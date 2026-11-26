// ─── Fanpages / PBIA ────────────────────────────────────────────────────────
// Usa los tokens de System User de los Business Managers de Ajustes (los mismos
// que el resto de Meta); Fanpages no tiene un token aparte.
// Los datos (páginas, BM, PBIA) son ESTABLES → se persisten en la tabla Fanpage y la
// UI lee de la DB (instantáneo). FB solo se toca al sincronizar o crear PBIA.
import { prisma } from "@winners/db";
import { decrypt } from "@/lib/crypto";
import { metaFetch } from "@/lib/meta-calls";

const API = "https://graph.facebook.com/v21.0";

export interface FanPageRaw {
  id: string;
  name: string;
  category: string | null;
  picture: string | null;
  tasks: string[];
  igReal: string | null;
  bm: { id: string; name: string } | null;
  isPublished: boolean | null;
  verificationStatus: string | null;
}

export const NO_BM_TOKEN_MSG = "No hay Business Manager con token activo en Ajustes";

interface BmToken { name: string; token: string }

// Tokens (en claro) de los BMs activos de la operación, los de Ajustes. Un BM en
// la papelera o con el token marcado como inválido no se usa.
async function getBmTokens(operationId?: string): Promise<BmToken[]> {
  const bms = await prisma.businessManager.findMany({
    where: { status: "active", deletedAt: null, ...(operationId ? { operationId } : {}) },
    orderBy: { createdAt: "asc" },
    select: { name: true, encryptedToken: true },
  });
  if (!bms.length) throw new Error(NO_BM_TOKEN_MSG);
  return bms.map((b) => ({ name: b.name, token: decrypt(b.encryptedToken) }));
}

export async function hasFanpageToken(operationId?: string): Promise<boolean> {
  const n = await prisma.businessManager.count({
    where: { status: "active", deletedAt: null, ...(operationId ? { operationId } : {}) },
  });
  return n > 0;
}

