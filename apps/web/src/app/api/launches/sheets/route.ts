import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { getActiveOperationId, requireActiveOperationId } from "@/lib/operation";

// Lista las hojas de la operación activa. Si no existe ninguna, crea una por
// defecto ("Hoja 1") y adopta los lanzamientos huérfanos (sheetId = null) de la op.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;

  let sheets = await prisma.launchSheet.findMany({
    where: op ? { operationId: op } : {},
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, kind: true, columns: true, sortOrder: true },
  });

  // Solo auto-crear la hoja principal cuando hay operación activa válida
  // (evita hojas huérfanas con operationId = null).
  if (sheets.length === 0 && op) {
    const created = await prisma.launchSheet.create({
      data: { name: "Hoja 1", kind: "launches", sortOrder: 0, operationId: op, createdBy: session.user.id },
      select: { id: true, name: true, kind: true, columns: true, sortOrder: true },
    });
    // Adoptar lanzamientos existentes sin hoja dentro de la misma operación.
    await prisma.launch.updateMany({
      where: { operationId: op, sheetId: null },
      data: { sheetId: created.id },
    });
    sheets = [created];
  }

  return NextResponse.json({ sheets });
}

// Columnas por defecto de una hoja libre nueva.
function defaultColumns() {
  return [
    { id: crypto.randomUUID(), name: "Columna 1", w: 180 },
    { id: crypto.randomUUID(), name: "Columna 2", w: 180 },
    { id: crypto.randomUUID(), name: "Columna 3", w: 180 },
  ];
}

// Crea una nueva hoja al final.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = await requireActiveOperationId();

  const body = await req.json().catch(() => ({}));
  const name = (typeof body?.name === "string" && body.name.trim()) || null;

  const last = await prisma.launchSheet.findFirst({
    where: { operationId: op }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true },
  });
  const count = await prisma.launchSheet.count({ where: { operationId: op } });

  // Las hojas creadas a mano son cuadrículas libres (columnas de texto propias).
  const sheet = await prisma.launchSheet.create({
    data: {
      name: name ?? `Hoja ${count + 1}`,
      kind: "free",
      columns: defaultColumns(),
      sortOrder: (last?.sortOrder ?? -1) + 1,
      operationId: op,
      createdBy: session.user.id,
    },
    select: { id: true, name: true, kind: true, columns: true, sortOrder: true },
  });
  return NextResponse.json({ sheet });
}
