-- What a workspace's people and payment methods have had (model
-- BillingIdentity in schema.prisma): the first-month offer, and later the
-- trial, are given once per person (SubscriptionService.personHadBefore).
-- Apply by hand (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/billing-identity.migration.sql
-- Only creates a new table; touches nothing that exists, and running it
-- twice changes nothing (IF NOT EXISTS). Generated with prisma migrate diff;
-- tests/integration/billing-first-month-offer-once.int.spec.ts applies it
-- twice.
--
-- Apply BEFORE the deploy. Until the table exists every write to it is logged
-- and skipped, and the offer check cannot read it, fails open and gives the
-- offer to everyone (logged on each check): nothing breaks, but the rule is
-- off. Then fill it from Razorpay's history with
-- scripts/backfill-billing-identity.ts --write.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "BillingIdentity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingIdentity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BillingIdentity_kind_hash_idx" ON "BillingIdentity"("kind", "hash");

CREATE INDEX IF NOT EXISTS "BillingIdentity_organizationId_idx" ON "BillingIdentity"("organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "BillingIdentity_organizationId_kind_hash_source_key" ON "BillingIdentity"("organizationId", "kind", "hash", "source");

COMMIT;

-- Roll back with:
--   DROP TABLE "BillingIdentity";
