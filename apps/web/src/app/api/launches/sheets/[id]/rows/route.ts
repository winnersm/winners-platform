import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { getActiveOperationId } from "@/lib/operation";

// Filas de una hoja libre.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  const op = (await getActiveOperationId()) ?? undefined;

  const sheet = await prisma.launchSheet.findUnique({ where: { id } });
  if (!sheet || (op && sheet.operationId !== op)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const rows = await prisma.sheetRow.findMany({
    where: { sheetId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, data: true, sortOrder: true },
  });
  return NextResponse.json({ rows });
}

// Agregar una fila vacía al final.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  const op = (await getActiveOperationId()) ?? undefined;

  const sheet = await prisma.launchSheet.findUnique({ where: { id } });
  if (!sheet || (op && sheet.operationId !== op)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const last = await prisma.sheetRow.findFirst({ where: { sheetId: id }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const row = await prisma.sheetRow.create({
    data: { sheetId: id, sortOrder: (last?.sortOrder ?? 0) + 1, data: {} },
    select: { id: true, data: true, sortOrder: true },
  });
  return NextResponse.json({ row });
}
