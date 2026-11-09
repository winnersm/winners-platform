// Cómo se presenta el historial de Trabajos. Sin dependencias: lo usan la página
// y el panel flotante. No toca la base: se calcula sobre los trabajos ya leídos,
// así que también ordena el historial anterior a este cambio.

export interface JobLike {
  id: string;
  type: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  logs: Array<{ ts: string; msg: string }> | null;
  error?: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  accountName?: string | null;
  userName?: string | null;
}

export type JobKind = "campaign" | "adset" | "ad" | "sync" | "pbia" | "pause" | "other";

const KIND_BY_TYPE: Record<string, JobKind> = {
  DUPLICATE_CAMPAIGN: "campaign",
  DUPLICATE_ADSET: "adset",
  DUPLICATE_AD: "ad",
  SYNC_ACTIVE_ADS: "sync",
  CREATE_PBIA_BULK: "pbia",
  PAUSE_CASCADE: "pause",
};
export const kindOf = (type: string): JobKind => KIND_BY_TYPE[type] ?? "other";

/** Envíos seguidos a esta distancia cuentan como una misma tanda. */
const GROUP_GAP_MS = 5 * 60 * 1000;
/** Tiempo que un error sigue en la pestaña «Con error»; después, solo en Historial. */
const ERROR_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface JobGroup<T extends JobLike> {
  key: string;
  kind: JobKind;
  /** Lote real (se puede cancelar de una vez). Las tandas automáticas no tienen. */
  batchId?: string;
  jobs: T[];
}

const time = (iso: string) => new Date(iso).getTime();

/**
 * Agrupa los trabajos, que llegan del más reciente al más antiguo:
 *  - los de un mismo lote, siempre;
 *  - los duplicados de ad sets y anuncios enviados seguidos a la misma cuenta
 *    por la misma persona: cada envío es un trabajo, pero para quien los lanzó
 *    fueron una sola tanda.
 */
export function groupJobs<T extends JobLike>(jobs: T[]): JobGroup<T>[] {
  const out: JobGroup<T>[] = [];
  const batches = new Map<string, JobGroup<T>>();
  const open = new Map<string, JobGroup<T>>();

  for (const job of jobs) {
    const kind = kindOf(job.type);
    const input = job.input ?? {};
    const batchId = typeof input.batchId === "string" && Number(input.total) > 1 ? input.batchId : null;

    if (batchId) {
      const existing = batches.get(batchId);
      if (existing) { existing.jobs.push(job); continue; }
      const group: JobGroup<T> = { key: batchId, kind, batchId, jobs: [job] };
      batches.set(batchId, group);
      out.push(group);
      continue;
    }

    if (kind === "adset" || kind === "ad") {
      const tanda = `${job.type}|${String(input.accountId ?? "")}|${job.createdBy ?? ""}`;
      const current = open.get(tanda);
      const previous = current?.jobs[current.jobs.length - 1];
      if (current && previous && time(previous.createdAt) - time(job.createdAt) <= GROUP_GAP_MS) {
        current.jobs.push(job);
        continue;
      }
      const group: JobGroup<T> = { key: job.id, kind, jobs: [job] };
      open.set(tanda, group);
      out.push(group);
      continue;
    }

    out.push({ key: job.id, kind, jobs: [job] });
  }
  return out;
}

