import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";
import { getActiveOperationId, requireActiveOperationId } from "@/lib/operation";
import type { Launch } from "@winners/db";

// Convierte la fila de DB → objeto para la UI (token descifrado).
function toClient(l: Launch) {
  const { tokenEnc, ...rest } = l;
  let token = "";
  try { if (tokenEnc) token = decrypt(tokenEnc); } catch { token = ""; }
  return { ...rest, token };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;
  const sheetId = new URL(req.url).searchParams.get("sheetId") || undefined;
  const rows = await prisma.launch.findMany({
    where: { ...(op ? { operationId: op } : {}), ...(sheetId ? { sheetId } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ launches: rows.map(toClient) });
}

// Crea una fila vacía al final (en la operación activa y la hoja indicada).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = await requireActiveOperationId();
  const body = await req.json().catch(() => ({}));
  const sheetId = typeof body?.sheetId === "string" && body.sheetId ? body.sheetId : null;
  const last = await prisma.launch.findFirst({
    where: { operationId: op, ...(sheetId ? { sheetId } : {}) },
    orderBy: { sortOrder: "desc" }, select: { sortOrder: true },
  });
  const row = await prisma.launch.create({
    data: { status: "pendiente", sortOrder: (last?.sortOrder ?? 0) + 1, createdBy: session.user.id, operationId: op, sheetId },
  });
  return NextResponse.json({ launch: toClient(row) });
}
