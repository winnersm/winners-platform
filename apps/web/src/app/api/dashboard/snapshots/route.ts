import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { getActiveOperationId } from "@/lib/operation";

// Dashboard servido desde DB: snapshots de insights a nivel cuenta (los llena el
// job SYNC_DASHBOARD en segundo plano). Instantáneo, sin pegarle a Meta.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = await getActiveOperationId();
  const datePreset = req.nextUrl.searchParams.get("datePreset") ?? "last_7d";
  if (!op) return NextResponse.json({ accounts: [], synced: false, syncedAt: null });

  const rows = await prisma.accountInsightSnapshot.findMany({
    where: { operationId: op, datePreset },
    orderBy: { spend: "desc" },
  });

  const accounts = rows.map((r) => ({
    id: `act_${r.accountId}`,
    name: r.accountName ?? r.accountId,
    bmId: r.bmId ?? "",
    account_status: r.accountStatus,
    insights: r.data ?? null,
  }));

  const syncedAt = rows.reduce<Date | null>(
    (max, r) => (max && max > r.syncedAt ? max : r.syncedAt),
    null
  );

  return NextResponse.json({ accounts, synced: rows.length > 0, syncedAt });
}
