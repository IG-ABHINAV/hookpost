/**
 * The evidence pack for a payment dispute (chargeback), and the deadline we
 * have to answer it by.
 *
 * Razorpay gives a merchant three business days at the chargeback stage to
 * contest a dispute, and a dispute nobody answers is lost automatically
 * (https://razorpay.com/docs/payments/disputes/chargeback-fees-and-penalties/).
 * The disputed amount is held back from our settlements the moment the
 * dispute opens and returned if we win. So the owner's alert has to say the
 * date, and the facts needed to answer have to be ready without digging:
 * RazorpayService.handleDispute builds this pack while the plan still
 * exists, stores it on the workspace (Organization.disputeEvidence), and
 * Admin offers it as a file (GET /admin/workspaces/:id/dispute/evidence).
 *
 * Nothing here states a fee or a penalty amount: those depend on the stage
 * the dispute reaches and the network, and quoting one would be wrong as
 * often as right.
 */
import { formatBillingDate } from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

/** Razorpay's window to contest a dispute at the chargeback stage. */
export const DISPUTE_RESPONSE_BUSINESS_DAYS = 3;

const HOOKPOST = 'https://hookpost.hookstep.in';

/** Our side of the story, the same links every time. */
export const DISPUTE_POLICY_LINKS = {
  terms: `${HOOKPOST}/terms`,
  refundPolicy: `${HOOKPOST}/refund-policy`,
  cancellationPolicy: `${HOOKPOST}/cancellation-policy`,
  privacy: `${HOOKPOST}/privacy`,
  support: 'support@hookstep.in',
};

/**
 * `days` business days after `from`, counting Monday to Friday and ignoring
 * public holidays (Razorpay counts its own, so this is the earliest the
 * deadline can be, never a later one we would relax to).
 */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    const day = out.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return out;
}

/**
 * When Razorpay wants our answer: its own `respond_by` when the webhook
 * carries one, else three business days after the dispute was raised. Null
 * only when the dispute has neither date, which its payload always has.
 */
export function disputeRespondBy(dispute: {
  respond_by?: number | string | null;
  created_at?: number | string | null;
}): Date | null {
  const respondBy = Number(dispute?.respond_by || 0);
  if (respondBy > 0) return new Date(respondBy * 1000);
  const created = Number(dispute?.created_at || 0);
  if (created > 0) {
    return addBusinessDays(
      new Date(created * 1000),
      DISPUTE_RESPONSE_BUSINESS_DAYS
    );
  }
  return null;
}

/**
 * The deadline line of the owner's alert. It always names the three business
 * days, because that is the rule being applied, and says where the date came
 * from when we had to work it out ourselves.
 */
export function respondByNote(dispute: {
  respond_by?: number | string | null;
  created_at?: number | string | null;
}): string {
  const by = disputeRespondBy(dispute);
  if (!by) {
    return `Respond within ${DISPUTE_RESPONSE_BUSINESS_DAYS} business days of the dispute being raised, or it is lost automatically. Razorpay sent no date: check the dispute in the dashboard.`;
  }
  const given = Number(dispute?.respond_by || 0) > 0;
  return `Respond within ${DISPUTE_RESPONSE_BUSINESS_DAYS} business days (by ${formatBillingDate(
    by
  )}${given ? '' : ', worked out from the date it was raised'}). A dispute nobody answers is lost automatically.`;
}

/**
 * Still waiting for our answer: Razorpay's `open` (and `action_required`,
 * the webhook named for it, before the status is read). Under review, won,
 * lost and closed need nothing from us.
 */
export function disputeAwaitsResponse(status: string | null | undefined): boolean {
  return status === 'open' || status === 'created' || status === 'action_required';
}

/** The deadline, short, for the owner alert's subject line. */
export function respondBySubject(dispute: {
  respond_by?: number | string | null;
  created_at?: number | string | null;
}): string {
  const by = disputeRespondBy(dispute);
  return `respond within ${DISPUTE_RESPONSE_BUSINESS_DAYS} business days${
    by ? ` (by ${formatBillingDate(by)})` : ''
  }`;
}

