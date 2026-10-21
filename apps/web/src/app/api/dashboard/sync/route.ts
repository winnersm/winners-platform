import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOperationId } from "@/lib/operation";
import { getAdAccounts } from "@/lib/meta-api";
import { syncDashboardForOperation } from "@/lib/dashboard-sync";

// Sincronización REAL contra Meta de la operación activa (la que dispara el
// botón "Sincronizar con Meta"). El job de fondo hace lo mismo cada 20 min;
// esto es para no tener que esperarlo.
//
// Es una operación lenta (una llamada por cuenta y preset, con pacing), así que
// la UI muestra estado mientras corre.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const op = await getActiveOperationId();
  if (!op) return NextResponse.json({ error: "No hay operación activa" }, { status: 400 });

  // Pre-chequeo de acceso: syncDashboardForOperation se traga los errores a
  // propósito (para que el job nunca reviente), pero aquí la persona necesita
  // saber POR QUÉ no se sincronizó.
  // forceRefresh: true porque es un sync manual, no queremos caché.
  try {
    await getAdAccounts(undefined, op, true);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sin acceso a Meta" },
      { status: 502 },
    );
  }

  const r = await syncDashboardForOperation(op, undefined, true);
  return NextResponse.json(r);
}
