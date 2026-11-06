import { AsyncLocalStorage } from "node:async_hooks";
import { redis } from "@/lib/redis";

// Registro de cada llamada HTTP a Meta, para el reporte diario de «Llamadas a Meta».
// Cuenta intentos reales (un reintento es otra llamada; un batch cuenta como una).
// Toda llamada a graph.facebook.com debe pasar por metaFetch; registrar nunca rompe ni
// retrasa la llamada. Solo se guarda el tipo de llamada: la URL lleva el token.

const TZ = "America/Bogota";
const RETENTION_SEC = 90 * 24 * 60 * 60;
const SEP = "\u0001";
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

type Outcome = "ok" | "error" | "limit";

const sourceStore = new AsyncLocalStorage<string>();

/** Atribuye a `source` las llamadas hechas dentro de `fn` (p. ej. el tipo de job). */
export function withMetaSource<T>(source: string, fn: () => T): T {
  return sourceStore.run(source, fn);
}

/** Igual que withMetaSource, para el resto de la petición en curso. */
export function markMetaSource(source: string): void {
  sourceStore.enterWith(source);
}

function dateParts(d: Date): { day: string; hour: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: String(Number(p.hour)) };
}

export function metaCallsToday(): string {
  return dateParts(new Date()).day;
}

const key = (day: string) => `meta:calls:${day}`;
const hoursKey = (day: string) => `meta:calls:${day}:hours`;

/** Tipo de llamada y cuenta a partir de la URL, sin ningún dato sensible. */
export function describeMetaCall(url: string, method = "GET"): { endpoint: string; accountId: string } {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean).slice(1); // sin la versión (/v21.0)
  const accountId = parts[0]?.startsWith("act_") ? parts[0].slice(4) : "";
  const rest = (accountId ? parts.slice(1) : parts).filter((p) => !/^\d+$/.test(p));
  let name = rest.join("/") || (accountId ? "cuenta" : parts.length ? "objeto" : "batch");
  if (name === "insights") {
    const preset = u.searchParams.get("date_preset") ?? (u.searchParams.has("time_range") ? "rango" : "");
    name = ["insights", u.searchParams.get("level"), preset].filter(Boolean).join(" ");
  }
  return { endpoint: `${method.toUpperCase()} ${name}`, accountId };
}

async function outcomeOf(res: Response): Promise<Outcome> {
  if (res.ok) return "ok";
  try {
    const body = await res.clone().json() as { error?: { code?: number } };
    const code = body.error?.code ?? 0;
    return RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014) ? "limit" : "error";
  } catch {
    return "error";
  }
}

async function record(url: string, method: string, outcome: Outcome): Promise<void> {
  try {
    const { endpoint, accountId } = describeMetaCall(url, method);
    const source = sourceStore.getStore() ?? "panel";
    const { day, hour } = dateParts(new Date());
    await redis.pipeline()
      .hincrby(key(day), [source, endpoint, accountId, outcome].join(SEP), 1)
      .hincrby(hoursKey(day), hour, 1)
      .hincrby(hoursKey(day), "total", 1)
      .expire(key(day), RETENTION_SEC)
      .expire(hoursKey(day), RETENTION_SEC)
      .exec();
  } catch {
    // el registro nunca debe afectar a la llamada
  }
}

/** fetch para graph.facebook.com que deja constancia en el reporte diario. */
export async function metaFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    void record(url, method, "error");
    throw e;
  }
  void outcomeOf(res).then((o) => record(url, method, o));
  return res;
}

export interface CallRow { key: string; total: number; errors: number; limited: number }

export interface MetaCallsReport {
  date: string;
  total: number;
  errors: number;
  limited: number;
  hours: number[];
  days: Array<{ date: string; total: number }>;
  bySource: CallRow[];
  byEndpoint: CallRow[];
  byAccount: CallRow[];
  /** Origen + tipo de llamada: lo más accionable para reducir consumo. */
  top: Array<CallRow & { source: string; endpoint: string }>;
}

/** Reporte de un día, con la serie de los últimos 14 días (solo lee Redis). */
export async function readMetaCalls(date: string): Promise<MetaCallsReport> {
  const dates = Array.from({ length: 14 }, (_, i) => dateParts(new Date(Date.now() - i * 86_400_000)).day).reverse();
  const [raw, hoursRaw, totals] = await Promise.all([
    redis.hgetall(key(date)),
    redis.hgetall(hoursKey(date)),
    Promise.all(dates.map((d) => redis.hget(hoursKey(d), "total"))),
  ]);

  const add = (m: Map<string, CallRow>, k: string, n: number, outcome: string) => {
    const r = m.get(k) ?? { key: k, total: 0, errors: 0, limited: 0 };
    r.total += n;
    if (outcome === "error") r.errors += n;
    if (outcome === "limit") r.limited += n;
    m.set(k, r);
  };
  const bySource = new Map<string, CallRow>();
  const byEndpoint = new Map<string, CallRow>();
  const byAccount = new Map<string, CallRow>();
  const top = new Map<string, CallRow>();
  let total = 0, errors = 0, limited = 0;

  for (const [field, value] of Object.entries(raw)) {
    const [source, endpoint, accountId, outcome] = field.split(SEP);
    const n = Number(value);
    total += n;
    if (outcome === "error") errors += n;
    if (outcome === "limit") limited += n;
    add(bySource, source, n, outcome);
    add(byEndpoint, endpoint, n, outcome);
    if (accountId) add(byAccount, accountId, n, outcome);
    add(top, `${source}${SEP}${endpoint}`, n, outcome);
  }

  const sorted = (m: Map<string, CallRow>) => [...m.values()].sort((a, b) => b.total - a.total);
  return {
    date, total, errors, limited,
    hours: Array.from({ length: 24 }, (_, h) => Number(hoursRaw[String(h)] ?? 0)),
    days: dates.map((d, i) => ({ date: d, total: Number(totals[i] ?? 0) })),
    bySource: sorted(bySource),
    byEndpoint: sorted(byEndpoint),
    byAccount: sorted(byAccount),
    top: sorted(top).slice(0, 15).map((r) => {
      const [source, endpoint] = r.key.split(SEP);
      return { ...r, source, endpoint };
    }),
  };
}
