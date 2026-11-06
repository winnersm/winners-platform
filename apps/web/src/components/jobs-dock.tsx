"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Briefcase, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JobList, JobTabs, type Job } from "@/components/job-list";
import { groupJobs, splitByTab, tabCounts, type JobTab } from "@/lib/job-groups";
import { JOBS_DOCK_EVENTS } from "@/lib/jobs-dock-events";

// Panel flotante de Trabajos, disponible en toda la plataforma. No bloquea la
// pantalla: se puede seguir trabajando con él abierto.
//  - Cerrado solo pide contadores (?summary=1), porque corre en todas las páginas.
//  - Abierto pide la lista completa.
const POLL_OPEN_MS = 4_000;
const POLL_ACTIVE_MS = 8_000;
const POLL_IDLE_MS = 60_000;
const SEEN_KEY = "jobs_seen_at";
const DAY_MS = 24 * 3600 * 1000;

const isActive = (j: Job) => j.status === "pending" || j.status === "processing";
const isFailed = (j: Job) => j.status === "failed";

export function JobsDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<JobTab>("active");
  const [summary, setSummary] = useState({ active: 0, failed: 0, lastFailedAt: null as string | null });
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nowTs, setNowTs] = useState(0);
  const openRef = useRef(open);
  const activeRef = useRef(0);
  const wakeRef = useRef<() => void>(() => { });

  const refresh = useCallback(async () => {
    try {
      if (openRef.current) {
        const res = await fetch("/api/jobs");
        if (!res.ok) { setError(true); return; }
        const json = await res.json();
        const list = (json.jobs ?? []) as Job[];
        const now = Date.now();
        const failed = list.filter(j => isFailed(j) && now - new Date(j.updatedAt).getTime() < DAY_MS);
        const active = list.filter(isActive).length;
        activeRef.current = active;
        setJobs(list);
        setNowTs(now);
        setError(false);
        setSummary(s => ({ active, failed: failed.length, lastFailedAt: failed[0]?.updatedAt ?? s.lastFailedAt }));
      } else {
        const res = await fetch("/api/jobs?summary=1");
        if (!res.ok) return;
        const json = await res.json();
        activeRef.current = json.active ?? 0;
        setSummary({ active: json.active ?? 0, failed: json.failed ?? 0, lastFailedAt: json.lastFailedAt ?? null });
      }
    } catch {
      if (openRef.current) setError(true);
    }
  }, []);

  // Consulta periódica; más lenta si no pasa nada y en pausa si la pestaña no se ve.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (stopped) return;
      timer = setTimeout(tick, openRef.current ? POLL_OPEN_MS : activeRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    wakeRef.current = () => { clearTimeout(timer); void tick(); };
    timer = setTimeout(tick, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    openRef.current = open;
    if (open) wakeRef.current();
  }, [open]);

  useEffect(() => {
    const show = () => setOpen(true);
    const changed = () => wakeRef.current();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const load = () => { try { setSeenAt(localStorage.getItem(SEEN_KEY)); } catch { /* sin almacenamiento */ } };
    window.addEventListener(JOBS_DOCK_EVENTS.OPEN, show);
    window.addEventListener(JOBS_DOCK_EVENTS.CHANGED, changed);
    window.addEventListener("keydown", esc);
    const t = setTimeout(load, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener(JOBS_DOCK_EVENTS.OPEN, show);
      window.removeEventListener(JOBS_DOCK_EVENTS.CHANGED, changed);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  function toggle() {
    if (!open) {
      // Al abrir: la pestaña útil (errores nuevos antes que nada) y errores vistos.
      const nowIso = new Date().toISOString();
      setTab(hasNewErrors ? "failed" : "active");
      setSeenAt(nowIso);
      try { localStorage.setItem(SEEN_KEY, nowIso); } catch { /* sin almacenamiento */ }
    }
    setOpen(o => !o);
  }

  async function manualRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const hasNewErrors = summary.failed > 0 && !!summary.lastFailedAt && (!seenAt || summary.lastFailedAt > seenAt);

  // La página de Trabajos ya muestra todo esto.
  if (pathname === "/meta/jobs") return null;

  const recent = (j: Job) => nowTs - new Date(j.updatedAt).getTime() < DAY_MS;
  const list = jobs ?? [];
  const running = list.filter(j => j.status === "processing").length;
  const queued = list.filter(j => j.status === "pending").length;
  const doneToday = list.filter(j => j.status === "completed" && recent(j)).length;
  const failedToday = list.filter(j => isFailed(j) && recent(j)).length;

  const tabs = splitByTab(groupJobs(list), nowTs);

  return (
    <>
      {open && (
        <section
          aria-label="Trabajos"
          className="fixed z-40 bottom-16 right-2 left-2 sm:left-auto sm:right-4 sm:w-[580px] max-h-[75vh] flex flex-col rounded-xl border bg-card shadow-2xl"
        >
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <Briefcase className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Trabajos</h2>
            <div className="ml-auto flex items-center gap-0.5">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={manualRefresh} title="Actualizar">
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </Button>
              <Link href="/meta/jobs" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" title="Abrir página completa">
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setOpen(false)} title="Cerrar (Esc)">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </header>

          {/* Resumen rápido */}
          <div className="grid grid-cols-4 divide-x border-b text-center">
            <Stat label="En curso" value={running} className="text-info" />
            <Stat label="En cola" value={queued} />
            <Stat label="Listos 24 h" value={doneToday} className="text-success" />
            <Stat label="Con error 24 h" value={failedToday} className={failedToday > 0 ? "text-danger" : ""} />
          </div>

          <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
            <JobTabs tab={tab} onChange={setTab} counts={tabCounts(tabs)} withHistory={false} />
            <Link href="/meta/jobs" className="text-xs text-primary hover:underline">Ver historial</Link>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto bg-muted/20 p-2">
            {error && <p className="px-2 py-1 text-xs text-destructive">No se pudo actualizar. Se reintenta solo.</p>}
            {!jobs && !error && (
              <p className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando…
              </p>
            )}
            {jobs && <JobList groups={tabs[tab].slice(0, 30)} tab={tab} now={nowTs} onChanged={refresh} compact />}
          </div>
        </section>
      )}

      <button
        type="button" onClick={toggle} aria-expanded={open}
        title="Trabajos"
        className={`fixed bottom-4 right-4 z-40 inline-flex h-10 items-center gap-2 rounded-full border bg-card px-3 text-xs font-medium shadow-lg transition-colors hover:bg-muted ${hasNewErrors ? "border-danger/40" : ""}`}
      >
        {summary.active > 0
          ? <Loader2 className="h-4 w-4 animate-spin text-info" />
          : <Briefcase className="h-4 w-4 text-muted-foreground" />}
        {summary.active > 0 && <span>{summary.active} activo{summary.active > 1 ? "s" : ""}</span>}
        {hasNewErrors && (
          <span className="inline-flex items-center gap-1 text-danger">
            <span className="h-2 w-2 rounded-full bg-danger" /> {summary.failed} con error
          </span>
        )}
        {summary.active === 0 && !hasNewErrors && <span className="text-muted-foreground">Trabajos</span>}
      </button>
    </>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: number; className?: string }) {
  return (
    <div className="px-2 py-2">
      <p className={`text-base font-semibold tabular-nums ${className}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
