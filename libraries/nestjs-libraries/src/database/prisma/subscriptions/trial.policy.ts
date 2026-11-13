/**
 * Who has to start the card or UPI trial before using Hookpost, and what state
 * a workspace's plan is in. PR-2 of local-assets/trial-usd-plan-2026-10-18.md.
 *
 * Pure: no Nest, Prisma or Razorpay imports, and no imports at all, so the
 * backend, the orchestrator and the lead-drip cron (which runs a plain-JS
 * esbuild bundle of this file, scripts/lead-campaign/trial-policy.generated.js)
 * all apply the same rule to the same environment.
 *
 * Two cutoffs, read from the environment on every call so a restart with a
 * changed .env applies without a code change:
 *
 *   TRIAL_REQUIRED_SINCE_IN      workspaces whose owner signed up from India
 *   TRIAL_REQUIRED_SINCE_GLOBAL  everyone else, including an unknown country
 *
 * A workspace created on or after its group's cutoff, with no plan on file, is
 * in the new cohort: no Free plan, it must start the trial (needs_trial) or,
 * once it has used its trial, choose a plan (locked). Every workspace created
 * before the cutoff keeps the Free plan, whatever happens to it later. So does
 * one in a country listed in USD_EXCLUDED_COUNTRIES (PR-4): the USD rail does
 * not sell there, and the rupee rail is unproven for a buyer abroad.
 *
 * The GLOBAL cutoff also needs the dollar checkout to be selling
 * (usdRailLive: USD_CHECKOUT=on and GST_LUT_ARN set, the rule
 * billing.currency.ts applies). Without it a workspace outside India would be
 * sent to the rupee checkout, so TRIAL_REQUIRED_SINCE_GLOBAL counts as unset
 * and is logged: USD rolled back to off, or an LUT missing from .env, must
 * not lock every new foreign signup behind a rail that has never worked for
 * them. So the GLOBAL rule reads USD_CHECKOUT, GST_LUT_ARN and
 * USD_EXCLUDED_COUNTRIES too, in every process that reads the cutoffs.
 *
 * Both cutoffs ship empty, which means nobody is in the new cohort and nothing
 * changes. A value that is not a strict ISO-8601 UTC timestamp, or that is
 * earlier than TRIAL_CUTOFF_FLOOR, also counts as empty and is logged: in the
 * first design `createdAt >= new Date('typo')` would have been false for
 * everyone and `<` true, and one of those would have locked all 31
 * grandfathered workspaces. Failing open is the safe direction here.
 *
 * Rollback is setting the key to empty, never deleting the line: the backend's
 * env override only applies keys present in .env, so a deleted line leaves the
 * old value running in PM2.
 *
 * FREE_PLAN_SUNSET_AT ends the Free plan of those grandfathered workspaces.
 * From that moment a workspace created before its group's cutoff is treated
 * exactly like one created after it: no plan on file means needs_trial (or
 * locked once its trial is used), in the currency its group's trial is sold
 * in. Before it, such a workspace stays Free and freePlanEndsAt() gives the
 * date for the in-app notice. It only reaches a group whose cutoff is set and
 * applied, so it never asks a workspace for a trial its region cannot buy.
 * A plan on file is never touched; once the sunset has passed, a grandfathered
 * workspace whose plan ends is paused like a new-cohort one, not moved to Free.
 * A workspace with a platform super admin among its members, or listed in
 * FREE_PLAN_SUNSET_EXEMPT_ORGS (org ids, for internal and test workspaces),
 * keeps the Free plan. Same strict format and floor as the cutoffs; empty or
 * unusable means the Free plan never ends, which is today's behaviour.
 *
 * FREE POSTS (28 Oct 2026, the owner's call): a workspace created on or
 * after its group's cutoff no longer has to start the trial. It is on
 * `free_posts`: it may create FREE_POST_LIMIT posts, then it must choose a
 * plan, which is charged at once (no trial, so the first-month offer of
 * first.month.offer.ts applies). 42 sign-ups in three weeks had all left at
 * the card or UPI step without posting once. The grandfathered workspaces the
 * sunset sends to the trial (needs_trial, 25 of them promised 7 days) are not
 * part of it, and a workspace that has had a trial or a plan stays `locked`.
 *
 * Whether the sunset reaches a workspace reads only what is on file: the
 * owner's signup country, or GLOBAL without one. Never the request's own
 * country or timezone, because the orchestrator, which refuses the posts, has
 * no request to read them from; with them the app could show a workspace as
 * Free while its posts fail (or the reverse).
 */

export type PlanState =
  /** No plan, created before its group's cutoff: the Free plan. */
  | 'free'
  /**
   * No plan, created on or after its group's cutoff, no trial or plan used
   * yet: may create FREE_POST_LIMIT posts, then must choose a plan.
   */
  | 'free_posts'
  /**
   * No longer produced (4 Nov 2026: one rule, free posts then a plan; see
   * planState). Kept in the type so the trial switch's code paths still
   * compile; planState never returns it.
   */
  | 'needs_trial'
  /** No plan, new cohort, trial already used (allowTrial false): must choose a plan. */
  | 'locked'
  /** A Razorpay trial on file, first charge still ahead. */
  | 'trialing'
  /** A paid (or lifetime) plan. */
  | 'active'
  /**
   * A plan whose charge is failing while Razorpay retries it: a trial's first
   * charge or a renewal, told apart nowhere here because both get the same
   * treatment. Only the features that cost Hookpost money per use stop (AI
   * and X: allowsVariableCostFeatures, allowsXPublishing); publishing to the
   * other channels, scheduling, drafts and media carry on, because they cost
   * nothing and a genuine customer's UPI or bank glitch should not take the
   * product away while their bank is still trying.
   */
  | 'dunning'
  /** A plan or trial set to end (cancelAt on file). */
  | 'cancelling';

export type TrialGroup = 'IN' | 'GLOBAL';

export interface TrialCutoffs {
  IN: Date | null;
  GLOBAL: Date | null;
  /**
   * USD_EXCLUDED_COUNTRIES (see excludedCountries): countries the USD rail
   * does not sell to. A workspace there is never in the GLOBAL cohort, so it
   * keeps the Free plan rather than being asked for a trial on the rupee
   * rail, which has never been proven for a buyer outside India. Absent
   * means none.
   */
  excluded?: ReadonlySet<string>;
  /**
   * usdRailLive(): the dollar checkout sells to everyone outside India. When
   * false, nobody is in the GLOBAL cohort (trialCutoffs already empties
   * GLOBAL then). Absent means not checked, as in a hand-built object.
   */
  usdLive?: boolean;
  /**
   * FREE_PLAN_SUNSET_AT: when the grandfathered Free plan ends. Null or
   * absent means it never does.
   */
  sunset?: Date | null;
  /** FREE_PLAN_SUNSET_EXEMPT_ORGS: workspaces that keep the Free plan. */
  sunsetExempt?: ReadonlySet<string>;
  /** The moment the sunset is compared with. Absent means now (tests fix it). */
  now?: Date;
}

/**
 * The 402 codes the permissions gate answers with, and FREE_POSTS_USED: a
 * free_posts workspace saving a new post past FREE_POST_LIMIT
 * (SubscriptionService.assertFreePostAllowed, from PostsService.createPost).
 * Publishing never refuses a free post.
 *
 * A failing payment is not one of these: `dunning` keeps publishing and only
 * loses AI and X (see PlanState), so the gate has nothing to say about it.
 */
export type PlanGateCode = 'TRIAL_REQUIRED' | 'PLAN_REQUIRED' | 'FREE_POSTS_USED';

/**
 * No cutoff earlier than this is accepted. PR-2 cannot be live before 19 Oct
 * 2026, so an earlier value is a typo (2026-01-01 for 2026-11-01) that would
 * put every workspace created since then behind the paywall.
 */
export const TRIAL_CUTOFF_FLOOR = new Date('2026-10-19T00:00:00.000Z');

