-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "automations";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "links";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "meta";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "monitor";

-- CreateEnum
CREATE TYPE "core"."Role" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER', 'SERVICE');

-- CreateEnum
CREATE TYPE "core"."Module" AS ENUM ('META', 'AUTOMATIONS', 'LINKS', 'MONITOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "core"."GrantLevel" AS ENUM ('NONE', 'READ', 'WRITE', 'ADMIN');

-- CreateEnum
CREATE TYPE "core"."UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "automations"."ScopeMode" AS ENUM ('ALL', 'INCLUDE', 'EXCLUDE');

-- CreateEnum
CREATE TYPE "monitor"."LinkHealth" AS ENUM ('OK', 'FAIL', 'UNKNOWN');

-- CreateTable
CREATE TABLE "core"."Operation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" "core"."Role" NOT NULL DEFAULT 'OPERATOR',
    "status" "core"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ModuleGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "module" "core"."Module" NOT NULL,
    "level" "core"."GrantLevel" NOT NULL DEFAULT 'READ',

    CONSTRAINT "ModuleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "module" "core"."Module" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Secret" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "hint" TEXT,
    "operationId" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "section" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "meta"."BusinessManager" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bmIdMeta" TEXT NOT NULL,
    "systemUserId" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenLast4" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessManager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."AdAccount" (
    "id" TEXT NOT NULL,
    "accountIdMeta" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "bmId" TEXT NOT NULL,
    "lastSynced" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."FanpageToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemUserId" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FanpageToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."Fanpage" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "picture" TEXT,
    "bmId" TEXT,
    "bmName" TEXT,
    "igReal" TEXT,
    "igId" TEXT,
    "pbiaCheckedAt" TIMESTAMP(3),
    "tasks" TEXT[],
    "isPublished" BOOLEAN,
    "verificationStatus" TEXT,
    "activeAds" INTEGER,
    "adsSyncedAt" TIMESTAMP(3),
    "operationId" TEXT,
    "lastSynced" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fanpage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."LaunchSheet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'launches',
    "columns" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."SheetRow" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."Launch" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "mlaNombre" TEXT NOT NULL DEFAULT '',
    "businessName" TEXT NOT NULL DEFAULT '',
    "businessId" TEXT NOT NULL DEFAULT '',
    "adAccount" TEXT NOT NULL DEFAULT '',
    "fanPageId" TEXT NOT NULL DEFAULT '',
    "fanPage" TEXT NOT NULL DEFAULT '',
    "fanPageBm" TEXT NOT NULL DEFAULT '',
    "nameAds" TEXT NOT NULL DEFAULT '',
    "nameAdsUrl" TEXT NOT NULL DEFAULT '',
    "oferta" TEXT NOT NULL DEFAULT '',
    "tipoAnuncio" TEXT NOT NULL DEFAULT '',
    "strategy" TEXT NOT NULL DEFAULT '',
    "dominios" TEXT NOT NULL DEFAULT '',
    "urlLanzar" TEXT NOT NULL DEFAULT '',
    "suffixUrl" TEXT NOT NULL DEFAULT '',
    "nombrePixel" TEXT NOT NULL DEFAULT '',
    "pixelId" TEXT NOT NULL DEFAULT '',
    "tokenEnc" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Launch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."AccountInsightSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "datePreset" TEXT NOT NULL,
    "accountName" TEXT,
    "accountStatus" INTEGER NOT NULL DEFAULT 0,
    "bmId" TEXT,
    "data" JSONB,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta"."ListingSnapshot" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "datePreset" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "links"."Domain" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "lastIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "links"."FunnelUrl" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urlTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunnelUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "links"."Link" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "funnelUrlId" TEXT,
    "targetUrl" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "adsetId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "assetId" TEXT,
    "adName" TEXT,
    "campaignName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "operationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations"."automation_tasks" (
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scopeMode" "automations"."ScopeMode" NOT NULL DEFAULT 'ALL',
    "scopeAccounts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "operationId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_tasks_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "automations"."task_runs" (
    "id" SERIAL NOT NULL,
    "taskName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "success" BOOLEAN,
    "errorMsg" TEXT,
    "result" JSONB,
    "durationS" DOUBLE PRECISION,
    "triggeredBy" TEXT NOT NULL DEFAULT 'scheduler',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations"."account_snapshots" (
    "id" SERIAL NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "statusCode" INTEGER,
    "statusLabel" TEXT,
    "level" TEXT,
    "balance" DOUBLE PRECISION,
    "currency" TEXT,
    "errorMsg" TEXT,

    CONSTRAINT "account_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations"."billing_alerts" (
    "id" SERIAL NOT NULL,
    "alertedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "alertType" TEXT,
    "message" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "billing_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations"."task_triggers" (
    "id" SERIAL NOT NULL,
    "taskName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "task_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations"."system_flags" (
    "key" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "monitor"."MonitoredLink" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "expectedUrl" TEXT,
    "expectedText" TEXT,
    "maxResponseMs" INTEGER NOT NULL DEFAULT 10000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "monitor"."LinkHealth" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastFailAt" TIMESTAMP(3),
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoredLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."MonitorCheck" (
    "id" BIGSERIAL NOT NULL,
    "linkId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "monitor"."LinkHealth" NOT NULL,
    "httpStatus" INTEGER,
    "finalUrl" TEXT,
    "responseMs" INTEGER,
    "failReason" TEXT,
    "detail" TEXT,

    CONSTRAINT "MonitorCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor"."MonitorIncident" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "reason" TEXT,
    "detail" TEXT,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MonitorIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operation_slug_key" ON "core"."Operation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "core"."User"("email");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "core"."User"("status");

-- CreateIndex
CREATE INDEX "Membership_operationId_idx" ON "core"."Membership"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_operationId_key" ON "core"."Membership"("userId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleGrant_userId_module_key" ON "core"."ModuleGrant"("userId", "module");

-- CreateIndex
CREATE INDEX "AuditLog_module_createdAt_idx" ON "core"."AuditLog"("module", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "core"."AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "core"."AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_key_key" ON "core"."Secret"("key");

-- CreateIndex
CREATE INDEX "Secret_section_idx" ON "core"."Secret"("section");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessManager_systemUserId_key" ON "meta"."BusinessManager"("systemUserId");

-- CreateIndex
CREATE INDEX "BusinessManager_operationId_idx" ON "meta"."BusinessManager"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_accountIdMeta_key" ON "meta"."AdAccount"("accountIdMeta");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "meta"."jobs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FanpageToken_systemUserId_key" ON "meta"."FanpageToken"("systemUserId");

-- CreateIndex
CREATE INDEX "FanpageToken_operationId_idx" ON "meta"."FanpageToken"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "Fanpage_pageId_key" ON "meta"."Fanpage"("pageId");

-- CreateIndex
CREATE INDEX "Fanpage_bmId_idx" ON "meta"."Fanpage"("bmId");

-- CreateIndex
CREATE INDEX "Fanpage_operationId_idx" ON "meta"."Fanpage"("operationId");

-- CreateIndex
CREATE INDEX "LaunchSheet_operationId_idx" ON "meta"."LaunchSheet"("operationId");

-- CreateIndex
CREATE INDEX "SheetRow_sheetId_idx" ON "meta"."SheetRow"("sheetId");

-- CreateIndex
CREATE INDEX "Launch_operationId_idx" ON "meta"."Launch"("operationId");

-- CreateIndex
CREATE INDEX "Launch_sheetId_idx" ON "meta"."Launch"("sheetId");

-- CreateIndex
CREATE INDEX "AccountInsightSnapshot_operationId_datePreset_idx" ON "meta"."AccountInsightSnapshot"("operationId", "datePreset");

-- CreateIndex
CREATE UNIQUE INDEX "AccountInsightSnapshot_accountId_operationId_datePreset_key" ON "meta"."AccountInsightSnapshot"("accountId", "operationId", "datePreset");

-- CreateIndex
CREATE INDEX "ListingSnapshot_operationId_accountId_idx" ON "meta"."ListingSnapshot"("operationId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingSnapshot_operationId_accountId_kind_datePreset_key" ON "meta"."ListingSnapshot"("operationId", "accountId", "kind", "datePreset");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_host_key" ON "links"."Domain"("host");

-- CreateIndex
CREATE UNIQUE INDEX "Link_slug_key" ON "links"."Link"("slug");

-- CreateIndex
CREATE INDEX "Link_domainId_idx" ON "links"."Link"("domainId");

-- CreateIndex
CREATE INDEX "Link_funnelUrlId_idx" ON "links"."Link"("funnelUrlId");

-- CreateIndex
CREATE INDEX "Link_operationId_idx" ON "links"."Link"("operationId");

-- CreateIndex
CREATE INDEX "task_runs_taskName_startedAt_idx" ON "automations"."task_runs"("taskName", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "account_snapshots_checkedAt_idx" ON "automations"."account_snapshots"("checkedAt" DESC);

-- CreateIndex
CREATE INDEX "account_snapshots_accountId_checkedAt_idx" ON "automations"."account_snapshots"("accountId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "billing_alerts_alertedAt_idx" ON "automations"."billing_alerts"("alertedAt" DESC);

-- CreateIndex
CREATE INDEX "task_triggers_processed_idx" ON "automations"."task_triggers"("processed");

-- CreateIndex
CREATE INDEX "MonitoredLink_status_idx" ON "monitor"."MonitoredLink"("status");

-- CreateIndex
CREATE INDEX "MonitoredLink_operationId_idx" ON "monitor"."MonitoredLink"("operationId");

-- CreateIndex
CREATE INDEX "MonitorCheck_linkId_checkedAt_idx" ON "monitor"."MonitorCheck"("linkId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "MonitorCheck_checkedAt_idx" ON "monitor"."MonitorCheck"("checkedAt" DESC);

-- CreateIndex
CREATE INDEX "MonitorIncident_linkId_openedAt_idx" ON "monitor"."MonitorIncident"("linkId", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "MonitorIncident_closedAt_idx" ON "monitor"."MonitorIncident"("closedAt");

-- AddForeignKey
ALTER TABLE "core"."Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Membership" ADD CONSTRAINT "Membership_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "core"."Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ModuleGrant" ADD CONSTRAINT "ModuleGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta"."AdAccount" ADD CONSTRAINT "AdAccount_bmId_fkey" FOREIGN KEY ("bmId") REFERENCES "meta"."BusinessManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta"."SheetRow" ADD CONSTRAINT "SheetRow_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "meta"."LaunchSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links"."Link" ADD CONSTRAINT "Link_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "links"."Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links"."Link" ADD CONSTRAINT "Link_funnelUrlId_fkey" FOREIGN KEY ("funnelUrlId") REFERENCES "links"."FunnelUrl"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations"."task_runs" ADD CONSTRAINT "task_runs_taskName_fkey" FOREIGN KEY ("taskName") REFERENCES "automations"."automation_tasks"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations"."task_triggers" ADD CONSTRAINT "task_triggers_taskName_fkey" FOREIGN KEY ("taskName") REFERENCES "automations"."automation_tasks"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor"."MonitorCheck" ADD CONSTRAINT "MonitorCheck_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "monitor"."MonitoredLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor"."MonitorIncident" ADD CONSTRAINT "MonitorIncident_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "monitor"."MonitoredLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
