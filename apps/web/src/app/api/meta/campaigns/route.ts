import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCampaigns, invalidateCampaignsCache, type MetaCampaign } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readListingSnapshot } from "@/lib/listing-sync";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  if (!accountId) return NextResponse.json({ error: "accountId requerido" }, { status: 400 });

  const cursor = searchParams.get("cursor") ?? undefined;
  const refresh = searchParams.get("refresh") === "true";
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  try {
    if (refresh) {
      // Refresco en vivo + re-sync de toda la cuenta en segundo plano (adsets/ads/insights).
      await invalidateCampaignsCache(accountId);
      if (op && bmId) {
        try { await duplicationsQueue.add(JOB_TYPES.SYNC_LISTINGS_ACCOUNT, { operationId: op, accountId, bmId }); } catch {}
      }
    } else if (op && !cursor) {
      // Servir desde DB (todas las campañas → sin paginación).
      const snap = await readListingSnapshot<MetaCampaign[]>(op, accountId, "campaigns");
      if (snap) return NextResponse.json({ campaigns: snap.data, nextCursor: null, syncedAt: snap.syncedAt, fromDb: true });
    }
    const result = await getCampaigns(accountId, cursor, bmId, op);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