export interface DisputeEvidencePack {
  /** When handleDispute built it, ISO. */
  builtAt: string;
  dispute: {
    id: string;
    status: string | null;
    phase: string | null;
    reasonCode: string | null;
    /** Major units. */
    amount: number | null;
    currency: string | null;
    createdAt: string | null;
    respondBy: string | null;
  };
  payment: {
    id: string;
    method: string | null;
    international: boolean | null;
    bank: string | null;
    wallet: string | null;
    vpa: string | null;
    cardId: string | null;
    email: string | null;
    contact: string | null;
    amount: number | null;
    currency: string | null;
    createdAt: string | null;
    /** acquirer_data: the bank's own proof the customer authorised it. */
    acquirer: Record<string, string> | null;
  };
  workspace: {
    id: string;
    name: string | null;
    createdAt: string | null;
    ownerEmail: string | null;
    /** The owner's country at sign-up (User.signupCountry). */
    signupCountry: string | null;
    /** The country their IP was in when they first landed (SignupAttribution). */
    ipCountry: string | null;
    signupMethod: string | null;
    firstSeenAt: string | null;
  };
  /**
   * The plan the disputed payment bought, as it stood before the dispute
   * ended it. Null when the workspace had none left to read. `periodEnd` is
   * what a restore gives back (AdminController restoreWorkspacePlan).
   */
  plan: {
    tier: string | null;
    period: string | null;
    identifier: string | null;
    totalChannels: number | null;
    startedAt: string | null;
    periodEnd: string | null;
  } | null;
  /** What the workspace published with the plan it paid for: the service. */
  posts: {
    since: string | null;
    count: number;
    firstAt: string | null;
    lastAt: string | null;
    sample: { at: string; channel: string; url: string | null }[];
  };
  /** What we told them (Notifications: the in-app and emailed messages). */
  messages: { at: string; text: string }[];
  policies: typeof DISPUTE_POLICY_LINKS;
}

const iso = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

/** Razorpay's epoch seconds, as an ISO string. */
const epoch = (s: number | string | null | undefined) =>
  Number(s || 0) > 0 ? new Date(Number(s) * 1000).toISOString() : null;

