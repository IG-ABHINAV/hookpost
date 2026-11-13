-- A payment dispute (chargeback) on a workspace: the six nullable columns of
-- model Organization in schema.prisma. Apply by hand (never prisma db push -
-- see deploy.sh). Only adds nullable columns and one index; touches no data
-- and changes nothing that exists, so it is safe to apply before the deploy.
--
-- Until these columns exist, every read of a workspace fails once the code
-- that selects them is live, so apply this BEFORE deploying the dispute
-- branch. Without the deploy the columns are simply never written.
BEGIN;

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputeReason" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputePaymentId" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputeClearedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputeClearedBy" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "disputeEvidence" TEXT;

CREATE INDEX IF NOT EXISTS "Organization_disputedAt_idx" ON "Organization"("disputedAt");

COMMIT;

-- Roll back with:
--   DROP INDEX IF EXISTS "Organization_disputedAt_idx";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputeEvidence";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputeClearedBy";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputeClearedAt";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputePaymentId";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputeReason";
--   ALTER TABLE "Organization" DROP COLUMN IF EXISTS "disputedAt";
