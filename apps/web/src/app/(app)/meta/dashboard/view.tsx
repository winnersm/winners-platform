"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { calcMetrics, fmtMoney, fmtInt, fmtPct, type Insights } from "@/lib/metrics";

interface Acct { id: string; name: string; account_status: number; bmId: string; removedFromBmAt?: string | null; lastSeenInBmAt?: string | null }

function agoLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "hace segundos";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return `hace ${h} h`;
}
const DATE_PRESETS = [
  { value: "today", label: "Hoy" },
  { value: "yesterday", label: "Ayer" },
  { value: "last_7d", label: "7 días" },
  { value: "last_14d", label: "14 días" },
  { value: "last_30d", label: "30 días" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes pasado" },
  { value: "maximum", label: "Máximo" },
];

export default function DashboardView() {

  const router = useRouter();
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [ins, setIns] = useState<Record<string, Insights | null>>({});
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [datePreset, setDatePreset] = useState("last_7d");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" });
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const runId = useRef(0);

  // Camino en VIVO (fallback): recorre cuentas y pega a Meta por cada una.
  const runLive = useCallback(async (my: number) => {
    setLive(true); setSyncedAt(null);
    let accs: Acct[] = [];
    try { accs = ((await fetch("/api/meta/accounts").then((r) => r.json())).accounts ?? []) as Acct[]; } catch {}
    if (my !== runId.current) return;
    setAccounts(accs);
    const active = accs.filter((a) => a.account_status === 1);
    setTotal(active.length);
    await Promise.all(active.map(async (a) => {
      const rawId = a.id.replace("act_", "");
      try {
        const j = await fetch(`/api/dashboard/account?accountId=${rawId}&bmId=${a.bmId}&datePreset=${datePreset}`).then((r) => r.json());
        if (my !== runId.current) return;
        setIns((prev) => ({ ...prev, [a.id]: j.insights ?? null }));
      } catch {}
      if (my === runId.current) setDone((d) => d + 1);
    }));
    if (my === runId.current) setLoading(false);
  }, [datePreset]);

  const run = useCallback(async () => {
    const my = ++runId.current;
    setLoading(true); setIns({}); setDone(0); setSyncedAt(null);
    const view = showArchived ? "removed" : "active";

    // 1) Snapshots desde DB (instantáneo, sin pegarle a Meta).
    try {
      const snap = await fetch(`/api/dashboard/snapshots?datePreset=${datePreset}&view=${view}`).then((r) => r.json());
      if (my !== runId.current) return;
      const list = (snap.accounts ?? []) as Array<{ id: string; name: string; bmId: string; account_status: number; insights: Insights | null; removedFromBmAt?: string | null; lastSeenInBmAt?: string | null }>;

      // Archivadas: historial puro desde DB. Sin fallback en vivo (no están en el BM).
      if (showArchived) {
        const accs: Acct[] = list.map((a) => ({ id: a.id, name: a.name, bmId: a.bmId, account_status: a.account_status, removedFromBmAt: a.removedFromBmAt, lastSeenInBmAt: a.lastSeenInBmAt }));
        const insMap: Record<string, Insights | null> = {};
        for (const a of list) insMap[a.id] = a.insights ?? null;
        setAccounts(accs); setIns(insMap);
        setTotal(accs.length); setDone(accs.length);
        setSyncedAt(snap.syncedAt ?? null); setLive(false); setLoading(false);
        return;
      }

      if (snap.synced && list.length > 0) {
        const accs: Acct[] = list.map((a) => ({ id: a.id, name: a.name, bmId: a.bmId, account_status: a.account_status }));
        const insMap: Record<string, Insights | null> = {};
        for (const a of list) insMap[a.id] = a.insights ?? null;
        setAccounts(accs);
        setIns(insMap);
        const active = accs.filter((a) => a.account_status === 1);
        setTotal(active.length); setDone(active.length);
        setSyncedAt(snap.syncedAt ?? null); setLive(false); setLoading(false);
        return;
      }
    } catch {}

    // 2) Fallback: preset sin snapshot o DB vacía → en vivo. (Solo vista activa.)
    await runLive(my);
  }, [datePreset, runLive, showArchived]);

  useEffect(() => { run(); }, [run]);

  // Totales agregados (suma de crudos → recalcular derivados).
  const tot = accounts.reduce(
    (s, a) => {
      const i = ins[a.id];
      if (!i) return s;
      const m = calcMetrics(i)!;
      s.spend += m.spend; s.revenue += m.revenue; s.sales += m.sales; s.ic += m.ic ?? 0;
      return s;
    },
    { spend: 0, revenue: 0, sales: 0, ic: 0 }
  );
  const totProfit = tot.revenue - tot.spend;
  const totRoi = tot.spend > 0 ? (totProfit / tot.spend) * 100 : null;
  const totCpa = tot.sales > 0 ? tot.spend / tot.sales : null;

  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const rows = accounts
    .filter((a) => showArchived || a.account_status === 1)
    .map((a) => ({ acc: a, m: calcMetrics(ins[a.id]) }))
    .sort((x, y) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      if (sort.key === "name") return x.acc.name.localeCompare(y.acc.name, "es") * dir;
      const vx = (x.m as Record<string, number | null> | null)?.[sort.key] ?? -Infinity;
      const vy = (y.m as Record<string, number | null> | null)?.[sort.key] ?? -Infinity;
      return ((vx as number) - (vy as number)) * dir;
    });

  const arrow = (k: string) => (sort.key === k ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const sh = (k: string, label: string) => (
    <TableHead className={`py-2 text-[10px] font-semibold text-right cursor-pointer select-none hover:text-foreground ${sort.key === k ? "text-primary" : ""}`} onClick={() => toggleSort(k)}>
      {label}{arrow(k)}
    </TableHead>
  );

  const Card = ({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) => (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tone === "pos" ? "text-green-600" : tone === "neg" ? "text-red-600" : ""}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Rendimiento</h1>
          <span className="text-sm text-muted-foreground">{loading ? `Cargando ${done}/${total} cuentas…` : `${total} ${showArchived ? "cuentas archivadas" : "cuentas activas"}`}</span>
          {!loading && !showArchived && (
            live
              ? <span className="text-[11px] text-amber-600" title="Datos en vivo desde Meta (preset sin snapshot)">· en vivo</span>
              : syncedAt && <span className="text-[11px] text-muted-foreground/70">· actualizado {agoLabel(syncedAt)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border p-0.5">
            <Button variant={showArchived ? "ghost" : "secondary"} size="sm" className="h-7 px-2.5 text-xs" onClick={() => setShowArchived(false)}>Activas</Button>
            <Button variant={showArchived ? "secondary" : "ghost"} size="sm" className="h-7 px-2.5 text-xs" onClick={() => setShowArchived(true)}>Archivadas</Button>
          </div>
          <TrendingUp className={`h-3.5 w-3.5 ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={(v) => v && setDatePreset(v)}>
            <SelectTrigger className="h-8 w-28 text-xs bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>{DATE_PRESETS.map((p) => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={run} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
        </div>
      </div>

      {/* Totales (solo en vista activa; en archivadas los números están congelados) */}
      {!showArchived && (
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          <Card label="Gasto" value={fmtMoney(tot.spend)} />
          <Card label="Revenue" value={fmtMoney(tot.revenue)} />
          <Card label="Profit" value={fmtMoney(totProfit)} tone={totProfit > 0 ? "pos" : totProfit < 0 ? "neg" : undefined} />
          <Card label="ROI" value={fmtPct(totRoi)} tone={(totRoi ?? 0) > 0 ? "pos" : (totRoi ?? 0) < 0 ? "neg" : undefined} />
          <Card label="Ventas" value={fmtInt(tot.sales)} />
          <Card label="CPA" value={fmtMoney(totCpa)} />
        </div>
      )}

      {showArchived && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          Cuentas que salieron del Business Manager. Sus números son la <strong>última foto</strong> antes de salir y ya no se actualizan. Se conservan solo para consulta histórica.
        </div>
      )}

      {/* Por cuenta */}
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="py-2 text-[10px] font-semibold min-w-[200px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("name")}>CUENTA{arrow("name")}</TableHead>
              {sh("spend", "GASTO")}{sh("revenue", "REVENUE")}{sh("profit", "PROFIT")}{sh("roi", "ROI")}{sh("sales", "VENTAS")}{sh("cpa", "CPA")}{sh("cpm", "CPM")}{sh("ctr", "CTR")}
              {showArchived && <TableHead className="py-2 text-[10px] font-semibold text-right whitespace-nowrap">SALIÓ DEL BM</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.every((r) => !r.m) ? (
              Array.from({ length: 6 }).map((_, i) => <TableRow key={i}><TableCell colSpan={showArchived ? 10 : 9} className="py-2"><Skeleton className="h-6 w-full" /></TableCell></TableRow>)
            ) : rows.map(({ acc, m }) => {
              const profit = m?.profit ?? 0;
              const rawId = acc.id.replace("act_", "");
              return (
                <TableRow key={acc.id} className={`cursor-pointer border-l-4 ${profit > 0 ? "bg-green-50 border-l-green-400 hover:bg-green-100/60" : profit < 0 ? "bg-red-50 border-l-red-400 hover:bg-red-100/60" : "border-l-transparent hover:bg-muted/30"}`}
                  onClick={() => router.push(`/meta/campaigns?accountId=${rawId}&bmId=${acc.bmId}`)}>
                  <TableCell className="py-2"><span className="text-xs font-medium line-clamp-1">{acc.name}</span></TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(m?.spend ?? 0)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(m?.revenue ?? 0)}</TableCell>
                  <TableCell className={`py-2 text-right text-xs tabular-nums font-medium ${profit > 0 ? "text-green-600" : profit < 0 ? "text-red-600" : ""}`}>{fmtMoney(profit)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtPct(m?.roi ?? 0)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtInt(m?.sales ?? 0)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(m?.cpa ?? 0)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtMoney(m?.cpm ?? 0)}</TableCell>
                  <TableCell className="py-2 text-right text-xs tabular-nums">{fmtPct(m?.ctr ?? 0)}</TableCell>
                  {showArchived && <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground whitespace-nowrap">{acc.removedFromBmAt ? new Date(acc.removedFromBmAt).toLocaleDateString("es") : "—"}</TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
