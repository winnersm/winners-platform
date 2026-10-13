import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { encrypt } from "@/lib/crypto";
import { redis } from "@/lib/redis";
import { getActiveOperationId, requireActiveOperationId } from "@/lib/operation";
import { z } from "zod";
import { assertGrant, ForbiddenError } from "@/lib/guards";

const API = "https://graph.facebook.com/v21.0";
const createSchema = z.object({ name: z.string().optional(), token: z.string().min(20) });

// Estado del token de fanpages de la operación (sin exponer el valor).
export async function GET() {
  try {
    await assertGrant("META", "READ");
  } catch {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const op = (await getActiveOperationId()) ?? undefined;
  const row = await prisma.fanpageToken.findFirst({
    where: { status: "active", ...(op ? { operationId: op } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, systemUserId: true, createdAt: true },
  });
  return NextResponse.json({ configured: !!row, token: row });
}

// Guardar/actualizar el token de fanpages de la operación (solo ADMIN).
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
  const op = await requireActiveOperationId();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Token inválido" }, { status: 400 });
  const { token, name } = parsed.data;

  // Validar: ¿quién es y qué permisos tiene?
  const meRes = await fetch(`${API}/me?fields=id,name&access_token=${token}`);
  const me = await meRes.json() as { id?: string; name?: string; error?: { message?: string } };
  if (!me.id) return NextResponse.json({ error: me.error?.message ?? "Token inválido" }, { status: 400 });

  const permRes = await fetch(`${API}/me/permissions?access_token=${token}`);
  const permJson = await permRes.json() as { data?: Array<{ permission: string; status: string }> };
  const granted = new Set((permJson.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission));
  const required = ["pages_show_list", "pages_read_engagement", "business_management"];
  const missing = required.filter((r) => !granted.has(r));
  if (missing.length) {
    return NextResponse.json({ error: `Al token le faltan permisos: ${missing.join(", ")}` }, { status: 400 });
  }

  // Reemplazo limpio: quitar cualquier token previo de ESTA operación que sea de
  // otro system user (si no, quedaría duplicado y GET devolvería el viejo).
  await prisma.fanpageToken.deleteMany({ where: { operationId: op, NOT: { systemUserId: me.id } } });

  const row = await prisma.fanpageToken.upsert({
    where: { systemUserId: me.id },
    create: { name: name || me.name || me.id, systemUserId: me.id, encryptedToken: encrypt(token), status: "active", operationId: op },
    update: { name: name || me.name || me.id, encryptedToken: encrypt(token), status: "active", operationId: op },
  });
  await redis.del("fanpages:list"); // invalidar caché de páginas

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: actor.id,
      action: "FANPAGE_TOKEN_CONFIGURED",
      entityType: "FanpageToken",
      entityId: row.id,
      payload: { name: row.name, systemUserId: me.id },
    },
  });

  return NextResponse.json({ ok: true, name: row.name, systemUserId: me.id });
}

export async function DELETE() {
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
  await prisma.fanpageToken.deleteMany({ where: op ? { operationId: op } : {} });
  await redis.del("fanpages:list");
  return NextResponse.json({ ok: true });
}
