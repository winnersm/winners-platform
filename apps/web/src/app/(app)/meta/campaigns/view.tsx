"use client";

import { useEffect, useState, useCallback, Suspense, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  RefreshCw, Search, Copy, TrendingUp, Play, Pause, Briefcase, Building2,
  ExternalLink, X, CloudDownload, Loader2, CheckCircle2, AlertTriangle, Columns3,
  ChevronDown, ChevronLeft, ChevronRight, ArrowDownWideNarrow, ArrowUpNarrowWide, Info, BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DuplicateCampaignModal } from "@/components/duplicate-campaign-modal";
import { useConfirm } from "@/components/use-confirm";
import { DuplicateAdsetsModal } from "@/components/duplicate-adsets-modal";
import { EntityChartsSheet, type ChartTarget } from "@/components/entity-charts";
import { MetricsSummary } from "@/components/metrics-summary";
import { DuplicateAdsModal } from "@/components/duplicate-ads-modal";
import { ErrorDetails, errorInfoOf, toastApiError, type ErrorInfo } from "@/components/error-details";
import { openJobsDock } from "@/lib/jobs-dock-events";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: string; name: string; status: string; objective: string;
  buying_type: string; daily_budget?: string; lifetime_budget?: string;
  is_cbo: boolean; special_ad_categories: string[];
}
interface AdSet {
  id: string; name: string; status: string; campaign_id?: string;
  daily_budget?: string; lifetime_budget?: string; optimization_goal?: string;
}
interface Ad { id: string; name: string; status: string; creative_id?: string; adset_id?: string; campaign_id?: string; }

interface Insights {
  spend: string; impressions: string; clicks: string; ctr: string; cpc: string;
  cpm?: string; inline_link_clicks?: string; unique_link_clicks_ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}
type Level = "campaign" | "adset" | "ad";
type Selection = { id: string; name: string };
type EntityStatus = "ACTIVE" | "PAUSED";
/** Campaña elegida para ver juntos sus ad sets y anuncios, con el color que la identifica. */
type ScopeCampaign = Selection & { color: string };

// Colores distinguibles entre sí y legibles en claro y oscuro; se repiten pasada la décima.
const SCOPE_COLORS = ["#3b82f6", "#f97316", "#10b981", "#a855f7", "#ef4444", "#eab308", "#06b6d4", "#ec4899", "#84cc16", "#6366f1"];

/** Puntito con el color de la campaña; al pasar el cursor muestra su nombre. */
function CampaignDot({ camp, className = "" }: { camp: ScopeCampaign; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={`Campaña: ${camp.name}`}
            className={`inline-block h-2.5 w-2.5 shrink-0 cursor-help rounded-full ring-2 ring-background ${className}`}
            style={{ backgroundColor: camp.color }}
            onClick={e => e.stopPropagation()}
          />
        }
      />
      <TooltipContent><span className="break-words">Campaña: {camp.name}</span></TooltipContent>
    </Tooltip>
  );
}

/** Cómo llegaron los datos: copia de DB, Meta en vivo, o caché por límite de Meta. */
interface Freshness { syncedAt: string | null; source: string | null }
const NO_FRESHNESS: Freshness = { syncedAt: null, source: null };
/** Frescura y aviso de copia de respaldo de la última carga de un nivel. */
interface DataMeta extends Freshness { stale: boolean; staleInfo: ErrorInfo | null }

// ─── Client-side cache ────────────────────────────────────────────────────────
const CLIENT_TTL = 5 * 60 * 1000;
interface Snap<T> { data: T; key: string; ts: number; }
function fresh<T>(s: Snap<T> | null, key: string): s is Snap<T> {
  return !!s && s.key === key && Date.now() - s.ts < CLIENT_TTL;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { value: "today", label: "Hoy" },
  { value: "yesterday", label: "Ayer" },
  { value: "last_7d", label: "7 días" },
  { value: "last_14d", label: "14 días" },
  { value: "last_30d", label: "30 días" },
  { value: "last_month", label: "Mes ant." },
];

const STATUS_OPTS = [
  { value: "ALL", label: "Todos" },
  { value: "ACTIVE", label: "Activos" },
  { value: "PAUSED", label: "Pausados" },
  { value: "ARCHIVED", label: "Archivados" },
];

/** Presupuesto en la moneda real de la cuenta (Meta lo da en centavos). */
const labelOf = (opts: Array<{ value: string; label: string }>, value: string) =>
  opts.find(o => o.value === value)?.label ?? value;

const ENTITY_STATUS: Record<string, string> = { ACTIVE: "Activo", PAUSED: "Pausado", ARCHIVED: "Archivado", DELETED: "Eliminado" };

// Casilla, estado y acciones van a la izquierda, siempre a la vista aunque la tabla se desplace en
// horizontal (salvo en móvil, donde taparían las métricas). Sus anchos son fijos porque el
// `left` de cada columna fija depende de los de las anteriores.
const STICKY_CHECK = "w-8 min-w-8 max-w-8 md:sticky md:left-0 z-10 bg-card group-hover:bg-muted";
const STICKY_STATUS = "w-16 min-w-16 max-w-16 md:sticky md:left-8 z-10 bg-card group-hover:bg-muted";
const STICKY_ACTIONS = "w-20 min-w-20 max-w-20 md:sticky md:left-24 z-10 bg-card group-hover:bg-muted md:shadow-[6px_0_6px_-6px_rgba(0,0,0,0.15)] xl:shadow-none";
// El nombre solo se fija en pantallas anchas: antes dejaría sin sitio a las métricas.
const STICKY_NAME = "w-[260px] min-w-[260px] max-w-[260px] xl:sticky xl:left-44 z-10 bg-card group-hover:bg-muted xl:shadow-[6px_0_6px_-6px_rgba(0,0,0,0.15)]";

function fmtBudget(cents?: string, currency = "USD") {
  if (!cents) return "—";
  try {
    return new Intl.NumberFormat("es-CO", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(cents) / 100);
  } catch {
    return `${(Number(cents) / 100).toLocaleString("es-CO")} ${currency}`;
  }
}

