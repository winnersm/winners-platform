"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, RefreshCw, TrendingUp, History, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { fmtMoney, fmtInt, fmtPct } from "@/lib/metrics";

interface Row {
  accountId: string;
  name: string;
  bmId: string | null;
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
  days: number;
  removedFromBm: boolean;
}
interface DayRow {
  date: string;
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
  accounts: number;
}
interface CurrencyTotal {
  currency: string | null;
  spend: number;
  revenue: number;
  sales: number;
}
interface Result {
  rows: Row[];
  totals: CurrencyTotal[];
  daily: DayRow[];
  lastSync?: string | null;
}

function agoLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "hace segundos";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Todos los días del rango (inclusive), para que la gráfica muestre también los días sin gasto.
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (d <= end && out.length < 1200) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function quickRanges(): { label: string; from: string; to: string }[] {
  const today = new Date();
  const t = ymd(today);
  const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };
  const firstOfMonth = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  const firstLastMonth = ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  const lastLastMonth = ymd(new Date(today.getFullYear(), today.getMonth(), 0));
  const firstOfYear = ymd(new Date(today.getFullYear(), 0, 1));
  return [
    { label: "Hoy", from: t, to: t },
    { label: "7 días", from: daysAgo(6), to: t },
    { label: "30 días", from: daysAgo(29), to: t },
    { label: "90 días", from: daysAgo(89), to: t },
    { label: "Este mes", from: firstOfMonth, to: t },
    { label: "Mes pasado", from: firstLastMonth, to: lastLastMonth },
    { label: "Este año", from: firstOfYear, to: t },
  ];
}

