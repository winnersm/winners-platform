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

export async function GET() {
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
  const bms = await prisma.businessManager.findMany({
    where: op ? { operationId: op } : {},
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, bmIdMeta: true, systemUserId: true, status: true, createdAt: true, updatedAt: true },
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

  await prisma.businessManager.update({ where: { id }, data: { status: "inactive" } });
  return NextResponse.json({ ok: true });
}
