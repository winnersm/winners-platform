"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { JobList, JobTabs, type Job } from "@/components/job-list";
import { groupJobs, splitByTab, tabCounts, type JobTab } from "@/lib/job-groups";

export default function JobsView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chosenTab, setChosenTab] = useState<JobTab | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const json = await res.json();
    if (!res.ok) { setError(json.error ?? "Error"); return; }
    setJobs(json.jobs ?? []);
    setNow(Date.now());
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

  const tabs = splitByTab(groupJobs(jobs), now);
  // Sin elegir: lo que pide atención primero.
  const tab: JobTab = chosenTab ?? (tabs.active.length ? "active" : tabs.failed.length ? "failed" : "history");
  const activeCount = jobs.filter(j => j.status === "pending" || j.status === "processing").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
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
          <JobTabs tab={tab} onChange={setChosenTab} counts={tabCounts(tabs)} />
          <Button variant="ghost" size="sm" onClick={load} title="Actualizar">
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
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      ) : (
        <JobList groups={tabs[tab]} tab={tab} now={now} onChanged={load} />
      )}
    </div>
  );
}
