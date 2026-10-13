import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncFanpages, hasFanpageToken } from "@/lib/fanpages-api";
import { requireActiveOperationId } from "@/lib/operation";

// Trae las páginas desde Facebook y las guarda en la DB (bajo demanda).
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = await requireActiveOperationId();
  if (!(await hasFanpageToken(op))) {
    return NextResponse.json({ error: "No hay token de Fanpages configurado" }, { status: 409 });
  }
  try {
    const { synced, removed } = await syncFanpages(op);
    return NextResponse.json({ ok: true, synced, removed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error al sincronizar" }, { status: 500 });
  }
}
