// The trial policy (trial.policy.ts): which workspaces must start the 3-day
// trial before using Hookpost, read from TRIAL_REQUIRED_SINCE_IN and
// TRIAL_REQUIRED_SINCE_GLOBAL. Pure, so every case runs on plain objects.
//   pnpm exec jest -c apps/backend/jest.config.ts trial.policy

import {
  allowsVariableCostFeatures,
  allowsAiFeatures,
  allowsXPublishing,
  blocksPlanUse,
  checkoutAllowsTrial,
  trialCheckoutOn,
  FREE_POST_LIMIT,
  freePostAllowed,
  freePostKey,
  freePostsUsed,
  freePostsLeft,
  PLAN_GATE_MESSAGES,
  planGateMessage,
  preTrialChannelLimit,
  describeTrialPolicy,
  excludedCountries,
  freePlanAvailable,
  freePlanEndDateLabel,
  freePlanEndsAt,
  freePlanSunsetAt,
  freePlanSunsetPassed,
  inTrialCohort,
  needsTrial,
  orgCountry,
  parseTrialCutoff,
  planGateCode,
  planLapsed,
  planSource,
  planState,
  PolicyOrg,
  resetTrialPolicyWarnings,
  TRIAL_CUTOFF_FLOOR,
  trialCutoffs,
  trialPolicyActive,
  usdRailLive,
  emailIdentity,
  reusedChannelMessage,
  freePostsLeftElsewhereMessage,
  workspaceDisputed,
  policyOrgFromFacts,
  DISPUTE_CHECKOUT_MESSAGE,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { usdOnForEveryone } from '@hookpost/nestjs-libraries/services/billing.currency';

const CUTOFF = '2026-10-20T00:00:00Z';
// FREE_PLAN_SUNSET_AT as planned: 27 Oct 23:59:59 IST.
const SUNSET = '2026-10-27T18:29:59Z';
const BEFORE = new Date('2026-10-19T12:00:00Z'); // a grandfathered workspace
const AFTER = new Date('2026-10-21T09:00:00Z'); // a new signup

// The GLOBAL cutoff only counts while the dollar checkout sells (usdRailLive),
// so a GLOBAL value comes with USD_CHECKOUT=on and an LUT here unless a test
// says otherwise.
const USD_ON = { USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0910260000000' };
const env = (IN?: string, GLOBAL?: string, usd: Record<string, string> = USD_ON) => ({
  TRIAL_REQUIRED_SINCE_IN: IN,
  TRIAL_REQUIRED_SINCE_GLOBAL: GLOBAL,
  ...usd,
});

const quiet = () => jest.fn();

beforeEach(() => resetTrialPolicyWarnings());

describe('parseTrialCutoff: only a strict UTC timestamp on or after the floor counts', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('%s is unset, silently', (_label, raw) => {
    const log = quiet();
    expect(parseTrialCutoff('TRIAL_REQUIRED_SINCE_IN', raw as any, log)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['a month that does not exist', '2026-13-01'],
    ['a date with no time', '2026-10-20'],
    ['a day that does not exist (Date would roll it to 2 Mar)', '2026-02-30T00:00:00Z'],
    ['no timezone (local time is ambiguous)', '2026-10-20T05:30:00'],
    ['a timezone that is not UTC', '2026-10-20T05:30:00+05:30'],
    ['a typo', 'typo'],
    ['a unix timestamp', '1792540800'],
  ])('%s is unset, and logged', (_label, raw) => {
    const log = quiet();
    expect(parseTrialCutoff('TRIAL_REQUIRED_SINCE_IN', raw, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('treating it as unset');
  });

  it('before the floor (2026-01-01 for 2026-11-01) is unset, and logged', () => {
    const log = quiet();
    expect(parseTrialCutoff('TRIAL_REQUIRED_SINCE_IN', '2026-01-01T00:00:00Z', log)).toBeNull();
    expect(log.mock.calls[0][0]).toContain(TRIAL_CUTOFF_FLOOR.toISOString());
  });

  it.each([
    ['Z', '2026-10-20T05:30:00Z', '2026-10-20T05:30:00.000Z'],
    ['milliseconds', '2026-10-20T05:30:00.250Z', '2026-10-20T05:30:00.250Z'],
    ['no seconds', '2026-10-20T05:30Z', '2026-10-20T05:30:00.000Z'],
    ['+00:00', '2026-10-20T05:30:00+00:00', '2026-10-20T05:30:00.000Z'],
    ['the floor itself', '2026-10-19T00:00:00Z', '2026-10-19T00:00:00.000Z'],
    ['a future date', '2027-03-01T00:00:00Z', '2027-03-01T00:00:00.000Z'],
  ])('%s is accepted', (_label, raw, iso) => {
    const log = quiet();
    expect(parseTrialCutoff('X', raw, log)?.toISOString()).toBe(iso);
    expect(log).not.toHaveBeenCalled();
  });

  it('a bad value is logged once, not on every permission check', () => {
    const log = quiet();
    for (let i = 0; i < 5; i++) trialCutoffs(env('2026-13-01'), log);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('orgCountry', () => {
  it('the owner’s signup country wins over everything else', () => {
    expect(orgCountry({ ownerCountry: 'in', requestCountry: 'US', tz: 'America/New_York' })).toBe('IN');
  });
  it('then the request’s trusted country', () => {
    expect(orgCountry({ ownerCountry: null, requestCountry: 'US' })).toBe('US');
  });
  it('then an India-only timezone', () => {
    expect(orgCountry({ tz: 'Asia/Kolkata' })).toBe('IN');
    expect(orgCountry({ tz: 'Asia/Calcutta' })).toBe('IN');
    expect(orgCountry({ tz: 'Asia/Colombo' })).toBeNull();
  });
  it('Cloudflare’s XX and T1 and junk mean unknown', () => {
    expect(orgCountry({ ownerCountry: 'XX', requestCountry: 'T1' })).toBeNull();
    expect(orgCountry({ ownerCountry: 'India' })).toBeNull();
  });
});

const org = (over: Partial<PolicyOrg> = {}): PolicyOrg => ({
  createdAt: AFTER,
  allowTrial: true,
  isTrailing: true,
  subscription: null,
  ownerCountry: 'IN',
  ...over,
});

const ROW = { isLifetime: false, cancelAt: null, deletedAt: null };
const LIFETIME = { isLifetime: true, cancelAt: null, deletedAt: null };
/**
 * A plan set to end, as production holds one: the date is still ahead. Once
 * it passes the plan is over for every gate, whether or not the hourly sweep
 * has deleted the row yet (planLapsed); ENDED below is that same plan an hour
 * later.
 */
const SET_TO_END = { ...ROW, cancelAt: new Date(Date.now() + 7 * 86_400_000) };
const ENDED = { ...ROW, cancelAt: new Date(Date.now() - 60_000) };

describe('the cutoff matrix', () => {
  // [cutoff env, country, createdAt, plan] -> planState
  const cases: Array<[string, Record<string, string | undefined>, string | null, Date, any, string]> = [
    // Unset, empty, invalid, before the floor: nobody is in the new cohort.
    ['unset', env(), 'IN', AFTER, null, 'free'],
    ['empty', env('', ''), 'IN', AFTER, null, 'free'],
    ['invalid IN', env('2026-13-01'), 'IN', AFTER, null, 'free'],
    ['before the floor', env('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), 'US', AFTER, null, 'free'],
    // IN set: India-first. Only Indian signups after the cutoff.
    ['IN set, IN, after', env(CUTOFF), 'IN', AFTER, null, 'free_posts'],
    ['IN set, IN, before', env(CUTOFF), 'IN', BEFORE, null, 'free'],
    ['IN set, US, after', env(CUTOFF), 'US', AFTER, null, 'free'],
    ['IN set, unknown, after', env(CUTOFF), null, AFTER, null, 'free'],
    ['IN set in the future', env('2027-01-01T00:00:00Z'), 'IN', AFTER, null, 'free'],
    // GLOBAL set: everyone not in India, unknown included.
    ['GLOBAL set, US, after', env(undefined, CUTOFF), 'US', AFTER, null, 'free_posts'],
    ['GLOBAL set, unknown, after', env(undefined, CUTOFF), null, AFTER, null, 'free_posts'],
    ['GLOBAL set, IN, after', env(undefined, CUTOFF), 'IN', AFTER, null, 'free'],
    ['GLOBAL set, US, before', env(undefined, CUTOFF), 'US', BEFORE, null, 'free'],
    // A plan on file is never needs_trial, whatever the cutoff.
    ['IN set, IN, after, trial row', env(CUTOFF), 'IN', AFTER, ROW, 'trialing'],
    ['IN set, IN, after, lifetime', env(CUTOFF), 'IN', AFTER, LIFETIME, 'active'],
    ['unset, lifetime', env(), 'US', BEFORE, LIFETIME, 'active'],
    // A soft-deleted row is no plan.
    ['IN set, IN, after, deleted row', env(CUTOFF), 'IN', AFTER, { ...ROW, deletedAt: new Date() }, 'free_posts'],
  ];

  it.each(cases)('%s', (_label, e, country, createdAt, subscription, expected) => {
    const cutoffs = trialCutoffs(e, quiet());
    expect(
      planState(org({ ownerCountry: country, createdAt, subscription }), cutoffs)
    ).toBe(expected);
  });

  it('an unreadable createdAt cannot put a workspace in the cohort', () => {
    const cutoffs = trialCutoffs(env(CUTOFF, CUTOFF), quiet());
    expect(inTrialCohort(org({ createdAt: 'not a date' }), cutoffs)).toBe(false);
  });

  it('exactly at the cutoff is in the cohort', () => {
    const cutoffs = trialCutoffs(env(CUTOFF), quiet());
    expect(needsTrial(org({ createdAt: new Date(CUTOFF) }), cutoffs)).toBe(true);
  });
});

describe('planState for a workspace with a plan, and the trial flag', () => {
  const cutoffs = trialCutoffs(env(CUTOFF), quiet());

  it('a used trial and no plan in the cohort is locked, not needs_trial', () => {
    expect(planState(org({ allowTrial: false }), cutoffs)).toBe('locked');
  });
  it('a paid plan is active, a trial is trialing, one set to end is cancelling', () => {
    expect(planState(org({ isTrailing: false, subscription: ROW }), cutoffs)).toBe('active');
    expect(planState(org({ isTrailing: true, subscription: ROW }), cutoffs)).toBe('trialing');
    expect(planState(org({ subscription: SET_TO_END }), cutoffs)).toBe('cancelling');
  });
  it('a plan whose cancelAt has passed is over, before the sweep deletes its row', () => {
    // The hourly sweep (RazorpayService.endLapsedCancellations) is what
    // deletes the row. Until it runs the row is still on file, and reading
    // only that gave the workspace up to an hour of plan it no longer had.
    expect(planState(org({ allowTrial: false, subscription: ENDED }), cutoffs)).toBe('locked');
    // The same answer the sweep leaves behind, so nothing changes when it runs.
    expect(planState(org({ allowTrial: false, subscription: null }), cutoffs)).toBe('locked');
    // A grandfathered workspace falls back to Free, again as after the sweep.
    const old = { createdAt: BEFORE, allowTrial: false };
    expect(planState(org({ ...old, subscription: ENDED }), cutoffs)).toBe('free');
    expect(planState(org({ ...old, subscription: null }), cutoffs)).toBe('free');
  });

  it('a paid one-time month is a plan until its end, then the free-posts state (8 Nov 2026)', () => {
    const PAID = { identifier: 'order_A', cancelAt: new Date(Date.now() + 86_400_000) };
    const RAN_OUT = { identifier: 'order_A', cancelAt: new Date(Date.now() - 60_000) };
    expect(planSource(PAID)).toBe('order');
    // Paid up to cancelAt: everything it bought stays on, AI and X included.
    const paid = org({ isTrailing: false, allowTrial: false, subscription: PAID });
    expect(planState(paid, cutoffs)).toBe('cancelling');
    expect(allowsVariableCostFeatures('cancelling', paid)).toBe(true);
    expect(allowsXPublishing(paid, cutoffs)).toBe(true);
    // Over the second it ends, before the sweep: free posts, not locked.
    expect(planLapsed(RAN_OUT)).toBe(true);
    expect(planState(org({ allowTrial: false, subscription: RAN_OUT }), cutoffs)).toBe('free_posts');
    // After the sweep (row gone, allowTrial given back): the same state.
    expect(planState(org({ allowTrial: true, subscription: null }), cutoffs)).toBe('free_posts');
    // Any other ended plan is still locked, as before.
    expect(planState(org({ allowTrial: false, subscription: ENDED }), cutoffs)).toBe('locked');
    // A chargeback still locks it.
    expect(
      planState(org({ allowTrial: false, subscription: RAN_OUT, disputedAt: new Date() }), cutoffs)
    ).toBe('locked');
  });

  it('planLapsed: only a real end date that has passed, never a lifetime plan', () => {
    const now = new Date('2026-10-29T14:30:00Z');
    expect(planLapsed({ ...ROW, cancelAt: new Date('2026-10-29T14:29:00Z') }, now)).toBe(true);
    // The moment itself counts as ended: the 14:30 plan does not cover 14:30.
    expect(planLapsed({ ...ROW, cancelAt: now }, now)).toBe(true);
    expect(planLapsed({ ...ROW, cancelAt: new Date('2026-10-29T14:31:00Z') }, now)).toBe(false);
    // No date, no plan, a soft-deleted row: nothing to end here.
    expect(planLapsed(ROW, now)).toBe(false);
    expect(planLapsed(null, now)).toBe(false);
    expect(planLapsed({ ...ENDED, deletedAt: new Date() }, now)).toBe(false);
    // A lifetime plan is never swept (getLapsedCancellations skips it), so an
    // odd date on one must not take it away.
    expect(planLapsed({ ...LIFETIME, cancelAt: new Date('2020-01-01T00:00:00Z') }, now)).toBe(false);
    expect(
      planState(org({ subscription: { ...LIFETIME, cancelAt: new Date('2020-01-01T00:00:00Z') } }), cutoffs)
    ).toBe('active');
    // An unreadable date proves nothing: fail open, as everywhere else here.
    expect(planLapsed({ ...ROW, cancelAt: 'not a date' }, now)).toBe(false);
  });

  it('planLapsed: only a Razorpay plan, the one the hourly sweep ends', () => {
    // getLapsedCancellations reads only `sub_` rows. A Gumroad plan past its
    // cancelAt is the Gumroad sweep's to judge: the buyer may have
    // resubscribed there, and that sweep then lifts the date. Ending it here
    // would lock a paying Gumroad customer until that sweep runs.
    const now = new Date('2026-10-29T14:30:00Z');
    const past = new Date('2026-10-29T14:29:00Z');
    const c = { ...cutoffs, now };
    expect(planLapsed({ ...ROW, identifier: 'sub_abc', cancelAt: past }, now)).toBe(true);
    expect(planLapsed({ ...ROW, identifier: 'gumroad:sale1', cancelAt: past }, now)).toBe(false);
    expect(planLapsed({ ...ROW, identifier: 'apimkt:social:u1', cancelAt: past }, now)).toBe(false);
    // A plan an admin gave (no Razorpay subscription behind it, e.g. James's
    // complimentary Pro, restored-...) ends at its date too: nothing else
    // would ever end it.
    expect(planLapsed({ ...ROW, identifier: 'restored-f9q1la6nen', cancelAt: past }, now)).toBe(true);
    expect(planLapsed({ ...ROW, identifier: 'restored-f9q1la6nen', cancelAt: new Date('2027-02-03T18:29:00Z') }, now)).toBe(false);
    expect(
      planState(org({ allowTrial: false, subscription: { ...ROW, identifier: 'restored-x', cancelAt: past } }), c)
    ).toBe('locked');
    expect(
      planState(org({ allowTrial: false, subscription: { ...ROW, identifier: 'gumroad:sale1', cancelAt: past } }), c)
    ).toBe('cancelling');
    // A row read without its identifier is still judged by its date: a
    // caller that forgot to select it must not reopen the lag.
    expect(planLapsed({ ...ROW, cancelAt: past }, now)).toBe(true);
  });

  it('dunning when the caller knows Razorpay says pending or halted', () => {
    expect(planState(org({ isTrailing: false, subscription: ROW }), cutoffs, 'halted')).toBe('dunning');
    expect(planState(org({ isTrailing: false, subscription: ROW }), cutoffs, 'pending')).toBe('dunning');
    expect(planState(org({ isTrailing: false, subscription: LIFETIME }), cutoffs, 'halted')).toBe('active');
  });

  // What stops while a payment is failing (29 Oct 2026, the owner's call).
  // The marker is what every entitlement check reads: those have no
  // remoteStatus, because they do not ask Razorpay.
  describe('the stored failing-payment marker', () => {
    const FAILING = { ...ROW, paymentFailingSince: new Date('2026-10-29T10:00:00Z') };

    it("a trial's first charge and a renewal are both dunning", () => {
      expect(planState(org({ isTrailing: true, subscription: FAILING }), cutoffs)).toBe('dunning');
      expect(planState(org({ isTrailing: false, subscription: FAILING }), cutoffs)).toBe('dunning');
    });

    it('a lifetime plan has no charge to fail', () => {
      expect(
        planState(org({ isTrailing: true, subscription: { ...LIFETIME, paymentFailingSince: new Date() } }), cutoffs)
      ).toBe('active');
    });

    it('a plan set to end and failing is still failing: the money, not the date, decides', () => {
      const cancelling = { ...FAILING, cancelAt: new Date('2026-11-20T00:00:00Z') };
      expect(planState(org({ isTrailing: false, subscription: cancelling }), cutoffs)).toBe('dunning');
      expect(planState(org({ isTrailing: true, subscription: cancelling }), cutoffs)).toBe('dunning');
    });

    it('a soft-deleted plan row is no plan at all, marker or not', () => {
      expect(
        planState(org({ subscription: { ...FAILING, deletedAt: new Date() } }), cutoffs)
      ).toBe('free_posts');
    });

    it('cleared (null or absent) is the plan it was before', () => {
      expect(planState(org({ isTrailing: true, subscription: { ...ROW, paymentFailingSince: null } }), cutoffs)).toBe('trialing');
      expect(planState(org({ isTrailing: false, subscription: ROW }), cutoffs)).toBe('active');
    });

    it('does not depend on the trial cutoffs: a bought plan is not a cohort', () => {
      const none = trialCutoffs({}, quiet());
      expect(planState(org({ isTrailing: true, subscription: FAILING }), none)).toBe('dunning');
      expect(planState(org({ isTrailing: false, subscription: FAILING }), none)).toBe('dunning');
    });
  });
});

describe('what the states mean', () => {
  const cutoffs = trialCutoffs(env(CUTOFF), quiet());

  it('only needs_trial and locked are gated; a failing payment never is', () => {
    expect(blocksPlanUse('needs_trial')).toBe(true);
    expect(blocksPlanUse('locked')).toBe(true);
    for (const s of ['free', 'trialing', 'active', 'dunning', 'cancelling'] as const) {
      expect(blocksPlanUse(s)).toBe(false);
      // A failing charge only costs the workspace AI and X; the gate, which
      // is what refuses a publish, has nothing to say about it.
      expect(planGateCode(s)).toBeNull();
    }
    expect(planGateCode('needs_trial')).toBe('TRIAL_REQUIRED');
    expect(planGateCode('locked')).toBe('PLAN_REQUIRED');
  });

  it('the Free plan exists for grandfathered workspaces, never for the new cohort, plan or not', () => {
    expect(freePlanAvailable(org({ createdAt: BEFORE }), cutoffs)).toBe(true);
    expect(freePlanAvailable(org(), cutoffs)).toBe(false);
    expect(freePlanAvailable(org({ subscription: ROW }), cutoffs)).toBe(false);
    expect(freePlanAvailable(org(), trialCutoffs(env(), quiet()))).toBe(true);
  });

  it('trialPolicyActive is false with both cutoffs empty or unusable', () => {
    expect(trialPolicyActive(trialCutoffs(env(), quiet()))).toBe(false);
    expect(trialPolicyActive(trialCutoffs(env('typo', '2026-01-01T00:00:00Z'), quiet()))).toBe(false);
    expect(trialPolicyActive(trialCutoffs(env(CUTOFF), quiet()))).toBe(true);
  });

  it('reads process.env on every call, so a restart with a new value applies', () => {
    const old = { ...process.env };
    try {
      delete process.env.TRIAL_REQUIRED_SINCE_IN;
      delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
      expect(planState(org())).toBe('free');
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      expect(planState(org())).toBe('free_posts');
      // Rollback is an empty value, not a deleted line.
      process.env.TRIAL_REQUIRED_SINCE_IN = '';
      expect(planState(org())).toBe('free');
    } finally {
      process.env = old;
    }
  });
});

// PR-4: a country the USD rail does not sell to keeps the Free plan, because
// the only checkout it would get is the rupee one (the plan's T13).
describe('USD_EXCLUDED_COUNTRIES leaves the GLOBAL cohort', () => {
  const newOrg = (ownerCountry: string | null): PolicyOrg => ({
    createdAt: AFTER,
    allowTrial: true,
    ownerCountry,
  });
  const cutoffs = (excluded?: string, IN?: string, GLOBAL = CUTOFF) =>
    trialCutoffs(
      { ...env(IN, GLOBAL), ...(excluded !== undefined ? { USD_EXCLUDED_COUNTRIES: excluded } : {}) },
      quiet()
    );

  it('an excluded country keeps Free after the GLOBAL cutoff; others need the trial', () => {
    const c = cutoffs('EU27, GB');
    expect(planState(newOrg('DE'), c)).toBe('free');
    expect(planState(newOrg('GB'), c)).toBe('free');
    expect(freePlanAvailable(newOrg('FR'), c)).toBe(true);
    expect(planState(newOrg('US'), c)).toBe('free_posts');
    // Unknown is GLOBAL and cannot be excluded.
    expect(planState(newOrg(null), c)).toBe('free_posts');
  });

  it('never touches India, whatever the list says', () => {
    expect(planState(newOrg('IN'), cutoffs('IN', CUTOFF, ''))).toBe('free_posts');
  });

  it('with no list, every country outside India needs the trial', () => {
    expect(planState(newOrg('DE'), cutoffs(undefined))).toBe('free_posts');
    expect(planState(newOrg('DE'), cutoffs(''))).toBe('free_posts');
  });

  it('reads groups, any case and separator, and logs what it cannot read', () => {
    const log = quiet();
    const set = excludedCountries({ USD_EXCLUDED_COUNTRIES: 'eea;uk el, CH  Europe' }, log);
    for (const c of ['DE', 'FR', 'NO', 'IS', 'LI', 'GB', 'GR', 'CH']) expect(set.has(c)).toBe(true);
    expect(set.has('US')).toBe(false);
    expect(set.has('EUROPE')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('"EUROPE"');
  });
});

// The GLOBAL cohort exists only while the dollar checkout sells: otherwise a
// workspace outside India would be sent to the rupee checkout, which has
// never worked for a buyer abroad (the plan's decision 2).
describe('TRIAL_REQUIRED_SINCE_GLOBAL needs the USD rail to be live', () => {
  const newOrg = (ownerCountry: string | null): PolicyOrg => ({
    createdAt: AFTER,
    allowTrial: true,
    ownerCountry,
  });

  it.each([
    ['USD_CHECKOUT unset', {}],
    ['off', { USD_CHECKOUT: 'off', GST_LUT_ARN: 'AD1' }],
    ['allowlist', { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co', GST_LUT_ARN: 'AD1' }],
    ['on without an LUT', { USD_CHECKOUT: 'on' }],
    ['on with a blank LUT', { USD_CHECKOUT: 'on', GST_LUT_ARN: '  ' }],
    ['a typo', { USD_CHECKOUT: 'onn', GST_LUT_ARN: 'AD1' }],
  ])('%s: US and unknown keep Free, India is unaffected, and it is logged once', (_label, usd) => {
    const log = quiet();
    let c = trialCutoffs(env(CUTOFF, CUTOFF, usd as any), log);
    for (let i = 0; i < 3; i++) c = trialCutoffs(env(CUTOFF, CUTOFF, usd as any), log);
    expect(c.GLOBAL).toBeNull();
    expect(c.usdLive).toBe(false);
    expect(planState(newOrg('US'), c)).toBe('free');
    expect(planState(newOrg(null), c)).toBe('free');
    expect(freePlanAvailable(newOrg('US'), c)).toBe(true);
    expect(planState(newOrg('IN'), c)).toBe('free_posts');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('workspaces outside India keep the Free plan');
  });

  it('GLOBAL alone with USD off switches nothing on, not even the copy', () => {
    const c = trialCutoffs(env(undefined, CUTOFF, {}), quiet());
    expect(trialPolicyActive(c)).toBe(false);
  });

  it('on with an LUT (any case, padded): GLOBAL applies', () => {
    const c = trialCutoffs(
      env(undefined, CUTOFF, { USD_CHECKOUT: ' ON ', GST_LUT_ARN: 'AD1' }),
      quiet()
    );
    expect(c.usdLive).toBe(true);
    expect(c.GLOBAL?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(planState(newOrg('US'), c)).toBe('free_posts');
  });

  it('a hand-built cutoffs object that says the rail is off has no GLOBAL cohort', () => {
    expect(
      inTrialCohort(newOrg('US'), { IN: null, GLOBAL: new Date(CUTOFF), usdLive: false })
    ).toBe(false);
  });

  it('is the same rule as usdOnForEveryone, which decides what checkout charges', () => {
    const modes = [undefined, '', 'off', 'on', ' On ', 'allowlist', 'yes'];
    const luts = [undefined, '', ' ', 'AD1'];
    for (const USD_CHECKOUT of modes) {
      for (const GST_LUT_ARN of luts) {
        const e = { USD_CHECKOUT, GST_LUT_ARN };
        expect([e, usdRailLive(e)]).toEqual([e, usdOnForEveryone(e, () => undefined)]);
      }
    }
  });
});

describe('describeTrialPolicy, the startup line backend and orchestrator print', () => {
  it('says what is applied, and never prints the LUT', () => {
    const line = describeTrialPolicy(
      {
        ...env(CUTOFF, CUTOFF, { USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0910260000000' }),
        USD_EXCLUDED_COUNTRIES: 'GB, FR',
      },
      quiet()
    );
    expect(line).toBe(
      'Trial policy: IN cutoff 2026-10-20T00:00:00.000Z; GLOBAL cutoff 2026-10-20T00:00:00.000Z; USD_CHECKOUT=on; GST_LUT_ARN set; USD rail live; USD_EXCLUDED_COUNTRIES FR,GB; FREE_PLAN_SUNSET_AT unset; TRIAL_CHECKOUT off'
    );
    expect(line).not.toContain('AD0910260000000');
  });

  it('flags a GLOBAL value that is set but not applied', () => {
    expect(describeTrialPolicy(env(undefined, CUTOFF, {}), quiet())).toBe(
      'Trial policy: IN cutoff unset; GLOBAL cutoff unset (set but not applied); USD_CHECKOUT=unset; GST_LUT_ARN empty; USD rail off; USD_EXCLUDED_COUNTRIES none; FREE_PLAN_SUNSET_AT unset; TRIAL_CHECKOUT off'
    );
  });

  it('names the Free plan sunset and how many workspaces are exempt, never which', () => {
    expect(
      describeTrialPolicy(
        { ...env(CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET, FREE_PLAN_SUNSET_EXEMPT_ORGS: 'org-a, org-b' },
        quiet()
      )
    ).toContain('FREE_PLAN_SUNSET_AT 2026-10-27T18:29:59.000Z (2 exempt orgs); TRIAL_CHECKOUT off');
  });
});

describe('FREE_PLAN_SUNSET_AT: the grandfathered Free plan ends', () => {
  const WEEK_BEFORE = new Date('2026-10-20T12:00:00Z');
  const AT_SUNSET = new Date(SUNSET);
  const DAY_AFTER = new Date('2026-10-28T12:00:00Z');
  const at = (e: Record<string, string | undefined>, now: Date) => ({
    ...trialCutoffs(e, quiet()),
    now,
  });
  const sunsetEnv = (extra: Record<string, string> = {}) => ({
    ...env(CUTOFF, CUTOFF),
    FREE_PLAN_SUNSET_AT: SUNSET,
    ...extra,
  });
  const grandfathered = (over: Partial<PolicyOrg> = {}) =>
    org({ id: 'org-1', createdAt: BEFORE, ...over });

  it('unset, empty or invalid: exactly today’s behaviour, for every workspace', () => {
    const plans = [null, ROW, LIFETIME, SET_TO_END];
    for (const raw of [undefined, '', 'next week', '2026-10-27', '2026-01-01T00:00:00Z']) {
      for (const createdAt of [BEFORE, AFTER]) {
        for (const subscription of plans) {
          for (const allowTrial of [true, false]) {
            for (const country of ['IN', 'US', null]) {
              const o = org({ id: 'org-1', createdAt, subscription, allowTrial, ownerCountry: country });
              const today = trialCutoffs(env(CUTOFF, CUTOFF), quiet());
              const withKey = at({ ...env(CUTOFF, CUTOFF), FREE_PLAN_SUNSET_AT: raw }, DAY_AFTER);
              expect(planState(o, withKey)).toBe(planState(o, today));
              expect(freePlanAvailable(o, withKey)).toBe(freePlanAvailable(o, today));
              expect(freePlanEndsAt(o, withKey)).toBeNull();
            }
          }
        }
      }
      resetTrialPolicyWarnings();
    }
  });

  it('an unusable value is logged once, saying the Free plan does not end', () => {
    const log = quiet();
    for (let i = 0; i < 3; i++) trialCutoffs({ ...env(CUTOFF), FREE_PLAN_SUNSET_AT: '2026-10-27' }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('so the Free plan does not end for any workspace');
  });

  it('before the sunset: still Free, with the date for the notice', () => {
    const c = at(sunsetEnv(), WEEK_BEFORE);
    for (const allowTrial of [true, false]) {
      const o = grandfathered({ allowTrial });
      expect(planState(o, c)).toBe('free');
      expect(freePlanAvailable(o, c)).toBe(true);
      expect(needsTrial(o, c)).toBe(false);
      expect(freePlanEndsAt(o, c)?.toISOString()).toBe('2026-10-27T18:29:59.000Z');
    }
    expect(freePlanSunsetPassed(c)).toBe(false);
  });

  it('from the sunset on: one rule with the new cohort, free posts and then a plan (no needs_trial, 4 Nov 2026)', () => {
    for (const now of [AT_SUNSET, DAY_AFTER]) {
      const c = at(sunsetEnv(), now);
      expect(freePlanSunsetPassed(c)).toBe(true);
      expect(planState(grandfathered(), c)).toBe('free_posts');
      expect(planGateCode(planState(grandfathered(), c))).toBeNull();
      expect(planState(grandfathered({ allowTrial: false }), c)).toBe('locked');
      expect(freePlanAvailable(grandfathered(), c)).toBe(false);
      expect(freePlanEndsAt(grandfathered(), c)).toBeNull();
    }
  });

  it('region-correct: outside India only while the dollar checkout sells there', () => {
    const c = at(sunsetEnv(), DAY_AFTER);
    expect(planState(grandfathered({ ownerCountry: 'US' }), c)).toBe('free_posts');
    expect(planState(grandfathered({ ownerCountry: null }), c)).toBe('free_posts');
    // No GLOBAL cutoff, dollars off, or a country dollars are not sold in:
    // that group has no trial to offer, so it keeps the Free plan.
    const inOnly = at({ ...env(CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET }, DAY_AFTER);
    expect(planState(grandfathered({ ownerCountry: 'US' }), inOnly)).toBe('free');
    expect(freePlanEndsAt(grandfathered({ ownerCountry: 'US' }), at({ ...env(CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET }, WEEK_BEFORE))).toBeNull();
    expect(planState(grandfathered({ ownerCountry: 'IN' }), inOnly)).toBe('free_posts');
    const usdOff = at({ ...env(CUTOFF, CUTOFF, {}), FREE_PLAN_SUNSET_AT: SUNSET }, DAY_AFTER);
    expect(planState(grandfathered({ ownerCountry: 'US' }), usdOff)).toBe('free');
    const excluded = at(sunsetEnv({ USD_EXCLUDED_COUNTRIES: 'GB' }), DAY_AFTER);
    expect(planState(grandfathered({ ownerCountry: 'GB' }), excluded)).toBe('free');
  });

  it('exemptions: FREE_PLAN_SUNSET_EXEMPT_ORGS and a platform super admin keep the Free plan', () => {
    const c = at(sunsetEnv({ FREE_PLAN_SUNSET_EXEMPT_ORGS: 'org-test, org-1 ,org-x' }), DAY_AFTER);
    expect(planState(grandfathered(), c)).toBe('free');
    expect(freePlanAvailable(grandfathered(), c)).toBe(true);
    expect(planState(grandfathered({ id: 'org-2' }), c)).toBe('free_posts');
    const plain = at(sunsetEnv(), DAY_AFTER);
    expect(planState(grandfathered({ platformAdmin: true }), plain)).toBe('free');
    // Neither gets the notice either.
    const before = at(sunsetEnv({ FREE_PLAN_SUNSET_EXEMPT_ORGS: 'org-1' }), WEEK_BEFORE);
    expect(freePlanEndsAt(grandfathered(), before)).toBeNull();
    expect(freePlanEndsAt(grandfathered({ platformAdmin: true }), at(sunsetEnv(), WEEK_BEFORE))).toBeNull();
  });

  it('a plan on file is never touched, before or after, and gets no notice', () => {
    for (const now of [WEEK_BEFORE, DAY_AFTER]) {
      const c = at(sunsetEnv(), now);
      expect(planState(grandfathered({ isTrailing: false, subscription: ROW }), c)).toBe('active');
      expect(planState(grandfathered({ isTrailing: true, subscription: ROW }), c)).toBe('trialing');
      expect(planState(grandfathered({ subscription: LIFETIME }), c)).toBe('active');
      expect(planState(grandfathered({ subscription: SET_TO_END }), c)).toBe('cancelling');
      expect(planState(grandfathered({ isTrailing: false, subscription: ROW }), c, 'halted')).toBe('dunning');
      expect(freePlanEndsAt(grandfathered({ subscription: ROW }), c)).toBeNull();
      expect(freePlanEndsAt(grandfathered({ subscription: LIFETIME }), c)).toBeNull();
    }
  });

  it('the new cohort is on its free posts, and gets no notice', () => {
    for (const now of [WEEK_BEFORE, DAY_AFTER]) {
      const c = at(sunsetEnv(), now);
      expect(planState(org({ id: 'new' }), c)).toBe('free_posts');
      expect(freePlanEndsAt(org({ id: 'new' }), c)).toBeNull();
    }
  });

  it('the date as the notice and the email print it', () => {
    expect(freePlanEndDateLabel(SUNSET)).toBe('27 October 2026');
  });

  it('reads only the owner’s country, so the app (with a request) and the orchestrator (without) agree', () => {
    // An owner with no signup country is GLOBAL whatever country they sign
    // in from: the orchestrator, which refuses the posts, has no request.
    const noCountry = (over: Partial<PolicyOrg> = {}) => grandfathered({ ownerCountry: null, ...over });
    const both = at(sunsetEnv({ USD_EXCLUDED_COUNTRIES: 'GB' }), DAY_AFTER);
    for (const requestCountry of [null, 'IN', 'US', 'GB']) {
      expect(planState(noCountry({ requestCountry }), both)).toBe(planState(noCountry(), both));
    }
    expect(planState(noCountry(), both)).toBe('free_posts');
    // Only the India cutoff: the orchestrator keeps publishing for them
    // (GLOBAL has no cutoff), so the app keeps them on Free too, even when
    // they sign in from India, and no notice is shown.
    const inOnly = (now: Date) => at({ ...env(CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET }, now);
    for (const requestCountry of [null, 'IN']) {
      expect(planState(noCountry({ requestCountry }), inOnly(DAY_AFTER))).toBe('free');
      expect(freePlanEndsAt(noCountry({ requestCountry, tz: 'Asia/Kolkata' }), inOnly(WEEK_BEFORE))).toBeNull();
    }
    // A known country is never overridden by the request.
    expect(planState(grandfathered({ ownerCountry: 'IN', requestCountry: 'US' }), inOnly(DAY_AFTER))).toBe('free_posts');
  });

  it('freePlanSunsetAt: the date a Free fallback ends, whatever plan is on file now', () => {
    const before = at(sunsetEnv(), WEEK_BEFORE);
    for (const subscription of [null, ROW, SET_TO_END]) {
      expect(freePlanSunsetAt(grandfathered({ subscription }), before)?.toISOString()).toBe('2026-10-27T18:29:59.000Z');
    }
    // Only freePlanEndsAt (the notice) needs the workspace to be on Free now.
    expect(freePlanEndsAt(grandfathered({ subscription: ROW }), before)).toBeNull();
    // None after the date, for the new cohort, an exempt workspace or a group
    // the sunset does not reach.
    expect(freePlanSunsetAt(grandfathered({ subscription: ROW }), at(sunsetEnv(), DAY_AFTER))).toBeNull();
    expect(freePlanSunsetAt(org({ id: 'new', subscription: ROW }), before)).toBeNull();
    expect(freePlanSunsetAt(grandfathered({ platformAdmin: true }), before)).toBeNull();
    expect(freePlanSunsetAt(grandfathered({ ownerCountry: 'US' }), at({ ...env(CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET }, WEEK_BEFORE))).toBeNull();
  });

  it('a plan that ends after the sunset is paused, one that ends before it falls back to Free', () => {
    const paid = grandfathered({ subscription: null });
    // Evaluated at the moment the plan ends, as the billing emails do.
    expect(freePlanAvailable(paid, at(sunsetEnv(), new Date('2026-10-25T00:00:00Z')))).toBe(true);
    expect(freePlanAvailable(paid, at(sunsetEnv(), new Date('2026-11-05T00:00:00Z')))).toBe(false);
  });
});

describe('variable-cost features per plan state: AI and X', () => {
  const CANCELLING = SET_TO_END;
  const FAILING = { ...ROW, paymentFailingSince: new Date('2026-10-29T10:00:00Z') };
  const cutoffs = (extra: Record<string, string> = {}) =>
    trialCutoffs({ ...env(CUTOFF), ...extra }, quiet());

  // [workspace, planState, AI allowed, X allowed, the workspace]
  const MATRIX: Array<[string, string, boolean, boolean, PolicyOrg]> = [
    ['active Standard', 'active', true, true, org({ isTrailing: false, allowTrial: false, subscription: ROW })],
    ['lifetime', 'active', true, true, org({ isTrailing: false, allowTrial: false, subscription: LIFETIME })],
    ['trialing', 'trialing', true, true, org({ allowTrial: false, subscription: ROW })],
    // The owner, 29 Oct 2026: a customer who paid for the period and
    // cancelled keeps every feature until cancelAt, X and AI included. Only
    // time nobody paid for loses them: a cancelled trial never charged.
    ['cancelling, paid', 'cancelling', true, true, org({ isTrailing: false, allowTrial: false, subscription: CANCELLING })],
    ['cancelling, paid, grandfathered', 'cancelling', true, true, org({ createdAt: BEFORE, isTrailing: false, allowTrial: false, subscription: CANCELLING })],
    ['cancelling trial, never charged', 'cancelling', false, false, org({ allowTrial: false, subscription: CANCELLING })],
    // A charge that is failing costs Hookpost real money on AI and X for a
    // plan nobody has paid for yet (29 Oct 2026): both stop at once, and come
    // back by themselves when a retry goes through.
    ['renewal failing', 'dunning', false, false, org({ isTrailing: false, allowTrial: false, subscription: FAILING })],
    ['trial first charge failing', 'dunning', false, false, org({ allowTrial: false, subscription: FAILING })],
    // One of our own workspaces never loses a feature to a failing charge: a
    // test mandate must not take AI off the founder's workspace.
    ['exempt, renewal failing', 'active', true, true, org({ id: 'org-exempt', isTrailing: false, allowTrial: false, subscription: FAILING })],
    ['super admin member, trial charge failing', 'trialing', true, true, org({ platformAdmin: true, allowTrial: false, subscription: FAILING })],
    // Paid to cancelAt but a charge is failing (a retried renewal before the
    // cancel): dunning wins, X and AI stay off until it is paid.
    ['cancelling, paid, charge failing', 'dunning', false, false, org({ isTrailing: false, allowTrial: false, subscription: { ...CANCELLING, paymentFailingSince: new Date() } })],
    ['free (grandfathered)', 'free', false, true, org({ createdAt: BEFORE })],
    ['super admin member, no plan', 'free', false, true, org({ createdAt: BEFORE, platformAdmin: true })],
    ['super admin member, cancelling', 'cancelling', false, true, org({ platformAdmin: true, subscription: CANCELLING })],
    ['exempt, no plan', 'free', false, true, org({ id: 'org-exempt', createdAt: BEFORE })],
    ['exempt, cancelling', 'cancelling', false, true, org({ id: 'org-exempt', subscription: CANCELLING })],
    ['grandfathered, plan soft-deleted', 'free', false, true, org({ createdAt: BEFORE, subscription: { ...CANCELLING, deletedAt: new Date() } })],
    // That same cancelling plan an hour later, with the sweep not yet run:
    // the row is still on file but the plan is over, so AI is refused on the
    // state the sweep itself would leave, not on `cancelling`.
    ['ended, row not swept yet', 'locked', false, true, org({ isTrailing: false, allowTrial: false, subscription: ENDED })],
    ['ended, row not swept yet, grandfathered', 'free', false, true, org({ createdAt: BEFORE, allowTrial: false, subscription: ENDED })],
  ];

  it.each(MATRIX)('%s: %s, AI %s, X %s', (_name, state, ai, x, workspace) => {
    const c = cutoffs({ FREE_PLAN_SUNSET_EXEMPT_ORGS: 'other, org-exempt' });
    expect(planState(workspace, c)).toBe(state);
    expect(allowsVariableCostFeatures(planState(workspace, c), workspace)).toBe(ai);
    expect(allowsXPublishing(workspace, c)).toBe(x);
  });

  it('the X rule does not depend on the trial cutoffs: a cancelled trial loses X with both empty', () => {
    const c = trialCutoffs({}, quiet());
    expect(allowsXPublishing(org({ subscription: CANCELLING }), c)).toBe(false);
    expect(allowsXPublishing(org({ isTrailing: false, subscription: CANCELLING }), c)).toBe(true);
    expect(allowsXPublishing(org({ subscription: FAILING, isTrailing: false }), c)).toBe(false);
    expect(allowsXPublishing(org({ subscription: ROW, isTrailing: false }), c)).toBe(true);
    expect(allowsXPublishing(org(), c)).toBe(true);
  });

  it('without the workspace, cancelling is refused: never grant AI on a guess', () => {
    expect(allowsVariableCostFeatures('cancelling')).toBe(false);
    expect(allowsVariableCostFeatures('cancelling', null)).toBe(false);
    // A soft-deleted or lifetime row is never "paid until cancelAt".
    expect(allowsVariableCostFeatures('cancelling', org({ isTrailing: false, subscription: { ...CANCELLING, deletedAt: new Date() } }))).toBe(false);
  });

  it('exempt only by id: another workspace with the same plan is still refused', () => {
    const c = cutoffs({ FREE_PLAN_SUNSET_EXEMPT_ORGS: 'org-exempt' });
    expect(allowsXPublishing(org({ id: 'org-other', subscription: CANCELLING }), c)).toBe(false);
  });

  it('free_posts and locked are not refused here: free_posts publishes, the plan gate refuses locked', () => {
    const c = cutoffs();
    const needs = org();
    const locked = org({ allowTrial: false, isTrailing: false });
    expect([planState(needs, c), planState(locked, c)]).toEqual(['free_posts', 'locked']);
    expect(planGateCode(planState(needs, c))).toBeNull();
    expect(planGateCode(planState(locked, c))).toBe('PLAN_REQUIRED');
    expect(allowsXPublishing(needs, c)).toBe(true);
    expect(allowsXPublishing(locked, c)).toBe(true);
  });
});

// 25 Oct 2026, connect first: needs_trial may connect one channel before its
// trial; every other state keeps its own allowance (or, locked, none).
describe('the pre-trial channel limit', () => {
  const {
    PLAN_GATE_MESSAGES,
    planGateMessage,
    policyOrgFromFacts,
    PRE_TRIAL_CHANNEL_LIMIT,
    preTrialChannelLimit,
    preTrialChannelMessage,
  } = jest.requireActual(
    '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy'
  );

  it('is 1, and only for needs_trial', () => {
    expect(PRE_TRIAL_CHANNEL_LIMIT).toBe(1);
    for (const state of ['free', 'locked', 'trialing', 'active', 'dunning', 'cancelling']) {
      expect([state, preTrialChannelLimit(state)]).toEqual([state, null]);
    }
    expect(preTrialChannelLimit('needs_trial')).toBe(1);
  });

  it('says how many channels come before the trial, and the trial length', () => {
    expect(preTrialChannelMessage()).toBe(
      'You can connect 1 channel before your trial starts. Start your 3-day trial to connect more and schedule posts.'
    );
    expect(preTrialChannelMessage(7)).toContain('Start your 7-day trial');
    expect(preTrialChannelMessage(0)).toContain('Start your 3-day trial');
  });

  it('the gate copy no longer says channels need the trial', () => {
    expect(PLAN_GATE_MESSAGES.TRIAL_REQUIRED).toBe('Start your 3-day trial to schedule and publish posts.');
    expect(planGateMessage('TRIAL_REQUIRED', 7)).toBe('Start your 7-day trial to schedule and publish posts.');
    expect(PLAN_GATE_MESSAGES.TRIAL_REQUIRED).not.toMatch(/connect/i);
  });

  it('policyOrgFromFacts reads getPlanFacts the way the plan state needs it', () => {
    const row = {
      id: 'org-1',
      createdAt: AFTER,
      allowTrial: true,
      isTrailing: true,
      subscription: null,
      users: [{ user: { signupCountry: 'IN' } }],
      _count: { users: 1 },
    };
    expect(policyOrgFromFacts(row, { requestCountry: 'US', tz: 'Asia/Kolkata' })).toEqual({
      id: 'org-1',
      createdAt: AFTER,
      allowTrial: true,
      isTrailing: true,
      subscription: null,
      disputedAt: null,
      ownerCountry: 'IN',
      platformAdmin: true,
      requestCountry: 'US',
      tz: 'Asia/Kolkata',
    });
    expect(policyOrgFromFacts({ ...row, users: [], _count: null })).toMatchObject({
      ownerCountry: null,
      platformAdmin: false,
      requestCountry: null,
      tz: null,
    });
  });
});

// 28 Oct 2026, the owner's call: a new sign-up gets FREE_POST_LIMIT free posts
// instead of the card or UPI trial, then must choose a plan, charged at once.
describe('free posts: the new cohort', () => {
  const c = trialCutoffs(env(CUTOFF, CUTOFF), quiet());
  const sunsetPassed = {
    ...trialCutoffs(
      { ...env(CUTOFF, CUTOFF), FREE_PLAN_SUNSET_AT: SUNSET },
      quiet()
    ),
    now: new Date('2026-10-28T12:00:00Z'),
  };

  it('is 3', () => {
    expect(FREE_POST_LIMIT).toBe(3);
  });

  it('a new sign-up with no plan is on its free posts, not the trial', () => {
    expect(planState(org(), c)).toBe('free_posts');
    expect(planState(org({ ownerCountry: 'US' }), c)).toBe('free_posts');
    // Nothing blocks it: no paywall, no 402 gate, the Free channel allowance.
    expect(blocksPlanUse('free_posts')).toBe(false);
    expect(planGateCode('free_posts')).toBeNull();
    expect(preTrialChannelLimit('free_posts')).toBeNull();
    expect(freePlanAvailable(org(), c)).toBe(false);
    // No AI (it costs per call), X like any channel.
    expect(allowsVariableCostFeatures('free_posts')).toBe(false);
    expect(allowsXPublishing(org(), c)).toBe(true);
  });

  it.each([
    [0, 3, true],
    [1, 2, true],
    [2, 1, true],
    [3, 0, false],
    [4, 0, false],
  ])('%i posts used: %i left, a new one allowed: %s', (used, left, allowed) => {
    expect(freePostsLeft(used)).toBe(left);
    expect(freePostAllowed(used, true)).toBe(allowed);
    // An edit of a post it has is never refused.
    expect(freePostAllowed(used, false)).toBe(true);
  });

  it('a junk count is read as none used, never as more posts', () => {
    expect(freePostsLeft(NaN)).toBe(3);
    expect(freePostsLeft(-2)).toBe(3);
    expect(freePostsLeft(1.7)).toBe(2);
  });

  it('one post on three channels is ONE post: its rows share the publish date to the minute', () => {
    // PostsRepository gives every channel its own group, so group cannot
    // count posts; one save gives every channel the same date.
    const rows = [
      { group: 'g-linkedin', publishDate: new Date('2026-10-29T10:30:00Z') },
      { group: 'g-x', publishDate: new Date('2026-10-29T10:30:00Z') },
      { group: 'g-threads', publishDate: '2026-10-29T10:30:00.000Z' },
      { group: 'g-next', publishDate: new Date('2026-10-30T09:00:00Z') },
    ];
    const posts = new Set(rows.map((r) => freePostKey(r.publishDate)));
    expect(posts.size).toBe(2);
    expect(freePostsLeft(posts.size)).toBe(1);
    expect(freePostKey('2026-10-29T10:30:59Z')).toBe(freePostKey('2026-10-29T10:30:00Z'));
    expect(freePostKey('2026-10-29T10:31:00Z')).not.toBe(freePostKey('2026-10-29T10:30:00Z'));
  });

  describe('freePostsUsed: posts from root rows', () => {
    const at = (iso: string) => new Date(iso);
    it('one save to three channels is one post', () => {
      expect(
        freePostsUsed([
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'x' },
          { publishDate: '2026-10-29T10:30:20.000Z', integrationId: 'th' },
        ])
      ).toBe(1);
    });
    it('two saves to the same channel at the same minute are two posts', () => {
      expect(
        freePostsUsed([
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T10:30:40Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'x' },
        ])
      ).toBe(2);
    });
    it('any number at one minute costs one post each, so the limit cannot be dodged', () => {
      const rows = Array.from({ length: 10 }, () => ({ publishDate: at('2026-11-01T09:00:00Z'), integrationId: 'li' }));
      expect(freePostsUsed(rows)).toBe(10);
      expect(freePostsLeft(freePostsUsed(rows))).toBe(0);
    });
    it('two saves at one minute to two different channels are what one save to both makes: one post', () => {
      expect(
        freePostsUsed([
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T10:30:10Z'), integrationId: 'x' },
        ])
      ).toBe(1);
    });
    it('different minutes add up; a row with no channel counts on its own', () => {
      expect(
        freePostsUsed([
          { publishDate: at('2026-10-29T10:30:00Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T11:30:00Z'), integrationId: 'li' },
          { publishDate: at('2026-10-29T11:30:00Z'), integrationId: null },
        ])
      ).toBe(3);
      expect(freePostsUsed([])).toBe(0);
    });
  });

  it('the 4th post is refused with FREE_POSTS_USED and its own sentence', () => {
    expect(PLAN_GATE_MESSAGES.FREE_POSTS_USED).toBe(
      "You've used your 3 free posts. Pick a plan to keep posting."
    );
    expect(planGateMessage('FREE_POSTS_USED', 7)).toBe(
      PLAN_GATE_MESSAGES.FREE_POSTS_USED
    );
  });

  it('its checkout has no trial, so the first payment (and the first-month offer) is today', () => {
    expect(checkoutAllowsTrial('free_posts', true, false)).toBe(false);
    expect(checkoutAllowsTrial('needs_trial', true)).toBe(true);
    expect(checkoutAllowsTrial('free', true)).toBe(true);
    expect(checkoutAllowsTrial('free', false)).toBe(false);
    expect(checkoutAllowsTrial('locked', false)).toBe(false);
  });

  it('with the trial switch on (TRIAL_CHECKOUT=on) its checkout starts a trial, once', () => {
    expect(checkoutAllowsTrial('free_posts', true, true)).toBe(true);
    // allowTrial goes false with the first trial or plan: never a second.
    expect(checkoutAllowsTrial('free_posts', false, true)).toBe(false);
    expect(checkoutAllowsTrial('locked', false, true)).toBe(false);
    // Locked with allowTrial left true is a disputed workspace: never a trial
    // with the switch on; off, exactly as before (the dispute clears allowTrial).
    expect(checkoutAllowsTrial('locked', true, true)).toBe(false);
    expect(checkoutAllowsTrial('locked', true, false)).toBe(true);
    // Nothing else moves with the switch.
    for (const on of [true, false]) {
      expect(checkoutAllowsTrial('needs_trial', true, on)).toBe(true);
      expect(checkoutAllowsTrial('free', true, on)).toBe(true);
      expect(checkoutAllowsTrial('free', false, on)).toBe(false);
    }
  });

  it('the switch is TRIAL_CHECKOUT exactly "on", any case; anything else is off', () => {
    expect(trialCheckoutOn({ TRIAL_CHECKOUT: 'on' })).toBe(true);
    expect(trialCheckoutOn({ TRIAL_CHECKOUT: ' ON ' })).toBe(true);
    for (const v of [undefined, '', 'off', 'true', '1', 'yes', 'onn']) {
      expect(trialCheckoutOn({ TRIAL_CHECKOUT: v })).toBe(false);
    }
  });

  it('the default reads the environment on every call', () => {
    const before = process.env.TRIAL_CHECKOUT;
    try {
      process.env.TRIAL_CHECKOUT = 'on';
      expect(checkoutAllowsTrial('free_posts', true)).toBe(true);
      process.env.TRIAL_CHECKOUT = '';
      expect(checkoutAllowsTrial('free_posts', true)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.TRIAL_CHECKOUT;
      else process.env.TRIAL_CHECKOUT = before;
    }
  });

  it('a workspace whose trial or plan ended is locked, not given free posts again', () => {
    expect(planState(org({ allowTrial: false, isTrailing: false }), c)).toBe('locked');
  });

  it('a running trial, a paid plan and a lifetime plan are unchanged', () => {
    expect(planState(org({ subscription: ROW, isTrailing: true }), c)).toBe('trialing');
    expect(planState(org({ subscription: ROW, isTrailing: false, allowTrial: false }), c)).toBe('active');
    expect(planState(org({ subscription: LIFETIME }), c)).toBe('active');
    expect(planState(org({ subscription: SET_TO_END }), c)).toBe('cancelling');
  });

  it('the grandfathered workspaces the sunset reached are on free posts, like everyone (4 Nov 2026)', () => {
    const old = org({ id: 'old', createdAt: BEFORE });
    expect(planState(old, sunsetPassed)).toBe('free_posts');
    expect(checkoutAllowsTrial(planState(old, sunsetPassed), true, false)).toBe(false);
    // Before the sunset it was Free, as before.
    expect(planState(old, c)).toBe('free');
  });

  it('exempt workspaces are unchanged: Free if grandfathered, the new rule if created after the cutoff', () => {
    const exempt = { ...sunsetPassed, sunsetExempt: new Set(['org-exempt']) };
    expect(planState(org({ id: 'org-exempt', createdAt: BEFORE }), exempt)).toBe('free');
    expect(planState(org({ id: 'org-exempt', createdAt: BEFORE, platformAdmin: true }), sunsetPassed)).toBe('free');
    expect(planState(org({ id: 'org-exempt' }), exempt)).toBe('free_posts');
  });

  it('with both cutoffs empty nothing changes: Free for everyone', () => {
    expect(planState(org(), trialCutoffs(env(), quiet()))).toBe('free');
  });
});

// Free posts are given once (29 Oct 2026): the pure parts of the sign-up
// guards and the reused-channel refusal.
describe('free posts are given once', () => {
  it.each([
    ['j.o.h.n@gmail.com', 'john@gmail.com'],
    ['John.Doe+promo@Gmail.com', 'johndoe@gmail.com'],
    ['john+1+2@gmail.com', 'john@gmail.com'],
    ['j.ohn@googlemail.com', 'john@gmail.com'],
    ['  JOHN@gmail.com ', 'john@gmail.com'],
  ])('gmail: %s is %s', (email, identity) => {
    expect(emailIdentity(email)).toBe(identity);
  });

  it('a +tag is dropped on any domain, dots are kept off Gmail', () => {
    expect(emailIdentity('sam+client@agency.io')).toBe('sam@agency.io');
    expect(emailIdentity('Sam@Agency.io')).toBe('sam@agency.io');
    expect(emailIdentity('s.am@agency.io')).toBe('s.am@agency.io');
    expect(emailIdentity('s.am@agency.io')).not.toBe(emailIdentity('sam@agency.io'));
  });

  it.each([null, undefined, '', 'wallet-0xabc', '@gmail.com', '+tag@gmail.com', 'a@'])(
    '%p is not an address',
    (email) => {
      expect(emailIdentity(email as any)).toBeNull();
    }
  );

  it.each(['Instagram', 'LinkedIn', 'X', 'YouTube', 'Facebook Page', 'TikTok', 'Threads', 'Pinterest'])(
    'names the provider (%s) in the refusal, and no workspace (owner copy, 29 Oct item 11)',
    (provider) => {
      expect(reusedChannelMessage(provider)).toBe(
        `This ${provider} account has already used its free posts on Hookpost. Pick a plan to keep posting from it. Your other connected accounts are not affected.`
      );
    }
  );

  it('a provider with no name is still a sentence', () => {
    expect(reusedChannelMessage('')).toContain('This social account');
  });

  it.each([
    ['LinkedIn', 'Acme Studio', 2, 'Your workspace "Acme Studio" still has 2 free posts with this LinkedIn account. Switch to it from the workspace menu to use them, or pick a plan to post from here.'],
    ['X', 'Side project', 1, 'Your workspace "Side project" still has 1 free post with this X account. Switch to it from the workspace menu to use them, or pick a plan to post from here.'],
    ['Instagram', 'Chai', 3, 'Your workspace "Chai" still has 3 free posts with this Instagram account. Switch to it from the workspace menu to use them, or pick a plan to post from here.'],
  ])('your own other workspace with posts left: %s', (provider, workspace, left, text) => {
    expect(freePostsLeftElsewhereMessage(provider, workspace, left)).toBe(text);
  });
});

describe('allowsAiFeatures: the one AI rule', () => {
  const STATES = [
    'free', 'free_posts', 'needs_trial', 'locked', 'trialing', 'active', 'dunning', 'cancelling',
  ] as const;

  it('a failing payment refuses AI whether or not the trial cohorts are on', () => {
    expect(allowsAiFeatures('dunning', false)).toBe(false);
    expect(allowsAiFeatures('dunning', true)).toBe(false);
  });

  it('with the cohorts off every other state keeps AI, as before', () => {
    for (const s of STATES.filter((x) => x !== 'dunning')) {
      expect([s, allowsAiFeatures(s, false)]).toEqual([s, true]);
    }
  });

  it('with the cohorts on it is allowsVariableCostFeatures', () => {
    for (const s of STATES) {
      expect([s, allowsAiFeatures(s, true)]).toEqual([s, allowsVariableCostFeatures(s)]);
    }
  });
});

// A chargeback ends the plan and holds the workspace there (the owner's rule
// of 29 Oct 2026). Organization.disputedAt is written by
// RazorpayService.handleDispute and only a super admin's clear empties it.
describe('a payment dispute locks the workspace', () => {
  const cutoffs = trialCutoffs(env(CUTOFF), quiet());
  const DISPUTED = new Date('2026-10-29T11:26:00Z');

  it('workspaceDisputed is the disputedAt column, and nothing else', () => {
    expect(workspaceDisputed(org({ disputedAt: DISPUTED }))).toBe(true);
    expect(workspaceDisputed(org({ disputedAt: DISPUTED.toISOString() }))).toBe(true);
    expect(workspaceDisputed(org())).toBe(false);
    expect(workspaceDisputed(org({ disputedAt: null }))).toBe(false);
    expect(workspaceDisputed(null)).toBe(false);
    expect(workspaceDisputed(undefined)).toBe(false);
  });

  it('a disputed workspace is locked, so the plan gate refuses with PLAN_REQUIRED', () => {
    expect(planState(org({ disputedAt: DISPUTED }), cutoffs)).toBe('locked');
    expect(planGateCode(planState(org({ disputedAt: DISPUTED }), cutoffs))).toBe(
      'PLAN_REQUIRED'
    );
    expect(blocksPlanUse(planState(org({ disputedAt: DISPUTED }), cutoffs))).toBe(true);
  });

  it('locked beats every cohort: a grandfathered workspace does not fall back to Free', () => {
    const before = org({ createdAt: BEFORE, disputedAt: DISPUTED });
    expect(planState(before, cutoffs)).toBe('locked');
    expect(freePlanAvailable(before, cutoffs)).toBe(false);
    // And with the cutoffs empty, where everyone else is simply `free`.
    const off = trialCutoffs(env(), quiet());
    expect(planState(org({ createdAt: BEFORE }), off)).toBe('free');
    expect(planState(before, off)).toBe('locked');
    expect(freePlanAvailable(before, off)).toBe(false);
  });

  it('a disputed workspace gets no free posts and no trial', () => {
    // free_posts and needs_trial are what this workspace would be otherwise.
    expect(planState(org({ allowTrial: true }), cutoffs)).toBe('free_posts');
    expect(planState(org({ allowTrial: true, disputedAt: DISPUTED }), cutoffs)).toBe(
      'locked'
    );
    expect(needsTrial(org({ disputedAt: DISPUTED }), cutoffs)).toBe(false);
    // markDisputed also writes allowTrial false, which is what checkout reads:
    // no trial on the way back in, even once the dispute has been cleared.
    expect(
      checkoutAllowsTrial(planState(org({ disputedAt: DISPUTED }), cutoffs), false)
    ).toBe(false);
  });

  it('a plan still on file does not outrank the dispute once the row is gone, and never while it is there', () => {
    // handleDispute deletes the row, which is this case: locked.
    expect(planState(org({ disputedAt: DISPUTED, subscription: null }), cutoffs)).toBe(
      'locked'
    );
    // Its retry path can leave the row behind for one redelivery. A paid row
    // still wins there, on purpose: we never take away a plan we did not end.
    expect(
      planState(org({ disputedAt: DISPUTED, subscription: ROW, isTrailing: false }), cutoffs)
    ).toBe('active');
  });

  it('a lifetime plan is not taken away by a dispute on some other payment', () => {
    expect(
      planState(
        org({ disputedAt: DISPUTED, subscription: LIFETIME, isTrailing: false }),
        cutoffs
      )
    ).toBe('active');
  });

  it('clearing the dispute (disputedAt back to null) lets the workspace buy again', () => {
    expect(planState(org({ disputedAt: null, allowTrial: false }), cutoffs)).toBe('locked');
    // Still locked, but as an ordinary used-up workspace: checkout works.
    expect(freePlanAvailable(org({ createdAt: BEFORE, disputedAt: null }), cutoffs)).toBe(
      true
    );
  });

  it('the checkout refusal names support, and says nothing about fraud', () => {
    expect(DISPUTE_CHECKOUT_MESSAGE).toBe(
      'Your account has a payment dispute. Contact support@hookstep.in'
    );
    expect(DISPUTE_CHECKOUT_MESSAGE.toLowerCase()).not.toContain('fraud');
  });

  it('policyOrgFromFacts carries disputedAt through from the database row', () => {
    expect(
      policyOrgFromFacts({ createdAt: AFTER, disputedAt: DISPUTED } as any, {}).disputedAt
    ).toBe(DISPUTED);
    expect(policyOrgFromFacts({ createdAt: AFTER } as any, {}).disputedAt).toBeNull();
  });
});
