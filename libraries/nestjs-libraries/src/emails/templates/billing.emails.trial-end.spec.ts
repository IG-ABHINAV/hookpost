// The emails at the end of a cancelled trial (22 Oct 2026): "your access
// ends" while Reactivate still works, and "your workspace is paused" once
// it has run out. Templates only; when they are sent is in
// razorpay.trial-policy.spec.ts.
//   pnpm exec jest -c apps/backend/jest.config.ts billing.emails.trial-end

import {
  formatBillingDateTime,
  relativeDayLabel,
  subscriptionWelcomeEmail,
  trialAccessEndingEmail,
  workspacePausedEmail,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

const charge = { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod: 'upi' };

describe('relativeDayLabel: "tomorrow" only when it is, in India', () => {
  // 24 Oct 2026, 10:00 IST.
  const now = new Date('2026-10-24T04:30:00Z');

  it.each([
    ['later the same day', '2026-10-24T17:00:00Z', 'today'], // 22:30 IST
    ['the next day', '2026-10-25T12:00:00Z', 'tomorrow'],
    ['just after midnight IST', '2026-10-24T18:31:00Z', 'tomorrow'], // 00:01 IST on the 25th
    ['two days on', '2026-10-26T04:30:00Z', 'on 26 Oct 2026'],
  ])('%s', (_label, at, expected) => {
    expect(relativeDayLabel(new Date(at), now)).toBe(expected);
  });

  it('a date and a time, in India time', () => {
    expect(formatBillingDateTime(new Date('2026-10-25T12:00:00Z'))).toBe('25 Oct 2026, 5:30 pm IST');
  });
});

describe('trialAccessEndingEmail', () => {
  const now = new Date('2026-10-24T04:30:00Z');
  const accessUntil = new Date('2026-10-25T12:00:00Z'); // 25 Oct, 17:30 IST

  it('paused afterwards: access ends, the last moment Reactivate works, the amount and date kept', () => {
    const e = trialAccessEndingEmail({
      orgName: 'Chai <Point>',
      billing: 'STANDARD',
      accessUntil,
      charge,
      freePlanAvailable: false,
      now,
    });
    expect(e.subject).toBe('Your Hookpost access ends tomorrow: reactivate to keep it');
    expect(e.text).toContain('so nothing will be charged. It keeps working until 25 Oct 2026, 5:30 pm IST.');
    expect(e.text).toContain('After that your workspace is paused; your channels and posts are kept, and their media files for 30 days.');
    expect(e.text).toContain(
      'Reactivate from Billing by 24 Oct 2026, 5:30 pm IST: you approve UPI AutoPay or your card again and the first charge of ₹599/month stays on 25 Oct 2026.'
    );
    expect(e.html).toContain('/billing');
    expect(e.html).toContain('Chai &lt;Point&gt;');
    expect(e.html).not.toContain('Chai <Point>');
    expect(e.html + e.text).not.toMatch(/free plan|one tap|stripe/i);
  });

  it('a workspace that moves to the Free plan: the trial ends, not access', () => {
    const e = trialAccessEndingEmail({
      orgName: 'Chai Point',
      billing: 'PRO',
      accessUntil,
      charge: { ...charge, amount: 1999 },
      freePlanAvailable: true,
      now,
    });
    expect(e.subject).toBe('Your Hookpost Pro trial ends tomorrow: reactivate to keep it');
    expect(e.text).toContain('After that the workspace moves to the Free plan');
  });

  it('a dollar trial names no UPI; no amount when it could not be read', () => {
    const usd = trialAccessEndingEmail({
      orgName: 'Acme',
      billing: 'STANDARD',
      accessUntil,
      charge: { amount: 19, currency: 'USD', period: 'MONTHLY' },
      freePlanAvailable: false,
      now,
    });
    expect(usd.text).toContain('you approve your card again');
    expect(usd.text).toContain('$19/month');
    expect(usd.text).not.toMatch(/UPI|₹/);

    const none = trialAccessEndingEmail({
      orgName: 'Acme',
      billing: 'STANDARD',
      accessUntil,
      charge: null,
      freePlanAvailable: false,
      now,
    });
    expect(none.text).toContain('and the first charge stays on 25 Oct 2026.');
  });
});

describe('workspacePausedEmail', () => {
  it('paused, nothing charged, channels and posts kept, pick a plan that is charged now', () => {
    const e = workspacePausedEmail({
      orgName: 'Chai Point',
      billing: 'STANDARD',
      endedAt: new Date('2026-10-25T12:00:00Z'),
      charge,
    });
    expect(e.subject).toBe('Your Hookpost workspace is paused: pick a plan to continue');
    expect(e.text).toContain('ended on 25 Oct 2026.');
    // No charge claim: a debit started in the last 24 h before the end may still land.
    expect(e.text).not.toContain('nothing was charged');
    expect(e.text).toContain('Your workspace is paused; your channels and posts are kept, and their media files for 30 days. Choose a plan to keep everything. Nothing is published while it is paused.');
    expect(e.text).toContain('Pick a plan to continue: Standard is ₹599/month. Your trial has been used, so the plan you pick is charged when you pick it.');
    expect(e.html).toContain('/billing');
  });
});

describe('the welcome email on a trial', () => {
  it('without a length from Razorpay it says the TRIAL_DAYS default, 3 days', () => {
    const e = subscriptionWelcomeEmail({
      orgName: 'Chai Point',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
    });
    expect(e.text).toContain('Your 3-day free trial is now active');
    expect(e.text).not.toMatch(/7-day/);
  });
});
