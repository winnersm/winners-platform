import { AsyncLocalStorage } from "node:async_hooks";
import { META_CALL_LOG_DAYS, META_CALL_LOG_MAX_PER_HOUR, explainCall, type MetaCallFacts } from "@/lib/meta-calls-explain";
import { redis } from "@/lib/redis";

// Registro de cada llamada HTTP a Meta, para el reporte diario de «Llamadas a Meta».
// Cuenta intentos reales (un reintento es otra llamada; un batch cuenta como una).
// Toda llamada a graph.facebook.com debe pasar por metaFetch; registrar nunca rompe ni
// retrasa la llamada. Nunca se guarda la URL (lleva el token) ni un valor enviado: solo
// el tipo de llamada, los nombres de los campos y unos pocos parámetros inocuos.
//
// Además del total del día hay un detalle llamada a llamada, en una lista de Redis por
// hora. Pesa bastante más que los contadores: por eso dura menos y tiene tope. Mismo
// formato en services/*/src/meta_calls.py.

const TZ = "America/Bogota";
const RETENTION_SEC = 90 * 24 * 60 * 60;
const LOG_RETENTION_SEC = META_CALL_LOG_DAYS * 24 * 60 * 60;
const LOG_PAGE_SIZE = 100;
const SEP = "\u0001";
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const QUERY_KEYS = ["fields", "level", "date_preset", "time_range", "time_increment", "limit", "breakdowns", "type"];
const MAX_VALUE = 200;
const MAX_BODY_KEYS = 20;
const MAX_BATCH_ITEMS = 5;
// Lo pone proxy.ts en cada petición: es lo que dice qué ruta hizo la llamada.
const ROUTE_HEADER = "x-meta-route";

type Outcome = "ok" | "error" | "limit";

const sourceStore = new AsyncLocalStorage<{ source: string; route?: string }>();

/** Atribuye a `source` (y a `route`, si no hay petición web) las llamadas hechas dentro de `fn`. */
export function withMetaSource<T>(source: string, fn: () => T, route?: string): T {
  return sourceStore.run({ source, route }, fn);
}

/** Igual que withMetaSource, para el resto de la petición en curso. */
export function markMetaSource(source: string): void {
  sourceStore.enterWith({ source });
}

/** Ruta y pantalla de la petición en curso. Fuera de una petición web no hay ninguna. */
async function requestOrigin(): Promise<{ route: string; page: string }> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const referer = h.get("referer");
    return {
      route: (h.get(ROUTE_HEADER) ?? "").slice(0, MAX_VALUE),
      page: referer ? new URL(referer).pathname.slice(0, MAX_VALUE) : "",
    };
  } catch {
    return { route: "", page: "" };
  }
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
const logKey = (day: string, hour: string | number) => `meta:calls:${day}:log:${hour}`;

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

/** Lo que se puede guardar de los parámetros: nunca el token ni los cursores. */
function safeQuery(params: URLSearchParams): Record<string, string> | undefined {
  const q = Object.fromEntries(
    QUERY_KEYS.flatMap((k) => { const v = params.get(k); return v ? [[k, v.slice(0, MAX_VALUE)]] : []; }),
  );
  return Object.keys(q).length ? q : undefined;
}

function bodyEntries(body: RequestInit["body"]): Array<[string, unknown]> {
  if (body instanceof URLSearchParams || body instanceof FormData) return [...body.entries()];
  if (typeof body !== "string") return [];
  try {
    if (body.trimStart().startsWith("{")) return Object.entries(JSON.parse(body) as Record<string, unknown>);
  } catch { return []; }
  return [...new URLSearchParams(body).entries()];
}

/** De lo enviado solo interesan los nombres, el estado y qué lleva dentro un batch. */
function describeBody(body: RequestInit["body"]): Pick<MetaCallFacts, "body" | "status" | "batch"> {
  const entries = new Map(bodyEntries(body));
  const keys = [...entries.keys()]
    .filter((k) => k !== "access_token" && k !== "batch" && /^[\w[\]]{1,40}$/.test(k))
    .slice(0, MAX_BODY_KEYS);
  const status = entries.get("status");
  const raw = entries.get("batch");
  let batch: MetaCallFacts["batch"];
  try {
    const list = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ method?: string; relative_url?: string }> | undefined;
    if (Array.isArray(list)) {
      // relative_url puede llevar el token de la página: solo se guarda lo anterior al «?».
      batch = {
        n: list.length,
        items: list.slice(0, MAX_BATCH_ITEMS).map((b) => `${b.method ?? "GET"} ${(b.relative_url ?? "").split("?")[0]}`),
      };
      const fields = new URLSearchParams((list[0]?.relative_url ?? "").split("?")[1] ?? "").get("fields");
      if (fields) batch.fields = fields.slice(0, MAX_VALUE);
    }
  } catch { /* un batch ilegible se queda sin desglose */ }
  return {
    ...(keys.length ? { body: keys } : {}),
    ...(typeof status === "string" ? { status: status.slice(0, 40) } : {}),
    ...(batch ? { batch } : {}),
  };
}

async function outcomeOf(res: Response): Promise<{ outcome: Outcome; code?: number }> {
  if (res.ok) return { outcome: "ok" };
  try {
    const body = await res.clone().json() as { error?: { code?: number } };
    const code = body.error?.code ?? 0;
    return { outcome: RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014) ? "limit" : "error", code: code || undefined };
  } catch {
    return { outcome: "error" };
  }
}

interface CallInfo {
  url: string; method: string; body: RequestInit["body"]; started: number;
  source: string; route: string; page: string;
}

