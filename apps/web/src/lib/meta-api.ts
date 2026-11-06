import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";
import { redis } from "@/lib/redis";
import { splitExistingAds } from "@/lib/ad-dedup";
import { MetaApiError, isRateLimitKind, serializeError, type MetaErrorDetail, type SerializedError } from "@/lib/meta-errors";

export { MetaApiError } from "@/lib/meta-errors";

const META_API_BASE = "https://graph.facebook.com/v21.0";
// TTLs en segundos. Estructura cambia poco → caché largo (ahorra cuota Meta).
// Insights = datos financieros → balance frescura/cuota; el botón ↻ siempre trae fresco.
const TTL = { accounts: 21600, campaigns: 1800, adsets: 1800, ads: 1800, insights: 3600 };
const STALE_TTL = 43200; // 12h: copia de respaldo para servir cuando Meta limita la cuenta (error 17).

// Detecta errores de rate limit de Meta (17 cuenta, 4 app, 32 página, 613 custom, 8000x).
function isRateLimit(e: unknown): boolean {
  if (e instanceof MetaApiError) return isRateLimitKind(e.kind);
  const m = e instanceof Error ? e.message : String(e);
  return /\berror (4|17|32|613|8000\d|80014)\b|request limit|rate limit/i.test(m);
}

// ─── Errores estructurados ────────────────────────────────────────────────────
type RawMetaError = {
  code?: number; error_subcode?: number; type?: string; message?: string;
  error_user_title?: string; error_user_msg?: string; fbtrace_id?: string; is_transient?: boolean;
};

/** Error crudo de Meta + contexto → detalle para el desarrollador (nunca incluye el token). */
function toDetail(err: RawMetaError | undefined, ctx: { endpoint: string; httpStatus?: number; attempts?: number; retryAfterSec?: number }): MetaErrorDetail {
  return {
    code: err?.code, subcode: err?.error_subcode, type: err?.type, message: err?.message,
    userTitle: err?.error_user_title, userMsg: err?.error_user_msg, fbtraceId: err?.fbtrace_id,
    isTransient: err?.is_transient, ...ctx,
  };
}

/** Segundos que Meta pide esperar según el header de cuota de la respuesta (0 si no dice). */
function retryAfterFromHeaders(res: Response): number {
  try {
    const buc = res.headers.get("x-business-use-case-usage");
    if (!buc) return 0;
    let maxMin = 0;
    for (const arr of Object.values(JSON.parse(buc) as Record<string, AccountUsage[]>)) {
      for (const u of arr ?? []) maxMin = Math.max(maxMin, Number(u?.estimated_time_to_regain_access ?? 0));
    }
    return maxMin * 60;
  } catch {
    return 0;
  }
}

