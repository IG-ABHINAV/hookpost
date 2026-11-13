-- Affiliate commission for the lifetime of the referred subscription
-- (owner's approval, 22 Oct 2026). Apply by hand on production, once, after
-- the code that reads commissionMonths = 0 as "no limit" is deployed
-- (affiliate.terms.ts). Never prisma db push.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f affiliate-lifetime.migration.sql
--
-- Idempotent: safe to run again. A second run keeps the first backup and
-- moves only rows that were at 12 in that backup, so a 12-month deal made by
-- hand after the first run is left alone.
--
-- What it does:
--   1. Backs up the Affiliate table as it is now, into
--      "Affiliate_backup_20261022" (created only if it does not exist yet, so
--      a re-run never overwrites the original rows).
--   2. Moves every affiliate on the old 12-month window to lifetime
--      (commissionMonths 0). Only rows at 12, the programme's old default,
--      both now and in the backup: a deal made by hand with another window,
--      or any row created after the backup, is left alone.
--   3. Makes 0 the column default, so a row created without the column also
--      gets lifetime. The code writes 0 explicitly anyway.
--
-- AffiliateReferral and AffiliateCommission store no window and are not
-- touched. Commission on payments made before the deploy is not recomputed:
-- a payment more than 12 months after its referral cannot exist yet (the
-- programme started 27 Sep 2026).
--
-- Additive only: no column is added, dropped or renamed. To undo, run
-- affiliate-lifetime.rollback.sql right after the previous code is deployed
-- again (that code reads commissionMonths 0 as no commission at all).
BEGIN;

CREATE TABLE IF NOT EXISTS "Affiliate_backup_20261022" AS
  SELECT * FROM "Affiliate";

UPDATE "Affiliate" a
   SET "commissionMonths" = 0
  FROM "Affiliate_backup_20261022" b
 WHERE b.id = a.id
   AND b."commissionMonths" = 12
   AND a."commissionMonths" = 12;

ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 0;

-- What it left: every row's window, and the backup's size.
SELECT "commissionMonths", count(*) AS affiliates
  FROM "Affiliate"
 GROUP BY 1
 ORDER BY 1;
SELECT count(*) AS backed_up FROM "Affiliate_backup_20261022";

COMMIT;
