import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOperationId } from "@/lib/operation";
import { getAdAccounts } from "@/lib/meta-api";
import { syncSpendDailyForOperation } from "@/lib/spend-history";

// Actualiza el libro diario de la operación activa con los últimos días.
// Es lo mismo que hace el job de las 6:00 AM, pero a demanda.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const op = await getActiveOperationId();
  if (!op) return NextResponse.json({ error: "No hay operación activa" }, { status: 400 });

  // El sync se traga los errores (para que el job nunca reviente), así que aquí
  // se comprueba el acceso antes, para poder decir POR QUÉ falló.
  try {
    await getAdAccounts(undefined, op);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sin acceso a Meta" }, { status: 502 });
  }

  const r = await syncSpendDailyForOperation(op);
  return NextResponse.json(r);
}
