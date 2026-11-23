import { prisma } from "@winners/db";
import { getAdAccounts, getActiveToken } from "@/lib/meta-api";
import { getPurchaseRevenue, getPurchaseCount, type Insights } from "@/lib/metrics";
import { metaFetch } from "@/lib/meta-calls";
import { MetaApiError } from "@/lib/meta-errors";

// Libro diario de gasto por cuenta. Se alimenta del insights de Meta con
// time_increment=1 (una fila por día). A diferencia del dashboard (que sobrescribe
// la última foto), esto acumula: permite consultar el gasto por cualquier rango y
// conserva el histórico aunque la cuenta salga del BM.

const BASE = "https://graph.facebook.com/v21.0";

interface DailyRaw {
  date_start: string; // "YYYY-MM-DD"
  date_stop?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Fecha de hoy en la zona de la operación (la misma que usa Rendimiento). Con la
// fecha UTC, por la noche se pedía "mañana" a Meta.
async function operationToday(operationId: string): Promise<Date> {
  const op = await prisma.operation.findUnique({ where: { id: operationId }, select: { timezone: true } });
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: op?.timezone ?? "America/Bogota" }).format(new Date());
  return new Date(`${s}T00:00:00.000Z`);
}

// Insights diario a nivel cuenta, día por día, en una ventana [since, until].
async function fetchDailySpend(
  accountId: string,
  bmId: string | undefined,
  operationId: string | undefined,
  since: string,
  until: string,
): Promise<DailyRaw[]> {
  const { token } = await getActiveToken(bmId, operationId);
  const u = new URL(`${BASE}/act_${accountId}/insights`);
  u.searchParams.set("access_token", token);
  u.searchParams.set("level", "account");
  u.searchParams.set("fields", "spend,impressions,clicks,actions,action_values");
  u.searchParams.set("time_increment", "1");
  u.searchParams.set("time_range", JSON.stringify({ since, until }));
  u.searchParams.set("limit", "500");

  const out: DailyRaw[] = [];
  let next: string | null = u.toString();
  let pages = 0;
  while (next && pages < 100) {
    const res = await metaFetch(next);
    const json = (await res.json()) as {
      data?: DailyRaw[];
      error?: { code?: number; message?: string };
      paging?: { next?: string };
    };
    if (json.error) {
      throw new MetaApiError({
        code: json.error.code,
        message: json.error.message ?? "insights diarios",
        httpStatus: res.status,
        endpoint: `GET act_${accountId}/insights (diario)`,
      });
    }
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
    pages++;
    if (next) await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/**
 * Guarda en el libro la respuesta día por día de Meta para una cuenta y una ventana
 * [since, until]. La ventana se reemplaza entera: Meta omite los días sin gasto, así
 * que un día guardado que ya no viene en la respuesta pasó a cero y se borra.
 * Lo usan el sync de Rendimiento (que ya pide estos días) y «Traer histórico».
 */
export async function saveSpendDays(
  operationId: string,
  account: { id: string; name: string; bmId?: string | null; currency?: string | null },
  window: { since: string; until: string },
  rows: DailyRaw[],
): Promise<number> {
  const accountId = account.id.replace("act_", "");
  const data = rows
    .filter((r) => r.date_start >= window.since && r.date_start <= window.until)
    .map((r) => {
      const ins: Insights = {
        spend: r.spend ?? "0",
        impressions: r.impressions,
        clicks: r.clicks,
        actions: r.actions,
        action_values: r.action_values,
      };
      return {
        accountId,
        operationId,
        date: new Date(`${r.date_start}T00:00:00.000Z`),
        accountName: account.name,
        bmId: account.bmId ?? null,
        currency: account.currency ?? null,
        spend: parseFloat(r.spend ?? "0"),
        revenue: getPurchaseRevenue(ins),
        sales: Math.round(getPurchaseCount(ins)),
        impressions: parseInt(r.impressions ?? "0", 10) || 0,
        clicks: parseInt(r.clicks ?? "0", 10) || 0,
      };
    });
  await prisma.$transaction([
    prisma.accountSpendDaily.deleteMany({
      where: {
        accountId,
        operationId,
        date: { gte: new Date(`${window.since}T00:00:00.000Z`), lte: new Date(`${window.until}T00:00:00.000Z`) },
      },
    }),
    prisma.accountSpendDaily.createMany({ data }),
  ]);
  return data.length;
}

// Sync a demanda (botón «Sincronizar» de Gasto histórico): reescribe los últimos
// `trailingDays` días de cada cuenta. El libro lo alimenta normalmente el sync de
// Rendimiento (dashboard-sync), que ya pide estos días cada hora.
export async function syncSpendDailyForOperation(
  operationId: string,
  trailingDays = 4,
): Promise<{ accounts: number; days: number; failed: string[] }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId);
  } catch {
    return { accounts: 0, days: 0, failed: [] };
  }
  // Todas las cuentas, no solo las activas: una cuenta deshabilitada o con
  // deuda pudo gastar en esos días y Meta sí lo cuenta.
  const until = await operationToday(operationId);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (trailingDays - 1));

  let days = 0;
  const failed: string[] = [];
  for (const a of accounts) {
    const rawId = a.id.replace("act_", "");
    try {
      const w = { since: ymd(since), until: ymd(until) };
      const rows = await fetchDailySpend(rawId, a.bmId, operationId, w.since, w.until);
      days += await saveSpendDays(operationId, a, w, rows);
    } catch (e) {
      // una cuenta que falla no frena a las demás, pero queda registrada
      failed.push(a.name);
      console.warn(`[spend-daily] ${a.name} (${rawId}) falló:`, e instanceof Error ? e.message : e);
      continue;
    }
    await new Promise((r) => setTimeout(r, 250)); // pacing anti rate-limit
  }
  return { accounts: accounts.length, days, failed };
}

