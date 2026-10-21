"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { calcMetrics, fmtMoney, fmtInt, fmtPct, type Insights } from "@/lib/metrics";

interface Acct { id: string; name: string; account_status: number; bmId: string; currency: string; removedFromBmAt?: string | null; lastSeenInBmAt?: string | null }
interface CampaignData { active: number; campaigns: string[] }

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

// Códigos de account_status de Meta. El 1 (activa) no se etiqueta: es lo normal.
// Rojo = la cuenta no puede gastar. Ámbar = sigue viva pero necesita atención.
const ACCOUNT_STATUS: Record<number, { label: string; tone: "red" | "amber" }> = {
  2: { label: "Desactivado", tone: "red" },
  3: { label: "Sin liquidar", tone: "amber" },
  7: { label: "En revisión", tone: "amber" },
  8: { label: "Pago pendiente", tone: "amber" },
  9: { label: "Periodo de gracia", tone: "amber" },
  100: { label: "Cierre pendiente", tone: "red" },
  101: { label: "Cerrado", tone: "red" },
};

export default function DashboardView() {

  const router = useRouter();
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [ins, setIns] = useState<Record<string, Insights | null>>({});
  const [campaigns, setCampaigns] = useState<Record<string, CampaignData>>({});
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [datePreset, setDatePreset] = useState("last_7d");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" });
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const runId = useRef(0);

  // Camino en VIVO (fallback): recorre cuentas y pega a Meta por cada una.
  const runLive = useCallback(async (my: number) => {
    setLive(true); setSyncedAt(null);
    let accs: Acct[] = [];
    try { accs = ((await fetch("/api/meta/accounts").then((r) => r.json())).accounts ?? []) as Acct[]; } catch {}
    if (my !== runId.current) return;
    // En vivo solo se piden insights de las activas, así que se muestran esas:
    // los totales tienen que cuadrar con las filas visibles.
    const active = accs.filter((a) => a.account_status === 1);
    setAccounts(active);
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
      const list = (snap.accounts ?? []) as Array<{ id: string; name: string; bmId: string; currency?: string; account_status: number; insights: Insights | null; removedFromBmAt?: string | null; lastSeenInBmAt?: string | null }>;

      // Archivadas: historial puro desde DB. Sin fallback en vivo (no están en el BM).
      if (showArchived) {
        const accs: Acct[] = list.map((a) => ({ id: a.id, name: a.name, bmId: a.bmId, currency: a.currency ?? "USD", account_status: a.account_status, removedFromBmAt: a.removedFromBmAt, lastSeenInBmAt: a.lastSeenInBmAt }));
        const insMap: Record<string, Insights | null> = {};
        for (const a of list) insMap[a.id] = a.insights ?? null;
        setAccounts(accs); setIns(insMap);
        setTotal(accs.length); setDone(accs.length);
        setSyncedAt(snap.syncedAt ?? null); setLive(false); setLoading(false);
        return;
      }

      if (snap.synced && list.length > 0) {
        const accs: Acct[] = list.map((a) => ({ id: a.id, name: a.name, bmId: a.bmId, currency: a.currency ?? "USD", account_status: a.account_status }));
        const insMap: Record<string, Insights | null> = {};
        for (const a of list) insMap[a.id] = a.insights ?? null;
        setAccounts(accs);
        setIns(insMap);
        // Totales y tabla incluyen TODAS las cuentas vivas del BM (activas y
        // pausadas): lo que se suma es exactamente lo que se ve.
        setTotal(accs.length); setDone(accs.length);
        setSyncedAt(snap.syncedAt ?? null); setLive(false); setLoading(false);
        return;
      }
    } catch {}

    // 2) Fallback: preset sin snapshot o DB vacía → en vivo. (Solo vista activa.)
    await runLive(my);
  }, [datePreset, runLive, showArchived]);

  useEffect(() => { run(); }, [run]);

  // Sincronización REAL contra Meta a demanda: lo mismo que hace el job de
  // fondo cada 20 min, pero sin esperarlo. Al terminar recarga la vista.
  const syncWithMeta = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/dashboard/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "No se pudo sincronizar"); return; }
      if ((json.accounts ?? 0) === 0) {
        toast("Meta no devolvió cuentas para esta operación");
      } else {
        toast.success(`Sincronizadas ${json.accounts} cuentas${json.archived ? ` · ${json.archived} archivadas` : ""}`);
      }
      await run();
    } catch {
      toast.error("Error de red al sincronizar");
    } finally {
      setSyncing(false);
    }
  }, [run]);

  // Cargar campañas activas cuando cambien las cuentas
  useEffect(() => {
    if (accounts.length === 0) { setCampaigns({}); return; }
    const load = async () => {
      const map: Record<string, CampaignData> = {};
      for (const a of accounts) {
        try {
          const r = await fetch(`/api/dashboard/active-campaigns?accountId=${a.id.replace("act_", "")}&bmId=${a.bmId}`).then(r => r.json());
          if (r.active > 0) map[a.id] = r;
        } catch {}
      }
      setCampaigns(map);
    };
    load();
  }, [accounts]);

  // Totales agregados POR MONEDA (suma de crudos → recalcular derivados).
  const totsByC = new Map<string, { spend: number; revenue: number; sales: number; ic: number }>();
  for (const a of accounts) {
    const i = ins[a.id];
    if (!i) continue;
    const m = calcMetrics(i)!;
    const key = a.currency;
    const existing = totsByC.get(key) ?? { spend: 0, revenue: 0, sales: 0, ic: 0 };
    totsByC.set(key, {
      spend: existing.spend + m.spend,
      revenue: existing.revenue + m.revenue,
      sales: existing.sales + m.sales,
      ic: existing.ic + (m.ic ?? 0),
    });
  }
  // Total combinado (para compatibilidad, aunque no lo usaremos)
  const tot = Array.from(totsByC.values()).reduce(
    (s, t) => ({ spend: s.spend + t.spend, revenue: s.revenue + t.revenue, sales: s.sales + t.sales, ic: s.ic + t.ic }),
    { spend: 0, revenue: 0, sales: 0, ic: 0 }
  );

  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const rows = accounts
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
          <span className="text-sm text-muted-foreground">{loading ? `Cargando ${done}/${total} cuentas…` : `${total} ${showArchived ? "cuentas archivadas" : "cuentas"}`}</span>
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
          <Button size="sm" className="h-8 px-2.5 text-xs" onClick={syncWithMeta} disabled={syncing || loading} title="Trae datos frescos desde Meta y actualiza los snapshots">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Sincronizando…" : "Sincronizar con Meta"}
          </Button>
        </div>
      </div>

      {/* Totales por moneda (solo en vista activa; en archivadas los números están congelados) */}
      {!showArchived && totsByC.size > 0 && (
        <div className="space-y-3">
          {Array.from(totsByC.entries()).map(([currency, t]) => {
            const profit = t.revenue - t.spend;
            const roi = t.spend > 0 ? (profit / t.spend) * 100 : null;
            return (
              <div key={currency} className="space-y-1">
                {totsByC.size > 1 && (
                  <div className="text-xs font-medium text-muted-foreground ml-0.5">{currency}</div>
                )}
                <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                  <Card label={`Gasto ${currency}`} value={fmtMoney(t.spend)} />
                  <Card label={`Revenue ${currency}`} value={fmtMoney(t.revenue)} />
                  <Card label={`Profit ${currency}`} value={fmtMoney(profit)} tone={profit > 0 ? "pos" : profit < 0 ? "neg" : undefined} />
                  <Card label="ROI" value={fmtPct(roi)} tone={(roi ?? 0) > 0 ? "pos" : (roi ?? 0) < 0 ? "neg" : undefined} />
                  <Card label={`Ventas ${currency}`} value={fmtInt(t.sales)} />
                  <Card label="CPA" value={t.sales > 0 ? fmtMoney(t.spend / t.sales) : "—"} />
                </div>
              </div>
            );
          })}
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
              const st = acc.account_status === 1
                ? null
                : ACCOUNT_STATUS[acc.account_status] ?? { label: `Estado ${acc.account_status}`, tone: "amber" as const };
              return (
                <TableRow key={acc.id} className={`border-l-4 ${showArchived ? "" : "cursor-pointer"} ${profit > 0 ? "bg-green-50 border-l-green-400 hover:bg-green-100/60" : profit < 0 ? "bg-red-50 border-l-red-400 hover:bg-red-100/60" : "border-l-transparent hover:bg-muted/30"}`}
                  onClick={showArchived ? undefined : () => router.push(`/meta/campaigns?accountId=${rawId}&bmId=${acc.bmId}`)}>
                  <TableCell className="py-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium line-clamp-1">{acc.name} ({acc.currency})</span>
                      {st && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-[1px] text-[9px] font-semibold ${st.tone === "red" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}
                          title={`account_status ${acc.account_status} en Meta`}
                        >
                          {st.label}
                        </span>
                      )}
                      {campaigns[acc.id] && (
                        <span className="shrink-0 rounded bg-blue-50 text-blue-600 px-1.5 py-[1px] text-[9px] font-semibold" title={campaigns[acc.id].campaigns.join(", ")}>
                          {campaigns[acc.id].active} activa{campaigns[acc.id].active !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </TableCell>
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