export const TRIAL_CUTOFF_ENV: Record<TrialGroup, string> = {
  IN: 'TRIAL_REQUIRED_SINCE_IN',
  GLOBAL: 'TRIAL_REQUIRED_SINCE_GLOBAL',
};

/** When the grandfathered Free plan ends (see the top of this file). */
export const FREE_PLAN_SUNSET_ENV = 'FREE_PLAN_SUNSET_AT';
/** Org ids that keep the Free plan after the sunset, comma separated. */
export const FREE_PLAN_SUNSET_EXEMPT_ENV = 'FREE_PLAN_SUNSET_EXEMPT_ORGS';
/** The trial switch (trialCheckoutOn, "TRIALS BEHIND A SWITCH" above). */
export const TRIAL_CHECKOUT_ENV = 'TRIAL_CHECKOUT';

/**
 * How long the card or UPI AutoPay trial runs before its first charge: the
 * one number every trial date and every "N-day trial" in the product comes
 * from. RazorpayService.subscribe() sets start_at to now plus this many days
 * (RAZORPAY_TRIAL_DAYS overrides it on the server and ships unset), and the
 * marketing pages (trial-offer.ts), the paywall (trial.terms.copy.ts), the
 * gate messages below and the emails all print it.
 *
 * 3, not 7, since 22 Oct 2026: the owner's call ("decide within 2 or 3
 * days"). A trial already running keeps the start_at Razorpay holds for it;
 * only trials started after the deploy get 3 days. With 3 days the "cancel at
 * least 24 hours before the first charge" rule leaves the first 48 hours to
 * cancel in, and the reminder email goes out on day 2 (TRIAL_REMINDER_TO_MS
 * in razorpay.service.ts).
 */
export const TRIAL_DAYS = 3;

/**
 * A first charge closer than this is a plan that starts now, not a trial. A
 * checkout with no trial (allowTrial false, RAZORPAY_TRIAL_DAYS=0) is also
 * `authenticated` for a moment, with its first charge at about now; a trial's
 * is days away (plus any free-months coupon). The welcome email and the
 * paywall's trial terms (trial.terms.copy.ts) draw the same line.
 */
export const TRIAL_MIN_LEAD_MS = 12 * 3600 * 1000;

/** Server override of TRIAL_DAYS (baseTrialDays); ships unset. */
export const RAZORPAY_TRIAL_DAYS_ENV = 'RAZORPAY_TRIAL_DAYS';

/**
 * The trial length before any per-workspace promise (trialDaysFor):
 * RAZORPAY_TRIAL_DAYS when it is set, else TRIAL_DAYS. 0 turns trials off.
 * The one place the override is read, so checkout, /user/self, the paywall's
 * 402 body, the MCP gate and the channel gate all name the same number.
 */
export function baseTrialDays(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[RAZORPAY_TRIAL_DAYS_ENV];
  if (configured === undefined || configured === '') return TRIAL_DAYS;
  // Anything that is not a positive number (0, -1, "abc") means no trial,
  // as subscribe() always read it; 0 rather than NaN, so a 402 body or
  // /user/self never carries NaN.
  const n = Number(configured);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The trial the Free plan sunset notice promised. On 21 Oct 2026 (20 Oct
 * 19:02 UTC) scripts/notify-free-plan-sunset.ts emailed 25 owners of
 * grandfathered Free workspaces "start the 7-day trial", a day before the
 * trial went to 3. Those workspaces still get 7 days: the notice was a
 * written promise, and each of them can start only one trial (allowTrial).
 *
 * Which workspaces: the sent-once rows the notice wrote, UsedCodes
 * `notice:free_plan_sunset:<userId>` on the recipient's first named
 * workspace (orgId), created before SUNSET_NOTICE_7_DAY_BEFORE. A workspace
 * qualifies when the row is on it, or the row is for one of its owners
 * (SUPERADMIN) and the workspace existed when the row was written: the email
 * named every affected workspace its owner had. On 22 Oct every one of the
 * 25 recipients owned exactly one workspace, the one the row is on. A notice
 * sent after this date says TRIAL_DAYS (free-plan-sunset.template.ts) and
 * gets TRIAL_DAYS.
 */
export const SUNSET_NOTICE_TRIAL_DAYS = 7;
/** Notices written before this said SUNSET_NOTICE_TRIAL_DAYS. */
export const SUNSET_NOTICE_7_DAY_BEFORE = new Date('2026-10-22T00:00:00.000Z');
/** The sent-once code prefix of the sunset notice (notify-free-plan-sunset.ts). */
export const SUNSET_NOTICE_CODE_PREFIX = 'notice:free_plan_sunset:';

/**
 * The trial length for one workspace: `base` (baseTrialDays: TRIAL_DAYS, or
 * RAZORPAY_TRIAL_DAYS), or SUNSET_NOTICE_TRIAL_DAYS for
 * a workspace the sunset notice promised it to. Trials switched off
 * (base 0) stay off for everyone.
 */
export function trialDaysFor(
  p: { sunsetNoticePromised?: boolean | null },
  base: number = baseTrialDays()
): number {
  if (!(base > 0) || !p.sunsetNoticePromised) return base;
  return Math.max(base, SUNSET_NOTICE_TRIAL_DAYS);
}

/**
 * A trial length as /user/self or a 402 body sends it (trialDays), or
 * TRIAL_DAYS when it is absent or not a positive number (an older backend,
 * a body without one).
 */
export function knownTrialDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : TRIAL_DAYS;
}

/**
 * How many posts a free_posts workspace may create before it chooses a plan.
 * A post is what one Save in the composer makes: every channel it goes to,
 * with its comments and thread replies, is ONE post. Hookpost stores a
 * separate `group` per channel (PostsRepository.createOrUpdatePost makes a
 * new one for each channel on every save), so `group` cannot tell one
 * three-channel post from three posts; the channels of one post share its
 * publishDate instead, and that is what is counted (freePostKey). A post
 * counts while it is not deleted, and for good once it went out (published,
 * reminder sent, posted by hand), so deleting a published post does not give
 * the free post back. Drafts count: they are posts the workspace created.
 * Known limit: moving one channel of a post to another time on the calendar
 * (changeDate moves one row) makes it count as two; it never lets a
 * workspace past the limit.
 */
export const FREE_POST_LIMIT = 3;

/**
 * The key one post's rows share, for FREE_POST_LIMIT: its publishDate to the
 * minute, which every channel of one save is given (PostsService.createPost).
 */
export function freePostKey(publishDate: Date | string): string {
  const d = new Date(publishDate);
  if (Number.isNaN(d.getTime())) return String(publishDate);
  return d.toISOString().slice(0, 16);
}

/**
 * How many posts a free_posts workspace has used, from its root post rows.
 * One save gives each of its channels one row at the same minute
 * (freePostKey), so for each minute the post count is the most rows any ONE
 * channel has at it: three channels at 10:30 are one post, and two saves to
 * the same channel at 10:30 are two. Until 1 Nov 2026 every minute counted
 * once, whatever it held, so any number of posts saved for the same minute
 * cost one free post (found by the billing sandbox, scenario s0). Rows with
 * no channel are counted one each. Two saves at one minute to two DIFFERENT
 * channels count as one: that is exactly what one save to both would have
 * made, so it gives nothing a single post could not.
 */
export function freePostsUsed(
  rows: ReadonlyArray<{ publishDate: Date | string; integrationId: string | null }>
): number {
  const perMinute = new Map<string, Map<string, number>>();
  let unattached = 0;
  for (const row of rows) {
    if (!row.integrationId) {
      unattached++;
      continue;
    }
    const key = freePostKey(row.publishDate);
    const channels = perMinute.get(key) ?? new Map<string, number>();
    channels.set(row.integrationId, (channels.get(row.integrationId) ?? 0) + 1);
    perMinute.set(key, channels);
  }
  let used = unattached;
  for (const channels of perMinute.values()) used += Math.max(...channels.values());
  return used;
}

