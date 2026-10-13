"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

interface Ad {
  id: string;
  name: string;
  status: string;
  creative_id?: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default", PAUSED: "secondary", ARCHIVED: "outline", DELETED: "destructive",
};

function AdsInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const accountId = searchParams.get("accountId");
  const adsetId = searchParams.get("adsetId");
  const adsetName = searchParams.get("adsetName") ?? adsetId;
  const campaignId = searchParams.get("campaignId");
  const campaignName = searchParams.get("campaignName") ?? "";

  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId || !adsetId) return;
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/meta/ads?accountId=${accountId}&adsetId=${adsetId}`);
    const json = await res.json();
    setLoading(false);
    if (!res.ok) { setError(json.error ?? "Error al cargar"); return; }
    setAds(json.ads);
  }, [accountId, adsetId]);

  useEffect(() => { load(); }, [load]);

  if (!accountId || !adsetId) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Accede desde un Ad Set.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(
              `/meta/adsets?accountId=${accountId}&campaignId=${campaignId}&campaignName=${encodeURIComponent(campaignName)}`
            )}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Ad Sets
          </Button>
          <div>
            <h1 className="text-xl font-bold">Ads</h1>
            <p className="text-xs text-muted-foreground truncate max-w-sm">{adsetName}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
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
                <TableHead>Nombre</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Creative ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ads.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-10 text-muted-foreground text-sm">
                    No hay ads en este ad set
                  </TableCell>
                </TableRow>
              ) : (
                ads.map((ad) => (
                  <TableRow key={ad.id}>
                    <TableCell>
                      <p className="font-medium text-sm">{ad.name}</p>
                      <p className="text-xs text-muted-foreground">{ad.id}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[ad.status] ?? "outline"}>{ad.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ad.creative_id ?? "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function AdsView() {

  return (
    <Suspense fallback={<div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}</div>}>
      <AdsInner />
    </Suspense>
  );
}
