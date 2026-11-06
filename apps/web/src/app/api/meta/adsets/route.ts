import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAdSets, type MetaAdSet } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readSnapshotWithAge, saveListingSnapshot } from "@/lib/listing-sync";
import { errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";
import { markMetaSource } from "@/lib/meta-calls";

// Ad sets de una cuenta (o de una campaña). Misma política que /api/meta/campaigns:
// copia de DB si es reciente; si no, Meta en vivo; refresh=true salta los cachés.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const campaignId = searchParams.get("campaignId");
  const refresh = searchParams.get("refresh") === "true";
  if (refresh) markMetaSource("sincronizar");
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  if (!accountId) {
    return NextResponse.json({ error: "accountId requerido" }, { status: 400 });
  }

  const pick = (rows: MetaAdSet[]) => (campaignId ? rows.filter((a) => a.campaign_id === campaignId) : rows);

  try {
    const snap = op ? await readSnapshotWithAge<MetaAdSet[]>(op, accountId, "adsets") : null;
    if (snap?.fresh && !refresh) {
      return NextResponse.json({ adsets: pick(snap.data), syncedAt: snap.syncedAt, source: "db" });
    }
    try {
      const adsets = await getAdSets(accountId, campaignId ?? undefined, bmId, op, { force: refresh });
      // Lectura completa de la cuenta pedida a mano: pasa a ser la copia vigente.
      if (refresh && op && !campaignId) await saveListingSnapshot(op, accountId, "adsets", "", adsets);
      return NextResponse.json({ adsets, syncedAt: new Date(), source: "meta" });
    } catch (e) {
      if (!snap) throw e;
      const info = serializeError(e);
      return NextResponse.json({
        adsets: pick(snap.data), syncedAt: snap.syncedAt, source: "db",
        stale: true, staleReason: userLine(info), errorInfo: info,
      });
    }
  } catch (err) {
    return errorResponse(err, "adsets");
  }
}