/** Only the acquirer fields worth quoting: auth code, RRN, UPI reference. */
function acquirerFacts(data: any): Record<string, string> | null {
  if (!data || typeof data !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    out[key] = String(value).slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The pack, from Razorpay's dispute and payment entities and the workspace's
 * own rows (OrganizationService.getDisputeEvidenceFacts). Pure: every read
 * has already happened, so a missing piece is simply a null in the file
 * rather than a dispute we failed to record.
 */
export function buildDisputeEvidence(input: {
  dispute: any;
  payment: any;
  facts: {
    id: string;
    name?: string | null;
    createdAt?: Date | string | null;
    ownerEmail?: string | null;
    signupCountry?: string | null;
    ipCountry?: string | null;
    signupMethod?: string | null;
    firstSeenAt?: Date | string | null;
    posts: {
      since?: Date | string | null;
      count: number;
      firstAt?: Date | string | null;
      lastAt?: Date | string | null;
      sample: { at: Date | string; channel: string; url?: string | null }[];
    };
    messages: { at: Date | string; text: string }[];
  };
  plan?: {
    tier?: string | null;
    period?: string | null;
    identifier?: string | null;
    totalChannels?: number | null;
    startedAt?: Date | string | null;
    periodEnd?: Date | string | null;
  } | null;
  builtAt?: Date;
}): DisputeEvidencePack {
  const { dispute, payment, facts, plan } = input;
  const respondBy = disputeRespondBy(dispute || {});
  return {
    builtAt: (input.builtAt || new Date()).toISOString(),
    dispute: {
      id: String(dispute?.id || ''),
      status: dispute?.status ?? null,
      phase: dispute?.phase ?? null,
      reasonCode: dispute?.reason_code ?? null,
      amount: dispute?.amount != null ? Number(dispute.amount) / 100 : null,
      currency: dispute?.currency ?? null,
      createdAt: epoch(dispute?.created_at),
      respondBy: respondBy ? respondBy.toISOString() : null,
    },
    payment: {
      id: String(dispute?.payment_id || payment?.id || ''),
      method: payment?.method ?? null,
      international: payment?.international ?? null,
      bank: payment?.bank ?? null,
      wallet: payment?.wallet ?? null,
      vpa: payment?.vpa ?? null,
      cardId: payment?.card_id ?? null,
      email: payment?.email ?? null,
      contact: payment?.contact ?? null,
      amount: payment?.amount != null ? Number(payment.amount) / 100 : null,
      currency: payment?.currency ?? null,
      createdAt: epoch(payment?.created_at),
      acquirer: acquirerFacts(payment?.acquirer_data),
    },
    workspace: {
      id: facts.id,
      name: facts.name ?? null,
      createdAt: iso(facts.createdAt),
      ownerEmail: facts.ownerEmail ?? null,
      signupCountry: facts.signupCountry ?? null,
      ipCountry: facts.ipCountry ?? null,
      signupMethod: facts.signupMethod ?? null,
      firstSeenAt: iso(facts.firstSeenAt),
    },
    plan: plan
      ? {
          tier: plan.tier ?? null,
          period: plan.period ?? null,
          identifier: plan.identifier ?? null,
          totalChannels: plan.totalChannels ?? null,
          startedAt: iso(plan.startedAt),
          periodEnd: iso(plan.periodEnd),
        }
      : null,
    posts: {
      since: iso(facts.posts.since),
      count: facts.posts.count,
      firstAt: iso(facts.posts.firstAt),
      lastAt: iso(facts.posts.lastAt),
      sample: facts.posts.sample.map((p) => ({
        at: new Date(p.at).toISOString(),
        channel: p.channel,
        url: p.url ?? null,
      })),
    },
    messages: facts.messages.map((m) => ({
      at: new Date(m.at).toISOString(),
      text: m.text,
    })),
    policies: DISPUTE_POLICY_LINKS,
  };
}

const line = (label: string, value: unknown) =>
  `${label}: ${
    value === null || value === undefined || value === '' ? '-' : String(value)
  }`;

/** The pack as the file the owner downloads and can paste into Razorpay. */
export function renderDisputeEvidence(pack: DisputeEvidencePack): string {
  const money = (amount: number | null, currency: string | null) =>
    amount === null ? '-' : `${currency || 'INR'} ${amount}`;
  const out: string[] = [
    `Hookpost dispute evidence pack`,
    `Dispute ${pack.dispute.id} on payment ${pack.payment.id}`,
    `Built ${pack.builtAt}`,
    '',
    'DISPUTE',
    line('Status', pack.dispute.status),
    line('Phase', pack.dispute.phase),
    line('Reason code', pack.dispute.reasonCode),
    line('Amount', money(pack.dispute.amount, pack.dispute.currency)),
    line('Raised', pack.dispute.createdAt),
    line(
      `Respond by (${DISPUTE_RESPONSE_BUSINESS_DAYS} business days)`,
      pack.dispute.respondBy
    ),
    '',
    'PAYMENT',
    line('Payment id', pack.payment.id),
    line('Amount', money(pack.payment.amount, pack.payment.currency)),
    line('Paid', pack.payment.createdAt),
    line('Method', pack.payment.method),
    line('International', pack.payment.international),
    line('Bank', pack.payment.bank),
    line('Wallet', pack.payment.wallet),
    line('UPI VPA', pack.payment.vpa),
    line('Card', pack.payment.cardId),
    line('Email on the payment', pack.payment.email),
    line('Contact on the payment', pack.payment.contact),
  ];
  // The bank's own authorisation record (3DS auth code, RRN, UPI reference):
  // what proves the cardholder approved the charge.
  if (pack.payment.acquirer) {
    for (const [key, value] of Object.entries(pack.payment.acquirer)) {
      out.push(line(`Authorisation ${key}`, value));
    }
  } else {
    out.push(line('Authorisation', null));
  }

  out.push(
    '',
    'CUSTOMER',
    line('Workspace', `${pack.workspace.name || '-'} (${pack.workspace.id})`),
    line('Signed up', pack.workspace.createdAt),
    line('Account email', pack.workspace.ownerEmail),
    line('Sign-up country (declared)', pack.workspace.signupCountry),
    line('Sign-up country (IP)', pack.workspace.ipCountry),
    line('Signed up with', pack.workspace.signupMethod),
    line('First seen', pack.workspace.firstSeenAt),
    '',
    'PLAN PAID FOR'
  );
  if (pack.plan) {
    out.push(
      line('Tier', pack.plan.tier),
      line('Billing period', pack.plan.period),
      line('Razorpay subscription', pack.plan.identifier),
      line('Channels included', pack.plan.totalChannels),
      line('Started', pack.plan.startedAt),
      line('Paid until', pack.plan.periodEnd)
    );
  } else {
    out.push('No plan row was left to read when the dispute arrived.');
  }

  out.push(
    '',
    'SERVICE DELIVERED',
    line('Posts published in the paid period', pack.posts.count),
    line('Counted from', pack.posts.since),
    line('First published', pack.posts.firstAt),
    line('Last published', pack.posts.lastAt)
  );
  if (pack.posts.sample.length) {
    out.push('', 'Published posts (most recent first):');
    for (const p of pack.posts.sample) {
      out.push(`  ${p.at}  ${p.channel}${p.url ? `  ${p.url}` : ''}`);
    }
  }

  out.push('', 'WHAT WE SENT THEM');
  if (pack.messages.length) {
    for (const m of pack.messages) out.push(`  ${m.at}  ${m.text}`);
  } else {
    out.push('  No messages on file.');
  }

  out.push(
    '',
    'OUR TERMS',
    line('Terms of service', pack.policies.terms),
    line('Refund policy', pack.policies.refundPolicy),
    line('Cancellation policy', pack.policies.cancellationPolicy),
    line('Privacy policy', pack.policies.privacy),
    line('Support', pack.policies.support),
    ''
  );
  return out.join('\n');
}

/** What the downloaded file is called. */
export function disputeEvidenceFilename(pack: DisputeEvidencePack): string {
  const safe = (pack.dispute.id || pack.payment.id || 'dispute').replace(
    /[^A-Za-z0-9_-]/g,
    ''
  );
  return `hookpost-dispute-${safe}.txt`;
}