// ── FB: traer todas las páginas (paginado) ───────────────────────────────────
// Recorre el token de cada BM y une las páginas sin repetir. Si un BM falla se
// sigue con los demás y se anota en `failed`: la lista queda PARCIAL.
async function fetchPagesFromFB(operationId?: string): Promise<{ pages: FanPageRaw[]; failed: string[] }> {
  const bms = await getBmTokens(operationId);
  const pages: FanPageRaw[] = [];
  const seen = new Set<string>();
  const failed: string[] = [];
  for (const bm of bms) {
    try {
      for (const p of await fetchPagesForToken(bm.token)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        pages.push(p);
      }
    } catch (e) {
      console.error(`[fanpages] BM ${bm.name}: no se pudieron listar las páginas:`, e);
      failed.push(`${bm.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { pages, failed };
}

async function fetchPagesForToken(token: string): Promise<FanPageRaw[]> {
  const fields = "id,name,category,picture.width(100).height(100),tasks,is_published,verification_status,business{id,name},instagram_business_account{username},connected_instagram_account{username}";
  let url: string | null = `${API}/me/accounts?fields=${fields}&limit=100&access_token=${token}`;
  const pages: FanPageRaw[] = [];
  let guard = 0;

  while (url && guard < 50) {
    const res: Response = await metaFetch(url);
    const json: { data?: Array<Record<string, unknown>>; paging?: { next?: string }; error?: { message?: string } } = await res.json();
    if (json.error) throw new Error(json.error.message ?? "Error al listar páginas");
    for (const p of json.data ?? []) {
      const pic = p.picture as { data?: { url?: string; is_silhouette?: boolean } } | undefined;
      const iba = p.instagram_business_account as { username?: string } | undefined;
      const cia = p.connected_instagram_account as { username?: string } | undefined;
      const biz = p.business as { id?: string; name?: string } | undefined;
      pages.push({
        id: String(p.id),
        name: String(p.name ?? p.id),
        category: (p.category as string) ?? null,
        picture: pic?.data && !pic.data.is_silhouette ? pic.data.url ?? null : null,
        tasks: (p.tasks as string[]) ?? [],
        igReal: iba?.username ?? cia?.username ?? null,
        bm: biz?.id ? { id: biz.id, name: biz.name ?? biz.id } : null,
        isPublished: typeof p.is_published === "boolean" ? p.is_published : null,
        verificationStatus: (p.verification_status as string) ?? null,
      });
    }
    url = json.paging?.next ?? null;
    guard++;
  }
  return pages;
}

// Sincroniza las páginas de FB → DB (upsert) y ELIMINA las que ya no vienen de
// ningún BM (páginas a las que se le quitó el acceso). No pisa el igId ya conocido.
export async function syncFanpages(operationId: string): Promise<{ synced: number; removed: number; failed: string[] }> {
  const { pages, failed } = await fetchPagesFromFB(operationId);
  if (pages.length === 0 && failed.length > 0) {
    throw new Error(`No se pudieron listar las páginas. ${failed.join(" · ")}`);
  }
  for (const p of pages) {
    await prisma.fanpage.upsert({
      where: { pageId: p.id },
      create: {
        pageId: p.id, name: p.name, category: p.category, picture: p.picture,
        bmId: p.bm?.id ?? null, bmName: p.bm?.name ?? null, igReal: p.igReal, tasks: p.tasks,
        isPublished: p.isPublished, verificationStatus: p.verificationStatus, operationId,
      },
      update: {
        name: p.name, category: p.category, picture: p.picture,
        bmId: p.bm?.id ?? null, bmName: p.bm?.name ?? null, igReal: p.igReal, tasks: p.tasks,
        isPublished: p.isPublished, verificationStatus: p.verificationStatus, operationId,
        lastSynced: new Date(),
      },
    });
  }

  // Purga SOLO dentro de la operación (no toca fanpages de otra operación).
  // Si algún BM falló, la lista es parcial: no se purga, o se borrarían páginas
  // que siguen teniendo acceso.
  let removed = 0;
  if (pages.length > 0 && failed.length === 0) {
    const keep = pages.map((p) => p.id);
    const del = await prisma.fanpage.deleteMany({ where: { operationId, pageId: { notIn: keep } } });
    removed = del.count;
  }

  return { synced: pages.length, removed, failed };
}

// Sincroniza las fanpages de TODAS las operaciones que tengan token. Lo llama
// el job diario del worker. El botón "Sincronizar" de la UI solo cubre la
// operación activa; esto cubre las demás y evita que su lista se quede vieja.
// Cada operación va en su propio try: que una falle no frena a las otras.
export async function syncAllFanpages(): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      if (!(await hasFanpageToken(op.id))) {
        console.log(`[fanpages-sync] ${op.name}: sin BM con token, se omite`);
        continue;
      }
      const { synced, removed, failed } = await syncFanpages(op.id);
      console.log(`[fanpages-sync] ${op.name}: ${synced} sincronizadas, ${removed} eliminadas${failed.length ? ` · BM con error: ${failed.join(" · ")}` : ""}`);
    } catch (e) {
      console.error(`[fanpages-sync] ${op.name} falló:`, e);
    }
  }
}

// Lee las páginas de la operación desde la DB (lo que consume la UI).
export async function getFanpagesFromDB(operationId?: string) {
  return prisma.fanpage.findMany({ where: operationId ? { operationId } : {}, orderBy: { name: "asc" } });
}

export async function lastSyncedAt(operationId?: string): Promise<Date | null> {
  const row = await prisma.fanpage.findFirst({ where: operationId ? { operationId } : {}, orderBy: { lastSynced: "desc" }, select: { lastSynced: true } });
  return row?.lastSynced ?? null;
}

// ── PBIA ─────────────────────────────────────────────────────────────────────
// Pide el token de la página probando los BMs en orden: puede estar en cualquiera.
async function getPageToken(pageId: string, bms: BmToken[]): Promise<string> {
  let lastError = "Sin acceso a la página";
  for (const bm of bms) {
    const res = await metaFetch(`${API}/${pageId}?fields=access_token&access_token=${bm.token}`);
    const json = await res.json() as { access_token?: string; error?: { message?: string } };
    if (json.access_token) return json.access_token;
    if (json.error?.message) lastError = json.error.message;
  }
  throw new Error(lastError);
}

// Crea (o devuelve) el PBIA de una página y lo PERSISTE en la DB. Idempotente.
export async function createPBIA(pageId: string, operationId?: string): Promise<string> {
  const pageToken = await getPageToken(pageId, await getBmTokens(operationId));

  const g = await metaFetch(`${API}/${pageId}/page_backed_instagram_accounts?access_token=${pageToken}`);
  const gj = await g.json() as { data?: Array<{ id: string }> };
  let igId = gj.data && gj.data.length ? gj.data[0].id : null;

  if (!igId) {
    const p = await metaFetch(`${API}/${pageId}/page_backed_instagram_accounts?access_token=${pageToken}`, { method: "POST" });
    const pj = await p.json() as { id?: string; error?: { message?: string; error_user_msg?: string } };
    if (!pj.id) throw new Error(pj.error?.error_user_msg ?? pj.error?.message ?? "No se pudo crear el PBIA");
    igId = pj.id;
  }

  await prisma.fanpage.updateMany({ where: { pageId }, data: { igId, pbiaCheckedAt: new Date() } });
  return igId;
}

// Verifica el estado PBIA de varias páginas (Batch API) y lo PERSISTE en la DB.
export async function syncPBIA(pageIds: string[], operationId?: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (pageIds.length === 0) return out;
  const bms = await getBmTokens(operationId);
  const userToken = bms[0].token; // solo autentica el batch de PBIA; cada página va con su page token

  for (let i = 0; i < pageIds.length; i += 50) {
    const chunk = pageIds.slice(i, i + 50);

    // 1) page tokens (batch), BM por BM con las páginas que aún no tienen token
    const pageTokens: Record<string, string> = {};
    for (const bm of bms) {
      const pending = chunk.filter((id) => !pageTokens[id]);
      if (!pending.length) break;
      const tokRes = await metaFetch(`${API}/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: bm.token, batch: pending.map((id) => ({ method: "GET", relative_url: `${id}?fields=access_token` })) }),
      });
      const tokJson = await tokRes.json() as unknown;
      if (!Array.isArray(tokJson)) continue; // token del BM rechazado → probar el siguiente
      (tokJson as Array<{ code: number; body: string } | null>).forEach((r, idx) => {
        try { const b = JSON.parse(r?.body ?? "{}") as { access_token?: string }; if (b.access_token) pageTokens[pending[idx]] = b.access_token; } catch {}
      });
    }

    // 2) PBIA (batch) con el page token de cada una
    const ready = chunk.filter((id) => pageTokens[id]);
    if (ready.length) {
      const pbiaRes = await metaFetch(`${API}/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: userToken,
          batch: ready.map((id) => ({ method: "GET", relative_url: `${id}/page_backed_instagram_accounts?access_token=${pageTokens[id]}` })),
        }),
      });
      const pbiaJson = await pbiaRes.json() as Array<{ code: number; body: string }>;
      for (let k = 0; k < ready.length; k++) {
        const id = ready[k];
        let igId: string | null = null;
        try { const b = JSON.parse(pbiaJson[k]?.body ?? "{}") as { data?: Array<{ id: string }> }; igId = b.data && b.data.length ? b.data[0].id : null; } catch {}
        out[id] = igId;
        await prisma.fanpage.updateMany({ where: { pageId: id }, data: { igId, pbiaCheckedAt: new Date() } });
      }
    }
    for (const id of chunk) if (!(id in out)) out[id] = null;
  }

  return out;
}

// ── Ads activos por página ───────────────────────────────────────────────────
// Recorre TODAS las ad accounts de los BMs, cuenta los ads ACTIVE por page_id y
// persiste el conteo en cada Fanpage.
export async function syncActiveAds(
  operationId?: string,
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<{ accounts: number; totalActive: number }> {
  const bms = await getBmTokens(operationId);

  // 1) listar las cuentas de cada BM (sin repetir), con el token que las ve
  const accounts: Array<{ id: string; token: string }> = [];
  const seenAcc = new Set<string>();
  const failed: string[] = [];
  for (const bm of bms) {
    let accUrl: string | null = `${API}/me/adaccounts?fields=id&limit=200&access_token=${bm.token}`;
    let g = 0;
    while (accUrl && g < 20) {
      const r = await metaFetch(accUrl);
      const j = await r.json() as { data?: Array<{ id: string }>; paging?: { next?: string }; error?: { message?: string } };
      if (j.error) { failed.push(`${bm.name}: ${j.error.message ?? "sin acceso a las cuentas"}`); break; }
      for (const a of j.data ?? []) {
        if (seenAcc.has(a.id)) continue;
        seenAcc.add(a.id);
        accounts.push({ id: a.id, token: bm.token });
      }
      accUrl = j.paging?.next ?? null;
      g++;
    }
  }
  // Sin ninguna cuenta legible no se cuenta nada (no dejar todo a 0).
  if (accounts.length === 0 && failed.length > 0) throw new Error(`Sin acceso a las cuentas. ${failed.join(" · ")}`);

  // 2) por cuenta, contar ads ACTIVE por page_id
  const counts: Record<string, number> = {};
  let totalActive = 0;
  const filtering = encodeURIComponent(JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
  for (let i = 0; i < accounts.length; i++) {
    let url: string | null =
      `${API}/${accounts[i].id}/ads?fields=creative{object_story_spec{page_id},effective_object_story_id}&filtering=${filtering}&limit=500&access_token=${accounts[i].token}`;
    let pg = 0;
    while (url && pg < 20) {
      const r = await metaFetch(url);
      const j = await r.json() as {
        data?: Array<{ creative?: { object_story_spec?: { page_id?: string }; effective_object_story_id?: string } }>;
        paging?: { next?: string }; error?: { message?: string };
      };
      if (j.error) break; // cuenta sin permiso de lectura de ads → saltar
      for (const ad of j.data ?? []) {
        const cr = ad.creative ?? {};
        const pid = cr.object_story_spec?.page_id ?? (cr.effective_object_story_id?.split("_")[0]) ?? null;
        if (pid) { counts[pid] = (counts[pid] ?? 0) + 1; totalActive++; }
      }
      url = j.paging?.next ?? null;
      pg++;
    }
    if (onProgress) await onProgress(i + 1, accounts.length);
  }

  // 3) persistir en cada Fanpage de la operación (0 a las que no aparecen)
  const now = new Date();
  const all = await prisma.fanpage.findMany({ where: operationId ? { operationId } : {}, select: { pageId: true } });
  for (const f of all) {
    await prisma.fanpage.updateMany({
      where: { pageId: f.pageId },
      data: { activeAds: counts[f.pageId] ?? 0, adsSyncedAt: now },
    });
  }

  return { accounts: accounts.length, totalActive };
}