const numberOf = (v: unknown) => (typeof v === "number" ? v : 0);
const listOf = (v: unknown) => (Array.isArray(v) ? v : []);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Parte común de nombres como «[#1]-[SugarReset]-[Enoch…]»: «SugarReset». */
function commonTags(names: string[]): string | null {
  const tags = (name: string) => [...name.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]).filter(t => !/^#\d+$/.test(t));
  const [first, ...rest] = names.map(tags);
  const common = (first ?? []).filter(tag => rest.every(list => list.includes(tag)));
  return common.length ? common.join(" · ") : null;
}

function subjectOf(kind: JobKind, jobs: JobLike[]): string {
  const input = (j: JobLike) => j.input ?? {};
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

  if (kind === "campaign") {
    const names = unique(jobs.map(j => String(input(j).baseName ?? input(j).name ?? "").replace(/ \(\d+\)$/, "")));
    if (names.length <= 1) return names[0] ?? "Campaña";
    return commonTags(names) ?? plural(names.length, "campaña", "campañas");
  }
  if (kind === "adset" || kind === "ad") {
    const key = kind === "adset" ? "targetCampaignName" : "targetAdsetName";
    const fallback = kind === "adset" ? "targetCampaignId" : "targetAdsetId";
    const names = unique(jobs.map(j => String(input(j)[key] ?? input(j)[fallback] ?? "")));
    if (names.length <= 1) return names[0] ?? (kind === "adset" ? "Ad sets" : "Anuncios");
    return commonTags(names) ?? `${names[0]} y ${names.length - 1} más`;
  }
  if (kind === "pause") {
    const names = unique(jobs.map(j => String(input(j).name ?? input(j).entityId ?? "")));
    return `Pausar ${names.length <= 1 ? names[0] || "campaña" : plural(names.length, "campaña", "campañas")} y lo que tiene debajo`;
  }
  if (kind === "sync") return "Conteo de ads activos";
  if (kind === "pbia") return "Crear cuentas de Instagram (PBIA)";
  return "Trabajo";
}

function resultOf(kind: JobKind, jobs: JobLike[]): string {
  const done = jobs.filter(j => j.status === "completed").length;

  if (kind === "campaign") {
    const total = Number(jobs[0]?.input?.total) || jobs.length;
    if (total === 1) return "1 copia";
    return `${done} de ${total} copias`;
  }
  if (kind === "adset") {
    const expected = jobs.reduce((n, j) => n + listOf(j.input?.adsetIds).length * (Number(j.input?.count) || 1), 0);
    const created = jobs.reduce((n, j) => n + numberOf(j.output?.adsetsCount), 0);
    return created === expected ? plural(created, "copia", "copias") : `${created} de ${plural(expected, "copia", "copias")}`;
  }
  if (kind === "ad") {
    const expected = jobs.reduce((n, j) => n + listOf(j.input?.ads).length, 0);
    const created = jobs.reduce((n, j) => n + numberOf(j.output?.adsCount), 0);
    return created === expected ? plural(created, "anuncio", "anuncios") : `${created} de ${plural(expected, "anuncio", "anuncios")}`;
  }
  if (kind === "pause") {
    const sets = jobs.reduce((n, j) => n + numberOf(j.output?.pausedAdsets), 0);
    const ads = jobs.reduce((n, j) => n + numberOf(j.output?.pausedAds), 0);
    const failed = jobs.reduce((n, j) => n + numberOf(j.output?.failed), 0);
    return `${plural(sets, "ad set", "ad sets")} y ${plural(ads, "anuncio", "anuncios")} pausados${failed ? ` · ${failed} con error` : ""}`;
  }
  if (kind === "sync") {
    const o = jobs[0]?.output;
    return o ? `${numberOf(o.totalActive)} ads activos en ${plural(numberOf(o.accounts), "cuenta", "cuentas")}` : "";
  }
  if (kind === "pbia") {
    const o = jobs[0]?.output;
    const pages = listOf(jobs[0]?.input?.pageIds).length;
    return o ? `${numberOf(o.ok)} de ${plural(numberOf(o.total) || pages, "página", "páginas")}` : plural(pages, "página", "páginas");
  }
  return "";
}

/** Espera en cola y trabajo real, con los logs: los trabajos no guardan cuándo empezaron. */
function timesOf(jobs: JobLike[]): { queueMs: number | null; workMs: number | null } {
  const logged = jobs.flatMap(j => (j.logs ?? []).map(l => time(l.ts))).filter(Number.isFinite);
  if (logged.length === 0) return { queueMs: null, workMs: null };
  const created = Math.min(...jobs.map(j => time(j.createdAt)));
  const started = Math.min(...logged);
  return { queueMs: Math.max(0, started - created), workMs: Math.max(...logged) - started };
}

export function describeGroup(kind: JobKind, jobs: JobLike[]) {
  const count = (status: string) => jobs.filter(j => j.status === status).length;
  const counts = {
    completed: count("completed"), failed: count("failed"), cancelled: count("cancelled"),
    processing: count("processing"), pending: count("pending"),
  };
  const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => !!v))];
  const accounts = unique(jobs.map(j => j.accountName ?? (j.input?.accountId as string | undefined)));
  const people = unique(jobs.map(j => j.userName));
  const failed = jobs.filter(j => j.status === "failed");
  const errors = unique(failed.map(j => (j.output?.error as { title?: string } | undefined)?.title ?? j.error ?? "Error"));
  const waits = jobs
    .filter(j => j.status === "pending")
    .map(j => j.output?.waiting as { reason?: string; until?: string } | undefined)
    .filter((w): w is { reason: string; until?: string } => !!w?.reason);
  return {
    subject: subjectOf(kind, jobs),
    result: resultOf(kind, jobs),
    counts,
    active: counts.processing + counts.pending,
    errors,
    /** Prioriza el aviso de límite de Meta sobre «cuenta ocupada». */
    waiting: waits.find(w => /Meta/.test(w.reason)) ?? waits[0] ?? null,
    withIssues: jobs.filter(j => j.status === "completed" && listOf(j.output?.issues).length > 0).length,
    account: accounts.length > 1 ? `${accounts.length} cuentas` : accounts[0] ?? null,
    person: people.length > 1 ? `${people.length} personas` : people[0] ?? null,
    createdAt: jobs[jobs.length - 1]?.createdAt ?? "",
    ...timesOf(jobs),
  };
}

