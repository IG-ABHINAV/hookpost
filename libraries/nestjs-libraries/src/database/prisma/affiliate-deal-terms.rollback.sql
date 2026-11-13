-- Undo affiliate-deal-terms.migration.sql, AFTER the previous code is
-- deployed again (it does not read the referral columns). Safe twice.
-- Affiliates who joined after the migration keep commissionMonths 12; set
-- them to 0 by hand if lifetime terms were promised to them.
BEGIN;
ALTER TABLE "AffiliateReferral" DROP COLUMN IF EXISTS "commissionPercent";
ALTER TABLE "AffiliateReferral" DROP COLUMN IF EXISTS "commissionMonths";
ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 0;
COMMIT;
