import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";

// Duplica un lanzamiento completo (copia todos los campos, incluido el token cifrado).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;

  const orig = await prisma.launch.findUnique({ where: { id } });
  if (!orig) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  // Hacer espacio justo debajo del original (dentro de su misma operación).
  await prisma.launch.updateMany({
    where: { sortOrder: { gt: orig.sortOrder }, operationId: orig.operationId, sheetId: orig.sheetId },
    data: { sortOrder: { increment: 1 } },
  });
  const { id: _id, createdAt: _ca, updatedAt: _ua, sortOrder: _so, ...copy } = orig;
  void _id; void _ca; void _ua; void _so;

  const row = await prisma.launch.create({
    data: { ...copy, sortOrder: orig.sortOrder + 1, createdBy: session.user.id },
  });

  let token = "";
  try { if (row.tokenEnc) token = decrypt(row.tokenEnc); } catch { token = ""; }
  const { tokenEnc, ...rest } = row;
  void tokenEnc;
  return NextResponse.json({ launch: { ...rest, token } });
}
