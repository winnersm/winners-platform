import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAds, type MetaAd } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readSnapshotWithAge } from "@/lib/listing-sync";
import { errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";

// Anuncios de una cuenta (o de un ad set). Misma política que /api/meta/campaigns.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const adsetId = searchParams.get("adsetId");
  const refresh = searchParams.get("refresh") === "true";
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  if (!accountId) {
    return NextResponse.json({ error: "accountId requerido" }, { status: 400 });
  }

  const pick = (rows: MetaAd[]) => (adsetId ? rows.filter((a) => a.adset_id === adsetId) : rows);

  try {
    const snap = op ? await readSnapshotWithAge<MetaAd[]>(op, accountId, "ads") : null;
    if (snap?.fresh && !refresh) {
      return NextResponse.json({ ads: pick(snap.data), syncedAt: snap.syncedAt, source: "db" });
    }
    try {
      const ads = await getAds(accountId, adsetId ?? undefined, bmId, op, { force: refresh });
      return NextResponse.json({ ads, syncedAt: new Date(), source: "meta" });
    } catch (e) {
      if (!snap) throw e;
      const info = serializeError(e);
      return NextResponse.json({
        ads: pick(snap.data), syncedAt: snap.syncedAt, source: "db",
        stale: true, staleReason: userLine(info), errorInfo: info,
      });
    }
  } catch (err) {
    return errorResponse(err, "ads");
  }
}
