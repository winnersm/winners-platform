"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@winners/db";
import { assertGrant } from "@/lib/guards";
import { audit } from "@/lib/audit";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const linkSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  expectedUrl: z.string().max(2000).optional().or(z.literal("")),
  expectedText: z.string().max(500).optional().or(z.literal("")),
  maxResponseMs: z.coerce.number().int().min(500).max(60000),
  expectRedirect: z.coerce.boolean(),
});

export async function saveLink(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "WRITE");

  const id = formData.get("id")?.toString() || null;
  const parsed = linkSchema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    expectedUrl: formData.get("expectedUrl"),
    expectedText: formData.get("expectedText"),
    maxResponseMs: formData.get("maxResponseMs"),
    expectRedirect: formData.get("expectRedirect") === "on",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const data = {
    name: parsed.data.name.trim(),
    url: parsed.data.url.trim(),
    expectedUrl: parsed.data.expectedUrl?.trim() || null,
    expectedText: parsed.data.expectedText?.trim() || null,
    maxResponseMs: parsed.data.maxResponseMs,
    expectRedirect: parsed.data.expectRedirect,
  };

  const link = id
    ? await prisma.monitoredLink.update({ where: { id }, data })
    : await prisma.monitoredLink.create({ data });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: id ? "link.update" : "link.create",
    entityType: "MonitoredLink",
    entityId: link.id,
    payload: { name: data.name, url: data.url },
  });

  revalidatePath("/monitor");
  return { ok: true, message: id ? "Link actualizado" : "Link añadido a la vigilancia" };
}

export async function setLinkEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "WRITE");

  const link = await prisma.monitoredLink.findUnique({ where: { id } });
  if (!link) return { ok: false, error: "Link no encontrado" };

  await prisma.monitoredLink.update({ where: { id }, data: { enabled } });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: enabled ? "link.watch" : "link.unwatch",
    entityType: "MonitoredLink",
    entityId: id,
    payload: { name: link.name },
  });

  revalidatePath("/monitor");
  return {
    ok: true,
    message: enabled
      ? `${link.name} vuelve a vigilarse`
      : `${link.name} deja de vigilarse (su histórico se conserva)`,
  };
}

export async function deleteLink(id: string): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "ADMIN");

  const link = await prisma.monitoredLink.findUnique({
    where: { id },
    include: { _count: { select: { checks: true, incidents: true } } },
  });
  if (!link) return { ok: false, error: "Link no encontrado" };

  // Se borra en cascada su histórico. Para conservarlo, la opción correcta es
  // dejar de vigilarlo en vez de eliminarlo.
  await prisma.monitoredLink.delete({ where: { id } });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: "link.delete",
    entityType: "MonitoredLink",
    entityId: id,
    payload: {
      name: link.name,
      url: link.url,
      checksBorrados: link._count.checks,
      incidentesBorrados: link._count.incidents,
    },
  });

  revalidatePath("/monitor");
  return {
    ok: true,
    message: `${link.name} eliminado junto con su histórico (${link._count.incidents} incidencias)`,
  };
}

/** Copia un link para crear una variante sin teclear todo de nuevo. */
export async function duplicateLink(id: string): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "WRITE");

  const original = await prisma.monitoredLink.findUnique({ where: { id } });
  if (!original) return { ok: false, error: "Link no encontrado" };

  const copia = await prisma.monitoredLink.create({
    data: {
      name: `${original.name} (copia)`,
      url: original.url,
      expectedUrl: original.expectedUrl,
      expectRedirect: original.expectRedirect,
      expectedText: original.expectedText,
      maxResponseMs: original.maxResponseMs,
      // La copia nace desactivada: se revisa y se activa a mano, para no
      // empezar a vigilar una URL que todavía hay que editar.
      enabled: false,
    },
  });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: "link.duplicate",
    entityType: "MonitoredLink",
    entityId: copia.id,
    payload: { desde: original.name },
  });

  revalidatePath("/monitor");
  return { ok: true, message: `Copia creada y desactivada. Edítala y actívala cuando esté lista.` };
}

/** Pide una comprobación inmediata. El motor la recoge en menos de un minuto. */
export async function requestCheck(id: string): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "WRITE");

  const link = await prisma.monitoredLink.findUnique({ where: { id } });
  if (!link) return { ok: false, error: "Link no encontrado" };
  if (!link.enabled) {
    return { ok: false, error: "Este link no se está vigilando. Actívalo primero." };
  }

  await prisma.monitoredLink.update({
    where: { id },
    data: { checkRequestedAt: new Date() },
  });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: "link.check_now",
    entityType: "MonitoredLink",
    entityId: id,
    payload: { name: link.name },
  });

  revalidatePath("/monitor");
  return { ok: true, message: `${link.name}: comprobación pedida, tarda menos de un minuto` };
}

/**
 * Cada cuánto se comprueban los links.
 *
 * El panel anterior lo tenía en su pantalla de ajustes; aquí vive junto a los
 * links, que es donde se mira. El motor lo relee sin reiniciar.
 */
export async function setCheckInterval(minutos: number): Promise<ActionResult> {
  const actor = await assertGrant("MONITOR", "ADMIN");

  const n = Math.round(minutos);
  if (!Number.isFinite(n) || n < 5 || n > 1440) {
    return { ok: false, error: "El intervalo debe estar entre 5 minutos y 24 horas" };
  }

  await prisma.setting.upsert({
    where: { key: "monitor.interval_minutes" },
    create: {
      key: "monitor.interval_minutes",
      value: String(n),
      label: "Intervalo de comprobación (minutos)",
      section: "monitor",
    },
    update: { value: String(n) },
  });

  await audit({
    userId: actor.id,
    module: "MONITOR",
    action: "settings.interval",
    entityType: "Setting",
    entityId: "monitor.interval_minutes",
    payload: { minutos: n },
  });

  revalidatePath("/monitor");
  return { ok: true, message: `Se comprobará cada ${n} minutos` };
}
