import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { encrypt } from "@/lib/crypto";
import { verifyToken } from "@/lib/meta-api";
import { requireActiveOperationId, getActiveOperationId } from "@/lib/operation";
import { z } from "zod";
import { assertGrant, ForbiddenError } from "@/lib/guards";

const META_API_BASE = "https://graph.facebook.com/v21.0";

const createSchema = z.object({
  name: z.string().min(1),
  bmIdMeta: z.string().min(1),
  token: z.string().min(1),
});

async function fetchSystemUser(token: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${META_API_BASE}/me?fields=id,name&access_token=${token}`);
  const json = await res.json() as { id?: string; name?: string; error?: unknown };
  if (!json.id) throw new Error("No se pudo obtener el System User del token");
  return { id: json.id, name: json.name ?? json.id };
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
      id: true, name: true, bmIdMeta: true, systemUserId: true, status: true,
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
  const { valid, name: bmName } = await verifyToken(token, bmIdMeta);
  if (!valid) {
    return NextResponse.json({ error: "Token inválido o BM ID incorrecto" }, { status: 400 });
  }

  const systemUser = await fetchSystemUser(token);
  const encryptedToken = encrypt(token);
  const displayName = name || `${bmName ?? bmIdMeta} · ${systemUser.name}`;

  const bm = await prisma.businessManager.upsert({
    where: { systemUserId: systemUser.id },
    create: { name: displayName, bmIdMeta, systemUserId: systemUser.id, encryptedToken, status: "active", operationId: op },
    update: { name: displayName, bmIdMeta, encryptedToken, status: "active", operationId: op },
  });

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: actor.id,
      action: "BM_CONFIGURED",
      entityType: "BusinessManager",
      entityId: bm.id,
      payload: { name: bm.name, bmIdMeta, systemUserId: systemUser.id },
    },
  });

  return NextResponse.json({ id: bm.id, name: bm.name, status: bm.status });
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