/** How many of a free_posts workspace's FREE_POST_LIMIT posts are left. */
export function freePostsLeft(used: number): number {
  return Math.max(0, FREE_POST_LIMIT - Math.max(0, Math.floor(used || 0)));
}

/**
 * Whether a free_posts workspace may still create a post: one that is not
 * new (an edit of a post it already has) always, a new one while fewer than
 * FREE_POST_LIMIT are used.
 */
export function freePostAllowed(used: number, isNewPost: boolean): boolean {
  return !isNewPost || freePostsLeft(used) > 0;
}

/**
 * FREE POSTS ARE GIVEN ONCE (29 Oct 2026, the owner's call). A new email
 * gives a new workspace, so without more FREE_POST_LIMIT was 3 posts per
 * email. Three guards, as Buffer and Canva do it; none blocks a sign-up, and
 * the posts are still counted per workspace as above:
 *
 * 1. A channel (Integration providerIdentifier + internalId) gives free posts
 *    once. A free_posts workspace whose save puts a post on a channel (a new
 *    post, or an edit moving one there) that is, or ever was (removed
 *    channels and deleted accounts too), connected in another workspace that
 *    is "spent" is refused FREE_POSTS_USED with reusedChannelMessage
 *    (SubscriptionService.assertFreePostAllowed). Spent: it has at least one
 *    post counted as FREE_POST_LIMIT counts them, or has had a trial or a
 *    plan (SubscriptionRepository SPENT_FREE_POSTS_WORKSPACE), so whichever
 *    workspace uses the account first keeps it. One of our own workspaces
 *    (internalWorkspace) is not refused.
 * 2. A sign-up whose emailIdentity is that of an existing user in a spent
 *    workspace, or whose address is that of a deleted account that was in
 *    one, starts locked: allowTrial false, no free posts
 *    (OrganizationService.createOrgAndUser).
 * 3. So does a sign-up from a disposable email domain (disposable.email.ts
 *    disposableEmail: the vendored open-source list plus an allow-list).
 *
 * Workspaces created before this applied keep the posts they have; a refusal
 * only ever applies to a new post.
 *
 * WHAT STOPS WHILE A PAYMENT IS FAILING (29 Oct 2026, the owner's call).
 * A trial's first charge and a paid plan's renewal are treated alike, whether
 * or not anything was ever paid: the workspace is `dunning`, and only what
 * costs Hookpost money per use goes off, AI generations and X
 * (allowsVariableCostFeatures, allowsXPublishing). Posting to the other
 * channels, scheduling, drafts and media keep working: they cost nothing, and
 * a customer whose bank is still retrying has not left. Razorpay keeps
 * retrying in the background, and subscription.charged / activated clears the
 * marker, so AI and X come back with nobody doing anything - both live trial
 * conversions were captured on such a retry.
 *
 * When Razorpay halts (every retry failed), the plan ends at once with no
 * further grace, never before the time already paid for
 * (RazorpayService.endHaltedUnpaidTrial, scheduleHaltedRenewalEnd), and the
 * workspace falls back to whatever state it has without a plan.
 *
 * `dunning` reads Subscription.paymentFailingSince, persisted by the
 * webhooks, so no publish has to ask Razorpay. A lifetime plan, which has no
 * charge to fail, and one of our own workspaces are never dunning.
 *
 * TRIALS BEHIND A SWITCH (29 Oct 2026, the owner's call: trials stay off,
 * but can be switched on at any time without working the cases out again).
 * TRIAL_CHECKOUT=on (trialCheckoutOn) gives a free_posts workspace a card or
 * UPI AutoPay trial of TRIAL_DAYS when it picks a plan, instead of a charge
 * at once with the first-month offer (checkoutAllowsTrial). Its free posts
 * stay as they are. Off (unset, production) changes nothing anywhere: the
 * grandfathered needs_trial workspaces keep the trial they were promised
 * either way. With it on, every case decided on 29 Oct holds, and the specs
 * run the billing suite both ways (CI step unit-trial-on):
 *
 *  - Card or UPI upfront: the mandate is approved at checkout (start_at =
 *    now + TRIAL_DAYS, RazorpayService.subscribe), nothing is charged until
 *    then; the welcome email states the charge, a reminder goes out before.
 *  - First charge fails: `dunning` above (only AI and X off) while Razorpay
 *    retries; a retry that succeeds restores them; halted ends the trial now
 *    (endHaltedUnpaidTrial) and the workspace is `locked`.
 *  - Cancel during the trial: Razorpay is stopped at once, nothing is ever
 *    charged, the workspace keeps working to the trial's end (cancelAt) with
 *    AI and X off at once (paidUntilCancelAt), then `locked`. A mandate the
 *    customer revokes in their UPI app is the same cancel (handleCancelled).
 *  - Refund or chargeback, during or after the trial: the plan ends now
 *    (endRefundedSubscription, endDisputedSubscription); a dispute locks the
 *    workspace (workspaceDisputed).
 *  - Upgrade or downgrade during the trial: a new mandate on the new plan
 *    from the same first-charge date, nothing charged early
 *    (switchPlanDuringTrial).
 *  - Once per person: allowTrial goes false with the first trial or plan, a
 *    sign-up under a known email identity or a disposable domain starts
 *    locked, and at checkout a workspace tied to one that has had a trial,
 *    a paid plan or the first-month offer, by an owner's email identity, a
 *    channel or a card or UPI ID, gets no trial (SubscriptionService
 *    trialUsedByPerson, personHadBefore). A second trial approved anyway
 *    (two checkouts side by side; a card or UPI ID known only once it
 *    approves) is refused at approval: its mandate is cancelled at once,
 *    nothing is charged, the workspace is locked and told
 *    (SubscriptionService.refuseTrialAtApproval).
 */


const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * One person's address, however they spell it: lower case, without a +tag on
 * any domain, and for Gmail without dots and with googlemail.com as
 * gmail.com, which Gmail all delivers to the same inbox. Null for something
 * that is not an address (wallet and Farcaster ids).
 */
