import type { MetaInsights } from "@/lib/meta-api";

// Periodos de Rendimiento que se pueden calcular a partir de filas día por día
// (time_increment=1), con las mismas fechas que usa Meta en cada date_preset: los
// «últimos N días» terminan ayer, no incluyen hoy. «maximum» no está: no tiene un
// inicio conocido y siempre se pide a Meta directamente.

export interface DateRange { since: string; until: string }
export type DailyInsights = MetaInsights & { date_start: string };

const addDays = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Fechas de un periodo visto desde `today` (YYYY-MM-DD); null si no se puede calcular. */
export function periodRange(preset: string, today: string): DateRange | null {
  const yesterday = addDays(today, -1);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  switch (preset) {
    case "today": return { since: today, until: today };
    case "yesterday": return { since: yesterday, until: yesterday };
    case "last_7d": return { since: addDays(today, -7), until: yesterday };
    case "last_14d": return { since: addDays(today, -14), until: yesterday };
    case "last_30d": return { since: addDays(today, -30), until: yesterday };
    case "this_month": return { since: monthStart, until: today };
    case "last_month": return { since: `${lastMonthEnd.slice(0, 7)}-01`, until: lastMonthEnd };
    default: return null;
  }
}

/** Ventana mínima que cubre todos los periodos. Las fechas ISO se comparan como texto. */
export function coveringRange(ranges: DateRange[]): DateRange {
  return {
    since: ranges.map((r) => r.since).sort()[0],
    until: ranges.map((r) => r.until).sort().at(-1) as string,
  };
}

const round = (n: number) => String(Math.round(n * 100) / 100);

function sumActions(rows: Array<MetaInsights["actions"]>): MetaInsights["actions"] {
  const totals = new Map<string, number>();
  for (const list of rows) {
    for (const a of list ?? []) totals.set(a.action_type, (totals.get(a.action_type) ?? 0) + parseFloat(a.value || "0"));
  }
  if (!totals.size) return undefined;
  return [...totals].map(([action_type, value]) => ({ action_type, value: round(value) }));
}

/**
 * Junta las filas diarias que caen en un periodo. Los crudos se suman; CTR, CPC y CPM
 * no se pueden sumar y se recalculan. Sin filas no hubo actividad: null, como en Meta.
 * Sin base para una métrica queda vacía, igual que cuando Meta no la devuelve.
 */
export function sumDays(days: DailyInsights[], { since, until }: DateRange): MetaInsights | null {
  const rows = days.filter((d) => d.date_start >= since && d.date_start <= until);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0]; // un solo día ya es el dato de Meta

  const total = (field: "spend" | "impressions" | "clicks" | "inline_link_clicks") =>
    rows.reduce((sum, r) => sum + parseFloat(r[field] ?? "0"), 0);
  const spend = total("spend");
  const impressions = total("impressions");
  const clicks = total("clicks");
  return {
    spend: spend.toFixed(2),
    impressions: String(impressions),
    clicks: String(clicks),
    inline_link_clicks: String(total("inline_link_clicks")),
    ctr: impressions > 0 ? String((clicks / impressions) * 100) : "",
    cpc: clicks > 0 ? String(spend / clicks) : "",
    cpm: impressions > 0 ? String((spend / impressions) * 1000) : "",
    actions: sumActions(rows.map((r) => r.actions)),
    action_values: sumActions(rows.map((r) => r.action_values)),
  };
}
