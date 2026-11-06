import { Prisma } from "@winners/db";
import { prisma } from "@winners/db";
import {
  getAdAccounts, getCampaigns, getAdSets, getAds, getInsights, getAccountCooldown,
  type MetaAdAccount, type MetaCampaign, type MetaAdSet, type MetaAd, type MetaInsights,
} from "@/lib/meta-api";
import { serializeError } from "@/lib/meta-errors";

/** Antigüedad a partir de la cual una copia de listado se considera vieja. */
export const LISTING_MAX_AGE_MS = 45 * 60 * 1000;

/** Ad sets y anuncios (y sus métricas) se sincronizan cada 6 h; la copia vale algo más. */
export const DEEP_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
export const DEEP_LISTING_MAX_AGE_MS = DEEP_SYNC_EVERY_MS + 30 * 60 * 1000;

/** Vigencia de una copia según su tipo (`adsets`, `ads`, `ins:adset`, `ins:ad` son «profundos»). */
export function listingMaxAgeMs(kind: string): number {
  return kind === "adsets" || kind === "ads" || kind === "ins:adset" || kind === "ins:ad"
    ? DEEP_LISTING_MAX_AGE_MS
    : LISTING_MAX_AGE_MS;
}

/** light = campañas + métricas de campaña (30 min); deep = ad sets, anuncios y sus métricas (6 h). */
export type SyncScope = "light" | "deep" | "all";

// Un fallo de sync no debe romper la pasada, pero sí dejar rastro legible.
function logSyncError(what: string, accountId: string, e: unknown) {
  const s = serializeError(e);
  console.warn(`[listing-sync] ${what} cuenta ${accountId}: ${s.title} (${s.kind}) ${JSON.stringify(s.detail)}`);
}

export const LISTING_PRESETS = ["today", "last_7d", "last_30d"];

// Lee un snapshot de listado de la DB (o null si no existe).
export async function readListingSnapshot<T = unknown>(
  operationId: string, accountId: string, kind: string, datePreset = "",
): Promise<{ data: T; syncedAt: Date } | null> {
  const row = await prisma.listingSnapshot.findUnique({
    where: { operationId_accountId_kind_datePreset: { operationId, accountId, kind, datePreset } },
    select: { data: true, syncedAt: true },
  });
  if (!row) return null;
  return { data: row.data as T, syncedAt: row.syncedAt };
}

/**
 * Lee la copia de un listado y dice si sigue vigente. Las rutas la sirven tal
 * cual si es reciente; si es vieja, intentan Meta en vivo y solo vuelven a la
 * copia (marcada como "stale") si Meta falla.
 */
export async function readSnapshotWithAge<T = unknown>(
  operationId: string, accountId: string, kind: string, datePreset = "",
): Promise<{ data: T; syncedAt: Date; fresh: boolean } | null> {
  const snap = await readListingSnapshot<T>(operationId, accountId, kind, datePreset);
  if (!snap) return null;
  return { ...snap, fresh: Date.now() - snap.syncedAt.getTime() < listingMaxAgeMs(kind) };
}

/** Guarda una lectura en vivo como copia (lo usan las rutas al pulsar «Sincronizar con Meta»). */
export async function saveListingSnapshot(operationId: string, accountId: string, kind: string, datePreset: string, data: unknown) {
  try { await upsertSnapshot(operationId, accountId.replace("act_", ""), kind, datePreset, data); }
  catch (e) { console.warn("[listing-sync] no se pudo guardar la copia", kind, e); }
}

async function upsertSnapshot(operationId: string, accountId: string, kind: string, datePreset: string, data: unknown) {
  const payload = data as unknown as Prisma.InputJsonValue;
  await prisma.listingSnapshot.upsert({
    where: { operationId_accountId_kind_datePreset: { operationId, accountId, kind, datePreset } },
    create: { operationId, accountId, kind, datePreset, data: payload, syncedAt: new Date() },
    update: { data: payload, syncedAt: new Date() },
  });
}

