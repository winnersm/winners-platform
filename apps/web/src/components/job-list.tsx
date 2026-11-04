"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Loader2, Ban, Trash2, AlertTriangle, ExternalLink, Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ErrorDetails, WaitingNote, toastApiError, type ErrorInfo } from "@/components/error-details";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry { ts: string; msg: string; }

export interface Job {
  id: string;
  type: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  progress: number;
  logs: LogEntry[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  DUPLICATE_CAMPAIGN: "Duplicar campaña",
  DUPLICATE_ADSET: "Duplicar ad sets",
  DUPLICATE_AD: "Duplicar ads",
  CREATE_PBIA_BULK: "Crear PBIA (masivo)",
  SYNC_ACTIVE_ADS: "Sincronizar ads activos",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-yellow-500" />,
  processing: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
  completed: <CheckCircle2 className="h-4 w-4 text-green-600" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  cancelled: <Ban className="h-4 w-4 text-muted-foreground" />,
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "En cola", processing: "En curso", completed: "Completado", failed: "Con error", cancelled: "Cancelado",
};

const STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  processing: "default",
  completed: "outline",
  failed: "destructive",
  cancelled: "secondary",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function duration(createdAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function jobTitle(job: Job): string {
  const inp = job.input ?? {};
  if (job.type === "DUPLICATE_CAMPAIGN") {
    return `${inp.name ?? inp.campaignId ?? "—"}`;
  }
  if (job.type === "DUPLICATE_ADSET") {
    const ids = Array.isArray(inp.adsetIds) ? inp.adsetIds as string[] : [];
    const target = (inp.targetCampaignName as string) || (inp.targetCampaignId as string) || "";
    return `${ids.length} ad set${ids.length !== 1 ? "s" : ""} → ${target}`;
  }
  if (job.type === "DUPLICATE_AD") {
    const ads = Array.isArray(inp.ads) ? inp.ads as unknown[] : [];
    const target = (inp.targetAdsetName as string) || (inp.targetAdsetId as string) || "";
    return `${ads.length} ad${ads.length !== 1 ? "s" : ""} → ${target}`;
  }
  return job.id;
}

function outputSummary(job: Job): string | null {
  if (!job.output) return null;
  const o = job.output;
  const parts: string[] = [];
  const of = (n: unknown, total: unknown) => typeof total === "number" && total !== n ? `${n}/${total}` : `${n}`;
  if (typeof o.adsetsCount === "number") parts.push(`${of(o.adsetsCount, o.adsetsExpected)} adsets`);
  if (typeof o.adsCount === "number") parts.push(`${of(o.adsCount, o.adsExpected)} ads`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface Issue { step: string; name: string; sourceId?: string; error: ErrorInfo }
const STEP_LABEL: Record<string, string> = { campaign: "Campaña", adset: "Ad set", ad: "Anuncio", status: "Estado" };

function issuesOf(job: Job): Issue[] {
  const v = job.output?.issues;
  return Array.isArray(v) ? (v as Issue[]) : [];
}
function waitingOf(job: Job): { reason: string; until?: string } | null {
  const w = job.output?.waiting as { reason?: string; until?: string } | undefined;
  return w?.reason ? { reason: w.reason, until: w.until } : null;
}
function batchOf(job: Job): { id: string; seq: number; total: number } | null {
  const i = job.input ?? {};
  return typeof i.batchId === "string" && typeof i.total === "number" && i.total > 1
    ? { id: i.batchId, seq: Number(i.seq ?? 0), total: i.total }
    : null;
}

// ─── Row ──────────────────────────────────────────────────────────────────────

export function JobRow({ job, onChanged, compact = false }: { job: Job; onChanged: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isActive = job.status === "pending" || job.status === "processing";
  const logs: LogEntry[] = Array.isArray(job.logs) ? job.logs : [];
  const issues = issuesOf(job);
  const waiting = job.status === "pending" ? waitingOf(job) : null;
  const batch = batchOf(job);
  const newCampaignId = typeof job.output?.newCampaignId === "string" ? job.output.newCampaignId : null;
  const accountId = typeof job.input?.accountId === "string" ? job.input.accountId : null;

  function openConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmOpen(true);
  }

  async function doAction() {
    setActing(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toastApiError(json, "No se pudo completar la acción"); return; }
      toast.success(isActive ? "Trabajo cancelado" : "Trabajo eliminado");
      setConfirmOpen(false);
      onChanged();
    } catch {
      toast.error("Error de red");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className={`border rounded-lg bg-white ${isActive ? "border-blue-200 shadow-sm" : "border-border"}`}>
      <div
        className={`flex items-center cursor-pointer hover:bg-muted/20 transition-colors ${compact ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3"}`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="shrink-0">{STATUS_ICONS[job.status] ?? <Clock className="h-4 w-4" />}</div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {!compact && <span className="text-xs font-medium text-muted-foreground">{TYPE_LABELS[job.type] ?? job.type}</span>}
            {batch && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0" title={`Lote ${batch.id}`}>
                {batch.seq}/{batch.total}
              </Badge>
            )}
            <span className={`font-semibold truncate ${compact ? "text-xs" : "text-sm"}`} title={jobTitle(job)}>{jobTitle(job)}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
            <span className="text-[11px] text-muted-foreground">{fmtDate(job.createdAt)}</span>
            {(job.status === "completed" || job.status === "failed") && (
              <span className="text-[11px] text-muted-foreground">{duration(job.createdAt, job.updatedAt)}</span>
            )}
            {job.status === "completed" && outputSummary(job) && (
              <span className="text-[11px] text-green-700">{outputSummary(job)}</span>
            )}
            {job.status === "completed" && issues.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                <AlertTriangle className="h-3 w-3" /> {issues.length} incidencia{issues.length > 1 ? "s" : ""}
              </span>
            )}
            {waiting && <WaitingNote reason={waiting.reason} until={waiting.until} />}
            {job.status === "failed" && job.error && (
              <span className="text-[11px] text-red-600 truncate max-w-[420px]" title={job.error}>{job.error}</span>
            )}
          </div>
        </div>

        <div className={`flex items-center shrink-0 ${compact ? "gap-1.5" : "gap-3"}`}>
          {!compact && (
            <Badge variant={STATUS_BADGE[job.status] ?? "outline"} className="text-xs">
              {STATUS_LABEL[job.status] ?? job.status}
            </Badge>
          )}

          {isActive && (
            <div className={compact ? "w-14" : "w-24"}>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">{job.progress}%</span>
            </div>
          )}

          {isActive ? (
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={openConfirm} disabled={acting}
              title="Cancelar trabajo"
            >
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              {!compact && <span className="ml-1 text-xs">Cancelar</span>}
            </Button>
          ) : (
            <Button
              variant="ghost" size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-red-600 hover:bg-red-50"
              onClick={openConfirm} disabled={acting}
              title="Eliminar del historial"
            >
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          )}

          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="border-t px-4 py-3 bg-muted/10 space-y-3">
          {job.status === "failed" && (
            <ErrorDetails info={job.output?.error as ErrorInfo | undefined} fallback={job.error ?? "El trabajo falló"} />
          )}

          {issues.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-amber-800">
                Se completó, pero {issues.length} elemento{issues.length > 1 ? "s" : ""} no se pudo crear:
              </p>
              {issues.map((it, i) => (
                <div key={i} className="space-y-0.5">
                  <p className="text-[11px] text-muted-foreground">
                    {STEP_LABEL[it.step] ?? it.step}: <span className="font-medium text-foreground">{it.name}</span>
                    {it.sourceId ? <span className="font-mono"> · {it.sourceId}</span> : null}
                  </p>
                  <ErrorDetails info={it.error} variant="warning" compact />
                </div>
              ))}
            </div>
          )}

          {newCampaignId && (
            <div className="flex items-center gap-3 flex-wrap text-xs">
              {newCampaignId && accountId && (
                <a
                  href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId}&selected_campaign_ids=${newCampaignId}`}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" /> Ver copia en Ads Manager
                </a>
              )}
            </div>
          )}

          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Sin logs</p>
          ) : (
            <div className="font-mono text-[11px] space-y-0.5 max-h-60 overflow-y-auto">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                    {new Date(l.ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className={l.msg.startsWith("ERROR") ? "text-red-600" : l.msg.startsWith("PAUSA") ? "text-amber-700" : "text-foreground"}>{l.msg}</span>
                </div>
              ))}
            </div>
          )}

          <div className="text-[10px] text-muted-foreground/60 font-mono">
            ID: {job.id}{batch ? ` · lote ${batch.id}` : ""}
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(v) => !acting && setConfirmOpen(v)}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isActive
                ? <><Ban className="h-4 w-4 text-red-600" /> Cancelar trabajo</>
                : <><Trash2 className="h-4 w-4 text-red-600" /> Eliminar trabajo</>}
            </DialogTitle>
            <DialogDescription>
              {isActive
                ? "Se detendrá el trabajo en curso. Lo ya creado en Meta (campaña, adsets, ads) no se borra."
                : "Se quitará este trabajo del historial. No afecta nada en Meta."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{TYPE_LABELS[job.type] ?? job.type}: </span>
            <span className="font-medium">{jobTitle(job)}</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={acting}>
              Volver
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={doAction} disabled={acting}
            >
              {acting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> {isActive ? "Cancelando…" : "Eliminando…"}</>
                : isActive ? "Sí, cancelar" : "Sí, eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Lote ─────────────────────────────────────────────────────────────────────
// Una tanda de copias se ve como una sola tarjeta: de 50 filas sueltas, lo que
// importa es cuántas van, cuántas fallaron y por qué.

export function BatchCard({ batchId, jobs, visible, onChanged, compact = false }: {
  batchId: string; jobs: Job[]; visible?: (job: Job) => boolean; onChanged: () => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Los contadores miran el lote completo; el filtro solo decide qué filas se despliegan.
  const ordered = jobs
    .filter(j => !visible || visible(j))
    .sort((a, b) => Number(a.input?.seq ?? 0) - Number(b.input?.seq ?? 0));
  const total = Number(jobs[0]?.input?.total ?? jobs.length);
  const by = (st: string) => jobs.filter(j => j.status === st).length;
  const done = by("completed"), failed = by("failed"), cancelled = by("cancelled");
  const running = by("processing"), queued = by("pending");
  const withIssues = jobs.filter(j => j.status === "completed" && issuesOf(j).length > 0).length;
  const active = running + queued;
  const pct = Math.round(((done + failed + cancelled) / Math.max(1, total)) * 100);

  // Nombre base sin el «(n)» de cada copia.
  const names = [...new Set(jobs.map(j => String(j.input?.name ?? "").replace(/ \(\d+\)$/, "")))];
  const title = names.length === 1 ? names[0] : `${names.length} campañas`;

  // Por qué falló, sin repetir: normalmente todas caen por lo mismo.
  const errorTitles = [...new Set(jobs
    .filter(j => j.status === "failed")
    .map(j => (j.output?.error as ErrorInfo | undefined)?.title ?? j.error ?? "Error"))];
  const limited = jobs.map(j => (j.status === "pending" ? waitingOf(j) : null)).find(w => w && /Meta/.test(w.reason));

  async function cancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`¿Cancelar lo pendiente de este lote (${active} de ${total})? Lo ya creado en Meta no se borra.`)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/jobs?batchId=${batchId}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toastApiError(json, "No se pudo cancelar el lote"); return; }
      toast.success(`${json.cancelled ?? 0} trabajo(s) del lote cancelados`);
      onChanged();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setCancelling(false);
    }
  }

  const StatusIcon = failed > 0 ? XCircle : active > 0 ? Loader2 : CheckCircle2;
  const iconClass = failed > 0 ? "text-red-500" : active > 0 ? "text-blue-500 animate-spin" : "text-green-600";

  return (
    <div className={`border rounded-lg bg-white ${active > 0 ? "border-blue-200 shadow-sm" : "border-border"}`}>
      <div className={`flex items-center cursor-pointer hover:bg-muted/20 transition-colors ${compact ? "gap-2 px-3 py-2 flex-wrap sm:flex-nowrap" : "gap-3 px-4 py-3"}`} onClick={() => setOpen(o => !o)}>
        <StatusIcon className={`h-4 w-4 shrink-0 ${iconClass}`} />
        <div className={`flex-1 min-w-0 ${compact ? "basis-[calc(100%-1.5rem)] sm:basis-0" : ""}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Layers className="h-3 w-3" /> Lote{compact ? "" : ` · ${TYPE_LABELS[jobs[0].type] ?? jobs[0].type}`}
            </span>
            <span className={`font-semibold truncate ${compact ? "text-xs" : "text-sm"}`} title={title}>{title}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap text-[11px]">
            <span className="text-muted-foreground">{fmtDate(jobs[jobs.length - 1].createdAt)}</span>
            <span className="font-medium">{total} copias</span>
            <span className="text-green-700">{done} listas</span>
            {failed > 0 && <span className="text-red-600">{failed} con error</span>}
            {running > 0 && <span className="text-blue-600">{running} en curso</span>}
            {queued > 0 && <span className="text-muted-foreground">{queued} en cola</span>}
            {cancelled > 0 && <span className="text-muted-foreground">{cancelled} canceladas</span>}
            {withIssues > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3 w-3" /> {withIssues} con avisos
              </span>
            )}
          </div>
          {limited && <div className="mt-0.5"><WaitingNote reason={limited.reason} until={limited.until} /></div>}
          {errorTitles.map(t => (
            <p key={t} className="mt-0.5 text-[11px] text-red-600 truncate" title={t}>{t}</p>
          ))}
        </div>

        <div className={`flex items-center gap-3 shrink-0 ${compact ? "w-full justify-end sm:w-auto" : ""}`}>
          <div className={compact ? "w-16" : "w-28"}>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${failed > 0 ? "bg-amber-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground">{done + failed + cancelled}/{total}</span>
          </div>
          {active > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={cancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              <span className="ml-1 text-xs">{compact ? "Cancelar" : "Cancelar lote"}</span>
            </Button>
          )}
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="border-t p-3 bg-muted/10 space-y-2">
          {ordered.map(j => <JobRow key={j.id} job={j} onChanged={onChanged} compact={compact} />)}
        </div>
      )}
    </div>
  );
}

// Junta los trabajos de un mismo lote en la posición del más reciente.
export function groupJobs(jobs: Job[]): Array<{ key: string; batchId?: string; jobs: Job[] }> {
  const out: Array<{ key: string; batchId?: string; jobs: Job[] }> = [];
  const seen = new Map<string, Job[]>();
  for (const j of jobs) {
    const b = batchOf(j);
    if (!b) { out.push({ key: j.id, jobs: [j] }); continue; }
    const list = seen.get(b.id);
    if (list) { list.push(j); continue; }
    const group = [j];
    seen.set(b.id, group);
    out.push({ key: b.id, batchId: b.id, jobs: group });
  }
  return out;
}