// Ya no está programado (lo cubre el sync de Rendimiento). Se conserva por si
// queda algún job SYNC_SPEND_DAILY encolado.
export async function syncAllSpendDaily(trailingDays = 4): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const r = await syncSpendDailyForOperation(op.id, trailingDays);
      console.log(`[spend-daily] ${op.name}: ${r.accounts} cuentas, ${r.days} días${r.failed.length ? `, ${r.failed.length} con error` : ""}`);
    } catch (e) {
      console.error(`[spend-daily] ${op.name} falló:`, e);
    }
  }
}

// Siembra el histórico de los últimos `monthsBack` meses.
// Trocea en ventanas de 90 días para no pedir rangos enormes de golpe.
export async function backfillSpendDaily(
  operationId: string,
  monthsBack = 12,
): Promise<{ accounts: number; days: number }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId);
  } catch {
    return { accounts: 0, days: 0 };
  }
  const end = await operationToday(operationId);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - monthsBack);

  // Ventanas de 90 días.
  const windows: Array<{ since: string; until: string }> = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const wEnd = new Date(cursor);
    wEnd.setUTCDate(wEnd.getUTCDate() + 89);
    windows.push({ since: ymd(cursor), until: ymd(wEnd < end ? wEnd : end) });
    cursor = new Date(wEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  let days = 0;
  for (const a of accounts) {
    const rawId = a.id.replace("act_", "");
    for (const w of windows) {
      try {
        const rows = await fetchDailySpend(rawId, a.bmId, operationId, w.since, w.until);
        days += await saveSpendDays(operationId, a, w, rows);
      } catch (e) {
        console.warn(`[spend-daily] histórico ${a.name} ${w.since}→${w.until} falló:`, e instanceof Error ? e.message : e);
        continue;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { accounts: accounts.length, days };
}

export interface SpendRangeRow {
  accountId: string;
  name: string;
  bmId: string | null;
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
  days: number;
  /** Tiene histórico pero Meta ya no la devuelve en ningún BM de la operación. */
  removedFromBm: boolean;
}

export interface DayRow {
  date: string;
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
  accounts: number;
}

export interface CurrencyTotal {
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
}

export interface SpendRangeResult {
  rows: SpendRangeRow[];
  totals: CurrencyTotal[];
  /** Una fila por día y moneda (para no mezclar USD/COP). */
  daily: DayRow[];
}

// Consulta por rango [from, to] (inclusive): total por cuenta + serie diaria agregada.
// Totales separados por moneda para evitar mezclar USD/COP/etc.
export async function getSpendByRange(
  operationId: string,
  from: Date,
  to: Date,
): Promise<SpendRangeResult> {
  const where = { operationId, date: { gte: from, lte: to } };

  const [grouped, names, series] = await Promise.all([
    prisma.accountSpendDaily.groupBy({
      by: ["accountId", "currency"],
      where,
      _sum: { spend: true, revenue: true, sales: true },
      _count: { date: true },
    }),
    // Nombre/BM más reciente de cada cuenta en el rango.
    prisma.accountSpendDaily.findMany({
      where,
      distinct: ["accountId"],
      orderBy: { date: "desc" },
      select: { accountId: true, accountName: true, bmId: true, currency: true },
    }),
    prisma.accountSpendDaily.groupBy({
      by: ["date", "currency"],
      where,
      _sum: { spend: true, revenue: true, sales: true },
      _count: { accountId: true },
      orderBy: { date: "asc" },
    }),
  ]);

  // Cuentas que ya no están en el BM: la misma membresía que mantiene Rendimiento
  // (dashboard-sync marca removedFromBmAt), sin consultar a Meta. Una cuenta del
  // libro sin fila en Rendimiento tampoco está en el BM. Si Rendimiento aún no ha
  // sincronizado esta operación no se marca nada.
  const memb = await prisma.accountInsightSnapshot.findMany({
    where: { operationId },
    distinct: ["accountId"],
    select: { accountId: true, removedFromBmAt: true },
  });
  const current: Set<string> | null = memb.length
    ? new Set(memb.filter((m) => m.removedFromBmAt === null).map((m) => m.accountId))
    : null;

  const nameOf = new Map(
    names.map((n) => [n.accountId, { name: n.accountName, bmId: n.bmId, currency: n.currency }])
  );

  const rows: SpendRangeRow[] = grouped
    .map((g) => ({
      accountId: g.accountId,
      name: nameOf.get(g.accountId)?.name ?? g.accountId,
      bmId: nameOf.get(g.accountId)?.bmId ?? null,
      currency: g.currency ?? null,
      spend: g._sum.spend ?? 0,
      revenue: g._sum.revenue ?? 0,
      sales: g._sum.sales ?? 0,
      days: g._count.date,
      removedFromBm: current ? !current.has(g.accountId) : false,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Totales agrupados por moneda
  const totalsByC = new Map<string | null, CurrencyTotal>();
  for (const r of rows) {
    const key = r.currency ?? null;
    const existing = totalsByC.get(key) ?? { currency: key, spend: 0, revenue: 0, sales: 0 };
    totalsByC.set(key, {
      currency: key,
      spend: existing.spend + r.spend,
      revenue: existing.revenue + r.revenue,
      sales: existing.sales + r.sales,
    });
  }
  const totals = Array.from(totalsByC.values()).sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));

  const daily: DayRow[] = series
    .filter((s) => (s._sum.spend ?? 0) > 0 || (s._sum.revenue ?? 0) > 0)
    .map((s) => ({
      date: ymd(s.date),
      currency: s.currency ?? null,
      spend: s._sum.spend ?? 0,
      revenue: s._sum.revenue ?? 0,
      sales: s._sum.sales ?? 0,
      accounts: s._count.accountId,
    }));

  return { rows, totals, daily };
}
