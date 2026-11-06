import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOperationId } from "@/lib/operation";
import { getAdAccounts } from "@/lib/meta-api";
import { DASHBOARD_PRESETS, syncDashboardForOperation } from "@/lib/dashboard-sync";

// Sincronización REAL contra Meta de la operación activa (la que dispara el
// botón "Sincronizar con Meta"). El job de fondo hace lo mismo (hoy y este mes cada
// hora, los periodos cerrados una vez al día); esto es para no tener que esperarlo.
//
// Es una operación lenta (una llamada por cuenta y preset, con pacing), así que
// solo se pide el periodo que se está viendo. Las fechas personalizadas no tienen
// snapshot: solo se refresca la lista de cuentas. La UI muestra estado mientras corre.
export async function POST(req: NextRequest) {
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

  const body = (await req.json().catch(() => null)) as { datePreset?: string } | null;
  const preset = body?.datePreset;
  const presets = !preset ? undefined : DASHBOARD_PRESETS.includes(preset) ? [preset] : [];
  const r = await syncDashboardForOperation(op, presets, true);
  return NextResponse.json(r);
}
