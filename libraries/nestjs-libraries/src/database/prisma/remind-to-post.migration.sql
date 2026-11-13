-- "Remind me to post": Post.remind (the post is published by the user from
-- the platform's own app, Hookpost only sends the reminder) and the two
-- states such a post moves through, REMINDER_SENT and POSTED_MANUALLY
-- (postWorkflowV114, PostsService.markPostedManually).
-- Apply by hand BEFORE the deploy (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f libraries/nestjs-libraries/src/database/prisma/remind-to-post.migration.sql
-- Additive only: a column with a default and two enum values. Code built
-- before this change reads and writes posts exactly as before, and running
-- it twice changes nothing (IF NOT EXISTS). Generated with prisma migrate
-- diff; tests/integration/remind-to-post.int.spec.ts applies it twice to a
-- copy of the schema and checks the result equals schema.prisma.
--
-- Order matters: the new backend selects "remind", so this runs first.
BEGIN;

ALTER TYPE "State" ADD VALUE IF NOT EXISTS 'REMINDER_SENT';
ALTER TYPE "State" ADD VALUE IF NOT EXISTS 'POSTED_MANUALLY';

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "remind" BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- Rolling the CODE back (to a build before postWorkflowV114), in this order:
--   1. Old code ignores "remind", so a queued reminder would be PUBLISHED
--      through the platform's API, which the user chose not to do. Park them:
--        UPDATE "Post" SET state = 'DRAFT' WHERE remind AND state = 'QUEUE' AND "deletedAt" IS NULL;
--   2. Old Prisma clients cannot read the new states:
--        UPDATE "Post" SET state = 'PUBLISHED' WHERE state = 'POSTED_MANUALLY';
--        UPDATE "Post" SET state = 'ERROR', error = 'Reminder sent' WHERE state = 'REMINDER_SENT';
--   3. An old worker has no postWorkflowV114: terminate the running ones
--      (temporal workflow terminate --query 'WorkflowType="postWorkflowV114"').
-- The column can stay (old code never reads it). To drop it:
--   ALTER TABLE "Post" DROP COLUMN "remind";
-- Postgres cannot drop an enum value; leaving the two values is harmless.