export function emailIdentity(email: string | null | undefined): string | null {
  const lower = (email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return null;
  let local = lower.slice(0, at).split('+')[0];
  let domain = lower.slice(at + 1);
  if (!local || !domain) return null;
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local ? `${local}@${domain}` : null;
}

// disposableEmail moved to disposable.email.ts (server-only, the vendored
// open-source list; owner item 12, 1 Nov 2026).

/**
 * The FREE_POSTS_USED message for a save to a channel that already gave its
 * free posts in another workspace (guard 1 above). `provider` is the
 * provider's name as the app shows it ("Instagram", "LinkedIn").
 */
export function reusedChannelMessage(provider: string): string {
  const name = (provider || '').trim() || 'social';
  return `This ${name} account has already used its free posts on Hookpost. Pick a plan to keep posting from it. Your other connected accounts are not affected.`;
}

/**
 * FREE_POSTS_USED when the signed-in user is a member of the workspace where
 * this account used its free posts and that workspace still has some left
 * (owner, 29 Oct 2026, item 11): name it, so they can switch to it. Only
 * ever for a workspace the user belongs to (PostsController); every other
 * case is reusedChannelMessage, which names no workspace.
 */
export function freePostsLeftElsewhereMessage(
  provider: string,
  workspace: string,
  left: number
): string {
  const name = (provider || '').trim() || 'social';
  const posts = `${left} free post${left === 1 ? '' : 's'}`;
  return `Your workspace "${workspace}" still has ${posts} with this ${name} account. Switch to it from the workspace menu to use them, or pick a plan to post from here.`;
}

/**
 * What the gate says, in the 402 body and in the orchestrator's post error.
 * TRIAL_REQUIRED stopped saying "connect channels" on 25 Oct 2026: a
 * needs_trial workspace now connects its first channel before the trial
 * (PRE_TRIAL_CHANNEL_LIMIT) and is told this when it tries to post.
 */
export const PLAN_GATE_MESSAGES: Record<PlanGateCode, string> = {
  TRIAL_REQUIRED: `Start your ${TRIAL_DAYS}-day trial to schedule and publish posts.`,
  PLAN_REQUIRED: 'Choose a plan to continue.',
  // No offer here: it applies to rupee monthly plans only, so the plans page
  // adds it where the checkout carries it (first.month.offer.ts).
  FREE_POSTS_USED: `You've used your ${FREE_POST_LIMIT} free posts. Pick a plan to keep posting.`,
};

/**
 * PLAN_GATE_MESSAGES for one workspace: TRIAL_REQUIRED names its own trial
 * length (trialDaysFor), so a workspace promised 7 days is not told 3.
 */
export function planGateMessage(
  code: PlanGateCode,
  days: number = TRIAL_DAYS
): string {
  return code === 'TRIAL_REQUIRED' && days !== TRIAL_DAYS && days > 0
    ? `Start your ${days}-day trial to schedule and publish posts.`
    : PLAN_GATE_MESSAGES[code];
}

/**
 * How many channels a workspace that has to start its trial (needs_trial)
 * may connect before it does. Since 25 Oct 2026 a new sign-up connects its
 * first channel and only then sees the card or UPI step: 19 ad sign-ups had
 * reached the paywall with nothing connected and all of them left. The trial
 * still comes before any post: scheduling, publishing, AI and everything
 * else answer TRIAL_REQUIRED (planGate) exactly as before.
 *
 * Enforced where a channel is created, not only where the connect link is
 * handed out: the OAuth callback (social-connect) and the page pick of a
 * two-step login (IntegrationService.saveProviderPage) count again.
 */
export const PRE_TRIAL_CHANNEL_LIMIT = 1;

/**
 * PRE_TRIAL_CHANNEL_LIMIT for a workspace that has to start its trial, else
 * null: locked has used its trial and must choose a plan first, and every
 * other state has its plan's (or the Free plan's) own allowance.
 */
export function preTrialChannelLimit(state: PlanState): number | null {
  return state === 'needs_trial' ? PRE_TRIAL_CHANNEL_LIMIT : null;
}

/** The 402 message for a connect past PRE_TRIAL_CHANNEL_LIMIT. */
export function preTrialChannelMessage(days: number = TRIAL_DAYS): string {
  const n = PRE_TRIAL_CHANNEL_LIMIT;
  return `You can connect ${n} channel${
    n === 1 ? '' : 's'
  } before your trial starts. Start your ${
    days > 0 ? days : TRIAL_DAYS
  }-day trial to connect more and schedule posts.`;
}

/**
 * Where a workspace whose last charge failed (pending or halted, `dunning`)
 * pays from a different UPI app or card: Billing opens Change payment method,
 * a new mandate charged on approval (RazorpayService.startReplacementMandate).
 * The failure email's button and the banner in the app both link here.
 */
export const PAY_FROM_ANOTHER_ACCOUNT_PATH = '/billing?pay=another-account';

/**
 * MEDIA RETENTION AFTER A PLAN ENDS (owner, 29 Oct 2026: "jo user cancel karke
 * jaayenge unka data lifetime pada rahega, unka bhi koi policy hona chahiye").
 * A workspace left without a plan keeps its posts, channels and settings, but
 * the media of its unpublished posts (QUEUE, DRAFT, ERROR, REMINDER_SENT) and
 * its media library uploads are removed from storage this many days after it
 * is told so (MediaRetentionService). The notice goes out the day the plan
 * ends, a reminder MEDIA_RETENTION_REMINDER_DAYS before the removal, and
 * buying a plan again at any time before it stops the clock.
 */
export const MEDIA_RETENTION_AFTER_END_DAYS = 30;
export const MEDIA_RETENTION_REMINDER_DAYS = 7;

/** The rule as the privacy policy, the terms and the cancellation policy state it. */
export const MEDIA_RETENTION_POLICY = `When a workspace has no plan (its plan or trial ended, including after a refund or a payment dispute, or its free posts are used up), we keep its posts and media for ${MEDIA_RETENTION_AFTER_END_DAYS} days from the day we email its owner, and send a reminder ${MEDIA_RETENTION_REMINDER_DAYS} days before that date. After that date we delete from our storage the media files of its scheduled, draft and failed posts and the files in its media library, unless another workspace uses them. Post text, published posts and their pictures, connected channels and settings stay. Choosing a plan before the date keeps everything.`;

/** What a workspace without a plan keeps, for emails and Billing copy. */
export const MEDIA_KEPT_LINE = `your channels and posts are kept, and their media files for ${MEDIA_RETENTION_AFTER_END_DAYS} days`;

/** What a workspace that loses its plan becomes, in emails and on Billing. */
export const PAUSED_WORKSPACE_LINE = `Your workspace is paused; ${MEDIA_KEPT_LINE}. Choose a plan to keep everything.`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When media told about at `from` may be removed: the email names the
 * calendar day `days` after `from` (UTC), and the removal waits until that
 * day is over everywhere on Earth (UTC-12), so no reader in any time zone
 * loses a file on or before the date they were given.
 */
export function mediaRemoveAt(
  from: Date,
  days: number = MEDIA_RETENTION_AFTER_END_DAYS
): Date {
  const day = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate() + days
  );
  return new Date(day + DAY_MS + 12 * 60 * 60 * 1000);
}

/** Midnight UTC of the day the emails name for a removal at `removeAt`. */
function mediaKeptUntilDay(removeAt: Date): number {
  return removeAt.getTime() - DAY_MS - 12 * 60 * 60 * 1000;
}

/**
 * From when the reminder is due: the start (UTC) of the day
 * MEDIA_RETENTION_REMINDER_DAYS before the named day, so a reminder sent on
 * time names the same date as the notice (mediaRemoveAt from it lands on
 * `removeAt` exactly).
 */
export function mediaReminderFrom(removeAt: Date): Date {
  return new Date(
    mediaKeptUntilDay(removeAt) - MEDIA_RETENTION_REMINDER_DAYS * DAY_MS
  );
}

/** The day the emails name for a removal at `removeAt` ("1 December 2026"). */
export function mediaKeptUntilLabel(removeAt: Date): string {
  return new Date(mediaKeptUntilDay(removeAt)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Whether a workspace in this plan state is on the media retention clock.
 * Only a workspace with nothing to post on: `locked` (its plan or trial
 * ended, or a chargeback ended it) and `needs_trial` (a grandfathered Free
 * plan the sunset ended, never paid). A `free_posts` workspace that never
 * paid only once its free posts are spent and nothing of it is still
 * scheduled, because until then it is still using them. Never one with a
 * plan (active, trialing, cancelling, dunning, lifetime), one on the Free
 * plan, or one of our own (internalWorkspace).
 */
export function onMediaRetentionClock(
  state: PlanState,
  facts: { internal: boolean; freePostsSpent?: boolean }
): boolean {
  if (facts.internal) return false;
  if (state === 'locked' || state === 'needs_trial') return true;
  if (state === 'free_posts') return !!facts.freePostsSpent;
  return false;
}

// YYYY-MM-DDTHH:MM, optional :SS and .fraction, then Z or +00:00 / -00:00.
const ISO_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]00:?00)$/;

type Env = Record<string, string | undefined>;
type Log = (message: string) => void;

const defaultLog: Log = (m) => console.error(m);

// One log line per bad value, not one per request: this runs on every
// permission check and every publish.
const reported = new Set<string>();

/** For tests: let the same bad value be reported again. */
export function resetTrialPolicyWarnings() {
  reported.clear();
}

function report(log: Log, key: string, message: string) {
  if (reported.has(key)) return;
  reported.add(key);
  log(message);
}

/**
 * One cutoff, or null when it is unset or unusable. Strict: a calendar date
 * that does not exist (2026-02-30T00:00Z) is rejected rather than rolled over
 * the way Date would.
 */
