-- AddColumn: currency a AccountSpendDaily
ALTER TABLE "meta"."AccountSpendDaily" ADD COLUMN "currency" TEXT;

-- AddColumn: currency a AccountInsightSnapshot
ALTER TABLE "meta"."AccountInsightSnapshot" ADD COLUMN "currency" TEXT;
