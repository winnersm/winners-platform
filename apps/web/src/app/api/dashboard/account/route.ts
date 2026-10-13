import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccountInsights } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";

// Insights a nivel cuenta (totales) para el dashboard. Se llama por cuenta (progresivo).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const accountId = req.nextUrl.searchParams.get("accountId");
  const bmId = req.nextUrl.searchParams.get("bmId") ?? undefined;
  const datePreset = req.nextUrl.searchParams.get("datePreset") ?? "last_7d";
  const op = (await getActiveOperationId()) ?? undefined;
  if (!accountId) return NextResponse.json({ error: "accountId requerido" }, { status: 400 });

  try {
    const insights = await getAccountInsights(accountId, datePreset, bmId, op);
    return NextResponse.json({ insights });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