function fmtC(n: number | null, currency = "USD"): string {
  const x = n ?? 0;
  if (currency !== "USD") return `${currency} ${x.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
  return `$${x.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtI(n: number | null): string {
  const x = n ?? 0;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}K`;
  return Math.round(x).toString();
}
function fmtP(n: number | null): string {
  return `${(n ?? 0).toFixed(2)}%`;
}

/** "hace 3 min", "justo ahora"… */
function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "justo ahora";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `hace ${h} h ${m % 60} min` : `hace ${h} h`;
  const d = Math.floor(h / 24);
  const days = `hace ${d} ${d === 1 ? "día" : "días"}`;
  return h % 24 ? `${days} ${h % 24} h` : days;
}

/** Cada cuánto renueva el servidor las métricas de un periodo (hora Colombia). */
function syncPlan(datePreset: string): { everyMin: number; label: string } {
  if (datePreset === "today") return { everyMin: 12 * 60, label: "se actualiza a las 5:30, 12:00 y 17:30" };
  if (datePreset === "last_30d") return { everyMin: 7 * 24 * 60, label: "se actualiza cada 7 días" };
  if (datePreset === "last_month") return { everyMin: 24 * 60, label: "se consulta a Meta al abrirlo" };
  return { everyMin: 24 * 60, label: "se actualiza cada día a las 5:00" };
}

function adsManagerUrl(level: Level, accountId: string, id: string): string {
  const tab = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
  const param = level === "campaign" ? "selected_campaign_ids" : level === "adset" ? "selected_adset_ids" : "selected_ad_ids";
  return `https://adsmanager.facebook.com/adsmanager/manage/${tab}?act=${accountId}&${param}=${id}`;
}

/** Ejecuta fn sobre items con como mucho `limit` a la vez (no saturar a Meta). */
async function runPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Meta devuelve varios action_types de compra/checkout que SE SOLAPAN (omni_*,
// offsite_conversion.*, onsite_*, purchase, ...) con el mismo valor → sumarlos es
// doble/óctuple conteo. Se toma el primer tipo canónico (omni_* = deduplicado, el
// que muestra Ads Manager).
function pickAction(rows: Array<{ action_type: string; value: string }> | undefined, priority: string[]): number {
  const list = rows ?? [];
  for (const t of priority) {
    const hit = list.find(a => a.action_type === t);
    if (hit) return parseFloat(hit.value || "0");
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "purchase"];
const INITIATE_CHECKOUT = ["omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "onsite_web_initiate_checkout", "initiate_checkout"];

function getPurchaseRevenue(ins: Insights): number {
  return pickAction(ins.action_values, PURCHASE);
}
function getPurchaseCount(ins: Insights): number {
  return pickAction(ins.actions, PURCHASE);
}
// IC = Initiate Checkout (evento de Meta), NO inline link clicks.
function getInitiateCheckout(ins: Insights): number {
  return pickAction(ins.actions, INITIATE_CHECKOUT);
}

function calcMetrics(ins: Insights | undefined) {
  if (!ins) return null;
  const spend = parseFloat(ins.spend || "0");
  const revenue = getPurchaseRevenue(ins);
  const sales = getPurchaseCount(ins);
  const profit = revenue - spend;
  const cpa = sales > 0 && spend > 0 ? spend / sales : null;
  const roi = spend > 0 ? (profit / spend) * 100 : null;
  const cpm = ins.cpm ? parseFloat(ins.cpm) : spend > 0 && parseFloat(ins.impressions || "0") > 0
    ? (spend / parseFloat(ins.impressions)) * 1000 : null;
  const cpc = ins.cpc ? parseFloat(ins.cpc) : null;
  const ctr = ins.ctr ? parseFloat(ins.ctr) : null;
  const uctr = ins.unique_link_clicks_ctr ? parseFloat(ins.unique_link_clicks_ctr) : null;
  const icRaw = getInitiateCheckout(ins);
  const ic = icRaw > 0 ? icRaw : null;
  const costPerIc = ic && ic > 0 && spend > 0 ? spend / ic : null;
  return { spend, revenue, sales, profit, cpa, roi, cpm, cpc, ctr, uctr, ic, costPerIc };
}

// Resultado de la fila: una franja a la izquierda. El color de la fila entera
// competía con los avisos de error; Profit y ROI ya llevan su propio color.
function stripeClass(ins: Insights | undefined, loaded: boolean): string {
  if (!ins) return loaded ? "shadow-[inset_3px_0_0_0_#60a5fa]" : "";
  const profit = getPurchaseRevenue(ins) - parseFloat(ins.spend || "0");
  if (profit > 0) return "shadow-[inset_3px_0_0_0_#4ade80]";
  if (profit < 0) return "shadow-[inset_3px_0_0_0_#f87171]";
  return "shadow-[inset_3px_0_0_0_#60a5fa]";
}

function Ldr({ loading }: { loading: boolean }) {
  return loading ? <span className="inline-block w-10 h-3 bg-muted animate-pulse rounded" /> : null;
}

// ¿El string formateado representa cero? ("0", "$0.00", "0.00%", "0%", "-$0.00")
function isZeroStr(v: string): boolean {
  return /^-?(?:[A-Z]{3} )?\$?0([.,]0+)?%?$/.test(v.trim());
}
function MC({ v, loading }: { v: string | null; loading: boolean }) {
  if (loading) return <Ldr loading />;
  const cls = (v == null || isZeroStr(v)) ? "text-muted-foreground/40" : "";
  return <span className={`text-xs tabular-nums ${cls}`}>{v ?? "—"}</span>;
}
function ProfitCell({ v, loading, currency }: { v: number | null; loading: boolean; currency: string }) {
  if (loading) return <Ldr loading />;
  const val = v ?? 0;
  if (val === 0) return <span className="text-xs tabular-nums text-muted-foreground/60">{fmtC(0, currency)}</span>;
  const pos = val > 0;
  return <span className={`text-xs tabular-nums font-medium ${pos ? "text-success" : "text-danger"}`}>
    {pos ? "" : "-"}{fmtC(Math.abs(val), currency)}
  </span>;
}
function RoiCell({ v, loading }: { v: number | null; loading: boolean }) {
  if (loading) return <Ldr loading />;
  const val = v ?? 0;
  if (val === 0) return <span className="text-xs tabular-nums text-muted-foreground/60">0%</span>;
  const pos = val > 0;
  return <span className={`text-xs tabular-nums font-medium ${pos ? "text-success" : "text-danger"}`}>
    {val.toFixed(0)}%
  </span>;
}

// ─── Columnas de métricas ─────────────────────────────────────────────────────

type Metrics = NonNullable<ReturnType<typeof calcMetrics>>;
interface ColumnDef {
  key: keyof Metrics; label: string; title: string; w: string; money?: boolean;
  cell: (m: Metrics | null, currency: string, loading: boolean) => ReactNode;
}
const money = (key: keyof Metrics): ColumnDef["cell"] => function MoneyCell(m, c, l) { return <MC v={fmtC(m?.[key] ?? 0, c)} loading={l} />; };
const pct = (key: keyof Metrics): ColumnDef["cell"] => function PctCell(m, _c, l) {
  const v = m?.[key] ?? 0;
  return <MC v={Number.isNaN(v) ? "—" : fmtP(v)} loading={l} />; // NaN = no se puede sumar (U-CTR en totales)
};
const count = (key: keyof Metrics): ColumnDef["cell"] => function CountCell(m, _c, l) { return <MC v={fmtI(m?.[key] ?? 0)} loading={l} />; };

const COLUMNS: ColumnDef[] = [
  { key: "sales", label: "SALES", title: "Ventas", w: "w-12", cell: count("sales") },
  { key: "spend", label: "SPEND", title: "Gasto", w: "w-20", money: true, cell: money("spend") },
  { key: "revenue", label: "REVENUE", title: "Ingresos", w: "w-20", money: true, cell: money("revenue") },
  { key: "profit", label: "PROFIT", title: "Profit", w: "w-20", money: true, cell: (m, c, l) => <ProfitCell v={m?.profit ?? 0} loading={l} currency={c} /> },
  { key: "cpa", label: "CPA", title: "Costo por venta (CPA)", w: "w-20", money: true, cell: money("cpa") },
  { key: "roi", label: "ROI", title: "ROI", w: "w-14", cell: (m, _c, l) => <RoiCell v={m?.roi ?? 0} loading={l} /> },
  { key: "cpm", label: "CPM", title: "CPM", w: "w-20", money: true, cell: money("cpm") },
  { key: "cpc", label: "CPC", title: "CPC", w: "w-20", money: true, cell: money("cpc") },
  { key: "ctr", label: "CTR", title: "CTR", w: "w-14", cell: pct("ctr") },
  { key: "uctr", label: "U-CTR", title: "CTR único", w: "w-14", cell: pct("uctr") },
  { key: "ic", label: "IC", title: "Pagos iniciados (IC)", w: "w-16", cell: count("ic") },
  { key: "costPerIc", label: "$/IC", title: "Costo por pago iniciado", w: "w-20", money: true, cell: money("costPerIc") },
];
const MONEY_KEYS = new Set<string>(COLUMNS.filter(c => c.money).map(c => c.key));
const COLUMNS_STORAGE = "campaigns_columns";

const columnListeners = new Set<() => void>();
function subscribeColumns(cb: () => void) {
  columnListeners.add(cb);
  return () => { columnListeners.delete(cb); };
}
function readHiddenColumns(): string {
  try { return localStorage.getItem(COLUMNS_STORAGE) ?? "[]"; } catch { return "[]"; }
}
function parseHidden(raw: string): Set<string> {
  try { return new Set(JSON.parse(raw) as string[]); } catch { return new Set(); }
}

/** Columnas visibles, recordadas en este navegador. El servidor no conoce localStorage: renderiza todas. */
function useColumns() {
  const hidden = parseHidden(useSyncExternalStore(subscribeColumns, readHiddenColumns, () => "[]"));
  const save = (next: Set<string>) => {
    try { localStorage.setItem(COLUMNS_STORAGE, JSON.stringify([...next])); } catch { /* sin almacenamiento */ }
    columnListeners.forEach(cb => cb());
  };
  return {
    columns: COLUMNS.filter(c => !hidden.has(c.key)),
    isVisible: (key: string) => !hidden.has(key),
    toggle: (key: string) => { const n = parseHidden(readHiddenColumns()); if (n.has(key)) n.delete(key); else n.add(key); save(n); },
    reset: () => save(new Set()),
  };
}

function ColumnPicker({ state }: { state: ReturnType<typeof useColumns> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="outline" size="sm" className="h-8 text-xs bg-card">
          <Columns3 className="h-3.5 w-3.5 mr-1" /> Columnas ({state.columns.length}/{COLUMNS.length})
        </Button>
      } />
      <DropdownMenuContent align="end" className="w-56">
        {COLUMNS.map(c => (
          <DropdownMenuCheckboxItem key={c.key} className="text-xs" checked={state.isVisible(c.key)} onCheckedChange={() => state.toggle(c.key)}>
            {c.title}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-xs" onClick={state.reset}>Mostrar todas</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MetricCells({ metrics, loading, columns, currency }: {
  metrics: Metrics | null; loading: boolean; columns: ColumnDef[]; currency: string;
}) {
  return (
    <>
      {columns.map(c => (
        <TableCell key={c.key} className="py-2 text-right">{c.cell(metrics, currency, loading)}</TableCell>
      ))}
    </>
  );
}

/** Suma de filas recalculando los derivados. factor = conversión a la moneda del total. */
function sumMetrics(items: Array<{ ins: Insights | undefined; factor: number }>): Metrics {
  let spend = 0, revenue = 0, sales = 0, ic = 0, impressions = 0, clicks = 0;
  for (const { ins, factor } of items) {
    const m = calcMetrics(ins);
    if (!m || !ins) continue;
    spend += m.spend * factor;
    revenue += m.revenue * factor;
    sales += m.sales;
    ic += m.ic ?? 0;
    impressions += parseFloat(ins.impressions || "0");
    clicks += parseFloat(ins.clicks || "0");
  }
  const profit = revenue - spend;
  return {
    spend, revenue, sales, profit,
    cpa: sales > 0 ? spend / sales : null,
    roi: spend > 0 ? (profit / spend) * 100 : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    uctr: NaN, // necesitaría los clics únicos de toda la vista
    ic: ic > 0 ? ic : null,
    costPerIc: ic > 0 && spend > 0 ? spend / ic : null,
  };
}

/** Tasas contra USD para sumar y ordenar monedas distintas. */
function useFx() {
  const [fx, setFx] = useState<{ rates: Record<string, number>; updatedAt: string | null; stale?: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/fx").then(r => r.json()).then(j => { if (j?.rates) setFx(j); }).catch(() => { });
  }, []);
  /** Multiplicador a USD; null si no hay tasa para esa moneda. */
  const toUsd = (currency: string | undefined): number | null => {
    const c = currency ?? "USD";
    if (c === "USD") return 1;
    const r = fx?.rates[c];
    return r ? 1 / r : null;
  };
  return { fx, toUsd };
}

function Checkbox({ checked, indeterminate, onToggle, label, className = "h-3.5 w-3.5" }: {
  checked: boolean; indeterminate?: boolean; onToggle: () => void; label: string; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref} type="checkbox" checked={checked} aria-label={label}
      onChange={() => { }} onClick={e => { e.stopPropagation(); onToggle(); }}
      className={`cursor-pointer ${className}`}
    />
  );
}

// ─── Vista móvil ──────────────────────────────────────────────────────────────
// Por debajo de `md` la tabla se sustituye por tarjetas: las columnas no caben y
// desplazarlas en horizontal con el pulgar hace perder de vista la campaña.

const MOBILE_LABEL: Record<keyof Metrics, string> = {
  sales: "Ventas", spend: "Gasto", revenue: "Ingresos", profit: "Profit", cpa: "CPA", roi: "ROI",
  cpm: "CPM", cpc: "CPC", ctr: "CTR", uctr: "U-CTR", ic: "IC", costPerIc: "$/IC",
};
const MOBILE_PRIMARY: Array<keyof Metrics> = ["spend", "revenue", "profit", "roi"];
const MOBILE_EXTRA: Array<keyof Metrics> = ["sales", "cpa", "cpm", "cpc", "ctr", "uctr", "ic", "costPerIc"];
const MOBILE_SORT = [...COLUMNS.map(c => ({ value: c.key as string, label: MOBILE_LABEL[c.key] })), { value: "name", label: "Nombre" }];

/** Importe abreviado: en una tarjeta no cabe una cifra completa en cuatro columnas. */
function fmtShort(n: number, currency: string): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (currency !== "USD") return `${sign}${currency} ${fmtI(abs)}`;
  return `${sign}${abs < 10_000 ? fmtC(abs) : `$${fmtI(abs)}`}`;
}

function MobileMetric({ metric, metrics, currency, loading }: {
  metric: keyof Metrics; metrics: Metrics | null; currency: string; loading: boolean;
}) {
  const v = metrics?.[metric] ?? 0;
  const text = Number.isNaN(v) ? "—"
    : MONEY_KEYS.has(metric) ? fmtShort(v, currency)
      : metric === "roi" ? `${v.toFixed(0)}%`
        : metric === "ctr" || metric === "uctr" ? fmtP(v)
          : fmtI(v);
  const tone = !v ? "text-muted-foreground"
    : metric === "profit" || metric === "roi" ? (v > 0 ? "text-success" : "text-danger") : "";
  return (
    <div className="min-w-0">
      <p className="text-[11px] leading-4 text-muted-foreground">{MOBILE_LABEL[metric]}</p>
      {loading ? <Ldr loading /> : <p className={`truncate text-[13px] leading-5 font-semibold tabular-nums ${tone}`}>{text}</p>}
    </div>
  );
}

function MobileMetricGrid({ list, metrics, currency, loading }: {
  list: Array<keyof Metrics>; metrics: Metrics | null; currency: string; loading: boolean;
}) {
  return (
    <div className="grid grid-cols-4 gap-x-2 gap-y-2">
      {list.map(k => <MobileMetric key={k} metric={k} metrics={metrics} currency={currency} loading={loading} />)}
    </div>
  );
}

/** Tarjeta de una campaña, ad set o anuncio. Tocarla entra al nivel siguiente, como la fila en desktop. */
function MobileCard({
  name, tag, detail, metrics, currency, loading, stripe, selected, onToggle, status, onOpen, openLabel, onDuplicate, onCharts, href,
}: {
  name: string; tag?: ReactNode; detail?: ReactNode; metrics: Metrics | null; currency: string; loading: boolean; stripe: string;
  selected: boolean; onToggle: () => void; status: ReactNode;
  onOpen?: () => void; openLabel?: string; onDuplicate?: () => void; onCharts?: () => void; href: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <article
      className={`rounded-lg border transition-colors ${stripe} ${selected ? "border-primary/50 bg-primary/5" : "bg-card"} ${onOpen ? "cursor-pointer active:bg-muted" : ""}`}
      onClick={onOpen}
    >
      <div className="flex items-start gap-1 pl-1 pr-3 pt-1">
        <label className="flex h-11 w-10 shrink-0 cursor-pointer items-center justify-center" onClick={stop}>
          <Checkbox checked={selected} onToggle={onToggle} label={`Seleccionar ${name}`} className="h-5 w-5" />
        </label>
        <div className="min-w-0 flex-1 pt-2">
          <p className="text-sm font-medium leading-snug break-words line-clamp-2">{name}</p>
          {tag ? <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{tag}</div> : null}
          {detail ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <div className="shrink-0 pt-2.5 pl-2" onClick={stop}>{status}</div>
      </div>

      <div className="px-3 pt-2 pb-1"><MobileMetricGrid list={MOBILE_PRIMARY} metrics={metrics} currency={currency} loading={loading} /></div>
      {expanded && (
        <div className="px-3 pt-1 pb-1"><MobileMetricGrid list={MOBILE_EXTRA} metrics={metrics} currency={currency} loading={loading} /></div>
      )}

      <div className="flex items-center pl-1 pr-1" onClick={stop}>
        <Button variant="ghost" size="sm" className="h-10 text-xs text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded(x => !x)}>
          {expanded ? "Menos" : "Más métricas"}
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </Button>
        <div className="ml-auto flex items-center">
          {onCharts && (
            <Button variant="ghost" size="sm" className="size-10 p-0 text-muted-foreground" aria-label={`Ver gráficas de ${name}`} onClick={onCharts}>
              <BarChart3 className="h-4 w-4" />
            </Button>
          )}
          {onDuplicate && (
            <Button variant="ghost" size="sm" className="size-10 p-0 text-muted-foreground" aria-label={`Duplicar ${name}`} onClick={onDuplicate}>
              <Copy className="h-4 w-4" />
            </Button>
          )}
          <a href={href} target="_blank" rel="noreferrer" aria-label="Abrir en Ads Manager"
            className="inline-flex size-10 items-center justify-center rounded text-muted-foreground active:bg-muted">
            <ExternalLink className="h-4 w-4" />
          </a>
          {onOpen && (
            <Button variant="ghost" size="sm" className="h-10 pr-1 text-xs text-primary" onClick={onOpen}>
              {openLabel}<ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Total de lo visible y casilla de seleccionar todo, encima de las tarjetas. */
function MobileSummary({ title, note, metrics, currency, loading, allSel, someSel, onToggleAll }: {
  title: string; note?: string; metrics: Metrics; currency: string; loading: boolean;
  allSel: boolean; someSel: boolean; onToggleAll: () => void;
}) {
  return (
    <>
      <div className="rounded-lg border bg-muted p-3">
        <p className="mb-2 text-xs font-semibold">{title}{note ? <span className="font-normal text-muted-foreground"> · {note}</span> : null}</p>
        <MobileMetricGrid list={MOBILE_PRIMARY} metrics={metrics} currency={currency} loading={loading} />
      </div>
      <label className="flex h-11 w-fit cursor-pointer items-center gap-2.5 pl-3 pr-3 text-xs text-muted-foreground">
        <Checkbox checked={allSel} indeterminate={someSel} onToggle={onToggleAll} label="Seleccionar todo" className="h-5 w-5" />
        Seleccionar todo
      </label>
    </>
  );
}

/** Orden en móvil: sin cabeceras de columna que tocar. */
function MobileSort({ sort, onChange, extra = [] }: {
  sort: { key: string; dir: "asc" | "desc" } | null;
  onChange: (s: { key: string; dir: "asc" | "desc" }) => void;
  extra?: Array<{ value: string; label: string }>;
}) {
  const opts = [...MOBILE_SORT, ...extra];
  const textual = (key: string) => key === "name" || key === "account";
  return (
    <div className="flex w-full items-center gap-2 md:hidden">
      <Select value={sort?.key ?? ""} onValueChange={v => { if (v) onChange({ key: v, dir: textual(v) ? "asc" : "desc" }); }}>
        <SelectTrigger className="flex-1 bg-card text-xs data-[size=default]:h-10" aria-label="Ordenar por">
          <SelectValue>{sort ? `Ordenar: ${labelOf(opts, sort.key)}` : "Ordenar por…"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {opts.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        variant="outline" size="sm" className="size-10 bg-card p-0" disabled={!sort}
        aria-label={sort?.dir === "asc" ? "Orden ascendente: cambiar a descendente" : "Orden descendente: cambiar a ascendente"}
        onClick={() => { if (sort) onChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" }); }}
      >
        {sort?.dir === "asc" ? <ArrowUpNarrowWide className="h-4 w-4" /> : <ArrowDownWideNarrow className="h-4 w-4" />}
      </Button>
    </div>
  );
}

// ─── Status toggle ─────────────────────────────────────────────────────────────

function StatusCell({
  entityId, status, entityType, loadingSet, onToggle,
}: {
  entityId: string; status: string; entityType: Level;
  loadingSet: Set<string>;
  onToggle: (id: string, currentStatus: string, type: Level) => void;
}) {
  const loading = loadingSet.has(entityId);
  const isActive = status === "ACTIVE";
  if (status !== "ACTIVE" && status !== "PAUSED") {
    return <span className="text-[10px] text-muted-foreground">{ENTITY_STATUS[status] ?? status}</span>;
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isActive}
      aria-label={isActive ? "Activa: pausar" : "Pausada: activar"}
      title={isActive ? "Activa · clic para pausar" : "Pausada · clic para activar"}
      disabled={loading}
      onClick={e => { e.stopPropagation(); onToggle(entityId, status, entityType); }}
      className={`relative block h-4 w-7 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-md:origin-right max-md:scale-125 max-md:after:absolute max-md:after:-inset-3 ${isActive ? "bg-primary" : "bg-muted-foreground/35"}`}
    >
      <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${isActive ? "translate-x-3" : ""}`} />
    </button>
  );
}

/** Estado de solo lectura (vista global), con el mismo color que el interruptor. */
function StatusLabel({ status }: { status: string }) {
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "ACTIVE" ? "bg-primary" : "bg-muted-foreground/50"}`} />
      {ENTITY_STATUS[status] ?? status}
    </span>
  );
}

/** Estado desde el que una acción masiva tiene efecto: pausar solo toca lo activo, activar solo lo pausado. */
const fromStatus = (target: EntityStatus): string => target === "ACTIVE" ? "PAUSED" : "ACTIVE";

const STATUS_ACTION = {
  PAUSED: {
    label: "Pausar", busyLabel: "Pausando…", Icon: Pause, none: "Ninguna selección está activa",
    tone: "border-warning/30 bg-warning-soft/60 text-warning hover:border-warning/50 hover:bg-warning-soft",
  },
  ACTIVE: {
    label: "Activar", busyLabel: "Activando…", Icon: Play, none: "Ninguna selección está pausada",
    tone: "border-success/30 bg-success-soft/60 text-success hover:border-success/50 hover:bg-success-soft",
  },
} as const;

/** Pausar/Activar con su color. Muestra a cuántas afecta cuando no son todas las seleccionadas. */
function StatusAction({ target, applicable, total, busy, spinning, onClick }: {
  target: EntityStatus; applicable: number; total: number; busy: boolean; spinning: boolean; onClick: () => void;
}) {
  const { label, busyLabel, Icon, none, tone } = STATUS_ACTION[target];
  // El botón desactivado no recibe el ratón: el aviso va en el contenedor.
  return (
    <span className="max-md:flex-1" title={applicable === 0 ? none : undefined}>
      <Button size="sm" variant="secondary" className={`h-7 text-xs max-md:h-10 max-md:w-full ${tone}`} onClick={onClick} disabled={busy || applicable === 0}>
        {spinning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5 fill-current" />}
        {spinning ? busyLabel : label}
        {!spinning && applicable > 0 && applicable < total ? <span className="tabular-nums opacity-70">{applicable}</span> : null}
      </Button>
    </span>
  );
}

/** Barra que aparece al seleccionar: acciones masivas a mano. */
function SelectionBar({
  count, statuses, hidden = 0, noun, busy, onDuplicate, onStatus, onClear,
}: {
  count: number; statuses: string[]; hidden?: number; noun: string; busy: boolean;
  onDuplicate?: () => void; onStatus: (s: EntityStatus) => void; onClear: () => void;
}) {
  const { confirmar, dialogo } = useConfirm();
  const [lastAction, setLastAction] = useState<EntityStatus | null>(null);
  if (count === 0) return null;
  const toPause = statuses.filter(s => s === fromStatus("PAUSED")).length;
  const toActivate = statuses.filter(s => s === fromStatus("ACTIVE")).length;
  const run = (target: EntityStatus) => { setLastAction(target); onStatus(target); };
  const activate = async () => {
    // Activar empieza a gastar presupuesto: una tanda no debe salir de un clic suelto.
    const ok = await confirmar({
      title: `¿Activar ${toActivate} ${noun}${toActivate > 1 ? "s" : ""}?`,
      description: toActivate > 1 ? "Empezarán a gastar presupuesto." : "Empezará a gastar presupuesto.",
      confirmLabel: "Activar",
    });
    if (ok) run("ACTIVE");
  };
  return (
    <div className="flex items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/25 bg-primary/5 px-2 py-1.5 mb-2 flex-wrap motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150 max-md:fixed max-md:inset-x-2 max-md:bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] max-md:z-[45] max-md:mb-0 max-md:bg-card max-md:shadow-xl">
      <span className="inline-flex items-center gap-2 text-xs font-medium max-md:min-w-0 max-md:flex-1" aria-live="polite">
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">{count}</span>
        <span>{noun}{count > 1 ? "s" : ""} seleccionad{noun.endsWith("a") ? "a" : "o"}{count > 1 ? "s" : ""}{hidden > 0 ? <span className="font-normal text-warning"> · {hidden} fuera del filtro actual</span> : null}</span>
      </span>
      <div className="flex items-center gap-1.5 flex-wrap max-md:order-3 max-md:w-full max-md:flex-nowrap">
        {onDuplicate && (
          <>
            <Button size="sm" className="h-7 text-xs shadow-sm shadow-primary/25 max-md:h-10 max-md:flex-1" onClick={onDuplicate} disabled={busy}>
              <Copy className="h-3.5 w-3.5" /> Duplicar
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border max-md:hidden" aria-hidden />
          </>
        )}
        <StatusAction target="PAUSED" applicable={toPause} total={count} busy={busy} spinning={busy && lastAction === "PAUSED"} onClick={() => run("PAUSED")} />
        <StatusAction target="ACTIVE" applicable={toActivate} total={count} busy={busy} spinning={busy && lastAction === "ACTIVE"} onClick={activate} />
      </div>
      <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs text-muted-foreground max-md:size-10 max-md:p-0" onClick={onClear} disabled={busy} aria-label="Quitar selección">
        <X className="h-3.5 w-3.5 max-md:h-5 max-md:w-5" /> <span className="max-md:hidden">Quitar selección</span>
      </Button>
      {dialogo}
    </div>
  );
}

/** Icono «i» que muestra una ayuda al pasar el cursor o al tocarlo (también en móvil). */
function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(o => !o)} onBlur={() => setOpen(false)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground max-md:h-9 max-md:w-9">
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div role="tooltip" className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-md max-md:fixed max-md:inset-x-4 max-md:top-auto max-md:w-auto">
          {children}
        </div>
      )}
    </span>
  );
}

/**
 * Indicador de frescura con «latido» + botón «Sincronizar con Meta».
 * Dice cuánto hace de la última lectura y cada cuánto se renueva el periodo elegido.
 * El latido es verde mientras la copia es reciente, ámbar al pasar de 1× el intervalo y rojo al pasar de 2×.
 * Pasados 15 min desde la última lectura, el botón salta para invitar a pedir datos frescos.
 */
function FreshnessBar({ freshness, now, loading, onRefresh, datePreset, progress }: {
  freshness: Freshness; now: number; loading: boolean; onRefresh: () => void; datePreset: string;
  progress?: { step: number; total: number; label: string } | null;
}) {
  const { everyMin, label: plan } = syncPlan(datePreset);
  const label = freshness.source === "meta" ? "de Meta" : freshness.source === "cache" ? "en caché" : "copia guardada";
  const ageMin = freshness.syncedAt ? (now - new Date(freshness.syncedAt).getTime()) / 60_000 : 0;
  const state = ageMin > everyMin * 2 ? "bad" : ageMin > everyMin * 1.2 ? "warn" : "ok";
  const dot = state === "bad" ? "bg-red-500" : state === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const text = state === "bad" ? "text-red-500" : state === "warn" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2 max-md:min-w-0 max-md:flex-1 max-md:justify-between">
      {freshness.syncedAt && (
        <span className={`inline-flex items-center gap-1.5 text-[11px] ${text}`} title={`${new Date(freshness.syncedAt).toLocaleString("es-CO")} · ${label}`}>
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${loading ? "bg-primary" : dot}`} style={{ animationDuration: state === "ok" ? "2.4s" : "1.2s" }} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${loading ? "bg-primary" : dot}`} />
          </span>
          <span><span className="max-md:hidden">Actualizado </span>{ago(freshness.syncedAt, now)}</span>
        </span>
      )}
      <InfoHint label="Cada cuánto se actualiza">
        <p className="font-medium">Cuándo se actualizan los datos</p>
        <p className="mt-1">Este periodo: <b>{plan}</b>.</p>
        <p className="mt-1 text-muted-foreground">Calendario general: estructura y «hoy» a las 5:30, 12:00 y 17:30 (hora Colombia); ayer, 7 y 14 días a las 5:00; 30 días los lunes. «Sincronizar con Meta» trae ya todo lo de esta cuenta.</p>
      </InfoHint>
      <Button variant="outline" size="sm" className={`h-7 px-2 text-xs bg-card max-md:h-10 max-md:px-3 ${ageMin > 15 && !loading ? "motion-safe:animate-bounce" : ""}`} onClick={onRefresh} disabled={loading || !!progress}
        title="Trae de Meta las campañas, ad sets, anuncios y métricas de esta cuenta, sin usar copias guardadas.">
        {loading || progress ? <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5 mr-1" />}
        {progress ? <>{progress.step}/{progress.total} · {progress.label}</> : <>Sincronizar<span className="max-md:hidden"> con Meta</span></>}
      </Button>
    </div>
  );
}

// ─── Seguimiento de lotes de duplicación ──────────────────────────────────────

interface BatchState { batchIds: string[]; total: number; done: number; failed: number; withIssues: number }

function useBatchTracker(onFinished: () => void) {
  const [batch, setBatch] = useState<BatchState | null>(null);
  const finishedRef = useRef(onFinished);
  useEffect(() => { finishedRef.current = onFinished; }, [onFinished]);

  useEffect(() => {
    if (!batch || batch.done + batch.failed >= batch.total) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const lists = await Promise.all(batch.batchIds.map(id =>
          fetch(`/api/jobs?batchId=${id}`).then(r => r.json()).then(j => (j.jobs ?? []) as Array<{ status: string; output?: { issues?: unknown[] } }>)));
        const jobs = lists.flat();
        if (cancelled) return;
        const done = jobs.filter(j => j.status === "completed").length;
        const failed = jobs.filter(j => j.status === "failed" || j.status === "cancelled").length;
        const withIssues = jobs.filter(j => j.status === "completed" && (j.output?.issues?.length ?? 0) > 0).length;
        setBatch(b => b && { ...b, done, failed, withIssues });
        if (done + failed >= batch.total) {
          if (failed > 0 || withIssues > 0) {
            toast.warning(`Duplicación terminada: ${done} OK, ${failed} con error${withIssues ? `, ${withIssues} con avisos` : ""}`, {
              description: "Revisa el motivo de cada uno en Trabajos.",
              duration: 12_000,
            });
          } else {
            toast.success(`Duplicación terminada: ${done} copia${done > 1 ? "s" : ""} creada${done > 1 ? "s" : ""}`);
          }
          finishedRef.current();
        }
      } catch { /* reintenta en el siguiente tick */ }
    };
    const t = setInterval(tick, 8000);
    void tick();
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.batchIds.join(","), batch?.total, batch && batch.done + batch.failed >= batch.total]);

  return {
    batch,
    track: (batchIds: string[], total: number) => setBatch({ batchIds, total, done: 0, failed: 0, withIssues: 0 }),
    dismiss: () => setBatch(null),
  };
}

function BatchBanner({ batch, onDismiss, onOpenJobs }: { batch: BatchState | null; onDismiss: () => void; onOpenJobs: () => void }) {
  if (!batch) return null;
  const finished = batch.done + batch.failed >= batch.total;
  const pct = Math.round(((batch.done + batch.failed) / Math.max(1, batch.total)) * 100);
  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2 mb-2 text-xs ${finished ? (batch.failed ? "border-warning/40 bg-warning-soft" : "border-success/40 bg-success-soft") : "border-info/40 bg-info-soft"}`}>
      {finished
        ? (batch.failed ? <AlertTriangle className="h-4 w-4 text-warning" /> : <CheckCircle2 className="h-4 w-4 text-success" />)
        : <Loader2 className="h-4 w-4 animate-spin text-info" />}
      <span className="font-medium">
        {finished ? "Duplicación terminada" : "Duplicando"}: {batch.done}/{batch.total} creadas
        {batch.failed ? ` · ${batch.failed} con error` : ""}{batch.withIssues ? ` · ${batch.withIssues} con avisos` : ""}
      </span>
      {!finished && (
        <div className="h-1.5 w-28 bg-card rounded-full overflow-hidden">
          <div className="h-full bg-info transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <button className="ml-auto text-primary hover:underline" onClick={onOpenJobs}>Ver trabajos</button>
      <button className="text-muted-foreground hover:text-foreground" onClick={onDismiss} title="Ocultar"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/** Cambia el estado de varias entidades de una en una (sin ráfagas a Meta). */
async function bulkStatus(
  items: Array<{ id: string; accountId: string; bmId?: string; name?: string }>, entityType: Level, status: EntityStatus,
): Promise<{ ok: string[]; failed: number; firstError: unknown; cascadeJobs: string[] }> {
  const ok: string[] = [];
  const cascadeJobs: string[] = [];
  let failed = 0;
  let firstError: unknown = null;
  const batchId = items.length > 1 ? `pausa-${Date.now()}` : undefined;
  for (const it of items) {
    try {
      const res = await fetch("/api/meta/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: it.id, status, accountId: it.accountId, entityType, bmId: it.bmId }),
      });
      if (res.ok) {
        ok.push(it.id);
        if (status === "PAUSED" && entityType !== "ad") {
          const jobId = await queueCascade(it, entityType, batchId, items.length);
          if (jobId) cascadeJobs.push(jobId);
        }
      } else { failed++; firstError ??= await res.json().catch(() => null); }
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok, failed, firstError, cascadeJobs };
}

/**
 * Pide al servidor pausar, en segundo plano, los ad sets y anuncios que siguen activos debajo
 * de una campaña (o ad set). Lo hace el worker: sigue aunque se cierre el navegador, y su
 * avance también se ve en Trabajos. Devuelve el id del trabajo, o null si no se pudo crear.
 */
async function queueCascade(
  parent: { id: string; accountId: string; bmId?: string; name?: string }, entityType: Level,
  batchId?: string, total?: number,
): Promise<string | null> {
  try {
    const res = await fetch("/api/meta/status-cascade", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: parent.id, entityType, accountId: parent.accountId, name: parent.name, bmId: parent.bmId, batchId, total }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.jobId) { toastApiError(json, "No se pudo pausar lo que tiene debajo"); return null; }
    return json.jobId as string;
  } catch {
    toast.error("No se pudo pausar lo que tiene debajo: sin conexión con el servidor");
    return null;
  }
}

/**
 * Muestra en un aviso cómo va la pausa en cascada (consultando los trabajos). Solo es la vista:
 * el trabajo corre en el servidor y continúa aunque esta página se cierre.
 */
async function trackCascade(jobIds: string[], onDone: () => void) {
  if (jobIds.length === 0) return;
  const toastId = `cascada-${jobIds[0]}`;
  type J = { status: string; progress: number; output?: { pausedAdsets?: number; pausedAds?: number; failed?: number; total?: number } | null; error?: string | null };
  toast.loading("Pausando ad sets y anuncios · en segundo plano…", { id: toastId, description: "Puedes cerrar la página: sigue en el servidor." });
  for (let tick = 0; tick < 2400; tick++) { // ~2 h como máximo; el trabajo no depende de esto
    await new Promise(r => setTimeout(r, 3000));
    let jobs: J[];
    try {
      jobs = await Promise.all(jobIds.map(id => fetch(`/api/jobs/${id}`).then(r => r.json()).then(j => j.job as J)));
    } catch { continue; }
    const finished = jobs.filter(j => ["completed", "failed", "cancelled"].includes(j.status));
    const done = jobs.reduce((n, j) => n + (j.output?.pausedAdsets ?? 0) + (j.output?.pausedAds ?? 0) + (j.output?.failed ?? 0), 0);
    const total = jobs.reduce((n, j) => n + (j.output?.total ?? 0), 0);
    if (finished.length < jobs.length) {
      const where = jobIds.length > 1 ? ` · campaña ${finished.length + 1}/${jobIds.length}` : "";
      toast.loading(`Pausando ad sets y anuncios · ${done}${total ? `/${total}` : ""}${where}`, {
        id: toastId, description: "Puedes cerrar la página: sigue en el servidor.",
      });
      continue;
    }
    const failed = jobs.reduce((n, j) => n + (j.output?.failed ?? 0), 0) + jobs.filter(j => j.status !== "completed").length;
    const sets = jobs.reduce((n, j) => n + (j.output?.pausedAdsets ?? 0), 0);
    const ads = jobs.reduce((n, j) => n + (j.output?.pausedAds ?? 0), 0);
    toast.dismiss(toastId);
    if (failed > 0) toast.warning(`Pausa terminada con errores: ${sets} ad sets y ${ads} anuncios pausados, ${failed} fallaron`, { description: "Revisa el detalle en Trabajos.", duration: 12_000 });
    else toast.success(`También se pausaron ${sets} ad sets y ${ads} anuncios`);
    onDone();
    return;
  }
  toast.dismiss(toastId);
}

function reportBulk(r: { ok: string[]; failed: number; firstError: unknown }, status: EntityStatus) {
  const verb = status === "ACTIVE" ? "activad" : "pausad";
  if (r.failed === 0) { toast.success(`${r.ok.length} ${verb}o${r.ok.length > 1 ? "s" : ""}`); return; }
  toastApiError(r.firstError, `${r.failed} no se pudieron cambiar`);
  if (r.ok.length) toast.message(`${r.ok.length} ${verb}o${r.ok.length > 1 ? "s" : ""} correctamente`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

// Cambiar de cuenta empieza de cero: sin nivel, selección ni datos de la anterior.
function ManagerByAccount() {
  const accountId = useSearchParams().get("accountId");
  return <ManagerInner key={accountId ?? "todas"} />;
}

function ManagerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const accountId = searchParams.get("accountId");
  const bmId = searchParams.get("bmId") ?? undefined;
  const { confirmar, dialogo } = useConfirm();

  const [accountList, setAccountList] = useState<Array<{ id: string; name: string; bmId: string; currency?: string }>>([]);
  const accountName = accountList.find(a => a.id === `act_${accountId}` || a.id === accountId)?.name ?? "";
  const currency = accountList.find(a => a.id === `act_${accountId}` || a.id === accountId)?.currency ?? "USD";
  const columnState = useColumns();
  const { columns } = columnState;

  // Desde «Todas las cuentas» se llega con la campaña ya elegida: abre directo sus ad sets.
  const campaignParam = searchParams.get("campaignId");
  const [level, setLevel] = useState<Level>(campaignParam ? "adset" : "campaign");
  const [selCampaign, setSelCampaign] = useState<Selection | null>(
    campaignParam ? { id: campaignParam, name: searchParams.get("campaignName") ?? campaignParam } : null,
  );
  const [selAdset, setSelAdset] = useState<Selection | null>(null);
  // Varias campañas marcadas al pasar a Ad Sets/Anuncios: se ven solo las suyas, con su color.
  const [campScope, setCampScope] = useState<ScopeCampaign[] | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [adsets, setAdsets] = useState<AdSet[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);

  const [insightsMap, setInsightsMap] = useState<Record<string, Insights>>({});
  const [datePreset, setDatePreset] = useState("today");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const [loadingData, setLoadingData] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  // Por nivel: cada uno sincroniza a su ritmo, y al volver a un nivel desde la caché del
  // cliente no hay petición que refresque estos datos.
  const [dataMetaBy, setDataMetaBy] = useState<Partial<Record<Level, DataMeta>>>({});
  const [insFreshBy, setInsFreshBy] = useState<Partial<Record<Level, Freshness>>>({});
  const dataMeta = dataMetaBy[level];
  const dataFresh = dataMeta ?? NO_FRESHNESS;
  const insFresh = insFreshBy[level] ?? NO_FRESHNESS;
  const stale = dataMeta?.stale ?? false;
  const staleInfo = dataMeta?.staleInfo ?? null;
  const [now, setNow] = useState(() => Date.now());

  const [statusFilter, setStatusFilter] = useState("ALL");
  const [nameFilter, setNameFilter] = useState("");
  const [duplicateTargets, setDuplicateTargets] = useState<Campaign[] | null>(null);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<string>>(new Set());
  const [selectedAdsetIds, setSelectedAdsetIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsetsModal, setShowDuplicateAdsetsModal] = useState(false);
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsModal, setShowDuplicateAdsModal] = useState(false);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);

  // Snapshots para caché client-side (sobreviven re-renders, no recargas de página)
  // Un Map por nivel, con una entrada por clave (campaña, ad set, periodo): volver a una
  // vista ya visitada la recupera al instante en vez de pedirla otra vez a Meta.
  const campSnap = useRef(new Map<string, Snap<{ list: Campaign[]; cur: string | null }>>());
  const adsetSnap = useRef(new Map<string, Snap<AdSet[]>>());
  const adSnap = useRef(new Map<string, Snap<Ad[]>>());
  const insSnap = useRef(new Map<string, Snap<Record<string, Insights>>>());

  // "hace X min" se actualiza solo.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Lee del JSON la frescura, el aviso de copia desactualizada y lo deja en estado. */
  const applyMeta = useCallback((lvl: Level, json: { syncedAt?: string; source?: string; stale?: boolean; errorInfo?: ErrorInfo; staleReason?: string }) => {
    setDataMetaBy(p => ({
      ...p,
      [lvl]: {
        syncedAt: json.syncedAt ?? null,
        source: json.source ?? null,
        stale: !!json.stale,
        staleInfo: json.stale ? (json.errorInfo ?? { title: json.staleReason ?? "Mostrando datos guardados" }) : null,
      },
    }));
  }, []);

  // ── Loaders ───────────────────────────────────────────────────────────────

  const loadCampaigns = useCallback(async (refresh = false, cursor?: string) => {
    if (!accountId) return;
    if (cursor) setLoadingMore(true); else setLoadingData(true);
    setError(null);
    const p = new URLSearchParams({ accountId });
    if (cursor) p.set("cursor", cursor);
    if (refresh) p.set("refresh", "true");
    if (bmId) p.set("bmId", bmId);
    try {
      const res = await fetch(`/api/meta/campaigns?${p}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "Error al cargar campañas" }); return; }
      applyMeta("campaign", json);
      setCampaigns(prev => cursor ? [...prev, ...json.campaigns] : json.campaigns);
      setNextCursor(json.nextCursor);
      if (!cursor) campSnap.current.set(accountId, { data: { list: json.campaigns, cur: json.nextCursor }, key: accountId, ts: Date.now() });
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión y pulsa «Traer de Meta»." });
    } finally {
      if (cursor) setLoadingMore(false); else setLoadingData(false);
    }
  }, [accountId, bmId, applyMeta]);

  const loadAdsets = useCallback(async (campaignId?: string, refresh = false) => {
    if (!accountId) return;
    setLoadingData(true); setError(null);
    const p = new URLSearchParams({ accountId });
    if (campaignId) p.set("campaignId", campaignId);
    if (bmId) p.set("bmId", bmId);
    if (refresh) p.set("refresh", "true");
    try {
      const res = await fetch(`/api/meta/adsets?${p}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "Error al cargar ad sets" }); return; }
      applyMeta("adset", json);
      setAdsets(json.adsets);
      { const key = `adsets:${accountId}:${campaignId || "all"}`; adsetSnap.current.set(key, { data: json.adsets, key, ts: Date.now() }); }
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión y pulsa «Traer de Meta»." });
    } finally {
      setLoadingData(false);
    }
  }, [accountId, bmId, applyMeta]);

  const loadAds = useCallback(async (adsetId?: string, refresh = false, campaignId?: string) => {
    if (!accountId) return;
    setLoadingData(true); setError(null);
    const p = new URLSearchParams({ accountId });
    if (adsetId) p.set("adsetId", adsetId);
    else if (campaignId) p.set("campaignId", campaignId);
    if (bmId) p.set("bmId", bmId);
    if (refresh) p.set("refresh", "true");
    try {
      const res = await fetch(`/api/meta/ads?${p}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "Error al cargar anuncios" }); return; }
      applyMeta("ad", json);
      setAds(json.ads);
      { const key = `ads:${accountId}:${adsetId || (campaignId ? `c:${campaignId}` : "all")}`; adSnap.current.set(key, { data: json.ads, key, ts: Date.now() }); }
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión y pulsa «Traer de Meta»." });
    } finally {
      setLoadingData(false);
    }
  }, [accountId, bmId, applyMeta]);

  const loadInsights = useCallback(async (lvl: Level, date: string, refresh = false) => {
    if (!accountId) return;
    setLoadingInsights(true);
    const p = new URLSearchParams({ accountId, level: lvl, datePreset: date });
    if (bmId) p.set("bmId", bmId);
    if (refresh) p.set("refresh", "true");
    try {
      const res = await fetch(`/api/meta/insights?${p}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastApiError(json, `No se pudieron cargar las métricas (${lvl})`);
        return;
      }
      setInsFreshBy(p => ({ ...p, [lvl]: { syncedAt: json.syncedAt ?? null, source: json.source ?? null } }));
      if (json.stale) toastApiError({ errorInfo: json.errorInfo, error: json.staleReason }, "Métricas desactualizadas");
      const idField = lvl === "campaign" ? "campaign_id" : lvl === "adset" ? "adset_id" : "ad_id";
      const map: Record<string, Insights> = {};
      for (const item of json.data ?? []) {
        if (item[idField]) map[item[idField]] = item;
      }
      setInsightsMap(map);
      { const key = `${lvl}:${accountId}:${date}`; insSnap.current.set(key, { data: map, key, ts: Date.now() }); }
    } catch (e) {
      console.error(`[insights] fetch error:`, e);
      toast.error("No se pudo conectar con el servidor para cargar las métricas");
    } finally {
      setLoadingInsights(false);
    }
  }, [accountId, bmId]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!accountId) return;
    if (selCampaign) loadAdsets(selCampaign.id); else loadCampaigns();
    loadInsights(level, datePreset);
  }, [accountId]); // eslint-disable-line

  // Nombre y moneda de la cuenta actual. Usa el listado cacheado.
  useEffect(() => {
    if (!accountId) return;
    fetch("/api/meta/accounts")
      .then(r => r.json())
      .then(j => setAccountList(j.accounts ?? []))
      .catch(() => { });
  }, [accountId, bmId]);

  useEffect(() => {
    setInsightsMap({});
    loadInsights(level, datePreset);
  }, [datePreset]); // eslint-disable-line

  // ── Navigation ────────────────────────────────────────────────────────────

  // Las selecciones se conservan al cambiar de nivel o de campaña: solo se vacían tras
  // duplicar, o al «Traer de Meta» (ahí se descartan los ids que ya no existen).

  /** Muestra de inmediato lo que haya en caché y pide solo lo que falte o esté vencido. */
  async function showLevel(
    lvl: Level, dKey: string, load: () => Promise<void>,
  ) {
    const iKey = `${lvl}:${accountId}:${datePreset}`;
    const insSnapHit = insSnap.current.get(iKey);
    const insOk = fresh(insSnapHit ?? null, iKey);
    if (insOk) setInsightsMap(insSnapHit!.data); else setInsightsMap({});
    let dataOk = false;
    if (lvl === "campaign") {
      const h = campSnap.current.get(dKey);
      if (fresh(h ?? null, dKey)) { dataOk = true; setCampaigns(h!.data.list); setNextCursor(h!.data.cur); }
    } else if (lvl === "adset") {
      const h = adsetSnap.current.get(dKey);
      if (fresh(h ?? null, dKey)) { dataOk = true; setAdsets(h!.data); }
    } else {
      const h = adSnap.current.get(dKey);
      if (fresh(h ?? null, dKey)) { dataOk = true; setAds(h!.data); }
    }
    if (!dataOk) {
      // Caducada o ausente: se deja ver lo último que había mientras llega lo nuevo.
      if (lvl === "campaign") { const h = campSnap.current.get(dKey); if (h) { setCampaigns(h.data.list); setNextCursor(h.data.cur); } else { setCampaigns([]); setNextCursor(null); } }
      else if (lvl === "adset") setAdsets(adsetSnap.current.get(dKey)?.data ?? []);
      else setAds(adSnap.current.get(dKey)?.data ?? []);
      await load();
    }
    if (!insOk) loadInsights(lvl, datePreset);
  }

  async function drillAdsets(campaign: Selection) {
    setSelCampaign({ id: campaign.id, name: campaign.name });
    setSelAdset(null); setCampScope(null);
    setLevel("adset"); setNameFilter(""); setStatusFilter("ALL");
    await showLevel("adset", `adsets:${accountId}:${campaign.id}`, () => loadAdsets(campaign.id));
  }

  async function drillAds(adset: AdSet) {
    setSelAdset({ id: adset.id, name: adset.name });
    setLevel("ad"); setNameFilter(""); setStatusFilter("ALL");
    await showLevel("ad", `ads:${accountId}:${adset.id}`, () => loadAds(adset.id));
  }

  // Tabs siempre clickeables. Conservan la campaña / ad set elegidos para no perder el contexto.
  async function goToCampaigns() {
    setSelCampaign(null); setSelAdset(null); setCampScope(null);
    setLevel("campaign"); setNameFilter(""); setStatusFilter("ALL");
    await showLevel("campaign", accountId!, () => loadCampaigns());
  }

  /** Al salir de Campañas con campañas marcadas, ad sets y anuncios se limitan a ellas. */
  function scopeFromSelection(): ScopeCampaign[] | null {
    if (level !== "campaign") return campScope;
    const picked = campaigns.filter(c => selectedCampaignIds.has(c.id));
    const next = picked.length
      ? picked.map((c, i) => ({ id: c.id, name: c.name, color: SCOPE_COLORS[i % SCOPE_COLORS.length] }))
      : null;
    setCampScope(next);
    if (next) { setSelCampaign(null); setSelAdset(null); }
    return next;
  }

  async function goToAdsets() {
    const scope = scopeFromSelection();
    setLevel("adset"); setNameFilter(""); setStatusFilter("ALL");
    // Con varias campañas se traen los de toda la cuenta y se filtran aquí.
    const cid = scope ? undefined : selCampaign?.id;
    await showLevel("adset", `adsets:${accountId}:${cid ?? "all"}`, () => loadAdsets(cid));
  }

  async function goToAds() {
    const fromCampaigns = level === "campaign";
    const scope = scopeFromSelection();
    setLevel("ad"); setNameFilter(""); setStatusFilter("ALL");
    // Con un ad set elegido, sus anuncios; si no, los de la campaña; sin campaña (o con
    // varias, que se filtran aquí), toda la cuenta.
    const aid = scope && fromCampaigns ? undefined : selAdset?.id;
    const cid = scope ? undefined : selCampaign?.id;
    await showLevel("ad", `ads:${accountId}:${aid ?? (cid ? `c:${cid}` : "all")}`, () => loadAds(aid, false, cid));
  }

  // «Sincronizar con Meta»: trae de la cuenta seleccionada, en orden y con progreso, las
  // campañas, los ad sets y los anuncios tal cual están en Meta, y las métricas de los tres
  // niveles para el periodo elegido. Cada paso queda guardado como copia en la DB.
  // El general de todas las cuentas lo hace el job programado.
  async function refreshFromMeta() {
    if (!accountId || syncProgress) return;
    const base = new URLSearchParams({ accountId });
    if (bmId) base.set("bmId", bmId);
    const steps = [
      { label: "Campañas", url: `/api/meta/sync-account?${base}&step=campaigns` },
      { label: "Ad sets", url: `/api/meta/sync-account?${base}&step=adsets` },
      { label: "Anuncios", url: `/api/meta/sync-account?${base}&step=ads` },
      { label: "Métricas de campañas", url: `/api/meta/insights?${base}&level=campaign&datePreset=${datePreset}&refresh=true` },
      { label: "Métricas de ad sets", url: `/api/meta/insights?${base}&level=adset&datePreset=${datePreset}&refresh=true` },
      { label: "Métricas de anuncios", url: `/api/meta/insights?${base}&level=ad&datePreset=${datePreset}&refresh=true` },
    ];
    campSnap.current.clear(); adsetSnap.current.clear(); adSnap.current.clear(); insSnap.current.clear();
    setError(null);
    const failed: string[] = [];
    const out: Array<Record<string, unknown> | null> = [];
    for (let i = 0; i < steps.length; i++) {
      setSyncProgress({ step: i + 1, total: steps.length, label: steps[i].label });
      try {
        const res = await fetch(steps[i].url);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { failed.push(steps[i].label); toastApiError(json, `No se pudo sincronizar: ${steps[i].label}`); out.push(null); continue; }
        out.push(json);
      } catch {
        failed.push(steps[i].label);
        toast.error(`Sin conexión al sincronizar: ${steps[i].label}`);
        out.push(null);
      }
    }
    setSyncProgress(null);

    // Refleja lo traído en la vista actual y deja las copias del cliente al día.
    const [cj, aj, dj, ic, ia, id] = out as Array<{ campaigns?: Campaign[]; adsets?: AdSet[]; ads?: Ad[]; data?: Insights[]; syncedAt?: string; source?: string } | null>;
    const now0 = Date.now();
    if (cj?.campaigns) {
      campSnap.current.set(accountId, { data: { list: cj.campaigns, cur: null }, key: accountId, ts: now0 });
      applyMeta("campaign", cj);
      if (level === "campaign") { setCampaigns(cj.campaigns); setNextCursor(null); }
    }
    if (aj?.adsets) {
      const key = `adsets:${accountId}:all`;
      adsetSnap.current.set(key, { data: aj.adsets, key, ts: now0 });
      applyMeta("adset", aj);
      if (level === "adset") setAdsets(selCampaign ? aj.adsets.filter(a => a.campaign_id === selCampaign.id) : aj.adsets);
    }
    if (dj?.ads) {
      const key = `ads:${accountId}:all`;
      adSnap.current.set(key, { data: dj.ads, key, ts: now0 });
      applyMeta("ad", dj);
      if (level === "ad") {
        const campAdsets = new Set((aj?.adsets ?? adsets).filter(a => a.campaign_id === selCampaign?.id).map(a => a.id));
        setAds(selAdset ? dj.ads.filter(a => a.adset_id === selAdset.id)
          : selCampaign ? dj.ads.filter(a => a.campaign_id === selCampaign.id || (!!a.adset_id && campAdsets.has(a.adset_id)))
          : dj.ads);
      }
    }
    const insBy: Array<[Level, typeof ic]> = [["campaign", ic], ["adset", ia], ["ad", id]];
    for (const [lvl, j] of insBy) {
      if (!j?.data) continue;
      const idField = lvl === "campaign" ? "campaign_id" : lvl === "adset" ? "adset_id" : "ad_id";
      const map: Record<string, Insights> = {};
      for (const item of j.data as Array<Insights & Record<string, string>>) if (item[idField]) map[item[idField]] = item;
      const key = `${lvl}:${accountId}:${datePreset}`;
      insSnap.current.set(key, { data: map, key, ts: now0 });
      setInsFreshBy(p => ({ ...p, [lvl]: { syncedAt: j.syncedAt ?? null, source: j.source ?? null } }));
      if (lvl === level) setInsightsMap(map);
    }
    if (failed.length === 0) toast.success("Campañas, ad sets, anuncios y métricas sincronizados con Meta");
    else toast.error(`Sincronización incompleta. Falló: ${failed.join(", ")}`);
  }

  const tracker = useBatchTracker(() => { if (level === "campaign") void loadCampaigns(true); });

  // ── Status toggle ─────────────────────────────────────────────────────────

  function patchStatus(entityType: Level, ids: Set<string>, status: string) {
    if (entityType === "campaign") setCampaigns(p => p.map(c => ids.has(c.id) ? { ...c, status } : c));
    else if (entityType === "adset") setAdsets(p => p.map(a => ids.has(a.id) ? { ...a, status } : a));
    else setAds(p => p.map(a => ids.has(a.id) ? { ...a, status } : a));
  }

  /** Terminada la pausa en cascada: vuelve a leer ad sets y anuncios (la DB ya está corregida). */
  function reloadChildren() {
    adsetSnap.current.clear(); adSnap.current.clear();
    if (level === "adset") void loadAdsets(selCampaign?.id);
    else if (level === "ad") void loadAds(selAdset?.id, false, selCampaign?.id);
  }

  async function toggleStatus(entityId: string, currentStatus: string, entityType: Level) {
    if (loadingStatus.has(entityId) || !accountId) return;
    const newStatus = currentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";

    // Activar empieza a gastar presupuesto: el interruptor no debe hacerlo de un clic suelto.
    if (newStatus === "ACTIVE") {
      const list: Array<{ id: string; name: string }> = entityType === "campaign" ? campaigns : entityType === "adset" ? adsets : ads;
      const name = list.find(e => e.id === entityId)?.name;
      const ok = await confirmar({
        title: `¿Activar ${entityType === "campaign" ? "esta campaña" : entityType === "adset" ? "este ad set" : "este anuncio"}?`,
        description: "Empezará a gastar presupuesto.",
        detail: name ? <span className="break-words">{name}</span> : undefined,
        confirmLabel: "Activar",
      });
      if (!ok) return;
    }

    patchStatus(entityType, new Set([entityId]), newStatus); // optimista
    setLoadingStatus(p => new Set([...p, entityId]));
    try {
      const res = await fetch("/api/meta/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, status: newStatus, accountId, entityType, bmId }),
      });
      if (!res.ok) {
        patchStatus(entityType, new Set([entityId]), currentStatus); // revertir
        toastApiError(await res.json().catch(() => null), "No se pudo cambiar el estado");
        return;
      }
      toast.success(newStatus === "ACTIVE" ? "Activado" : "Pausado");
      if (newStatus === "PAUSED" && entityType !== "ad") {
        const name = (entityType === "campaign" ? campaigns : adsets).find(e => e.id === entityId)?.name;
        const jobId = await queueCascade({ id: entityId, accountId, bmId, name }, entityType);
        if (jobId) void trackCascade([jobId], reloadChildren);
      }
    } catch {
      patchStatus(entityType, new Set([entityId]), currentStatus);
      toast.error("No se pudo conectar con el servidor; el estado no cambió");
    } finally {
      setLoadingStatus(p => { const n = new Set(p); n.delete(entityId); return n; });
    }
  }

  async function bulkSetStatus(entityType: Level, ids: Set<string>, status: EntityStatus) {
    if (!accountId || ids.size === 0) return;
    setBulkBusy(true);
    try {
      const nameOf = (id: string) => (entityType === "campaign" ? campaigns : entityType === "adset" ? adsets : ads).find(e => e.id === id)?.name;
      const r = await bulkStatus([...ids].map(id => ({ id, accountId, bmId, name: nameOf(id) })), entityType, status);
      patchStatus(entityType, new Set(r.ok), status);
      reportBulk(r, status);
      if (r.cascadeJobs.length) void trackCascade(r.cascadeJobs, reloadChildren);
    } finally {
      setBulkBusy(false);
    }
  }

  // ── Filter ────────────────────────────────────────────────────────────────

  function filterData<T extends { name: string; status: string }>(data: T[]): T[] {
    return data.filter(d =>
      (statusFilter === "ALL" || d.status === statusFilter) &&
      d.name.toLowerCase().includes(nameFilter.toLowerCase())
    );
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  function toggleSort(key: string) {
    setSort(s => s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }
  // Valor de orden de una fila para una columna (name o métrica calculada de insights).
  function sortVal(key: string, row: { id: string; name: string }): number | string {
    if (key === "name") return row.name.toLowerCase();
    const m = calcMetrics(insightsMap[row.id]) as Record<string, number | null> | null;
    const v = m ? m[key] : null;
    return v == null ? -Infinity : v; // sin dato → al fondo
  }
  function applySort<T extends { id: string; name: string }>(rows: T[]): T[] {
    if (!sort) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortVal(sort.key, a), vb = sortVal(sort.key, b);
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }

  // Campañas elegidas: cada ad set / anuncio sabe a cuál pertenece (los anuncios sin
  // campaign_id, por su ad set).
  const scopeMap = new Map((campScope ?? []).map(c => [c.id, c]));
  const adsetCamp = new Map(adsets.filter(a => a.campaign_id).map(a => [a.id, a.campaign_id!]));
  const scopeOf = (campaignId?: string, adsetId?: string): ScopeCampaign | undefined =>
    campScope ? scopeMap.get(campaignId ?? (adsetId ? adsetCamp.get(adsetId) ?? "" : "")) : undefined;
  const scopedAdsets = campScope ? adsets.filter(a => scopeOf(a.campaign_id)) : adsets;
  const scopedAds = campScope ? ads.filter(a => scopeOf(a.campaign_id, a.adset_id)) : ads;

  const visCampaigns = applySort(filterData(campaigns));
  const visAdsets = applySort(filterData(scopedAdsets));
  const visAds = applySort(filterData(scopedAds));

  if (!accountId) {
    return <GlobalCampaignsView />;
  }

  // Selección del nivel actual (para la barra y la casilla de cabecera).
  const sel = level === "campaign" ? selectedCampaignIds : level === "adset" ? selectedAdsetIds : selectedAdIds;
  const selEntities = (level === "campaign" ? campaigns : level === "adset" ? adsets : ads).filter(e => sel.has(e.id));
  const setSel = level === "campaign" ? setSelectedCampaignIds : level === "adset" ? setSelectedAdsetIds : setSelectedAdIds;
  const visIds = (level === "campaign" ? visCampaigns : level === "adset" ? visAdsets : visAds).map(r => r.id);
  const allSel = visIds.length > 0 && visIds.every(id => sel.has(id));
  const someSel = visIds.some(id => sel.has(id));
  const toggleOne = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(visIds));

  // ── Tab labels ────────────────────────────────────────────────────────────

  const scopeLabel = campScope ? `${campScope.length} campaña${campScope.length > 1 ? "s" : ""}` : "";
  const adsetTabLabel = level === "adset" && campScope ? `Ad Sets · ${scopeLabel}`
    : level === "adset" && selCampaign
      ? `Ad Sets · ${selCampaign.name.length > 18 ? selCampaign.name.slice(0, 18) + "…" : selCampaign.name}`
      : "Ad Sets";
  const adTabLabel = level === "ad" && selAdset
    ? `Anuncios · ${selAdset.name.length > 18 ? selAdset.name.slice(0, 18) + "…" : selAdset.name}`
    : level === "ad" && campScope ? `Anuncios · ${scopeLabel}` : "Anuncios";

  /** Puntito de la campaña a la que pertenece la fila (solo con varias campañas elegidas). */
  const rowScope = (r: { campaign_id?: string; adset_id?: string }) => scopeOf(r.campaign_id, r.adset_id);

  // Con 2 o más seleccionados en un nivel, su pestaña lo indica con un contador.
  const tabBtn = (id: Level, label: string, short: string, active: boolean, onClick: () => void, selCount: number, selNoun: string) => (
    <button
      key={id}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap max-md:flex-1 max-md:px-2 max-md:py-3 ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      <span className="max-md:hidden">{label}</span>
      <span className="md:hidden">{short}</span>
      {selCount >= 2 && (
        <span
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
          title={`${selCount} ${selNoun}`}
          aria-label={`${selCount} ${selNoun}`}
        >
          {selCount}
        </span>
      )}
    </button>
  );

  // ── Column headers ────────────────────────────────────────────────────────

  const sh = (key: string, label: string, w: string) => (
    <TableHead
      key={key}
      className={`py-2 text-[10px] font-semibold text-right ${w} cursor-pointer select-none hover:text-foreground ${sort?.key === key ? "text-primary" : ""}`}
      onClick={() => toggleSort(key)}
    >
      <span className="inline-flex items-center justify-end gap-0.5">
        {label}{sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </span>
    </TableHead>
  );
  const metricHeaders = <>{columns.map(c => sh(c.key, c.label, c.w))}</>;
  const COLS = columns.length + 5; // casilla + nombre + métricas + estado + presupuesto/creative + acciones

  // Total de lo que se ve ahora en la tabla, en la moneda de la cuenta.
  const visRows = level === "campaign" ? visCampaigns : level === "adset" ? visAdsets : visAds;
  const totals = sumMetrics(visRows.map(r => ({ ins: insightsMap[r.id], factor: 1 })));

  /** Botones visibles por fila. */
  const rowActions = (lvl: Level, id: string, name: string, extra?: React.ReactNode) => (
    <div className="-ml-1.5 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
      {extra}
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Ver gráficas" aria-label="Ver gráficas"
        onClick={() => setChartTarget({ level: lvl, id, name, accountId, bmId: bmId ?? undefined, currency })}>
        <BarChart3 className="h-3.5 w-3.5" />
      </Button>
      <a
        href={adsManagerUrl(lvl, accountId, id)} target="_blank" rel="noreferrer"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        title="Abrir en Ads Manager"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );

  // Nivel superior al que se vuelve en móvil.
  const parentName = level === "ad" ? (selAdset?.name ?? (campScope ? scopeLabel : undefined))
    : level === "adset" ? (campScope ? scopeLabel : selCampaign?.name) : undefined;
  function goBack() {
    if (level === "adset") void goToCampaigns();
    else if (selCampaign) void drillAdsets(selCampaign);
    else void goToAdsets();
  }
  const noun = level === "campaign" ? "campañas" : level === "adset" ? "ad sets" : "anuncios";

  const freshness: Freshness = insFresh.syncedAt && dataFresh.syncedAt
    ? (new Date(insFresh.syncedAt) < new Date(dataFresh.syncedAt) ? insFresh : dataFresh)
    : (dataFresh.syncedAt ? dataFresh : insFresh);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <TooltipProvider>
    <div className="space-y-0">

      {/* Cuenta actual */}
      <div className="flex items-center gap-2 pb-2 text-sm max-md:flex-wrap">
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <Select
          value={`act_${accountId}`}
          onValueChange={v => {
            const a = accountList.find(x => x.id === v);
            if (a) router.push(`/meta/campaigns?accountId=${a.id.replace("act_", "")}&bmId=${a.bmId}`);
          }}
        >
          <SelectTrigger className="h-7 min-w-0 md:min-w-44 max-w-72 text-sm font-semibold bg-card max-md:max-w-none max-md:flex-1 max-md:data-[size=default]:h-10" aria-label="Cambiar de cuenta">
            <SelectValue>{accountName || "Cuenta"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {accountList.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}{a.currency && a.currency !== "USD" ? ` · ${a.currency}` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-xs max-md:hidden">· {accountId}{currency !== "USD" ? ` · ${currency}` : ""}</span>
        <button className="ml-2 text-xs text-primary hover:underline max-md:ml-0 max-md:w-full max-md:py-2 max-md:text-left" onClick={() => router.push("/meta/campaigns")}>
          Todas las cuentas
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b bg-card -mx-5 px-5 max-md:flex-wrap">
        <div className="contents max-md:flex max-md:w-full">
          {tabBtn("campaign", "Campañas", "Campañas", level === "campaign", goToCampaigns, selectedCampaignIds.size, "campañas seleccionadas")}
          {tabBtn("adset", adsetTabLabel, "Ad Sets", level === "adset", goToAdsets, selectedAdsetIds.size, "ad sets seleccionados")}
          {tabBtn("ad", adTabLabel, "Anuncios", level === "ad", goToAds, selectedAdIds.size, "anuncios seleccionados")}
        </div>

        <div className="ml-auto flex items-center gap-2 py-1 max-md:ml-0 max-md:w-full">
          <TrendingUp className={`h-3.5 w-3.5 max-md:hidden ${loadingInsights ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none max-md:data-[size=default]:h-10" aria-label="Periodo">
              <SelectValue>{labelOf(DATE_PRESETS, datePreset)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <FreshnessBar freshness={freshness} now={now} loading={loadingData || loadingInsights} onRefresh={refreshFromMeta} datePreset={datePreset} progress={syncProgress} />
        </div>
      </div>

      {/* Dónde estoy y volver: en móvil las pestañas no caben con el nombre */}
      {parentName && (
        <button
          className="flex min-h-11 w-full items-center gap-1 pt-2 text-left text-sm font-medium md:hidden"
          onClick={goBack}
        >
          <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{parentName}</span>
        </button>
      )}

      {/* Campaña (y ad set) en la que estoy navegando */}
      {selCampaign && level !== "campaign" && (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground ${level === "adset" ? "max-md:hidden" : ""}`}>
          <span>Navegando en la campaña</span>
          <span className="rounded-md border bg-card px-2 py-0.5 font-medium text-foreground max-w-full md:max-w-[32rem] truncate" title={selCampaign.name}>{selCampaign.name}</span>
          {level === "ad" && selAdset && (<><ChevronRight className="h-3 w-3" /><span className="rounded-md border bg-card px-2 py-0.5 font-medium text-foreground max-w-full md:max-w-[24rem] truncate" title={selAdset.name}>{selAdset.name}</span></>)}
          <button className="text-primary hover:underline" onClick={goToCampaigns}>Cambiar</button>
        </div>
      )}

      {/* Varias campañas elegidas: leyenda de colores */}
      {campScope && level !== "campaign" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground">
          <span>Viendo {campScope.length === 1 ? "la campaña" : `${campScope.length} campañas`}</span>
          {campScope.map(c => (
            <span key={c.id} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 font-medium text-foreground md:max-w-[20rem]" title={c.name}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
              <span className="truncate">{c.name}</span>
            </span>
          ))}
          {level === "ad" && selAdset && (<><ChevronRight className="h-3 w-3" /><span className="rounded-md border bg-card px-2 py-0.5 font-medium text-foreground max-w-full md:max-w-[24rem] truncate" title={selAdset.name}>{selAdset.name}</span></>)}
          <button className="text-primary hover:underline" onClick={goToCampaigns}>Cambiar</button>
        </div>
      )}

      {/* Resumen de la vista (mismas tarjetas que Rendimiento, con lo que se ve aquí) */}
      <div className="pt-3">
        <MetricsSummary
          scope={noun} loading={loadingInsights}
          items={(level === "campaign" ? campaigns : level === "adset" ? scopedAdsets : scopedAds).map(e => ({ ins: insightsMap[e.id], currency }))}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 pb-2 flex-wrap">
        <div className="relative max-md:w-full">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground max-md:top-3.5" />
          <Input
            placeholder="Buscar..." className="pl-8 h-8 text-sm w-44 bg-card max-md:h-10 max-md:w-full max-md:text-base"
            value={nameFilter} onChange={e => setNameFilter(e.target.value)}
          />
        </div>

        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-card max-md:flex-1 max-md:data-[size=default]:h-10" aria-label="Filtrar por estado">
            <SelectValue>{labelOf(STATUS_OPTS, statusFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground max-md:hidden">
          {!loadingData && !error ? `${visIds.length} elementos` : null}
        </span>

        <Button
          variant="outline" size="sm" className="h-8 text-xs ml-1 max-md:ml-0 max-md:h-10 max-md:bg-card"
          onClick={openJobsDock}
        >
          <Briefcase className="h-3.5 w-3.5 mr-1" /> Trabajos
        </Button>
        <div className="ml-auto max-md:hidden"><ColumnPicker state={columnState} /></div>
        <MobileSort sort={sort} onChange={setSort} />
      </div>

      <BatchBanner batch={tracker.batch} onDismiss={tracker.dismiss} onOpenJobs={openJobsDock} />

      {/* Barra de acciones de la selección */}
      <SelectionBar
        count={sel.size}
        statuses={selEntities.map(e => e.status)}
        hidden={[...sel].filter(id => !visIds.includes(id)).length}
        noun={level === "campaign" ? "campaña" : level === "adset" ? "ad set" : "anuncio"}
        busy={bulkBusy}
        onDuplicate={
          level === "campaign" ? () => setDuplicateTargets(campaigns.filter(c => selectedCampaignIds.has(c.id)))
            : level === "adset" ? () => setShowDuplicateAdsetsModal(true)
              : () => setShowDuplicateAdsModal(true)
        }
        onStatus={s => bulkSetStatus(level, new Set(selEntities.filter(e => e.status === fromStatus(s)).map(e => e.id)), s)}
        onClear={() => setSel(new Set())}
      />

      {/* Error */}
      {error && <div className="mb-2"><ErrorDetails info={error} /></div>}

      {/* Datos de respaldo (Meta falló o limitó la cuenta y servimos la última copia buena) */}
      {stale && !error && (
        <div className="mb-2">
          <ErrorDetails
            variant="warning"
            info={{ ...staleInfo, title: `Mostrando datos guardados (${ago(dataFresh.syncedAt, now)}): ${staleInfo?.title ?? "Meta no respondió"}` }}
          />
        </div>
      )}

      {/* Table */}
      {loadingData ? (
        <div className="space-y-1.5 pt-1">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded max-md:h-36" />)}
        </div>
      ) : error && visIds.length === 0 ? null : (<>
        {/* Móvil: tarjetas */}
        <div className={`space-y-2 md:hidden ${sel.size > 0 ? "pb-28" : ""}`}>
          {visRows.length > 0 ? (
            <MobileSummary
              title={`Total · ${visRows.length} ${noun}`} metrics={totals} currency={currency} loading={loadingInsights}
              allSel={allSel} someSel={someSel} onToggleAll={toggleAll}
            />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Sin {noun}{statusFilter !== "ALL" ? ` (filtro: ${labelOf(STATUS_OPTS, statusFilter)})` : ""}
            </p>
          )}
          {visRows.map(r => {
            const ins = insightsMap[r.id];
            const { daily_budget, lifetime_budget, creative_id } = r as Partial<Campaign> & Partial<Ad>;
            const sc = level === "campaign" ? undefined : rowScope(r as Partial<Ad>);
            return (
              <MobileCard
                key={r.id} name={r.name}
                tag={sc ? (<>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: sc.color }} aria-hidden />
                  <span className="truncate">{sc.name}</span>
                </>) : undefined}
                detail={daily_budget ? `Presupuesto diario ${fmtBudget(daily_budget, currency)}` : lifetime_budget ? `Presupuesto total ${fmtBudget(lifetime_budget, currency)}` : undefined}
                metrics={calcMetrics(ins)} currency={currency} loading={loadingInsights}
                stripe={stripeClass(ins, !loadingInsights)}
                selected={sel.has(r.id)} onToggle={() => toggleOne(r.id)}
                status={<StatusCell entityId={r.id} status={r.status} entityType={level} loadingSet={loadingStatus} onToggle={toggleStatus} />}
                href={adsManagerUrl(level, accountId, r.id)}
                onOpen={level === "campaign" ? () => drillAdsets(r) : level === "adset" ? () => drillAds(r) : undefined}
                openLabel={level === "campaign" ? "Ad sets" : "Anuncios"}
                onDuplicate={
                  level === "campaign" ? () => setDuplicateTargets([r as Campaign])
                    : level === "adset" ? () => { setSelectedAdsetIds(new Set([r.id])); setShowDuplicateAdsetsModal(true); }
                      : creative_id ? () => { setSelectedAdIds(new Set([r.id])); setShowDuplicateAdsModal(true); } : undefined
                }
                onCharts={() => setChartTarget({ level, id: r.id, name: r.name, accountId: accountId!, bmId: bmId ?? undefined, currency })}
              />
            );
          })}
        </div>

        {/* Desktop: tabla */}
        <div className="rounded-lg border bg-card shadow-sm overflow-x-auto max-md:hidden">
          <Table className="w-full min-w-[1100px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent border-b">
                <TableHead className={`py-2 ${STICKY_CHECK}`}>
                  <Checkbox checked={allSel} indeterminate={someSel} onToggle={toggleAll} label="Seleccionar todo" />
                </TableHead>
                <TableHead className={`py-2 text-[10px] font-semibold ${STICKY_STATUS}`}>STATUS</TableHead>
                <TableHead className={`py-2 text-[10px] font-semibold ${STICKY_ACTIONS}`}>ACCIONES</TableHead>
                <TableHead
                  className={`py-2 text-[10px] font-semibold cursor-pointer select-none hover:text-foreground ${STICKY_NAME} ${sort?.key === "name" ? "text-primary" : ""}`}
                  onClick={() => toggleSort("name")}
                >
                  NOMBRE{sort?.key === "name" ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </TableHead>
                {metricHeaders}
                {level !== "ad" && <TableHead className="py-2 text-[10px] font-semibold w-20">PRESUP.</TableHead>}
                {level === "ad" && <TableHead className="py-2 text-[10px] font-semibold w-20">CREATIVE</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visRows.length > 0 && (
                <TableRow className="group bg-muted hover:bg-muted font-semibold">
                  <TableCell className={`py-2 ${STICKY_CHECK} bg-muted`} />
                  <TableCell className={`py-2 ${STICKY_STATUS} bg-muted`} />
                  <TableCell className={`py-2 ${STICKY_ACTIONS} bg-muted`} />
                  <TableCell className={`py-2 text-xs ${STICKY_NAME} bg-muted`}>
                    Total · {visRows.length} {level === "campaign" ? "campañas" : level === "adset" ? "ad sets" : "anuncios"}
                  </TableCell>
                  <MetricCells metrics={totals} loading={loadingInsights} columns={columns} currency={currency} />
                  <TableCell className="py-2" />
                </TableRow>
              )}

              {/* ── CAMPAÑAS */}
              {level === "campaign" && (
                visCampaigns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLS} className="text-center py-12 text-muted-foreground text-sm">
                      Sin campañas{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visCampaigns.map(c => {
                  const ins = insightsMap[c.id];
                  return (
                    <TableRow key={c.id} className="group cursor-pointer hover:bg-muted" onClick={() => drillAdsets(c)}>
                      <TableCell className={`py-2 ${STICKY_CHECK} ${stripeClass(ins, !loadingInsights)}`} onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selectedCampaignIds.has(c.id)} onToggle={() => toggleOne(c.id)} label={`Seleccionar ${c.name}`} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_STATUS}`} onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={c.id} status={c.status} entityType="campaign"
                          loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_ACTIONS}`}>
                        {rowActions("campaign", c.id, c.name, (
                          <>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar campaña" aria-label="Duplicar campaña"
                              onClick={() => setDuplicateTargets([c])}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ))}
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_NAME}`}>
                        <p className="font-medium text-xs leading-tight whitespace-normal break-words line-clamp-2 group-hover:text-primary transition-colors" title={c.name}>{c.name}</p>
                      </TableCell>
                      <MetricCells metrics={calcMetrics(ins)} loading={loadingInsights} columns={columns} currency={currency} />
                      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtBudget(c.daily_budget ?? c.lifetime_budget, currency)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

              {/* ── AD SETS */}
              {level === "adset" && (
                visAdsets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLS} className="text-center py-12 text-muted-foreground text-sm">
                      Sin ad sets{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visAdsets.map(a => {
                  const ins = insightsMap[a.id];
                  return (
                    <TableRow key={a.id} className="group cursor-pointer hover:bg-muted" onClick={() => drillAds(a)}>
                      <TableCell className={`py-2 ${STICKY_CHECK} ${stripeClass(ins, !loadingInsights)}`} onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selectedAdsetIds.has(a.id)} onToggle={() => toggleOne(a.id)} label={`Seleccionar ${a.name}`} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_STATUS}`} onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={a.id} status={a.status} entityType="adset"
                          loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_ACTIONS}`}>
                        {rowActions("adset", a.id, a.name, (
                          <>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar ad set" aria-label="Duplicar ad set"
                              onClick={() => { setSelectedAdsetIds(new Set([a.id])); setShowDuplicateAdsetsModal(true); }}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ))}
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_NAME}`}>
                        <div className="flex items-start gap-1.5">
                          {(() => { const sc = rowScope(a); return sc ? <CampaignDot camp={sc} className="mt-0.5" /> : null; })()}
                          <p className="min-w-0 font-medium text-xs leading-tight whitespace-normal break-words line-clamp-2 group-hover:text-primary transition-colors" title={a.name}>{a.name}</p>
                        </div>
                      </TableCell>
                      <MetricCells metrics={calcMetrics(ins)} loading={loadingInsights} columns={columns} currency={currency} />
                      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtBudget(a.daily_budget ?? a.lifetime_budget, currency)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

              {/* ── ADS */}
              {level === "ad" && (
                visAds.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLS} className="text-center py-12 text-muted-foreground text-sm">
                      Sin anuncios{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visAds.map(ad => {
                  const ins = insightsMap[ad.id];
                  return (
                    <TableRow key={ad.id} className="group hover:bg-muted">
                      <TableCell className={`py-2 ${STICKY_CHECK} ${stripeClass(ins, !loadingInsights)}`} onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selectedAdIds.has(ad.id)} onToggle={() => toggleOne(ad.id)} label={`Seleccionar ${ad.name}`} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_STATUS}`} onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={ad.id} status={ad.status} entityType="ad"
                          loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_ACTIONS}`}>
                        {rowActions("ad", ad.id, ad.name, ad.creative_id ? (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar anuncio" aria-label="Duplicar anuncio"
                            onClick={() => { setSelectedAdIds(new Set([ad.id])); setShowDuplicateAdsModal(true); }}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        ) : null)}
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_NAME}`}>
                        <div className="flex items-start gap-1.5">
                          {(() => { const sc = rowScope(ad); return sc ? <CampaignDot camp={sc} className="mt-0.5" /> : null; })()}
                          <p className="min-w-0 font-medium text-xs leading-tight whitespace-normal break-words line-clamp-2" title={ad.name}>{ad.name}</p>
                        </div>
                      </TableCell>
                      <MetricCells metrics={calcMetrics(ins)} loading={loadingInsights} columns={columns} currency={currency} />
                      <TableCell className="py-2 text-[10px] text-muted-foreground font-mono truncate max-w-[80px]">
                        {ad.creative_id ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

            </TableBody>
          </Table>
        </div>
      </>)}

      {/* Load more */}
      {level === "campaign" && nextCursor && !loadingData && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" className="max-md:h-10 max-md:w-full" onClick={() => loadCampaigns(false, nextCursor!)} disabled={loadingMore}>
            {loadingMore && <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}

      {/* Modales */}
      <EntityChartsSheet target={chartTarget} datePreset={datePreset} onClose={() => setChartTarget(null)} />
      {duplicateTargets && duplicateTargets.length > 0 && (
        <DuplicateCampaignModal
          campaigns={duplicateTargets} accountId={accountId} bmId={bmId} currency={currency}
          onClose={() => setDuplicateTargets(null)}
          onSuccess={({ batchIds, queued }) => {
            setDuplicateTargets(null);
            setSelectedCampaignIds(new Set());
            tracker.track(batchIds, queued);
          }}
        />
      )}

      {showDuplicateAdsetsModal && (
        <DuplicateAdsetsModal
          selectedAdsets={adsets.filter(a => selectedAdsetIds.has(a.id))}
          accountId={accountId} bmId={bmId}
          onClose={() => setShowDuplicateAdsetsModal(false)}
          onSuccess={() => { setShowDuplicateAdsetsModal(false); setSelectedAdsetIds(new Set()); }}
        />
      )}

      {showDuplicateAdsModal && (
        <DuplicateAdsModal
          selectedAds={ads.filter(a => selectedAdIds.has(a.id)).map(a => ({ name: a.name, creativeId: a.creative_id ?? "" })).filter(a => a.creativeId)}
          accountId={accountId} bmId={bmId}
          onClose={() => setShowDuplicateAdsModal(false)}
          onSuccess={() => { setShowDuplicateAdsModal(false); setSelectedAdIds(new Set()); }}
        />
      )}

      {dialogo}
    </div>
    </TooltipProvider>
  );
}

// ─── Vista GLOBAL: campañas de TODAS las cuentas (carga progresiva) ─────────────
interface GAcct { id: string; name: string; account_status: number; bmId: string; currency?: string }
interface GRow { camp: Campaign; accId: string; accName: string; bmId: string; currency?: string }
interface AcctProblem { accName: string; info: ErrorInfo }

function GlobalCampaignsView() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<GAcct[]>([]);
  const [rows, setRows] = useState<GRow[]>([]);
  const [insMap, setInsMap] = useState<Record<string, Insights>>({});
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [datePreset, setDatePreset] = useState("today");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>({ key: "spend", dir: "desc" });
  const [oldest, setOldest] = useState<string | null>(null);
  const [problems, setProblems] = useState<AcctProblem[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dupTargets, setDupTargets] = useState<GRow[] | null>(null);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const columnState = useColumns();
  const { columns } = columnState;
  const { fx, toUsd } = useFx();
  // Invalida corridas viejas (StrictMode monta el efecto 2× en dev y dispararía cargas duplicadas).
  const runId = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = useCallback(async (refresh = false) => {
    const myRun = ++runId.current;
    setLoading(true); setRefreshing(refresh); setRows([]); setInsMap({}); setDone(0); setOldest(null); setProblems([]);
    let accs: GAcct[] = [];
    try {
      const res = await fetch("/api/meta/accounts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toastApiError(json, "No se pudo cargar la lista de cuentas");
      accs = (json.accounts ?? []) as GAcct[];
    } catch {
      toast.error("No se pudo conectar con el servidor");
    }
    if (myRun !== runId.current) return; // otra corrida la reemplazó
    setAccounts(accs);
    const active = accs.filter(a => a.account_status === 1);
    setTotal(active.length);
    const r = refresh ? "&refresh=true" : "";
    // Progresivo y acotado: pocas cuentas a la vez (el rate limit de Meta es por cuenta
    // y por app); «Traer de Meta» va aún más despacio porque salta las copias guardadas.
    await runPool(active, refresh ? 3 : 6, async (acc) => {
      const rawId = acc.id.replace("act_", "");
      try {
        const [cRes, iRes] = await Promise.all([
          fetch(`/api/meta/campaigns?accountId=${rawId}&bmId=${acc.bmId}${r}`),
          fetch(`/api/meta/insights?accountId=${rawId}&level=campaign&datePreset=${datePreset}&bmId=${acc.bmId}${r}`),
        ]);
        const [cj, ij] = await Promise.all([cRes.json().catch(() => ({})), iRes.json().catch(() => ({}))]);
        if (myRun !== runId.current) return; // descartar respuestas de corrida obsoleta
        for (const [res, j] of [[cRes, cj], [iRes, ij]] as const) {
          if (!res.ok || j.stale) {
            const info = errorInfoOf(j) ?? { title: j.error ?? j.staleReason ?? "Error" };
            setProblems(p => [...p, { accName: acc.name, info: j.stale ? { ...info, title: `Datos guardados: ${info.title}` } : info }]);
          }
        }
        const synced = [cj.syncedAt, ij.syncedAt].filter(Boolean) as string[];
        if (synced.length) setOldest(prev => [prev, ...synced].filter(Boolean).sort()[0] ?? null);
        const camps: Campaign[] = cj.campaigns ?? [];
        const ins: Array<Insights & { campaign_id?: string }> = ij.data ?? [];
        if (ins.length) setInsMap(prev => { const n = { ...prev }; for (const it of ins) if (it.campaign_id) n[it.campaign_id] = it; return n; });
        if (camps.length) setRows(prev => {
          // dedupe por accId:campId (misma cuenta puede aparecer en 2 BMs)
          const seen = new Set(prev.map(x => `${x.accId}:${x.camp.id}`));
          const fresh = camps
            .filter(c => !seen.has(`${rawId}:${c.id}`))
            .map(c => ({ camp: c, accId: rawId, accName: acc.name, bmId: acc.bmId, currency: acc.currency }));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      } catch {
        setProblems(p => [...p, { accName: acc.name, info: { kind: "network", title: "No se pudo conectar con el servidor" } }]);
      }
      if (myRun === runId.current) setDone(d => d + 1);
    });
    if (myRun === runId.current) { setLoading(false); setRefreshing(false); }
  }, [datePreset]);

  useEffect(() => { run(); }, [run]);

  const tracker = useBatchTracker(() => { void run(true); });

  const toggleSort = (key: string) => setSort(s => s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });

  const q = query.toLowerCase().trim();
  let vis = rows.filter(r =>
    (statusFilter === "ALL" || r.camp.status === statusFilter) &&
    (!q || r.camp.name.toLowerCase().includes(q) || r.accName.toLowerCase().includes(q))
  );
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: GRow): number | string => {
      if (sort.key === "name") return r.camp.name.toLowerCase();
      if (sort.key === "account") return r.accName.toLowerCase();
      const m = calcMetrics(insMap[r.camp.id]) as Record<string, number | null> | null;
      const v = m ? m[sort.key] : null;
      if (v == null) return -Infinity;
      // Dinero en USD para comparar entre monedas. Sin tasa: al fondo, nunca mezclado.
      if (!MONEY_KEYS.has(sort.key)) return v;
      const f = toUsd(r.currency);
      return f == null ? -Infinity : v * f;
    };
    vis = [...vis].sort((a, b) => {
      const va = val(a), vb = val(b);
      return typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) * dir : ((va as number) - (vb as number)) * dir;
    });
  }

  // Totales en USD. Las monedas sin tasa no se suman y se avisa.
  const noRate = [...new Set(vis.filter(r => toUsd(r.currency) == null).map(r => r.currency ?? "?"))];
  const totals = sumMetrics(vis.filter(r => toUsd(r.currency) != null).map(r => ({ ins: insMap[r.camp.id], factor: toUsd(r.currency) ?? 1 })));
  const otherCurrencies = [...new Set(vis.map(r => r.currency ?? "USD"))].filter(c => c !== "USD");

  const keyOf = (r: GRow) => `${r.accId}:${r.camp.id}`;
  const openCampaign = (r: GRow) => {
    const p = new URLSearchParams({ accountId: r.accId, bmId: r.bmId, campaignId: r.camp.id, campaignName: r.camp.name });
    router.push(`/meta/campaigns?${p}`);
  };
  const visKeys = vis.map(keyOf);
  const allSel = visKeys.length > 0 && visKeys.every(k => selected.has(k));
  const someSel = visKeys.some(k => selected.has(k));
  const selRows = rows.filter(r => selected.has(keyOf(r)));
  const toggleOne = (k: string) => setSelected(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function bulk(status: EntityStatus) {
    setBulkBusy(true);
    try {
      const res = await bulkStatus(selRows.filter(r => r.camp.status === fromStatus(status)).map(r => ({ id: r.camp.id, accountId: r.accId, bmId: r.bmId, name: r.camp.name })), "campaign", status);
      const ok = new Set(res.ok);
      setRows(prev => prev.map(r => ok.has(r.camp.id) ? { ...r, camp: { ...r.camp, status } } : r));
      reportBulk(res, status);
      if (res.cascadeJobs.length) void trackCascade(res.cascadeJobs, () => {});
    } finally {
      setBulkBusy(false);
    }
  }

  const arrow = (key: string) => sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const sh = (key: string, label: string, w: string) => (
    <TableHead key={key} className={`py-2 text-[10px] font-semibold text-right ${w} cursor-pointer select-none hover:text-foreground ${sort?.key === key ? "text-primary" : ""}`} onClick={() => toggleSort(key)}>
      <span className="inline-flex items-center justify-end gap-0.5">{label}{arrow(key)}</span>
    </TableHead>
  );

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-2 pb-2 flex-wrap">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Todas las cuentas</span>
        <Select value="" onValueChange={(v) => { const a = accounts.find(x => x.id === v); if (a) router.push(`/meta/campaigns?accountId=${a.id.replace("act_", "")}&bmId=${a.bmId}`); }}>
          <SelectTrigger className="h-7 text-xs w-52 ml-1 max-md:ml-0 max-md:w-full max-md:data-[size=default]:h-10"><SelectValue placeholder="Ver una cuenta…">Ver una cuenta…</SelectValue></SelectTrigger>
          <SelectContent>
            {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">
          <TrendingUp className={`h-3.5 w-3.5 max-md:hidden ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none max-md:data-[size=default]:h-10" aria-label="Periodo"><SelectValue>{labelOf(DATE_PRESETS, datePreset)}</SelectValue></SelectTrigger>
            <SelectContent>{DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
          </Select>
          <FreshnessBar
            freshness={{ syncedAt: oldest, source: refreshing ? "meta" : "db" }}
            now={now} loading={loading} onRefresh={() => run(true)} datePreset={datePreset}
          />
        </div>
      </div>

      {/* Resumen de todas las cuentas, por moneda y por cuenta publicitaria */}
      <MetricsSummary
        scope="campañas" loading={loading} byAccount
        items={rows.map(r => ({ ins: insMap[r.camp.id], currency: r.currency ?? "USD", account: { id: r.accId, name: r.accName } }))}
      />

      <div className="flex items-center gap-2 pt-1 pb-2 flex-wrap">
        <div className="relative max-md:w-full">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground max-md:top-3.5" />
          <Input placeholder="Buscar campaña o cuenta..." className="pl-8 h-8 text-sm w-56 bg-card max-md:h-10 max-md:w-full max-md:text-base" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-card max-md:flex-1 max-md:data-[size=default]:h-10" aria-label="Filtrar por estado"><SelectValue>{labelOf(STATUS_OPTS, statusFilter)}</SelectValue></SelectTrigger>
          <SelectContent>{STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1 max-md:order-last max-md:ml-0 max-md:w-full">
          {loading ? `${refreshing ? "Trayendo de Meta" : "Cargando"} ${done}/${total} cuentas…` : `${vis.length} campañas · ${total} cuentas`}
        </span>
        {problems.length > 0 && (
          <button className="inline-flex items-center gap-1 text-xs text-warning hover:underline" onClick={() => setShowProblems(s => !s)}>
            <AlertTriangle className="h-3.5 w-3.5" /> {problems.length} aviso{problems.length > 1 ? "s" : ""} de cuentas
          </button>
        )}
        <Button variant="outline" size="sm" className="h-8 text-xs ml-auto max-md:ml-0 max-md:h-10 max-md:bg-card" onClick={openJobsDock}>
          <Briefcase className="h-3.5 w-3.5 mr-1" /> Trabajos
        </Button>
        <div className="max-md:hidden"><ColumnPicker state={columnState} /></div>
        <MobileSort sort={sort} onChange={setSort} extra={[{ value: "account", label: "Cuenta" }]} />
      </div>

      {showProblems && problems.length > 0 && (
        <div className="space-y-1.5 pb-2">
          {problems.map((p, i) => (
            <div key={i}>
              <p className="text-[11px] text-muted-foreground mb-0.5">{p.accName}</p>
              <ErrorDetails info={p.info} variant="warning" compact />
            </div>
          ))}
        </div>
      )}

      <BatchBanner batch={tracker.batch} onDismiss={tracker.dismiss} onOpenJobs={openJobsDock} />

      {noRate.length > 0 && !loading && (
        <p className="mb-2 text-xs text-warning">
          Sin tasa de cambio para {noRate.join(", ")}: esas cuentas no se suman al total y van al final al ordenar por dinero.
        </p>
      )}

      <SelectionBar
        count={selected.size} statuses={selRows.map(r => r.camp.status)} hidden={[...selected].filter(k => !visKeys.includes(k)).length} noun="campaña" busy={bulkBusy}
        onDuplicate={() => setDupTargets(selRows)}
        onStatus={bulk}
        onClear={() => setSelected(new Set())}
      />

      {/* Móvil: tarjetas */}
      <div className={`space-y-2 md:hidden ${selected.size > 0 ? "pb-28" : ""}`}>
        {vis.length > 0 ? (
          <MobileSummary
            title={`Total · ${vis.length} campañas`} note={otherCurrencies.length > 0 ? "en USD aprox." : undefined}
            metrics={totals} currency="USD" loading={false}
            allSel={allSel} someSel={someSel} onToggleAll={() => setSelected(allSel ? new Set() : new Set(visKeys))}
          />
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">{loading ? "Cargando…" : "Sin campañas"}</p>
        )}
        {vis.map(r => {
          const ins = insMap[r.camp.id];
          const k = keyOf(r);
          return (
            <MobileCard
              key={k} name={r.camp.name} detail={r.accName}
              metrics={calcMetrics(ins)} currency={r.currency ?? "USD"} loading={false}
              stripe={stripeClass(ins, true)}
              selected={selected.has(k)} onToggle={() => toggleOne(k)}
              status={<StatusLabel status={r.camp.status} />}
              href={adsManagerUrl("campaign", r.accId, r.camp.id)}
              onOpen={() => openCampaign(r)}
              openLabel="Ad sets"
              onDuplicate={() => setDupTargets([r])}
              onCharts={() => setChartTarget({ level: "campaign", id: r.camp.id, name: r.camp.name, accountId: r.accId, bmId: r.bmId, currency: r.currency ?? "USD" })}
            />
          );
        })}
      </div>

      {/* Desktop: tabla */}
      <div className="rounded-lg border bg-card shadow-sm overflow-x-auto max-md:hidden">
        <Table className="w-full min-w-[1220px]">
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className={`py-2 ${STICKY_CHECK}`}>
                <Checkbox checked={allSel} indeterminate={someSel} label="Seleccionar todo"
                  onToggle={() => setSelected(allSel ? new Set() : new Set(visKeys))} />
              </TableHead>
              <TableHead className={`py-2 text-[10px] font-semibold ${STICKY_STATUS}`}>STATUS</TableHead>
              <TableHead className={`py-2 text-[10px] font-semibold ${STICKY_ACTIONS}`}>ACCIONES</TableHead>
              <TableHead className={`py-2 text-[10px] font-semibold cursor-pointer select-none hover:text-foreground ${STICKY_NAME} ${sort?.key === "name" ? "text-primary" : ""}`} onClick={() => toggleSort("name")}>NOMBRE{arrow("name")}</TableHead>
              <TableHead className={`py-2 text-[10px] font-semibold min-w-[140px] cursor-pointer select-none hover:text-foreground ${sort?.key === "account" ? "text-primary" : ""}`} onClick={() => toggleSort("account")}>CUENTA{arrow("account")}</TableHead>
              {columns.map(c => sh(c.key, c.label, c.w))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {vis.length > 0 && (
              <TableRow className="group bg-muted hover:bg-muted font-semibold">
                <TableCell className={`py-2 ${STICKY_CHECK} bg-muted`} />
                <TableCell className={`py-2 ${STICKY_STATUS} bg-muted`} />
                <TableCell className={`py-2 ${STICKY_ACTIONS} bg-muted`} />
                <TableCell className={`py-2 text-xs ${STICKY_NAME} bg-muted`}>
                  Total · {vis.length} campañas
                </TableCell>
                <TableCell className="py-2 text-[11px] font-normal text-muted-foreground"
                  title={otherCurrencies.map(c => `1 USD = ${(fx?.rates[c] ?? 0).toLocaleString("es-CO", { maximumFractionDigits: 0 })} ${c}`).join(" · ")}>
                  {otherCurrencies.length > 0 ? "en USD aprox." : "USD"}
                </TableCell>
                <MetricCells metrics={totals} loading={false} columns={columns} currency="USD" />
              </TableRow>
            )}
            {vis.length === 0 ? (
              <TableRow><TableCell colSpan={columns.length + 5} className="text-center py-16 text-muted-foreground text-sm">{loading ? "Cargando…" : "Sin campañas"}</TableCell></TableRow>
            ) : vis.map(r => {
              const ins = insMap[r.camp.id];
              const k = keyOf(r);
              return (
                <TableRow key={k} className="group cursor-pointer hover:bg-muted" onClick={() => openCampaign(r)}>
                  <TableCell className={`py-2 ${STICKY_CHECK} ${stripeClass(ins, true)}`} onClick={e => e.stopPropagation()}>
                    <Checkbox checked={selected.has(k)} onToggle={() => toggleOne(k)} label={`Seleccionar ${r.camp.name}`} />
                  </TableCell>
                  <TableCell className={`py-2 ${STICKY_STATUS}`}>
                    <StatusLabel status={r.camp.status} />
                  </TableCell>
                  <TableCell className={`py-2 ${STICKY_ACTIONS}`}>
                    <div className="-ml-1.5 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar campaña" aria-label="Duplicar campaña" onClick={() => setDupTargets([r])}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Ver gráficas" aria-label="Ver gráficas"
                        onClick={() => setChartTarget({ level: "campaign", id: r.camp.id, name: r.camp.name, accountId: r.accId, bmId: r.bmId, currency: r.currency ?? "USD" })}>
                        <BarChart3 className="h-3.5 w-3.5" />
                      </Button>
                      <a
                        href={adsManagerUrl("campaign", r.accId, r.camp.id)} target="_blank" rel="noreferrer"
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Abrir en Ads Manager"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </TableCell>
                  <TableCell className={`py-2 ${STICKY_NAME}`}><span className="text-xs leading-tight font-medium whitespace-normal break-words line-clamp-2 group-hover:text-primary" title={r.camp.name}>{r.camp.name}</span></TableCell>
                  <TableCell className="py-2"><span className="text-[11px] text-muted-foreground line-clamp-1">{r.accName}</span></TableCell>
                  <MetricCells metrics={calcMetrics(ins)} loading={false} columns={columns} currency={r.currency ?? "USD"} />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <EntityChartsSheet target={chartTarget} datePreset={datePreset} onClose={() => setChartTarget(null)} />
      {dupTargets && dupTargets.length > 0 && (
        <DuplicateCampaignModal
          campaigns={dupTargets.map(r => ({ ...r.camp, accountId: r.accId, bmId: r.bmId }))}
          currency={dupTargets.length === 1 ? dupTargets[0].currency : undefined}
          onClose={() => setDupTargets(null)}
          onSuccess={({ batchIds, queued }) => {
            setDupTargets(null);
            setSelected(new Set());
            tracker.track(batchIds, queued);
          }}
        />
      )}
    </div>
  );
}

export default function CampaignsView() {

  return (
    <Suspense fallback={
      <div className="space-y-1.5 pt-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
      </div>
    }>
      <ManagerByAccount />
    </Suspense>
  );
}
