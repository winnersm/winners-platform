import { Queue } from "bullmq";

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
};

export const JOB_TYPES = {
  DUPLICATE_CAMPAIGN: "DUPLICATE_CAMPAIGN",
  DUPLICATE_ADSET: "DUPLICATE_ADSET",
  DUPLICATE_AD: "DUPLICATE_AD",
  DEEP_COPY: "DEEP_COPY",
  SYNC_ACCOUNTS: "SYNC_ACCOUNTS",
  CREATE_PBIA_BULK: "CREATE_PBIA_BULK",
  SYNC_ACTIVE_ADS: "SYNC_ACTIVE_ADS",
  SYNC_DASHBOARD: "SYNC_DASHBOARD",
  SYNC_LISTINGS: "SYNC_LISTINGS",
  SYNC_LISTINGS_ACCOUNT: "SYNC_LISTINGS_ACCOUNT",
  SYNC_FANPAGES: "SYNC_FANPAGES",
  SYNC_SPEND_DAILY: "SYNC_SPEND_DAILY",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const duplicationsQueue = new Queue("duplications", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// Sincronizaciones periódicas (dashboard, listados, fanpages, gasto). Van en su
// propia cola para que una tanda de duplicaciones no las deje esperando, y al
// revés: un sync largo no retrasa lo que pidió una persona.
export const syncQueue = new Queue("syncs", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

export const SYNC_JOB_NAMES = new Set<string>([
  JOB_TYPES.SYNC_DASHBOARD,
  JOB_TYPES.SYNC_LISTINGS,
  JOB_TYPES.SYNC_LISTINGS_ACCOUNT,
  JOB_TYPES.SYNC_FANPAGES,
  JOB_TYPES.SYNC_SPEND_DAILY,
]);
