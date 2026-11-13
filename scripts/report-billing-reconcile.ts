/**
 * READ-ONLY. The pre-charge guard's report (RazorpayService.reconcileBilling
 * with dryRun), run against production without the app.
 *
 * It only reads. It cancels nothing at Razorpay, writes nothing to the
 * database and sends no email. It answers one question: does the database
 * disagree with Razorpay about whether any customer will be charged?
 *
 * The verdicts come from razorpay.mapping.ts, the same pure helpers the
 * hourly job uses, so the report and the job can never drift apart.
 *
 * It prints workspace ids and Razorpay subscription ids, never a key, a
 * customer's contact details or a payment instrument.
 *
 * Run locally:
 *   npx ts-node --compiler-options '{"module":"commonjs"}' \
 *     scripts/report-billing-reconcile.ts
 *
 * Run on the server (no TypeScript toolchain there): bundle it, copy it over,
 * and let dotenv load DATABASE_URL and the Razorpay key from the backend's .env:
 *   node_modules/.bin/esbuild scripts/report-billing-reconcile.ts --bundle \
 *     --platform=node --format=cjs --external:@prisma/client \
 *     --outfile=/tmp/report-billing-reconcile.js
 *   scp /tmp/report-billing-reconcile.js server:/tmp/
 *   ssh server 'cd ~/hookpost && NODE_PATH=node_modules \
 *     DOTENV_CONFIG_PATH=.env node -r dotenv/config /tmp/report-billing-reconcile.js'
 */
import { PrismaClient } from '@prisma/client';
import {
  canStillCharge,
  cancelProvenAtRazorpay,
  chargeAtSeconds,
  chargeIsNear,
  planMismatch,
  preChargeVerdict,
} from '../libraries/nestjs-libraries/src/services/razorpay.mapping';

const BASE = 'https://api.razorpay.com/v1';
const iso = (sec: number) => (sec ? new Date(sec * 1000).toISOString() : '-');

function auth() {
  const id = process.env.RAZORPAY_KEY_ID || '';
  const secret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!id || !secret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.');
  }
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Razorpay GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Was a charge on this subscription refunded? The same two reads the service
 * makes (subscriptionRefunded): the invoices, then their payments.
 */
async function hasRefundedCharge(subscriptionId: string): Promise<boolean> {
  const invoices = await get(
    `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100`
  );
  const paymentIds: string[] = (invoices?.items || [])
    .map((inv: any) => inv?.payment_id)
    .filter(Boolean);
  for (const id of paymentIds) {
    const pay = await get(`/payments/${id}`).catch(() => null);
    const refunded = Number(pay?.amount_refunded || 0);
    const captured =
      pay?.captured === true || ['captured', 'refunded'].includes(pay?.status);
    if (Number(pay?.amount || 0) > 0 && captured && refunded > 0) return true;
  }
  return false;
}

/** Every subscription Hookpost's own checkout opened, newest first. */
async function listHookpostSubscriptions() {
  const items: any[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await get(`/subscriptions?count=100&skip=${page * 100}`);
    const batch: any[] = res?.items || [];
    items.push(...batch.filter((s) => s?.notes?.service === 'hookpost'));
    if (batch.length < 100) return items;
  }
  return items;
}

