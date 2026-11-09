"use client";

import { useState } from "react";
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Loader2, Ban, Trash2, ExternalLink,
  Megaphone, Layers, Image as ImageIcon, RefreshCw, Camera, Briefcase,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ErrorDetails, WaitingNote, toastApiError, type ErrorInfo } from "@/components/error-details";
import {
  describeGroup, formatSpan, kindOf, shortAccount, statusOf, timeAgo,
  type JobGroup, type JobKind, type JobTab, type JobTone,
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

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-warning" />,
  processing: <Loader2 className="h-4 w-4 text-info animate-spin" />,
  completed: <CheckCircle2 className="h-4 w-4 text-success" />,
  failed: <XCircle className="h-4 w-4 text-danger" />,
  cancelled: <Ban className="h-4 w-4 text-muted-foreground" />,
};

const TONE: Record<JobTone, string> = {
  info: "bg-info-soft text-info",
  muted: "bg-muted text-muted-foreground",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
};

const KIND: Record<JobKind, { label: string; icon: typeof Layers }> = {
  campaign: { label: "Campañas", icon: Megaphone },
  adset: { label: "Ad sets", icon: Layers },
  ad: { label: "Anuncios", icon: ImageIcon },
  sync: { label: "Sincronización", icon: RefreshCw },
  pbia: { label: "PBIA", icon: Camera },
  pause: { label: "Pausas", icon: RefreshCw },
  other: { label: "Trabajo", icon: Briefcase },
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface Issue { step: string; name: string; sourceId?: string; error: ErrorInfo }
const STEP_LABEL: Record<string, string> = { campaign: "Campaña", adset: "Ad set", ad: "Anuncio", status: "Estado" };

function issuesOf(job: Job): Issue[] {
  const v = job.output?.issues;
  return Array.isArray(v) ? (v as Issue[]) : [];
}

// ─── Detalle de un trabajo ────────────────────────────────────────────────────

function JobDetail({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const logs: LogEntry[] = Array.isArray(job.logs) ? job.logs : [];
  const issues = issuesOf(job);
  const info = describeGroup(kindOf(job.type), [job]);
  const isActive = job.status === "pending" || job.status === "processing";
  const newCampaignId = typeof job.output?.newCampaignId === "string" ? job.output.newCampaignId : null;
  const accountId = typeof job.input?.accountId === "string" ? job.input.accountId.replace("act_", "") : null;
  const times = [
    info.queueMs != null && info.queueMs >= 60_000 ? `En cola ${formatSpan(info.queueMs)}` : null,
    info.workMs != null && !isActive ? `Trabajó ${formatSpan(info.workMs)}` : null,
    info.account,
    fmtDate(job.createdAt),
  ].filter(Boolean);

  async function remove() {
    if (!confirm("¿Quitar este trabajo del historial? No afecta nada en Meta.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (!res.ok) { toastApiError(await res.json().catch(() => ({})), "No se pudo eliminar"); return; }
      toast.success("Trabajo eliminado");
      onChanged();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-3">
      {job.status === "failed" && (
        <ErrorDetails info={job.output?.error as ErrorInfo | undefined} fallback={job.error ?? "El trabajo falló"} />
      )}

      {issues.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-warning">
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

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
        <span className="text-muted-foreground">{times.join(" · ")}</span>
        {newCampaignId && accountId && (
          <a
            href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId}&selected_campaign_ids=${newCampaignId}`}
            target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Ver copia en Ads Manager
          </a>
        )}
        {!isActive && (
          <button type="button" onClick={remove} disabled={deleting} className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-danger disabled:opacity-50">
            <Trash2 className="h-3 w-3" /> Quitar del historial
          </button>
        )}
      </div>

      {logs.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">Sin registro de actividad</p>
      ) : (
        <div className="font-mono text-[11px] space-y-0.5 max-h-48 overflow-y-auto">
          {logs.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {new Date(l.ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className={l.msg.startsWith("ERROR") ? "text-danger" : l.msg.startsWith("PAUSA") ? "text-warning" : "text-foreground"}>{l.msg}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground font-mono">ID: {job.id}</p>
    </div>
  );
}

/** Una copia dentro de un grupo. */
function ChildRow({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const info = describeGroup(kindOf(job.type), [job]);
  const seq = job.input?.seq != null && Number(job.input?.total) > 1 ? `${job.input.seq}/${job.input.total}` : null;
  return (
    <div className="rounded-md border bg-card">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
        {STATUS_ICONS[job.status] ?? <Clock className="h-4 w-4" />}
        {seq && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{seq}</span>}
        <span className="flex-1 truncate text-xs font-medium" title={info.subject}>{info.subject}</span>
        {info.result && <span className="shrink-0 text-[11px] text-muted-foreground">{info.result}</span>}
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {job.status === "failed" && !open && job.error && (
        <p className="truncate px-3 pb-2 text-[11px] text-danger" title={job.error}>{job.error}</p>
      )}
      {open && <div className="border-t p-3"><JobDetail job={job} onChanged={onChanged} /></div>}
    </div>
  );
}

// ─── Fila ─────────────────────────────────────────────────────────────────────

const COLUMNS = "lg:grid-cols-[104px_minmax(0,1fr)_128px_128px_84px_92px_20px]";

function ProgressBar({ counts, total }: {
  counts: { completed: number; failed: number; cancelled: number; processing: number }; total: number;
}) {
  const parts: Array<[number, string]> = [
    [counts.completed, "bg-success"], [counts.failed, "bg-danger"],
    [counts.cancelled, "bg-muted-foreground/50"], [counts.processing, "bg-info"],
  ];
  return (
    <div className="flex h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
      {parts.map(([n, color]) => n > 0 && <div key={color} className={color} style={{ width: `${(n / Math.max(1, total)) * 100}%` }} />)}
    </div>
  );
}

function JobEntry({ group, tab, now, onChanged, compact }: {
  group: JobGroup<Job>; tab: JobTab; now: number; onChanged: () => void; compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { jobs, kind, batchId } = group;
  const info = describeGroup(kind, jobs);
  const status = statusOf(info);
  const { counts, active } = info;
  const total = Number(jobs[0]?.input?.total) || jobs.length;
  const single = jobs.length === 1;
  const Kind = KIND[kind];
  const finished = counts.completed + counts.failed + counts.cancelled;
  const account = shortAccount(info.account);

  // En «Con error» el grupo se despliega mostrando solo lo que falló.
  const children = jobs
    .filter(j => tab !== "failed" || j.status === "failed")
    .sort((a, b) => Number(a.input?.seq ?? 0) - Number(b.input?.seq ?? 0) || a.createdAt.localeCompare(b.createdAt));

  async function cancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`¿Cancelar ${active} trabajo${active > 1 ? "s" : ""} pendiente${active > 1 ? "s" : ""}? Lo ya creado en Meta no se borra.`)) return;
    setCancelling(true);
    try {
      const pending = jobs.filter(j => j.status === "pending" || j.status === "processing");
      const responses = batchId
        ? [await fetch(`/api/jobs?batchId=${batchId}`, { method: "DELETE" })]
        : await Promise.all(pending.map(j => fetch(`/api/jobs/${j.id}`, { method: "DELETE" })));
      const bad = responses.find(r => !r.ok);
      if (bad) { toastApiError(await bad.json().catch(() => ({})), "No se pudo cancelar"); return; }
      toast.success(`${pending.length} trabajo${pending.length > 1 ? "s" : ""} cancelado${pending.length > 1 ? "s" : ""}`);
      onChanged();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setCancelling(false);
    }
  }

  const hasNote = active > 0 || info.errors.length > 0;

  return (
    <div className={compact ? "rounded-md border bg-card" : "border-b last:border-b-0"}>
      <div
        role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => !o); } }}
        className={`cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${compact ? "px-3 py-2" : "px-4 py-2.5"}`}
      >
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${compact ? "" : `lg:grid lg:gap-x-3 ${COLUMNS}`}`}>
          <span className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${TONE[status.tone]}`}>
            {status.tone === "info" && <Loader2 className="h-3 w-3 animate-spin" />}
            {status.label}
          </span>

          <span className={`flex min-w-0 items-center gap-1.5 w-full order-first ${compact ? "" : "lg:order-none lg:w-auto"}`}>
            <Kind.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 text-xs text-muted-foreground">{Kind.label}</span>
            <span className="text-xs text-muted-foreground" aria-hidden>·</span>
            <span className="truncate text-sm font-medium" title={info.subject}>{info.subject}</span>
          </span>

          <span className="text-sm font-medium tabular-nums">{info.result}</span>
          <span className="truncate text-xs text-muted-foreground" title={info.account ?? ""}>{account}</span>
          <span className="truncate text-xs text-muted-foreground">{info.person}</span>
          <span className="text-xs text-muted-foreground" title={info.createdAt ? fmtDate(info.createdAt) : ""}>{timeAgo(info.createdAt, now)}</span>
          {open
            ? <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground ${compact ? "" : "lg:ml-0"}`} aria-hidden />
            : <ChevronRight className={`ml-auto h-4 w-4 text-muted-foreground ${compact ? "" : "lg:ml-0"}`} aria-hidden />}
        </div>

        {/* Solo aparece si hay algo que seguir o resolver */}
        {hasNote && (
          <div className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 ${compact ? "" : "lg:pl-[116px]"}`}>
            {active > 0 && (
              <>
                <ProgressBar counts={counts} total={total} />
                <span className="text-xs text-muted-foreground">{finished} de {total} listos</span>
              </>
            )}
            {info.waiting && <WaitingNote reason={info.waiting.reason} until={info.waiting.until} />}
            {info.errors.map(t => <span key={t} className="max-w-full truncate text-xs text-danger" title={t}>{t}</span>)}
            {active > 0 && (
              <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger" onClick={cancel} disabled={cancelling}>
                {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                <span className="ml-1 text-xs">Cancelar</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="space-y-2 border-t bg-muted/30 p-3">
          {single
            ? <JobDetail job={jobs[0]} onChanged={onChanged} />
            : children.map(j => <ChildRow key={j.id} job={j} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  );
}

// ─── Lista ────────────────────────────────────────────────────────────────────

const TAB_LABEL: Record<JobTab, string> = { active: "Activos", failed: "Con error", history: "Historial" };
const EMPTY: Record<JobTab, string> = {
  active: "No hay trabajos en curso",
  failed: "Sin errores en los últimos 7 días",
  history: "Todavía no hay trabajos terminados",
};

/** Pestañas compartidas por la página y el panel flotante. */
export function JobTabs({ tab, onChange, counts, withHistory = true }: {
  tab: JobTab; onChange: (tab: JobTab) => void; counts: { active: number; failed: number }; withHistory?: boolean;
}) {
  const items: JobTab[] = withHistory ? ["active", "failed", "history"] : ["active", "failed"];
  return (
    <div className="flex items-center gap-1 text-xs" role="tablist">
      {items.map(id => {
        const count = id === "active" ? counts.active : id === "failed" ? counts.failed : null;
        return (
          <button
            key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onChange(id)}
            className={`rounded px-2.5 py-1 transition-colors ${tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            {TAB_LABEL[id]}{count != null ? ` (${count})` : ""}
          </button>
        );
      })}
    </div>
  );
}

export function JobList({ groups, tab, now, onChanged, compact = false }: {
  groups: JobGroup<Job>[]; tab: JobTab; now: number; onChanged: () => void; compact?: boolean;
}) {
  if (groups.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{EMPTY[tab]}</p>;
  }

  const rows = groups.map(g => <JobEntry key={g.key} group={g} tab={tab} now={now} onChanged={onChanged} compact={compact} />);
  if (compact) return <div className="space-y-2">{rows}</div>;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className={`hidden border-b bg-muted/40 px-4 py-2 text-[10px] font-semibold tracking-wide text-muted-foreground lg:grid lg:gap-x-3 ${COLUMNS}`}>
        <span>ESTADO</span>
        <span>QUÉ SE HIZO</span>
        <span>RESULTADO</span>
        <span>CUENTA</span>
        <span>QUIÉN</span>
        <span>CUÁNDO</span>
        <span />
      </div>
      {rows}
    </div>
  );
}
