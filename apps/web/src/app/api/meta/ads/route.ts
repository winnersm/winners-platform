import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAds, type MetaAd } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readSnapshotWithAge, saveListingSnapshot } from "@/lib/listing-sync";
import type { MetaAdSet } from "@/lib/meta-api";
import { errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";
import { markMetaSource } from "@/lib/meta-calls";

// Anuncios de una cuenta (o de un ad set). Misma política que /api/meta/campaigns.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const adsetId = searchParams.get("adsetId");
  const campaignId = searchParams.get("campaignId");
  const refresh = searchParams.get("refresh") === "true";
  if (refresh) markMetaSource("sincronizar");
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  if (!accountId) {
    return NextResponse.json({ error: "accountId requerido" }, { status: 400 });
  }

  try {
    const snap = op ? await readSnapshotWithAge<MetaAd[]>(op, accountId, "ads") : null;
    // Anuncios de una campaña: por su campaign_id o, en copias viejas sin él, por los ad sets de esa campaña.
    let campAdsets: Set<string> | null = null;
    if (campaignId && op) {
      const as = await readSnapshotWithAge<MetaAdSet[]>(op, accountId, "adsets");
      if (as) campAdsets = new Set(as.data.filter((a) => a.campaign_id === campaignId).map((a) => a.id));
    }
    const pick = (rows: MetaAd[]) => {
      if (adsetId) return rows.filter((a) => a.adset_id === adsetId);
      if (campaignId) return rows.filter((a) => a.campaign_id === campaignId || (!!a.adset_id && !!campAdsets?.has(a.adset_id)));
      return rows;
    };
    // Una copia sin campaign_id ni lista de ad sets no sirve para filtrar por campaña: se pide a Meta.
    const canPick = !campaignId || !!campAdsets || (snap?.data.some((a) => a.campaign_id) ?? false);
    if (snap?.fresh && !refresh && canPick) {
      return NextResponse.json({ ads: pick(snap.data), syncedAt: snap.syncedAt, source: "db" });
    }
    try {
      const ads = await getAds(accountId, adsetId ?? undefined, bmId, op, { force: refresh, campaignId: campaignId ?? undefined });
      if (refresh && op && !adsetId && !campaignId) await saveListingSnapshot(op, accountId, "ads", "", ads);
      return NextResponse.json({ ads, syncedAt: new Date(), source: "meta" });
    } catch (e) {
      if (!snap || !canPick) throw e;
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