export function parseTrialCutoff(
  name: string,
  raw: string | undefined | null,
  log: Log = defaultLog,
  unsetMeans = 'so no workspace is required to start a trial'
): Date | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  const m = ISO_UTC.exec(value);
  const parsed = m ? new Date(value.replace(/[+-]00:?00$/, 'Z')) : null;
  const valid =
    !!m &&
    !!parsed &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(m[1]) &&
    parsed.getUTCMonth() + 1 === Number(m[2]) &&
    parsed.getUTCDate() === Number(m[3]) &&
    parsed.getUTCHours() === Number(m[4]) &&
    parsed.getUTCMinutes() === Number(m[5]);

  if (!valid) {
    report(
      log,
      `${name}=${value}`,
      `${name}="${value}" is not a UTC timestamp like 2026-10-20T05:30:00Z; treating it as unset, ${unsetMeans}.`
    );
    return null;
  }
  if (parsed!.getTime() < TRIAL_CUTOFF_FLOOR.getTime()) {
    report(
      log,
      `${name}=${value}`,
      `${name}="${value}" is before ${TRIAL_CUTOFF_FLOOR.toISOString()}; treating it as unset, ${unsetMeans}.`
    );
    return null;
  }
  return parsed!;
}

/**
 * Whether the dollar checkout sells to everyone outside India: USD_CHECKOUT is
 * exactly "on" (trimmed, any case) and GST_LUT_ARN is not empty. The same rule
 * as usdOnForEveryone() in billing.currency.ts, which decides what checkout
 * charges (billing.currency.spec.ts checks the two agree); kept here so this
 * file stays import-free for the lead-drip bundle. Off, allowlist, a typo, or
 * "on" without an LUT all mean rupees for everyone, so false.
 */
export function usdRailLive(env: Env = process.env): boolean {
  const mode = String(env.USD_CHECKOUT ?? '').trim().toLowerCase();
  return mode === 'on' && !!String(env.GST_LUT_ARN ?? '').trim();
}

/** Both cutoffs, from the environment as it is now. */
export function trialCutoffs(
  env: Env = process.env,
  log: Log = defaultLog
): TrialCutoffs {
  const usdLive = usdRailLive(env);
  let global = parseTrialCutoff(
    TRIAL_CUTOFF_ENV.GLOBAL,
    env[TRIAL_CUTOFF_ENV.GLOBAL],
    log
  );
  if (global && !usdLive) {
    // Fail open, like a bad value: the only checkout these workspaces would
    // get is the rupee one, never proven for a buyer abroad.
    report(
      log,
      `${TRIAL_CUTOFF_ENV.GLOBAL}:usd-off`,
      `${TRIAL_CUTOFF_ENV.GLOBAL} is set, but the dollar checkout is not selling (that needs USD_CHECKOUT=on and GST_LUT_ARN set); treating it as unset, so workspaces outside India keep the Free plan.`
    );
    global = null;
  }
  return {
    IN: parseTrialCutoff(TRIAL_CUTOFF_ENV.IN, env[TRIAL_CUTOFF_ENV.IN], log),
    GLOBAL: global,
    excluded: excludedCountries(env, log),
    usdLive,
    sunset: parseTrialCutoff(
      FREE_PLAN_SUNSET_ENV,
      env[FREE_PLAN_SUNSET_ENV],
      log,
      'so the Free plan does not end for any workspace'
    ),
    sunsetExempt: sunsetExemptOrgs(env),
  };
}

