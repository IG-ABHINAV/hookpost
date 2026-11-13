-- Hookpost plans sold on Gumroad (model GumroadLicense in schema.prisma).
-- Apply by hand (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/gumroad-license.migration.sql
-- Only creates a new table; touches nothing that exists. Generated with
-- prisma migrate diff.
--
-- Apply BEFORE setting GUMROAD_PRODUCT_STANDARD / GUMROAD_PRODUCT_PRO in .env.
-- Nothing reads this table while both are empty (the redeem field is hidden,
-- POST /billing/gumroad/redeem answers 404 and the daily re-check does
-- nothing), so the backend can be deployed before or after it.
BEGIN;

CREATE TABLE IF NOT EXISTS "GumroadLicense" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "licenseKeyHash" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "period" "Period" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GumroadLicense_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GumroadLicense_licenseKeyHash_key" ON "GumroadLicense"("licenseKeyHash");

CREATE INDEX IF NOT EXISTS "GumroadLicense_organizationId_idx" ON "GumroadLicense"("organizationId");

CREATE INDEX IF NOT EXISTS "GumroadLicense_status_lastVerifiedAt_idx" ON "GumroadLicense"("status", "lastVerifiedAt");

COMMIT;

-- Roll back with (only after GUMROAD_PRODUCT_* are empty again):
--   DROP TABLE "GumroadLicense";
