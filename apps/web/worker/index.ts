if (process.env.NODE_ENV !== "production") {
  require("dotenv/config");
}
import { Worker, DelayedError, type Job as BullJob } from "bullmq";
import { prisma, Prisma } from "@winners/db";
import { duplicateCampaign, duplicateAdsets, duplicateAds, getAccountCooldown, setAccountCooldown, FatalAdError } from "@/lib/meta-api";
import { MetaApiError, isRateLimitKind, serializeError, userLine } from "@/lib/meta-errors";
import { createPBIA, syncActiveAds, syncAllFanpages } from "@/lib/fanpages-api";
import { syncAllDashboards } from "@/lib/dashboard-sync";
import { syncAllListings, syncListingsForAccount } from "@/lib/listing-sync";
import { syncAllSpendDaily } from "@/lib/spend-history";
import { duplicationsQueue, syncQueue, SYNC_JOB_NAMES, JOB_TYPES } from "@/lib/queue";

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
};

type LogEntry = { ts: string; msg: string };

// ─── Límite de concurrencia POR CUENTA ──────────────────────────────────────
// Global: hasta WORKER_CONCURRENCY jobs a la vez. De la MISMA ad account solo
// PER_ACCOUNT_MAX simultáneos (protege contra el rate limit por cuenta).
// Si la cuenta está ocupada o enfriándose, el job NO se queda esperando dentro
// del worker (eso bloqueaba un hueco y frenaba a las demás cuentas): se
// reprograma unos segundos más tarde y el hueco queda libre para otro trabajo.
const WORKER_CONCURRENCY = 5;
const PER_ACCOUNT_MAX = 2;
const ACCOUNT_BUSY_DELAY_MS = 15_000;
const accountActive = new Map<string, number>();

function tryAcquireAccount(accountId?: string): boolean {
  if (!accountId) return true;
  const cur = accountActive.get(accountId) ?? 0;
  if (cur >= PER_ACCOUNT_MAX) return false;
  accountActive.set(accountId, cur + 1);
  return true;
}

function releaseAccount(accountId?: string): void {
  if (!accountId) return;
  const cur = accountActive.get(accountId) ?? 1;
  accountActive.set(accountId, Math.max(0, cur - 1));
}

/** Tipos que se pueden reanudar sin duplicar nada (tienen punto de control). */
const RESUMABLE = new Set<string>([JOB_TYPES.DUPLICATE_CAMPAIGN]);

// Pausas ante un límite de Meta: cada vez más largas, porque el medidor de cuota
// no siempre avisa cuándo se libera. En total, ~2 h 20 min antes de rendirse.
const RATE_LIMIT_WAITS_SEC = [60, 120, 300, 600, 900];
const MAX_RATE_LIMIT_PAUSES = 12;

// Marca de cancelación: el catch la distingue de un fallo real para no pisar el estado "cancelled".
class CancelledError extends Error {
  constructor() {
    super("Job cancelado por el usuario");
    this.name = "CancelledError";
  }
}

async function writeLog(
  jobId: string,
  logs: LogEntry[],
  msg: string,
  progress?: number
): Promise<void> {
  logs.push({ ts: new Date().toISOString(), msg });
  await prisma.metaJob.update({
    where: { id: jobId },
    data: { logs, ...(progress !== undefined ? { progress } : {}) },
  });
}

// Jobs de sistema (sin fila en DB): sincronización de snapshots.
async function processSyncJob(bullJob: BullJob) {
  console.log(`[worker:sync] Job ${bullJob.id} tipo ${bullJob.name}`);
  switch (bullJob.name) {
    case JOB_TYPES.SYNC_DASHBOARD:
      console.log("[worker] SYNC_DASHBOARD: sincronizando dashboards de todas las operaciones...");
      return syncAllDashboards();
    case JOB_TYPES.SYNC_LISTINGS:
      console.log("[worker] SYNC_LISTINGS: sincronizando listados de todas las operaciones...");
      return syncAllListings((bullJob.data as { scope?: "light" | "deep" } | undefined)?.scope ?? "light");
    case JOB_TYPES.SYNC_FANPAGES:
      console.log("[worker] SYNC_FANPAGES: sincronizando fanpages de todas las operaciones...");
      return syncAllFanpages();
    case JOB_TYPES.SYNC_SPEND_DAILY:
      console.log("[worker] SYNC_SPEND_DAILY: acumulando gasto diario de todas las operaciones...");
      return syncAllSpendDaily();
    case JOB_TYPES.SYNC_LISTINGS_ACCOUNT: {
      const { operationId, accountId, bmId, scope } = bullJob.data as { operationId: string; accountId: string; bmId: string; scope?: "light" | "deep" | "all" };
      console.log(`[worker] SYNC_LISTINGS_ACCOUNT: cuenta ${accountId} (op ${operationId}, ${scope ?? "all"})`);
      return syncListingsForAccount(operationId, { id: accountId, bmId }, undefined, { force: true, scope: scope ?? "all" });
    }
  }
}

