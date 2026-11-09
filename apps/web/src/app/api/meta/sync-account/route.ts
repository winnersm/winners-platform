import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getCampaigns, getAdSets, getAds, invalidateAccountCaches,
  type MetaCampaign, type MetaAdSet, type MetaAd,
} from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { saveListingSnapshot } from "@/lib/listing-sync";
import { errorResponse } from "@/lib/api-error";
import { markMetaSource } from "@/lib/meta-calls";

// «Sincronizar con Meta» de UNA cuenta, paso a paso para que la UI muestre el progreso.
// Cada paso lee la lista COMPLETA de la cuenta en vivo (sin cachés), la guarda como copia
// vigente en la DB y la devuelve tal cual. El general de todas las cuentas lo hace el job.
//   step=campaigns | adsets | ads
// Las métricas van por /api/meta/insights?refresh=true, que ya las guarda.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const step = searchParams.get("step");
  const bmId = searchParams.get("bmId") ?? undefined;
  if (!accountId || !step || !["campaigns", "adsets", "ads"].includes(step)) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }
  markMetaSource("sincronizar");
  const op = (await getActiveOperationId()) ?? undefined;

  try {
    if (step === "campaigns") {
      await invalidateAccountCaches(accountId); // solo el primer paso; los demás ya van con force
      const all: MetaCampaign[] = [];
      let cursor: string | undefined;
      do {
        const r = await getCampaigns(accountId, cursor, bmId, op, { force: true });
        all.push(...r.campaigns);
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      if (op) await saveListingSnapshot(op, accountId, "campaigns", "", all);
      return NextResponse.json({ campaigns: all, count: all.length, syncedAt: new Date(), source: "meta" });
    }
    if (step === "adsets") {
      const adsets: MetaAdSet[] = await getAdSets(accountId, undefined, bmId, op, { force: true });
      if (op) await saveListingSnapshot(op, accountId, "adsets", "", adsets);
      return NextResponse.json({ adsets, count: adsets.length, syncedAt: new Date(), source: "meta" });
    }
    const ads: MetaAd[] = await getAds(accountId, undefined, bmId, op, { force: true });
    if (op) await saveListingSnapshot(op, accountId, "ads", "", ads);
    return NextResponse.json({ ads, count: ads.length, syncedAt: new Date(), source: "meta" });
  } catch (err) {
    return errorResponse(err, `sync-account ${step}`);
  }
}
