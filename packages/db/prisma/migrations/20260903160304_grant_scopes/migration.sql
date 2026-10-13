-- AlterTable
ALTER TABLE "core"."ModuleGrant" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
