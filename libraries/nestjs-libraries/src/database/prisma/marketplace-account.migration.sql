-- Hookpost products sold on api.market (model MarketplaceAccount in
-- schema.prisma, apps/backend/src/marketplace-api).
-- Apply by hand (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/marketplace-account.migration.sql
-- Only creates a new table and its indexes; touches nothing that exists, and
-- running it twice changes nothing (IF NOT EXISTS). Generated with
-- prisma migrate diff; tests/integration/marketplace-migration.int.spec.ts
-- applies it twice to a copy of the schema and checks the result equals
-- schema.prisma.
--
-- Apply BEFORE setting any MKT_GATEWAY_SECRETS_* in .env. While all of them
-- are empty every /api/mkt request is refused before this table is read, so
-- the backend can be deployed before or after it.
BEGIN;

CREATE TABLE IF NOT EXISTS "MarketplaceAccount" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'API_MARKET',
    "externalUserId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceAccount_organizationId_key" ON "MarketplaceAccount"("organizationId");

CREATE INDEX IF NOT EXISTS "MarketplaceAccount_status_lastSeenAt_idx" ON "MarketplaceAccount"("status", "lastSeenAt");

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceAccount_marketplace_externalUserId_product_key" ON "MarketplaceAccount"("marketplace", "externalUserId", "product");

COMMIT;

-- Roll back with (only after every MKT_GATEWAY_SECRETS_* is empty again; the
-- workspaces it created stay, unreachable, with their apimkt: plan rows):
--   DROP TABLE "MarketplaceAccount";
