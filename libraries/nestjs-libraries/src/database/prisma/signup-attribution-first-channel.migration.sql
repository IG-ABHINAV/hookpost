-- SignupAttribution.firstChannelAt (schema.prisma): when the workspace saved
-- its first real channel, so "connected a channel within 10 minutes of
-- sign-up" can be counted per campaign (GET /admin/attribution,
-- scripts/reports/signups-by-campaign.sql). Connect-first, 25 Oct 2026.
--
-- Apply by hand BEFORE deploying the backend that has the column in its
-- schema (never prisma db push - see deploy.sh). Prisma reads and returns
-- every column of the model, so a backend that knows the column while the
-- database does not would fail every SignupAttribution write: sign-ups still
-- succeed, but go unrecorded, and the report answers 503.
--
-- Adds one nullable column and fills it for workspaces that already have a
-- channel, from the earliest channel row that is not an unfinished two-step
-- placeholder (removed channels count: they were connected). Touches nothing
-- else. Safe to run twice.
BEGIN;

-- ADD COLUMN takes an ACCESS EXCLUSIVE lock on the table. If a long
-- transaction holds it, give up after 5 s instead of queueing every sign-up
-- write behind the ALTER; nothing is changed, run it again.
SET lock_timeout = '5s';

ALTER TABLE "SignupAttribution" ADD COLUMN IF NOT EXISTS "firstChannelAt" TIMESTAMP(3);

UPDATE "SignupAttribution" a
SET "firstChannelAt" = f.first_at
FROM (
  SELECT i."organizationId", min(i."createdAt") AS first_at
  FROM "Integration" i
  WHERE i."inBetweenSteps" = false
  GROUP BY i."organizationId"
) f
WHERE f."organizationId" = a."organizationId"
  AND a."firstChannelAt" IS NULL;

COMMIT;

-- Roll back with (after deploying a backend without the column):
--   ALTER TABLE "SignupAttribution" DROP COLUMN "firstChannelAt";
