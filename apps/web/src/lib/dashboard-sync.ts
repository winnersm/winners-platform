import { Prisma } from "@winners/db";
import { prisma } from "@winners/db";
import { getAdAccounts, getAccountInsights, type MetaInsights } from "@/lib/meta-api";

// Presets que se sincronizan a DB (los más usados del dashboard). Otros presets
// siguen sirviéndose en vivo (con caché/stale/coalescing).
export const DASHBOARD_PRESETS = ["today", "last_7d", "last_30d"];

// Sincroniza los insights a nivel cuenta de UNA operación → tabla snapshot.
// Reusa getAccountInsights (caché/coalescing/stale) y va paceado por cuenta.
export async function syncDashboardForOperation(
  operationId: string,
  presets: string[] = DASHBOARD_PRESETS,
): Promise<{ accounts: number; snapshots: number }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId);
  } catch {
    return { accounts: 0, snapshots: 0 };
  }
  const active = accounts.filter((a) => a.account_status === 1);
  let snaps = 0;

  for (const a of active) {
    const rawId = a.id.replace("act_", "");
    for (const preset of presets) {
      let insights: MetaInsights | null = null;
      try {
        insights = await getAccountInsights(rawId, preset, a.bmId, operationId);
      } catch {
        continue; // conservar el snapshot anterior si falla (rate limit, permiso, etc.)
      }
      await prisma.accountInsightSnapshot.upsert({
        where: { accountId_operationId_datePreset: { accountId: rawId, operationId, datePreset: preset } },
        create: {
          accountId: rawId, operationId, datePreset: preset,
          accountName: a.name, accountStatus: a.account_status, bmId: a.bmId,
          data: insights ? (insights as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          spend: parseFloat(insights?.spend ?? "0"),
          syncedAt: new Date(),
        },
        update: {
          accountName: a.name, accountStatus: a.account_status, bmId: a.bmId,
          data: insights ? (insights as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          spend: parseFloat(insights?.spend ?? "0"),
          syncedAt: new Date(),
        },
      });
      snaps++;
      await new Promise((r) => setTimeout(r, 250)); // pacing para no saturar la cuenta
    }
  }
  return { accounts: active.length, snapshots: snaps };
}

// Sincroniza TODAS las operaciones (lo llama el job en segundo plano).
export async function syncAllDashboards(): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const r = await syncDashboardForOperation(op.id);
      console.log(`[dashboard-sync] ${op.name}: ${r.accounts} cuentas, ${r.snapshots} snapshots`);
    } catch (e) {
      console.error(`[dashboard-sync] ${op.name} falló:`, e);
    }
  }
}