export default function SpendView() {
  const ranges = useMemo(quickRanges, []);
  const [from, setFrom] = useState(ranges[2].from); // 30 días por defecto
  const [to, setTo] = useState(ranges[2].to);
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [mode, setMode] = useState<"accounts" | "days">("accounts");
  const [chartCurrency, setChartCurrency] = useState<string | null>(null);
  // Rango desde el que se entró a un día, para poder volver.
  const [prevRange, setPrevRange] = useState<{ from: string; to: string } | null>(null);

  const openDay = (date: string) => {
    if (from !== to) setPrevRange({ from, to });
    setFrom(date);
    setTo(date);
    setMode("accounts");
  };

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/spend?from=${f}&to=${t}`);
      const json = await res.json();
      if (!res.ok) { setData({ rows: [], totals: [], daily: [] }); return; }
      setData(json as Result);
    } catch {
      setData({ rows: [], totals: [], daily: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  // Actualiza los últimos días a demanda (normalmente lo hace el sync de Rendimiento cada hora).
  const doSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/spend/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "No se pudo sincronizar"); return; }
      if (json.failed?.length) toast.warning(`Actualizado: ${json.accounts} cuentas · ${json.days} días. Sin datos de ${json.failed.length}: ${json.failed.slice(0, 3).join(", ")}${json.failed.length > 3 ? "…" : ""}`);
      else toast.success(`Actualizado: ${json.accounts} cuentas · ${json.days} días`);
      await load(from, to);
    } catch { toast.error("Error de red al sincronizar"); }
    finally { setSyncing(false); }
  }, [from, to, load]);

  // Siembra hacia atrás. Lento y con muchas llamadas: se confirma antes.
  const doBackfill = useCallback(async () => {
    if (!confirm("Traer el histórico de los últimos 12 meses desde Meta. Tarda varios minutos y hace muchas llamadas. ¿Continuar?")) return;
    setBackfilling(true);
    try {
      const res = await fetch("/api/spend/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: 12 }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "No se pudo traer el histórico"); return; }
      toast.success(`Histórico de ${json.months} meses: ${json.accounts} cuentas · ${json.days} días`);
      await load(from, to);
    } catch { toast.error("Error de red en el histórico"); }
    finally { setBackfilling(false); }
  }, [from, to, load]);

  const activeRange = ranges.find((r) => r.from === from && r.to === to)?.label;
  const totByC = data?.totals ?? [];
  const daily = useMemo(() => data?.daily ?? [], [data]);
  // La gráfica muestra una sola moneda (por defecto la de mayor gasto).
  const currencies = totByC.map((t) => t.currency);
  const mainCurrency = [...totByC].sort((a, b) => b.spend - a.spend)[0]?.currency ?? null;
  const chartCur = chartCurrency !== null && currencies.includes(chartCurrency) ? chartCurrency : mainCurrency;
  const chartSeries = useMemo(() => {
    const byDate = new Map(daily.filter((d) => d.currency === chartCur).map((d) => [d.date, d.spend]));
    return daysBetween(from, to).map((date) => ({ date, spend: byDate.get(date) ?? 0 }));
  }, [daily, chartCur, from, to]);
  const maxSpend = Math.max(1, ...chartSeries.map((s) => s.spend));
  const daysDesc = useMemo(() => [...daily].sort((a, b) => b.date.localeCompare(a.date) || (a.currency ?? "").localeCompare(b.currency ?? "")), [daily]);
  const isSingleDay = from === to;

  const Card = ({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) => (
    <div className="min-w-0 rounded-xl border bg-white p-4 max-md:p-3">
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`truncate text-xl font-bold mt-1 tabular-nums max-md:text-lg ${tone === "pos" ? "text-green-600" : tone === "neg" ? "text-red-600" : ""}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarDays className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Gasto histórico</h1>
        <span className="text-sm text-muted-foreground">
          {loading ? "Cargando…" : `${data?.rows.length ?? 0} cuentas · ${from} → ${to}`}
        </span>
        {!loading && data?.lastSync && (
          <span className="text-[11px] text-muted-foreground/70">· actualizado {agoLabel(data.lastSync)}</span>
        )}
        <TrendingUp className={`h-3.5 w-3.5 ml-1 max-md:hidden ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
        <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs max-md:h-10 max-md:flex-1" onClick={doBackfill} disabled={backfilling || syncing} title="Trae el histórico de los últimos 12 meses desde Meta (lento)">
            <History className={`h-3.5 w-3.5 mr-1.5 ${backfilling ? "animate-spin" : ""}`} />
            {backfilling ? "Trayendo histórico…" : "Traer histórico"}
          </Button>
          <Button size="sm" className="h-8 px-2.5 text-xs max-md:h-10 max-md:flex-1" onClick={doSync} disabled={syncing || backfilling} title="Actualiza los últimos días desde Meta">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Sincronizando…" : <>Sincronizar<span className="max-md:hidden"> con Meta</span></>}
          </Button>
        </div>
      </div>

      {/* Calendario + rangos rápidos */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1 max-md:flex-1">
          <label className="text-[11px] text-muted-foreground">Desde</label>
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 w-40 bg-white max-md:h-10 max-md:w-full" />
        </div>
        <div className="space-y-1 max-md:flex-1">
          <label className="text-[11px] text-muted-foreground">Hasta</label>
          <Input type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 w-40 bg-white max-md:h-10 max-md:w-full" />
        </div>
        {isSingleDay && prevRange && (
          <Button variant="outline" size="sm" className="h-9 px-2.5 text-xs" onClick={() => { setFrom(prevRange.from); setTo(prevRange.to); setPrevRange(null); setMode("days"); }}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Volver a {prevRange.from} → {prevRange.to}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-9 px-2" onClick={() => load(from, to)} disabled={loading} title="Recargar">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <div className="flex items-center gap-1 flex-wrap ml-auto max-md:ml-0 max-md:w-full">
          {ranges.map((r) => (
            <Button
              key={r.label}
              variant={activeRange === r.label ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => { setFrom(r.from); setTo(r.to); setPrevRange(null); }}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Totales por moneda */}
      {totByC.length === 0 ? (
        <div className="rounded-xl border bg-white p-4 text-center text-sm text-muted-foreground">
          Sin datos en este rango
        </div>
      ) : (
        <div className="space-y-4">
          {totByC.map((tot) => {
            const profit = tot.revenue - tot.spend;
            const roi = tot.spend > 0 ? (profit / tot.spend) * 100 : null;
            const curr = tot.currency ? ` ${tot.currency}` : "";
            return (
              <div key={tot.currency ?? "null"} className="space-y-1">
                {totByC.length > 1 && (
                  <div className="text-xs font-medium text-muted-foreground ml-0.5">{tot.currency ?? "SIN MONEDA"}</div>
                )}
                <div className="grid gap-3 grid-cols-2 md:grid-cols-4 max-md:gap-2">
                  <Card label={`Gasto${curr}`} value={fmtMoney(tot.spend)} />
                  <Card label={`Revenue${curr}`} value={fmtMoney(tot.revenue)} />
                  <Card label={`Profit${curr}`} value={fmtMoney(profit)} tone={profit > 0 ? "pos" : profit < 0 ? "neg" : undefined} />
                  <Card label="ROI" value={fmtPct(roi)} tone={(roi ?? 0) > 0 ? "pos" : (roi ?? 0) < 0 ? "neg" : undefined} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Gráfica diaria: clic en una barra abre ese día */}
      {!loading && !isSingleDay && chartSeries.length > 0 && (
        <div className="rounded-lg border bg-white p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-[11px] text-muted-foreground">Gasto por día{chartCur ? ` (${chartCur})` : ""} · clic en un día para ver sus cuentas</div>
            {currencies.length > 1 && (
              <div className="ml-auto flex gap-1">
                {currencies.map((c) => (
                  <Button key={c ?? "null"} size="sm" variant={c === chartCur ? "secondary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => setChartCurrency(c)}>
                    {c ?? "SIN MONEDA"}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-end gap-[2px] h-24">
            {chartSeries.map((s) => (
              <button
                key={s.date}
                type="button"
                onClick={() => openDay(s.date)}
                className={`flex-1 rounded-t ${s.spend > 0 ? "bg-blue-400/70 hover:bg-blue-600" : "bg-muted hover:bg-muted-foreground/30"}`}
                style={{ height: `${s.spend > 0 ? Math.max(3, (s.spend / maxSpend) * 100) : 2}%` }}
                title={`${dayLabel(s.date)}: ${fmtMoney(s.spend)}`}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{from}</span><span>{to}</span>
          </div>
        </div>
      )}

      {/* Selector de vista */}
      {!isSingleDay && (
        <div className="flex gap-1">
          <Button size="sm" variant={mode === "accounts" ? "secondary" : "ghost"} className="h-8 text-xs" onClick={() => setMode("accounts")}>Por cuenta</Button>
          <Button size="sm" variant={mode === "days" ? "secondary" : "ghost"} className="h-8 text-xs" onClick={() => setMode("days")}>Por día</Button>
        </div>
      )}
      {isSingleDay && (
        <div className="text-sm font-medium capitalize">{dayLabel(from)}</div>
      )}

      {/* Tabla por día */}
      {mode === "days" && !isSingleDay && (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">DÍA</TableHead>
                <TableHead className="text-right">GASTO</TableHead>
                <TableHead className="text-right">REVENUE</TableHead>
                <TableHead className="text-right">PROFIT</TableHead>
                <TableHead className="text-right">VENTAS</TableHead>
                <TableHead className="text-right">CUENTAS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={6} className="py-2"><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : daysDesc.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground text-sm">Sin gasto registrado en este rango</TableCell></TableRow>
              ) : daysDesc.map((d) => {
                const profit = d.revenue - d.spend;
                return (
                  <TableRow key={`${d.date}-${d.currency}`} className="cursor-pointer hover:bg-muted/50" onClick={() => openDay(d.date)}>
                    <TableCell className="py-2 text-xs font-medium capitalize">
                      {dayLabel(d.date)}{currencies.length > 1 && d.currency ? <span className="text-muted-foreground"> ({d.currency})</span> : null}
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(d.spend)}</TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(d.revenue)}</TableCell>
                    <TableCell className={`py-2 text-right text-xs tabular-nums font-medium ${profit > 0 ? "text-green-600" : profit < 0 ? "text-red-600" : ""}`}>{fmtMoney(profit)}</TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">{fmtInt(d.sales)}</TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">{d.accounts}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Tabla por cuenta */}
      {(mode === "accounts" || isSingleDay) && (
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px] max-md:sticky max-md:left-0 max-md:z-10 max-md:min-w-[150px] max-md:bg-card">CUENTA</TableHead>
              <TableHead className="text-right">GASTO</TableHead>
              <TableHead className="text-right">REVENUE</TableHead>
              <TableHead className="text-right">PROFIT</TableHead>
              <TableHead className="text-right">VENTAS</TableHead>
              <TableHead className="text-right">DÍAS CON DATOS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6} className="py-2"><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              ))
            ) : (data?.rows.length ?? 0) === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground text-sm">Sin gasto registrado en este rango</TableCell></TableRow>
            ) : data!.rows.map((r) => {
              const profit = r.revenue - r.spend;
              const currLabel = r.currency ? ` (${r.currency})` : "";
              return (
                <TableRow key={r.accountId}>
                  <TableCell className="py-2 max-md:sticky max-md:left-0 max-md:z-10 max-md:bg-card"><span className="text-xs font-medium line-clamp-2">{r.name}{currLabel}</span>
                    {r.removedFromBm && (
                      <span className="mt-0.5 inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700" title="Meta ya no devuelve esta cuenta en ningún BM; se conserva su histórico">Eliminada del BM</span>
                    )}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(r.spend)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(r.revenue)}</TableCell>
                  <TableCell className={`py-2 text-right text-xs tabular-nums font-medium ${profit > 0 ? "text-green-600" : profit < 0 ? "text-red-600" : ""}`}>{fmtMoney(profit)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtInt(r.sales)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">{r.days}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      )}
    </div>
  );
}
