-- AccountSpendDaily se añadió al schema sin migración (cbd8e5c). En producción
-- se creó a mano sin comillas, así que quedó como "accountspenddaily" con
-- columnas en minúsculas y Prisma no la encuentra. Esta migración la rehace.
-- Es idempotente: también sirve en bases donde la tabla ya existe bien.

-- 1. Tabla en minúsculas: se elimina solo si está vacía.
DO $$
BEGIN
  IF to_regclass('meta.accountspenddaily') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM meta.accountspenddaily LIMIT 1) THEN
      RAISE EXCEPTION 'meta.accountspenddaily tiene datos: migrarlos antes de continuar';
    END IF;
    DROP TABLE meta.accountspenddaily;
  END IF;
END $$;

-- 2. Libro diario de gasto.
CREATE TABLE IF NOT EXISTS "meta"."AccountSpendDaily" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "accountName" TEXT,
    "bmId" TEXT,
    "currency" TEXT,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSpendDaily_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "meta"."AccountSpendDaily" ADD COLUMN IF NOT EXISTS "currency" TEXT;

CREATE INDEX IF NOT EXISTS "AccountSpendDaily_operationId_date_idx" ON "meta"."AccountSpendDaily"("operationId", "date");
CREATE INDEX IF NOT EXISTS "AccountSpendDaily_accountId_idx" ON "meta"."AccountSpendDaily"("accountId");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountSpendDaily_accountId_operationId_date_key" ON "meta"."AccountSpendDaily"("accountId", "operationId", "date");

-- 3. Índices del schema que tampoco tenían migración.
CREATE INDEX IF NOT EXISTS "AccountInsightSnapshot_operationId_removedFromBmAt_idx" ON "meta"."AccountInsightSnapshot"("operationId", "removedFromBmAt");
CREATE INDEX IF NOT EXISTS "BusinessManager_operationId_deletedAt_idx" ON "meta"."BusinessManager"("operationId", "deletedAt");

-- 4. Precisión de timestamps igual a la que genera Prisma.
ALTER TABLE "meta"."AccountInsightSnapshot" ALTER COLUMN "lastSeenInBmAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "removedFromBmAt" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "meta"."BusinessManager" ALTER COLUMN "deletedAt" SET DATA TYPE TIMESTAMP(3);
