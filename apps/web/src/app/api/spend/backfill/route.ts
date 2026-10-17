import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOperationId } from "@/lib/operation";
import { getAdAccounts } from "@/lib/meta-api";
import { backfillSpendDaily } from "@/lib/spend-history";

// Siembra el histórico hacia atrás (Meta conserva ~37 meses). Es LENTO: una
// llamada por cuenta y ventana de 90 días. Se lanza a mano, no en bucle.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const op = await getActiveOperationId();
  if (!op) return NextResponse.json({ error: "No hay operación activa" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { months?: number };
  const months = Math.min(24, Math.max(1, Number(body?.months) || 12));

  try {
    await getAdAccounts(undefined, op);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sin acceso a Meta" }, { status: 502 });
  }

  const r = await backfillSpendDaily(op, months);
  return NextResponse.json({ ...r, months });
}
