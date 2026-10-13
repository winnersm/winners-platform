"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@winners/db";
import { assertGrant } from "@/lib/guards";
import { audit } from "@/lib/audit";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Control de las tareas automáticas.
 *
 * Estas tareas pausan campañas y borran anuncios de verdad. Hasta ahora el
 * panel enseñaba un horario y un interruptor que el worker no consultaba: los
 * cron estaban escritos en el código y solo funcionaba el interruptor general.
 * A partir de aquí lo que se ve aquí es lo que ocurre.
 */

export async function setTaskEnabled(name: string, enabled: boolean): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "WRITE");

  const task = await prisma.automationTask.findUnique({ where: { name } });
  if (!task) return { ok: false, error: "Tarea no encontrada" };

  await prisma.automationTask.update({
    where: { name },
    data: { enabled, updatedBy: actor.id },
  });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: enabled ? "task.enable" : "task.disable",
    entityType: "AutomationTask",
    entityId: name,
    payload: { displayName: task.displayName },
  });

  revalidatePath("/automations");
  return {
    ok: true,
    message: enabled ? `${task.displayName} activada` : `${task.displayName} desactivada`,
  };
}

/** Valida un cron de 5 campos. Un cron mal escrito deja la tarea sin ejecutarse en silencio. */
const CRON_RE =
  /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/;

export async function setTaskSchedule(name: string, cron: string): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "WRITE");

  const value = cron.trim();
  if (!CRON_RE.test(value)) {
    return { ok: false, error: "Horario inválido. Formato: minuto hora día mes día-semana" };
  }

  const task = await prisma.automationTask.findUnique({ where: { name } });
  if (!task) return { ok: false, error: "Tarea no encontrada" };

  await prisma.automationTask.update({
    where: { name },
    data: { cron: value, updatedBy: actor.id },
  });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: "task.set_schedule",
    entityType: "AutomationTask",
    entityId: name,
    payload: { from: task.cron, to: value },
  });

  revalidatePath("/automations");
  return { ok: true, message: "Horario actualizado" };
}

const scopeSchema = z.object({
  mode: z.enum(["ALL", "INCLUDE", "EXCLUDE"]),
  accounts: z.array(z.string().max(64)).max(500),
});

/**
 * A qué cuentas se aplica la tarea.
 *
 * Hoy todas las tareas de Meta actúan sobre TODAS las cuentas que ve el token,
 * sin forma de excluir ninguna — y pausan campañas y borran anuncios reales.
 * Esto es lo que permite dejar una cuenta fuera.
 */
export async function setTaskScope(
  name: string,
  mode: string,
  accounts: string[],
): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "WRITE");

  const parsed = scopeSchema.safeParse({ mode, accounts });
  if (!parsed.success) return { ok: false, error: "Selección inválida" };

  const task = await prisma.automationTask.findUnique({ where: { name } });
  if (!task) return { ok: false, error: "Tarea no encontrada" };

  if (parsed.data.mode !== "ALL" && parsed.data.accounts.length === 0) {
    return {
      ok: false,
      error:
        parsed.data.mode === "INCLUDE"
          ? "Elige al menos una cuenta, o cambia a «todas»"
          : "Elige al menos una cuenta a excluir, o cambia a «todas»",
    };
  }

  await prisma.automationTask.update({
    where: { name },
    data: {
      scopeMode: parsed.data.mode,
      scopeAccounts: parsed.data.mode === "ALL" ? [] : parsed.data.accounts,
      updatedBy: actor.id,
    },
  });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: "task.set_scope",
    entityType: "AutomationTask",
    entityId: name,
    payload: {
      from: { mode: task.scopeMode, accounts: task.scopeAccounts },
      to: { mode: parsed.data.mode, accounts: parsed.data.accounts },
    },
  });

  revalidatePath("/automations");

  const n = parsed.data.accounts.length;
  return {
    ok: true,
    message:
      parsed.data.mode === "ALL"
        ? "Se aplicará a todas las cuentas"
        : parsed.data.mode === "INCLUDE"
          ? `Se aplicará solo a ${n} cuenta(s)`
          : `Se excluirán ${n} cuenta(s)`,
  };
}

/** Modo prueba: calcula y reporta lo que haría, sin ejecutarlo. */
export async function setTaskDryRun(name: string, dryRun: boolean): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "WRITE");

  const task = await prisma.automationTask.findUnique({ where: { name } });
  if (!task) return { ok: false, error: "Tarea no encontrada" };

  await prisma.automationTask.update({ where: { name }, data: { dryRun, updatedBy: actor.id } });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: dryRun ? "task.dry_run_on" : "task.dry_run_off",
    entityType: "AutomationTask",
    entityId: name,
  });

  revalidatePath("/automations");
  return {
    ok: true,
    message: dryRun
      ? `${task.displayName} en modo prueba: informará de lo que haría, sin hacerlo`
      : `${task.displayName} vuelve a ejecutar de verdad`,
  };
}

/** Encola una ejecución manual. El worker la recoge en su siguiente vuelta. */
export async function runTaskNow(name: string): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "WRITE");

  const task = await prisma.automationTask.findUnique({ where: { name } });
  if (!task) return { ok: false, error: "Tarea no encontrada" };

  const pendiente = await prisma.taskTrigger.findFirst({
    where: { taskName: name, processed: false },
  });
  if (pendiente) return { ok: false, error: "Ya hay una ejecución pendiente para esta tarea" };

  await prisma.taskTrigger.create({
    data: { taskName: name, requestedBy: actor.email },
  });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: "task.run_now",
    entityType: "AutomationTask",
    entityId: name,
    payload: { dryRun: task.dryRun },
  });

  revalidatePath("/automations");
  return {
    ok: true,
    message: task.dryRun
      ? `${task.displayName} encolada en modo prueba`
      : `${task.displayName} encolada`,
  };
}

/** Interruptor general: para todo de golpe sin tocar la configuración de cada tarea. */
export async function setMasterSwitch(on: boolean): Promise<ActionResult> {
  const actor = await assertGrant("AUTOMATIONS", "ADMIN");

  await prisma.systemFlag.upsert({
    where: { key: "automations_enabled" },
    create: { key: "automations_enabled", value: on, updatedBy: actor.id },
    update: { value: on, updatedBy: actor.id },
  });

  await audit({
    userId: actor.id,
    module: "AUTOMATIONS",
    action: on ? "master_switch.on" : "master_switch.off",
    entityType: "SystemFlag",
    entityId: "automations_enabled",
  });

  revalidatePath("/automations");
  return {
    ok: true,
    message: on
      ? "Automatizaciones reanudadas"
      : "TODAS las automatizaciones detenidas. Nada se ejecutará hasta reanudarlas.",
  };
}
