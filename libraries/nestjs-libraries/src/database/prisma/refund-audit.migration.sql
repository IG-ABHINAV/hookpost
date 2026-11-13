-- Audit trail of the super-admin Refunds page (model RefundAudit in schema.prisma).
-- Apply by hand (never prisma db push - see deploy.sh). Only creates a new
-- table; touches nothing that exists. Generated with prisma migrate diff.
--
-- Apply BEFORE using /admin/refunds: until the table exists every refund is
-- refused (no audit row, no refund), and the page says so. Nothing else in
-- the app reads this table, so the deploy order does not matter otherwise.
BEGIN;

CREATE TABLE IF NOT EXISTS "RefundAudit" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "foreign" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "refundId" TEXT,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RefundAudit_paymentId_idx" ON "RefundAudit"("paymentId");

CREATE INDEX IF NOT EXISTS "RefundAudit_createdAt_idx" ON "RefundAudit"("createdAt");

COMMIT;

-- Roll back with:
--   DROP TABLE "RefundAudit";
