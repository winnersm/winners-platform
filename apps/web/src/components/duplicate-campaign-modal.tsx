"use client";

import { useState } from "react";
import { toast } from "sonner";
import { notifyJobsChanged, openJobsDock } from "@/lib/jobs-dock-events";
import { Copy, RefreshCw, Briefcase, ShieldCheck } from "lucide-react";
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
import { ErrorDetails, errorInfoOf, type ErrorInfo } from "@/components/error-details";
import { DUPLICATE_LIMITS } from "@/lib/duplicate-limits";

interface Campaign {
  id: string; name: string; status: string; is_cbo: boolean;
  daily_budget?: string; lifetime_budget?: string; objective: string;
  /** Cuenta de la campaña (vista global). Si falta, se usa la del modal. */
  accountId?: string; bmId?: string;
}

interface Props {
  /** Una o varias campañas; pueden ser de cuentas distintas (vista global). */
  campaigns: Campaign[];
  accountId?: string;
  bmId?: string;
  currency?: string;
  onClose: () => void;
  onSuccess: (result: { batchIds: string[]; queued: number }) => void;
}

const { copiesPerCampaign: MAX_COPIES, jobsPerRequest: MAX_TOTAL } = DUPLICATE_LIMITS;

function formatBudget(cents: string | undefined, currency = "USD") {
  if (!cents) return null;
  return new Intl.NumberFormat("es-CO", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(cents) / 100);
}

export function DuplicateCampaignModal({ campaigns, accountId, bmId, currency, onClose, onSuccess }: Props) {
  const single = campaigns.length === 1 ? campaigns[0] : null;

  const [name, setName] = useState(single ? `[Copia] ${single.name}` : "");
  const [prefix, setPrefix] = useState("[Copia] ");
  const [status, setStatus] = useState<"ACTIVE" | "PAUSED">("PAUSED");
  const [countRaw, setCountRaw] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const count = Math.floor(Number(countRaw));
  const total = campaigns.length * (Number.isFinite(count) ? count : 0);
  const countError =
    !Number.isFinite(count) || count < 1 ? "Indica al menos 1 copia"
    : count > MAX_COPIES ? `Máximo ${MAX_COPIES} copias por campaña`
    : total > MAX_TOTAL ? `Son ${total} copias: el máximo por tanda es ${MAX_TOTAL}. Reduce la cantidad o divide la selección.`
    : null;
  const nameError = single && !name.trim() ? "Nombre requerido" : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (countError || nameError) return;
    setSaving(true);
    setError(null);
    try {
      // Una petición (= un lote) por cuenta: el reparto y la cuota son por cuenta.
      const groups = new Map<string, { bmId?: string; items: Array<{ campaignId: string; name: string }> }>();
      for (const c of campaigns) {
        const acc = c.accountId ?? accountId;
        if (!acc) continue;
        const g = groups.get(acc) ?? { bmId: c.bmId ?? bmId, items: [] };
        g.items.push({ campaignId: c.id, name: single ? name.trim() : `${prefix}${c.name}` });
        groups.set(acc, g);
      }
      const batchIds: string[] = [];
      let queued = 0;
      for (const [acc, g] of groups) {
        const res = await fetch("/api/meta/duplicate/campaign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: g.items, accountId: acc, bmId: g.bmId, status, count }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const info: ErrorInfo = errorInfoOf(json) ?? { title: json.error ?? "No se pudo encolar la duplicación" };
          // Lo ya encolado sigue su curso (se ve en Trabajos); el modal queda abierto con el motivo.
          setError(queued > 0 ? { ...info, message: `${queued} copias de otras cuentas ya quedaron en cola; falló la cuenta ${acc}. ${info.message ?? ""}` } : info);
          return;
        }
        batchIds.push(json.batchId);
        queued += json.queued;
      }
      notifyJobsChanged();
      toast.success(
        `${queued} copia${queued > 1 ? "s" : ""} en cola`,
        {
          description: "Se procesan en orden, como máximo 2 a la vez por cuenta.",
          action: { label: "Ver trabajos", onClick: openJobsDock },
        },
      );
      onSuccess({ batchIds, queued });
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión e inténtalo de nuevo." });
    } finally {
      setSaving(false);
    }
  }

  const budget = single ? formatBudget(single.daily_budget ?? single.lifetime_budget, currency) : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4" /> {single ? "Duplicar campaña" : `Duplicar ${campaigns.length} campañas`}
          </DialogTitle>
          <DialogDescription className="text-xs space-y-1">
            {single ? (
              <>
                <span className="block font-medium text-foreground truncate">{single.name}</span>
                <span className="flex gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">{single.objective?.replace(/_/g, " ")}</Badge>
                  <Badge variant="outline" className="text-xs">{single.is_cbo ? "CBO" : "ABO"}</Badge>
                  {budget && <Badge variant="outline" className="text-xs">{budget}{single.daily_budget ? "/día" : ""}</Badge>}
                </span>
              </>
            ) : (
              <span className="block max-h-24 overflow-y-auto rounded border bg-muted/30 p-1.5">
                {campaigns.map((c) => <span key={c.id} className="block truncate">{c.name}</span>)}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4 mt-2">
          {single ? (
            <div className="space-y-1.5">
              <Label htmlFor="dup-name">Nombre de la copia</Label>
              <Input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} />
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="dup-prefix">Prefijo para los nombres</Label>
              <Input id="dup-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              <p className="text-[11px] text-muted-foreground truncate">
                Ej.: «{prefix}{campaigns[0]?.name}{count > 1 ? " (1)" : ""}»
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Estado al terminar</Label>
              <Select value={status} onValueChange={(v) => v && setStatus(v as "ACTIVE" | "PAUSED")}>
                <SelectTrigger>
                  <SelectValue>{status === "ACTIVE" ? "Activa" : "Pausada"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAUSED">Pausada</SelectItem>
                  <SelectItem value="ACTIVE">Activa</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dup-count">Copias {single ? "" : "por campaña"}</Label>
              <Input
                id="dup-count" type="number" min={1} max={MAX_COPIES}
                value={countRaw} onChange={(e) => setCountRaw(e.target.value)}
              />
            </div>
          </div>
          {countError && <p className="text-xs text-destructive -mt-2">{countError}</p>}

          {!countError && total > 1 && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
              Se crearán <strong>{total} copias</strong> en un lote numerado
              {count > 1 ? <> («… (1)» a «… ({count})»)</> : null}. Sigue el avance en esta pantalla o en Trabajos.
            </p>
          )}

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground flex items-center gap-1">
              <Briefcase className="h-3 w-3" /> Cómo se procesa
            </p>
            <p>• Cada copia es un trabajo propio: si una falla, las demás siguen.</p>
            <p>• Máximo 2 a la vez por cuenta; si Meta limita la cuenta, se pausa y reanuda sola.</p>
            <p className="flex items-start gap-1">
              <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0" />
              La copia se crea pausada y solo se activa al final si eliges «Activa».
            </p>
          </div>

          {error && <ErrorDetails info={error} />}

          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || !!countError || !!nameError}>
              {saving
                ? <><RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Encolando...</>
                : <><Copy className="h-4 w-4 mr-1" /> {total > 1 ? `Duplicar ×${total}` : "Duplicar"}</>
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
