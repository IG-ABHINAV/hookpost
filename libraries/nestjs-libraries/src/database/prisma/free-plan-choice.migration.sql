-- "Start free" remembered on the server (model FreePlanChoice in schema.prisma).
-- Apply by hand (never prisma db push - see deploy.sh). Only creates a new
-- table; touches nothing that exists. Generated with prisma migrate diff.
--
-- Safe in either order with the deploy: until the table exists the app logs
-- one warning per process, keeps the browser-only behaviour for "Start free",
-- and still skips the plans screen for workspaces with a channel or a post.
BEGIN;

CREATE TABLE IF NOT EXISTS "FreePlanChoice" (
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreePlanChoice_pkey" PRIMARY KEY ("organizationId")
);

COMMIT;

-- Roll back with:
--   DROP TABLE "FreePlanChoice";
