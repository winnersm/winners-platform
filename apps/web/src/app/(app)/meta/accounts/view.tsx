"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Building2, RefreshCw, AlertCircle, Activity, Search, ArrowDownAZ, ArrowUpZA } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

interface AdAccount {
  id: string;
  name: string;
  currency: string;
  account_status: number;
  bmId: string;
}

interface AccountUsage {
  call_count: number;
  total_cputime: number;
  total_time: number;
  estimated_time_to_regain_access?: number;
}

const STATUS_LABEL: Record<number, string> = {
  1: "Activa",
  2: "Desactivada",
  3: "Sin facturación",
  7: "Archivada",
  9: "Cerrada",
};

// % de cuota = el peor de los 3 ejes. -1 = sin dato.
function usagePct(u: AccountUsage | null | undefined): number {
  if (!u) return -1;
  return Math.max(u.call_count ?? 0, u.total_cputime ?? 0, u.total_time ?? 0);
}

function QuotaBadge({ u }: { u: AccountUsage | null | undefined }) {
  const pct = usagePct(u);
  if (pct < 0) return <span className="text-[11px] text-muted-foreground/50">cuota —</span>;
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-green-500";
  const regain = u?.estimated_time_to_regain_access ?? 0;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium"
      title={`Cuota ads_management: ${pct}%${regain > 0 ? ` · se libera en ~${regain} min` : ""}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {pct}%
    </span>
  );
}

export default function AccountsView() {

  const router = useRouter();
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [usage, setUsage] = useState<Record<string, AccountUsage | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadingQuota, setLoadingQuota] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Lee la cuota: cache (instantáneo) o barrido activo (refresh=true).
  const loadUsage = useCallback(async (refresh = false) => {
    if (refresh) setLoadingQuota(true);
    try {
      const res = await fetch(`/api/meta/usage/all${refresh ? "?refresh=true" : ""}`);
      const json = await res.json();
      if (res.ok) setUsage(json.usage ?? {});
      if (refresh && res.ok) toast.success("Cuotas actualizadas");
      else if (refresh) toast.error(json.error ?? "Error al actualizar cuotas");
    } catch {
      if (refresh) toast.error("Error al actualizar cuotas");
    } finally {
      if (refresh) setLoadingQuota(false);
    }
  }, []);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    const url = `/api/meta/accounts${refresh ? "?refresh=true" : ""}`;
    const res = await fetch(url);
    const json = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(json.error ?? "Error al cargar cuentas");
      return;
    }
    setAccounts(json.accounts);
    if (refresh) toast.success("Cuentas actualizadas");
    loadUsage(false); // cuota cacheada, sin llamadas extra
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Filtrado: por nombre o ID, y opción "solo activas".
  const q = query.toLowerCase().trim();
  const filtered = accounts
    .filter((a) => {
      const matchText = !q || a.name.toLowerCase().includes(q) || a.id.replace("act_", "").includes(q);
      const matchStatus = !onlyActive || a.account_status === 1;
      return matchText && matchStatus;
    })
    // Orden por nombre (natural: "Liminal 40" < "Liminal 41" < "Liminal 42").
    .sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cuentas publicitarias</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {accounts.length > 0
              ? (filtered.length === accounts.length ? `${accounts.length} cuentas` : `${filtered.length} de ${accounts.length} cuentas`)
              : "Cargando..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => loadUsage(true)} disabled={loading || loadingQuota}>
            <Activity className={`h-4 w-4 mr-1 ${loadingQuota ? "animate-pulse" : ""}`} />
            {loadingQuota ? "Midiendo..." : "Refrescar cuotas"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Sincronizar
          </Button>
        </div>
      </div>

      {/* Filtro */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar cuenta por nombre o ID..."
            className="pl-8 h-9 w-72 bg-white"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          variant={onlyActive ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyActive((v) => !v)}
        >
          {onlyActive ? "Solo activas ✓" : "Solo activas"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          title={`Ordenar por nombre (${sortDir === "asc" ? "A→Z" : "Z→A"})`}
        >
          {sortDir === "asc" ? <ArrowDownAZ className="h-4 w-4 mr-1" /> : <ArrowUpZA className="h-4 w-4 mr-1" />}
          Nombre {sortDir === "asc" ? "A→Z" : "Z→A"}
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((acc) => {
            const rawId = acc.id.replace("act_", "");
            const isActive = acc.account_status === 1;
            return (
              <Card
                key={acc.id}
                className={`cursor-pointer transition-all hover:border-primary/50 hover:shadow-md ${!isActive ? "opacity-60" : ""}`}
                onClick={() => isActive && router.push(`/meta/campaigns?accountId=${rawId}&bmId=${acc.bmId}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <CardTitle className="text-sm leading-snug line-clamp-2">{acc.name}</CardTitle>
                    </div>
                    <Badge variant={isActive ? "default" : "secondary"} className="shrink-0 text-xs">
                      {STATUS_LABEL[acc.account_status] ?? "Desconocido"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end justify-between gap-2">
                    <CardDescription className="text-xs space-y-0.5">
                      <div>ID: {rawId}</div>
                      <div>Moneda: {acc.currency}</div>
                    </CardDescription>
                    <QuotaBadge u={usage[rawId]} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && accounts.length === 0 && !error && (
        <div className="text-center text-muted-foreground py-16 text-sm">
          No se encontraron cuentas. Configura un Business Manager en Ajustes.
        </div>
      )}

      {!loading && accounts.length > 0 && filtered.length === 0 && (
        <div className="text-center text-muted-foreground py-16 text-sm">
          Ninguna cuenta coincide con el filtro.
        </div>
      )}
    </div>
  );
}
