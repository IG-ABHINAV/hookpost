-- The in-app review card's state, one row per user (model ReviewAsk in
-- schema.prisma, review-ask/review.ask.policy.ts).
-- Apply by hand (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -f libraries/nestjs-libraries/src/database/prisma/review-ask.migration.sql
-- Only creates a new table; touches nothing that exists, and running it
-- twice changes nothing (IF NOT EXISTS). Generated with prisma migrate diff;
-- tests/integration/review-ask.int.spec.ts applies it twice to a copy of the
-- schema and checks the result equals schema.prisma.
--
-- Safe in either order with the deploy: until the table exists the backend
-- logs one warning per process and the card never appears.
BEGIN;

CREATE TABLE IF NOT EXISTS "ReviewAsk" (
    "userId" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL,
    "asks" INTEGER NOT NULL DEFAULT 1,
    "dismissedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "clickedTarget" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewAsk_pkey" PRIMARY KEY ("userId")
);

COMMIT;

-- Roll back with:
--   DROP TABLE "ReviewAsk";
