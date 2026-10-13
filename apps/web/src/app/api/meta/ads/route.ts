import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAds, type MetaAd } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readListingSnapshot } from "@/lib/listing-sync";

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

  try {
    // Servir desde DB (todos los ads de la cuenta) filtrando por adset.
    if (op && !refresh) {
      const snap = await readListingSnapshot<MetaAd[]>(op, accountId, "ads");
      if (snap) {
        const ads = adsetId ? snap.data.filter((a) => a.adset_id === adsetId) : snap.data;
        return NextResponse.json({ ads, fromDb: true, syncedAt: snap.syncedAt });
      }
    }
    const ads = await getAds(accountId, adsetId ?? undefined, bmId, op);
    return NextResponse.json({ ads });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[ads]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