// Sincroniza estructura + insights de UNA cuenta → snapshots en DB.
// force: saltarse el caché de Redis (lo pide «Traer de Meta»). Sin force, la
// estructura y los insights de "hoy" se piden frescos igualmente; el resto de
// presets aprovecha el caché (≤1 h) para no gastar cuota de más.
export async function syncListingsForAccount(
  operationId: string, account: { id: string; bmId: string }, presets: string[] = LISTING_PRESETS,
  opts: { force?: boolean; scope?: SyncScope } = {},
): Promise<{ skipped?: string }> {
  const scope = opts.scope ?? "all";
  const doLight = scope !== "deep";
  const doDeep = scope !== "light";
  const rawId = account.id.replace("act_", "");
  const bmId = account.bmId;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Cuenta enfriándose por cuota: no insistir (se conserva la copia anterior).
  const cd = await getAccountCooldown(rawId);
  if (cd.seconds > 0) {
    console.log(`[listing-sync] cuenta ${rawId} omitida: ${cd.reason ?? "cuota alta"} (${cd.seconds}s)`);
    return { skipped: cd.reason ?? "cuota alta" };
  }

  // Campañas: todas (paginando por cursor).
  if (doLight) try {
    const all: MetaCampaign[] = [];
    let cursor: string | undefined = undefined;
    do {
      const r = await getCampaigns(rawId, cursor, bmId, operationId, { force: true });
      all.push(...r.campaigns);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    await upsertSnapshot(operationId, rawId, "campaigns", "", all);
  } catch (e) { logSyncError("campañas", rawId, e); /* conservar snapshot anterior */ }
  if (doLight) await wait(200);

  // Adsets (todos de la cuenta — traen campaign_id para filtrar por campaña).
  if (doDeep) {
    try {
      const adsets: MetaAdSet[] = await getAdSets(rawId, undefined, bmId, operationId, { force: true });
      await upsertSnapshot(operationId, rawId, "adsets", "", adsets);
    } catch (e) { logSyncError("adsets", rawId, e); }
    await wait(200);

    // Ads (todos de la cuenta — traen adset_id para filtrar por adset).
    try {
      const ads: MetaAd[] = await getAds(rawId, undefined, bmId, operationId, { force: true });
      await upsertSnapshot(operationId, rawId, "ads", "", ads);
    } catch (e) { logSyncError("ads", rawId, e); }
    await wait(200);
  }

  // Insights por nivel × preset.
  for (const preset of presets) {
    for (const level of ["campaign", "adset", "ad"] as const) {
      if (level === "campaign" ? !doLight : !doDeep) continue;
      try {
        const force = opts.force || preset === "today";
        const ins: MetaInsights[] = await getInsights(rawId, level, preset, bmId, operationId, { force });
        await upsertSnapshot(operationId, rawId, `ins:${level}`, preset, ins);
      } catch (e) { logSyncError(`insights ${level}/${preset}`, rawId, e); }
      await wait(200);
    }
  }
  return {};
}

// Al cambiar estado de una entidad, reflejarlo en el snapshot para que un reload
// no muestre el estado viejo (la UI ya es optimista; esto mantiene la DB consistente).
export async function patchListingSnapshotStatus(
  operationId: string, accountId: string,
  entityType: "campaign" | "adset" | "ad", entityId: string, status: string,
): Promise<void> {
  const kind = entityType === "campaign" ? "campaigns" : entityType === "adset" ? "adsets" : "ads";
  const rawId = accountId.replace("act_", "");
  const where = { operationId_accountId_kind_datePreset: { operationId, accountId: rawId, kind, datePreset: "" } };
  const row = await prisma.listingSnapshot.findUnique({ where, select: { data: true } });
  if (!row || !Array.isArray(row.data)) return;
  const arr = row.data as Array<{ id: string; status?: string }>;
  let changed = false;
  for (const e of arr) if (e.id === entityId) { e.status = status; changed = true; }
  if (changed) await prisma.listingSnapshot.update({ where, data: { data: arr as unknown as Prisma.InputJsonValue } });
}

export async function syncListingsForOperation(
  operationId: string, presets: string[] = LISTING_PRESETS, scope: SyncScope = "all",
): Promise<number> {
  let accounts: MetaAdAccount[];
  try { accounts = await getAdAccounts(undefined, operationId); }
  catch { return 0; }
  const active = accounts.filter((a) => a.account_status === 1);
  for (const a of active) {
    await syncListingsForAccount(operationId, { id: a.id, bmId: a.bmId }, presets, { scope });
  }
  return active.length;
}

export async function syncAllListings(scope: SyncScope = "light"): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const n = await syncListingsForOperation(op.id, LISTING_PRESETS, scope);
      console.log(`[listing-sync] ${op.name}: ${n} cuentas sincronizadas`);
    } catch (e) {
      console.error(`[listing-sync] ${op.name} falló:`, e);
    }
  }
}
