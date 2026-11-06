import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCampaigns, invalidateAccountCaches, type MetaCampaign } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readSnapshotWithAge } from "@/lib/listing-sync";
import { syncQueue, JOB_TYPES } from "@/lib/queue";
import { errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";

// Campañas de una cuenta.
//  - Normal: copia de DB si es reciente (<45 min); si es vieja, Meta en vivo.
//  - refresh=true («Sincronizar con Meta»): Meta en vivo saltando cachés + re-sync de
//    campañas y sus métricas en segundo plano. Ad sets y anuncios no se tocan aquí:
//    se sincronizan cada 6 h o desde su propia pestaña.
// Si Meta falla y hay copia, se sirve la copia marcada como desactualizada.
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
    const snap = op && !cursor ? await readSnapshotWithAge<MetaCampaign[]>(op, accountId, "campaigns") : null;
    if (snap?.fresh && !refresh) {
      return NextResponse.json({ campaigns: snap.data, nextCursor: null, syncedAt: snap.syncedAt, source: "db" });
    }
    try {
      if (refresh) {
        await invalidateAccountCaches(accountId);
        if (op && bmId) {
          try {
            await syncQueue.add(JOB_TYPES.SYNC_LISTINGS_ACCOUNT, { operationId: op, accountId, bmId, scope: "light" }, {
              jobId: `sync-acc-${op}-${accountId}-${Math.floor(Date.now() / 60_000)}`, // 1 por minuto y cuenta
              removeOnComplete: true, removeOnFail: true,
            });
          } catch { /* sin cola: el refresco en vivo basta */ }
        }
      }
      const result = await getCampaigns(accountId, cursor, bmId, op, { force: refresh });
      return NextResponse.json({ ...result, syncedAt: new Date(), source: result.stale ? "cache" : "meta" });
    } catch (e) {
      if (!snap) throw e;
      const info = serializeError(e);
      return NextResponse.json({
        campaigns: snap.data, nextCursor: null, syncedAt: snap.syncedAt, source: "db",
        stale: true, staleReason: userLine(info), errorInfo: info,
      });
    }
  } catch (err) {
    return errorResponse(err, "campaigns");
  }
}
