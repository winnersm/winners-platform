import { prisma } from "@winners/db";
import { getAdAccounts, getActiveToken } from "@/lib/meta-api";
import { getPurchaseRevenue, getPurchaseCount, type Insights } from "@/lib/metrics";

// Libro diario de gasto por cuenta. Se alimenta del insights de Meta con
// time_increment=1 (una fila por día). A diferencia del dashboard (que sobrescribe
// la última foto), esto acumula: permite consultar el gasto por cualquier rango y
// conserva el histórico aunque la cuenta salga del BM.

const BASE = "https://graph.facebook.com/v21.0";

interface DailyRaw {
  date_start: string; // "YYYY-MM-DD"
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    const res = await fetch(next);
    const json = (await res.json()) as {
      data?: DailyRaw[];
      error?: { code?: number; message?: string };
      paging?: { next?: string };
    };
    if (json.error) throw new Error(`Meta error ${json.error.code ?? ""}: ${json.error.message ?? "insights diarios"}`);
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
    pages++;
    if (next) await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

async function upsertDays(
  rawId: string,
  accountName: string,
  bmId: string | undefined,
  operationId: string,
  rows: DailyRaw[],
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const day = new Date(`${r.date_start}T00:00:00.000Z`);
    const ins: Insights = {
      spend: r.spend ?? "0",
      impressions: r.impressions,
      clicks: r.clicks,
      actions: r.actions,
      action_values: r.action_values,
    };
    const data = {
      accountName,
      bmId: bmId ?? null,
      spend: parseFloat(r.spend ?? "0"),
      revenue: getPurchaseRevenue(ins),
      sales: Math.round(getPurchaseCount(ins)),
      impressions: parseInt(r.impressions ?? "0", 10) || 0,
      clicks: parseInt(r.clicks ?? "0", 10) || 0,
    };
    await prisma.accountSpendDaily.upsert({
      where: { accountId_operationId_date: { accountId: rawId, operationId, date: day } },
      create: { accountId: rawId, operationId, date: day, ...data },
      update: data,
    });
    n++;
  }
  return n;
}

// Sync incremental: reescribe los últimos `trailingDays` días de cada cuenta activa.
// La ventana corta (no solo "ayer") recupera los ajustes tardíos de Meta
// (conversiones que entran con retraso) y rellena huecos si un día falló.
export async function syncSpendDailyForOperation(
  operationId: string,
  trailingDays = 4,
): Promise<{ accounts: number; days: number }> {
  let accounts;
  try {
    accounts = await getAdAccounts(undefined, operationId);
  } catch {
    return { accounts: 0, days: 0 };
  }
  const active = accounts.filter((a) => a.account_status === 1);
  const until = new Date();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (trailingDays - 1));

  let days = 0;
  for (const a of active) {
    const rawId = a.id.replace("act_", "");
    try {
      const rows = await fetchDailySpend(rawId, a.bmId, operationId, ymd(since), ymd(until));
      days += await upsertDays(rawId, a.name, a.bmId, operationId, rows);
    } catch {
      continue; // una cuenta que falla no frena a las demás
    }
    await new Promise((r) => setTimeout(r, 250)); // pacing anti rate-limit
  }
  return { accounts: active.length, days };
}

// Lo llama el job diario del worker: todas las operaciones.
export async function syncAllSpendDaily(): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const r = await syncSpendDailyForOperation(op.id);
      console.log(`[spend-daily] ${op.name}: ${r.accounts} cuentas, ${r.days} días`);
    } catch (e) {
      console.error(`[spend-daily] ${op.name} falló:`, e);
    }
  }
}

// Siembra el histórico de los últimos `monthsBack` meses (solo cuentas activas).
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
  const active = accounts.filter((a) => a.account_status === 1);

  const end = new Date();
  const start = new Date();
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
  for (const a of active) {
    const rawId = a.id.replace("act_", "");
    for (const w of windows) {
      try {
        const rows = await fetchDailySpend(rawId, a.bmId, operationId, w.since, w.until);
        days += await upsertDays(rawId, a.name, a.bmId, operationId, rows);
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { accounts: active.length, days };
}

export interface SpendRangeRow {
  accountId: string;
  name: string;
  bmId: string | null;
  spend: number;
  revenue: number;
  sales: number;
  days: number;
}

export interface SpendRangeResult {
  rows: SpendRangeRow[];
  totals: { spend: number; revenue: number; sales: number };
  series: Array<{ date: string; spend: number; revenue: number }>;
}

// Consulta por rango [from, to] (inclusive): total por cuenta + serie diaria agregada.
export async function getSpendByRange(
  operationId: string,
  from: Date,
  to: Date,
): Promise<SpendRangeResult> {
  const where = { operationId, date: { gte: from, lte: to } };

  const [grouped, names, series] = await Promise.all([
    prisma.accountSpendDaily.groupBy({
      by: ["accountId"],
      where,
      _sum: { spend: true, revenue: true, sales: true },
      _count: { date: true },
    }),
    // Nombre/BM más reciente de cada cuenta en el rango.
    prisma.accountSpendDaily.findMany({
      where,
      distinct: ["accountId"],
      orderBy: { date: "desc" },
      select: { accountId: true, accountName: true, bmId: true },
    }),
    prisma.accountSpendDaily.groupBy({
      by: ["date"],
      where,
      _sum: { spend: true, revenue: true },
      orderBy: { date: "asc" },
    }),
  ]);

  const nameOf = new Map(names.map((n) => [n.accountId, { name: n.accountName, bmId: n.bmId }]));

  const rows: SpendRangeRow[] = grouped
    .map((g) => ({
      accountId: g.accountId,
      name: nameOf.get(g.accountId)?.name ?? g.accountId,
      bmId: nameOf.get(g.accountId)?.bmId ?? null,
      spend: g._sum.spend ?? 0,
      revenue: g._sum.revenue ?? 0,
      sales: g._sum.sales ?? 0,
      days: g._count.date,
    }))
    .sort((a, b) => b.spend - a.spend);

  const totals = rows.reduce(
    (s, r) => ({ spend: s.spend + r.spend, revenue: s.revenue + r.revenue, sales: s.sales + r.sales }),
    { spend: 0, revenue: 0, sales: 0 },
  );

  const seriesOut = series.map((s) => ({
    date: ymd(s.date),
    spend: s._sum.spend ?? 0,
    revenue: s._sum.revenue ?? 0,
  }));

  return { rows, totals, series: seriesOut };
}
