-- Media retention after a plan ends (model MediaRetention in schema.prisma;
-- media.retention.service.ts): the 30-day clock of workspaces without a plan.
-- Apply by hand (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/media-retention.migration.sql
-- Only creates a new table; touches nothing that exists, and running it
-- twice changes nothing (IF NOT EXISTS). Generated with prisma migrate diff;
-- tests/integration/media-retention.int.spec.ts applies it twice.
--
-- Apply BEFORE the deploy. Until the table exists the daily run logs the
-- error and does nothing, and the plan-ended emails go out without the
-- retention line: nothing breaks, nothing is removed.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "MediaRetention" (
    "organizationId" TEXT NOT NULL,
    "planEndedAt" TIMESTAMP(3) NOT NULL,
    "noticeSentAt" TIMESTAMP(3),
    "removeAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaRetention_pkey" PRIMARY KEY ("organizationId")
);

CREATE INDEX IF NOT EXISTS "MediaRetention_removeAt_idx" ON "MediaRetention"("removeAt");

COMMIT;

-- Roll back with:
--   DROP TABLE "MediaRetention";
