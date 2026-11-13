/**
 * The first-month offer once per person: fills BillingIdentity from
 * Razorpay's history, and reports what the rule would have done.
 *
 * BillingIdentity rows are written by the webhooks from the offer-once
 * deploy on (RazorpayService.recordBillingIdentities). Everything paid
 * before that is only at Razorpay: this reads every subscription Hookpost's
 * checkout opened (notes.service = hookpost) that took at least one charge,
 * and for each one the same rows a webhook would have written: the
 * workspace, its owners' email identities (trial.policy.ts emailIdentity)
 * and the UPI VPA or card of every paid invoice (razorpay.mapping.ts
 * paymentMethodKeys), as OFFER when the subscription carried the offer,
 * else PAID.
 *
 * READ-ONLY unless --write. Without it, it writes nothing and prints:
 *   - the paid workspaces it found, and the rows it would write;
 *   - how many workspaces paying now would have been refused the offer by
 *     the rule (tied by an owner identity, a channel or a payment method to
 *     a workspace that paid before them), and how many of those actually
 *     got it.
 * With --write it inserts the rows (createMany skipDuplicates: running it
 * again writes nothing new). Apply billing-identity.migration.sql first.
 *
 * It prints workspace ids, subscription ids and counts, never a key, an
 * email, a VPA or a card.
 *
 * Run locally:
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/backfill-billing-identity.ts
 *
 * Run on the server (no TypeScript toolchain there), as
 * report-billing-reconcile.ts:
 *   node_modules/.bin/esbuild scripts/backfill-billing-identity.ts --bundle \
 *     --platform=node --format=cjs --external:@prisma/client \
 *     --outfile=/tmp/backfill-billing-identity.js
 *   scp /tmp/backfill-billing-identity.js server:/tmp/
 *   ssh server 'cd ~/hookpost && NODE_PATH=node_modules \
 *     DOTENV_CONFIG_PATH=.env node -r dotenv/config /tmp/backfill-billing-identity.js [--write]'
 */
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  billingIdentityHash,
  BillingIdentityKind,
  paymentMethodKeys,
} from '../libraries/nestjs-libraries/src/services/razorpay.mapping';
import { emailIdentity } from '../libraries/nestjs-libraries/src/database/prisma/subscriptions/trial.policy';

const BASE = 'https://api.razorpay.com/v1';

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

/** Every subscription Hookpost's own checkout opened that took a charge. */
async function paidHookpostSubscriptions() {
  const items: any[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await get(`/subscriptions?count=100&skip=${page * 100}`);
    const batch: any[] = res?.items || [];
    items.push(
      ...batch.filter(
        (s) => s?.notes?.service === 'hookpost' && s?.notes?.orgId && Number(s.paid_count) > 0
      )
    );
    if (batch.length < 100) return items;
  }
  return items;
}

/** The captured payments of a subscription's paid invoices, oldest first. */
async function paymentsOf(subscriptionId: string) {
  const invoices = await get(
    `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100`
  );
  const out: any[] = [];
  for (const inv of invoices?.items || []) {
    if (!inv?.payment_id) continue;
    const pay = await get(`/payments/${inv.payment_id}?expand[]=card`).catch(() => null);
    const captured = pay?.captured === true || ['captured', 'refunded'].includes(pay?.status);
    if (pay && captured && Number(pay.amount) > 0) out.push(pay);
  }
  return out.sort((a, b) => Number(a.created_at) - Number(b.created_at));
}

type Row = {
  organizationId: string;
  kind: BillingIdentityKind;
  hash: string;
  source: 'PAID' | 'OFFER';
  subscriptionId: string;
  paymentId: string | null;
};

/** A channel as an account, whatever form a removed one keeps its id in. */
function channelKeys(providerIdentifier: string, internalId: string): string[] {
  const m = internalId.match(/^deleted_(.+)_[^_]+$/);
  const root = m ? m[1] : internalId;
  const md5 = /^[0-9a-f]{32}$/.test(root) ? root : createHash('md5').update(root).digest('hex');
  return [`${providerIdentifier}:${md5}`];
}

