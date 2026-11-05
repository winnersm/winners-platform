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
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  accountName?: string | null;
  userName?: string | null;
}

export type JobKind = "campaign" | "adset" | "ad" | "sync" | "pbia" | "other";

const KIND_BY_TYPE: Record<string, JobKind> = {
  DUPLICATE_CAMPAIGN: "campaign",
  DUPLICATE_ADSET: "adset",
  DUPLICATE_AD: "ad",
  SYNC_ACTIVE_ADS: "sync",
  CREATE_PBIA_BULK: "pbia",
};
export const kindOf = (type: string): JobKind => KIND_BY_TYPE[type] ?? "other";

/** Envíos seguidos a esta distancia cuentan como una misma tanda. */
const GROUP_GAP_MS = 5 * 60 * 1000;
/** Tiempo que un error sigue destacado arriba antes de pasar al historial. */
const ERROR_HIGHLIGHT_MS = 48 * 3600 * 1000;

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
    const sources = jobs.reduce((n, j) => n + listOf(j.input?.adsetIds).length, 0);
    const expected = jobs.reduce((n, j) => n + listOf(j.input?.adsetIds).length * (Number(j.input?.count) || 1), 0);
    const created = jobs.reduce((n, j) => n + numberOf(j.output?.adsetsCount), 0);
    const copies = created === expected ? plural(created, "copia", "copias") : `${created} de ${plural(expected, "copia", "copias")}`;
    return `${plural(sources, "ad set", "ad sets")} → ${copies}`;
  }
  if (kind === "ad") {
    const expected = jobs.reduce((n, j) => n + listOf(j.input?.ads).length, 0);
    const created = jobs.reduce((n, j) => n + numberOf(j.output?.adsCount), 0);
    return created === expected ? plural(created, "anuncio", "anuncios") : `${created} de ${plural(expected, "anuncio", "anuncios")}`;
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
  return {
    subject: subjectOf(kind, jobs),
    result: resultOf(kind, jobs),
    counts,
    active: counts.processing + counts.pending,
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

export interface JobSection<T extends JobLike> {
  key: string;
  label: string;
  tone?: "active" | "error";
  groups: JobGroup<T>[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 3600 * 1000);
  if (dayKey(date) === dayKey(today)) return "Hoy";
  if (dayKey(date) === dayKey(yesterday)) return "Ayer";
  return date.toLocaleDateString("es-CO", {
    day: "numeric", month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Lo que requiere atención arriba; el resto, por día. */
export function sectionize<T extends JobLike>(groups: JobGroup<T>[], now: number): JobSection<T>[] {
  const active: JobGroup<T>[] = [];
  const failed: JobGroup<T>[] = [];
  const days = new Map<string, JobGroup<T>[]>();

  for (const group of groups) {
    const running = group.jobs.some(j => j.status === "pending" || j.status === "processing");
    const hasRecentError = group.jobs.some(j => j.status === "failed" && now - time(j.updatedAt) < ERROR_HIGHLIGHT_MS);
    if (running) active.push(group);
    else if (hasRecentError) failed.push(group);
    else {
      const label = dayLabel(group.jobs[0].createdAt, now);
      days.set(label, [...(days.get(label) ?? []), group]);
    }
  }

  return [
    ...(active.length ? [{ key: "active", label: "En curso", tone: "active" as const, groups: active }] : []),
    ...(failed.length ? [{ key: "failed", label: "Con error", tone: "error" as const, groups: failed }] : []),
    ...[...days].map(([label, list]) => ({ key: label, label, groups: list })),
  ];
}
