-- AlterTable
ALTER TABLE "cloner"."CloneJob" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "status" SET DEFAULT 'queued';
