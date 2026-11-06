"use client";

import { useEffect, useState, useCallback, Suspense, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  RefreshCw, Search, Copy, TrendingUp, Play, Pause, Briefcase, Building2,
  ExternalLink, X, CloudDownload, Loader2, CheckCircle2, AlertTriangle, Columns3,
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
import { DuplicateCampaignModal } from "@/components/duplicate-campaign-modal";
import { useConfirm } from "@/components/use-confirm";
import { DuplicateAdsetsModal } from "@/components/duplicate-adsets-modal";
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
interface Ad { id: string; name: string; status: string; creative_id?: string; }

interface Insights {
  spend: string; impressions: string; clicks: string; ctr: string; cpc: string;
  cpm?: string; inline_link_clicks?: string; unique_link_clicks_ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}
type Level = "campaign" | "adset" | "ad";
type Selection = { id: string; name: string };
type EntityStatus = "ACTIVE" | "PAUSED";

/** Cómo llegaron los datos: copia de DB, Meta en vivo, o caché por límite de Meta. */
interface Freshness { syncedAt: string | null; source: string | null }

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
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
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

function Checkbox({ checked, indeterminate, onToggle, label }: {
  checked: boolean; indeterminate?: boolean; onToggle: () => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref} type="checkbox" checked={checked} aria-label={label}
      onChange={() => { }} onClick={e => { e.stopPropagation(); onToggle(); }}
      className="cursor-pointer h-3.5 w-3.5"
    />
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
      className={`relative block h-4 w-7 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${isActive ? "bg-primary" : "bg-muted-foreground/35"}`}
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

/** Barra que aparece al seleccionar: acciones masivas a mano. */
function SelectionBar({
  count, hidden = 0, noun, busy, onDuplicate, onStatus, onClear,
}: {
  count: number; hidden?: number; noun: string; busy: boolean;
  onDuplicate?: () => void; onStatus: (s: EntityStatus) => void; onClear: () => void;
}) {
  const { confirmar, dialogo } = useConfirm();
  if (count === 0) return null;
  const activate = async () => {
    // Activar empieza a gastar presupuesto: una tanda no debe salir de un clic suelto.
    const ok = await confirmar({
      title: `¿Activar ${count} ${noun}${count > 1 ? "s" : ""}?`,
      description: count > 1 ? "Empezarán a gastar presupuesto." : "Empezará a gastar presupuesto.",
      confirmLabel: "Activar",
    });
    if (ok) onStatus("ACTIVE");
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 mb-2 flex-wrap">
      <span className="text-xs font-medium">{count} {noun}{count > 1 ? "s" : ""} seleccionad{noun.endsWith("a") ? "a" : "o"}{count > 1 ? "s" : ""}{hidden > 0 ? <span className="font-normal text-warning"> · {hidden} fuera del filtro actual</span> : null}</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {onDuplicate && (
          <Button size="sm" className="h-7 text-xs" onClick={onDuplicate} disabled={busy}>
            <Copy className="h-3.5 w-3.5 mr-1" /> Duplicar
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-xs bg-card" onClick={() => onStatus("PAUSED")} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Pause className="h-3.5 w-3.5 mr-1" />} Pausar
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs bg-card" onClick={activate} disabled={busy}>
          <Play className="h-3.5 w-3.5 mr-1" /> Activar
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClear} disabled={busy}>
          <X className="h-3.5 w-3.5 mr-1" /> Limpiar
        </Button>
      </div>
      {dialogo}
    </div>
  );
}

/**
 * Indicador de frescura con «latido» + botón «Sincronizar con Meta».
 * `everyMin` = cada cuánto sincroniza el servidor este nivel (30 min campañas, 360 min ad sets/anuncios).
 * El latido es verde mientras la copia es reciente, ámbar al pasar de 1× el intervalo y rojo al pasar de 2×.
 */
function FreshnessBar({ freshness, now, loading, onRefresh, everyMin = 30 }: {
  freshness: Freshness; now: number; loading: boolean; onRefresh: () => void; everyMin?: number;
}) {
  const label = freshness.source === "meta" ? "de Meta" : freshness.source === "cache" ? "en caché" : "copia guardada";
  const ageMin = freshness.syncedAt ? (now - new Date(freshness.syncedAt).getTime()) / 60_000 : 0;
  const state = ageMin > everyMin * 2 ? "bad" : ageMin > everyMin * 1.2 ? "warn" : "ok";
  const dot = state === "bad" ? "bg-red-500" : state === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const text = state === "bad" ? "text-red-500" : state === "warn" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2">
      {freshness.syncedAt && (
        <span className={`inline-flex items-center gap-1.5 text-[11px] ${text}`} title={new Date(freshness.syncedAt).toLocaleString("es-CO")}>
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${loading ? "bg-primary" : dot}`} style={{ animationDuration: state === "ok" ? "2.4s" : "1.2s" }} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${loading ? "bg-primary" : dot}`} />
          </span>
          Actualizado {ago(freshness.syncedAt, now)} · {label}
        </span>
      )}
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs bg-card" onClick={onRefresh} disabled={loading}
        title="Pide los datos a Meta ahora, sin usar copias guardadas. El servidor los actualiza solo cada 30 min (campañas) o 6 h (ad sets y anuncios).">
        {loading ? <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5 mr-1" />}
        Sincronizar con Meta
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
  items: Array<{ id: string; accountId: string; bmId?: string }>, entityType: Level, status: EntityStatus,
): Promise<{ ok: string[]; failed: number; firstError: unknown }> {
  const ok: string[] = [];
  let failed = 0;
  let firstError: unknown = null;
  for (const it of items) {
    try {
      const res = await fetch("/api/meta/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: it.id, status, accountId: it.accountId, entityType, bmId: it.bmId }),
      });
      if (res.ok) ok.push(it.id);
      else { failed++; firstError ??= await res.json().catch(() => null); }
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok, failed, firstError };
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

  const [level, setLevel] = useState<Level>("campaign");
  const [selCampaign, setSelCampaign] = useState<Selection | null>(null);
  const [selAdset, setSelAdset] = useState<Selection | null>(null);

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
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [staleInfo, setStaleInfo] = useState<ErrorInfo | null>(null);
  const [stale, setStale] = useState(false);
  const [dataFresh, setDataFresh] = useState<Freshness>({ syncedAt: null, source: null });
  const [insFresh, setInsFresh] = useState<Freshness>({ syncedAt: null, source: null });
  const [now, setNow] = useState(() => Date.now());

  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [nameFilter, setNameFilter] = useState("");
  const [duplicateTargets, setDuplicateTargets] = useState<Campaign[] | null>(null);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<string>>(new Set());
  const [selectedAdsetIds, setSelectedAdsetIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsetsModal, setShowDuplicateAdsetsModal] = useState(false);
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsModal, setShowDuplicateAdsModal] = useState(false);

  // Snapshots para caché client-side (sobreviven re-renders, no recargas de página)
  const campSnap = useRef<Snap<{ list: Campaign[]; cur: string | null }> | null>(null);
  const adsetSnap = useRef<Snap<AdSet[]> | null>(null);
  const adSnap = useRef<Snap<Ad[]> | null>(null);
  const insSnap = useRef<Snap<Record<string, Insights>> | null>(null);

  // "hace X min" se actualiza solo.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Lee del JSON la frescura, el aviso de copia desactualizada y lo deja en estado. */
  const applyMeta = useCallback((json: { syncedAt?: string; source?: string; stale?: boolean; errorInfo?: ErrorInfo; staleReason?: string }) => {
    setDataFresh({ syncedAt: json.syncedAt ?? null, source: json.source ?? null });
    setStale(!!json.stale);
    setStaleInfo(json.stale ? (json.errorInfo ?? { title: json.staleReason ?? "Mostrando datos guardados" }) : null);
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
      applyMeta(json);
      setCampaigns(prev => cursor ? [...prev, ...json.campaigns] : json.campaigns);
      setNextCursor(json.nextCursor);
      if (!cursor) campSnap.current = { data: { list: json.campaigns, cur: json.nextCursor }, key: accountId, ts: Date.now() };
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
      applyMeta(json);
      setAdsets(json.adsets);
      adsetSnap.current = { data: json.adsets, key: `adsets:${accountId}:${campaignId || "all"}`, ts: Date.now() };
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión y pulsa «Traer de Meta»." });
    } finally {
      setLoadingData(false);
    }
  }, [accountId, bmId, applyMeta]);

  const loadAds = useCallback(async (adsetId?: string, refresh = false) => {
    if (!accountId) return;
    setLoadingData(true); setError(null);
    const p = new URLSearchParams({ accountId });
    if (adsetId) p.set("adsetId", adsetId);
    if (bmId) p.set("bmId", bmId);
    if (refresh) p.set("refresh", "true");
    try {
      const res = await fetch(`/api/meta/ads?${p}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "Error al cargar anuncios" }); return; }
      applyMeta(json);
      setAds(json.ads);
      adSnap.current = { data: json.ads, key: `ads:${accountId}:${adsetId || "all"}`, ts: Date.now() };
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
      setInsFresh({ syncedAt: json.syncedAt ?? null, source: json.source ?? null });
      if (json.stale) toastApiError({ errorInfo: json.errorInfo, error: json.staleReason }, "Métricas desactualizadas");
      const idField = lvl === "campaign" ? "campaign_id" : lvl === "adset" ? "adset_id" : "ad_id";
      const map: Record<string, Insights> = {};
      for (const item of json.data ?? []) {
        if (item[idField]) map[item[idField]] = item;
      }
      setInsightsMap(map);
      insSnap.current = { data: map, key: `${lvl}:${accountId}:${date}`, ts: Date.now() };
    } catch (e) {
      console.error(`[insights] fetch error:`, e);
      toast.error("No se pudo conectar con el servidor para cargar las métricas");
    } finally {
      setLoadingInsights(false);
    }
  }, [accountId, bmId]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (accountId) { loadCampaigns(); loadInsights("campaign", datePreset); }
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

  function clearSelections() {
    setSelectedCampaignIds(new Set()); setSelectedAdsetIds(new Set()); setSelectedAdIds(new Set());
  }

  async function drillAdsets(campaign: Campaign) {
    setSelCampaign({ id: campaign.id, name: campaign.name });
    setSelAdset(null);
    setLevel("adset"); setNameFilter(""); setStatusFilter("ACTIVE");
    clearSelections();
    const dKey = `adsets:${accountId}:${campaign.id}`;
    const iKey = `adset:${accountId}:${datePreset}`;
    const dataOk = fresh(adsetSnap.current, dKey);
    const insOk = fresh(insSnap.current, iKey);
    if (dataOk) setAdsets(adsetSnap.current!.data); else setAdsets([]);
    if (insOk) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataOk) await loadAdsets(campaign.id);
    if (!insOk) loadInsights("adset", datePreset);
  }

  async function drillAds(adset: AdSet) {
    setSelAdset({ id: adset.id, name: adset.name });
    setLevel("ad"); setNameFilter(""); setStatusFilter("ACTIVE");
    clearSelections();
    const dKey = `ads:${accountId}:${adset.id}`;
    const iKey = `ad:${accountId}:${datePreset}`;
    const dataOk = fresh(adSnap.current, dKey);
    const insOk = fresh(insSnap.current, iKey);
    if (dataOk) setAds(adSnap.current!.data); else setAds([]);
    if (insOk) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataOk) await loadAds(adset.id);
    if (!insOk) loadInsights("ad", datePreset);
  }

  // Tabs siempre clickeables → nivel cuenta
  async function goToCampaigns() {
    setSelCampaign(null); setSelAdset(null);
    setLevel("campaign"); setNameFilter(""); setStatusFilter("ACTIVE");
    clearSelections();
    const dKey = accountId!;
    const iKey = `campaign:${accountId}:${datePreset}`;
    const dataOk = fresh(campSnap.current, dKey);
    const insOk = fresh(insSnap.current, iKey);
    if (dataOk) { setCampaigns(campSnap.current!.data.list); setNextCursor(campSnap.current!.data.cur); }
    else { setCampaigns([]); setNextCursor(null); }
    if (insOk) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataOk) await loadCampaigns();
    if (!insOk) loadInsights("campaign", datePreset);
  }

  async function goToAdsets() {
    setSelCampaign(null); setSelAdset(null);
    setLevel("adset"); setNameFilter(""); setStatusFilter("ACTIVE");
    clearSelections();
    const dKey = `adsets:${accountId}:all`;
    const iKey = `adset:${accountId}:${datePreset}`;
    const dataOk = fresh(adsetSnap.current, dKey);
    const insOk = fresh(insSnap.current, iKey);
    if (dataOk) setAdsets(adsetSnap.current!.data); else setAdsets([]);
    if (insOk) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataOk) await loadAdsets();
    if (!insOk) loadInsights("adset", datePreset);
  }

  async function goToAds() {
    setSelAdset(null);
    setLevel("ad"); setNameFilter(""); setStatusFilter("ACTIVE");
    clearSelections();
    const dKey = `ads:${accountId}:all`;
    const iKey = `ad:${accountId}:${datePreset}`;
    const dataOk = fresh(adSnap.current, dKey);
    const insOk = fresh(insSnap.current, iKey);
    if (dataOk) setAds(adSnap.current!.data); else setAds([]);
    if (insOk) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataOk) await loadAds();
    if (!insOk) loadInsights("ad", datePreset);
  }

  // «Traer de Meta»: estructura y métricas en vivo, sin copias guardadas.
  async function refreshFromMeta() {
    campSnap.current = null; adsetSnap.current = null; adSnap.current = null; insSnap.current = null;
    setInsightsMap({});
    const ins = loadInsights(level, datePreset, true);
    if (level === "campaign") await loadCampaigns(true);
    else if (level === "adset") await loadAdsets(selCampaign?.id, true);
    else await loadAds(selAdset?.id, true);
    await ins;
  }

  const tracker = useBatchTracker(() => { if (level === "campaign") void loadCampaigns(true); });

  // ── Status toggle ─────────────────────────────────────────────────────────

  function patchStatus(entityType: Level, ids: Set<string>, status: string) {
    if (entityType === "campaign") setCampaigns(p => p.map(c => ids.has(c.id) ? { ...c, status } : c));
    else if (entityType === "adset") setAdsets(p => p.map(a => ids.has(a.id) ? { ...a, status } : a));
    else setAds(p => p.map(a => ids.has(a.id) ? { ...a, status } : a));
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
      const r = await bulkStatus([...ids].map(id => ({ id, accountId, bmId })), entityType, status);
      patchStatus(entityType, new Set(r.ok), status);
      reportBulk(r, status);
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

  const visCampaigns = applySort(filterData(campaigns));
  const visAdsets = applySort(filterData(adsets));
  const visAds = applySort(filterData(ads));

  if (!accountId) {
    return <GlobalCampaignsView />;
  }

  // Selección del nivel actual (para la barra y la casilla de cabecera).
  const sel = level === "campaign" ? selectedCampaignIds : level === "adset" ? selectedAdsetIds : selectedAdIds;
  const setSel = level === "campaign" ? setSelectedCampaignIds : level === "adset" ? setSelectedAdsetIds : setSelectedAdIds;
  const visIds = (level === "campaign" ? visCampaigns : level === "adset" ? visAdsets : visAds).map(r => r.id);
  const allSel = visIds.length > 0 && visIds.every(id => sel.has(id));
  const someSel = visIds.some(id => sel.has(id));
  const toggleOne = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(visIds));

  // ── Tab labels ────────────────────────────────────────────────────────────

  const adsetTabLabel = level === "adset" && selCampaign
    ? `Ad Sets · ${selCampaign.name.length > 18 ? selCampaign.name.slice(0, 18) + "…" : selCampaign.name}`
    : "Ad Sets";
  const adTabLabel = level === "ad" && selAdset
    ? `Anuncios · ${selAdset.name.length > 18 ? selAdset.name.slice(0, 18) + "…" : selAdset.name}`
    : "Anuncios";

  const tabBtn = (id: Level, label: string, active: boolean, onClick: () => void) => (
    <button
      key={id}
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {label}
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
  const rowActions = (lvl: Level, id: string, extra?: React.ReactNode) => (
    <div className="-ml-1.5 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
      {extra}
      <a
        href={adsManagerUrl(lvl, accountId, id)} target="_blank" rel="noreferrer"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        title="Abrir en Ads Manager"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );

  const freshness: Freshness = insFresh.syncedAt && dataFresh.syncedAt
    ? (new Date(insFresh.syncedAt) < new Date(dataFresh.syncedAt) ? insFresh : dataFresh)
    : (dataFresh.syncedAt ? dataFresh : insFresh);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-0">

      {/* Cuenta actual */}
      <div className="flex items-center gap-2 pb-2 text-sm">
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <Select
          value={`act_${accountId}`}
          onValueChange={v => {
            const a = accountList.find(x => x.id === v);
            if (a) router.push(`/meta/campaigns?accountId=${a.id.replace("act_", "")}&bmId=${a.bmId}`);
          }}
        >
          <SelectTrigger className="h-7 min-w-44 max-w-72 text-sm font-semibold bg-card" aria-label="Cambiar de cuenta">
            <SelectValue>{accountName || "Cuenta"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {accountList.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}{a.currency && a.currency !== "USD" ? ` · ${a.currency}` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-xs">· {accountId}{currency !== "USD" ? ` · ${currency}` : ""}</span>
        <button className="ml-2 text-xs text-primary hover:underline" onClick={() => router.push("/meta/campaigns")}>
          Todas las cuentas
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b bg-card -mx-5 px-5">
        {tabBtn("campaign", "Campañas", level === "campaign", goToCampaigns)}
        {tabBtn("adset", adsetTabLabel, level === "adset", goToAdsets)}
        {tabBtn("ad", adTabLabel, level === "ad", goToAds)}

        <div className="ml-auto flex items-center gap-2 py-1">
          <TrendingUp className={`h-3.5 w-3.5 ${loadingInsights ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none">
              <SelectValue>{labelOf(DATE_PRESETS, datePreset)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <FreshnessBar freshness={freshness} now={now} loading={loadingData || loadingInsights} onRefresh={refreshFromMeta} everyMin={level === "campaign" ? 30 : 360} />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 pt-3 pb-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar..." className="pl-8 h-8 text-sm w-44 bg-card"
            value={nameFilter} onChange={e => setNameFilter(e.target.value)}
          />
        </div>

        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-card">
            <SelectValue>{labelOf(STATUS_OPTS, statusFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">
          {!loadingData && !error ? `${visIds.length} elementos` : null}
        </span>

        <Button
          variant="outline" size="sm" className="h-8 text-xs ml-1"
          onClick={openJobsDock}
        >
          <Briefcase className="h-3.5 w-3.5 mr-1" /> Trabajos
        </Button>
        <div className="ml-auto"><ColumnPicker state={columnState} /></div>
      </div>

      <BatchBanner batch={tracker.batch} onDismiss={tracker.dismiss} onOpenJobs={openJobsDock} />

      {/* Barra de acciones de la selección */}
      <SelectionBar
        count={sel.size}
        hidden={[...sel].filter(id => !visIds.includes(id)).length}
        noun={level === "campaign" ? "campaña" : level === "adset" ? "ad set" : "anuncio"}
        busy={bulkBusy}
        onDuplicate={
          level === "campaign" ? () => setDuplicateTargets(campaigns.filter(c => selectedCampaignIds.has(c.id)))
            : level === "adset" ? () => setShowDuplicateAdsetsModal(true)
              : () => setShowDuplicateAdsModal(true)
        }
        onStatus={s => bulkSetStatus(level, sel, s)}
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
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
        </div>
      ) : error && visIds.length === 0 ? null : (
        <div className="rounded-lg border bg-card shadow-sm overflow-x-auto">
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
                        {rowActions("campaign", c.id, (
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
                        {rowActions("adset", a.id, (
                          <>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar ad set" aria-label="Duplicar ad set"
                              onClick={() => { setSelectedAdsetIds(new Set([a.id])); setShowDuplicateAdsetsModal(true); }}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ))}
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_NAME}`}>
                        <p className="font-medium text-xs leading-tight whitespace-normal break-words line-clamp-2 group-hover:text-primary transition-colors" title={a.name}>{a.name}</p>
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
                        {rowActions("ad", ad.id, ad.creative_id ? (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Duplicar anuncio" aria-label="Duplicar anuncio"
                            onClick={() => { setSelectedAdIds(new Set([ad.id])); setShowDuplicateAdsModal(true); }}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        ) : null)}
                      </TableCell>
                      <TableCell className={`py-2 ${STICKY_NAME}`}>
                        <p className="font-medium text-xs leading-tight whitespace-normal break-words line-clamp-2" title={ad.name}>{ad.name}</p>
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
      )}

      {/* Load more */}
      {level === "campaign" && nextCursor && !loadingData && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={() => loadCampaigns(false, nextCursor!)} disabled={loadingMore}>
            {loadingMore && <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}

      {/* Modales */}
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
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>({ key: "spend", dir: "desc" });
  const [oldest, setOldest] = useState<string | null>(null);
  const [problems, setProblems] = useState<AcctProblem[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dupTargets, setDupTargets] = useState<GRow[] | null>(null);
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
  const visKeys = vis.map(keyOf);
  const allSel = visKeys.length > 0 && visKeys.every(k => selected.has(k));
  const someSel = visKeys.some(k => selected.has(k));
  const selRows = rows.filter(r => selected.has(keyOf(r)));
  const toggleOne = (k: string) => setSelected(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function bulk(status: EntityStatus) {
    setBulkBusy(true);
    try {
      const res = await bulkStatus(selRows.map(r => ({ id: r.camp.id, accountId: r.accId, bmId: r.bmId })), "campaign", status);
      const ok = new Set(res.ok);
      setRows(prev => prev.map(r => ok.has(r.camp.id) ? { ...r, camp: { ...r.camp, status } } : r));
      reportBulk(res, status);
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
          <SelectTrigger className="h-7 text-xs w-52 ml-1"><SelectValue placeholder="Ver una cuenta…">Ver una cuenta…</SelectValue></SelectTrigger>
          <SelectContent>
            {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <TrendingUp className={`h-3.5 w-3.5 ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none"><SelectValue>{labelOf(DATE_PRESETS, datePreset)}</SelectValue></SelectTrigger>
            <SelectContent>{DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
          </Select>
          <FreshnessBar
            freshness={{ syncedAt: oldest, source: refreshing ? "meta" : "db" }}
            now={now} loading={loading} onRefresh={() => run(true)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 pb-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Buscar campaña o cuenta..." className="pl-8 h-8 text-sm w-56 bg-card" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-card"><SelectValue>{labelOf(STATUS_OPTS, statusFilter)}</SelectValue></SelectTrigger>
          <SelectContent>{STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1">
          {loading ? `${refreshing ? "Trayendo de Meta" : "Cargando"} ${done}/${total} cuentas…` : `${vis.length} campañas · ${total} cuentas`}
        </span>
        {problems.length > 0 && (
          <button className="inline-flex items-center gap-1 text-xs text-warning hover:underline" onClick={() => setShowProblems(s => !s)}>
            <AlertTriangle className="h-3.5 w-3.5" /> {problems.length} aviso{problems.length > 1 ? "s" : ""} de cuentas
          </button>
        )}
        <Button variant="outline" size="sm" className="h-8 text-xs ml-auto" onClick={openJobsDock}>
          <Briefcase className="h-3.5 w-3.5 mr-1" /> Trabajos
        </Button>
        <ColumnPicker state={columnState} />
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
        count={selected.size} hidden={[...selected].filter(k => !visKeys.includes(k)).length} noun="campaña" busy={bulkBusy}
        onDuplicate={() => setDupTargets(selRows)}
        onStatus={bulk}
        onClear={() => setSelected(new Set())}
      />

      <div className="rounded-lg border bg-card shadow-sm overflow-x-auto">
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
                <TableRow key={k} className="group cursor-pointer hover:bg-muted" onClick={() => router.push(`/meta/campaigns?accountId=${r.accId}&bmId=${r.bmId}`)}>
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
