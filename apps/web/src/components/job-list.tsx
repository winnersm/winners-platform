"use client";

import { useState } from "react";
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Loader2, Ban, Trash2, AlertTriangle, ExternalLink,
  Megaphone, Layers, Image as ImageIcon, RefreshCw, Camera, Briefcase,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ErrorDetails, WaitingNote, toastApiError, type ErrorInfo } from "@/components/error-details";
import {
  describeGroup, formatSpan, kindOf, sectionize, type JobGroup, type JobKind,
} from "@/lib/job-groups";

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
  accountName?: string | null;
  userName?: string | null;
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

const describeJob = (job: Job) => describeGroup(kindOf(job.type), [job]);

// Cada tipo de trabajo con su color e icono, para distinguirlos de un vistazo.
const KIND_TAG: Record<JobKind, { label: string; icon: typeof Layers; className: string }> = {
  campaign: { label: "Campañas", icon: Megaphone, className: "bg-blue-50 text-blue-700 border-blue-200" },
  adset: { label: "Ad sets", icon: Layers, className: "bg-violet-50 text-violet-700 border-violet-200" },
  ad: { label: "Anuncios", icon: ImageIcon, className: "bg-amber-50 text-amber-700 border-amber-200" },
  sync: { label: "Sincronización", icon: RefreshCw, className: "bg-slate-50 text-slate-600 border-slate-200" },
  pbia: { label: "PBIA", icon: Camera, className: "bg-pink-50 text-pink-700 border-pink-200" },
  other: { label: "Trabajo", icon: Briefcase, className: "bg-slate-50 text-slate-600 border-slate-200" },
};

