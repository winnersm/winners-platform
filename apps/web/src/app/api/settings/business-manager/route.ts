import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { encrypt } from "@/lib/crypto";
import { verifyToken } from "@/lib/meta-api";
import { requireActiveOperationId, getActiveOperationId } from "@/lib/operation";
import { z } from "zod";
import { assertGrant, ForbiddenError } from "@/lib/guards";

const META_API_BASE = "https://graph.facebook.com/v21.0";

const createSchema = z.object({
  name: z.string().trim().min(1),
  bmIdMeta: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

// Editar: nombre y/o token. Sin token se conserva el actual.
const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  token: z.string().trim().min(1).optional(),
});

async function fetchSystemUser(token: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(`${META_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const json = await res.json() as { id?: string; name?: string; error?: unknown };
    if (!json.id) return null;
    return { id: json.id, name: json.name ?? json.id };
  } catch {
    return null;
  }
}

/** Verifica el token contra el BM y devuelve su System User, o un mensaje de error. */
async function checkToken(token: string, bmIdMeta: string) {
  const { valid, name: bmName } = await verifyToken(token, bmIdMeta);
  if (!valid) return { error: "Token inválido o sin acceso a ese BM ID" } as const;
  const systemUser = await fetchSystemUser(token);
  if (!systemUser) return { error: "No se pudo obtener el System User del token" } as const;
  return { bmName, systemUser } as const;
}

export async function GET(req: NextRequest) {
  // Configurar tokens es administración: se exige permiso de administración
  // sobre Meta, no el rol ADMIN del modelo de roles antiguo.
  let actor;
  try {
    actor = await assertGrant("META", "ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }
  const op = (await getActiveOperationId()) ?? undefined;
  // ?trash=1 devuelve la papelera; por defecto solo los vigentes.
  const trash = new URL(req.url).searchParams.get("trash") === "1";
  const bms = await prisma.businessManager.findMany({
    where: { ...(op ? { operationId: op } : {}), deletedAt: trash ? { not: null } : null },
    orderBy: trash ? { deletedAt: "desc" } : { createdAt: "asc" },
    select: {
      id: true, name: true, bmIdMeta: true, systemUserId: true, status: true, tokenLast4: true,
      createdAt: true, updatedAt: true,
      deletedAt: true, deletedByName: true, deletedReason: true,
    },
  });
  return NextResponse.json(bms);
}

export async function POST(req: NextRequest) {
  // Configurar tokens es administración: se exige permiso de administración
  // sobre Meta, no el rol ADMIN del modelo de roles antiguo.
  let actor;
  try {
    actor = await assertGrant("META", "ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", details: parsed.error.flatten() }, { status: 400 });
  }

  const { name, bmIdMeta, token } = parsed.data;
  const op = await requireActiveOperationId();
  const check = await checkToken(token, bmIdMeta);
  if ("error" in check) return NextResponse.json({ error: check.error }, { status: 400 });
  const { bmName, systemUser } = check;

  const encryptedToken = encrypt(token);
  const tokenLast4 = token.slice(-4);
  const displayName = name || `${bmName ?? bmIdMeta} · ${systemUser.name}`;

  // systemUserId es único: si el token ya estaba registrado, se reutiliza esa
  // fila. Antes el upsert la actualizaba sin sacarla de la papelera, así que el
  // BM «se guardaba» pero no aparecía en la lista.
  const existing = await prisma.businessManager.findUnique({ where: { systemUserId: systemUser.id } });
  if (existing && existing.operationId && existing.operationId !== op) {
    const other = await prisma.operation.findUnique({ where: { id: existing.operationId }, select: { name: true } });
    return NextResponse.json({
      error: `Este token ya está registrado en la operación «${other?.name ?? existing.operationId}»`,
    }, { status: 409 });
  }
  if (existing && !existing.deletedAt) {
    return NextResponse.json({
      error: `Este token ya está registrado como «${existing.name}». Usa «Editar» para cambiarlo.`,
    }, { status: 409 });
  }

  const bm = existing
    ? await prisma.businessManager.update({
        where: { id: existing.id },
        data: {
          name: displayName, bmIdMeta, encryptedToken, tokenLast4, status: "active", operationId: op,
          deletedAt: null, deletedById: null, deletedByName: null, deletedReason: null,
        },
      })
    : await prisma.businessManager.create({
        data: { name: displayName, bmIdMeta, systemUserId: systemUser.id, encryptedToken, tokenLast4, status: "active", operationId: op },
      });

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: actor.id,
      action: existing ? "BM_RESTORED" : "BM_CONFIGURED",
      entityType: "BusinessManager",
      entityId: bm.id,
      payload: { name: bm.name, bmIdMeta, systemUserId: systemUser.id },
    },
  });

  return NextResponse.json({ id: bm.id, name: bm.name, status: bm.status, restored: !!existing });
}

// Editar nombre y/o token sin tener que borrar y volver a crear el BM.
export async function PUT(req: NextRequest) {
  let actor;
  try {
    actor = await assertGrant("META", "ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID requerido" }, { status: 400 });

  const parsed = updateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", details: parsed.error.flatten() }, { status: 400 });
  }
  const { name, token } = parsed.data;
  if (!name && !token) return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });

  const op = (await getActiveOperationId()) ?? undefined;
  const bm = await prisma.businessManager.findFirst({
    where: { id, deletedAt: null, ...(op ? { operationId: op } : {}) },
  });
  if (!bm) return NextResponse.json({ error: "Business Manager no encontrado" }, { status: 404 });

  const data: {
    name?: string; encryptedToken?: string; tokenLast4?: string; systemUserId?: string; status?: string;
  } = {};
  if (name) data.name = name;

  if (token) {
    const check = await checkToken(token, bm.bmIdMeta);
    if ("error" in check) return NextResponse.json({ error: check.error }, { status: 400 });
    // El token puede ser de otro System User; no puede pisar a otro BM registrado.
    if (check.systemUser.id !== bm.systemUserId) {
      const other = await prisma.businessManager.findUnique({ where: { systemUserId: check.systemUser.id } });
      if (other) {
        return NextResponse.json({
          error: `Ese token ya está registrado como «${other.name}»${other.deletedAt ? " (en la papelera)" : ""}`,
        }, { status: 409 });
      }
      data.systemUserId = check.systemUser.id;
    }
    data.encryptedToken = encrypt(token);
    data.tokenLast4 = token.slice(-4);
    data.status = "active";
  }

  const updated = await prisma.businessManager.update({ where: { id }, data });

  await prisma.auditLog.create({
    data: {
      module: "META", userId: actor.id, action: "BM_UPDATED",
      entityType: "BusinessManager", entityId: updated.id,
      payload: {
        name: updated.name, tokenChanged: !!token,
        ...(data.systemUserId ? { systemUserId: data.systemUserId, previousSystemUserId: bm.systemUserId } : {}),
      },
    },
  });

  return NextResponse.json({ id: updated.id, name: updated.name, status: updated.status });
}

export async function DELETE(req: NextRequest) {
  // Configurar tokens es administración: se exige permiso de administración
  // sobre Meta, no el rol ADMIN del modelo de roles antiguo.
  let actor;
  try {
    actor = await assertGrant("META", "ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID requerido" }, { status: 400 });

  // El motivo es obligatorio: una papelera sin el porqué no sirve de nada.
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? "").trim();
  if (reason.length < 3) {
    return NextResponse.json({ error: "Indica el motivo de la eliminación" }, { status: 400 });
  }

  const bm = await prisma.businessManager.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      deletedById: actor.id,
      deletedByName: actor.name ?? actor.email,
      deletedReason: reason,
    },
  });

  await prisma.auditLog.create({
    data: {
      module: "META", userId: actor.id, action: "BM_DELETED",
      entityType: "BusinessManager", entityId: bm.id,
      payload: { name: bm.name, reason },
    },
  });

  return NextResponse.json({ ok: true });
}

// Restaurar desde la papelera.
export async function PATCH(req: NextRequest) {
  let actor;
  try {
    actor = await assertGrant("META", "ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID requerido" }, { status: 400 });

  const bm = await prisma.businessManager.update({
    where: { id },
    data: { deletedAt: null, deletedById: null, deletedByName: null, deletedReason: null },
  });

  await prisma.auditLog.create({
    data: {
      module: "META", userId: actor.id, action: "BM_RESTORED",
      entityType: "BusinessManager", entityId: bm.id,
      payload: { name: bm.name },
    },
  });

  return NextResponse.json({ ok: true });
}
