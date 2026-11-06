import { Prisma } from "@winners/db";
import { prisma } from "@winners/db";
import {
  getAdAccounts, getCampaigns, getAdSets, getAds, getInsights, getAccountCooldown,
  type MetaAdAccount, type MetaCampaign, type MetaAdSet, type MetaAd, type MetaInsights,
} from "@/lib/meta-api";
import { serializeError } from "@/lib/meta-errors";

// Calendario de pasadas (hora Colombia):
//  - Estructura y «hoy»: 5:30, 12:00 y 17:30.
//  - Ayer, 7 y 14 días: cada día a las 5:00.
//  - 30 días: los lunes a las 5:00.
// Una copia vale hasta su siguiente pasada (con margen), así que entre pasadas solo se
// pide a Meta con «Sincronizar con Meta».
export const LISTING_PRESETS = ["today"];
export const DAILY_HISTORY_PRESETS = ["yesterday", "last_7d", "last_14d"];
export const WEEKLY_HISTORY_PRESETS = ["last_30d"];

const HOUR_MS = 60 * 60 * 1000;

/** Vigencia de una copia según su periodo; sin periodo es estructura, que va con «hoy». */
export function listingMaxAgeMs(datePreset: string): number {
  if (DAILY_HISTORY_PRESETS.includes(datePreset)) return 25 * HOUR_MS;
  if (WEEKLY_HISTORY_PRESETS.includes(datePreset)) return 7 * 24 * HOUR_MS + HOUR_MS;
  return 12.5 * HOUR_MS; // el mayor hueco entre pasadas: de 17:30 a 5:30
}

/** light = campañas, ad sets y sus métricas («Sincronizar con Meta»); deep = anuncios y sus métricas; all = todo (pasadas programadas). */
export type SyncScope = "light" | "deep" | "all";

// Un fallo de sync no debe romper la pasada, pero sí dejar rastro legible.
function logSyncError(what: string, accountId: string, e: unknown) {
  const s = serializeError(e);
  console.warn(`[listing-sync] ${what} cuenta ${accountId}: ${s.title} (${s.kind}) ${JSON.stringify(s.detail)}`);
}

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
  return { ...snap, fresh: Date.now() - snap.syncedAt.getTime() < listingMaxAgeMs(datePreset) };
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
// structure=false: solo métricas (pasadas de datos históricos).
export async function syncListingsForAccount(
  operationId: string, account: { id: string; bmId: string }, presets: string[] = LISTING_PRESETS,
  opts: { force?: boolean; scope?: SyncScope; structure?: boolean } = {},
): Promise<{ skipped?: string }> {
  const scope = opts.scope ?? "all";
  const doLight = scope !== "deep";
  const doDeep = scope !== "light";
  const structure = opts.structure ?? true;
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
  if (doLight && structure) try {
    const all: MetaCampaign[] = [];
    let cursor: string | undefined = undefined;
    do {
      const r = await getCampaigns(rawId, cursor, bmId, operationId, { force: true });
      all.push(...r.campaigns);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    await upsertSnapshot(operationId, rawId, "campaigns", "", all);
  } catch (e) { logSyncError("campañas", rawId, e); /* conservar snapshot anterior */ }

  // Adsets (todos de la cuenta — traen campaign_id para filtrar por campaña).
  // Van con las campañas: ambos niveles deben mostrar datos de la misma pasada.
  if (doLight && structure) {
    await wait(200);
    try {
      const adsets: MetaAdSet[] = await getAdSets(rawId, undefined, bmId, operationId, { force: true });
      await upsertSnapshot(operationId, rawId, "adsets", "", adsets);
    } catch (e) { logSyncError("adsets", rawId, e); }
    await wait(200);
  }

  if (doDeep && structure) {
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
      if (level === "ad" ? !doDeep : !doLight) continue;
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
  operationId: string, presets: string[] = LISTING_PRESETS, scope: SyncScope = "all", structure = true,
): Promise<number> {
  let accounts: MetaAdAccount[];
  try { accounts = await getAdAccounts(undefined, operationId); }
  catch { return 0; }
  const active = accounts.filter((a) => a.account_status === 1);
  for (const a of active) {
    await syncListingsForAccount(operationId, { id: a.id, bmId: a.bmId }, presets, { scope, structure, force: !structure });
  }
  return active.length;
}

export async function syncAllListings(
  scope: SyncScope = "all", presets: string[] = LISTING_PRESETS, structure = true,
): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const n = await syncListingsForOperation(op.id, presets, scope, structure);
      console.log(`[listing-sync] ${op.name}: ${n} cuentas sincronizadas`);
    } catch (e) {
      console.error(`[listing-sync] ${op.name} falló:`, e);
    }
  }
}