/** Deja el job en espera con un motivo visible y lo reprograma. */
async function postpone(
  bullJob: BullJob, token: string | undefined, jobId: string, delayMs: number, reason: string,
  extra: Record<string, unknown> = {},
) {
  const until = new Date(Date.now() + delayMs).toISOString();
  const row = await prisma.metaJob.findUnique({ where: { id: jobId }, select: { output: true } });
  const prev = (row?.output ?? {}) as Record<string, unknown>;
  await prisma.metaJob.update({
    where: { id: jobId },
    data: { status: "pending", output: { ...prev, ...extra, waiting: { reason, until } } as Prisma.InputJsonValue },
  });
  await bullJob.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

async function processJob(bullJob: BullJob, token?: string) {
  console.log(`[worker] Job BullMQ ${bullJob.id} tipo ${bullJob.name}`);

  // Syncs que quedaron en la cola antigua antes del cambio de cola.
  if (SYNC_JOB_NAMES.has(bullJob.name)) return processSyncJob(bullJob);

  const jobId: string = bullJob.data.jobId;
  const accountId: string | undefined = bullJob.data.accountId;
  const row = await prisma.metaJob.findUnique({ where: { id: jobId }, select: { status: true, logs: true } });
  if (!row) { console.warn(`[worker] Job ${jobId} ya no existe en DB, se descarta`); return; }
  if (row.status === "cancelled") { console.log(`[worker] Job ${jobId} cancelado antes de empezar`); return; }

  // Cuenta enfriándose (Meta pidió esperar o la cuota está alta) → reprogramar.
  if (accountId) {
    const cd = await getAccountCooldown(accountId);
    if (cd.seconds > 0) {
      const mins = Math.max(1, Math.round(cd.seconds / 60));
      await postpone(bullJob, token, jobId, cd.seconds * 1000 + 2000 + (bullJob.data.seq ?? 0) * 200,
        `Meta está limitando esta cuenta (${cd.reason ?? "cuota alta"}). Se reanuda solo en ~${mins} min.`);
    }
  }
  // Cuenta con su cupo lleno → reprogramar sin ocupar un hueco del worker.
  if (!tryAcquireAccount(accountId)) {
    await postpone(bullJob, token, jobId, ACCOUNT_BUSY_DELAY_MS + (bullJob.data.seq ?? 0) * 200,
      `En cola: esta cuenta ya tiene ${PER_ACCOUNT_MAX} trabajos en curso.`);
  }

  const logs: LogEntry[] = Array.isArray(row.logs) ? (row.logs as LogEntry[]) : [];
  try {
    await runJob(bullJob, jobId, logs, token);
  } finally {
    releaseAccount(accountId);
  }
}

async function runJob(bullJob: BullJob, jobId: string, logs: LogEntry[], token?: string) {
  const current = await prisma.metaJob.findUnique({ where: { id: jobId }, select: { output: true } });
  const prevOutput = (current?.output ?? {}) as Record<string, unknown>;
  // Al arrancar se quita la marca de "en espera" (si la había).
  const { waiting: _waiting, ...outputWithoutWaiting } = prevOutput;
  void _waiting;
  await prisma.metaJob.update({
    where: { id: jobId },
    data: { status: "processing", output: outputWithoutWaiting as Prisma.InputJsonValue },
  });

  const cb = async (progress: number, msg: string) => {
    await bullJob.updateProgress(progress);
    await writeLog(jobId, logs, msg, progress);
    console.log(`[worker:${jobId}] ${progress}% — ${msg}`);
  };

  const checkCancelled = async () => {
    const job = await prisma.metaJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status === "cancelled" || job?.status === "failed") {
      throw new CancelledError();
    }
  };

  try {
    switch (bullJob.name) {
      case "DUPLICATE_CAMPAIGN": {
        const { campaignId, accountId, name, status, bmId, operationId } = bullJob.data;
        const resumeCampaignId = typeof prevOutput.newCampaignId === "string" ? prevOutput.newCampaignId : undefined;
        const result = await duplicateCampaign(campaignId, accountId, name, status, bmId, cb, checkCancelled, {
          resumeCampaignId,
          operationId,
          // Punto de control: en cuanto existe la copia se guarda, para reanudar sin duplicar.
          onCheckpoint: async ({ newCampaignId }) => {
            await prisma.metaJob.update({
              where: { id: jobId },
              data: { output: { ...outputWithoutWaiting, newCampaignId } as Prisma.InputJsonValue },
            });
          },
        });
        await prisma.metaJob.update({
          where: { id: jobId },
          data: { status: "completed", progress: 100, output: JSON.parse(JSON.stringify(result)), logs },
        });
        break;
      }

      case "DUPLICATE_ADSET": {
        const { adsetIds, targetCampaignId, accountId, bmId, count } = bullJob.data;
        const result = await duplicateAdsets(adsetIds, targetCampaignId, accountId, bmId, cb, count ?? 1, checkCancelled);
        await prisma.metaJob.update({
          where: { id: jobId },
          data: { status: "completed", progress: 100, output: JSON.parse(JSON.stringify(result)), logs },
        });
        break;
      }

      case "DUPLICATE_AD": {
        const { ads, targetAdsetId, accountId, bmId } = bullJob.data;
        const result = await duplicateAds(ads, targetAdsetId, accountId, bmId, cb, checkCancelled);
        await prisma.metaJob.update({
          where: { id: jobId },
          data: { status: "completed", progress: 100, output: JSON.parse(JSON.stringify(result)), logs },
        });
        break;
      }

      case "CREATE_PBIA_BULK": {
        const { pageIds, operationId } = bullJob.data as { pageIds: string[]; operationId?: string };
        const total = pageIds.length;
        let done = 0, ok = 0;
        const results: Array<{ pageId: string; igId?: string; error?: string }> = [];
        for (const pageId of pageIds) {
          await checkCancelled();
          try {
            const igId = await createPBIA(pageId, operationId);
            results.push({ pageId, igId });
            ok++;
          } catch (e) {
            results.push({ pageId, error: e instanceof Error ? e.message : String(e) });
          }
          done++;
          await cb(Math.round((done / total) * 100), `PBIA ${done}/${total} (${ok} creados)`);
        }
        await prisma.metaJob.update({
          where: { id: jobId },
          data: { status: "completed", progress: 100, output: { total, ok, results }, logs },
        });
        break;
      }

      case "SYNC_ACTIVE_ADS": {
        const { operationId: adsOp } = bullJob.data as { operationId?: string };
        await cb(5, "Recorriendo cuentas y contando ads activos...");
        const res = await syncActiveAds(adsOp, async (done, total) => {
          await cb(Math.min(99, Math.round((done / total) * 100)), `Cuentas ${done}/${total}`);
        });
        await prisma.metaJob.update({
          where: { id: jobId },
          data: { status: "completed", progress: 100, output: { accounts: res.accounts, totalActive: res.totalActive }, logs },
        });
        break;
      }

      default:
        throw new Error(`Tipo de job desconocido: ${bullJob.name}`);
    }
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    // Cancelación = no es un fallo: dejar el job en "cancelled" (lo puso la API) sin pisarlo.
    if (error instanceof CancelledError) {
      logs.push({ ts: new Date().toISOString(), msg: "Cancelado por el usuario" });
      await prisma.metaJob.update({ where: { id: jobId }, data: { status: "cancelled", logs } });
      throw error;
    }

    const metaErr = error instanceof FatalAdError ? (error.metaError ?? error) : error;
    const serialized = serializeError(metaErr);
    if (error instanceof FatalAdError) serialized.message = error.message;

    // Rate limit largo en un job reanudable → enfriar la cuenta y reprogramar el
    // job: continuará sobre lo ya creado (punto de control) en vez de fallar.
    const pauses = Number(prevOutput.pauses ?? 0);
    const rateLimited = metaErr instanceof MetaApiError && isRateLimitKind(metaErr.kind);
    if (rateLimited && RESUMABLE.has(bullJob.name) && pauses >= MAX_RATE_LIMIT_PAUSES) {
      serialized.action = "Meta mantuvo el límite durante más de 2 horas. Vuelve a lanzar esta copia más tarde.";
    }
    if (rateLimited && RESUMABLE.has(bullJob.name) && pauses < MAX_RATE_LIMIT_PAUSES) {
      const planned = RATE_LIMIT_WAITS_SEC[Math.min(pauses, RATE_LIMIT_WAITS_SEC.length - 1)];
      const waitSec = Math.max(planned, metaErr.detail.retryAfterSec ?? 0);
      const accountId: string | undefined = bullJob.data.accountId;
      if (accountId) await setAccountCooldown(accountId, waitSec, `Meta limitó la cuenta (código ${metaErr.detail.code})`);
      logs.push({ ts: new Date().toISOString(), msg: `PAUSA: ${serialized.title}. Se reanuda en ~${Math.ceil(waitSec / 60)} min sin repetir lo ya creado.` });
      await prisma.metaJob.update({ where: { id: jobId }, data: { logs } });
      await postpone(bullJob, token, jobId, waitSec * 1000, `${serialized.title}. Se reanuda solo en ~${Math.ceil(waitSec / 60)} min.`, { pauses: pauses + 1 });
    }

    const d = serialized.detail;
    const tech = [d.code != null ? `código ${d.code}${d.subcode != null ? `/${d.subcode}` : ""}` : null, d.endpoint, d.fbtraceId ? `fbtrace ${d.fbtraceId}` : null]
      .filter(Boolean).join(" · ");
    logs.push({ ts: new Date().toISOString(), msg: `ERROR: ${serialized.title} — ${serialized.message}${tech ? ` [${tech}]` : ""}` });
    const row = await prisma.metaJob.findUnique({ where: { id: jobId }, select: { output: true } });
    const out = (row?.output ?? {}) as Record<string, unknown>;
    await prisma.metaJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: userLine(serialized),
        logs,
        output: { ...out, error: serialized } as unknown as Prisma.InputJsonValue,
      },
    });
    console.error(`[worker:${jobId}] FALLÓ (${serialized.kind}): ${JSON.stringify(serialized.detail)}`);
    throw error;
  }
}

