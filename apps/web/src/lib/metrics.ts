// Métricas de rendimiento a partir de un insight de Meta. Compartido (dashboard, etc.).
export interface Insights {
  spend: string; impressions?: string; clicks?: string; ctr?: string; cpc?: string;
  cpm?: string; inline_link_clicks?: string; unique_link_clicks_ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

// Meta devuelve varios action_types de compra/checkout que se SOLAPAN
// (omni_*, offsite_conversion.*, onsite_*, purchase, web_in_store_*, ...) todos con
// el mismo valor. Sumarlos = doble/óctuple conteo. Se toma el primer tipo canónico
// presente: omni_* es el deduplicado que muestra Ads Manager.
function pickAction(rows: Array<{ action_type: string; value: string }> | undefined, priority: string[]): number {
  const list = rows ?? [];
  for (const t of priority) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return parseFloat(hit.value || "0");
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "purchase"];
const INITIATE_CHECKOUT = ["omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "onsite_web_initiate_checkout", "initiate_checkout"];

export function getPurchaseRevenue(ins: Insights): number {
  return pickAction(ins.action_values, PURCHASE);
}
export function getPurchaseCount(ins: Insights): number {
  return pickAction(ins.actions, PURCHASE);
}
// IC = Initiate Checkout (evento de Meta), NO inline link clicks.
export function getInitiateCheckout(ins: Insights): number {
  return pickAction(ins.actions, INITIATE_CHECKOUT);
}

export interface Metrics {
  spend: number; revenue: number; sales: number; profit: number;
  cpa: number | null; roi: number | null; cpm: number | null; cpc: number | null;
  ctr: number | null; ic: number | null; costPerIc: number | null;
}

export function calcMetrics(ins: Insights | undefined | null): Metrics | null {
  if (!ins) return null;
  const spend = parseFloat(ins.spend || "0");
  const revenue = getPurchaseRevenue(ins);
  const sales = getPurchaseCount(ins);
  const profit = revenue - spend;
  const imp = parseFloat(ins.impressions || "0");
  const ic = getInitiateCheckout(ins);
  return {
    spend, revenue, sales, profit,
    cpa: sales > 0 && spend > 0 ? spend / sales : null,
    roi: spend > 0 ? (profit / spend) * 100 : null,
    cpm: ins.cpm ? parseFloat(ins.cpm) : spend > 0 && imp > 0 ? (spend / imp) * 1000 : null,
    cpc: ins.cpc ? parseFloat(ins.cpc) : null,
    ctr: ins.ctr ? parseFloat(ins.ctr) : null,
    ic: ic > 0 ? ic : null,
    costPerIc: ic > 0 && spend > 0 ? spend / ic : null,
  };
}

export const fmtMoney = (n: number | null) => `$${(n ?? 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtInt = (n: number | null) => {
  const x = n ?? 0;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}K`;
  return Math.round(x).toString();
};
export const fmtPct = (n: number | null) => `${(n ?? 0).toFixed(2)}%`;
