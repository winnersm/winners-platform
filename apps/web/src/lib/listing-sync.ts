import { Prisma } from "@winners/db";
import { prisma } from "@winners/db";
import {
  getAdAccounts, getCampaigns, getAdSets, getAds, getInsights,
  type MetaAdAccount, type MetaCampaign, type MetaAdSet, type MetaAd, type MetaInsights,
} from "@/lib/meta-api";

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

async function upsertSnapshot(operationId: string, accountId: string, kind: string, datePreset: string, data: unknown) {
  const payload = data as unknown as Prisma.InputJsonValue;
  await prisma.listingSnapshot.upsert({
    where: { operationId_accountId_kind_datePreset: { operationId, accountId, kind, datePreset } },
    create: { operationId, accountId, kind, datePreset, data: payload, syncedAt: new Date() },
    update: { data: payload, syncedAt: new Date() },
  });
}

// Sincroniza estructura + insights de UNA cuenta → snapshots en DB.
export async function syncListingsForAccount(
  operationId: string, account: { id: string; bmId: string }, presets: string[] = LISTING_PRESETS,
): Promise<void> {
  const rawId = account.id.replace("act_", "");
  const bmId = account.bmId;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Campañas: todas (paginando por cursor).
  try {
    const all: MetaCampaign[] = [];
    let cursor: string | undefined = undefined;
    do {
      const r = await getCampaigns(rawId, cursor, bmId, operationId);
      all.push(...r.campaigns);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    await upsertSnapshot(operationId, rawId, "campaigns", "", all);
  } catch { /* conservar snapshot anterior */ }
  await wait(200);

  // Adsets (todos de la cuenta — traen campaign_id para filtrar por campaña).
  try {
    const adsets: MetaAdSet[] = await getAdSets(rawId, undefined, bmId, operationId);
    await upsertSnapshot(operationId, rawId, "adsets", "", adsets);
  } catch { }
  await wait(200);

  // Ads (todos de la cuenta — traen adset_id para filtrar por adset).
  try {
    const ads: MetaAd[] = await getAds(rawId, undefined, bmId, operationId);
    await upsertSnapshot(operationId, rawId, "ads", "", ads);
  } catch { }
  await wait(200);

  // Insights por nivel × preset.
  for (const preset of presets) {
    for (const level of ["campaign", "adset", "ad"] as const) {
      try {
        const ins: MetaInsights[] = await getInsights(rawId, level, preset, bmId, operationId);
        await upsertSnapshot(operationId, rawId, `ins:${level}`, preset, ins);
      } catch { }
      await wait(200);
    }
  }
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

export async function syncListingsForOperation(operationId: string, presets: string[] = LISTING_PRESETS): Promise<number> {
  let accounts: MetaAdAccount[];
  try { accounts = await getAdAccounts(undefined, operationId); }
  catch { return 0; }
  const active = accounts.filter((a) => a.account_status === 1);
  for (const a of active) {
    await syncListingsForAccount(operationId, { id: a.id, bmId: a.bmId }, presets);
  }
  return active.length;
}

export async function syncAllListings(): Promise<void> {
  const ops = await prisma.operation.findMany({ select: { id: true, name: true } });
  for (const op of ops) {
    try {
      const n = await syncListingsForOperation(op.id);
      console.log(`[listing-sync] ${op.name}: ${n} cuentas sincronizadas`);
    } catch (e) {
      console.error(`[listing-sync] ${op.name} falló:`, e);
    }
  }
}
