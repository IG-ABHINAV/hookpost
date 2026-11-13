-- Where each new workspace came from (model SignupAttribution in schema.prisma).
-- Apply by hand (never prisma db push - see deploy.sh). Only creates a new
-- table and its indexes; touches nothing that exists. Generated with prisma
-- migrate diff.
--
-- Safe in either order with the deploy: until the table exists the backend
-- logs one warning per process ("SignupAttribution is unavailable") and every
-- sign-up still succeeds, unrecorded; Meta's CompleteRegistration is sent
-- either way, and GET /admin/attribution answers 503 with the reason.
BEGIN;

CREATE TABLE IF NOT EXISTS "SignupAttribution" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "gclid" TEXT,
    "fbclid" TEXT,
    "ttclid" TEXT,
    "msclkid" TEXT,
    "fbc" TEXT,
    "fbp" TEXT,
    "landingPath" TEXT,
    "referrer" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "device" TEXT,
    "inApp" TEXT,
    "country" TEXT,
    "eventId" TEXT,
    "trialStartedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupAttribution_pkey" PRIMARY KEY ("organizationId")
);

CREATE INDEX IF NOT EXISTS "SignupAttribution_utmCampaign_idx" ON "SignupAttribution"("utmCampaign");

CREATE INDEX IF NOT EXISTS "SignupAttribution_createdAt_idx" ON "SignupAttribution"("createdAt");

COMMIT;

-- Roll back with:
--   DROP TABLE "SignupAttribution";
