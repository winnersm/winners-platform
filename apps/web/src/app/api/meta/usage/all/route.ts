import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAdAccounts, getAccountsUsageCached, refreshAccountsUsage } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";

// Cuota por cuenta para la lista de Cuentas.
//   GET                → cache (Redis), instantáneo, 0 llamadas a Meta.
//   GET ?refresh=true  → barrido activo: 1 GET liviano por cuenta (paralelo) y devuelve fresco.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const refresh = req.nextUrl.searchParams.get("refresh") === "true";
  const op = (await getActiveOperationId()) ?? undefined;
  try {
    const accounts = await getAdAccounts(undefined, op); // cacheado, por operación
    const usage = refresh
      ? await refreshAccountsUsage(accounts.map((a) => ({ id: a.id, bmId: a.bmId })))
      : await getAccountsUsageCached(accounts.map((a) => a.id));
    return NextResponse.json({ usage });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[usage/all] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
