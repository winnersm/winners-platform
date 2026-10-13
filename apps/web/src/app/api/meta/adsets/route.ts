import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAdSets, type MetaAdSet } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readListingSnapshot } from "@/lib/listing-sync";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const campaignId = searchParams.get("campaignId");
  const refresh = searchParams.get("refresh") === "true";
  const bmId = searchParams.get("bmId") ?? undefined;
  const op = (await getActiveOperationId()) ?? undefined;

  if (!accountId) {
    return NextResponse.json({ error: "accountId requerido" }, { status: 400 });
  }

  try {
    // Servir desde DB (todos los adsets de la cuenta) filtrando por campaña.
    if (op && !refresh) {
      const snap = await readListingSnapshot<MetaAdSet[]>(op, accountId, "adsets");
      if (snap) {
        const adsets = campaignId ? snap.data.filter((a) => a.campaign_id === campaignId) : snap.data;
        return NextResponse.json({ adsets, fromDb: true, syncedAt: snap.syncedAt });
      }
    }
    const adsets = await getAdSets(accountId, campaignId ?? undefined, bmId, op);
    return NextResponse.json({ adsets });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[adsets]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
