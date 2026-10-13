import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { getActiveOperationId } from "@/lib/operation";

// Renombrar una hoja y/o actualizar sus columnas (hojas libres).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  const op = (await getActiveOperationId()) ?? undefined;

  const sheet = await prisma.launchSheet.findUnique({ where: { id } });
  if (!sheet || (op && sheet.operationId !== op)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: { name?: string; columns?: { id: string; name: string; w: number }[] } = {};

  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
    data.name = name;
  }
  // columns: array de { id, name, w } (solo hojas libres)
  if (Array.isArray(body?.columns)) {
    data.columns = body.columns
      .filter((c: unknown): c is { id: string; name: string; w?: number } =>
        !!c && typeof (c as { id?: unknown }).id === "string")
      .map((c: { id: string; name?: string; w?: number }) => ({
        id: c.id,
        name: typeof c.name === "string" ? c.name : "",
        w: typeof c.w === "number" ? c.w : 180,
      }));
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });

  const updated = await prisma.launchSheet.update({
    where: { id }, data, select: { id: true, name: true, kind: true, columns: true, sortOrder: true },
  });
  return NextResponse.json({ sheet: updated });
}

// Eliminar una hoja y todos sus lanzamientos. No permite borrar la última.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  const op = (await getActiveOperationId()) ?? undefined;

  const sheet = await prisma.launchSheet.findUnique({ where: { id } });
  if (!sheet || (op && sheet.operationId !== op)) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  // La hoja principal de lanzamientos no se puede eliminar.
  if (sheet.kind === "launches") {
    return NextResponse.json({ error: "La hoja de lanzamientos no se puede eliminar" }, { status: 400 });
  }

  const total = await prisma.launchSheet.count({ where: { operationId: sheet.operationId } });
  if (total <= 1) return NextResponse.json({ error: "No puedes eliminar la última hoja" }, { status: 400 });

  await prisma.launch.deleteMany({ where: { sheetId: id } });
  await prisma.sheetRow.deleteMany({ where: { sheetId: id } });
  await prisma.launchSheet.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