function KindTag({ kind }: { kind: JobKind }) {
  const { label, icon: Icon, className } = KIND_TAG[kind];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${className}`}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

/** Cuenta, persona, fecha y tiempos: separa la espera en cola del trabajo real. */
function MetaLine({ info, showDate = true }: { info: ReturnType<typeof describeGroup>; showDate?: boolean }) {
  const parts = [
    info.account,
    info.person,
    showDate && info.createdAt ? fmtDate(info.createdAt) : null,
    info.queueMs != null && info.queueMs >= 60_000 ? `En cola ${formatSpan(info.queueMs)}` : null,
    info.active === 0 && info.workMs != null ? `Trabajó ${formatSpan(info.workMs)}` : null,
  ].filter(Boolean);
  return <span className="text-[11px] text-muted-foreground">{parts.join(" · ")}</span>;
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

export function JobRow({ job, onChanged, compact = false, nested = false }: {
  job: Job; onChanged: () => void; compact?: boolean;
  /** Dentro de un grupo: el tipo y la cuenta ya se ven en la tarjeta. */
  nested?: boolean;
}) {
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
  const info = describeJob(job);
  const kind = kindOf(job.type);
  const result = kind === "campaign" ? outputSummary(job) : info.result;

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
        className={`flex items-center flex-wrap sm:flex-nowrap cursor-pointer hover:bg-muted/20 transition-colors ${compact ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3"}`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="shrink-0">{STATUS_ICONS[job.status] ?? <Clock className="h-4 w-4" />}</div>

        <div className="flex-1 min-w-0 basis-[calc(100%-1.75rem)] sm:basis-0">
          <div className="flex items-center gap-2 min-w-0">
            {!nested && <KindTag kind={kind} />}
            {batch && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0" title={`Lote ${batch.id}`}>
                {batch.seq}/{batch.total}
              </Badge>
            )}
            <span className={`font-semibold truncate ${compact ? "text-xs" : "text-sm"}`} title={info.subject}>{info.subject}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
            {result && <span className={`text-[11px] font-medium ${job.status === "completed" ? "text-green-700" : "text-foreground"}`}>{result}</span>}
            {nested
              ? <span className="text-[11px] text-muted-foreground">{fmtDate(job.createdAt)}</span>
              : <MetaLine info={info} />}
            {job.status === "completed" && issues.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                <AlertTriangle className="h-3 w-3" /> {issues.length} incidencia{issues.length > 1 ? "s" : ""}
              </span>
            )}
            {waiting && <WaitingNote reason={waiting.reason} until={waiting.until} />}
            {job.status === "failed" && job.error && (
              <span className="text-[11px] text-red-600 truncate max-w-full" title={job.error}>{job.error}</span>
            )}
          </div>
        </div>

        <div className={`flex items-center shrink-0 w-full justify-end sm:w-auto ${compact ? "gap-1.5" : "gap-3"}`}>
          {/* «Completado» es lo normal: solo se destaca lo que pide atención. */}
          {!compact && job.status !== "completed" && (
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
            <span className="font-medium">{info.subject}</span>
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

// ─── Grupo ────────────────────────────────────────────────────────────────────
// Una tanda se ve como una sola tarjeta: lo que importa es qué se hizo, cuánto
// va y qué falló. Sirve para los lotes y para los envíos seguidos de ad sets.

/** Barra por colores: verde listas, rojo error, gris canceladas, azul en curso. */
function StatusBar({ counts, total, compact }: {
  counts: { completed: number; failed: number; cancelled: number; processing: number }; total: number; compact: boolean;
}) {
  const parts: Array<[number, string]> = [
    [counts.completed, "bg-green-500"], [counts.failed, "bg-red-500"],
    [counts.cancelled, "bg-slate-400"], [counts.processing, "bg-blue-500"],
  ];
  const finished = counts.completed + counts.failed + counts.cancelled;
  return (
    <div className={compact ? "w-16" : "w-28"}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {parts.map(([n, color]) => n > 0 && <div key={color} className={color} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} />)}
      </div>
      <span className="text-[10px] text-muted-foreground">{finished}/{total}</span>
    </div>
  );
}

function GroupCard({ group, visible, onChanged, compact }: {
  group: JobGroup<Job>; visible?: (job: Job) => boolean; onChanged: () => void; compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { jobs, kind, batchId } = group;

  // Los contadores miran el grupo completo; el filtro solo decide qué filas se despliegan.
  const info = describeGroup(kind, jobs);
  const { counts, active } = info;
  const total = Number(jobs[0]?.input?.total) || jobs.length;
  const withIssues = jobs.filter(j => j.status === "completed" && issuesOf(j).length > 0).length;
  const ordered = jobs
    .filter(j => !visible || visible(j))
    .sort((a, b) => Number(a.input?.seq ?? 0) - Number(b.input?.seq ?? 0) || a.createdAt.localeCompare(b.createdAt));

  // Por qué falló, sin repetir: normalmente todas caen por lo mismo.
  const errorTitles = [...new Set(jobs
    .filter(j => j.status === "failed")
    .map(j => (j.output?.error as ErrorInfo | undefined)?.title ?? j.error ?? "Error"))];
  const limited = jobs.map(j => (j.status === "pending" ? waitingOf(j) : null)).find(w => w && /Meta/.test(w.reason));

  async function cancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`¿Cancelar lo pendiente de este grupo (${active} de ${jobs.length})? Lo ya creado en Meta no se borra.`)) return;
    setCancelling(true);
    try {
      const pending = jobs.filter(j => j.status === "pending" || j.status === "processing");
      const responses = batchId
        ? [await fetch(`/api/jobs?batchId=${batchId}`, { method: "DELETE" })]
        : await Promise.all(pending.map(j => fetch(`/api/jobs/${j.id}`, { method: "DELETE" })));
      const failedRes = responses.find(r => !r.ok);
      if (failedRes) { toastApiError(await failedRes.json().catch(() => ({})), "No se pudo cancelar"); return; }
      toast.success(`${pending.length} trabajo(s) cancelados`);
      onChanged();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setCancelling(false);
    }
  }

  const StatusIcon = active > 0 ? Loader2 : counts.failed > 0 ? XCircle : CheckCircle2;
  const iconClass = active > 0 ? "text-blue-500 animate-spin" : counts.failed > 0 ? "text-red-500" : "text-green-600";

  return (
    <div className={`border rounded-lg bg-white ${active > 0 ? "border-blue-200 shadow-sm" : "border-border"}`}>
      <div className={`flex items-center cursor-pointer hover:bg-muted/20 transition-colors flex-wrap sm:flex-nowrap ${compact ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3"}`} onClick={() => setOpen(o => !o)}>
        <StatusIcon className={`h-4 w-4 shrink-0 ${iconClass}`} />
        <div className="flex-1 min-w-0 basis-[calc(100%-1.75rem)] sm:basis-0">
          <div className="flex items-center gap-2 min-w-0">
            <KindTag kind={kind} />
            <span className={`font-semibold truncate ${compact ? "text-xs" : "text-sm"}`} title={info.subject}>{info.subject}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap text-[11px]">
            <span className={`font-medium ${counts.failed === 0 && active === 0 && counts.cancelled === 0 ? "text-green-700" : "text-foreground"}`}>{info.result}</span>
            {counts.failed > 0 && <span className="text-red-600">{counts.failed} con error</span>}
            {counts.processing > 0 && <span className="text-blue-600">{counts.processing} en curso</span>}
            {counts.pending > 0 && <span className="text-muted-foreground">{counts.pending} en cola</span>}
            {counts.cancelled > 0 && <span className="text-muted-foreground">{counts.cancelled} cancelada{counts.cancelled > 1 ? "s" : ""}</span>}
            {withIssues > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3 w-3" /> {withIssues} con avisos
              </span>
            )}
            <MetaLine info={info} />
          </div>
          {limited && <div className="mt-0.5"><WaitingNote reason={limited.reason} until={limited.until} /></div>}
          {errorTitles.map(t => (
            <p key={t} className="mt-0.5 text-[11px] text-red-600 truncate" title={t}>{t}</p>
          ))}
        </div>

        <div className="flex items-center gap-3 shrink-0 w-full justify-end sm:w-auto">
          <StatusBar counts={counts} total={total} compact={compact} />
          {active > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={cancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              <span className="ml-1 text-xs">{compact ? "Cancelar" : "Cancelar todo"}</span>
            </Button>
          )}
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="border-t p-3 bg-muted/10 space-y-2">
          {ordered.map(j => <JobRow key={j.id} job={j} onChanged={onChanged} compact={compact} nested />)}
        </div>
      )}
    </div>
  );
}

// ─── Secciones ────────────────────────────────────────────────────────────────

/** Lista de Trabajos: lo que pide atención arriba y el historial por día. */
export function JobSections({ groups, now, visible, onChanged, compact = false }: {
  groups: JobGroup<Job>[]; now: number; visible?: (job: Job) => boolean; onChanged: () => void; compact?: boolean;
}) {
  return (
    <>
      {sectionize(groups, now).map(section => (
        <section key={section.key} className="space-y-2">
          <h3 className={`flex items-center gap-2 pt-1 text-xs font-semibold ${section.tone === "error" ? "text-red-600" : section.tone === "active" ? "text-blue-600" : "text-muted-foreground"}`}>
            {section.label} <span className="font-normal">({section.groups.length})</span>
            <span className="h-px flex-1 bg-border" />
          </h3>
          {section.groups.map(g => g.jobs.length > 1
            ? <GroupCard key={g.key} group={g} visible={visible} onChanged={onChanged} compact={compact} />
            : <JobRow key={g.key} job={g.jobs[0]} onChanged={onChanged} compact={compact} />)}
        </section>
      ))}
    </>
  );
}
