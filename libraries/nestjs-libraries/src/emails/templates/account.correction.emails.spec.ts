import {
  accountCorrectionEmail,
  AccountCorrectionFacts,
  ACCOUNT_CORRECTION_EVENTS,
  chargeStoppedEmail,
  correctionBillingUrl,
  duplicateChargeRefundedEmail,
  planCorrectedEndedEmail,
  planRestoredEmail,
  refundEndedPlanEmail,
} from '@hookpost/nestjs-libraries/emails/templates/account.correction.emails';
import { EMAIL_LAYOUT_MARKER } from '@hookpost/nestjs-libraries/emails/layout/email.layout';

// The five "we got it wrong" emails: that each one renders, says the one
// thing it is for, links where it should, and never leaks anything internal.

const ORG = 'RK DEFENCE ACADEMY';
const ENDED = new Date('2026-10-29T11:04:00Z');

/** One of each, with the fields a real send would carry. */
const samples: AccountCorrectionFacts[] = [
  {
    event: 'PLAN_CORRECTED_ENDED',
    billing: 'STANDARD',
    endedAt: ENDED,
    neverCharged: true,
    endedOn: new Date('2026-10-21T06:00:00Z'),
    because: 'your trial was cancelled on 21 October',
  },
  {
    event: 'CHARGE_STOPPED',
    billing: 'STANDARD',
    accessUntil: null,
  },
  { event: 'PLAN_RESTORED', billing: 'PRO', restoredAt: ENDED },
  {
    event: 'DUPLICATE_CHARGE_REFUNDED',
    billing: 'PRO',
    amount: 1999,
    currency: 'INR',
    refundId: 'rfnd_TestRefund01',
    paymentId: 'pay_TestPayment01',
    refundedAt: ENDED,
  },
  {
    event: 'REFUND_ENDED_PLAN',
    billing: 'STANDARD',
    refundedOn: new Date('2026-10-11T06:00:00Z'),
    endedAt: ENDED,
    amount: 693,
    currency: 'INR',
  },
];

