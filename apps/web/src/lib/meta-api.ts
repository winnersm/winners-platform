import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";
import { redis } from "@/lib/redis";

const META_API_BASE = "https://graph.facebook.com/v21.0";
// TTLs en segundos. Estructura cambia poco → caché largo (ahorra cuota Meta).
// Insights = datos financieros → balance frescura/cuota; el botón ↻ siempre trae fresco.
const TTL = { accounts: 21600, campaigns: 1800, adsets: 1800, ads: 1800, insights: 3600 };
const STALE_TTL = 43200; // 12h: copia de respaldo para servir cuando Meta limita la cuenta (error 17).

// Detecta errores de rate limit de Meta (17 cuenta, 4 app, 32 página, 613 custom, 80004).
function isRateLimit(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\berror (4|17|32|613|80004)\b|request limit|rate limit/i.test(m);
}

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
      ...(bmId ? { id: bmId } : {}),
      ...(operationId ? { operationId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (!bm) throw new Error("No hay Business Manager configurado con token activo");
  return { token: decrypt(bm.encryptedToken), bmDbId: bm.id };
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

async function metaGet(path: string, token: string, params: Record<string, string> = {}, retries = 3) {
  const url = new URL(`${META_API_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString());
    const json = await res.json();
    void captureUsage(res);
    if (!json.error) return json;

    const code: number = json.error.code;
    console.error(`[metaGet] ERROR en /${path} (intento ${attempt + 1}) → ${code}: ${json.error.message}`);

    // Error 17 = rate limit de la cuenta → backoff exponencial con tope de 60s.
    if (code === 17 && attempt < retries) {
      const wait = Math.min(60000, 5000 * Math.pow(2, attempt)); // 5s,10s,20s,40s,60s,60s...
      console.warn(`[metaGet] Rate limit (17), esperando ${wait}ms (intento ${attempt + 1}/${retries + 1})...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    throw new Error(`Meta API error ${code}: ${json.error.message}`);
  }
}

async function metaPost(path: string, token: string, body: Record<string, string | boolean | number>, retries = 3) {
  const url = new URL(`${META_API_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  const encoded = new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encoded,
    });
    const json = await res.json();
    void captureUsage(res);
    if (!json.error) return json;

    const code: number = json.error.code;
    console.error(`[metaPost] ERROR en /${path} (intento ${attempt + 1}) → ${code}: ${json.error.message}`);

    // Error 17 = rate limit de la cuenta publicitaria → backoff exponencial largo
    if (code === 17 && attempt < retries) {
      const wait = 10000 * Math.pow(2, attempt); // 10s, 20s, 40s
      console.warn(`[metaPost] Rate limit (17), esperando ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if ((code === 2 || code === 1) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }

    throw new Error(`Meta API error ${code}: ${json.error.message}`);
  }
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

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await res.json();
    void captureUsage(res);

    // Error a nivel del batch entero (p.ej. rate limit del batch).
    if (json.error) {
      const code: number = json.error.code;
      if (code === 17 && attempt < retries) {
        const wait = Math.min(60000, 5000 * Math.pow(2, attempt));
        console.warn(`[batch] Rate limit (17) en el batch completo, esperando ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`Meta batch error ${code}: ${json.error.message}`);
    }

    // json = array de { code, headers, body(string) }. body puede ser null si el sub-request expiró.
    return (json as Array<{ code?: number; body?: string } | null>).map((sub) => ({
      code: sub?.code ?? 0,
      body: sub?.body ? JSON.parse(sub.body) : null,
    }));
  }
  throw new Error("Meta batch: agotados los reintentos");
}

async function setEntityStatus(entityId: string, token: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const url = new URL(`${META_API_BASE}/${entityId}`);
  url.searchParams.set("access_token", token);
  await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ status }).toString(),
  });
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

interface AdToCreate { newId: string; name: string; creativeId: string }

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
  constructor(msg: string) { super(msg); this.name = "FatalAdError"; }
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
  checkCancelled?: () => Promise<void>
): Promise<{ adsOk: number; failed: AdToCreate[] }> {
  const total = items.length;
  let adsOk = 0;
  let pending = [...items];
  let wait = AD_WAIT_BASE; // espera adaptativa entre rondas

  for (let round = 0; round < AD_MAX_ATTEMPTS && pending.length > 0; round++) {
    if (checkCancelled) await checkCancelled();
    let sawRateLimit = false; // ¿esta ronda tuvo error 17? → back-off; si no, seguir corto.

    if (round > 0) {
      console.log(`[ads-batch] Ronda ${round + 1}: esperando ${wait / 1000}s antes de reintentar ${pending.length}...`);
      await new Promise((r) => setTimeout(r, wait));
      if (checkCancelled) await checkCancelled();

      // Dedup por batch GET: cuáles pendientes YA tienen el ad (falso positivo) → no recrear.
      const stillPending: AdToCreate[] = [];
      for (const group of chunk(pending, AD_BATCH_SIZE)) {
        let results: BatchRes[];
        try {
          results = await metaBatch(token, group.map((it) => ({
            method: "GET" as const, relative_url: `${it.newId}/ads?fields=name&limit=10`,
          })));
        } catch {
          stillPending.push(...group); // batch GET falló entero (probable 17) → reintentar todos
          sawRateLimit = true;
          continue;
        }
        results.forEach((r, i) => {
          const it = group[i];
          const body = r.body as { data?: Array<{ name: string }> } | null;
          if (r.code === 200 && (body?.data ?? []).some((a) => a.name === it.name)) {
            adsOk++;
            console.log(`[ads-batch] ✅ ya existía (falso positivo) | adset=${it.newId}`);
          } else {
            stillPending.push(it);
          }
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
        f.set("status", "ACTIVE");
        return { method: "POST" as const, relative_url: `act_${accountId}/ads`, body: f.toString() };
      }));
      results.forEach((r, i) => {
        const it = group[i];
        const body = r.body as { id?: string; error?: MetaAdError } | null;
        if (r.code === 200 && body?.id) {
          adsOk++;
        } else if (isTransientAdError(body?.error?.code, body?.error?.error_subcode, r.code)) {
          if (body?.error?.code === 17) sawRateLimit = true;
          nextPending.push(it);
        } else {
          const err = body?.error;
          console.error(`[ads-batch] ❌ error no reintentable | adset=${it.newId}: ${JSON.stringify(err)}`);
          // Fatal (permiso/token/config): no sirve reintentar ni seguir con los demás → abortar ya.
          if (isFatalAdError(err?.code, err?.error_subcode)) {
            throw new FatalAdError(humanizeMetaError(err));
          }
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

export async function getAdAccounts(bmId?: string, operationId?: string): Promise<MetaAdAccount[]> {
  const cacheKey = `meta:accounts:${operationId ?? "all"}:${bmId ?? "default"}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const activeBMs = await prisma.businessManager.findMany({
    where: {
      status: "active",
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
      const res = await fetch(nextUrl);
      const json = (await res.json()) as { data?: Record<string, string>[], error?: unknown, paging?: { next?: string } };
      // Nunca devolver (ni cachear) una lista PARCIAL: un error a mitad de
      // paginación dejaría fuera cuentas reales. Quien archiva por ausencia
      // (dashboard-sync) las borraría del dashboard por error. Mejor fallar y
      // que el llamador decida (los syncs hacen catch y se saltan la pasada).
      if (json.error) {
        throw new Error(`Meta error al listar cuentas (BM ${bm.id}): ${JSON.stringify(json.error)}`);
      }
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
  operationId?: string
): Promise<{ campaigns: MetaCampaign[]; nextCursor: string | null; stale?: boolean }> {
  const cacheKey = `meta:campaigns:${operationId ?? "all"}:${accountId}:${cursor ?? "first"}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { token } = await getActiveToken(bmId, operationId);
  const fields = "id,name,status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,special_ad_categories";
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
  operationId?: string
): Promise<MetaAdSet[]> {
  const cacheKey = campaignId ? `meta:adsets:${operationId ?? "all"}:${campaignId}` : `meta:adsets:${operationId ?? "all"}:account:${accountId}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { token } = await getActiveToken(bmId, operationId);
  const fields = "id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,start_time,end_time";
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
  operationId?: string
): Promise<MetaAd[]> {
  const cacheKey = adsetId ? `meta:ads:${operationId ?? "all"}:${adsetId}` : `meta:ads:${operationId ?? "all"}:account:${accountId}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = await redis.get(cacheKey);
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
  operationId?: string
): Promise<MetaInsights[]> {
  const cacheKey = `meta:insights2:${operationId ?? "all"}:${accountId}:${level}:${datePreset}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  return coalesce(cacheKey, async () => {
    // Otro caller pudo llenar el caché mientras esperábamos el turno.
    const again = await redis.get(cacheKey);
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
        let retries = 0;
        let json: { data?: MetaInsights[]; error?: { code: number; message: string }; paging?: { next?: string } } | null = null;

        while (retries <= 3) {
          const pageRes: Response = await fetch(nextUrl);
          json = (await pageRes.json()) as typeof json;
          if (!json!.error) break;
          if (json!.error!.code === 17 && retries < 3) {
            const wait = 5000 * Math.pow(2, retries);
            console.warn(`[getInsights] Rate limit (17), esperando ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            retries++;
          } else {
            throw new Error(`Meta API error ${json!.error!.code}: ${json!.error!.message}`);
          }
        }

        allData.push(...(json!.data ?? []));
        nextUrl = json!.paging?.next ?? null;
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
export async function getAccountInsights(
  accountId: string,
  datePreset = "last_7d",
  bmId?: string,
  operationId?: string
): Promise<MetaInsights | null> {
  const cacheKey = `meta:acctins:${operationId ?? "all"}:${accountId}:${datePreset}`;
  const staleKey = `${cacheKey}:stale`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  return coalesce(cacheKey, async () => {
    const again = await redis.get(cacheKey);
    if (again) return JSON.parse(again);

    try {
      const { token } = await getActiveToken(bmId, operationId);
      const fields = "spend,impressions,clicks,ctr,cpc,cpm,actions,action_values,inline_link_clicks,unique_link_clicks_ctr";
      const url = `${META_API_BASE}/act_${accountId}/insights?fields=${fields}&date_preset=${datePreset}&access_token=${token}`;
      const res = await fetch(url);
      const json = await res.json() as { data?: MetaInsights[]; error?: { code?: number; message?: string } };
      if (json.error) throw new Error(`Meta API error ${json.error.code ?? ""}: ${json.error.message ?? "Error al leer insights de cuenta"}`);
      const row = json.data && json.data.length ? json.data[0] : null;
      await redis.setex(cacheKey, TTL.insights, JSON.stringify(row));
      await redis.setex(staleKey, STALE_TTL, JSON.stringify(row));
      return row;
    } catch (e) {
      if (isRateLimit(e)) {
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

  // Invalidar cachés relevantes
  if (entityType === "campaign") {
    await invalidateCampaignsCache(accountId);
  } else {
    // Para adsets/ads: invalidar cachés de cuenta y específicos
    const patterns = [
      `meta:adsets:account:${accountId}`,
      `meta:ads:account:${accountId}`,
    ];
    const keys = (await Promise.all(patterns.map(p => redis.keys(p)))).flat();
    if (keys.length > 0) await redis.del(...keys);
  }
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

export async function invalidateCampaignsCache(accountId: string) {
  const keys = await redis.keys(`meta:campaigns:${accountId}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

// ─── Duplicación ──────────────────────────────────────────────────────────────

// ─── Clonación FROM SCRATCH de adsets (port app vieja) ──────────────────────────
// En vez de /copies (que deja el adset en IN_PROCESS y obliga a esperar 60s), se lee la
// config del adset original, se LIMPIA (buildAdsetPayload, evita error 100) y se crea uno
// nuevo con POST /adsets: instantáneo, sin IN_PROCESS, sin espera. El ad reusa el creative_id
// original de cada adset (no se recrea el creative).
const ADSET_GET_FIELDS = "name,status,daily_budget,lifetime_budget,bid_amount,bid_strategy," +
  "bid_constraints,billing_event,optimization_goal,targeting,promoted_object,pacing_type," +
  "destination_type,attribution_spec,start_time,end_time,ads.limit(1){name,creative{id}}";
const ADSET_SKIP = new Set(["id", "account_id", "created_time", "updated_time", "campaign_id", "name", "effective_status", "ads"]);

interface AdsetSpec { origId: string; adsetName: string; payload: Record<string, string>; adName: string; creativeId: string }

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
async function fetchAdsetSpecs(adsetIds: string[], token: string): Promise<AdsetSpec[]> {
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
        return;
      }
      const ads = (a.ads as { data?: Array<{ name: string; creative?: { id: string } }> } | undefined)?.data ?? [];
      const ad = ads.find((x) => x.creative?.id);
      if (!ad) { console.error(`[fromscratch] Adset ${id} sin ad/creative`); return; }
      out.push({ origId: id, adsetName: String(a.name ?? "Adset"), payload: buildAdsetPayload(a), adName: ad.name, creativeId: ad.creative!.id });
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
): Promise<{ newId: string; adName: string; creativeId: string }[]> {
  const created: { newId: string; adName: string; creativeId: string }[] = [];
  let pending = [...specs];

  for (let round = 0; round < ADSET_MAX_ROUNDS && pending.length > 0; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 5000)); // respiro entre rondas
    const next: { spec: AdsetSpec; name: string }[] = [];

    for (const group of chunk(pending, ADSET_BATCH_SIZE)) {
      let results: BatchRes[];
      try {
        results = await metaBatch(token, group.map(({ spec, name }) => {
          const f = new URLSearchParams({ ...spec.payload, campaign_id: campaignId, name });
          f.set("status", "ACTIVE");
          return { method: "POST" as const, relative_url: `act_${accountId}/adsets`, body: f.toString() };
        }));
      } catch {
        next.push(...group); // el batch falló entero (probable 17) → reintentar todos
        continue;
      }
      results.forEach((r, i) => {
        const item = group[i];
        const body = r.body as { id?: string; error?: { code?: number; error_subcode?: number } } | null;
        if (r.code === 200 && body?.id) {
          created.push({ newId: body.id, adName: item.spec.adName, creativeId: item.spec.creativeId });
        } else {
          const code = body?.error?.code;
          // transitorios → reintentar (2/1 unexpected, 17 rate limit, 960 abort, 5xx, sub-request null)
          if (code === 2 || code === 1 || code === 17 || code === 960 || r.code >= 500 || r.code === 0) {
            next.push(item);
          } else {
            console.error(`[fromscratch] Falló (no reintentable) adset orig ${item.spec.origId}: ${JSON.stringify(body?.error)}`);
          }
        }
      });
    }
    if (next.length) console.warn(`[fromscratch] Ronda ${round + 1}: ${created.length} OK, ${next.length} a reintentar`);
    pending = next;
  }
  return created;
}

export interface DuplicateResult {
  newCampaignId: string;
  adsetsCount: number;
  adsCount: number;
}

export async function duplicateCampaign(
  campaignId: string,
  accountId: string,
  name: string,
  status: "ACTIVE" | "PAUSED",
  bmId?: string,
  onProgress?: ProgressCallback,
  checkCancelled?: () => Promise<void>
): Promise<DuplicateResult> {
  const cb = onProgress ?? noop;
  const { token } = await getActiveToken(bmId);

  // Fase 1: Copiar campaña como ACTIVE
  await cb(5, "Copiando campaña como ACTIVE...");
  console.log(`[duplicate] INICIO | campaignId=${campaignId} accountId=${accountId} name="${name}" status=${status}`);
  const campaignJson = await metaPost(`${campaignId}/copies`, token, { name, status_option: "ACTIVE" });
  const newCampaignId: string = campaignJson.copied_campaign_id ?? campaignJson.id;
  console.log(`[duplicate] Campaña copiada | newCampaignId=${newCampaignId}`);
  await cb(10, `Campaña copiada → ${newCampaignId}`);

  // Fase 2: Leer config completa de los adsets originales (+ creative por adset) — FROM SCRATCH.
  await cb(15, "Leyendo adsets originales...");
  const adsetsJson = await metaGet(`${campaignId}/adsets`, token, { fields: "id", limit: "200" }, 8);
  const origAdsetIds: string[] = (adsetsJson.data ?? []).map((a: { id: string }) => a.id);
  if (origAdsetIds.length === 0) throw new Error("La campaña original no tiene adsets");
  const specs = await fetchAdsetSpecs(origAdsetIds, token);
  if (specs.length === 0) throw new Error("No se pudo leer la config de ningún adset");
  console.log(`[duplicate] Config leída de ${specs.length}/${origAdsetIds.length} adsets`);
  if (checkCancelled) await checkCancelled();

  // Fase 3: Crear adsets DESDE CERO (POST /adsets, instantáneo — sin IN_PROCESS, sin espera de 60s).
  await cb(30, `Creando ${specs.length} adsets (desde cero)...`);
  const createdAdsets = await createAdsetsFromScratch(
    accountId, token, newCampaignId, specs.map((s) => ({ spec: s, name: s.adsetName })),
  );
  const adsetsOk = createdAdsets.length;
  console.log(`[duplicate] ${adsetsOk}/${specs.length} adsets creados (from scratch)`);
  if (checkCancelled) await checkCancelled();

  // Fase 4: Crear ads (de a 2, reusan el creative ORIGINAL de cada adset) — sin cambios.
  await cb(55, "Creando ads (de a 2)...");
  const adItems: AdToCreate[] = createdAdsets.map((a) => ({ newId: a.newId, name: a.adName, creativeId: a.creativeId }));
  const { adsOk, failed } = await createAdsBatched(accountId, token, adItems, cb, 55, 96, checkCancelled);
  console.log(`[duplicate] FIN | ${adsetsOk} adsets, ${adsOk}/${createdAdsets.length} ads | ${failed.length} fallidos`);

  // Fase 9: Pausar campaña si el usuario lo pidió
  if (status === "PAUSED") {
    await cb(97, "Pausando campaña...");
    try {
      await setEntityStatus(newCampaignId, token, "PAUSED");
    } catch (e) {
      console.error(`[duplicate] Error pausando campaña:`, e);
    }
  }

  await cb(100, `Completado: ${adsetsOk} adsets, ${adsOk}/${createdAdsets.length} ads`);
  return { newCampaignId, adsetsCount: adsetsOk, adsCount: adsOk };
}

export async function duplicateAdsets(
  adsetIds: string[],
  targetCampaignId: string,
  accountId: string,
  bmId?: string,
  onProgress?: ProgressCallback,
  count: number = 1,
  checkCancelled?: () => Promise<void>
): Promise<{ adsetsCount: number; adsCount: number }> {
  const cb = onProgress ?? noop;
  const { token } = await getActiveToken(bmId);

  // Fase 1: Leer config completa de cada adset ORIGEN (config + creative) — FROM SCRATCH.
  if (checkCancelled) await checkCancelled();
  await cb(10, `Leyendo config de ${adsetIds.length} adset(s)...`);
  const specs = await fetchAdsetSpecs(adsetIds, token);
  if (specs.length === 0) throw new Error("No se pudo leer la config de ningún adset");

  // Lista de trabajo: cada adset origen × count, creado DESDE CERO (sin /copies, sin IN_PROCESS).
  const work: { spec: AdsetSpec; name: string }[] = [];
  for (let c = 0; c < count; c++) for (const spec of specs) work.push({ spec, name: spec.adsetName });
  const total = work.length;

  // Fase 2: Crear adsets desde cero (POST /adsets, instantáneo — sin IN_PROCESS, sin espera de 60s).
  if (checkCancelled) await checkCancelled();
  await cb(25, `Creando ${total} adsets (desde cero)...`);
  const createdAdsets = await createAdsetsFromScratch(accountId, token, targetCampaignId, work);
  if (createdAdsets.length === 0) {
    await cb(100, "No se pudo crear ningún adset");
    return { adsetsCount: 0, adsCount: 0 };
  }
  console.log(`[duplicateAdsets] ${createdAdsets.length}/${total} adsets creados (from scratch)`);

  // Fase 3: Crear ads (de a 2, reusan el creative ORIGINAL de cada adset) — sin cambios.
  if (checkCancelled) await checkCancelled();
  await cb(55, "Creando ads (de a 2)...");
  const adItems: AdToCreate[] = createdAdsets.map((a) => ({ newId: a.newId, name: a.adName, creativeId: a.creativeId }));
  const { adsOk, failed } = await createAdsBatched(accountId, token, adItems, cb, 55, 99, checkCancelled);
  console.log(`[duplicateAdsets] FIN: ${createdAdsets.length} adsets, ${adsOk}/${createdAdsets.length} ads | ${failed.length} fallidos`);

  await cb(100, `Completado: ${createdAdsets.length} adsets, ${adsOk}/${total} ads`);
  return { adsetsCount: createdAdsets.length, adsCount: adsOk };
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
