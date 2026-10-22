-- Restore the operation timezone column expected by the current Prisma schema.
-- Some production databases marked the initial migration as applied without it.
ALTER TABLE "core"."Operation"
ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/Bogota';
