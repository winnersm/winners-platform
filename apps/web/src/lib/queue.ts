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
