if (process.env.NODE_ENV !== "production") {
  require("dotenv/config");
}
import { Worker, type Job as BullJob } from "bullmq";
import { prisma } from "@winners/db";
import { duplicateCampaign, duplicateAdsets, duplicateAds } from "@/lib/meta-api";
import { createPBIA, syncActiveAds, syncAllFanpages } from "@/lib/fanpages-api";
import { syncAllDashboards } from "@/lib/dashboard-sync";
import { syncAllListings, syncListingsForAccount } from "@/lib/listing-sync";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
};

type LogEntry = { ts: string; msg: string };

// ─── Límite de concurrencia POR CUENTA ──────────────────────────────────────
// Global: hasta WORKER_CONCURRENCY jobs a la vez. Pero de la MISMA ad account
// solo PER_ACCOUNT_MAX simultáneos (protege contra el rate limit 17 por cuenta).
const WORKER_CONCURRENCY = 5;
const PER_ACCOUNT_MAX = 2;
const accountActive = new Map<string, number>();
const accountWaiters = new Map<string, Array<() => void>>();

async function acquireAccount(accountId?: string): Promise<void> {
  if (!accountId) return;
  const cur = accountActive.get(accountId) ?? 0;
  if (cur < PER_ACCOUNT_MAX) {
    accountActive.set(accountId, cur + 1);
    return;
  }
  // Cupo lleno para esta cuenta → esperar a que se libere un turno.
  await new Promise<void>((resolve) => {
    const q = accountWaiters.get(accountId) ?? [];
    q.push(resolve);
    accountWaiters.set(accountId, q);
  });
  // El slot se transfiere directo desde releaseAccount → no incrementamos aquí.
}

function releaseAccount(accountId?: string): void {
  if (!accountId) return;
  const q = accountWaiters.get(accountId);
  if (q && q.length) {
    const next = q.shift()!;
    next(); // transferir el slot al siguiente en espera (sin tocar el contador)
  } else {
    const cur = accountActive.get(accountId) ?? 1;
    accountActive.set(accountId, Math.max(0, cur - 1));
  }
}

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

async function processJob(bullJob: BullJob) {
  console.log(`[worker] Job BullMQ ${bullJob.id} tipo ${bullJob.name}`);

  // Jobs de sistema (sin fila en DB): sincronización de snapshots.
  if (bullJob.name === "SYNC_DASHBOARD") {
    console.log("[worker] SYNC_DASHBOARD: sincronizando dashboards de todas las operaciones...");
    await syncAllDashboards();
    return;
  }
  if (bullJob.name === "SYNC_LISTINGS") {
    console.log("[worker] SYNC_LISTINGS: sincronizando listados de todas las operaciones...");
    await syncAllListings();
    return;
  }
  if (bullJob.name === "SYNC_FANPAGES") {
    console.log("[worker] SYNC_FANPAGES: sincronizando fanpages de todas las operaciones...");
    await syncAllFanpages();
    return;
  }
  if (bullJob.name === "SYNC_LISTINGS_ACCOUNT") {
    const { operationId, accountId, bmId } = bullJob.data as { operationId: string; accountId: string; bmId: string };
    console.log(`[worker] SYNC_LISTINGS_ACCOUNT: cuenta ${accountId} (op ${operationId})`);
    await syncListingsForAccount(operationId, { id: accountId, bmId });
    return;
  }

  const jobId: string = bullJob.data.jobId;
  const accountId: string | undefined = bullJob.data.accountId;
  const logs: LogEntry[] = [];

  // Esperar cupo de la cuenta (máx PER_ACCOUNT_MAX de la misma ad account a la vez).
  await acquireAccount(accountId);
  try {
    await runJob(bullJob, jobId, logs);
  } finally {
    releaseAccount(accountId);
  }
}

async function runJob(bullJob: BullJob, jobId: string, logs: LogEntry[]) {
  await prisma.metaJob.update({
    where: { id: jobId },
    data: { status: "processing", progress: 0 },
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
        const { campaignId, accountId, name, status, bmId } = bullJob.data;
        const result = await duplicateCampaign(campaignId, accountId, name, status, bmId, cb, checkCancelled);
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
    const message = error instanceof Error ? error.message : String(error);
    // Cancelación = no es un fallo: dejar el job en "cancelled" (lo puso la API) sin pisarlo.
    const cancelled = error instanceof CancelledError;
    logs.push({ ts: new Date().toISOString(), msg: cancelled ? "Cancelado por el usuario" : `ERROR: ${message}` });
    await prisma.metaJob.update({
      where: { id: jobId },
      data: cancelled
        ? { status: "cancelled", logs }
        : { status: "failed", error: message, logs },
    });
    throw error;
  }
}

const worker = new Worker("duplications", processJob, {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

worker.on("completed", (job) => {
  console.log(`[worker] Job BullMQ ${job.id} completado`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job BullMQ ${job?.id} falló:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] Error:", err);
});

console.log("[worker] Listo, esperando jobs en la cola 'duplications'...");

// Programar el sync del dashboard: uno inmediato al arrancar + repetible cada 20 min.
// El repeatable es idempotente por su clave (no se duplica entre despliegues).
(async () => {
  try {
    await duplicationsQueue.add(JOB_TYPES.SYNC_DASHBOARD, {}, { removeOnComplete: true, removeOnFail: true });
    await duplicationsQueue.add(
      JOB_TYPES.SYNC_DASHBOARD, {},
      { repeat: { every: 20 * 60 * 1000 }, removeOnComplete: true, removeOnFail: true }
    );
    // Listados (campañas/adsets/ads/insights): inmediato + cada 30 min.
    await duplicationsQueue.add(JOB_TYPES.SYNC_LISTINGS, {}, { removeOnComplete: true, removeOnFail: true });
    await duplicationsQueue.add(
      JOB_TYPES.SYNC_LISTINGS, {},
      { repeat: { every: 30 * 60 * 1000 }, removeOnComplete: true, removeOnFail: true }
    );
    // Fanpages: una vez al día a las 5:00 AM (hora Colombia). No lleva pasada
    // inmediata: las páginas cambian poco y el botón "Sincronizar" cubre lo
    // urgente. El repeatable es idempotente por su clave (cron + tz).
    await duplicationsQueue.add(
      JOB_TYPES.SYNC_FANPAGES, {},
      { repeat: { pattern: "0 5 * * *", tz: "America/Bogota" }, removeOnComplete: true, removeOnFail: true }
    );
    console.log("[worker] Sync programado: dashboard (20 min) + listados (30 min) + fanpages (diario 5:00 AM).");
  } catch (e) {
    console.error("[worker] No se pudo programar el sync de dashboard:", e);
  }
})();

process.on("SIGTERM", async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});
