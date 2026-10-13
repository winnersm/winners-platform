"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Copy, RefreshCw, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface Campaign {
  id: string; name: string; status: string; is_cbo: boolean;
  daily_budget?: string; lifetime_budget?: string; objective: string;
}

interface Props {
  campaign: Campaign;
  accountId: string;
  bmId?: string;
  onClose: () => void;
  onSuccess: () => void;
}

const schema = z.object({
  name: z.string().min(1, "Nombre requerido"),
  status: z.enum(["ACTIVE", "PAUSED"]),
  count: z.number().int().min(1).max(20),
});
type FormData = z.infer<typeof schema>;

function formatBudget(cents: string | undefined) {
  if (!cents) return null;
  return `$${(Number(cents) / 100).toLocaleString("es-MX")}`;
}

export function DuplicateCampaignModal({ campaign, accountId, bmId, onClose, onSuccess }: Props) {
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: `[Copia] ${campaign.name}`, status: "PAUSED", count: 1 },
  });

  const status = watch("status");
  const count = watch("count");

  async function onSubmit(data: FormData) {
    setSaving(true);
    const res = await fetch("/api/meta/duplicate/campaign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: campaign.id, accountId, bmId, ...data }),
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

  const budget = formatBudget(campaign.daily_budget ?? campaign.lifetime_budget);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4" /> Duplicar campaña
          </DialogTitle>
          <DialogDescription className="text-xs space-y-1">
            <span className="block font-medium text-foreground truncate">{campaign.name}</span>
            <span className="flex gap-2 flex-wrap">
              <Badge variant="outline" className="text-xs">{campaign.objective?.replace(/_/g, " ")}</Badge>
              <Badge variant="outline" className="text-xs">{campaign.is_cbo ? "CBO" : "ABO"}</Badge>
              {budget && <Badge variant="outline" className="text-xs">{budget}{campaign.is_cbo ? "/día" : ""}</Badge>}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label>Nombre base</Label>
            <Input {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Estado inicial</Label>
              <Select value={status} onValueChange={(v) => setValue("status", v as "ACTIVE" | "PAUSED")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAUSED">Pausada</SelectItem>
                  <SelectItem value="ACTIVE">Activa</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Cantidad</Label>
              <Input
                type="number" min={1} max={20}
                {...register("count", { valueAsNumber: true })}
              />
              {errors.count && <p className="text-xs text-destructive">{errors.count.message}</p>}
            </div>
          </div>

          {count > 1 && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
              Se crearán <strong>{count} copias</strong>: &quot;{watch("name")} (1)&quot; … &quot;{watch("name")} ({count})&quot;
            </p>
          )}

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground flex items-center gap-1">
              <Briefcase className="h-3 w-3" /> Trabajo en cola
            </p>
            <p>• La duplicación corre en segundo plano (~10 min por campaña)</p>
            <p>• Puedes seguir usando la app mientras dura</p>
            <p>• Sigue el progreso en Trabajos</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? <><RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Encolando...</>
                : <><Copy className="h-4 w-4 mr-1" /> {count > 1 ? `Duplicar ×${count}` : "Duplicar"}</>
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