/** FREE_PLAN_SUNSET_EXEMPT_ORGS: org ids, separated by commas or spaces. */
export function sunsetExemptOrgs(env: Env = process.env): Set<string> {
  return new Set(
    String(env[FREE_PLAN_SUNSET_EXEMPT_ENV] ?? '')
      .split(/[\s,;]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/**
 * One line for the startup log: the cutoffs this process will apply and the
 * keys that decide them. The backend and the orchestrator each print it, so a
 * process left on an old environment (the orchestrator runs on PM2's saved env
 * unless it is restarted with .env sourced) shows up as two different lines.
 * GST_LUT_ARN is reported as set or empty, never printed.
 */
export function describeTrialPolicy(
  env: Env = process.env,
  log: Log = defaultLog
): string {
  const c = trialCutoffs(env, log);
  const at = (d: Date | null) => (d ? d.toISOString() : 'unset');
  const excluded = [...(c.excluded ?? [])].sort();
  return [
    `Trial policy: IN cutoff ${at(c.IN)}`,
    `GLOBAL cutoff ${at(c.GLOBAL)}${
      !c.GLOBAL && String(env[TRIAL_CUTOFF_ENV.GLOBAL] ?? '').trim()
        ? ' (set but not applied)'
        : ''
    }`,
    `USD_CHECKOUT=${String(env.USD_CHECKOUT ?? '').trim() || 'unset'}`,
    `GST_LUT_ARN ${String(env.GST_LUT_ARN ?? '').trim() ? 'set' : 'empty'}`,
    `USD rail ${c.usdLive ? 'live' : 'off'}`,
    `USD_EXCLUDED_COUNTRIES ${excluded.length ? excluded.join(',') : 'none'}`,
    `${FREE_PLAN_SUNSET_ENV} ${at(c.sunset ?? null)}${
      c.sunset ? ` (${c.sunsetExempt?.size ?? 0} exempt orgs)` : ''
    }`,
    `${TRIAL_CHECKOUT_ENV} ${trialCheckoutOn(env) ? 'on' : 'off'}`,
  ].join('; ');
}

/** The countries the USD rail does not sell to (PR-4 of the plan). */
export const USD_EXCLUDED_ENV = 'USD_EXCLUDED_COUNTRIES';

const EU27 = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
];

/**
 * Names USD_EXCLUDED_COUNTRIES accepts besides ISO codes, so the CA's answer
 * ("EU27, EEA, GB") can be pasted as it is. UK and EL are the names the UK
 * and Greece go by in VAT rules; Cloudflare reports them as GB and GR.
 */
const COUNTRY_GROUPS: Record<string, string[]> = {
  EU: EU27,
  EU27,
  EEA: [...EU27, 'IS', 'LI', 'NO'],
  UK: ['GB'],
  EL: ['GR'],
};

/**
 * USD_EXCLUDED_COUNTRIES, read on every call: ISO 3166 alpha-2 codes or the
 * group names above, separated by commas or spaces, any case. A token that
 * is neither is logged and skipped.
 */
export function excludedCountries(
  env: Env = process.env,
  log: Log = defaultLog
): Set<string> {
  const out = new Set<string>();
  for (const token of String(env[USD_EXCLUDED_ENV] ?? '').split(/[\s,;]+/)) {
    const t = token.trim().toUpperCase();
    if (!t) continue;
    const group = COUNTRY_GROUPS[t];
    if (group) {
      group.forEach((c) => out.add(c));
    } else if (/^[A-Z]{2}$/.test(t)) {
      out.add(t);
    } else {
      report(
        log,
        `${USD_EXCLUDED_ENV}:${t}`,
        `${USD_EXCLUDED_ENV} has "${t}", which is not a two-letter country code or one of ${Object.keys(COUNTRY_GROUPS).join(', ')}; it is ignored.`
      );
    }
  }
  return out;
}

/** Is either cutoff set? When not, nothing in this file changes anything. */
export function trialPolicyActive(
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  return !!cutoffs.IN || !!cutoffs.GLOBAL;
}

/** An ISO 3166 alpha-2 code, upper-cased, or null. */
function countryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const c = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

/** A browser IANA timezone that only India uses. */
function tzIsIndia(tz: unknown): boolean {
  if (typeof tz !== 'string') return false;
  const t = tz.trim().toLowerCase();
  return t === 'asia/kolkata' || t === 'asia/calcutta';
}

/** Where the workspace is, as far as the policy is concerned. */
export interface CountryHints {
  /**
   * signupCountry of the workspace's first SUPERADMIN (the person who created
   * it). Recorded from Cloudflare on their first signed-in request; every
   * signup since 10 Oct 2026 has one.
   */
  ownerCountry?: string | null;
  /**
   * The country Cloudflare reports for this request (trustedCountry). Only
   * pass it on the owner's own browser requests, never from MCP or the public
   * API, where the caller is a server somewhere else.
   */
  requestCountry?: string | null;
  /** The browser's IANA timezone, where the page sent one. */
  tz?: string | null;
}

/**
 * The workspace's country: the owner's signup country, then the request's
 * trusted country, then the timezone (only Asia/Kolkata says anything), else
 * null, which counts as GLOBAL. User.timezone is not used: it is 0 for every
 * account, nothing ever writes it.
 */
export function orgCountry(hints: CountryHints): string | null {
  return (
    countryCode(hints.ownerCountry) ||
    countryCode(hints.requestCountry) ||
    (tzIsIndia(hints.tz) ? 'IN' : null)
  );
}

export function trialGroup(country: string | null): TrialGroup {
  return country === 'IN' ? 'IN' : 'GLOBAL';
}

/** The plan a workspace has on file, as far as the policy needs it. */
export interface PolicySubscription {
  isLifetime?: boolean | null;
  cancelAt?: Date | string | null;
  deletedAt?: Date | string | null;
  /** "sub_..." for Razorpay, "gumroad:..." and "apimkt:..." for the others. */
  identifier?: string | null;
  /**
   * Subscription.paymentFailingSince: when the provider's last charge on this
   * plan started failing, cleared the moment one goes through
   * (RazorpayService). Set means `dunning` (planState), without anything here
   * asking Razorpay on every publish.
   */
  paymentFailingSince?: Date | string | null;
}

export interface PolicyOrg extends CountryHints {
  /** The org id, for FREE_PLAN_SUNSET_EXEMPT_ORGS. */
  id?: string | null;
  createdAt: Date | string;
  allowTrial?: boolean | null;
  isTrailing?: boolean | null;
  subscription?: PolicySubscription | null;
  /**
   * Organization.disputedAt: a bank reported a chargeback on one of this
   * workspace's payments and no super admin has cleared it (see
   * workspaceDisputed).
   */
  disputedAt?: Date | string | null;
  /**
   * A platform super admin (User.isSuperAdmin) is a member: the founder's
   * and reviewers' workspaces, which keep the Free plan after the sunset.
   */
  platformAdmin?: boolean | null;
}

/** The row SubscriptionRepository.getPlanFacts reads for one workspace. */
export interface PlanFactsRow {
  id: string;
  createdAt: Date | string;
  allowTrial?: boolean | null;
  isTrailing?: boolean | null;
  subscription?: PolicySubscription | null;
  /** Organization.disputedAt (see workspaceDisputed). */
  disputedAt?: Date | string | null;
  /** The first SUPERADMIN member, with their signup country. */
  users?: Array<{ user?: { signupCountry?: string | null } | null }> | null;
  /** Members who are platform super admins. */
  _count?: { users?: number | null } | null;
}

/**
 * The workspace as this file sees it, from getPlanFacts. `hints` are the
 * request's own country and timezone, used only when the owner has no signup
 * country on file. Shared by SubscriptionService.getPolicyOrg and
 * IntegrationService, which cannot inject SubscriptionService (that service
 * injects IntegrationService), so both read a workspace's plan state alike.
 */
export function policyOrgFromFacts(
  facts: PlanFactsRow,
  hints: Pick<CountryHints, 'requestCountry' | 'tz'> = {}
): PolicyOrg {
  return {
    id: facts.id,
    createdAt: facts.createdAt,
    allowTrial: facts.allowTrial,
    isTrailing: facts.isTrailing,
    subscription: facts.subscription,
    disputedAt: facts.disputedAt ?? null,
    ownerCountry: facts.users?.[0]?.user?.signupCountry ?? null,
    platformAdmin: (facts._count?.users ?? 0) > 0,
    requestCountry: hints.requestCountry ?? null,
    tz: hints.tz ?? null,
  };
}

/** The workspace's Subscription row, when it is live (not soft-deleted). */
function liveRow(org: PolicyOrg): PolicySubscription | null {
  const s = org.subscription;
  return s && !s.deletedAt ? s : null;
}

/**
 * Where a plan on file comes from, so nothing has to guess from a row:
 *
 *  - razorpay     a Razorpay subscription (identifier `sub_...`), the only
 *                 plan that is ever charged by us;
 *  - order        one paid month of the plan, a one-time Razorpay order
 *                 (`order_...`, one.time.plan.ts); ends at its cancelAt;
 *  - gumroad      bought on Gumroad (`gumroad:<saleId>`);
 *  - marketplace  an api.market or RapidAPI plan (`apimkt:...`);
 *  - lifetime     isLifetime;
 *  - gift         anything else: a plan an admin gave with Restore plan
 *                 (`restored-...`) or added by hand, with no payment behind
 *                 it. Shown as "Free <tier> until <date>", never as Paying,
 *                 and it ends at its cancelAt (planLapsed).
 *
 * Null for no live row.
 */
export type PlanSource = 'razorpay' | 'order' | 'gumroad' | 'marketplace' | 'lifetime' | 'gift';

export function planSource(
  sub: Pick<PolicySubscription, 'deletedAt' | 'isLifetime' | 'identifier'> | null | undefined
): PlanSource | null {
  if (!sub || sub.deletedAt) return null;
  if (sub.isLifetime) return 'lifetime';
  const id = sub.identifier ?? '';
  if (id.startsWith('sub_')) return 'razorpay';
  if (id.startsWith('order_')) return 'order';
  if (id.startsWith('gumroad:')) return 'gumroad';
  if (id.startsWith('apimkt:')) return 'marketplace';
  return 'gift';
}

/**
 * A plan whose end date has passed: it is over now, whatever the row still
 * says. A cancellation, a cancelled trial and the end set for a halted
 * renewal all leave the row on file with a cancelAt, and the hourly sweep
 * (RazorpayService.endLapsedCancellations) is what deletes it. That sweep
 * runs once an hour, so reading only the row's existence gives a workspace up
 * to an hour of plan it no longer has: the post timed a minute after cancelAt
 * went out, and the AI kept its allowance. Every gate compares cancelAt with
 * the moment it runs instead, and the sweep then changes nothing (it only
 * tidies the row and sends the one email it always sent).
 *
 * Only the rows that sweep ends: never a lifetime plan (an odd date on one
 * must not take it away), and never a Gumroad or marketplace plan, whose own
 * sweep asks its store first (a Gumroad buyer who resubscribed has the date
 * lifted there, and ending it here would lock a paying customer until then).
 * A row read without its identifier is still judged by its date, so a caller
 * that did not select it cannot reopen the lag. An unreadable date is not an
 * ending either: fail open, as everywhere else in this file.
 */
export function planLapsed(
  sub: PolicySubscription | null | undefined,
  now: Date = new Date()
): boolean {
  if (!sub || sub.deletedAt || sub.isLifetime || !sub.cancelAt) return false;
  if (sub.identifier != null) {
    const source = planSource(sub);
    if (source !== 'razorpay' && source !== 'order' && source !== 'gift') return false;
  }
  const end = new Date(sub.cancelAt).getTime();
  return Number.isFinite(end) && end <= now.getTime();
}

/**
 * A PAYMENT DISPUTE ENDS THE PLAN (29 Oct 2026, the owner's call). A bank
 * reported a chargeback on one of this workspace's payments
 * (Organization.disputedAt, written by RazorpayService.handleDispute from
 * Razorpay's payment.dispute.* webhooks). A dispute is a refund the customer
 * took by force, plus a fraud signal, so it ends the plan at once exactly as
 * a refund does, and the workspace is held there: no Free plan, no free
 * posts, no trial, and checkout refuses (DISPUTE_CHECKOUT_MESSAGE) until a
 * super admin clears it (POST /admin/workspaces/:id/dispute/clear). Winning
 * the dispute does not clear it by itself: the owner decides.
 *
 * Null means no open dispute, which is every workspace but a disputed one.
 */
export function workspaceDisputed(
  org: Pick<PolicyOrg, 'disputedAt'> | null | undefined
): boolean {
  return !!org?.disputedAt;
}

/** What checkout tells a disputed workspace (BillingController). */
export const DISPUTE_CHECKOUT_MESSAGE =
  'Your account has a payment dispute. Contact support@hookstep.in';

/**
 * Created on or after its group's cutoff. Says nothing about whether it has a
 * plan: a new-cohort workspace with a trial is still new-cohort, and when the
 * trial ends it is paused rather than moved to Free.
 */
export function inTrialCohort(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  if (createdAfterCutoff(org, cutoffs)) return true;
  // Otherwise grandfathered on the Free plan, until the sunset passes.
  return freePlanSunsetPassed(cutoffs) && sunsetEndsFreePlan(org, cutoffs);
}

/**
 * Created on or after its group's cutoff: the new cohort proper, which gets
 * FREE_POST_LIMIT free posts instead of a trial. False for a grandfathered
 * workspace the sunset reached.
 */
export function createdAfterCutoff(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  const cohort = cohortFacts(org, cutoffs);
  return !!cohort && cohort.created >= cohort.cutoff;
}

/**
 * The applied cutoff of the workspace's group and its creation time, or null
 * when nothing about the trial applies to it.
 */
function cohortFacts(
  org: PolicyOrg,
  cutoffs: TrialCutoffs
): { cutoff: number; created: number } | null {
  if (!trialPolicyActive(cutoffs)) return null;
  const country = orgCountry(org);
  const group = trialGroup(country);
  const cutoff = cutoffs[group];
  if (!cutoff) return null;
  // Outside India the trial is only asked for while the dollar checkout is
  // selling, and never in a country it does not sell to: the only checkout
  // such a workspace would get is the rupee one (billing.currency.ts).
  if (group === 'GLOBAL' && cutoffs.usdLive === false) return null;
  if (group === 'GLOBAL' && country && cutoffs.excluded?.has(country)) {
    return null;
  }
  const created = new Date(org.createdAt).getTime();
  // An unreadable createdAt cannot prove the workspace is new: fail open.
  if (Number.isNaN(created)) return null;
  return { cutoff: cutoff.getTime(), created };
}

/** FREE_PLAN_SUNSET_AT is set and the moment compared with is on or after it. */
export function freePlanSunsetPassed(cutoffs: TrialCutoffs = trialCutoffs()): boolean {
  if (!cutoffs.sunset) return false;
  const now = (cutoffs.now ?? new Date()).getTime();
  return now >= cutoffs.sunset.getTime();
}

/**
 * One of our own workspaces: a platform super admin is a member (the founder's
 * and reviewers'), or it is listed in FREE_PLAN_SUNSET_EXEMPT_ORGS (internal,
 * test and Razorpay review workspaces).
 */
export function internalWorkspace(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  if (org.platformAdmin) return true;
  return !!(org.id && cutoffs.sunsetExempt?.has(org.id));
}

/** The sunset is set and this workspace is not exempt from it. */
function sunsetReaches(org: PolicyOrg, cutoffs: TrialCutoffs): boolean {
  if (!cutoffs.sunset) return false;
  return !internalWorkspace(org, cutoffs);
}

/**
 * FREE_PLAN_SUNSET_AT ends this workspace's Free plan: it is not exempt, and
 * by what is on file (the owner's signup country, GLOBAL without one; see the
 * top of this file) its group's cutoff is applied and it was created before
 * it. Says nothing about the plan it is on now.
 */
function sunsetEndsFreePlan(org: PolicyOrg, cutoffs: TrialCutoffs): boolean {
  if (!sunsetReaches(org, cutoffs)) return false;
  const onFile = cohortFacts({ ...org, requestCountry: null, tz: null }, cutoffs);
  return !!onFile && onFile.created < onFile.cutoff;
}

/**
 * When the Free plan this workspace has, or would fall back to when its plan
 * ends, itself ends: FREE_PLAN_SUNSET_AT while it is still ahead and reaches
 * this workspace, whatever plan it is on now. Null otherwise, including after
 * the sunset. Billing's cancel copy and emails use it to say "the Free plan
 * until 27 October 2026" rather than a Free plan with no end.
 */
export function freePlanSunsetAt(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): Date | null {
  if (!sunsetEndsFreePlan(org, cutoffs) || freePlanSunsetPassed(cutoffs)) {
    return null;
  }
  return cutoffs.sunset!;
}

/**
 * When this workspace's Free plan ends, while that is still ahead: it is on
 * the Free plan (no plan on file, created before its group's cutoff), the
 * sunset is set, it is not exempt, and the sunset has not passed. Null for
 * everyone else, including after the sunset, when it is on the paywall.
 */
export function freePlanEndsAt(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): Date | null {
  if (liveRow(org)) return null;
  return freePlanSunsetAt(org, cutoffs);
}

/**
 * The sunset date as the notice and the email print it: "27 October 2026",
 * the calendar day in India, where the business is. For the planned
 * 18:29:59Z that is the same day everywhere west of India and a day early
 * further east, never late.
 */
export function freePlanEndDateLabel(at: Date | string): string {
  return new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Must start a trial (or, with the trial used, choose a plan) before using
 * Hookpost: no live plan, not lifetime, and in the new cohort. Never a
 * disputed workspace (workspaceDisputed): it is locked, and offering it the
 * trial would be inviting it back in through a door the chargeback shut.
 */
export function needsTrial(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  const row = liveRow(org);
  if (row) return false;
  if (workspaceDisputed(org)) return false;
  return inTrialCohort(org, cutoffs);
}

/**
 * Is this plan's charge failing right now? The marker the webhooks persist
 * (paymentFailingSince), or the Razorpay status where the caller has already
 * read it; nothing here reads Razorpay. The marker is what makes the gate
 * work on the publish path, where there is no request to read a status on.
 */
function paymentFailing(
  row: PolicySubscription,
  remoteStatus?: string | null
): boolean {
  if (remoteStatus === 'pending' || remoteStatus === 'halted') return true;
  return !!row.paymentFailingSince;
}

/**
 * The workspace's plan state. Computed, never stored.
 *
 * `remoteStatus` is the Razorpay status of the plan on file where the caller
 * has already read it (pending or halted is dunning); nothing here reads
 * Razorpay.
 *
 * A plan whose cancelAt has passed counts as no plan from that moment on
 * (planLapsed), hours before the sweep gets to the row, which is what makes
 * this the same answer before and after the sweep.
 *
 * A failing charge is `dunning` whether it is a trial's first charge or a
 * renewal: both lose AI and X and keep everything else (see PlanState). It
 * comes before cancelAt, so a workspace that is both cancelling and failing
 * is dunning - the two take the same features away, and dunning is the one
 * the customer can still act on. A lifetime plan has no charge to fail and is
 * never dunning, and neither is one of our own workspaces
 * (internalWorkspace): the founder's and the Razorpay review workspaces must
 * never lose a feature to a test mandate, exactly as they always keep X
 * (allowsXPublishing).
 */
export function planState(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs(),
  remoteStatus?: string | null
): PlanState {
  const row = liveRow(org);
  if (row && !planLapsed(row, cutoffs.now)) {
    if (row.isLifetime) return 'active';
    if (paymentFailing(row, remoteStatus) && !internalWorkspace(org, cutoffs)) {
      return 'dunning';
    }
    if (row.cancelAt) return 'cancelling';
    return org.isTrailing ? 'trialing' : 'active';
  }
  // A chargeback ended the plan (workspaceDisputed): locked, whatever cohort
  // the workspace is in and whether or not the cutoffs are set, so a
  // grandfathered workspace does not fall back to the Free plan on a payment
  // its bank took back. Only an owner's clear lifts it.
  if (workspaceDisputed(org)) return 'locked';
  if (!inTrialCohort(org, cutoffs)) return 'free';
  // allowTrial goes false with the first plan or trial on file
  // (SubscriptionRepository), so a workspace whose plan or trial ended is
  // locked, never given free posts again.
  // A paid one-time month (one.time.plan.ts) that has run out drops back to
  // the free-posts state (the owner, 8 Nov 2026): whatever free posts are
  // left, then "Renew for another month". The sweep that tidies the row
  // gives allowTrial back (SubscriptionService.endOneTimePlan); until it
  // runs, the lapsed row says the same.
  if (!org.allowTrial) {
    return row && planSource(row) === 'order' ? 'free_posts' : 'locked';
  }
  // ONE RULE (4 Nov 2026, the owner: "make single consolidated logic"): a
  // workspace with no plan gets FREE_POST_LIMIT free posts and then picks a
  // plan, whether it signed up after the cutoff or is a grandfathered one the
  // sunset reached. `needs_trial` is no longer produced: the 24 workspaces it
  // held are on free_posts from this deploy on, and the 3 locked after the
  // old card trial without using their posts were given allowTrial back
  // (PlanActionAudit GRANT_FREE_POSTS, 4 Nov 2026).
  return 'free_posts';
}

/**
 * Whether a checkout opened now may start with a trial. A free_posts
 * workspace only while the trial switch is on (trialCheckoutOn, see "TRIALS
 * BEHIND A SWITCH" above); with it off, its first payment is taken at once
 * so the first-month offer applies (Razorpay refuses an offer on a
 * subscription with a start_at). Every other state as before: `allowTrial`
 * decides.
 *
 * Says nothing about the person: SubscriptionService.checkoutAllowsTrial
 * adds the once-per-person checks for a free_posts workspace.
 */
export function checkoutAllowsTrial(
  state: PlanState,
  allowTrial: boolean | null | undefined,
  trialsOn: boolean = trialCheckoutOn()
): boolean {
  if (!allowTrial) return false;
  // `locked` with allowTrial still true is a disputed workspace
  // (workspaceDisputed): the chargeback shut the door, a trial must not open
  // it. Only with the switch on, so nothing moves while trials are off (the
  // dispute already sets allowTrial false, and checkout refuses it).
  if (trialsOn && state === 'locked') return false;
  return state !== 'free_posts' || trialsOn;
}

/**
 * The switch of "TRIALS BEHIND A SWITCH": TRIAL_CHECKOUT is exactly "on"
 * (trimmed, any case). Anything else, unset included, is off, which is
 * production since 28 Oct 2026. Read on every call, like the cutoffs.
 */
export function trialCheckoutOn(env: Env = process.env): boolean {
  return String(env[TRIAL_CHECKOUT_ENV] ?? '').trim().toLowerCase() === 'on';
}

/** needs_trial and locked can sign in and reach Billing, and nothing else. */
export function blocksPlanUse(state: PlanState): boolean {
  return state === 'needs_trial' || state === 'locked';
}

/** The 402 code for a blocked state, or null. */
export function planGateCode(state: PlanState): PlanGateCode | null {
  return state === 'needs_trial'
    ? 'TRIAL_REQUIRED'
    : state === 'locked'
    ? 'PLAN_REQUIRED'
    : null;
}

/**
 * Whether the Free plan exists for this workspace: it does for everyone
 * created before the cutoff (until FREE_PLAN_SUNSET_AT, unless exempt), and
 * never for the new cohort, whose workspace is paused instead when a trial or
 * plan ends. Never for a disputed workspace either (workspaceDisputed): it is
 * paused, so the emails say so rather than offering it the Free plan.
 */
export function freePlanAvailable(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  return !workspaceDisputed(org) && !inTrialCohort(org, cutoffs);
}

/**
 * A plan set to end whose time up to cancelAt was paid for: a paid plan the
 * customer cancelled without a refund (the cancel stops Razorpay and this row
 * keeps the access), a first-month-discount plan, a plan our reconcile
 * stopped at Razorpay early. Everything it paid for stays on until cancelAt,
 * X and AI included (the owner, 29 Oct 2026). Not a cancelled trial: nothing
 * was ever charged (the workspace is still trialing), so the per-call
 * features stop at once. A refund, a chargeback or "end plan now" deletes
 * the row, so they never reach here.
 */
export function paidUntilCancelAt(org: PolicyOrg | null | undefined): boolean {
  const row = org ? liveRow(org) : null;
  return !!row && !!row.cancelAt && !row.isLifetime && !org!.isTrailing;
}

/**
 * Whether the workspace may use the AI features, which cost Hookpost per call
 * (OpenAI text and image generations). X has its own rule, allowsXPublishing.
 *
 * `active` and `trialing` may. A plan set to end (`cancelling`) may only when
 * its time to cancelAt was paid for (paidUntilCancelAt): a cancelled trial
 * that never charged loses AI at once, a paying customer who cancelled keeps
 * it to the end. Without `org` that cannot be told, so `cancelling` is
 * refused: never grant a paid feature on a guess.
 * A plan whose charge is failing (`dunning`) is refused too (allowsAiFeatures,
 * allowsXPublishing): nobody is paying for those calls yet.
 */
export function allowsVariableCostFeatures(
  state: PlanState,
  org?: PolicyOrg | null
): boolean {
  if (state === 'active' || state === 'trialing') return true;
  return state === 'cancelling' && paidUntilCancelAt(org);
}

/**
 * Whether a workspace in this state may use AI right now: the one rule every
 * AI entry point asks (the AI permission, the AI credit meter).
 *
 * A failing payment (`dunning`) always refuses, whatever the trial cutoffs
 * say: that is the owner's rule for failed charges (29 Oct 2026), and it
 * holds on an install with the trial cohorts switched off. The cohort states
 * (`free`, `needs_trial`, a cancelled trial, ...) refuse only while the
 * trial policy is on (`cohortRulesOn`, trialPolicyActive), exactly as before;
 * a paid plan set to end keeps AI to cancelAt (`org`, paidUntilCancelAt).
 */
export function allowsAiFeatures(
  state: PlanState,
  cohortRulesOn: boolean,
  org?: PolicyOrg | null
): boolean {
  if (state === 'dunning') return false;
  return !cohortRulesOn || allowsVariableCostFeatures(state, org);
}

/**
 * The refusal a workspace sees when AI or X is off because its payment is
 * failing (`dunning`). It names the way back: the retry, or paying from
 * another account on Billing.
 */
export const PAYMENT_FAILING_MESSAGE =
  "Your last payment didn't go through, so AI and X are paused until it does. Everything else keeps working. Razorpay retries it automatically, or you can pay from a different account on Billing.";

/**
 * Whether the workspace may connect X and publish to it. X bills Hookpost per
 * post ($0.015, $0.20 with a link), so a trial set to end without ever being
 * charged (`cancelling`, not paidUntilCancelAt) loses X at once, while its
 * other channels keep publishing until cancelAt. A paid plan set to end keeps
 * X to cancelAt like everything else it paid for (the owner, 29 Oct 2026).
 * A plan whose charge is failing (`dunning`) loses X too (29 Oct 2026, the
 * owner's call); it comes back by itself when a retry goes through.
 * Every other state keeps X: active, lifetime and trialing plans, and the
 * Free plan on its posts meter. One of our own workspaces (a platform super
 * admin member, or FREE_PLAN_SUNSET_EXEMPT_ORGS) always keeps it. needs_trial
 * and locked are not refused here: they publish nothing at all, the plan gate
 * (planGate) refuses them on every channel.
 *
 * `org.subscription` must be the Subscription row with cancelAt,
 * paymentFailingSince and deletedAt (SubscriptionService.getPolicyOrg). The
 * bare Organization row has no subscription, which reads as "no plan" for
 * everyone: on 24 Oct 2026 that refused X for every workspace, paid ones
 * included.
 */
export function allowsXPublishing(
  org: PolicyOrg,
  cutoffs: TrialCutoffs = trialCutoffs()
): boolean {
  if (internalWorkspace(org, cutoffs)) return true;
  const state = planState(org, cutoffs);
  if (state === 'dunning') return false;
  return state !== 'cancelling' || paidUntilCancelAt(org);
}
