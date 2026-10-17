import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOperationId } from "@/lib/operation";
import { getSpendByRange } from "@/lib/spend-history";
import { prisma } from "@winners/db";

// Gasto histórico por rango de fechas (desde el libro diario AccountSpendDaily).
// Instantáneo, no toca Meta: lo alimenta el job SYNC_SPEND_DAILY.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const op = await getActiveOperationId();
  if (!op) return NextResponse.json({ rows: [], totals: { spend: 0, revenue: 0, sales: 0 }, series: [] });

  const fromStr = req.nextUrl.searchParams.get("from");
  const toStr = req.nextUrl.searchParams.get("to");
  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "Faltan parámetros 'from' y 'to' (YYYY-MM-DD)" }, { status: 400 });
  }

  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  if (isNaN(+from) || isNaN(+to)) {
    return NextResponse.json({ error: "Fechas inválidas" }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "'from' no puede ser posterior a 'to'" }, { status: 400 });
  }

  // lastSync NO va acotado al rango: es "cuándo se actualizó el libro", que es
  // independiente de las fechas que se estén consultando.
  const [result, last] = await Promise.all([
    getSpendByRange(op, from, to),
    prisma.accountSpendDaily.aggregate({ where: { operationId: op }, _max: { updatedAt: true } }),
  ]);
  return NextResponse.json({ ...result, lastSync: last._max.updatedAt });
}
