import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEntityDailyInsights } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { errorResponse } from "@/lib/api-error";
import { markMetaSource } from "@/lib/meta-calls";

// Métricas día por día de una campaña, ad set o anuncio: alimentan sus gráficas.
// Caché corta (10 min); refresh=true salta la caché.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const entityId = searchParams.get("entityId");
  const datePreset = searchParams.get("datePreset") ?? "last_7d";
  const refresh = searchParams.get("refresh") === "true";
  const bmId = searchParams.get("bmId") ?? undefined;
  if (!entityId || !/^\d+$/.test(entityId)) {
    return NextResponse.json({ error: "entityId inválido" }, { status: 400 });
  }
  if (refresh) markMetaSource("sincronizar");
  const op = (await getActiveOperationId()) ?? undefined;

  try {
    const { rows, preset } = await getEntityDailyInsights(entityId, datePreset, bmId, op, refresh);
    return NextResponse.json({ rows, preset, syncedAt: new Date() });
  } catch (err) {
    return errorResponse(err, "insights-daily");
  }
}
