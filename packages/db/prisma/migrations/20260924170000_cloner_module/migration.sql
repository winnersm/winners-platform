-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cloner";

-- AlterEnum
ALTER TYPE "core"."Module" ADD VALUE 'CLONER';

-- CreateTable
CREATE TABLE "cloner"."CloneToken" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "hint" TEXT,
    "userName" TEXT,
    "userIdMeta" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloneToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloner"."CloneTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "sourceCampaignId" TEXT NOT NULL DEFAULT '',
    "sourceAccountId" TEXT NOT NULL DEFAULT '',
    "structure" JSONB NOT NULL,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloneTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloner"."CloneRun" (
    "id" TEXT NOT NULL,
    "sourceCampaign" TEXT NOT NULL DEFAULT '',
    "sourceName" TEXT NOT NULL DEFAULT '',
    "sourceAccount" TEXT NOT NULL DEFAULT '',
    "targetAccount" TEXT NOT NULL,
    "targetName" TEXT NOT NULL DEFAULT '',
    "targetCampaign" TEXT NOT NULL DEFAULT '',
    "adsets" INTEGER NOT NULL DEFAULT 0,
    "ads" INTEGER NOT NULL DEFAULT 0,
    "requestedCopies" INTEGER NOT NULL DEFAULT 1,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "jobId" TEXT,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloneRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloner"."CloneJob" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "results" JSONB NOT NULL DEFAULT '[]',
    "input" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CloneJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloner"."CloneCache" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloneCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloneToken_alias_key" ON "cloner"."CloneToken"("alias");

-- CreateIndex
CREATE INDEX "CloneToken_operationId_idx" ON "cloner"."CloneToken"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "CloneTemplate_name_key" ON "cloner"."CloneTemplate"("name");

-- CreateIndex
CREATE INDEX "CloneTemplate_operationId_idx" ON "cloner"."CloneTemplate"("operationId");

-- CreateIndex
CREATE INDEX "CloneRun_createdAt_idx" ON "cloner"."CloneRun"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CloneRun_operationId_idx" ON "cloner"."CloneRun"("operationId");

-- CreateIndex
CREATE INDEX "CloneJob_status_createdAt_idx" ON "cloner"."CloneJob"("status", "createdAt" DESC);