export function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Nombre corto de la cuenta: «#3025 - ROAS 1 - Grupo Winners…» → «ROAS 1». */
export function shortAccount(name: string | null): string | null {
  if (!name) return null;
  const m = /^#\d+\s*-\s*([^-[]+)/.exec(name);
  return m ? m[1].trim() : name;
}

/** Cuándo, en palabras: «hace 12 min», «ayer», «27 oct». */
export function timeAgo(iso: string, now: number): string {
  if (!iso || !now) return "";
  const date = new Date(iso);
  const mins = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 12 * 60) return `hace ${Math.round(mins / 60)} h`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(date)) / (24 * 3600 * 1000));
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  return date.toLocaleDateString("es-CO", {
    day: "numeric", month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

export type JobTone = "info" | "muted" | "danger" | "warning" | "success";

/** Estado del grupo en una palabra. */
export function statusOf(info: ReturnType<typeof describeGroup>): { label: string; tone: JobTone } {
  const { counts, active, withIssues } = info;
  const total = counts.completed + counts.failed + counts.cancelled + active;
  if (counts.processing > 0) return { label: "En curso", tone: "info" };
  if (active > 0) return { label: "En cola", tone: "muted" };
  if (counts.failed === total) return { label: "Falló", tone: "danger" };
  if (counts.failed > 0) return { label: "Con errores", tone: "danger" };
  if (counts.cancelled === total) return { label: "Cancelado", tone: "muted" };
  if (withIssues > 0) return { label: "Con avisos", tone: "warning" };
  return { label: "Listo", tone: "success" };
}

export type JobTab = "active" | "failed" | "history";

/** Cifras de las pestañas: trabajos, igual que el botón flotante, no filas. */
export function tabCounts<T extends JobLike>(tabs: Record<JobTab, JobGroup<T>[]>) {
  const jobs = (groups: JobGroup<T>[], match: (status: string) => boolean) =>
    groups.reduce((n, g) => n + g.jobs.filter(j => match(j.status)).length, 0);
  return {
    active: jobs(tabs.active, s => s === "pending" || s === "processing"),
    failed: jobs(tabs.failed, s => s === "failed"),
  };
}

/** Reparte los grupos en las pestañas. Historial incluye todo lo terminado. */
export function splitByTab<T extends JobLike>(groups: JobGroup<T>[], now: number): Record<JobTab, JobGroup<T>[]> {
  const isRunning = (g: JobGroup<T>) => g.jobs.some(j => j.status === "pending" || j.status === "processing");
  const hasError = (g: JobGroup<T>) => g.jobs.some(j => j.status === "failed" && now - time(j.updatedAt) < ERROR_WINDOW_MS);
  return {
    active: groups.filter(isRunning),
    failed: groups.filter(g => !isRunning(g) && hasError(g)),
    history: groups.filter(g => !isRunning(g)),
  };
}
