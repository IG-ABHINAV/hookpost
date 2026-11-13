/**
 * The owner and support-inbox alerts: every owner sale alert renders in the
 * shared branded template (logo, headline, summary, facts, a button to the
 * admin record, a plain-text part), with no bracket tags in the subject, and
 * "Test mode" appears only for fake money.
 */
import {
  adminAlertEmail,
  cancelNoteEmail,
} from './admin.alert.email';
import {
  OWNER_ACTION_EVENTS,
  OWNER_SALE_EVENT_LABELS,
  OwnerSaleAlert,
  OwnerSaleContext,
  OwnerSaleEvent,
  ownerAlertMode,
  ownerSaleAlertEmail,
} from './owner.sales.alert.email';
import { razorpayKeyTestReason } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import { EMAIL_BRAND, isRenderedEmail } from '@hookpost/nestjs-libraries/emails/layout/email.layout';

const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
beforeEach(() => {
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
});
afterAll(() => {
  if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
});

const ORG = 'org-sample-0001';

const ctx: OwnerSaleContext = {
  orgName: 'Chai Point Social',
  orgCreatedAt: new Date('2026-10-20T10:00:00Z'),
  customerName: 'Priya Shah',
  customerEmail: 'priya@chaipoint.in',
  signupCountry: 'IN',
  attribution: { utmSource: 'meta', utmCampaign: 'reel-oct', method: 'google' },
};

function alertFor(event: OwnerSaleEvent): OwnerSaleAlert {
  const gumroad = event.startsWith('GUMROAD');
  return {
    event,
    key: `sample:${event}`,
    source: gumroad ? 'gumroad' : 'razorpay',
    organizationId: ORG,
    tier: event === 'PLAN_CHANGED' ? 'PRO' : 'STANDARD',
    period: 'MONTHLY',
    previousTier: event === 'PLAN_CHANGED' ? 'STANDARD' : null,
    previousPeriod: event === 'PLAN_CHANGED' ? 'MONTHLY' : null,
    amount: gumroad ? 29 : 599,
    currency: gumroad ? 'USD' : 'INR',
    paymentMethod: gumroad ? null : 'upi',
    ids: gumroad
      ? { sale: 'sale_sample', license: 'lic_sample' }
      : {
          subscription: 'sub_sample',
          payment: 'pay_sample',
          ...(event === 'DISPUTE' ? { dispute: 'disp_sample' } : {}),
          ...(event === 'REFUND' ? { refund: 'rfnd_sample' } : {}),
        },
    notes: ['A note written by Hookpost'],
  };
}

const EVENTS = Object.keys(OWNER_SALE_EVENT_LABELS) as OwnerSaleEvent[];

