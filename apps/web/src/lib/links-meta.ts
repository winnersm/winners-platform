// Wrapper mínimo del Graph API de Meta (v21.0). HTTP directo con fetch, sin SDK.
// Adaptado del patrón de NewAppMeta (src/lib/meta-api.ts) y meta_api.py.
import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";

const META_API_BASE = "https://graph.facebook.com/v21.0";

export interface MetaAd {
  adId: string;
  adName: string;
  adsetId: string;
  campaignId: string;
  campaignName?: string;
  adsetName?: string;
  status?: string;
  /** post/creative id — el "Asset ID" (de effective_object_story_id: pageId_postId) */
  assetId?: string;
  /** story id crudo pageId_postId, útil para armar la URL del post */
  storyId?: string;
}

export interface MetaAdAccount {
  id: string; // act_xxx
  name: string;
  status?: number;
  currency?: string;
}

/** Clave del secreto que guarda el token usado para generar enlaces. */
export const LINKS_TOKEN_KEY = "links_meta_token";

/**
 * Token descifrado, desde core.Secret.
 *
 * Antes vivía en una tabla propia del acortador, cifrado con otra clave. Ahora
 * es un secreto más, con la clave maestra y visible en /admin/secrets.
 */
export async function getToken(): Promise<string> {
  const secret = await prisma.secret.findUnique({ where: { key: LINKS_TOKEN_KEY } });
  if (!secret) {
    throw new Error(
      "No hay token de Meta para los enlaces. Añádelo en Administración → Secretos " +
        `con el identificador "${LINKS_TOKEN_KEY}".`,
    );
  }
  return decrypt(secret.ciphertext);
}

function isRateLimit(msg: string): boolean {
  return /\b(error )?(4|17|32|613|80004)\b|request limit|rate limit|reduce the amount/i.test(msg);
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/** GET a un endpoint del Graph API. Lanza Error con mensaje legible en fallo. */
async function graphGet(
  path: string,
  params: Record<string, string>,
  token: string
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${META_API_BASE}/${path}?${qs.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown> & GraphError;

  if (!res.ok || json.error) {
    const m = json.error?.message ?? `HTTP ${res.status}`;
    const code = json.error?.code;
    if (isRateLimit(`${code} ${m}`)) {
      throw new Error(`Meta rate limit (código ${code}). Espera unos minutos y reintenta.`);
    }
    throw new Error(`Meta API error: ${m}`);
  }
  return json;
}

/** Sigue paging.next hasta agotar (o hasta maxPages). Devuelve la unión de data[]. */
async function graphGetAll(
  path: string,
  params: Record<string, string>,
  token: string,
  maxPages = 25
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let page = await graphGet(path, params, token);
  let count = 0;
  while (true) {
    const data = (page.data as Record<string, unknown>[]) ?? [];
    out.push(...data);
    const paging = page.paging as { next?: string; cursors?: { after?: string } } | undefined;
    const after = paging?.cursors?.after;
    if (!after || !paging?.next || ++count >= maxPages) break;
    page = await graphGet(path, { ...params, after }, token);
  }
  return out;
}

interface RawAccount {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
}

/** Lista TODAS las cuentas publicitarias accesibles por el token. */
export async function listAdAccounts(token: string): Promise<MetaAdAccount[]> {
  const rows = (await graphGetAll(
    "me/adaccounts",
    { fields: "id,name,account_status,currency", limit: "200" },
    token
  )) as unknown as RawAccount[];

  return rows
    .map((r) => ({
      id: r.id, // ya viene como act_xxx
      name: r.name || r.id,
      status: r.account_status,
      currency: r.currency,
    }))
    // activas primero, luego por nombre
    .sort((a, b) => (a.status === 1 ? -1 : 1) - (b.status === 1 ? -1 : 1) || a.name.localeCompare(b.name));
}

/** El "Asset ID": de effective_object_story_id (pageId_postId) extrae el postId. */
function parseAssetId(storyId?: string): string | undefined {
  if (!storyId) return undefined;
  const parts = storyId.split("_");
  return parts.length === 2 ? parts[1] : storyId;
}

interface RawAd {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  adset_id?: string;
  campaign_id?: string;
  campaign?: { name?: string };
  adset?: { name?: string };
  creative?: { id?: string; effective_object_story_id?: string; object_story_id?: string };
}

/**
 * Lista los ads de UNA cuenta con todos los IDs necesarios (ad, adset, campaign) y
 * resuelve el Asset/Post ID desde el creative. Funciona para ads nuevos sin spend
 * porque usa el edge /ads (no insights).
 */
export async function listAds(
  token: string,
  accountId: string,
  opts: { activeOnly?: boolean; limit?: number } = {}
): Promise<MetaAd[]> {
  const { activeOnly = true, limit = 200 } = opts;
  const account = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const fields = [
    "id",
    "name",
    "effective_status",
    "adset_id",
    "campaign_id",
    "campaign{name}",
    "adset{name}",
    "creative{id,effective_object_story_id,object_story_id}",
  ].join(",");

  const params: Record<string, string> = { fields, limit: String(limit) };
  // Solo ads realmente en entrega (toda la cadena activa) cuando activeOnly.
  if (activeOnly) params.effective_status = JSON.stringify(["ACTIVE"]);

  const rows = (await graphGetAll(`${account}/ads`, params, token)) as unknown as RawAd[];

  return rows.map((r) => {
    const storyId = r.creative?.effective_object_story_id ?? r.creative?.object_story_id;
    return {
      adId: r.id,
      adName: r.name ?? "",
      adsetId: r.adset_id ?? "",
      campaignId: r.campaign_id ?? "",
      campaignName: r.campaign?.name,
      adsetName: r.adset?.name,
      status: r.effective_status,
      storyId,
      assetId: parseAssetId(storyId),
    };
  });
}
