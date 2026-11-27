// ─── Validador de tokens de Meta ────────────────────────────────────────────
// Migrado del «Validar Token» de dash.mastermindwinners.com. Allí la Graph API se
// consultaba desde el navegador; aquí se hace en el servidor para que cada llamada
// pase por metaFetch (reporte de «Llamadas a Meta») y los errores salgan explicados.
// El token solo se usa para estas llamadas: nunca se guarda ni se registra.
import { metaFetch } from "@/lib/meta-calls";
import { MetaApiError, serializeError, type SerializedError } from "@/lib/meta-errors";
import { toDetail, type RawMetaError } from "@/lib/meta-api";

const API = "https://graph.facebook.com/v21.0";
const MAX_PAGES = 50;
const PIXEL_CONCURRENCY = 5;

type Json = Record<string, unknown> & { error?: RawMetaError; data?: unknown[]; paging?: { next?: string } };

export interface TokenDebug {
  is_valid?: boolean;
  type?: string;
  application?: string;
  app_id?: string;
  user_id?: string;
  expires_at?: number;
  data_access_expires_at?: number;
  issued_at?: number;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
  declined_scopes?: string[];
  error?: { code?: number; message?: string; subcode?: number };
}

export interface TokenIdentity { id: string; name?: string; email?: string }

export interface TokenAdAccount {
  id: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  amount_spent?: string;
  balance?: string;
  business?: { id: string; name: string };
}

export interface TokenPixel {
  id: string;
  name?: string;
  creation_time?: string;
  last_fired_time?: string;
  is_unavailable?: boolean;
  data_use_setting?: string;
  owner_business?: { id: string; name: string };
  can_proxy?: boolean;
  match_rate_approx?: number;
  /** Cuenta (o BM) desde la que se vio el píxel. */
  seenFrom: string;
}

export interface TokenPage {
  id: string;
  name?: string;
  category?: string;
  fan_count?: number;
  followers_count?: number;
  tasks?: string[];
  verification_status?: string;
  is_published?: boolean;
  link?: string;
}

export type TokenStepKey = "debug" | "bm" | "me" | "accounts" | "pixels" | "pages";

export interface TokenStep {
  key: TokenStepKey;
  label: string;
  ok: boolean;
  count?: number;
  note?: string;
  error?: SerializedError;
}

export interface TokenReport {
  /** De dónde salió el token: pegado o un BM de Ajustes. */
  source: { kind: "pasted" } | { kind: "bm"; id: string; name: string; bmIdMeta: string; tokenLast4: string | null };
  debug: TokenDebug;
  /** true si debug_token se pidió con App ID + App Secret (trae permisos completos). */
  appCredentials: boolean;
  identity: TokenIdentity | null;
  bm: { id: string; name?: string } | null;
  accounts: TokenAdAccount[];
  pixels: TokenPixel[];
  pages: TokenPage[];
  steps: TokenStep[];
  checkedAt: string;
}

/** Endpoint sin token ni ids largos, para el detalle técnico del error. */
function endpointOf(path: string): string {
  return `GET ${path.replace(/^\//, "")}`;
}

async function graph<T extends Json>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return send<T>(url.toString(), endpointOf(path));
}

async function send<T extends Json>(url: string, endpoint: string): Promise<T> {
  let res: Response;
  let json: T;
  try {
    res = await metaFetch(url);
    json = (await res.json()) as T;
  } catch (e) {
    throw new MetaApiError({ endpoint, httpStatus: 0, message: e instanceof Error ? e.message : String(e) });
  }
  if (json.error) throw new MetaApiError(toDetail(json.error, { endpoint, httpStatus: res.status }));
  return json;
}

/** Recorre todas las páginas de un listado. `paging.next` ya trae el token. */
async function graphAll<T>(path: string, token: string, params: Record<string, string>): Promise<T[]> {
  let json = await graph<Json>(path, token, { ...params, limit: "100" });
  const all = [...((json.data ?? []) as T[])];
  let guard = 1;
  while (json.paging?.next && guard < MAX_PAGES) {
    json = await send<Json>(json.paging.next, endpointOf(path));
    all.push(...((json.data ?? []) as T[]));
    guard++;
  }
  return all;
}

