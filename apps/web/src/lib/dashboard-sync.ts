import { Prisma } from "@winners/db";
import { prisma } from "@winners/db";
import { getAdAccounts, getAccountInsights, getDailyAccountInsights, type MetaInsights } from "@/lib/meta-api";
import { coveringRange, periodRange, sumDays, type DateRange } from "@/lib/insight-periods";

// Filtros de fecha que se sincronizan a DB. Ritmo del job: lo que incluye hoy, cada
// hora; los periodos cerrados, una vez al día. Solo las fechas personalizadas se
// sirven en vivo (con caché/stale/coalescing).
export const DASHBOARD_HOURLY_PRESETS = ["today", "this_month"];
export const DASHBOARD_DAILY_PRESETS = ["yesterday", "last_7d", "last_14d", "last_30d", "last_month", "maximum"];
export const DASHBOARD_PRESETS = [...DASHBOARD_HOURLY_PRESETS, ...DASHBOARD_DAILY_PRESETS];

/** Fecha de hoy en la zona de la operación, la misma con la que se pide «hoy» a Meta. */
async function operationToday(operationId: string): Promise<string> {
  const op = await prisma.operation.findUnique({ where: { id: operationId }, select: { timezone: true } });
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: op?.timezone ?? "America/Bogota",
  }).format(new Date());
}

// Sincroniza los insights a nivel cuenta de UNA operación → tabla snapshot.
// Lee siempre directo de Meta (el ritmo lo marca quien llama, no el caché) y va
// paceado por cuenta. syncedAt es la hora en que llegó ese dato de Meta: si la
// lectura falla, la fila conserva su dato y su hora.
//
// Con dos o más periodos calculables basta una llamada día por día por cuenta y cada
// periodo sale de sumar sus días. Un periodo suelto («Sincronizar con Meta») y los que
// no se pueden calcular se piden a Meta tal cual.
export async function syncDashboardForOperation(
  operationId: string,
  presets: string[] = DASHBOARD_PRESETS,
  forceRefresh?: boolean,
): Promise<{ accounts: number; snapshots: number; failed: number; archived: number }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId, forceRefresh);
  } catch {
    return { accounts: 0, snapshots: 0, failed: 0, archived: 0 };
  }

  // Membresía viva del BM: todos los accountId que el BM devuelve ahora (de
  // cualquier estado). Es la fuente de verdad para saber qué cuentas siguen.
  const currentIds = new Set(accounts.map((a) => a.id.replace("act_", "")));
  const now = new Date();
  let snaps = 0;
  let failed = 0;

  const today = await operationToday(operationId);
  const ranges = new Map(presets.flatMap((p): Array<[string, DateRange]> => {
    const range = periodRange(p, today);
    return range ? [[p, range]] : [];
  }));
  const window = ranges.size >= 2 ? coveringRange([...ranges.values()]) : null;
  const direct = window ? presets.filter((p) => !ranges.has(p)) : presets;
  const pace = () => new Promise((r) => setTimeout(r, 250)); // para no saturar la cuenta

  // Se piden insights de TODAS las cuentas del BM, no solo de las activas. Si
  // solo se pidieran las activas, al desactivarse una cuenta su última foto
  // quedaría congelada y el dashboard seguiría mostrando su "today" de hace
  // semanas como si fuera de hoy. Además evita la incoherencia de enseñar unas
  // cuentas desactivadas sí y otras no, según si alguna vez estuvieron activas.
  for (const a of accounts) {
    const rawId = a.id.replace("act_", "");
    // Si una lectura falla (rate limit, permiso, etc.) sus periodos no entran aquí y
    // conservan el snapshot anterior.
    const results: Array<[string, MetaInsights | null]> = [];
    if (window) {
      try {
        const days = await getDailyAccountInsights(rawId, window.since, window.until, a.bmId, operationId);
        for (const [preset, range] of ranges) results.push([preset, sumDays(days, range)]);
      } catch {
        failed += ranges.size;
      }
      await pace();
    }
    for (const preset of direct) {
      try {
        results.push([preset, await getAccountInsights(rawId, preset, a.bmId, operationId, { force: true })]);
      } catch {
        failed++;
      }
      await pace();
    }

    for (const [preset, insights] of results) {
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

  return { accounts: accounts.length, snapshots: snaps, failed, archived };
}

// Sincroniza TODAS las operaciones (lo llama el job en segundo plano).
export async function syncAllDashboards(presets: string[] = DASHBOARD_PRESETS): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const r = await syncDashboardForOperation(op.id, presets);
      console.log(`[dashboard-sync] ${op.name} (${presets.join(", ")}): ${r.accounts} cuentas, ${r.snapshots} snapshots, ${r.failed} fallidas, ${r.archived} archivadas`);
    } catch (e) {
      console.error(`[dashboard-sync] ${op.name} falló:`, e);
    }
  }
}
