import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getInsights, type MetaInsights } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { readListingSnapshot } from "@/lib/listing-sync";

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
    // Servir insights desde DB (por nivel + preset) si hay snapshot.
    if (op && !refresh) {
      const snap = await readListingSnapshot<MetaInsights[]>(op, accountId, `ins:${level}`, datePreset);
      if (snap) return NextResponse.json({ data: snap.data, count: snap.data.length, fromDb: true });
    }
    const data = await getInsights(accountId, level, datePreset, bmId, op);
    return NextResponse.json({ data, count: data.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error";
    console.error(`[insights API] level=${level}:`, message);
    return NextResponse.json({ error: message, data: [] }, { status: 500 });
  }
}