// En los totales, una ruta agrupa todos sus jobs e ids: si no, el hash crecería sin fin.
const routeGroup = (route: string) => route.replace(/ · job .*$/, "").replace(/\d{5,}/g, ":id");

async function record(c: CallInfo, outcome: Outcome, http?: number, code?: number): Promise<void> {
  try {
    const { endpoint, accountId } = describeMetaCall(c.url, c.method);
    const { day, hour } = dateParts(new Date(c.started));
    const u = new URL(c.url);
    const q = safeQuery(u.searchParams);
    const entry: MetaCallEntry = {
      t: c.started, ms: Date.now() - c.started, src: c.source, ep: endpoint,
      path: u.pathname.split("/").filter(Boolean).slice(1).join("/"), res: outcome,
      ...(c.route ? { route: c.route } : {}),
      ...(c.page ? { page: c.page } : {}),
      ...(accountId ? { acct: accountId } : {}),
      ...(http ? { http } : {}),
      ...(code ? { code } : {}),
      ...(u.searchParams.has("after") ? { paged: true } : {}),
      ...(q ? { q } : {}),
      ...describeBody(c.body),
    };
    const log = logKey(day, hour);
    await redis.pipeline()
      .hincrby(key(day), [c.source, endpoint, accountId, outcome, routeGroup(c.route)].join(SEP), 1)
      .hincrby(hoursKey(day), hour, 1)
      .hincrby(hoursKey(day), "total", 1)
      .rpush(log, JSON.stringify(entry))
      .ltrim(log, -META_CALL_LOG_MAX_PER_HOUR, -1)
      .expire(log, LOG_RETENTION_SEC)
      .expire(key(day), RETENTION_SEC)
      .expire(hoursKey(day), RETENTION_SEC)
      .exec();
  } catch {
    // el registro nunca debe afectar a la llamada
  }
}

/** fetch para graph.facebook.com que deja constancia en el reporte diario. */
export async function metaFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const store = sourceStore.getStore();
  // Un job trae su ruta y no pasa por una petición web; el worker ni siquiera lleva next/headers.
  const origin = store?.route ? { route: store.route, page: "" } : await requestOrigin();
  const call: CallInfo = {
    url: String(input), method: init?.method ?? "GET", body: init?.body, started: Date.now(),
    source: store?.source ?? "panel", ...origin,
  };
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    void record(call, "error");
    throw e;
  }
  void outcomeOf(res).then((o) => record(call, o.outcome, res.status, o.code));
  return res;
}

/** Una llamada tal como queda en el detalle. Sin token ni valores enviados. */
export interface MetaCallEntry extends MetaCallFacts {
  /** Inicio de la llamada (epoch en ms). */
  t: number;
  ms?: number;
  src: string;
  /** Ruta de la API, job o función de Python que la hizo. */
  route?: string;
  /** Pantalla desde la que se pidió. */
  page?: string;
  path: string;
  acct?: string;
  res: Outcome;
  http?: number;
  code?: number;
}

export interface MetaCallLogPage {
  date: string;
  hour: number;
  /** Llamadas de esa hora según los contadores. */
  total: number;
  /** Las que tienen detalle: menos si caducó o se pasó del tope. */
  stored: number;
  /** Las que cumplen los filtros. */
  matched: number;
  sources: string[];
  items: Array<MetaCallEntry & { what: string }>;
  hasMore: boolean;
}

/** Detalle de una hora, de la llamada más reciente a la más antigua (solo lee Redis). */
export async function readMetaCallLog(
  date: string, hour: number,
  filters: { source?: string; outcome?: string; q?: string; offset?: number } = {},
): Promise<MetaCallLogPage> {
  const [raw, total] = await Promise.all([redis.lrange(logKey(date, hour), 0, -1), redis.hget(hoursKey(date), String(hour))]);
  const entries = raw
    .flatMap((r) => { try { return [JSON.parse(r) as MetaCallEntry]; } catch { return []; } })
    .sort((a, b) => b.t - a.t)
    .map((e) => ({ ...e, what: explainCall(e) }));

  const needle = filters.q?.trim().toLowerCase();
  const matches = entries.filter((e) => (
    (!filters.source || e.src === filters.source)
    && (!filters.outcome || e.res === filters.outcome)
    && (!needle || [e.what, e.ep, e.path, e.route, e.page, e.acct].some((v) => v?.toLowerCase().includes(needle)))
  ));
  const offset = filters.offset ?? 0;
  return {
    date, hour,
    total: Number(total ?? 0),
    stored: entries.length,
    matched: matches.length,
    sources: [...new Set(entries.map((e) => e.src))].sort(),
    items: matches.slice(offset, offset + LOG_PAGE_SIZE),
    hasMore: offset + LOG_PAGE_SIZE < matches.length,
  };
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
  /** Ruta, job o función que hizo la llamada (las antiguas no la tienen). */
  byRoute: CallRow[];
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
  const byRoute = new Map<string, CallRow>();
  const top = new Map<string, CallRow>();
  let total = 0, errors = 0, limited = 0;

  for (const [field, value] of Object.entries(raw)) {
    const [source, endpoint, accountId, outcome, route] = field.split(SEP);
    const n = Number(value);
    total += n;
    if (outcome === "error") errors += n;
    if (outcome === "limit") limited += n;
    add(bySource, source, n, outcome);
    add(byEndpoint, endpoint, n, outcome);
    if (accountId) add(byAccount, accountId, n, outcome);
    if (route) add(byRoute, route, n, outcome);
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
    byRoute: sorted(byRoute).slice(0, 25),
    top: sorted(top).slice(0, 15).map((r) => {
      const [source, endpoint] = r.key.split(SEP);
      return { ...r, source, endpoint };
    }),
  };
}
