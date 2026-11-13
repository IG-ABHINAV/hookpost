-- The single plan on sale since 8 Nov 2026 (pricing.ts TIER_LIMITS.HOOKPOST):
-- every new purchase, autopay or a paid one-time month, is written with
-- Subscription."subscriptionTier" = 'HOOKPOST'. STANDARD, PRO, TEAM and
-- ULTIMATE stay, so everyone on them keeps exactly what they have.
--
-- Apply by hand BEFORE the deploy (never prisma db push - see deploy.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f libraries/nestjs-libraries/src/database/prisma/single-plan-tier.migration.sql
--
-- Additive only: one new enum value, no rows touched. Code built before this
-- change never writes it. Running it twice changes nothing (IF NOT EXISTS).
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- Postgres, so there is no BEGIN/COMMIT here.
--
-- Order matters: the new backend writes 'HOOKPOST' on the first purchase, so
-- this runs first.

ALTER TYPE "SubscriptionTier" ADD VALUE IF NOT EXISTS 'HOOKPOST';

-- Rolling the CODE back: nothing to undo while no row uses the value. Rows
-- on HOOKPOST would read as FREE to an older build (pricing[tier] missing),
-- so move them first, e.g. to PRO, which has every HOOKPOST feature:
--   UPDATE "Subscription" SET "subscriptionTier" = 'PRO' WHERE "subscriptionTier" = 'HOOKPOST';
-- Postgres cannot drop an enum value; leaving it is harmless.
