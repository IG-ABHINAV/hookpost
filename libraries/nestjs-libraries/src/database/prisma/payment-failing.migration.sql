-- What stops while a payment is failing (owner's call, 29 Oct 2026):
-- Subscription."paymentFailingSince", written by RazorpayService on
-- subscription.pending / subscription.halted and cleared when a charge goes
-- through. trial.policy.ts planState reads it as `dunning`, which takes the
-- features that cost money per use off the workspace (AI and X) and leaves
-- publishing to the other channels, scheduling and media working.
--
-- Apply by hand BEFORE the deploy (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f libraries/nestjs-libraries/src/database/prisma/payment-failing.migration.sql
--
-- Additive only: one nullable column, no default and no backfill, so every
-- plan on file reads as "not failing", which is today's behaviour. Code built
-- before this change neither reads nor writes it. Running it twice changes
-- nothing (IF NOT EXISTS).
--
-- Order matters: the new backend selects "paymentFailingSince", so this runs
-- first. A backend that knows the column while the database does not fails
-- every plan-state read.
BEGIN;

ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "paymentFailingSince" TIMESTAMP(3);

COMMIT;

-- Rolling the CODE back (to a build before this change): nothing to undo.
-- Old code ignores the column, which only ever took AI and X off a failing
-- workspace, so a rollback simply restores the old "everything keeps working
-- while Razorpay retries" behaviour. Clearing the markers is optional:
--   UPDATE "Subscription" SET "paymentFailingSince" = NULL;
-- To drop the column (only once no build reads it):
--   ALTER TABLE "Subscription" DROP COLUMN "paymentFailingSince";
