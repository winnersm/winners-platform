"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BatchCard, JobRow, STATUS_LABEL, groupJobs, type Job } from "@/components/job-list";

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

  const groups = groupJobs(jobs).filter(g => statusFilter === "all" || g.jobs.some(j => j.status === statusFilter));

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
                className={`px-2.5 py-1 rounded border transition-colors ${
                  statusFilter === s ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-muted/40"
                }`}
              >
                {s === "all" ? "Todos" : STATUS_LABEL[s] ?? s}
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
      ) : groups.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {statusFilter === "all" ? "No hay trabajos todavía" : `No hay trabajos con estado «${STATUS_LABEL[statusFilter] ?? statusFilter}»`}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map(g => g.batchId
            ? <BatchCard key={g.key} batchId={g.batchId} jobs={g.jobs} visible={statusFilter === "all" ? undefined : j => j.status === statusFilter} onChanged={load} />
            : <JobRow key={g.key} job={g.jobs[0]} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
