"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, RefreshCw, TrendingUp } from "lucide-react";
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
  spend: number;
  revenue: number;
  sales: number;
  days: number;
}
interface Result {
  rows: Row[];
  totals: { spend: number; revenue: number; sales: number };
  series: Array<{ date: string; spend: number; revenue: number }>;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/spend?from=${f}&to=${t}`);
      const json = await res.json();
      if (!res.ok) { setData({ rows: [], totals: { spend: 0, revenue: 0, sales: 0 }, series: [] }); return; }
      setData(json as Result);
    } catch {
      setData({ rows: [], totals: { spend: 0, revenue: 0, sales: 0 }, series: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  const activeRange = ranges.find((r) => r.from === from && r.to === to)?.label;
  const maxSpend = Math.max(1, ...(data?.series ?? []).map((s) => s.spend));
  const totProfit = (data?.totals.revenue ?? 0) - (data?.totals.spend ?? 0);
  const totRoi = data && data.totals.spend > 0 ? (totProfit / data.totals.spend) * 100 : null;

  const Card = ({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) => (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tone === "pos" ? "text-green-600" : tone === "neg" ? "text-red-600" : ""}`}>{value}</div>
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
        <TrendingUp className={`h-3.5 w-3.5 ml-1 ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
      </div>

      {/* Calendario + rangos rápidos */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Desde</label>
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 w-40 bg-white" />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Hasta</label>
          <Input type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 w-40 bg-white" />
        </div>
        <Button variant="ghost" size="sm" className="h-9 px-2" onClick={() => load(from, to)} disabled={loading} title="Recargar">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <div className="flex items-center gap-1 flex-wrap ml-auto">
          {ranges.map((r) => (
            <Button
              key={r.label}
              variant={activeRange === r.label ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => { setFrom(r.from); setTo(r.to); }}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Totales */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card label="Gasto" value={fmtMoney(data?.totals.spend ?? 0)} />
        <Card label="Revenue" value={fmtMoney(data?.totals.revenue ?? 0)} />
        <Card label="Profit" value={fmtMoney(totProfit)} tone={totProfit > 0 ? "pos" : totProfit < 0 ? "neg" : undefined} />
        <Card label="ROI" value={fmtPct(totRoi)} tone={(totRoi ?? 0) > 0 ? "pos" : (totRoi ?? 0) < 0 ? "neg" : undefined} />
      </div>

      {/* Mini-gráfica diaria */}
      {!loading && (data?.series.length ?? 0) > 0 && (
        <div className="rounded-lg border bg-white p-3">
          <div className="text-[11px] text-muted-foreground mb-2">Gasto por día</div>
          <div className="flex items-end gap-[2px] h-24">
            {data!.series.map((s) => (
              <div
                key={s.date}
                className="flex-1 bg-blue-400/70 hover:bg-blue-500 rounded-t"
                style={{ height: `${Math.max(2, (s.spend / maxSpend) * 100)}%` }}
                title={`${s.date}: ${fmtMoney(s.spend)}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Tabla por cuenta */}
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">CUENTA</TableHead>
              <TableHead className="text-right">GASTO</TableHead>
              <TableHead className="text-right">REVENUE</TableHead>
              <TableHead className="text-right">PROFIT</TableHead>
              <TableHead className="text-right">VENTAS</TableHead>
              <TableHead className="text-right">DÍAS CON GASTO</TableHead>
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
              return (
                <TableRow key={r.accountId}>
                  <TableCell className="py-2"><span className="text-xs font-medium line-clamp-1">{r.name}</span></TableCell>
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
    </div>
  );
}
