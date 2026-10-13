"use server";

import { revalidatePath } from "next/cache";
import { hash } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@winners/db";
import { MODULES, LEVELS, ROLES } from "@winners/auth";
import { assertGrant } from "@/lib/guards";
import { audit } from "@/lib/audit";

/**
 * Alta, baja y permisos de usuarios.
 *
 * Todas comprueban permiso con assertGrant: el middleware evita llegar a la
 * página, pero una Server Action se puede invocar directamente sin navegar.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const emailSchema = z.string().email().max(200);

const createSchema = z.object({
  email: emailSchema,
  name: z.string().min(1).max(120),
  role: z.enum(ROLES),
  password: z.string().min(10, "Mínimo 10 caracteres"),
});

export async function createUser(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  const parsed = createSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name"),
    role: formData.get("role"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const email = parsed.data.email.toLowerCase().trim();

  const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (exists) return { ok: false, error: "Ya existe un usuario con ese correo" };

  const user = await prisma.user.create({
    data: {
      email,
      name: parsed.data.name.trim(),
      role: parsed.data.role,
      passwordHash: await hash(parsed.data.password, 12),
      // Estrena contraseña en su primer acceso: la que se teclea aquí la ve
      // quien da de alta, así que no puede quedarse como definitiva.
      mustChangePassword: true,
    },
  });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "user.create",
    entityType: "User",
    entityId: user.id,
    payload: { email, role: parsed.data.role },
  });

  revalidatePath("/admin/users");
  return { ok: true, message: `Usuario ${email} creado` };
}

export async function setRole(userId: string, role: string): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  const parsed = z.enum(ROLES).safeParse(role);
  if (!parsed.success) return { ok: false, error: "Rol inválido" };

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { ok: false, error: "Usuario no encontrado" };

  // No dejar el sistema sin nadie capaz de administrarlo.
  if (target.role === "OWNER" && parsed.data !== "OWNER") {
    const owners = await prisma.user.count({ where: { role: "OWNER", status: "ACTIVE" } });
    if (owners <= 1) {
      return { ok: false, error: "No puedes quitar el último dueño: quedaría nadie con acceso de administración" };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { role: parsed.data } });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "user.set_role",
    entityType: "User",
    entityId: userId,
    payload: { from: target.role, to: parsed.data, email: target.email },
  });

  revalidatePath("/admin/users");
  return { ok: true, message: "Rol actualizado" };
}

export async function setGrant(userId: string, moduleKey: string, level: string): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  const m = z.enum(MODULES).safeParse(moduleKey);
  const l = z.enum(LEVELS).safeParse(level);
  if (!m.success || !l.success) return { ok: false, error: "Módulo o nivel inválido" };

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!target) return { ok: false, error: "Usuario no encontrado" };

  if (l.data === "NONE") {
    // Sin fila = sin acceso. Se borra en vez de guardar NONE para que la tabla
    // refleje solo lo concedido.
    await prisma.moduleGrant.deleteMany({ where: { userId, module: m.data } });
  } else {
    await prisma.moduleGrant.upsert({
      where: { userId_module: { userId, module: m.data } },
      create: { userId, module: m.data, level: l.data },
      update: { level: l.data },
    });
  }

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "user.set_grant",
    entityType: "User",
    entityId: userId,
    payload: { email: target.email, module: m.data, level: l.data },
  });

  revalidatePath("/admin/users");
  return { ok: true, message: "Permiso actualizado" };
}

export async function setStatus(userId: string, active: boolean): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  if (userId === actor.id && !active) {
    return { ok: false, error: "No puedes suspenderte a ti mismo" };
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { ok: false, error: "Usuario no encontrado" };

  if (!active && target.role === "OWNER") {
    const owners = await prisma.user.count({ where: { role: "OWNER", status: "ACTIVE" } });
    if (owners <= 1) return { ok: false, error: "No puedes suspender al último dueño" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { status: active ? "ACTIVE" : "SUSPENDED" },
  });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: active ? "user.reactivate" : "user.suspend",
    entityType: "User",
    entityId: userId,
    payload: { email: target.email },
  });

  revalidatePath("/admin/users");
  return {
    ok: true,
    message: active
      ? "Usuario reactivado"
      : "Usuario suspendido. Pierde el acceso en cuanto se refresque su sesión",
  };
}

export async function resetPassword(userId: string, password: string): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  if (password.length < 10) return { ok: false, error: "Mínimo 10 caracteres" };

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!target) return { ok: false, error: "Usuario no encontrado" };

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hash(password, 12), mustChangePassword: true },
  });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "user.reset_password",
    entityType: "User",
    entityId: userId,
    payload: { email: target.email },
  });

  revalidatePath("/admin/users");
  return { ok: true, message: "Contraseña restablecida. Deberá cambiarla al entrar" };
}

export async function setMembership(userId: string, operationId: string, member: boolean): Promise<ActionResult> {
  const actor = await assertGrant("ADMIN", "ADMIN");

  if (member) {
    await prisma.membership.upsert({
      where: { userId_operationId: { userId, operationId } },
      create: { userId, operationId },
      update: {},
    });
  } else {
    await prisma.membership.deleteMany({ where: { userId, operationId } });
  }

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: member ? "user.join_operation" : "user.leave_operation",
    entityType: "User",
    entityId: userId,
    payload: { operationId },
  });

  revalidatePath("/admin/users");
  return { ok: true, message: "Operaciones actualizadas" };
}
