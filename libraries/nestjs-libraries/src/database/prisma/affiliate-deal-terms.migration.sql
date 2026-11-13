-- Per-affiliate deal terms (3 Nov 2026). Apply by hand on production BEFORE
-- deploying the code that reads AffiliateReferral.commissionPercent /
-- .commissionMonths (Prisma selects them). Never prisma db push.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f affiliate-deal-terms.migration.sql
--
-- Idempotent and additive:
--   1. Adds two nullable columns to AffiliateReferral: the terms fixed for
--      that customer when they were referred.
--   2. Backfills every existing referral with its affiliate's terms as they
--      are now (lifetime, 30%, for everyone who joined before today), so no
--      later change to an affiliate's deal can cut a customer already
--      referred. Only rows still null are filled, so a re-run changes nothing.
--   3. Makes 12 the default of Affiliate.commissionMonths (the new standard
--      deal). The code writes it explicitly anyway. Existing affiliates keep
--      their stored terms.
BEGIN;
ALTER TABLE "AffiliateReferral" ADD COLUMN IF NOT EXISTS "commissionPercent" INTEGER;
ALTER TABLE "AffiliateReferral" ADD COLUMN IF NOT EXISTS "commissionMonths" INTEGER;
UPDATE "AffiliateReferral" r
   SET "commissionPercent" = a."commissionPercent",
       "commissionMonths"  = a."commissionMonths"
  FROM "Affiliate" a
 WHERE a."id" = r."affiliateId"
   AND r."commissionPercent" IS NULL
   AND r."commissionMonths" IS NULL;
ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 12;
COMMIT;
