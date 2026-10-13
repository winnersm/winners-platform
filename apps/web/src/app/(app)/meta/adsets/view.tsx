"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, AlertCircle, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { DuplicateAdsetsModal } from "@/components/duplicate-adsets-modal";

interface AdSet {
  id: string;
  name: string;
  status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default", PAUSED: "secondary", ARCHIVED: "outline", DELETED: "destructive",
};

function formatBudget(cents?: string) {
  if (!cents) return "—";
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(Number(cents) / 100);
}

function AdSetsInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const accountId = searchParams.get("accountId");
  const campaignId = searchParams.get("campaignId");
  const campaignName = searchParams.get("campaignName") ?? campaignId;

  const [adsets, setAdsets] = useState<AdSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);

  const load = useCallback(async () => {
    if (!accountId || !campaignId) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    const res = await fetch(`/api/meta/adsets?accountId=${accountId}&campaignId=${campaignId}`);
    const json = await res.json();
    setLoading(false);
    if (!res.ok) { setError(json.error ?? "Error al cargar"); return; }
    setAdsets(json.adsets);
  }, [accountId, campaignId]);

  useEffect(() => { load(); }, [load]);

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (selectedIds.size === adsets.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(adsets.map((a) => a.id)));
    }
  }

  const selectedAdsets = adsets.filter((a) => selectedIds.has(a.id));

  if (!accountId || !campaignId) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Accede desde una campaña en la página de{" "}
        <button className="underline" onClick={() => router.push("/meta/accounts")}>Cuentas</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => router.push(`/meta/campaigns?accountId=${accountId}`)}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Campañas
          </Button>
          <div>
            <h1 className="text-xl font-bold">Ad Sets</h1>
            <p className="text-xs text-muted-foreground truncate max-w-sm">{campaignName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button size="sm" onClick={() => setShowDuplicateModal(true)}>
              <Copy className="h-4 w-4 mr-1" />
              Duplicar {selectedIds.size} ad set{selectedIds.size > 1 ? "s" : ""}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={adsets.length > 0 && selectedIds.size === adsets.length}
                    ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < adsets.length; }}
                    onChange={() => {}}
                    onClick={toggleAll}
                    className="cursor-pointer"
                  />
                </TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Optimización</TableHead>
                <TableHead>Presupuesto</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adsets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground text-sm">
                    No hay ad sets en esta campaña
                  </TableCell>
                </TableRow>
              ) : (
                adsets.map((adset) => (
                  <TableRow
                    key={adset.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(
                      `/meta/ads?accountId=${accountId}&adsetId=${adset.id}&adsetName=${encodeURIComponent(adset.name)}&campaignId=${campaignId}&campaignName=${encodeURIComponent(campaignName ?? "")}`
                    )}
                  >
                    <TableCell onClick={(e) => toggleSelect(adset.id, e)}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(adset.id)}
                        onChange={() => {}}
                        className="cursor-pointer"
                      />
                    </TableCell>
                    <TableCell>
                      <p className="font-medium text-sm">{adset.name}</p>
                      <p className="text-xs text-muted-foreground">{adset.id}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[adset.status] ?? "outline"}>{adset.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {adset.optimization_goal?.replace(/_/g, " ") ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatBudget(adset.daily_budget ?? adset.lifetime_budget)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        Ver Ads <ChevronRight className="h-3 w-3" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {showDuplicateModal && accountId && (
        <DuplicateAdsetsModal
          selectedAdsets={selectedAdsets}
          accountId={accountId}
          onClose={() => setShowDuplicateModal(false)}
          onSuccess={() => { setShowDuplicateModal(false); load(); }}
        />
      )}
    </div>
  );
}

export default function AdsetsView() {

  return (
    <Suspense fallback={<div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>}>
      <AdSetsInner />
    </Suspense>
  );
}
