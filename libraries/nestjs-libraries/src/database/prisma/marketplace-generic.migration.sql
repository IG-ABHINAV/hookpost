-- One gateway for every API marketplace (marketplace.adapters.ts), 26 Oct 2026:
--  - Organization.source: where each customer came from. DIRECT for every
--    workspace made by signing up on hookpost.hookstep.in (the column's
--    default, so every existing row reads DIRECT at once, without a table
--    rewrite), the marketplace id (API_MARKET, RAPIDAPI, ...) for workspaces
--    a marketplace subscriber's first call made, backfilled here from
--    MarketplaceAccount;
--  - MarketplaceUsageDay: calls per marketplace, product and UTC day for the
--    admin Marketplaces page (counted in memory, added every 15 s).
--
-- Apply by hand BEFORE deploying the backend that has these in its schema
-- (never prisma db push - see deploy.sh). Prisma reads every column of a
-- model, so a backend that knows Organization.source while the database does
-- not would fail every workspace query. The backend running now does not
-- read the new column or table, so applying this first changes nothing for it.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f libraries/nestjs-libraries/src/database/prisma/marketplace-generic.migration.sql
--
-- Run it again right after the deploy: a marketplace workspace the old
-- backend made in between got the default DIRECT, and the UPDATE fixes it.
--
-- Adds; drops, rewrites and deletes nothing. Safe to run twice (IF NOT EXISTS,
-- and the UPDATE only touches rows still DIRECT that a MarketplaceAccount
-- owns). tests/integration/marketplace-generic-migration.int.spec.ts applies
-- it twice to a copy of today's schema and checks the result equals
-- schema.prisma.
BEGIN;

-- ADD COLUMN takes an ACCESS EXCLUSIVE lock on Organization. If a long
-- transaction holds the table, give up after 5 s rather than queue every
-- request behind the ALTER; nothing is changed, run it again.
SET lock_timeout = '5s';

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'DIRECT';

UPDATE "Organization" o
SET "source" = m."marketplace"
FROM "MarketplaceAccount" m
WHERE m."organizationId" = o."id"
  AND o."source" = 'DIRECT';

CREATE TABLE IF NOT EXISTS "MarketplaceUsageDay" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "unauthorized" INTEGER NOT NULL DEFAULT 0,
    "forbidden" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" INTEGER NOT NULL DEFAULT 0,
    "clientErrors" INTEGER NOT NULL DEFAULT 0,
    "serverErrors" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "lastCallAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceUsageDay_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MarketplaceUsageDay_day_idx" ON "MarketplaceUsageDay"("day");

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceUsageDay_marketplace_product_day_key" ON "MarketplaceUsageDay"("marketplace", "product", "day");

COMMIT;

-- Roll back with (only after deploying a backend without them):
--   ALTER TABLE "Organization" DROP COLUMN "source";
--   DROP TABLE "MarketplaceUsageDay";
