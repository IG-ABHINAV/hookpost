-- Audit trail of the super admin's "End plan now" and "Restore plan" on the
-- Users & Billing page (model PlanActionAudit in schema.prisma). Apply by hand
-- (never prisma db push - see deploy.sh). Only creates a new table; touches
-- nothing that exists. Generated with prisma migrate diff.
--
-- Apply BEFORE using the buttons: until the table exists every end and restore
-- is refused (no audit row, no plan change), and the page says so. Nothing
-- else in the app reads this table, so the deploy order does not matter
-- otherwise.
BEGIN;

CREATE TABLE IF NOT EXISTS "PlanActionAudit" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "correction" TEXT,
    "tier" TEXT,
    "period" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "emailOutcome" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanActionAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlanActionAudit_organizationId_idx" ON "PlanActionAudit"("organizationId");

CREATE INDEX IF NOT EXISTS "PlanActionAudit_createdAt_idx" ON "PlanActionAudit"("createdAt");

COMMIT;

-- Roll back with:
--   DROP TABLE "PlanActionAudit";