const worker = new Worker("duplications", processJob, {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

// Los syncs van aparte: 2 a la vez como máximo, sin competir con las duplicaciones.
const syncWorker = new Worker("syncs", processSyncJob, {
  connection,
  concurrency: 2,
});

for (const [label, w] of [["duplications", worker], ["syncs", syncWorker]] as const) {
  w.on("completed", (job) => console.log(`[worker:${label}] Job ${job.id} completado`));
  w.on("failed", (job, err) => console.error(`[worker:${label}] Job ${job?.id} falló:`, err.message));
  w.on("error", (err) => console.error(`[worker:${label}] Error:`, err));
}

console.log("[worker] Listo: colas 'duplications' (trabajos de usuario) y 'syncs' (sincronizaciones).");

// Programación de los syncs. upsertJobScheduler es idempotente por id, así que
// no se duplica entre despliegues. Antes vivían en la cola de duplicaciones:
// se quitan de ahí para que no corran dos veces.
(async () => {
  try {
    for (const sch of await duplicationsQueue.getJobSchedulers()) {
      if (sch.name && SYNC_JOB_NAMES.has(sch.name)) {
        await duplicationsQueue.removeJobScheduler(sch.key);
        console.log(`[worker] Programación antigua de ${sch.name} retirada de 'duplications'`);
      }
    }
    const opts = { removeOnComplete: true, removeOnFail: true };
    // Los schedulers con `every` ya lanzan una pasada inmediata al crearse/actualizarse.
    await syncQueue.upsertJobScheduler("sync-dashboard", { every: 20 * 60 * 1000 }, { name: JOB_TYPES.SYNC_DASHBOARD, opts });
    // Listados ligeros (campañas + métricas de campaña): cada 30 min.
    await syncQueue.upsertJobScheduler("sync-listings", { every: 30 * 60 * 1000 }, { name: JOB_TYPES.SYNC_LISTINGS, data: { scope: "light" }, opts });
    // Ad sets y anuncios (+ sus métricas): ~300 llamadas que casi nadie abre → cada 6 h.
    // «Sincronizar con Meta» en la UI cubre lo urgente.
    await syncQueue.upsertJobScheduler("sync-listings-deep", { every: 6 * 60 * 60 * 1000 }, { name: JOB_TYPES.SYNC_LISTINGS, data: { scope: "deep" }, opts });
    // Fanpages: una vez al día a las 5:00 AM (hora Colombia); el botón "Sincronizar" cubre lo urgente.
    await syncQueue.upsertJobScheduler("sync-fanpages", { pattern: "0 5 * * *", tz: "America/Bogota" }, { name: JOB_TYPES.SYNC_FANPAGES, opts });
    // Gasto diario: 6:00 AM (hora Colombia). Reescribe los últimos días para captar ajustes tardíos de Meta.
    await syncQueue.upsertJobScheduler("sync-spend-daily", { pattern: "0 6 * * *", tz: "America/Bogota" }, { name: JOB_TYPES.SYNC_SPEND_DAILY, opts });
    console.log("[worker] Sync programado: dashboard (20 min) + campañas (30 min) + ad sets/anuncios (6 h) + fanpages (5:00 AM) + gasto diario (6:00 AM).");
  } catch (e) {
    console.error("[worker] No se pudo programar los syncs:", e);
  }
})();

process.on("SIGTERM", async () => {
  await Promise.all([worker.close(), syncWorker.close()]);
  await prisma.$disconnect();
  process.exit(0);
});
