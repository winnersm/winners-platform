import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { allowedOperationIds, getActiveOperationId } from "@/lib/operation";

// Lista las operaciones a las que el usuario tiene acceso + la activa.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const allowed = await allowedOperationIds(session.user);
  const operations = await prisma.operation.findMany({
    where: { id: { in: allowed } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true },
  });
  const active = await getActiveOperationId();
  return NextResponse.json({ operations, active });
}
