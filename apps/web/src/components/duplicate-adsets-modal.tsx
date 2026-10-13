"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, RefreshCw, AlertCircle, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface AdSet { id: string; name: string; campaign_id?: string; }
interface Campaign { id: string; name: string; status: string; }

interface Props {
  selectedAdsets: AdSet[];
  accountId: string;
  bmId?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function DuplicateAdsetsModal({ selectedAdsets, accountId, bmId, onClose, onSuccess }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  // Por defecto: la campaña de origen del/los adset(s) seleccionados.
  const [targetCampaignId, setTargetCampaignId] = useState<string>(selectedAdsets[0]?.campaign_id ?? "");
  const [count, setCount] = useState(1);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const MAX_CLONES = 50;
  const maxCount = Math.max(1, Math.floor(MAX_CLONES / Math.max(1, selectedAdsets.length)));
  const totalClones = selectedAdsets.length * count;

  useEffect(() => {
    async function load() {
      setLoadingCampaigns(true);
      const all: Campaign[] = [];
      let cursor: string | null = null;
      try {
        do {
          const url: string = `/api/meta/campaigns?accountId=${accountId}${cursor ? `&cursor=${cursor}` : ""}${bmId ? `&bmId=${bmId}` : ""}`;
          const res: Response = await fetch(url);
          const json: { campaigns?: Campaign[]; nextCursor?: string | null } = await res.json();
          if (!res.ok) break;
          all.push(...(json.campaigns ?? []));
          cursor = json.nextCursor ?? null;
        } while (cursor);
      } catch { }
      setCampaigns(all);
      setLoadingCampaigns(false);
    }
    load();
  }, [accountId]);

  async function handleSubmit() {
    if (!targetCampaignId) return;
    setSaving(true);
    const res = await fetch("/api/meta/duplicate/adsets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adsetIds: selectedAdsets.map(a => a.id),
        targetCampaignId,
        targetCampaignName: campaigns.find(c => c.id === targetCampaignId)?.name,
        accountId, bmId, count,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { toast.error(json.error ?? "Error al encolar"); return; }
    toast.success(
      `Trabajo encolado — clonando ${json.totalClones ?? totalClones} adset(s)`,
      { action: { label: "Ver trabajos", onClick: () => router.push("/meta/jobs") } }
    );
    onSuccess();
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4" /> Duplicar Ad Sets
          </DialogTitle>
          <DialogDescription>
            {selectedAdsets.length} ad set{selectedAdsets.length > 1 ? "s" : ""} seleccionado{selectedAdsets.length > 1 ? "s" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="rounded-md border divide-y max-h-36 overflow-y-auto text-sm">
            {selectedAdsets.map(a => (
              <div key={a.id} className="px-3 py-2">
                <p className="font-medium truncate">{a.name}</p>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label>Campaña destino</Label>
            {loadingCampaigns ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" /> Cargando campañas...
              </div>
            ) : campaigns.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> No se encontraron campañas
              </div>
            ) : (
              <Select value={targetCampaignId} onValueChange={v => setTargetCampaignId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona una campaña">
                    {targetCampaignId
                      ? (campaigns.find(c => c.id === targetCampaignId)?.name ?? "Cargando…")
                      : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${c.status === "ACTIVE" ? "bg-green-500" : "bg-gray-400"}`} />
                        <span className="whitespace-normal break-words">{c.name}{c.id === selectedAdsets[0]?.campaign_id ? "  (origen)" : ""}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Cantidad de veces</Label>
            <Input
              type="number" min={1} max={maxCount} value={count}
              onChange={e => setCount(Math.max(1, Math.min(maxCount, parseInt(e.target.value) || 1)))}
              className="w-24"
            />
            <p className="text-xs text-muted-foreground">
              Se crearán <span className="font-medium text-foreground">{totalClones}</span> adset{totalClones > 1 ? "s" : ""} en la campaña destino (máx 50). Todo en un solo trabajo.
            </p>
          </div>

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground flex items-center gap-1"><Briefcase className="h-3 w-3" /> Trabajo en cola</p>
            <p>• Corre en segundo plano — sigue el progreso en Trabajos</p>
            <p>• Si la campaña destino está pausada, se activa y restaura automáticamente</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={saving || !targetCampaignId || loadingCampaigns}>
              {saving
                ? <><RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Encolando...</>
                : <><Copy className="h-4 w-4 mr-1" /> {totalClones > 1 ? `Duplicar ×${totalClones}` : "Duplicar"}</>
              }
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
