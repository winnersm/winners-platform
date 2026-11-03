"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ChevronDown, ChevronRight, Briefcase, CheckCircle2, XCircle, Clock, Loader2, Ban, Trash2, AlertTriangle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ErrorDetails, WaitingNote, toastApiError, type ErrorInfo } from "@/components/error-details";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry { ts: string; msg: string; }

interface Job {
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

function JobRow({ job, onChanged }: { job: Job; onChanged: () => void }) {
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

  async function cancelBatch(e: React.MouseEvent) {
    e.stopPropagation();
    if (!batch || !confirm(`¿Cancelar todo lo pendiente del lote (${batch.total} copias)? Lo ya creado en Meta no se borra.`)) return;
    const res = await fetch(`/api/jobs?batchId=${batch.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { toastApiError(json, "No se pudo cancelar el lote"); return; }
    toast.success(`${json.cancelled ?? 0} trabajo(s) del lote cancelados`);
    onChanged();
  }

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
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="shrink-0">{STATUS_ICONS[job.status] ?? <Clock className="h-4 w-4" />}</div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground">{TYPE_LABELS[job.type] ?? job.type}</span>
            {batch && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0" title={`Lote ${batch.id}`}>
                {batch.seq}/{batch.total}
              </Badge>
            )}
            <span className="text-sm font-semibold truncate">{jobTitle(job)}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
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

        <div className="flex items-center gap-3 shrink-0">
          <Badge variant={STATUS_BADGE[job.status] ?? "outline"} className="text-xs capitalize">
            {job.status}
          </Badge>

          {isActive && (
            <div className="w-24">
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
              <span className="ml-1 text-xs">Cancelar</span>
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

          {(newCampaignId || batch) && (
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
              {batch && isActive && (
                <button type="button" onClick={cancelBatch} className="inline-flex items-center gap-1 text-red-600 hover:underline">
                  <Ban className="h-3 w-3" /> Cancelar todo el lote
                </button>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function JobsView() {

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const json = await res.json();
    if (!res.ok) { setError(json.error ?? "Error"); return; }
    setJobs(json.jobs ?? []);
    setError(null);
  }, []);

  // Primera carga
  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  // Auto-refresh cada 4s mientras haya jobs activos
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === "pending" || j.status === "processing");
    if (!hasActive) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [jobs, load]);

  const filtered = statusFilter === "all"
    ? jobs
    : jobs.filter(j => j.status === statusFilter);

  const activeCount = jobs.filter(j => j.status === "pending" || j.status === "processing").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Trabajos</h1>
          {activeCount > 0 && (
            <Badge variant="default" className="text-xs">
              {activeCount} activo{activeCount > 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1 text-xs">
            {["all", "pending", "processing", "completed", "failed", "cancelled"].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1 rounded border transition-colors capitalize ${
                  statusFilter === s ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-muted/40"
                }`}
              >
                {s === "all" ? "Todos" : s}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded p-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {statusFilter === "all" ? "No hay trabajos todavía" : `No hay trabajos con estado "${statusFilter}"`}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(j => <JobRow key={j.id} job={j} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