describe('every owner sale alert renders in the branded template', () => {
  it.each(EVENTS)('%s', (event) => {
    const m = ownerSaleAlertEmail(alertFor(event), ctx);

    // Subject: event first, no [Hookpost]/[TEST]/[INTERNAL] tags.
    expect(m.subject.startsWith(OWNER_SALE_EVENT_LABELS[event])).toBe(true);
    expect(m.subject).not.toMatch(/[[\]]/);
    expect(m.subject).toContain('· Priya Shah');

    // HTML: the shared layout with the logo, a headline and the admin button.
    expect(isRenderedEmail(m.html)).toBe(true);
    expect(m.html).toContain(EMAIL_BRAND.logoUrl);
    expect(m.html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(m.html).toContain(`data-hp-button href="https://hookpost.hookstep.in/admin/users?q=${ORG}"`);
    expect(m.html).toContain('data-hp-label');
    expect(m.html).not.toMatch(/Test mode|Internal workspace/);
    expect(m.html.includes('Needs a look')).toBe(OWNER_ACTION_EVENTS.has(event));

    // Plain text: readable on its own, no markup.
    expect(m.text).not.toMatch(/<[a-z][^>]*>/i);
    expect(m.text).toContain(`Open in admin: https://hookpost.hookstep.in/admin/users?q=${ORG}`);
    expect(m.text).toContain('- A note written by Hookpost');
    expect(m.text.endsWith('\n')).toBe(true);

    expect({ subject: m.subject, text: m.text }).toMatchSnapshot();
  });

  it('the HTML of one alert (renewal paused)', () => {
    expect(ownerSaleAlertEmail(alertFor('HALTED'), ctx).html).toMatchSnapshot();
  });

  it('renewal paused reads the way the owner asked', () => {
    const m = ownerSaleAlertEmail(alertFor('HALTED'), ctx);
    expect(m.subject).toBe('Renewal paused: Standard monthly, ₹599 · Priya Shah');
    expect(m.text).toContain(
      "Razorpay stopped retrying Priya Shah's renewal, so the renewal is paused."
    );
  });

  it('without a workspace the Razorpay page is the button', () => {
    const m = ownerSaleAlertEmail({ ...alertFor('GUARD_CANCELLED'), organizationId: null }, {});
    expect(m.html).toContain(
      'data-hp-button href="https://dashboard.razorpay.com/app/subscriptions/sub_sample"'
    );
    expect(m.text).toContain('The pre-charge guard cancelled this subscription');
  });
});

describe('test / live labelling', () => {
  it('ownerAlertMode: test only for fake money, internal never shown as test', () => {
    expect(ownerAlertMode({})).toBe('live');
    expect(ownerAlertMode({ internal: true })).toBe('internal');
    expect(ownerAlertMode({ testReason: 'Razorpay test key' })).toBe('test');
    expect(ownerAlertMode({ testReason: 'Razorpay test key', internal: true })).toBe('test');
    expect(ownerAlertMode({ testReason: '   ' })).toBe('live');
  });

  it('razorpayKeyTestReason: only a rzp_live_ key is live', () => {
    expect(razorpayKeyTestReason({ RAZORPAY_KEY_ID: 'rzp_live_ABC' } as any)).toBeNull();
    expect(razorpayKeyTestReason({ RAZORPAY_KEY_ID: 'rzp_test_ABC' } as any)).toBe('Razorpay test key');
    expect(razorpayKeyTestReason({} as any)).toBe('Razorpay test key');
  });

  it('a live event carries no test wording anywhere; a test event has the badge and a clean subject', () => {
    const live = ownerSaleAlertEmail(alertFor('FIRST_CHARGE'), ctx);
    expect(`${live.subject}${live.html}${live.text}`).not.toMatch(/test/i);

    const test = ownerSaleAlertEmail(alertFor('FIRST_CHARGE'), {
      ...ctx,
      testReason: 'Razorpay test key',
    });
    expect(test.subject).toBe(live.subject);
    expect(test.html).toMatch(/data-hp-badge[^>]*>Test mode<\/span>/);
    expect(test.text.split('\n')[1]).toBe('Test mode: Razorpay test key');

    const internal = ownerSaleAlertEmail(alertFor('FIRST_CHARGE'), { ...ctx, internal: true });
    expect(internal.subject).toBe(live.subject);
    expect(internal.html).toMatch(/data-hp-badge[^>]*>Internal workspace<\/span>/);
    expect(`${internal.html}${internal.text}`).not.toMatch(/test mode/i);
  });
});

describe('support-inbox notes', () => {
  const HOSTILE = `<img src=x onerror="alert(1)">`;

  it('cancel note: reason quoted and escaped, button to admin', () => {
    const m = cancelNoteEmail({
      orgName: `Acme ${HOSTILE}`,
      orgId: ORG,
      customerEmail: 'a@b.in',
      feedback: `Too pricey\n${HOSTILE}`,
    });
    expect(m.subject).toBe('Cancellation requested · Acme <img src=x onerror="alert(1)">');
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).toContain('Too pricey<br />&lt;img');
    expect(m.text).toContain('Their reason:');
    expect(m.text).toContain(`Open in admin: https://hookpost.hookstep.in/admin/users?q=${ORG}`);
    expect(cancelNoteEmail({ orgId: ORG }).text).toContain('(no reason given)');
  });

  it('only http(s) and mailto links are kept', () => {
    const m = adminAlertEmail({
      subject: 's',
      headline: 'h',
      summary: 'x',
      facts: [{ label: 'L', value: 'v', href: 'javascript:alert(1)' }],
      primary: { label: 'Go', url: 'javascript:alert(1)' },
      reason: 'r',
    });
    expect(m.html).not.toContain('javascript:');
    expect(m.html).not.toContain('data-hp-button');
  });
});