/** Ejecuta `fn` sobre `items` con como mucho `n` llamadas a la vez. */
async function pool<I, O>(items: I[], n: number, fn: (i: I) => Promise<O>): Promise<PromiseSettledResult<O>[]> {
  const out: PromiseSettledResult<O>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i]) }; }
      catch (e) { out[i] = { status: "rejected", reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const PIXEL_FIELDS = "id,name,creation_time,last_fired_time,is_unavailable,data_use_setting,owner_business,can_proxy,match_rate_approx";
const PAGE_FIELDS = "id,name,category,fan_count,followers_count,tasks,verification_status,is_published,link";
const ACCOUNT_FIELDS = "id,name,account_status,currency,timezone_name,amount_spent,business,balance";

export interface ValidateOpts {
  token: string;
  appId?: string;
  appSecret?: string;
  /** BM de Ajustes del que sale el token: se comprueba además el acceso a ese BM. */
  bm?: { id: string; name: string; bmIdMeta: string; tokenLast4: string | null };
}

/**
 * Analiza un token: qué es (debug_token), de quién es y a qué llega (cuentas,
 * píxeles y páginas). Si debug_token falla se lanza el error; los pasos
 * siguientes fallan por separado y quedan anotados en `steps`.
 */
export async function validateToken({ token, appId, appSecret, bm }: ValidateOpts): Promise<TokenReport> {
  const steps: TokenStep[] = [];
  const appCredentials = !!(appId && appSecret);

  // 1. debug_token. Sin credenciales de app se usa el propio token como access_token.
  const dbg = await graph<Json>("/debug_token", appCredentials ? `${appId}|${appSecret}` : token, { input_token: token });
  const debug = ((dbg.data ?? dbg) as unknown) as TokenDebug;
  if (debug.is_valid === false) {
    // Meta responde 200 con is_valid=false (expirado, revocado…): se explica como error de token.
    throw new MetaApiError({
      endpoint: "GET debug_token",
      code: debug.error?.code ?? 190,
      subcode: debug.error?.subcode,
      message: debug.error?.message ?? "El token no es válido",
    });
  }
  steps.push({ key: "debug", label: "Token", ok: true, note: [debug.type, debug.application].filter(Boolean).join(" · ") });

  // 2. Acceso al BM de Ajustes (solo si el token viene de ahí).
  let bmInfo: TokenReport["bm"] = null;
  if (bm) {
    try {
      const j = await graph<Json>(`/${bm.bmIdMeta}`, token, { fields: "id,name" });
      bmInfo = { id: String(j.id ?? bm.bmIdMeta), name: j.name as string | undefined };
      steps.push({ key: "bm", label: "Acceso al BM", ok: true, note: bmInfo.name });
    } catch (e) {
      steps.push({ key: "bm", label: "Acceso al BM", ok: false, error: serializeError(e) });
    }
  }

  // 3. Identidad. El email solo existe en tokens de usuario.
  let identity: TokenIdentity | null = null;
  try {
    identity = (await graph<Json>("/me", token, { fields: debug.type === "USER" ? "id,name,email" : "id,name" })) as unknown as TokenIdentity;
    steps.push({ key: "me", label: "Identidad", ok: true, note: identity.name });
  } catch (e) {
    steps.push({ key: "me", label: "Identidad", ok: false, error: serializeError(e) });
  }

  // 4. Cuentas publicitarias.
  let accounts: TokenAdAccount[] = [];
  try {
    accounts = await graphAll<TokenAdAccount>("/me/adaccounts", token, { fields: ACCOUNT_FIELDS });
    steps.push({ key: "accounts", label: "Cuentas publicitarias", ok: true, count: accounts.length });
  } catch (e) {
    steps.push({ key: "accounts", label: "Cuentas publicitarias", ok: false, error: serializeError(e) });
  }

  // 5. Píxeles: los de cada cuenta y los propios de cada BM, sin repetir.
  const pixels: TokenPixel[] = [];
  if (accounts.length) {
    const seen = new Set<string>();
    const add = (list: unknown[] | undefined, seenFrom: string) => {
      for (const px of (list ?? []) as Omit<TokenPixel, "seenFrom">[]) {
        if (seen.has(px.id)) continue;
        seen.add(px.id);
        pixels.push({ ...px, seenFrom });
      }
    };
    const byAccount = await pool(accounts, PIXEL_CONCURRENCY, (acc) => graph<Json>(`/${acc.id}/adspixels`, token, { fields: PIXEL_FIELDS }));
    let failed = 0;
    byAccount.forEach((r, i) => {
      if (r.status === "fulfilled") add(r.value.data, `cuenta ${accounts[i].name ?? accounts[i].id}`);
      else failed++;
    });
    const bms = [...new Map(accounts.filter((a) => a.business).map((a) => [a.business!.id, a.business!])).values()];
    for (const b of bms) {
      try { add((await graph<Json>(`/${b.id}/owned_pixels`, token, { fields: PIXEL_FIELDS })).data, `BM ${b.name}`); }
      catch { failed++; }
    }
    steps.push({
      key: "pixels", label: "Píxeles", ok: true, count: pixels.length,
      note: failed ? `${failed} consulta(s) sin acceso` : undefined,
    });
  } else {
    steps.push({ key: "pixels", label: "Píxeles", ok: true, count: 0, note: "Sin cuentas en las que buscar" });
  }

  // 6. Páginas: /me/accounts y, si no hay, las asignadas al System User.
  let pages: TokenPage[] = [];
  try {
    pages = await graphAll<TokenPage>("/me/accounts", token, { fields: PAGE_FIELDS });
    if (!pages.length && debug.user_id) {
      pages = await graphAll<TokenPage>(`/${debug.user_id}/assigned_pages`, token, { fields: PAGE_FIELDS }).catch(() => []);
    }
    steps.push({ key: "pages", label: "Páginas", ok: true, count: pages.length });
  } catch (e) {
    steps.push({ key: "pages", label: "Páginas", ok: false, error: serializeError(e) });
  }

  return {
    source: bm ? { kind: "bm", ...bm } : { kind: "pasted" },
    debug, appCredentials, identity, bm: bmInfo, accounts, pixels, pages, steps,
    checkedAt: new Date().toISOString(),
  };
}