async function main() {
  const prisma = new PrismaClient();
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    const rows = (
      await prisma.subscription.findMany({
        where: {
          deletedAt: null,
          isLifetime: false,
          identifier: { startsWith: 'sub_' },
        },
        select: {
          organizationId: true,
          identifier: true,
          cancelAt: true,
          subscriptionTier: true,
          period: true,
          organization: { select: { deletedAt: true } },
        },
      })
    ).filter((r) => !!r.identifier);

    const ending = rows.filter((r) => r.cancelAt);
    console.log(`Billing reconcile report, read-only, ${now.toISOString()}`);
    console.log(
      `${rows.length} live Razorpay plan row(s); ${ending.length} with an end date on them.\n`
    );

    // --- what the guard would cancel at Razorpay ---
    const wouldCancel: string[] = [];
    const wouldEndRefunded: string[] = [];
    const waiting: string[] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      let remote: any = null;
      try {
        remote = await get(`/subscriptions/${row.identifier}`);
      } catch (e: any) {
        unreadable.push(`  ${row.identifier} (org ${row.organizationId}): ${e?.message || e}`);
        continue;
      }
      if (remote?.notes?.orgId !== row.organizationId) continue;
      const where =
        `  ${row.identifier} org ${row.organizationId} ${row.subscriptionTier}/${row.period} ` +
        `status=${remote.status} charge_at=${iso(chargeAtSeconds(remote))}`;

      if (row.organization?.deletedAt && canStillCharge(remote, nowSec)) {
        wouldCancel.push(`${where} -- the workspace was deleted`);
        continue;
      }

      // A plan with no end date: the only thing that ends it here is a refund
      // on a charge Razorpay is about to repeat.
      if (!row.cancelAt) {
        if (!canStillCharge(remote, nowSec) || !chargeIsNear(remote, nowSec)) {
          continue;
        }
        if (await hasRefundedCharge(row.identifier)) {
          wouldEndRefunded.push(`${where} -- a charge on it was refunded`);
        }
        continue;
      }

      const verdict = preChargeVerdict({
        subscription: remote,
        cancelAt: row.cancelAt,
        nowSec,
      });
      const line =
        `${where} ends_here=${row.cancelAt.toISOString()} ` +
        `proven_stopping=${cancelProvenAtRazorpay(remote)} -- ${verdict.reason}`;
      // Paid past the end saved here: only a refund says the row is right.
      if (verdict.recheck) {
        if (await hasRefundedCharge(row.identifier)) {
          wouldCancel.push(`${line}, and a charge on it was refunded`);
        } else {
          waiting.push(`${line}, so the grace sweep lifts the end date`);
        }
        continue;
      }
      if (verdict.cancel) wouldCancel.push(line);
      else if (canStillCharge(remote, nowSec)) waiting.push(line);
    }

    console.log(
      `Would cancel at Razorpay now (the plan is ending here and a charge is due): ${wouldCancel.length}`
    );
    wouldCancel.forEach((l) => console.log(l));
    console.log(
      `\nWould end now (refunded, still on, and about to be charged again): ${wouldEndRefunded.length}`
    );
    wouldEndRefunded.forEach((l) => console.log(l));
    console.log(
      `\nStill able to charge but not due yet, watched each hour: ${waiting.length}`
    );
    waiting.forEach((l) => console.log(l));
    if (unreadable.length) {
      console.log(`\nCould not be read at Razorpay (never acted on): ${unreadable.length}`);
      unreadable.forEach((l) => console.log(l));
    }

    // --- the other direction, reported only ---
    const byIdentifier = new Map(rows.map((r) => [String(r.identifier), r]));
    const mismatches: string[] = [];
    const goneWorkspaces: string[] = [];
    let listed = 0;
    try {
      const remotes = await listHookpostSubscriptions();
      listed = remotes.length;
      for (const remote of remotes) {
        const row = byIdentifier.get(String(remote.id)) || null;
        const kind = planMismatch({ subscription: remote, row, nowSec });
        if (!kind) continue;
        const orgId = String(remote.notes?.orgId || row?.organizationId || '');
        const line =
          `  ${remote.id} org ${orgId || '?'} status=${remote.status} ` +
          `charge_at=${iso(chargeAtSeconds(remote))}`;

        // The one disagreement in this direction the guard acts on: nobody is
        // left to hold the plan, so the mandate is cancelled.
        if (kind === 'charging_without_plan' && orgId) {
          const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { deletedAt: true },
          });
          if (!org || org.deletedAt) {
            goneWorkspaces.push(
              `${line} -- the workspace ${org ? 'was deleted' : 'no longer exists'}`
            );
            continue;
          }
        }
        mismatches.push(`${line} -- ${kind}`);
      }
    } catch (e: any) {
      console.log(`\nCould not list Razorpay subscriptions: ${e?.message || e}`);
    }
    console.log(
      `\nHookpost subscriptions at Razorpay: ${listed}.`
    );
    console.log(
      `Would cancel at Razorpay now (the workspace is gone): ${goneWorkspaces.length}`
    );
    goneWorkspaces.forEach((l) => console.log(l));
    console.log(
      `Disagreements to look at by hand (never cancelled automatically): ${mismatches.length}`
    );
    mismatches.forEach((l) => console.log(l));

    console.log('\nNothing was changed. This report only reads.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
