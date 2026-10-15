"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@winners/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { currentUser, ForbiddenError } from "@/lib/guards";
import { audit } from "@/lib/audit";

/**
 * Bóveda de secretos (core.Secret), cifrados con AES-256-GCM.
 *
 * Solo el rol OWNER los toca: el modelo de roles dice explícitamente que ADMIN
 * "no toca usuarios ni secretos". Como una Server Action se puede invocar sin
 * pasar por la navegación, cada una revalida el rol aquí, no solo en la página.
 *
 * El valor en claro NUNCA se registra en auditoría ni se devuelve salvo en
 * revealSecret, que es una acción explícita y auditada.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };
export type RevealResult = { ok: true; value: string } | { ok: false; error: string };

async function requireOwner() {
  const actor = await currentUser();
  if (!actor || actor.role !== "OWNER") throw new ForbiddenError("ADMIN", "ADMIN");
  return actor;
}

/**
 * Pista: últimos 4 caracteres, para reconocer el secreto sin revelarlo. En
 * valores cortos (< 8) no se guarda nada — ahí los 4 últimos filtrarían media
 * clave. Los tokens/API keys reales son largos, así que no se pierde utilidad.
 */
function hintOf(value: string): string | null {
  return value.length >= 8 ? value.slice(-4) : null;
}

const keySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/, "Solo minúsculas, números y _ . -");

const createSchema = z.object({
  key: keySchema,
  label: z.string().min(1, "Falta la etiqueta").max(120),
  section: z.string().min(1, "Falta la sección").max(40),
  value: z.string().min(1, "El valor no puede estar vacío").max(8000),
});

export async function createSecret(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const actor = await requireOwner();

  const parsed = createSchema.safeParse({
    key: formData.get("key"),
    label: formData.get("label"),
    section: formData.get("section"),
    value: formData.get("value"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const key = parsed.data.key.trim();
  const exists = await prisma.secret.findUnique({ where: { key }, select: { id: true } });
  if (exists) return { ok: false, error: `Ya existe un secreto con la clave "${key}"` };

  const created = await prisma.secret.create({
    data: {
      key,
      label: parsed.data.label.trim(),
      section: parsed.data.section.trim().toLowerCase(),
      ciphertext: encrypt(parsed.data.value),
      hint: hintOf(parsed.data.value),
      updatedBy: actor.id,
    },
  });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "secret.create",
    entityType: "Secret",
    entityId: created.id,
    payload: { key, section: parsed.data.section }, // nunca el valor
  });

  revalidatePath("/admin/secrets");
  return { ok: true, message: `Secreto "${key}" creado` };
}

const updateSchema = z.object({
  label: z.string().min(1, "Falta la etiqueta").max(120),
  section: z.string().min(1, "Falta la sección").max(40),
  // Opcional: si viene, se rota el valor. Si no, se deja el actual.
  value: z.string().max(8000).optional(),
});

export async function updateSecret(
  id: string,
  data: { label: string; section: string; value?: string },
): Promise<ActionResult> {
  const actor = await requireOwner();

  const parsed = updateSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const target = await prisma.secret.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "Secreto no encontrado" };

  const rotated = Boolean(parsed.data.value && parsed.data.value.length > 0);

  await prisma.secret.update({
    where: { id },
    data: {
      label: parsed.data.label.trim(),
      section: parsed.data.section.trim().toLowerCase(),
      updatedBy: actor.id,
      ...(rotated
        ? { ciphertext: encrypt(parsed.data.value!), hint: hintOf(parsed.data.value!) }
        : {}),
    },
  });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "secret.update",
    entityType: "Secret",
    entityId: id,
    payload: { key: target.key, rotated },
  });

  revalidatePath("/admin/secrets");
  return { ok: true, message: rotated ? "Secreto actualizado y valor rotado" : "Secreto actualizado" };
}

export async function deleteSecret(id: string): Promise<ActionResult> {
  const actor = await requireOwner();

  const target = await prisma.secret.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "Secreto no encontrado" };

  await prisma.secret.delete({ where: { id } });

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "secret.delete",
    entityType: "Secret",
    entityId: id,
    payload: { key: target.key },
  });

  revalidatePath("/admin/secrets");
  return { ok: true, message: `Secreto "${target.key}" eliminado` };
}

/** Descifra y devuelve el valor. Acción explícita y auditada; solo OWNER. */
export async function revealSecret(id: string): Promise<RevealResult> {
  const actor = await requireOwner();

  const target = await prisma.secret.findUnique({ where: { id } });
  if (!target) return { ok: false, error: "Secreto no encontrado" };

  let value: string;
  try {
    value = decrypt(target.ciphertext);
  } catch {
    return {
      ok: false,
      error: "No se pudo descifrar (clave de cifrado incorrecta o dato corrupto)",
    };
  }

  await audit({
    userId: actor.id,
    module: "ADMIN",
    action: "secret.reveal",
    entityType: "Secret",
    entityId: id,
    payload: { key: target.key },
  });

  return { ok: true, value };
}