/** Espera antes del reintento: respeta lo que pide Meta; si no lo dice, backoff exponencial. */
function retryDelayMs(e: MetaApiError, attempt: number): number | null {
  if (isRateLimitKind(e.kind)) {
    const asked = (e.detail.retryAfterSec ?? 0) * 1000;
    // Si Meta pide más de 2 min, no bloquear el proceso: que el job se reprograme.
    if (asked > 120_000) return null;
    return Math.max(asked, Math.min(60_000, 5000 * Math.pow(2, attempt)));
  }
  if (e.kind === "temporary") return 1000 * (attempt + 1);
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Coalescing: si ya hay una petición idéntica EN VUELO, reusar su promesa en vez
// de disparar otra llamada a Meta (N usuarios/recargas sobre la misma cuenta = 1 sola
// llamada). Alivia el rate limit 17 sin cambiar la lógica de caché.
const inflight = new Map<string, Promise<unknown>>();
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export type ProgressCallback = (progress: number, msg: string) => Promise<void>;
const noop: ProgressCallback = () => Promise.resolve();

export async function getActiveToken(bmId?: string, operationId?: string): Promise<{ token: string; bmDbId: string }> {
  const bm = await prisma.businessManager.findFirst({
    where: {
      status: "active",
      deletedAt: null, // un BM en la papelera no debe seguir operando
      ...(bmId ? { id: bmId } : {}),
      ...(operationId ? { operationId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (!bm) throw new Error("No hay Business Manager configurado con token activo");
  return { token: decrypt(bm.encryptedToken), bmDbId: bm.id };
}

// ─── Cooldown por cuenta ──────────────────────────────────────────────────────
// Cuando Meta avisa (por header o por error) que una cuenta está cerca o por
// encima de su cuota, se marca un "enfriamiento". El worker no arranca trabajos
// de esa cuenta hasta que pase, en vez de chocar contra el límite.
const COOLDOWN_PREFIX = "meta:cooldown:acct:";
const USAGE_SOFT_LIMIT = 85; // % de cuota a partir del cual se frena preventivamente

export async function setAccountCooldown(accountId: string, seconds: number, reason: string): Promise<void> {
  const rawId = accountId.replace("act_", "");
  const secs = Math.max(10, Math.ceil(seconds));
  try {
    const cur = await redis.ttl(`${COOLDOWN_PREFIX}${rawId}`);
    if (cur >= secs) return; // ya hay un enfriamiento más largo
    await redis.setex(`${COOLDOWN_PREFIX}${rawId}`, secs, reason);
  } catch { /* sin Redis no se frena, pero tampoco se rompe */ }
}

/** Segundos de enfriamiento que le quedan a la cuenta (0 = libre) y el motivo. */
export async function getAccountCooldown(accountId: string): Promise<{ seconds: number; reason: string | null }> {
  const rawId = accountId.replace("act_", "");
  try {
    const [ttl, reason] = await Promise.all([redis.ttl(`${COOLDOWN_PREFIX}${rawId}`), redis.get(`${COOLDOWN_PREFIX}${rawId}`)]);
    return { seconds: ttl > 0 ? ttl : 0, reason };
  } catch {
    return { seconds: 0, reason: null };
  }
}

// ─── Cuota de Meta (rate limit por cuenta) ────────────────────────────────────
// Captura los headers de cuota (x-app-usage = App, x-business-use-case-usage = por cuenta)
// y guarda el último valor en Redis. Sin llamadas extra: se lee de respuestas que ya pasan.
async function captureUsage(res: Response): Promise<void> {
  try {
    const app = res.headers.get("x-app-usage");
    if (app) await redis.setex("meta:usage:app", 900, app);
    const buc = res.headers.get("x-business-use-case-usage");
    if (buc) {
      const parsed = JSON.parse(buc) as Record<string, unknown>;
      for (const [acctId, arr] of Object.entries(parsed)) {
        await redis.setex(`meta:usage:acct:${acctId}`, 900, JSON.stringify(arr));
        // Frenar antes de chocar: si Meta pide esperar o la cuota pasa del umbral.
        for (const u of (Array.isArray(arr) ? arr : []) as AccountUsage[]) {
          const etaMin = Number(u?.estimated_time_to_regain_access ?? 0);
          const pct = Math.max(Number(u?.call_count ?? 0), Number(u?.total_cputime ?? 0), Number(u?.total_time ?? 0));
          if (etaMin > 0) await setAccountCooldown(acctId, etaMin * 60, `Meta pidió esperar ${etaMin} min (cuota ${u?.type ?? "ads"})`);
          else if (pct >= USAGE_SOFT_LIMIT) await setAccountCooldown(acctId, 60, `Cuota al ${pct}% (${u?.type ?? "ads"})`);
        }
      }
    }
  } catch {
    // nunca romper la llamada por un fallo al capturar la cuota
  }
}

export interface AccountUsage {
  type?: string;
  call_count: number;
  total_cputime: number;
  total_time: number;
  estimated_time_to_regain_access?: number;
}

function parseAcctUsage(raw: string | null): AccountUsage | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return (arr.find((a) => a?.type === "ads_management") ?? arr[0] ?? null) as AccountUsage | null;
  } catch {
    return null;
  }
}

// Lee la cuota CACHEADA (Redis) de varias cuentas. Sin llamadas a Meta — instantáneo.
export async function getAccountsUsageCached(accountIds: string[]): Promise<Record<string, AccountUsage | null>> {
  const out: Record<string, AccountUsage | null> = {};
  await Promise.all(accountIds.map(async (id) => {
    const rawId = id.replace("act_", "");
    out[rawId] = parseAcctUsage(await redis.get(`meta:usage:acct:${rawId}`));
  }));
  return out;
}

// Barrido ACTIVO: 1 GET liviano por cuenta (en paralelo) que lee el header de cuota y lo
// guarda en Redis. Para el botón "Refrescar cuotas".
export async function refreshAccountsUsage(accounts: { id: string; bmId: string }[]): Promise<Record<string, AccountUsage | null>> {
  const bmIds = [...new Set(accounts.map((a) => a.bmId))];
  const tokenByBm: Record<string, string> = {};
  await Promise.all(bmIds.map(async (bmId) => {
    try { tokenByBm[bmId] = (await getActiveToken(bmId)).token; } catch { /* BM sin token */ }
  }));

  await Promise.all(accounts.map(async (acc) => {
    const token = tokenByBm[acc.bmId];
    if (!token) return;
    const rawId = acc.id.replace("act_", "");
    try {
      const res = await fetch(`${META_API_BASE}/act_${rawId}?fields=id&access_token=${token}`);
      await captureUsage(res);
    } catch { /* ignorar fallos puntuales */ }
  }));

  return getAccountsUsageCached(accounts.map((a) => a.id));
}

/** Cuenta publicitaria a la que apunta un endpoint ("act_123/…"), si se ve en la ruta. */
function accountFromPath(path: string): string | null {
  const m = /^act_(\d+)/.exec(path);
  return m ? m[1] : null;
}

// Llamada única a Meta con reintentos según el tipo de error. Lanza MetaApiError
// con el detalle completo (code, subcode, fbtrace_id, endpoint) si no se resuelve.
// Las respuestas de Meta varían por endpoint; cada llamador conoce su forma.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MetaJson = any;

async function metaRequest(
  method: "GET" | "POST", path: string, url: string, init: RequestInit | undefined, retries: number,
): Promise<MetaJson> {
  const endpoint = `${method} ${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    let json: { error?: RawMetaError } & Record<string, unknown>;
    try {
      res = await fetch(url, init);
      json = await res.json();
    } catch (e) {
      const err = new MetaApiError({ endpoint, httpStatus: 0, attempts: attempt + 1, message: e instanceof Error ? e.message : String(e) });
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw err;
    }
    void captureUsage(res);
    if (!json.error) return json;

    const err = new MetaApiError(toDetail(json.error, {
      endpoint, httpStatus: res.status, attempts: attempt + 1, retryAfterSec: retryAfterFromHeaders(res),
    }));
    console.error(`[meta] ${endpoint} (intento ${attempt + 1}) → ${err.detail.code}/${err.detail.subcode ?? "-"} ${err.kind}: ${err.detail.message} [fbtrace ${err.detail.fbtraceId ?? "-"}]`);

    if (isRateLimitKind(err.kind)) {
      const acct = accountFromPath(path);
      if (acct) await setAccountCooldown(acct, err.detail.retryAfterSec || 60, `Meta limitó la cuenta (código ${err.detail.code})`);
    }
    const wait = attempt < retries ? retryDelayMs(err, attempt) : null;
    if (wait == null) throw err;
    console.warn(`[meta] ${endpoint}: reintento en ${Math.round(wait / 1000)}s (${err.kind})`);
    await sleep(wait);
  }
  throw new MetaApiError({ endpoint, message: "Agotados los reintentos" });
}

async function metaGet(path: string, token: string, params: Record<string, string> = {}, retries = 3) {
  const url = new URL(`${META_API_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return metaRequest("GET", path, url.toString(), undefined, retries);
}

async function metaPost(path: string, token: string, body: Record<string, string | boolean | number>, retries = 3) {
  const url = new URL(`${META_API_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  const encoded = new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString();
  return metaRequest("POST", path, url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encoded,
  }, retries);
}

// ─── Batch API ──────────────────────────────────────────────────────────────
// Meta permite hasta 50 sub-requests en 1 sola llamada HTTP. Reduce round-trips
// (mucho más rápido), aunque cada sub-request sigue contando para el rate limit.

const BATCH_MAX = 50;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface BatchReq { method: "GET" | "POST"; relative_url: string; body?: string }
interface BatchRes { code: number; body: unknown }

// Envía un batch (máx 50). Reintenta error 17 a nivel del batch completo.
async function metaBatch(token: string, requests: BatchReq[], retries = 3): Promise<BatchRes[]> {
  const url = new URL(`${META_API_BASE}/`);
  const form = new URLSearchParams();
  form.set("access_token", token);
  form.set("batch", JSON.stringify(requests));

  const target = requests[0]?.relative_url ?? "";
  const endpoint = `BATCH ×${requests.length} (${requests[0]?.method ?? "?"} ${target.split("?")[0]})`;
  const acct = accountFromPath(target);

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    let json: { error?: RawMetaError } | Array<{ code?: number; body?: string } | null>;
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      json = await res.json();
    } catch (e) {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw new MetaApiError({ endpoint, httpStatus: 0, attempts: attempt + 1, message: e instanceof Error ? e.message : String(e) });
    }
    void captureUsage(res);

    // Error a nivel del batch entero (p.ej. rate limit del batch).
    if (!Array.isArray(json)) {
      const err = new MetaApiError(toDetail(json.error, {
        endpoint, httpStatus: res.status, attempts: attempt + 1, retryAfterSec: retryAfterFromHeaders(res),
      }));
      console.error(`[batch] ${endpoint} (intento ${attempt + 1}) → ${err.detail.code} ${err.kind}: ${err.detail.message}`);
      if (isRateLimitKind(err.kind) && acct) {
        await setAccountCooldown(acct, err.detail.retryAfterSec || 60, `Meta limitó la cuenta (código ${err.detail.code})`);
      }
      const wait = attempt < retries ? retryDelayMs(err, attempt) : null;
      if (wait == null) throw err;
      await sleep(wait);
      continue;
    }

    // json = array de { code, headers, body(string) }. body puede ser null si el sub-request expiró.
    const out = json.map((sub) => ({
      code: sub?.code ?? 0,
      body: sub?.body ? JSON.parse(sub.body) : null,
    }));
    // Un sub-request con rate limit también enfría la cuenta.
    if (acct && out.some((r) => r.code !== 200 && isRateLimitKind(batchError(r, endpoint).kind))) {
      await setAccountCooldown(acct, retryAfterFromHeaders(res) || 60, "Meta limitó la cuenta (sub-request del batch)");
    }
    return out;
  }
  throw new MetaApiError({ endpoint, message: "Agotados los reintentos" });
}

/** Detalle de un sub-request fallido del batch, para registrarlo y explicarlo. */
function batchError(r: BatchRes, endpoint: string): MetaApiError {
  const body = r.body as { error?: RawMetaError } | null;
  return new MetaApiError(toDetail(body?.error ?? { message: r.code === 0 ? "Sub-request sin respuesta (expiró)" : `HTTP ${r.code}` }, {
    endpoint, httpStatus: r.code,
  }));
}

async function setEntityStatus(entityId: string, token: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  await metaPost(entityId, token, { status });
}

// Crea un ad usando bracket notation (única forma que funciona con creativos asset_feed_spec).
// Tras copiar una campaña, el creative/imagen tarda ~5-6 min en quedar utilizable en el CDN de Meta.
// Durante ese tiempo el POST falla con:
//   - 100/1487833 "Image Wasn't Downloaded" (CDN aún no descargó la imagen)
//   - 2 "An unexpected error has occurred" (asset todavía propagándose) ← NO es falso positivo: hay que reintentar
// La solución es reintentar el POST de forma persistente con esperas largas hasta que el asset propague.
// (Probado: el ad se crea consistentemente entre el intento 4 y 6, ~6 min después de copiar.)
const AD_MAX_ATTEMPTS = 20;       // ~20 rondas → creatives pesados que Meta tarda en procesar
const AD_RETRY_WAIT_MS = 75000;   // 75s entre intentos (usado por createAdBracket, ads individuales)

// Espera ADAPTATIVA entre rondas de createAdsBatched:
// si la ronda creó ads → espera corta (está fluyendo); si no creó nada → back-off (está atascado).
const AD_WAIT_BASE = 25000;       // 25s cuando hay progreso
const AD_WAIT_MAX = 75000;        // hasta 75s cuando una ronda sale vacía
const AD_BATCH_SIZE = 2;          // ads de a 2 por llamada batch (no todos juntos) → menos pico de cuota

async function createAdBracket(
  accountId: string,
  adsetId: string,
  token: string,
  name: string,
  creativeId: string
): Promise<string | null> {
  const url = new URL(`${META_API_BASE}/act_${accountId}/ads`);
  url.searchParams.set("access_token", token);
  const form = new URLSearchParams();
  form.set("name", name);
  form.set("adset_id", adsetId);
  form.set("creative[creative_id]", creativeId);
  form.set("status", "ACTIVE");

  console.log(`[bracket] POST act_${accountId}/ads | adset=${adsetId} | creative=${creativeId} | name="${name}"`);

  for (let attempt = 0; attempt < AD_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) console.log(`[bracket] Intento ${attempt + 1}/${AD_MAX_ATTEMPTS} | adset=${adsetId}`);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await res.json();

    if (json.id) {
      console.log(`[bracket] ✅ Ad creado id=${json.id} | adset=${adsetId} (intento ${attempt + 1})`);
      return json.id as string;
    }

    const code: number = json.error?.code;
    const subcode: number = json.error?.error_subcode;
    const isTransient: boolean = json.error?.is_transient ?? false;
    console.error(`[bracket] ❌ Error POST | adset=${adsetId} | code=${code} subcode=${subcode} is_transient=${isTransient} | msg="${json.error?.message}"`);

    // Errores transitorios de propagación del asset: 2 (unexpected), 1 (unknown), 100/1487833 (CDN image).
    const isPropagationError =
      code === 2 || code === 1 || (code === 100 && subcode === 1487833);
    // Error 17 = rate limit de la cuenta → también reintentable (esperar a que baje).
    const isRateLimit = code === 17;

    if (isPropagationError || isRateLimit) {
      // GET de verificación SOLO en el primer fallo de propagación (catch del falso positivo
      // inmediato). En reintentos posteriores y bajo rate limit NO verificamos, para no sumar
      // llamadas a una cuenta saturada — el segundo pase deduplica si hiciera falta.
      if (isPropagationError && attempt === 0) {
        console.log(`[bracket] Esperando ${AD_VERIFY_DELAY_MS / 1000}s antes de verificar si el ad se creó | adset=${adsetId}...`);
        await new Promise((r) => setTimeout(r, AD_VERIFY_DELAY_MS));
        try {
          const adsJson = await metaGet(`${adsetId}/ads`, token, { fields: "id,name", limit: "100" }, 0);
          const found = (adsJson.data ?? []).find((a: { name: string }) => a.name === name);
          if (found) {
            console.log(`[bracket] ✅ Verificado por GET tras ${AD_VERIFY_DELAY_MS / 1000}s: el ad SÍ existe id=${found.id} (era falso positivo, pedimos muy rápido) | adset=${adsetId}`);
            return found.id as string;
          }
          console.log(`[bracket] GET tras ${AD_VERIFY_DELAY_MS / 1000}s: el ad NO existe | adset=${adsetId} → reintento real`);
        } catch (e) {
          console.warn(`[bracket] GET verificación falló (probable rate limit) | adset=${adsetId} | error: ${e}`);
        }
      }

      if (attempt < AD_MAX_ATTEMPTS - 1) {
        const motivo = isRateLimit ? "Rate limit (17) de la cuenta" : "Asset aún propagándose";
        console.warn(`[bracket] ${motivo} | adset=${adsetId} | reintentando en ${AD_RETRY_WAIT_MS / 1000}s (intento ${attempt + 1}/${AD_MAX_ATTEMPTS})...`);
        await new Promise((r) => setTimeout(r, AD_RETRY_WAIT_MS));
        continue;
      }
      console.error(`[bracket] ❌ No se pudo crear tras ${AD_MAX_ATTEMPTS} intentos | adset=${adsetId} → null`);
      return null;
    }

    // Cualquier otro código (permisos, post borrado, parámetro inválido real) NO es reintentable.
    console.error(`[bracket] ❌ Error no reintentable | adset=${adsetId} | error completo: ${JSON.stringify(json.error)}`);
    return null;
  }

  console.error(`[bracket] ❌ Agotados todos los intentos | adset=${adsetId}`);
  return null;
}

// Espera antes del GET de verificación tras el 1er fallo de propagación (usado por createAdBracket).
const AD_VERIFY_DELAY_MS = 30000;

interface AdToCreate { newId: string; name: string; creativeId: string; status: "ACTIVE" | "PAUSED" }

// ¿El error de crear ad es transitorio (reintenta) o real (se descarta)?
function isTransientAdError(code: number | undefined, subcode: number | undefined, httpCode: number): boolean {
  if (httpCode >= 500 || httpCode === 0) return true; // 5xx o sub-request expirado
  return code === 2 || code === 1 || code === 17 || (code === 100 && subcode === 1487833);
}

type MetaAdError = {
  code?: number; error_subcode?: number;
  message?: string; error_user_title?: string; error_user_msg?: string;
};

// Errores FATALES de creación de ads: configuración/permisos que NO mejoran reintentando
// ni cambiando de adset (fallarían los 25 igual). Detectarlos → abortar el job de inmediato
// con un mensaje legible, en vez de machacar el mismo error N veces.
const FATAL_AD_SUBCODES = new Set<number>([1885499]); // "No Advertiser Permission On Page"
function isFatalAdError(code?: number, subcode?: number): boolean {
  if (code === 190) return true;                 // token inválido / expirado
  if (code === 10 || code === 200) return true;  // sin permiso de escritura
  if (subcode != null && FATAL_AD_SUBCODES.has(subcode)) return true;
  return false;
}

// Error fatal de Meta que debe DETENER el job. Lleva un mensaje ya legible para el usuario.
export class FatalAdError extends Error {
  /** Error de Meta original, con el detalle técnico. */
  readonly metaError?: MetaApiError;
  constructor(msg: string, metaError?: MetaApiError) { super(msg); this.name = "FatalAdError"; this.metaError = metaError; }
}

// Convierte el error crudo de Meta en un texto entendible (usa los campos error_user_*).
function humanizeMetaError(err?: MetaAdError): string {
  if (!err) return "Error de configuración en Meta";
  const title = err.error_user_title?.trim();
  const msg = err.error_user_msg?.trim();
  if (title && msg) return `${title}: ${msg}`;
  return title || msg || err.message || "Error de configuración en Meta";
}

// Crea ads para varios adsets usando el BATCH API de Meta, en RONDAS.
// Ronda: 1 batch POST con todos los pendientes (en grupos de 50). Los que dan error transitorio
// (2, 1, 1487833, 17, 5xx) pasan a la siguiente ronda tras esperar. Antes de reintentar, un batch
// GET deduplica: si el ad ya existe (falso positivo), no se vuelve a crear → cero duplicados.
// HTTP calls ≈ nº de rondas (no N). Las operaciones siguen contando igual para el rate limit.
async function createAdsBatched(
  accountId: string,
  token: string,
  items: AdToCreate[],
  cb: ProgressCallback,
  progFrom: number,
  progTo: number,
  checkCancelled?: () => Promise<void>,
  opts: { dedupFirst?: boolean; issues?: DuplicateIssue[]; stopOnRateLimit?: boolean } = {}
): Promise<{ adsOk: number; failed: AdToCreate[] }> {
  const total = items.length;
  let adsOk = 0;
  let pending = [...items];
  let wait = AD_WAIT_BASE; // espera adaptativa entre rondas
  const lastError = new Map<AdToCreate, MetaApiError>();
  // Creados en esta ejecución, por ad set y nombre (los nombres pueden repetirse).
  const counted = new Map<string, number>();
  const countKey = (adsetId: string, name: string) => `${adsetId}\u0000${name}`;

  for (let round = 0; round < AD_MAX_ATTEMPTS && pending.length > 0; round++) {
    if (checkCancelled) await checkCancelled();
    let sawRateLimit = false; // ¿esta ronda tuvo error 17? → back-off; si no, seguir corto.

    // Al reanudar un job, antes de crear nada se mira qué ads ya existen.
    if (round > 0 || opts.dedupFirst) {
      if (round > 0) {
        console.log(`[ads-batch] Ronda ${round + 1}: esperando ${wait / 1000}s antes de reintentar ${pending.length}...`);
        await sleep(wait);
      }
      if (checkCancelled) await checkCancelled();

      // Dedup por batch GET: cuáles pendientes YA tienen el ad (falso positivo) → no recrear.
      const stillPending: AdToCreate[] = [];
      for (const adsetIds of chunk([...new Set(pending.map((it) => it.newId))], AD_BATCH_SIZE)) {
        const itemsOf = (id: string) => pending.filter((it) => it.newId === id);
        let results: BatchRes[];
        try {
          results = await metaBatch(token, adsetIds.map((id) => ({
            method: "GET" as const, relative_url: `${id}/ads?fields=name&limit=200`,
          })));
        } catch (e) {
          if (opts.stopOnRateLimit && e instanceof MetaApiError && isRateLimitKind(e.kind)) throw e;
          for (const id of adsetIds) stillPending.push(...itemsOf(id)); // batch GET falló entero (probable 17) → reintentar todos
          sawRateLimit = true;
          continue;
        }
        results.forEach((r, i) => {
          const adsetId = adsetIds[i];
          if (r.code !== 200) {
            const err = batchError(r, `GET ${adsetId}/ads`);
            if (opts.stopOnRateLimit && isRateLimitKind(err.kind)) throw err;
            stillPending.push(...itemsOf(adsetId));
            return;
          }
          const body = r.body as { data?: Array<{ name: string }> } | null;
          const { found, missing } = splitExistingAds(
            itemsOf(adsetId), (body?.data ?? []).map((a) => a.name),
            (name) => counted.get(countKey(adsetId, name)) ?? 0,
          );
          for (const it of found) {
            adsOk++;
            counted.set(countKey(adsetId, it.name), (counted.get(countKey(adsetId, it.name)) ?? 0) + 1);
            console.log(`[ads-batch] ✅ ya existía | adset=${adsetId}`);
          }
          stillPending.push(...missing);
        });
      }
      pending = stillPending;
      if (pending.length === 0) break;
    }

    // Batch POST de creación: ads de a AD_BATCH_SIZE (2) por llamada, no todos juntos.
    const nextPending: AdToCreate[] = [];
    for (const group of chunk(pending, AD_BATCH_SIZE)) {
      const results = await metaBatch(token, group.map((it) => {
        const f = new URLSearchParams();
        f.set("name", it.name);
        f.set("adset_id", it.newId);
        f.set("creative[creative_id]", it.creativeId);
        f.set("status", it.status); // el mismo estado que el anuncio original
        return { method: "POST" as const, relative_url: `act_${accountId}/ads`, body: f.toString() };
      }));
      results.forEach((r, i) => {
        const it = group[i];
        const body = r.body as { id?: string; error?: MetaAdError } | null;
        if (r.code === 200 && body?.id) {
          adsOk++;
          counted.set(countKey(it.newId, it.name), (counted.get(countKey(it.newId, it.name)) ?? 0) + 1);
        } else if (isTransientAdError(body?.error?.code, body?.error?.error_subcode, r.code)) {
          if (body?.error?.code === 17) sawRateLimit = true;
          const err = batchError(r, `POST act_${accountId}/ads`);
          if (opts.stopOnRateLimit && isRateLimitKind(err.kind)) throw err;
          lastError.set(it, err);
          nextPending.push(it);
        } else {
          const err = body?.error;
          const apiErr = batchError(r, `POST act_${accountId}/ads`);
          console.error(`[ads-batch] ❌ error no reintentable | adset=${it.newId}: ${JSON.stringify(apiErr.detail)}`);
          // Fatal (permiso/token/config): no sirve reintentar ni seguir con los demás → abortar ya.
          if (isFatalAdError(err?.code, err?.error_subcode)) {
            throw new FatalAdError(humanizeMetaError(err), apiErr);
          }
          opts.issues?.push({ step: "ad", name: it.name, sourceId: it.newId, error: apiErr.toJSON() });
        }
      });
    }
    pending = nextPending;
    // Espera: corta y constante mientras sea propagación (atrapa cada ad apenas Meta lo termina);
    // solo back-off (×2 hasta el máx) si la ronda tuvo rate limit (17), para no saturar la cuenta.
    wait = sawRateLimit ? Math.min(AD_WAIT_MAX, wait * 2) : AD_WAIT_BASE;
    await cb(
      progFrom + Math.round(((total - pending.length) / total) * (progTo - progFrom)),
      `Ads: ${adsOk}/${total} creados${pending.length ? `, ${pending.length} reintentando...` : ""}`
    );
    console.log(`[ads-batch] Ronda ${round + 1}: ${adsOk}/${total} OK, ${pending.length} pendientes (prox. espera ${wait / 1000}s)`);
  }

  for (const it of pending) {
    opts.issues?.push({
      step: "ad", name: it.name, sourceId: it.newId,
      error: serializeError(lastError.get(it) ?? new Error(`No se pudo crear tras ${AD_MAX_ATTEMPTS} rondas`)),
    });
  }
  return { adsOk, failed: pending };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export interface MetaAdAccount {
  id: string;
  name: string;
  currency: string;
  account_status: number;
  bmId: string;
}

export async function getAdAccounts(bmId?: string, operationId?: string, skipCache?: boolean): Promise<MetaAdAccount[]> {
  const cacheKey = `meta:accounts:${operationId ?? "all"}:${bmId ?? "default"}`;
  if (!skipCache) {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const activeBMs = await prisma.businessManager.findMany({
    where: {
      status: "active",
      deletedAt: null, // un BM en la papelera no debe seguir operando
      ...(bmId ? { id: bmId } : {}),
      ...(operationId ? { operationId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  if (!activeBMs.length) throw new Error("No hay Business Manager configurado con token activo");

  const accounts: MetaAdAccount[] = [];
  const seen = new Set<string>();

  for (const bm of activeBMs) {
    const token = decrypt(bm.encryptedToken);
    let nextUrl: string | null = `${META_API_BASE}/me/adaccounts?fields=id,name,currency,account_status&limit=200&access_token=${token}`;
    while (nextUrl) {
      // Nunca devolver (ni cachear) una lista PARCIAL: un error a mitad de
      // paginación dejaría fuera cuentas reales. Quien archiva por ausencia
      // (dashboard-sync) las borraría del dashboard por error. Mejor fallar y
      // que el llamador decida (los syncs hacen catch y se saltan la pasada).
      const json = (await metaRequest("GET", `me/adaccounts (BM ${bm.name})`, nextUrl, undefined, 3)) as {
        data?: Record<string, string>[]; paging?: { next?: string };
      };
      console.log(`[meta-api] BM ${bm.id}: Respuesta de Meta tiene ${json.data?.length ?? 0} cuentas`);
      for (const acc of json.data ?? []) {
        console.log(`[meta-api] BM ${bm.id}: Procesando cuenta - id: ${acc.id}, name: ${acc.name}, status: ${acc.account_status}, currency: ${acc.currency}`);
        if (!seen.has(acc.id)) {
          seen.add(acc.id);
          console.log(`[meta-api] ✓ Agregando: ${acc.id} - ${acc.name}`);
          accounts.push({ ...acc, currency: acc.currency || "USD", bmId: bm.id } as MetaAdAccount);
        } else {
          console.log(`[meta-api] ✗ Cuenta duplicada: ${acc.id}`);
        }
      }
      nextUrl = json.paging?.next ?? null;
      console.log(`[meta-api] BM ${bm.id}: Procesadas ${json.data?.length ?? 0} cuentas, total acumulado: ${accounts.length}`);
    }
  }

  await redis.setex(cacheKey, TTL.accounts, JSON.stringify(accounts));
  return accounts;
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  buying_type: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  start_time?: string;
  stop_time?: string;
  special_ad_categories: string[];
  is_cbo: boolean;
}

export async function getCampaigns(
  accountId: string,
  cursor?: string,
  bmId?: string,
  operationId?: string,
  opts: FetchOpts = {}
): Promise<{ campaigns: MetaCampaign[]; nextCursor: string | null; stale?: boolean }> {
  const cacheKey = `meta:campaigns:${operationId ?? "all"}:${accountId}:${cursor ?? "first"}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = opts.force ? null : await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { token } = await getActiveToken(bmId, operationId);
  const fields = "id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,special_ad_categories";
  const params: Record<string, string> = { fields, limit: "50" };
  if (cursor) params.after = cursor;

  try {
    const json = await metaGet(`act_${accountId}/campaigns`, token, params);
    const campaigns: MetaCampaign[] = (json.data ?? []).map((c: Record<string, unknown>) => ({
      ...c,
      is_cbo: !!(c.daily_budget || c.lifetime_budget),
    }));
    const nextCursor: string | null = json.paging?.cursors?.after ?? null;
    const result = { campaigns, nextCursor };

    await redis.setex(cacheKey, TTL.campaigns, JSON.stringify(result));
    await redis.setex(staleKey, STALE_TTL, JSON.stringify(result));
    return result;
  } catch (e) {
    // Rate limit (17): servir la última copia buena en vez de fallar en duro.
    if (isRateLimit(e)) {
      const s = await redis.get(staleKey);
      if (s) return { ...JSON.parse(s), stale: true };
    }
    throw e;
  }
}

/** force = saltarse el caché fresco y pedir a Meta (botón «Traer de Meta»). */
export interface FetchOpts { force?: boolean }

export interface MetaAdSet {
  id: string;
  name: string;
  status: string;
  campaign_id?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  billing_event?: string;
  optimization_goal?: string;
  start_time?: string;
  end_time?: string;
}

export async function getAdSets(
  accountId: string,
  campaignId?: string,
  bmId?: string,
  operationId?: string,
  opts: FetchOpts = {}
): Promise<MetaAdSet[]> {
  const cacheKey = campaignId ? `meta:adsets:${operationId ?? "all"}:${campaignId}` : `meta:adsets:${operationId ?? "all"}:account:${accountId}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = opts.force ? null : await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { token } = await getActiveToken(bmId, operationId);
  const fields = "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,start_time,end_time";
  const endpoint = campaignId ? `${campaignId}/adsets` : `act_${accountId}/adsets`;
  try {
    const json = await metaGet(endpoint, token, { fields, limit: "200" });
    const adsets: MetaAdSet[] = json.data ?? [];
    await redis.setex(cacheKey, TTL.adsets, JSON.stringify(adsets));
    await redis.setex(staleKey, STALE_TTL, JSON.stringify(adsets));
    return adsets;
  } catch (e) {
    if (isRateLimit(e)) {
      const s = await redis.get(staleKey);
      if (s) return JSON.parse(s);
    }
    throw e;
  }
}

export interface MetaAd {
  id: string;
  name: string;
  status: string;
  creative_id?: string;
  adset_id?: string;
}

export async function getAds(
  accountId: string,
  adsetId?: string,
  bmId?: string,
  operationId?: string,
  opts: FetchOpts = {}
): Promise<MetaAd[]> {
  const cacheKey = adsetId ? `meta:ads:${operationId ?? "all"}:${adsetId}` : `meta:ads:${operationId ?? "all"}:account:${accountId}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = opts.force ? null : await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { token } = await getActiveToken(bmId, operationId);
  const endpoint = adsetId ? `${adsetId}/ads` : `act_${accountId}/ads`;
  const fields = "id,name,status,adset_id,creative{id}";
  try {
    const json = await metaGet(endpoint, token, { fields, limit: "200" });
    const ads: MetaAd[] = (json.data ?? []).map((a: Record<string, unknown> & { creative?: { id: string } }) => ({
      id: a.id as string,
      name: a.name as string,
      status: a.status as string,
      creative_id: a.creative?.id,
      adset_id: a.adset_id as string | undefined,
    }));
    await redis.setex(cacheKey, TTL.ads, JSON.stringify(ads));
    await redis.setex(staleKey, STALE_TTL, JSON.stringify(ads));
    return ads;
  } catch (e) {
    if (isRateLimit(e)) {
      const s = await redis.get(staleKey);
      if (s) return JSON.parse(s);
    }
    throw e;
  }
}

export interface MetaInsights {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpc: string;
  cpm?: string;
  inline_link_clicks?: string;
  unique_link_clicks_ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

export async function getInsights(
  accountId: string,
  level: "campaign" | "adset" | "ad",
  datePreset = "last_7d",
  bmId?: string,
  operationId?: string,
  opts: FetchOpts = {}
): Promise<MetaInsights[]> {
  const cacheKey = `meta:insights2:${operationId ?? "all"}:${accountId}:${level}:${datePreset}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = opts.force ? null : await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  return coalesce(`${cacheKey}${opts.force ? ":force" : ""}`, async () => {
    // Otro caller pudo llenar el caché mientras esperábamos el turno.
    const again = opts.force ? null : await redis.get(cacheKey);
    if (again) return JSON.parse(again);

    try {
      const { token } = await getActiveToken(bmId, operationId);
      const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
      const fields = `${idField},spend,impressions,clicks,ctr,cpc,cpm,actions,action_values,inline_link_clicks,unique_link_clicks_ctr`;

      const allData: MetaInsights[] = [];
      const baseUrl = new URL(`${META_API_BASE}/act_${accountId}/insights`);
      baseUrl.searchParams.set("access_token", token);
      baseUrl.searchParams.set("level", level);
      baseUrl.searchParams.set("fields", fields);
      baseUrl.searchParams.set("date_preset", datePreset);
      baseUrl.searchParams.set("limit", "500");

      let nextUrl: string | null = baseUrl.toString();
      let pages = 0;

      while (nextUrl && pages < 10) {
        const json = (await metaRequest("GET", `act_${accountId}/insights`, nextUrl, undefined, 3)) as {
          data?: MetaInsights[]; paging?: { next?: string };
        };
        allData.push(...(json.data ?? []));
        nextUrl = json.paging?.next ?? null;
        pages++;

        // Pequeña pausa entre páginas para no saturar el rate limit
        if (nextUrl) await new Promise((r) => setTimeout(r, 300));
      }

      // Cachear SIEMPRE, incluso vacío: cuentas sin actividad no deben reconsultarse
      // cada carga de la vista global (era cuota quemada sin datos a cambio).
      await redis.setex(cacheKey, TTL.insights, JSON.stringify(allData));
      await redis.setex(staleKey, STALE_TTL, JSON.stringify(allData));
      return allData;
    } catch (e) {
      // Rate limit → servir el último dato bueno en vez de fallar.
      if (isRateLimit(e)) {
        const s = await redis.get(staleKey);
        if (s) return JSON.parse(s);
      }
      throw e;
    }
  });
}

// Insights a NIVEL CUENTA (totales), para el dashboard de rendimiento. Cacheado.
// force: lectura directa de Meta. Ni caché ni copia de respaldo: si Meta falla,
// lanza el error, para que nadie anote como reciente un dato que no lo es.
export async function getAccountInsights(
  accountId: string,
  datePreset = "last_7d",
  bmId?: string,
  operationId?: string,
  opts: FetchOpts = {}
): Promise<MetaInsights | null> {
  const cacheKey = `meta:acctins:${operationId ?? "all"}:${accountId}:${datePreset}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = opts.force ? null : await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  return coalesce(`${cacheKey}${opts.force ? ":force" : ""}`, async () => {
    const again = opts.force ? null : await redis.get(cacheKey);
    if (again) return JSON.parse(again);

    try {
      const { token } = await getActiveToken(bmId, operationId);
      const fields = "spend,impressions,clicks,ctr,cpc,cpm,actions,action_values,inline_link_clicks,unique_link_clicks_ctr";

      let urlParams: Record<string, string> = { fields, access_token: token };

      if (datePreset.startsWith("custom:")) {
        const [, since, until] = datePreset.split(":");
        urlParams.time_range = JSON.stringify({ since, until });
      } else if (datePreset === "today" && operationId) {
        const op = await prisma.operation.findUnique({
          where: { id: operationId },
          select: { timezone: true }
        });
        if (op?.timezone) {
          const now = new Date();
          const formatter = new Intl.DateTimeFormat('sv-SE', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: op.timezone,
          });
          const today = formatter.format(now);
          urlParams.time_range = JSON.stringify({ since: today, until: today });
        } else {
          urlParams.date_preset = datePreset;
        }
      } else {
        urlParams.date_preset = datePreset;
      }

      const params = new URLSearchParams(urlParams);
      const url = `${META_API_BASE}/act_${accountId}/insights?${params}`;
      const json = (await metaRequest("GET", `act_${accountId}/insights`, url, undefined, 3)) as { data?: MetaInsights[] };
      const row = json.data && json.data.length ? json.data[0] : null;
      await redis.setex(cacheKey, TTL.insights, JSON.stringify(row));
      await redis.setex(staleKey, STALE_TTL, JSON.stringify(row));
      return row;
    } catch (e) {
      if (!opts.force && isRateLimit(e)) {
        const s = await redis.get(staleKey);
        if (s) return JSON.parse(s);
      }
      throw e;
    }
  });
}

export async function updateEntityStatus(
  entityId: string,
  status: "ACTIVE" | "PAUSED",
  accountId: string,
  entityType: "campaign" | "adset" | "ad",
  bmId?: string
): Promise<void> {
  const { token } = await getActiveToken(bmId);
  await setEntityStatus(entityId, token, status);

  // Invalidar cachés relevantes (las claves reales llevan la operación delante).
  void entityType;
  await invalidateAccountCaches(accountId);
}

export async function verifyToken(token: string, bmMetaId: string): Promise<{ valid: boolean; name?: string }> {
  try {
    const json = await metaGet(`${bmMetaId}`, token, { fields: "id,name" });
    return { valid: true, name: json.name };
  } catch {
    return { valid: false };
  }
}

export async function invalidateAccountsCache(bmId?: string) {
  const pattern = `meta:accounts:${bmId ?? "*"}`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

// Borra el caché "fresco" de una cuenta (campañas, adsets, ads, insights) de
// TODAS las operaciones. Las claves llevan la operación delante
// (meta:campaigns:{op}:{cuenta}:…), así que el patrón la comodina. Las copias
// ":stale" se conservan: son el respaldo cuando Meta limita la cuenta.
export async function invalidateAccountCaches(accountId: string) {
  const acc = accountId.replace("act_", "");
  const patterns = [
    `meta:campaigns:*:${acc}:*`,
    `meta:adsets:*:account:${acc}`,
    `meta:ads:*:account:${acc}`,
    `meta:insights2:*:${acc}:*`,
  ];
  const keys = (await Promise.all(patterns.map((p) => redis.keys(p)))).flat().filter((k) => !k.endsWith(":stale"));
  if (keys.length > 0) await redis.del(...keys);
}

/** @deprecated usar invalidateAccountCaches (este nombre se conserva por compatibilidad). */
export async function invalidateCampaignsCache(accountId: string) {
  await invalidateAccountCaches(accountId);
}

// ─── Duplicación ──────────────────────────────────────────────────────────────

// ─── Clonación FROM SCRATCH de adsets (port app vieja) ──────────────────────────
// En vez de /copies (que deja el adset en IN_PROCESS y obliga a esperar 60s), se lee la
// config del adset original, se LIMPIA (buildAdsetPayload, evita error 100) y se crea uno
// nuevo con POST /adsets: instantáneo, sin IN_PROCESS, sin espera. El ad reusa el creative_id
// original de cada adset (no se recrea el creative).
// Se copian todos los anuncios del ad set, reutilizando su creativo: el ad_id es
// nuevo, pero creative_id y publicación son los del original (conserva la prueba social).
const ADS_PER_ADSET_MAX = 100;
const ADSET_GET_FIELDS = "name,status,daily_budget,lifetime_budget,bid_amount,bid_strategy," +
  "bid_constraints,billing_event,optimization_goal,targeting,promoted_object,pacing_type," +
  "destination_type,attribution_spec,start_time,end_time,ads.limit(" + ADS_PER_ADSET_MAX + "){name,status,creative{id}}";
const ADSET_SKIP = new Set(["id", "account_id", "created_time", "updated_time", "campaign_id", "name", "effective_status", "ads"]);

interface AdsetSpecAd { name: string; creativeId: string; status: "ACTIVE" | "PAUSED" }
interface AdsetSpec { origId: string; adsetName: string; payload: Record<string, string>; ads: AdsetSpecAd[] }
interface ReadyAdset { newId: string; ads: AdsetSpecAd[] }

const toAdItems = (adsets: ReadyAdset[]): AdToCreate[] =>
  adsets.flatMap((a) => a.ads.map((ad) => ({ newId: a.newId, ...ad })));

function buildAdsetPayload(raw: Record<string, unknown>): Record<string, string> {
  const a: Record<string, unknown> = { ...raw };
  if (a.destination_type === "UNDEFINED") delete a.destination_type;
  if (a.lifetime_budget === "0" || a.lifetime_budget === 0) delete a.lifetime_budget;
  if (a.daily_budget === "0" || a.daily_budget === 0) delete a.daily_budget; // CBO: budget va en campaña
  if (a.targeting && typeof a.targeting === "object") {
    const t = a.targeting as Record<string, unknown>;
    delete t.age_range;
    const igp = t.instagram_positions;
    if (Array.isArray(igp) && igp.includes("explore_home") && !igp.includes("explore")) igp.push("explore");
  }
  if (a.promoted_object && typeof a.promoted_object === "object") {
    delete (a.promoted_object as Record<string, unknown>).smart_pse_enabled;
  }
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (ADSET_SKIP.has(k) || v === null || v === undefined) continue;
    p[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return p;
}

// Lee la config completa de cada adset (batch GET) + su creative, lista para recrear.
async function fetchAdsetSpecs(adsetIds: string[], token: string, issues: DuplicateIssue[] = []): Promise<AdsetSpec[]> {
  const out: AdsetSpec[] = [];
  for (const group of chunk(adsetIds, BATCH_MAX)) {
    const results = await metaBatch(token, group.map((id) => ({
      method: "GET" as const, relative_url: `${id}?fields=${encodeURIComponent(ADSET_GET_FIELDS)}`,
    })));
    results.forEach((r, i) => {
      const id = group[i];
      const a = r.body as Record<string, unknown> | null;
      if (r.code !== 200 || !a || (a as { error?: unknown }).error) {
        console.error(`[fromscratch] No se pudo leer adset ${id}: ${JSON.stringify((a as { error?: unknown })?.error)}`);
        // Por cuota no se omite el ad set: saldría una copia incompleta sin motivo real.
        const err = batchError(r, `GET ${id}`);
        if (isRateLimitKind(err.kind)) throw err;
        return;
      }
      const edge = a.ads as {
        data?: Array<{ name: string; status?: string; creative?: { id: string } }>; paging?: { next?: string };
      } | undefined;
      // Solo lo vigente: archivados y borrados no se copian.
      const live = (edge?.data ?? []).filter((x) => x.status === "ACTIVE" || x.status === "PAUSED");
      const ads = live.flatMap((x) => (x.creative?.id
        ? [{ name: x.name, creativeId: x.creative.id, status: x.status as AdsetSpecAd["status"] }]
        : []));
      if (ads.length === 0) { console.error(`[fromscratch] Adset ${id} sin ad/creative`); return; }
      if (edge?.paging?.next) {
        issues.push({
          step: "ad", name: String(a.name ?? "Adset"), sourceId: id,
          error: serializeError(new Error(`Este ad set tiene más de ${ADS_PER_ADSET_MAX} anuncios: solo se copiaron los primeros ${ADS_PER_ADSET_MAX}`)),
        });
      }
      out.push({ origId: id, adsetName: String(a.name ?? "Adset"), payload: buildAdsetPayload(a), ads });
    });
  }
  return out;
}

// Crea adsets nuevos desde cero (POST /adsets, instantáneo — sin IN_PROCESS).
// CLAVE: batches CHICOS (de a 2) + reintento de transitorios. Batchear 25 de golpe es frágil:
// si un sub-request falla/timeout, Meta aborta el batch entero (error 960 "Request aborted")
// y se pierden los demás. De a 2 + retry → robusto.
const ADSET_BATCH_SIZE = 2;     // adsets de a 2 por llamada (no todos juntos)
const ADSET_MAX_ROUNDS = 6;     // reintentos de los que dan error transitorio
async function createAdsetsFromScratch(
  accountId: string, token: string, campaignId: string,
  specs: { spec: AdsetSpec; name: string }[],
  issues: DuplicateIssue[] = [],
  /** Job reanudable: ante cuota, cortar para que el worker lo pause y siga luego. */
  stopOnRateLimit = false,
): Promise<ReadyAdset[]> {
  const created: ReadyAdset[] = [];
  let pending = [...specs];
  const lastError = new Map<{ spec: AdsetSpec; name: string }, MetaApiError>();

  for (let round = 0; round < ADSET_MAX_ROUNDS && pending.length > 0; round++) {
    if (round > 0) await sleep(5000); // respiro entre rondas
    const next: { spec: AdsetSpec; name: string }[] = [];

    for (const group of chunk(pending, ADSET_BATCH_SIZE)) {
      let results: BatchRes[];
      try {
        results = await metaBatch(token, group.map(({ spec, name }) => {
          const f = new URLSearchParams({ ...spec.payload, campaign_id: campaignId, name });
          f.set("status", "ACTIVE");
          return { method: "POST" as const, relative_url: `act_${accountId}/adsets`, body: f.toString() };
        }));
      } catch (e) {
        // El batch falló entero: si es definitivo (token, permiso) no tiene sentido seguir.
        if (e instanceof MetaApiError && (!e.retryable || (stopOnRateLimit && isRateLimitKind(e.kind)))) throw e;
        for (const it of group) if (e instanceof MetaApiError) lastError.set(it, e);
        next.push(...group); // probable rate limit → reintentar todos
        continue;
      }
      results.forEach((r, i) => {
        const item = group[i];
        const body = r.body as { id?: string } | null;
        if (r.code === 200 && body?.id) {
          created.push({ newId: body.id, ads: item.spec.ads });
          return;
        }
        const err = batchError(r, `POST act_${accountId}/adsets`);
        if (stopOnRateLimit && isRateLimitKind(err.kind)) throw err;
        // 960 = Meta abortó el batch por culpa de otro sub-request → reintentable.
        if (err.retryable || err.detail.code === 960) {
          lastError.set(item, err);
          next.push(item);
        } else {
          console.error(`[fromscratch] Falló (no reintentable) adset orig ${item.spec.origId}: ${JSON.stringify(err.detail)}`);
          issues.push({ step: "adset", name: item.name, sourceId: item.spec.origId, error: err.toJSON() });
        }
      });
    }
    if (next.length) console.warn(`[fromscratch] Ronda ${round + 1}: ${created.length} OK, ${next.length} a reintentar`);
    pending = next;
  }
  // Lo que siguió fallando tras todas las rondas también se informa (con su último error).
  for (const item of pending) {
    issues.push({
      step: "adset", name: item.name, sourceId: item.spec.origId,
      error: serializeError(lastError.get(item) ?? new Error(`No se pudo crear tras ${ADSET_MAX_ROUNDS} intentos`)),
    });
  }
  return created;
}

/** Algo que no salió en una duplicación: qué elemento, en qué paso y el error explicado. */
export interface DuplicateIssue {
  step: "campaign" | "adset" | "ad" | "status";
  name: string;
  sourceId?: string;
  error: SerializedError;
}

export interface DuplicateResult {
  newCampaignId: string;
  adsetsCount: number;
  adsCount: number;
  adsetsExpected?: number;
  adsExpected?: number;
  resumed?: boolean;
  issues?: DuplicateIssue[];
}

// La configuración de la campaña original se lee una vez por tanda y la reutilizan todas
// las copias de esa tanda (y sus reintentos): así 50 copias no leen 50 veces lo mismo.
// Cada tanda nueva la borra al crearse (invalidateDuplicationSource).
const SOURCE_TTL = 1800;
interface CampaignSource { adsetCount: number; specs: AdsetSpec[]; issues: DuplicateIssue[] }

/** Borra la lectura guardada de las campañas origen: la primera copia de la tanda vuelve a leer de Meta. */
export async function invalidateDuplicationSource(campaignIds: string[]): Promise<void> {
  if (campaignIds.length === 0) return;
  await redis.del(...campaignIds.map((id) => `meta:dup-source:${id}`)).catch(() => {});
}

async function readCampaignSource(campaignId: string, token: string): Promise<CampaignSource> {
  const key = `meta:dup-source:${campaignId}`;
  const cached = await redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached) as CampaignSource;

  const adsetsJson = await metaGet(`${campaignId}/adsets`, token, { fields: "id", limit: "200" }, 1);
  const ids: string[] = (adsetsJson.data ?? []).map((a: { id: string }) => a.id);
  if (ids.length === 0) throw new Error(`La campaña original (${campaignId}) no tiene ad sets: no hay nada que copiar. No se creó ninguna copia.`);
  const issues: DuplicateIssue[] = [];
  const specs = await fetchAdsetSpecs(ids, token, issues);
  if (specs.length === 0) {
    throw new Error(`Ningún ad set de la campaña original (${campaignId}) tiene anuncios activos o pausados con creativo, o no se pudieron leer: no hay nada que copiar. No se creó ninguna copia.`);
  }
  const source = { adsetCount: ids.length, specs, issues };
  await redis.setex(key, SOURCE_TTL, JSON.stringify(source)).catch(() => {});
  return source;
}

export interface DuplicateCampaignOpts {
  /** Copia creada en un intento anterior del mismo job: se continúa sobre ella. */
  resumeCampaignId?: string;
  /** Se llama en cuanto existe la copia, para guardarla y poder reanudar. */
  onCheckpoint?: (data: { newCampaignId: string }) => Promise<void>;
  operationId?: string;
}

export async function duplicateCampaign(
  campaignId: string,
  accountId: string,
  name: string,
  status: "ACTIVE" | "PAUSED",
  bmId?: string,
  onProgress?: ProgressCallback,
  checkCancelled?: () => Promise<void>,
  opts: DuplicateCampaignOpts = {}
): Promise<DuplicateResult> {
  const cb = onProgress ?? noop;
  const { token } = await getActiveToken(bmId, opts.operationId);
  const issues: DuplicateIssue[] = [];

  // Fase 1: leer la configuración del origen ANTES de crear nada. Si el origen no tiene
  // ad sets ni anuncios que copiar, el trabajo falla aquí y no deja una campaña vacía en Meta.
  await cb(3, "Leyendo ad sets originales...");
  const source = await readCampaignSource(campaignId, token);
  const { specs } = source;
  issues.push(...source.issues);
  if (specs.length < source.adsetCount) {
    issues.push({
      step: "adset", name: `${source.adsetCount - specs.length} ad set(s) sin anuncio o ilegibles`,
      error: serializeError(new Error("Se omitieron porque no tienen un anuncio con creativo que reutilizar")),
    });
  }
  console.log(`[duplicate] Config lista de ${specs.length}/${source.adsetCount} adsets`);
  if (checkCancelled) await checkCancelled();

  // Fase 2: la copia. Se crea PAUSADA y solo se activa al final si se pidió:
  // si el job muere a mitad, no queda una campaña gastando a medio montar.
  let newCampaignId = opts.resumeCampaignId;
  let resumed = false;
  if (newCampaignId) {
    try {
      await metaGet(newCampaignId, token, { fields: "id" }, 1);
      resumed = true;
      await cb(8, `Reanudando sobre la copia ya creada (${newCampaignId})`);
    } catch (e) {
      if (!(e instanceof MetaApiError && e.kind === "not_found")) throw e;
      await cb(5, "La copia anterior ya no existe; se crea una nueva");
      newCampaignId = undefined;
    }
  }
  if (!newCampaignId) {
    await cb(5, "Copiando campaña (en pausa)...");
    console.log(`[duplicate] INICIO | campaignId=${campaignId} accountId=${accountId} name="${name}" status=${status}`);
    const campaignJson = await metaPost(`${campaignId}/copies`, token, { name, status_option: "PAUSED" });
    newCampaignId = (campaignJson.copied_campaign_id ?? campaignJson.id) as string;
    await opts.onCheckpoint?.({ newCampaignId });
    console.log(`[duplicate] Campaña copiada | newCampaignId=${newCampaignId}`);
    await cb(10, `Campaña copiada → ${newCampaignId}`);
  }

  // Al reanudar, los ad sets que ya existen en la copia (mismo nombre) no se recrean.
  let work = specs.map((s) => ({ spec: s, name: s.adsetName }));
  const existing: ReadyAdset[] = [];
  if (resumed) {
    const cur = await metaGet(`${newCampaignId}/adsets`, token, { fields: "id,name", limit: "200" }, 1);
    const pool = [...((cur.data ?? []) as Array<{ id: string; name: string }>)];
    work = work.filter((w) => {
      const idx = pool.findIndex((a) => a.name === w.name);
      if (idx === -1) return true;
      existing.push({ newId: pool[idx].id, ads: w.spec.ads });
      pool.splice(idx, 1);
      return false;
    });
    await cb(25, `${existing.length} ad sets ya estaban creados; faltan ${work.length}`);
  }

  // Fase 3: Crear adsets DESDE CERO (POST /adsets, instantáneo — sin IN_PROCESS, sin espera de 60s).
  await cb(30, `Creando ${work.length} adsets (desde cero)...`);
  const createdAdsets = [
    ...existing,
    ...(work.length ? await createAdsetsFromScratch(accountId, token, newCampaignId, work, issues, true) : []),
  ];
  const adsetsOk = createdAdsets.length;
  console.log(`[duplicate] ${adsetsOk}/${specs.length} adsets listos (from scratch${resumed ? ", reanudado" : ""})`);
  if (checkCancelled) await checkCancelled();

  // Fase 4: Crear ads (de a 2, reusan el creative ORIGINAL de cada adset).
  await cb(55, "Creando ads (de a 2)...");
  const adItems = toAdItems(createdAdsets);
  const { adsOk, failed } = await createAdsBatched(accountId, token, adItems, cb, 55, 96, checkCancelled, {
    dedupFirst: resumed, issues, stopOnRateLimit: true,
  });
  console.log(`[duplicate] FIN | ${adsetsOk} adsets, ${adsOk}/${adItems.length} ads | ${failed.length} fallidos`);

  // Fase 5: activar solo si se pidió (la copia nació pausada).
  if (status === "ACTIVE") {
    await cb(97, "Activando campaña...");
    try {
      await setEntityStatus(newCampaignId, token, "ACTIVE");
    } catch (e) {
      console.error(`[duplicate] Error activando campaña:`, e);
      issues.push({ step: "status", name: "Activar la campaña copiada", sourceId: newCampaignId, error: serializeError(e) });
    }
  }

  const summary = `${adsetsOk}/${specs.length} adsets, ${adsOk}/${adItems.length} ads`;
  await cb(100, issues.length ? `Completado con avisos: ${summary} (${issues.length} incidencia${issues.length > 1 ? "s" : ""})` : `Completado: ${summary}`);
  return {
    newCampaignId, adsetsCount: adsetsOk, adsCount: adsOk,
    adsetsExpected: specs.length, adsExpected: adItems.length, resumed,
    ...(issues.length ? { issues } : {}),
  };
}

export async function duplicateAdsets(
  adsetIds: string[],
  targetCampaignId: string,
  accountId: string,
  bmId?: string,
  onProgress?: ProgressCallback,
  count: number = 1,
  checkCancelled?: () => Promise<void>
): Promise<{ adsetsCount: number; adsCount: number; issues?: DuplicateIssue[] }> {
  const cb = onProgress ?? noop;
  const { token } = await getActiveToken(bmId);
  const issues: DuplicateIssue[] = [];

  // Fase 1: Leer config completa de cada adset ORIGEN (config + creative) — FROM SCRATCH.
  if (checkCancelled) await checkCancelled();
  await cb(10, `Leyendo config de ${adsetIds.length} adset(s)...`);
  const specs = await fetchAdsetSpecs(adsetIds, token, issues);
  if (specs.length === 0) throw new Error("No se pudo leer la config de ningún adset");

  // Lista de trabajo: cada adset origen × count, creado DESDE CERO (sin /copies, sin IN_PROCESS).
  const work: { spec: AdsetSpec; name: string }[] = [];
  for (let c = 0; c < count; c++) for (const spec of specs) work.push({ spec, name: spec.adsetName });
  const total = work.length;

  // Fase 2: Crear adsets desde cero (POST /adsets, instantáneo — sin IN_PROCESS, sin espera de 60s).
  if (checkCancelled) await checkCancelled();
  await cb(25, `Creando ${total} adsets (desde cero)...`);
  const createdAdsets = await createAdsetsFromScratch(accountId, token, targetCampaignId, work, issues);
  if (createdAdsets.length === 0) {
    await cb(100, "No se pudo crear ningún adset");
    return { adsetsCount: 0, adsCount: 0, issues };
  }
  console.log(`[duplicateAdsets] ${createdAdsets.length}/${total} adsets creados (from scratch)`);

  // Fase 3: Crear ads (de a 2, reusan el creative ORIGINAL de cada adset) — sin cambios.
  if (checkCancelled) await checkCancelled();
  await cb(55, "Creando ads (de a 2)...");
  const adItems = toAdItems(createdAdsets);
  const { adsOk, failed } = await createAdsBatched(accountId, token, adItems, cb, 55, 99, checkCancelled, { issues });
  console.log(`[duplicateAdsets] FIN: ${createdAdsets.length} adsets, ${adsOk}/${adItems.length} ads | ${failed.length} fallidos`);

  await cb(100, `Completado: ${createdAdsets.length} adsets, ${adsOk}/${adItems.length} ads`);
  return { adsetsCount: createdAdsets.length, adsCount: adsOk, ...(issues.length ? { issues } : {}) };
}

export async function duplicateAds(
  ads: Array<{ name: string; creativeId: string }>,
  targetAdsetId: string,
  accountId: string,
  bmId?: string,
  onProgress?: ProgressCallback,
  checkCancelled?: () => Promise<void>
): Promise<{ adsCount: number }> {
  const cb = onProgress ?? noop;
  const { token } = await getActiveToken(bmId);
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  if (checkCancelled) await checkCancelled();
  await cb(5, "Verificando estado del adset destino...");
  const adsetInfo = await metaGet(targetAdsetId, token, { fields: "status,effective_status,campaign_id" });
  const campaignId: string = adsetInfo.campaign_id;
  const adsetWasPaused = adsetInfo.status === "PAUSED";
  const campaignWasPaused = adsetInfo.effective_status === "CAMPAIGN_PAUSED";

  if (campaignWasPaused) {
    await setEntityStatus(campaignId, token, "ACTIVE");
    await delay(2000);
  }
  if (adsetWasPaused || campaignWasPaused) {
    await setEntityStatus(targetAdsetId, token, "ACTIVE");
    await delay(2000);
  }

  // Crear todos los ads en paralelo
  await cb(20, `Creando ${ads.length} ads en paralelo...`);

  type AdResult = { name: string; creativeId: string; adId: string | null };

  const adResults = await Promise.all(ads.map(async (ad) => {
    const adId = await createAdBracket(accountId, targetAdsetId, token, ad.name, ad.creativeId);
    return { name: ad.name, creativeId: ad.creativeId, adId: adId ?? null } as AdResult;
  }));

  let adsOk = adResults.filter((r) => r.adId && r.adId !== "unverified").length;

  // Segundo pase para "unverified" y fallidos
  const needsCheck = adResults.filter((r) => !r.adId || r.adId === "unverified");
  if (needsCheck.length > 0) {
    await cb(75, `Segundo pase: ${needsCheck.length} ads a verificar/reintentar...`);
    await delay(30000);
    if (checkCancelled) await checkCancelled();
    for (const item of needsCheck) {
      if (item.adId === "unverified") {
        try {
          const check = await metaGet(`${targetAdsetId}/ads`, token, { fields: "id,name", limit: "10" }, 1);
          const existing = (check.data ?? []).find((a: { name: string }) => a.name === item.name);
          if (existing) { adsOk++; continue; }
        } catch { }
      }
      const retryId = await createAdBracket(accountId, targetAdsetId, token, item.name, item.creativeId);
      if (retryId) adsOk++;
      await delay(500);
    }
  }

  if (adsetWasPaused || campaignWasPaused) {
    await setEntityStatus(targetAdsetId, token, "PAUSED");
  }
  if (campaignWasPaused) {
    await setEntityStatus(campaignId, token, "PAUSED");
  }

  await cb(100, `Completado: ${adsOk}/${ads.length} ads creados`);
  return { adsCount: adsOk };
}
