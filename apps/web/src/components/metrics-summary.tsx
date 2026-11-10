"use client";

import { useMemo, useState } from "react";
import {
  DollarSign, ArrowUpRight, ArrowDownRight, Percent, ShoppingCart, Target, ChevronDown, type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { calcMetrics, fmtMoney, fmtInt, fmtPct, type Insights } from "@/lib/metrics";

// Resumen superior de Campañas: las mismas tarjetas que Rendimiento (gasto, revenue, profit,
// ROI, ventas, CPA), pero calculadas con las campañas (o ad sets / anuncios) de la vista, y
// separadas por moneda. En «Todas las cuentas» añade el desglose por cuenta publicitaria.

export interface SummaryItem {
  ins: Insights | undefined;
  currency: string;
  /** Cuenta publicitaria a la que pertenece (para el desglose). */
  account?: { id: string; name: string };
}

interface Tot { spend: number; revenue: number; sales: number }
const add = (t: Tot, i: SummaryItem): Tot => {
  const m = calcMetrics(i.ins);
  return m ? { spend: t.spend + m.spend, revenue: t.revenue + m.revenue, sales: t.sales + m.sales } : t;
};
const EMPTY: Tot = { spend: 0, revenue: 0, sales: 0 };

function StatCard({ label, value, tone, icon: Icon, accent, blob }: {
  label: string; value: string; tone?: "pos" | "neg"; icon: LucideIcon; accent: string; blob: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/20 bg-white/60 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-white/[0.06] max-md:p-3">
      <div className={`absolute -top-4 -right-4 h-20 w-20 rounded-full ${blob} opacity-30 blur-2xl`} style={{ animation: "blob-drift 8s ease-in-out infinite" }} />
      <div className={`absolute -bottom-6 -left-6 h-16 w-16 rounded-full ${blob} opacity-20 blur-2xl`} style={{ animation: "blob-drift-2 10s ease-in-out infinite" }} />
      <div className="relative z-10">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${accent} shadow-sm`}>
            <Icon className="h-3.5 w-3.5 text-white" />
          </div>
        </div>
        <div className={`text-xl font-bold max-md:text-lg ${tone === "pos" ? "text-green-600 dark:text-green-400" : tone === "neg" ? "text-red-600 dark:text-red-400" : ""}`}>{value}</div>
      </div>
    </div>
  );
}

function Cards({ t, currency, many }: { t: Tot; currency: string; many: boolean }) {
  const profit = t.revenue - t.spend;
  const roi = t.spend > 0 ? (profit / t.spend) * 100 : null;
  const tone = (n: number | null) => ((n ?? 0) > 0 ? "pos" : (n ?? 0) < 0 ? "neg" : undefined);
  return (
    <div className="space-y-1">
      {many && <div className="ml-0.5 text-xs font-medium text-muted-foreground">{currency}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 max-md:gap-2">
        <StatCard label={`Gasto ${currency}`} value={fmtMoney(t.spend)} icon={DollarSign} accent="bg-blue-500" blob="bg-blue-400" />
        <StatCard label={`Revenue ${currency}`} value={fmtMoney(t.revenue)} icon={ArrowUpRight} accent="bg-emerald-500" blob="bg-emerald-400" />
        <StatCard label={`Profit ${currency}`} value={fmtMoney(profit)} tone={tone(profit)} icon={profit >= 0 ? ArrowUpRight : ArrowDownRight} accent={profit >= 0 ? "bg-green-500" : "bg-red-500"} blob={profit >= 0 ? "bg-green-400" : "bg-red-400"} />
        <StatCard label="ROI" value={fmtPct(roi)} tone={tone(roi)} icon={Percent} accent={(roi ?? 0) >= 0 ? "bg-violet-500" : "bg-red-500"} blob={(roi ?? 0) >= 0 ? "bg-violet-400" : "bg-red-400"} />
        <StatCard label={`Ventas ${currency}`} value={fmtInt(t.sales)} icon={ShoppingCart} accent="bg-amber-500" blob="bg-amber-400" />
        <StatCard label="CPA" value={t.sales > 0 ? fmtMoney(t.spend / t.sales) : "—"} icon={Target} accent="bg-sky-500" blob="bg-sky-400" />
      </div>
    </div>
  );
}

export function MetricsSummary({ items, loading, byAccount = false, scope }: {
  items: SummaryItem[]; loading: boolean; byAccount?: boolean;
  /** Qué se está sumando: «campañas», «ad sets»… para el texto de ayuda. */
  scope: string;
}) {
  const [open, setOpen] = useState(false);

  const byCurrency = useMemo(() => {
    const m = new Map<string, Tot>();
    for (const i of items) m.set(i.currency, add(m.get(i.currency) ?? EMPTY, i));
    return [...m.entries()].sort((a, b) => b[1].spend - a[1].spend);
  }, [items]);

  const accounts = useMemo(() => {
    if (!byAccount) return [];
    const m = new Map<string, { name: string; currency: string; t: Tot }>();
    for (const i of items) {
      if (!i.account) continue;
      const cur = m.get(i.account.id) ?? { name: i.account.name, currency: i.currency, t: EMPTY };
      m.set(i.account.id, { ...cur, t: add(cur.t, i) });
    }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).filter(a => a.t.spend > 0 || a.t.revenue > 0).sort((a, b) => b.t.spend - a.t.spend);
  }, [items, byAccount]);

  const hasData = byCurrency.some(([, t]) => t.spend > 0 || t.revenue > 0 || t.sales > 0);

  if (loading && !hasData) {
    return (
      <div className="grid grid-cols-2 gap-3 pb-3 md:grid-cols-3 lg:grid-cols-6 max-md:gap-2">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[88px] rounded-xl" />)}
      </div>
    );
  }
  if (!hasData) return null;

  return (
    <div className="space-y-3 pb-3" aria-label={`Resumen de ${scope}`}>
      {byCurrency.map(([currency, t]) => <Cards key={currency} t={t} currency={currency} many={byCurrency.length > 1} />)}

      {byAccount && accounts.length > 0 && (
        <div className="rounded-lg border bg-card">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium max-md:min-h-11">
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            Por cuenta publicitaria
            <span className="font-normal text-muted-foreground">· {accounts.length} con gasto, ordenadas por gasto</span>
          </button>
          {open && (
            <div className="overflow-x-auto border-t">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    {["Cuenta", "Gasto", "Revenue", "Profit", "ROI", "Ventas", "CPA"].map(h => (
                      <th key={h} className="px-3 py-1.5 text-right font-medium first:text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => {
                    const profit = a.t.revenue - a.t.spend;
                    const roi = a.t.spend > 0 ? (profit / a.t.spend) * 100 : null;
                    const cls = profit > 0 ? "text-green-600 dark:text-green-400" : profit < 0 ? "text-red-600 dark:text-red-400" : "";
                    return (
                      <tr key={a.id} className="border-t tabular-nums">
                        <td className="max-w-[18rem] truncate px-3 py-1.5 text-left" title={a.name}>
                          {a.name}{a.currency !== "USD" ? <span className="text-muted-foreground"> · {a.currency}</span> : null}
                        </td>
                        <td className="px-3 py-1.5 text-right">{fmtMoney(a.t.spend)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtMoney(a.t.revenue)}</td>
                        <td className={`px-3 py-1.5 text-right ${cls}`}>{fmtMoney(profit)}</td>
                        <td className={`px-3 py-1.5 text-right ${cls}`}>{fmtPct(roi)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtInt(a.t.sales)}</td>
                        <td className="px-3 py-1.5 text-right">{a.t.sales > 0 ? fmtMoney(a.t.spend / a.t.sales) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
