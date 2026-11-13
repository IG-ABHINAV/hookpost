-- Undoes affiliate-lifetime.migration.sql. Apply by hand on production only
-- if that release is rolled back, right after the previous code is deployed
-- again: that code reads commissionMonths 0 as no commission at all, and 12
-- (the column default it expects) as twelve months. Never prisma db push.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f affiliate-lifetime.rollback.sql
--
-- What it does:
--   1. Every affiliate in "Affiliate_backup_20261022" gets back the window it
--      had then.
--   2. An affiliate who joined after the migration (lifetime, 0, not in the
--      backup) gets the programme's previous 12 months.
--   3. The column default goes back to 12.
-- The backup table is kept. Safe to run twice.
BEGIN;

UPDATE "Affiliate" a
   SET "commissionMonths" = b."commissionMonths"
  FROM "Affiliate_backup_20261022" b
 WHERE b.id = a.id
   AND a."commissionMonths" IS DISTINCT FROM b."commissionMonths";

UPDATE "Affiliate"
   SET "commissionMonths" = 12
 WHERE "commissionMonths" = 0
   AND id NOT IN (SELECT id FROM "Affiliate_backup_20261022");

ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 12;

-- What it left: every row's window.
SELECT "commissionMonths", count(*) AS affiliates
  FROM "Affiliate"
 GROUP BY 1
 ORDER BY 1;

COMMIT;
