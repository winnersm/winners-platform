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
  forceRefresh?: boolean,
): Promise<{ accounts: number; snapshots: number; archived: number }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId, forceRefresh);
  } catch {
    return { accounts: 0, snapshots: 0, archived: 0 };
  }

  // Membresía viva del BM: todos los accountId que el BM devuelve ahora (de
  // cualquier estado). Es la fuente de verdad para saber qué cuentas siguen.
  const currentIds = new Set(accounts.map((a) => a.id.replace("act_", "")));
  const now = new Date();
  let snaps = 0;

  // Se piden insights de TODAS las cuentas del BM, no solo de las activas. Si
  // solo se pidieran las activas, al desactivarse una cuenta su última foto
  // quedaría congelada y el dashboard seguiría mostrando su "today" de hace
  // semanas como si fuera de hoy. Además evita la incoherencia de enseñar unas
  // cuentas desactivadas sí y otras no, según si alguna vez estuvieron activas.
  for (const a of accounts) {
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
          accountName: a.name, accountStatus: a.account_status, bmId: a.bmId, currency: a.currency,
          data: insights ? (insights as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          spend: parseFloat(insights?.spend ?? "0"),
          syncedAt: now, lastSeenInBmAt: now, removedFromBmAt: null,
        },
        update: {
          accountName: a.name, accountStatus: a.account_status, bmId: a.bmId, currency: a.currency,
          data: insights ? (insights as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          spend: parseFloat(insights?.spend ?? "0"),
          syncedAt: now, lastSeenInBmAt: now, removedFromBmAt: null,
        },
      });
      snaps++;
      await new Promise((r) => setTimeout(r, 250)); // pacing para no saturar la cuenta
    }
  }

  // Red de seguridad para las cuentas no activas: si su llamada de insights
  // falló arriba (rate limit, permiso), la fila no se habría tocado y seguiría
  // marcada como activa. Esto refresca estado y membresía sin gastar cuota.
  for (const a of accounts) {
    if (a.account_status === 1) continue;
    const rawId = a.id.replace("act_", "");
    await prisma.accountInsightSnapshot.updateMany({
      where: { operationId, accountId: rawId },
      data: { accountStatus: a.account_status, lastSeenInBmAt: now, removedFromBmAt: null },
    });
  }

  // Desarchivar cualquier cuenta que haya VUELTO al BM, aunque hoy sus insights
  // fallen (rate limit): si está en la lista viva, no es un fantasma. Sin esto,
  // una cuenta reincorporada con insights fallidos seguiría oculta como archivada.
  if (currentIds.size > 0) {
    await prisma.accountInsightSnapshot.updateMany({
      where: { operationId, accountId: { in: [...currentIds] }, removedFromBmAt: { not: null } },
      data: { removedFromBmAt: null, lastSeenInBmAt: now },
    });
  }

  // Archivar (NUNCA borrar) las cuentas que ya no aparecen en el BM. Se marca la
  // fecha de salida una sola vez; las ya archivadas se dejan intactas. El guardia
  // evita archivar todo si el BM respondiera con lista vacía por un fallo.
  let archived = 0;
  if (currentIds.size > 0) {
    const res = await prisma.accountInsightSnapshot.updateMany({
      where: { operationId, accountId: { notIn: [...currentIds] }, removedFromBmAt: null },
      data: { removedFromBmAt: now },
    });
    archived = res.count;
  }

  return { accounts: accounts.length, snapshots: snaps, archived };
}

// Sincroniza TODAS las operaciones (lo llama el job en segundo plano).
export async function syncAllDashboards(): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const r = await syncDashboardForOperation(op.id);
      console.log(`[dashboard-sync] ${op.name}: ${r.accounts} cuentas, ${r.snapshots} snapshots, ${r.archived} archivadas`);
    } catch (e) {
      console.error(`[dashboard-sync] ${op.name} falló:`, e);
    }
  }
}