describe('account correction emails: every one renders', () => {
  it('covers every event in ACCOUNT_CORRECTION_EVENTS', () => {
    expect(samples.map((s) => s.event).sort()).toEqual(
      [...ACCOUNT_CORRECTION_EVENTS].sort()
    );
  });

  it.each(samples.map((s) => [s.event, s] as const))(
    '%s renders a subject, the layout and matching text',
    (_event, facts) => {
      const email = accountCorrectionEmail(facts, ORG);
      expect(email.subject.length).toBeGreaterThan(10);
      expect(email.subject.length).toBeLessThanOrEqual(90);
      expect(email.html).toContain(EMAIL_LAYOUT_MARKER);
      expect(email.html).toContain(ORG);
      expect(email.text).toContain(ORG);
      // The plain part is a real alternative, not an empty shell.
      expect(email.text.length).toBeGreaterThan(200);
      expect(email.html).not.toContain('undefined');
      expect(email.text).not.toContain('undefined');
      expect(email.html).not.toContain('[object Object]');
      // Nothing half-rendered: no template placeholder survives.
      expect(email.html).not.toMatch(/\{\{|\$\{/);
    }
  );

  it.each(samples.map((s) => [s.event, s] as const))(
    '%s says sorry and invites a reply',
    (_event, facts) => {
      const { text } = accountCorrectionEmail(facts, ORG);
      // CHARGE_STOPPED is the guard's own email (billing.emails.ts), sent
      // unchanged whoever stopped the charge; it owns no mistake to apologise for.
      if (facts.event !== 'CHARGE_STOPPED') expect(text.toLowerCase()).toContain('sorry');
      // Every one of them ends on a way to answer a person.
      expect(text.toLowerCase()).toMatch(/reply (to this email|with the refund id)/);
    }
  );

  it.each(samples.map((s) => [s.event, s] as const))(
    '%s carries no key, token or internal id',
    (_event, facts) => {
      const email = accountCorrectionEmail(facts, ORG);
      const all = `${email.subject}\n${email.html}\n${email.text}`;
      // Razorpay keys and secrets, Resend keys, and our own ids.
      expect(all).not.toMatch(/rzp_(live|test)_/);
      expect(all).not.toMatch(/\bre_[A-Za-z0-9]{10,}/);
      expect(all).not.toMatch(/sub_[A-Za-z0-9]{10,}/);
      expect(all).not.toMatch(/RESEND_API_KEY|DATABASE_URL|RAZORPAY_/);
      // Nothing about the workspace that the customer should not see.
      expect(all).not.toMatch(/organizationId|platformAdmin|isSuperAdmin/);
    }
  );

  it('escapes a workspace name that looks like markup', () => {
    const { html, text } = planCorrectedEndedEmail({
      orgName: '<script>alert(1)</script>',
      billing: 'STANDARD',
      endedAt: ENDED,
      neverCharged: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(text).toContain('<script>alert(1)</script>');
  });
});

describe('account correction emails: the links', () => {
  it('stamps the campaign so these visits are not read as ordinary billing traffic', () => {
    expect(correctionBillingUrl('PLAN_CORRECTED_ENDED')).toMatch(
      /\/billing\?utm_source=account_fix&utm_medium=email&utm_campaign=plan_corrected_ended$/
    );
  });

  it('sends a restored workspace to its calendar, not to billing', () => {
    const { html } = planRestoredEmail({
      orgName: ORG,
      billing: 'PRO',
      restoredAt: ENDED,
    });
    expect(html).toContain('/launches?utm_source=account_fix');
    expect(html).not.toContain('/billing?utm_source=account_fix');
  });

  it.each(samples.map((s) => [s.event, s] as const))(
    '%s links only to Hookpost',
    (_event, facts) => {
      const { html } = accountCorrectionEmail(facts, ORG);
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toMatch(/^(https?:\/\/[^/]*hookstep\.in|mailto:|https?:\/\/localhost)/);
      }
    }
  );
});

describe('PLAN_CORRECTED_ENDED', () => {
  it('says plainly that nothing was ever charged, when nothing was', () => {
    const { subject, text } = planCorrectedEndedEmail({
      orgName: ORG,
      billing: 'STANDARD',
      endedAt: ENDED,
      neverCharged: true,
      because: 'your trial was cancelled on 21 October',
    });
    expect(subject).toBe('Your Hookpost workspace: plan status corrected');
    expect(text).toContain('You were never charged');
    expect(text).toContain('your trial was cancelled on 21 October');
    expect(text).toContain('Choose a plan');
  });

  it('never promises "never charged" when we do not know that', () => {
    const { text } = planCorrectedEndedEmail({
      orgName: ORG,
      billing: 'STANDARD',
      endedAt: ENDED,
      neverCharged: false,
    });
    expect(text).not.toContain('never charged');
    expect(text).toContain('You will not be charged again');
  });

  it('keeps the customer their channels and posts', () => {
    const { text } = planCorrectedEndedEmail({
      orgName: ORG,
      endedAt: ENDED,
      neverCharged: true,
    });
    expect(text).toContain('connected channels');
    expect(text).toContain('saved');
  });
});

describe('CHARGE_STOPPED', () => {
  it('is the guard\'s own email, word for word: one template for a stopped charge', () => {
    const { chargeStoppedEmail: guard } = jest.requireActual('@hookpost/nestjs-libraries/emails/templates/billing.emails');
    const ours = chargeStoppedEmail({ orgName: ORG, billing: 'STANDARD', accessUntil: null });
    const theirs = guard({ orgName: ORG, billing: 'STANDARD', period: null, accessUntil: null });
    expect(ours.subject).toBe(theirs.subject);
    expect(ours.text).toBe(theirs.text);
  });
});

describe('PLAN_RESTORED', () => {
  it('owns the mistake and says no money moved', () => {
    const { subject, text } = planRestoredEmail({
      orgName: ORG,
      billing: 'PRO',
      restoredAt: ENDED,
      wasOffFor: 'from 21 to 29 October',
    });
    expect(subject).toBe('Your Hookpost Pro plan is back');
    expect(text).toContain('by mistake');
    expect(text).toContain('from 21 to 29 October');
    expect(text).toContain('not been charged anything extra');
    // A paused workspace publishes nothing, so the email must not pretend
    // the missed posts went out.
    expect(text).toContain('were not published');
  });
});

describe('DUPLICATE_CHARGE_REFUNDED', () => {
  it('names the money and leaves the plan alone', () => {
    const { subject, text } = duplicateChargeRefundedEmail({
      orgName: ORG,
      billing: 'PRO',
      amount: 1999,
      currency: 'INR',
      refundId: 'rfnd_TestRefund01',
      paymentId: 'pay_TestPayment01',
      refundedAt: ENDED,
      because: 'when you moved to Pro on 12 October',
    });
    expect(subject).toContain('₹1,999');
    expect(text).toContain('charged twice');
    expect(text).toContain('rfnd_TestRefund01');
    expect(text).toContain('when you moved to Pro on 12 October');
    expect(text).toContain('Your plan is unaffected');
  });

  it('shows dollars as dollars', () => {
    const { subject } = duplicateChargeRefundedEmail({
      orgName: ORG,
      amount: 19,
      currency: 'USD',
      refundId: 'rfnd_TestRefund02',
      refundedAt: ENDED,
    });
    expect(subject).toContain('$19');
    expect(subject).not.toContain('₹');
  });
});

describe('REFUND_ENDED_PLAN', () => {
  it('names the old refund and says the plan ends now, with no new money', () => {
    const { subject, text } = refundEndedPlanEmail({
      orgName: 'JR Consulting',
      billing: 'STANDARD',
      refundedOn: new Date('2026-10-11T06:00:00Z'),
      endedAt: ENDED,
      amount: 693,
      currency: 'INR',
    });
    expect(subject).toBe('Your Hookpost plan has ended after your refund');
    expect(text).toContain('11 Oct 2026');
    expect(text).toContain('₹693');
    expect(text).toContain('nothing more will be taken');
    expect(text).toContain('refund that too');
  });

  it('leaves the amount out when it is not known', () => {
    const { text } = refundEndedPlanEmail({
      orgName: 'JR Consulting',
      refundedOn: new Date('2026-10-11T06:00:00Z'),
      endedAt: ENDED,
    });
    expect(text).not.toContain('Amount refunded');
    expect(text).not.toContain('NaN');
  });
});
