import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { getActiveOperationId } from "@/lib/operation";

// Verifica que la fila pertenezca a una hoja de la operación activa.
async function ownRow(rowId: string) {
  const op = (await getActiveOperationId()) ?? undefined;
  const row = await prisma.sheetRow.findUnique({ where: { id: rowId } });
  if (!row) return null;
  if (op) {
    const sheet = await prisma.launchSheet.findUnique({ where: { id: row.sheetId }, select: { operationId: true } });
    if (!sheet || sheet.operationId !== op) return null;
  }
  return row;
}

// Actualiza celdas de la fila (merge parcial sobre data).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { rowId } = await params;

  const row = await ownRow(rowId);
  if (!row) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch = (body?.data && typeof body.data === "object") ? body.data as Record<string, string> : {};
  const current = (row.data && typeof row.data === "object") ? row.data as Record<string, string> : {};
  const merged = { ...current, ...patch };

  const updated = await prisma.sheetRow.update({
    where: { id: rowId }, data: { data: merged }, select: { id: true, data: true, sortOrder: true },
  });
  return NextResponse.json({ row: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { rowId } = await params;

  const row = await ownRow(rowId);
  if (!row) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  await prisma.sheetRow.delete({ where: { id: rowId } });
  return NextResponse.json({ ok: true });
}
