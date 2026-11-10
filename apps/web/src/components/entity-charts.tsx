"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, RefreshCw, Table2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorDetails, errorInfoOf, type ErrorInfo } from "@/components/error-details";

// Panel de gráficas de una campaña, ad set o anuncio: lo que un media buyer mira para
// monitorear (gasto vs ingresos, ganancia, ROI, CPA, CTR, CPC, CPM, frecuencia, embudo).
// Una medida por gráfica (nunca dos escalas en un eje), con la paleta validada del skill dataviz.

export interface ChartTarget {
  level: "campaign" | "adset" | "ad";
  id: string;
  name: string;
  accountId: string;
  bmId?: string;
  currency?: string;
}

type Action = { action_type: string; value: string };
interface DailyRow {
  date_start: string;
  spend?: string; impressions?: string; reach?: string; frequency?: string; clicks?: string;
  ctr?: string; cpc?: string; cpm?: string; inline_link_clicks?: string;
  actions?: Action[]; action_values?: Action[];
}

// Meta devuelve varios action_types que se solapan; se toma el primer tipo canónico (omni_* = deduplicado).
function pick(rows: Action[] | undefined, types: string[]): number {
  for (const t of types) {
    const hit = (rows ?? []).find(a => a.action_type === t);
    if (hit) return parseFloat(hit.value || "0");
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "purchase"];
const ADD_TO_CART = ["omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart", "add_to_cart"];
const CHECKOUT = ["omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "onsite_web_initiate_checkout", "initiate_checkout"];
const LANDING = ["landing_page_view", "omni_landing_page_view"];

interface Day {
  date: string; spend: number; revenue: number; profit: number; roi: number | null; roas: number | null;
  purchases: number; cpa: number | null; ctr: number | null; cpc: number | null; cpm: number | null;
  frequency: number | null; impressions: number; clicks: number; linkClicks: number;
  landing: number; atc: number; checkout: number;
}

function toDay(r: DailyRow): Day {
  const spend = parseFloat(r.spend || "0");
  const revenue = pick(r.action_values, PURCHASE);
  const purchases = pick(r.actions, PURCHASE);
  const impressions = parseFloat(r.impressions || "0");
  const clicks = parseFloat(r.clicks || "0");
  return {
    date: r.date_start, spend, revenue, profit: revenue - spend,
    roi: spend > 0 ? ((revenue - spend) / spend) * 100 : null,
    roas: spend > 0 ? revenue / spend : null,
    purchases, cpa: purchases > 0 && spend > 0 ? spend / purchases : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    frequency: r.frequency ? parseFloat(r.frequency) : null,
    impressions, clicks, linkClicks: parseFloat(r.inline_link_clicks || "0"),
    landing: pick(r.actions, LANDING), atc: pick(r.actions, ADD_TO_CART), checkout: pick(r.actions, CHECKOUT),
  };
}

const RANGES = [
  { value: "last_7d", label: "7 días" },
  { value: "last_14d", label: "14 días" },
  { value: "last_30d", label: "30 días" },
  { value: "last_month", label: "Mes anterior" },
];
const LEVEL_LABEL = { campaign: "Campaña", adset: "Ad set", ad: "Anuncio" } as const;

// ─── Formatos ────────────────────────────────────────────────────────────────

function makeMoney(currency: string) {
  return (n: number | null, compact = false) => {
    const x = n ?? 0;
    if (compact && Math.abs(x) >= 1000) return `${x < 0 ? "-" : ""}${currency === "USD" ? "$" : currency + " "}${(Math.abs(x) / 1000).toFixed(1)}K`;
    if (currency !== "USD") return `${currency} ${x.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
    return `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
}
const fmtPct = (n: number | null, d = 2) => (n == null ? "—" : `${n.toFixed(d)}%`);
const fmtInt = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("es-CO"));
const fmtNum = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));
const fmtDate = (ymd: string, long = false) => {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString("es-CO", long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
};

// ─── Gráfica base (SVG propio: línea o columnas) ─────────────────────────────

interface Series { key: string; label: string; color: string; values: Array<number | null> }

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function MiniChart({
  title, hint, dates, series, kind = "line", fmt, fmtAxis, baseline, reference, signed = false,
}: {
  title: string; hint?: string; dates: string[]; series: Series[]; kind?: "line" | "bar";
  fmt: (n: number | null) => string; fmtAxis?: (n: number) => string;
  /** Línea de referencia con nombre (p. ej. punto de equilibrio). */
  baseline?: { value: number; label: string };
  reference?: { value: number; label: string } | null;
  /** Columnas que cambian de color si son negativas (ganancia). */
  signed?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 150, padL = 44, padR = 8, padT = 10, padB = 22;
  const n = dates.length;
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
  const hasData = all.length > 0;
  const rawMax = Math.max(0, ...all, baseline?.value ?? 0, reference?.value ?? 0);
  const rawMin = Math.min(0, ...all, baseline?.value ?? 0);
  const max = niceMax(rawMax || 1);
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const x = (i: number) => padL + (n <= 1 ? (w - padL - padR) / 2 : (i * (w - padL - padR)) / (n - 1));
  const slot = (w - padL - padR) / Math.max(1, n);
  const xBar = (i: number) => padL + i * slot + slot / 2;
  const y = (v: number) => padT + ((max - v) / (max - min || 1)) * (H - padT - padB);
  const ticks = min < 0 ? [min, 0, max] : [0, max / 2, max];
  const xi = (i: number) => (kind === "bar" ? xBar(i) : x(i));
  const tickIdx = n <= 1 ? [0] : n <= 4 ? Array.from({ length: n }, (_, i) => i) : [0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1];
  const barW = Math.max(3, Math.min(18, slot * 0.62));

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(px - xi(i)); if (d < bd) { bd = d; best = i; } }
    setHover(best);
  };

  const linePath = (vals: Array<number | null>) => {
    let d = ""; let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true;
    });
    return d;
  };

  const multi = series.length > 1;
  const tipLeft = hover != null ? Math.min(Math.max(xi(hover) + 10, 4), w - 150) : 0;

  return (
    <section className="rounded-lg border bg-card p-3" aria-label={title}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
        {multi && (
          <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            {series.map(s => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className="h-0.5 w-3 rounded" style={{ background: s.color }} />{s.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div ref={wrap} className="relative">
        {!hasData ? (
          <div className="flex h-[150px] items-center justify-center text-xs text-muted-foreground">Sin datos en este periodo</div>
        ) : (
          <>
            <svg width={w} height={H} onPointerMove={move} onPointerLeave={() => setHover(null)} className="touch-none select-none">
              {ticks.map((t, i) => (
                <g key={i}>
                  <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
                  <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--viz-muted)">{(fmtAxis ?? fmt)(t)}</text>
                </g>
              ))}
              <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
              {baseline && baseline.value !== 0 && (
                <line x1={padL} x2={w - padR} y1={y(baseline.value)} y2={y(baseline.value)} stroke="var(--viz-muted)" strokeWidth={1} strokeDasharray="4 3" />
              )}
              {reference && (
                <g>
                  <line x1={padL} x2={w - padR} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--viz-muted)" strokeWidth={1} strokeDasharray="4 3" />
                  <text x={w - padR} y={y(reference.value) - 4} textAnchor="end" fontSize={10} fill="var(--viz-muted)">{reference.label}</text>
                </g>
              )}
              {tickIdx.map(i => (
                <text key={i} x={Math.min(Math.max(xi(i), padL + 12), w - padR - 14)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--viz-muted)">{fmtDate(dates[i])}</text>
              ))}

              {kind === "bar"
                ? series[0].values.map((v, i) => v == null ? null : (
                  <rect key={i}
                    x={xBar(i) - barW / 2} width={barW}
                    y={v >= 0 ? y(v) : y(0)} height={Math.max(1, Math.abs(y(v) - y(0)))}
                    rx={2}
                    fill={signed && v < 0 ? "var(--viz-neg)" : series[0].color}
                    opacity={hover == null || hover === i ? 1 : 0.55}
                  />
                ))
                : series.map(s => (
                  <g key={s.key}>
                    <path d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    {n <= 31 && s.values.map((v, i) => v == null ? null : (
                      <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 2.5} fill={s.color} stroke="var(--viz-surface)" strokeWidth={hover === i ? 2 : 1} />
                    ))}
                  </g>
                ))}

              {hover != null && <line x1={xi(hover)} x2={xi(hover)} y1={padT} y2={H - padB} stroke="var(--viz-axis)" strokeWidth={1} />}
            </svg>
            {hover != null && (
              <div className="pointer-events-none absolute top-0 z-10 w-[142px] rounded-md border bg-popover px-2 py-1.5 text-[11px] shadow-md" style={{ left: tipLeft }}>
                <div className="mb-0.5 font-medium">{fmtDate(dates[hover], true)}</div>
                {series.map(s => (
                  <div key={s.key} className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <span className="h-2 w-2 rounded-sm" style={{ background: signed && (s.values[hover] ?? 0) < 0 ? "var(--viz-neg)" : s.color }} />{s.label}
                    </span>
                    <span className="tabular-nums">{fmt(s.values[hover])}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ─── KPI ─────────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : ""}`}>{value}</div>
    </div>
  );
}

// ─── Embudo: cada paso, como % del anterior ─────────────────────────────────

function Funnel({ days }: { days: Day[] }) {
  const sum = (f: (d: Day) => number) => days.reduce((n, d) => n + f(d), 0);
  const stages = [
    { label: "Impresiones", v: sum(d => d.impressions) },
    { label: "Clics en el enlace", v: sum(d => d.linkClicks) },
    { label: "Vistas de la página", v: sum(d => d.landing) },
    { label: "Agregar al carrito", v: sum(d => d.atc) },
    { label: "Inicio de compra", v: sum(d => d.checkout) },
    { label: "Compras", v: sum(d => d.purchases) },
  ].filter(s => s.v > 0);
  if (stages.length < 2) {
    return (
      <section className="rounded-lg border bg-card p-3 md:col-span-2">
        <h3 className="text-xs font-semibold">Embudo</h3>
        <p className="py-6 text-center text-xs text-muted-foreground">Sin eventos suficientes para armar el embudo en este periodo.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border bg-card p-3 md:col-span-2" aria-label="Embudo de conversión">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold">Embudo</h3>
        <span className="text-[11px] text-muted-foreground">cada barra = % que pasa del paso anterior</span>
      </div>
      <ul className="space-y-1.5">
        {stages.map((s, i) => {
          const rate = i === 0 ? 100 : (s.v / stages[i - 1].v) * 100;
          return (
            <li key={s.label} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{s.label}</span>
              <span className="h-3 overflow-hidden rounded bg-muted">
                <span className="block h-full rounded" style={{ width: `${Math.min(100, Math.max(1.5, rate))}%`, background: "var(--viz-s1)" }} />
              </span>
              <span className="w-32 text-right tabular-nums">
                {fmtInt(s.v)}{i > 0 ? <span className="text-muted-foreground"> · {rate < 10 ? rate.toFixed(2) : rate.toFixed(1)}%</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function EntityChartsSheet({ target, datePreset, onClose }: {
  target: ChartTarget | null; datePreset: string; onClose: () => void;
}) {
  const initial = RANGES.some(r => r.value === datePreset) ? datePreset : "last_7d";
  const [range, setRange] = useState(initial);
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [table, setTable] = useState(false);
  const reqId = useRef(0);

  // Al abrir otra entidad, empieza con el periodo que se ve en la pantalla.
  useEffect(() => { if (target) { setRange(RANGES.some(r => r.value === datePreset) ? datePreset : "last_7d"); setTable(false); } }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (refresh = false) => {
    if (!target) return;
    const id = ++reqId.current;
    setLoading(true); setError(null);
    const p = new URLSearchParams({ entityId: target.id, datePreset: range });
    if (target.bmId) p.set("bmId", target.bmId);
    if (refresh) p.set("refresh", "true");
    try {
      const res = await fetch(`/api/meta/insights-daily?${p}`);
      const json = await res.json().catch(() => ({}));
      if (id !== reqId.current) return;
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "No se pudieron cargar las métricas" }); setRows(null); return; }
      setRows(json.rows ?? []);
    } catch {
      if (id === reqId.current) setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión y vuelve a intentarlo." });
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [target, range]);

  useEffect(() => { setRows(null); void load(); }, [load]);

  const currency = target?.currency ?? "USD";
  const money = useMemo(() => makeMoney(currency), [currency]);
  const days = useMemo(() => (rows ?? []).map(toDay).sort((a, b) => a.date.localeCompare(b.date)), [rows]);
  const dates = days.map(d => d.date);

  const t = useMemo(() => {
    const sum = (f: (d: Day) => number) => days.reduce((n, d) => n + f(d), 0);
    const spend = sum(d => d.spend), revenue = sum(d => d.revenue), purchases = sum(d => d.purchases);
    const impressions = sum(d => d.impressions), clicks = sum(d => d.clicks);
    return {
      spend, revenue, profit: revenue - spend, purchases,
      roi: spend > 0 ? ((revenue - spend) / spend) * 100 : null,
      roas: spend > 0 ? revenue / spend : null,
      cpa: purchases > 0 ? spend / purchases : null,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpc: clicks > 0 ? spend / clicks : null,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    };
  }, [days]);

  const S1 = "var(--viz-s1)", S2 = "var(--viz-s2)";
  const col = <K extends keyof Day>(k: K) => days.map(d => d[k] as number | null);

  return (
    <Sheet open={!!target} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-3xl overflow-y-auto gap-3 p-0"
      >
        <style>{`
          .viz-scope{--viz-s1:#2a78d6;--viz-s2:#eb6834;--viz-neg:#e34948;--viz-grid:#e1e0d9;--viz-axis:#c3c2b7;--viz-muted:#898781;--viz-surface:#fcfcfb}
          .dark .viz-scope{--viz-s1:#3987e5;--viz-s2:#d95926;--viz-neg:#e66767;--viz-grid:#2c2c2a;--viz-axis:#383835;--viz-muted:#898781;--viz-surface:#1a1a19}
        `}</style>
        <div className="viz-scope flex flex-col gap-3 pb-6">
          <SheetHeader className="space-y-1 px-4 pt-4 pr-12">
            <SheetDescription className="text-[11px] uppercase tracking-wide">{target ? LEVEL_LABEL[target.level] : ""}</SheetDescription>
            <SheetTitle className="break-words text-base leading-snug">{target?.name}</SheetTitle>
          </SheetHeader>

          <div className="flex flex-wrap items-center gap-2 px-4">
            <div role="tablist" aria-label="Periodo" className="inline-flex rounded-md border bg-card p-0.5">
              {RANGES.map(r => (
                <button key={r.value} role="tab" aria-selected={range === r.value} onClick={() => setRange(r.value)}
                  className={`rounded px-2.5 py-1 text-xs ${range === r.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {r.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => load(true)} disabled={loading}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setTable(v => !v)} aria-pressed={table}>
              <Table2 className="mr-1 h-3.5 w-3.5" />{table ? "Ver gráficas" : "Ver tabla"}
            </Button>
          </div>

          {error && (
            <div className="mx-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <ErrorDetails info={error} fallback="No se pudieron cargar las métricas" />
            </div>
          )}

          {loading && !rows ? (
            <div className="grid gap-2 px-4 md:grid-cols-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-lg" />)}</div>
          ) : rows && (
            <>
              <div className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-3 md:grid-cols-5">
                <Kpi label="Gasto" value={money(t.spend)} />
                <Kpi label="Ingresos" value={money(t.revenue)} />
                <Kpi label="Ganancia" value={money(t.profit)} tone={t.profit > 0 ? "good" : t.profit < 0 ? "bad" : undefined} />
                <Kpi label="ROI" value={fmtPct(t.roi, 1)} tone={t.roi == null ? undefined : t.roi > 0 ? "good" : t.roi < 0 ? "bad" : undefined} />
                <Kpi label="ROAS" value={t.roas == null ? "—" : `${t.roas.toFixed(2)}x`} />
                <Kpi label="Compras" value={fmtInt(t.purchases)} />
                <Kpi label="CPA" value={t.cpa == null ? "—" : money(t.cpa)} />
                <Kpi label="CTR" value={fmtPct(t.ctr)} />
                <Kpi label="CPC" value={t.cpc == null ? "—" : money(t.cpc)} />
                <Kpi label="CPM" value={t.cpm == null ? "—" : money(t.cpm)} />
              </div>

              {days.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">Meta no devolvió datos de este periodo.</p>
              ) : table ? (
                <div className="mx-4 overflow-x-auto rounded-lg border bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>{["Día", "Gasto", "Ingresos", "Ganancia", "ROI", "Compras", "CPA", "CTR", "CPC", "CPM"].map(h => <th key={h} className="px-2 py-1.5 text-right font-medium first:text-left">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {[...days].reverse().map(d => (
                        <tr key={d.date} className="border-t tabular-nums">
                          <td className="px-2 py-1.5 text-left">{fmtDate(d.date, true)}</td>
                          <td className="px-2 py-1.5 text-right">{money(d.spend)}</td>
                          <td className="px-2 py-1.5 text-right">{money(d.revenue)}</td>
                          <td className={`px-2 py-1.5 text-right ${d.profit > 0 ? "text-success" : d.profit < 0 ? "text-danger" : ""}`}>{money(d.profit)}</td>
                          <td className="px-2 py-1.5 text-right">{fmtPct(d.roi, 1)}</td>
                          <td className="px-2 py-1.5 text-right">{fmtInt(d.purchases)}</td>
                          <td className="px-2 py-1.5 text-right">{d.cpa == null ? "—" : money(d.cpa)}</td>
                          <td className="px-2 py-1.5 text-right">{fmtPct(d.ctr)}</td>
                          <td className="px-2 py-1.5 text-right">{d.cpc == null ? "—" : money(d.cpc)}</td>
                          <td className="px-2 py-1.5 text-right">{d.cpm == null ? "—" : money(d.cpm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="grid gap-2 px-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <MiniChart title="Gasto e ingresos" hint="por día" dates={dates} fmt={v => money(v)} fmtAxis={v => money(v, true)}
                      series={[{ key: "rev", label: "Ingresos", color: S1, values: col("revenue") }, { key: "spend", label: "Gasto", color: S2, values: col("spend") }]} />
                  </div>
                  <MiniChart title="Ganancia" hint="ingresos − gasto" kind="bar" signed dates={dates} fmt={v => money(v)} fmtAxis={v => money(v, true)}
                    series={[{ key: "profit", label: "Ganancia", color: S1, values: col("profit") }]} />
                  <MiniChart title="ROI" hint="0% = punto de equilibrio" dates={dates} fmt={v => fmtPct(v, 1)} fmtAxis={v => `${Math.round(v)}%`}
                    baseline={{ value: 0, label: "Equilibrio" }}
                    series={[{ key: "roi", label: "ROI", color: S1, values: col("roi") }]} />
                  <MiniChart title="Compras" kind="bar" dates={dates} fmt={v => fmtInt(v)} fmtAxis={v => String(Math.round(v))}
                    series={[{ key: "p", label: "Compras", color: S1, values: col("purchases") }]} />
                  <MiniChart title="CPA" hint="costo por compra" dates={dates} fmt={v => (v == null ? "—" : money(v))} fmtAxis={v => money(v, true)}
                    reference={t.cpa == null ? null : { value: t.cpa, label: `Prom. ${money(t.cpa)}` }}
                    series={[{ key: "cpa", label: "CPA", color: S1, values: col("cpa") }]} />
                  <MiniChart title="CTR" hint="clics / impresiones" dates={dates} fmt={v => fmtPct(v)} fmtAxis={v => `${v.toFixed(1)}%`}
                    series={[{ key: "ctr", label: "CTR", color: S1, values: col("ctr") }]} />
                  <MiniChart title="CPC" hint="costo por clic" dates={dates} fmt={v => (v == null ? "—" : money(v))} fmtAxis={v => money(v, true)}
                    series={[{ key: "cpc", label: "CPC", color: S1, values: col("cpc") }]} />
                  <MiniChart title="CPM" hint="costo por mil impresiones" dates={dates} fmt={v => (v == null ? "—" : money(v))} fmtAxis={v => money(v, true)}
                    series={[{ key: "cpm", label: "CPM", color: S1, values: col("cpm") }]} />
                  <MiniChart title="Frecuencia" hint="veces que cada persona vio el anuncio" dates={dates} fmt={v => fmtNum(v)} fmtAxis={v => v.toFixed(1)}
                    series={[{ key: "f", label: "Frecuencia", color: S1, values: col("frequency") }]} />
                  <Funnel days={days} />
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
