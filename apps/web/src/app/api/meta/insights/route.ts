import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getInsights, type MetaInsights } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readSnapshotWithAge } from "@/lib/listing-sync";
import { errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";

// Métricas por nivel y periodo. Misma política que /api/meta/campaigns: copia de
// DB si es reciente; si no, Meta en vivo; refresh=true salta los cachés.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const level = searchParams.get("level") as "campaign" | "adset" | "ad" | null;
  const datePreset = searchParams.get("datePreset") ?? "last_7d";
  const refresh = searchParams.get("refresh") === "true";
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  if (!accountId || !level || !["campaign", "adset", "ad"].includes(level)) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }

  try {
    const snap = op ? await readSnapshotWithAge<MetaInsights[]>(op, accountId, `ins:${level}`, datePreset) : null;
    if (snap?.fresh && !refresh) {
      return NextResponse.json({ data: snap.data, count: snap.data.length, syncedAt: snap.syncedAt, source: "db" });
    }
    try {
      const data = await getInsights(accountId, level, datePreset, bmId, op, { force: refresh });
      return NextResponse.json({ data, count: data.length, syncedAt: new Date(), source: "meta" });
    } catch (e) {
      if (!snap) throw e;
      const info = serializeError(e);
      return NextResponse.json({
        data: snap.data, count: snap.data.length, syncedAt: snap.syncedAt, source: "db",
        stale: true, staleReason: userLine(info), errorInfo: info,
      });
    }
  } catch (err) {
    return errorResponse(err, `insights ${level}`, { data: [] });
  }
}
