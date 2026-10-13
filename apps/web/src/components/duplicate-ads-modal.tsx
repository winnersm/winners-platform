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

interface Ad { name: string; creativeId: string; }
interface Campaign { id: string; name: string; status: string; }
interface AdSet { id: string; name: string; status: string; }

interface Props {
  selectedAds: Ad[];
  accountId: string;
  bmId?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function DuplicateAdsModal({ selectedAds, accountId, bmId, onClose, onSuccess }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [adsets, setAdsets] = useState<AdSet[]>([]);
  const [targetCampaignId, setTargetCampaignId] = useState("");
  const [targetAdsetId, setTargetAdsetId] = useState("");
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingAdsets, setLoadingAdsets] = useState(false);
  const [count, setCount] = useState(1);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

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

  async function onCampaignChange(campaignId: string) {
    setTargetCampaignId(campaignId);
    setTargetAdsetId("");
    setAdsets([]);
    if (!campaignId) return;
    setLoadingAdsets(true);
    const res = await fetch(`/api/meta/adsets?accountId=${accountId}&campaignId=${campaignId}${bmId ? `&bmId=${bmId}` : ""}`);
    const json = await res.json();
    setLoadingAdsets(false);
    if (res.ok) setAdsets(json.adsets ?? []);
  }

  async function handleSubmit() {
    if (!targetAdsetId) return;
    setSaving(true);
    const res = await fetch("/api/meta/duplicate/ads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ads: selectedAds,
        targetAdsetId,
        targetAdsetName: adsets.find(a => a.id === targetAdsetId)?.name,
        targetCampaignName: campaigns.find(c => c.id === targetCampaignId)?.name,
        accountId, bmId, count,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { toast.error(json.error ?? "Error al encolar"); return; }
    toast.success(
      `${json.queued} trabajo${json.queued > 1 ? "s" : ""} encolado${json.queued > 1 ? "s" : ""}`,
      { action: { label: "Ver trabajos", onClick: () => router.push("/meta/jobs") } }
    );
    onSuccess();
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4" /> Duplicar Anuncios
          </DialogTitle>
          <DialogDescription>
            {selectedAds.length} anuncio{selectedAds.length > 1 ? "s" : ""} seleccionado{selectedAds.length > 1 ? "s" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="rounded-md border divide-y max-h-32 overflow-y-auto text-sm">
            {selectedAds.map((a, i) => (
              <div key={i} className="px-3 py-2">
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
            ) : (
              <Select value={targetCampaignId} onValueChange={v => onCampaignChange(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Selecciona una campaña" /></SelectTrigger>
                <SelectContent>
                  {campaigns.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${c.status === "ACTIVE" ? "bg-green-500" : "bg-gray-400"}`} />
                        <span className="truncate max-w-xs">{c.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Ad Set destino</Label>
            {!targetCampaignId ? (
              <p className="text-xs text-muted-foreground">Primero selecciona una campaña</p>
            ) : loadingAdsets ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" /> Cargando ad sets...
              </div>
            ) : adsets.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> Sin ad sets
              </div>
            ) : (
              <Select value={targetAdsetId} onValueChange={v => setTargetAdsetId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Selecciona un ad set" /></SelectTrigger>
                <SelectContent>
                  {adsets.map(a => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${a.status === "ACTIVE" ? "bg-green-500" : "bg-gray-400"}`} />
                        <span className="truncate max-w-xs">{a.name}</span>
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
              type="number" min={1} max={20} value={count}
              onChange={e => setCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              className="w-24"
            />
          </div>

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground flex items-center gap-1"><Briefcase className="h-3 w-3" /> Trabajo en cola</p>
            <p>• Corre en segundo plano — sigue el progreso en Trabajos</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={saving || !targetAdsetId}>
              {saving
                ? <><RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Encolando...</>
                : <><Copy className="h-4 w-4 mr-1" /> {count > 1 ? `Duplicar ×${count}` : "Duplicar"}</>
              }
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