async function main() {
  const write = process.argv.includes('--write');
  const prisma = new PrismaClient();
  try {
    const subs = await paidHookpostSubscriptions();
    const orgIds = [...new Set(subs.map((s) => String(s.notes.orgId)))];
    const orgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: {
        id: true,
        source: true,
        users: {
          where: { role: 'SUPERADMIN' },
          select: { user: { select: { email: true, isSuperAdmin: true } } },
        },
        Integration: { select: { providerIdentifier: true, internalId: true } },
        subscription: { select: { isLifetime: true, identifier: true, deletedAt: true } },
      },
    });
    const byId = new Map(orgs.map((o) => [o.id, o]));

    const rows: Row[] = [];
    // When each workspace first paid, and what ties it to a person.
    const firstPaid = new Map<string, number>();
    const ties = new Map<string, Set<string>>();
    const tie = (orgId: string, key: string) => {
      if (!ties.has(orgId)) ties.set(orgId, new Set());
      ties.get(orgId)!.add(key);
    };
    let offers = 0;
    for (const sub of subs) {
      const orgId = String(sub.notes.orgId);
      const org = byId.get(orgId);
      if (!org) continue; // a workspace removed from the database outright
      const source: Row['source'] = sub.offer_id ? 'OFFER' : 'PAID';
      if (source === 'OFFER') offers++;
      const payments = await paymentsOf(sub.id);
      const at = Number(payments[0]?.created_at || sub.start_at || sub.created_at || 0);
      firstPaid.set(orgId, Math.min(firstPaid.get(orgId) ?? Infinity, at));

      const values: Array<{ kind: BillingIdentityKind; value: string; paymentId: string | null }> = [
        { kind: 'WORKSPACE', value: orgId, paymentId: null },
      ];
      for (const m of org.users) {
        const identity = emailIdentity(m.user.email);
        if (identity) {
          values.push({ kind: 'EMAIL', value: identity, paymentId: null });
          tie(orgId, `EMAIL:${identity}`);
        }
      }
      for (const pay of payments) {
        for (const k of paymentMethodKeys(pay)) {
          values.push({ kind: k.kind, value: k.value, paymentId: String(pay.id) });
          tie(orgId, `${k.kind}:${k.value}`);
        }
      }
      for (const ch of org.Integration) {
        if (ch.providerIdentifier && ch.internalId) {
          channelKeys(ch.providerIdentifier, ch.internalId).forEach((k) => tie(orgId, `CHANNEL:${k}`));
        }
      }
      for (const v of values) {
        rows.push({
          organizationId: orgId,
          kind: v.kind,
          hash: billingIdentityHash(v.kind, v.value),
          source,
          subscriptionId: sub.id,
          paymentId: v.paymentId,
        });
      }
    }
    const unique = new Map(rows.map((r) => [`${r.organizationId}|${r.kind}|${r.hash}|${r.source}`, r]));

    console.log(`Billing identity backfill, ${write ? 'WRITING' : 'read-only'}, ${new Date().toISOString()}`);
    console.log(
      `${subs.length} paid Hookpost subscription(s) in ${firstPaid.size} workspace(s); ${offers} carried the first-month offer.`
    );
    const kinds = [...unique.values()].reduce<Record<string, number>>((acc, r) => {
      acc[r.kind] = (acc[r.kind] || 0) + 1;
      return acc;
    }, {});
    console.log(`Rows: ${unique.size} (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}).\n`);

    // Which workspaces paying now the rule would have refused: tied to one
    // that paid before them. Our own and marketplace workspaces never count.
    const outside = (id: string) => {
      const o = byId.get(id);
      return !o || o.source !== 'DIRECT' || o.users.some((m) => m.user.isSuperAdmin);
    };
    const payingNow = orgs.filter(
      (o) =>
        o.subscription &&
        !o.subscription.deletedAt &&
        !o.subscription.isLifetime &&
        o.subscription.identifier?.startsWith('sub_') &&
        !outside(o.id)
    );
    const refused: string[] = [];
    const refusedButGotIt: string[] = [];
    for (const o of payingNow) {
      const mine = ties.get(o.id) || new Set<string>();
      const earlier = [...firstPaid.entries()].filter(
        ([other, at]) => other !== o.id && !outside(other) && at < (firstPaid.get(o.id) ?? Infinity)
      );
      const tiedTo = earlier.filter(([other]) => [...(ties.get(other) || [])].some((k) => mine.has(k)));
      if (!tiedTo.length) continue;
      refused.push(`  ${o.id}: tied to ${tiedTo.map(([id]) => id).join(', ')}`);
      if (subs.some((s) => s.notes.orgId === o.id && s.offer_id)) refusedButGotIt.push(o.id);
    }
    console.log(
      `${payingNow.length} workspace(s) pay now. The rule would have refused the offer to ${refused.length}; ${refusedButGotIt.length} of those got it.`
    );
    refused.forEach((line) => console.log(line));

    if (!write) {
      console.log('\nRead-only: nothing written. Run again with --write to insert the rows.');
      return;
    }
    const created = await prisma.billingIdentity.createMany({
      data: [...unique.values()],
      skipDuplicates: true,
    });
    console.log(`\nWrote ${created.count} new row(s); ${unique.size - created.count} were already on file.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
