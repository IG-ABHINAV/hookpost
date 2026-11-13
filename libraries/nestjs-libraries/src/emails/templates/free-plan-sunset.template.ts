/**
 * One-off notice to the owners of grandfathered Free workspaces: their Free
 * plan ends at FREE_PLAN_SUNSET_AT (trial.policy.ts). Sent by
 * scripts/notify-free-plan-sunset.ts, which picks the recipients.
 *
 * Keep it true to the code:
 * - After the date, a workspace without a plan is asked for the trial (or a
 *   plan, once its trial is used) and the orchestrator refuses its posts with
 *   the gate's message, so scheduled posts stop going out. Nothing deletes its
 *   channels or posts.
 * - Delete Account signs the user out, revokes channel and app connections
 *   and cancels scheduled posts at once (UsersService.deleteAccount); what is
 *   erased later is on /data-deletion. The email says only that, and links
 *   the page for the rest. The button opens /auth/login?returnUrl=/settings
 *   (DELETE_PATH): a bare /settings sends a signed-out visitor to
 *   /auth?provider=GITHUB (proxy.ts), which only spins. Signed out, they sign
 *   in and land on /settings; signed in, the login page sends them to
 *   /launches. Either way Delete Account is on screen: before the date in
 *   Global Settings and the Free plan notice, after it on the plans screen,
 *   which then replaces every page and shows it at every width (the Play
 *   app's plan gate too).
 * - Deleting the account deletes every workspace the person owns and cancels
 *   their plans, and there is no way to delete one workspace. So an owner who
 *   also owns a workspace with a live plan (offerDelete false) is not offered
 *   deletion at all: the email names only the affected workspaces and says
 *   the others keep their plans.
 * - Prices come from the pricing tables, in the currency the workspace's
 *   checkout charges (billing.currency.ts): rupees in India, dollars
 *   elsewhere once the dollar checkout sells there. When the owner's country
 *   is unknown both are given.
 *
 * Import-free apart from the layout, the pricing table and the trial policy,
 * so it bundles for plain node like the lead-drip emails.
 */
import {
  buildEmail,
  button,
  escapeHtml,
  heading,
  link,
  paragraph,
  RenderedEmail,
  signoff,
  strong,
} from '../layout/email.layout';
import {
  pricingINR,
  pricingUSD,
} from '../../database/prisma/subscriptions/pricing';
import {
  freePlanEndDateLabel,
  TRIAL_DAYS,
} from '../../database/prisma/subscriptions/trial.policy';

/** Where "Delete my account" goes (see the top of this file). */
export const DELETE_PATH = '/auth/login?returnUrl=%2Fsettings';

/** Which checkout the workspace gets: rupees, dollars, or not known. */
export type SunsetRegion = 'IN' | 'GLOBAL' | 'UNKNOWN';

export interface FreePlanSunsetEmailParams {
  userName?: string | null;
  /** The recipient's grandfathered Free workspaces (usually one). */
  orgNames: string[];
  endsAt: Date;
  region: SunsetRegion;
  /** Organization.allowTrial: the trial (TRIAL_DAYS) is still available to it. */
  canTrial: boolean;
  appUrl: string;
  /**
   * False for an owner who also owns a workspace with a live plan: deleting
   * the account would delete that one too and cancel its plan. Default true.
   */
  offerDelete?: boolean;
}

function priceLine(region: SunsetRegion): string {
  const inr = `₹${pricingINR.STANDARD.month_price.toLocaleString('en-IN')} a month`;
  const usd = `$${pricingUSD.STANDARD.month_price} a month`;
  if (region === 'IN') return `${inr} (UPI or card)`;
  if (region === 'GLOBAL') return `${usd} (card)`;
  return `${inr} in India (UPI or card), or ${usd} elsewhere (card)`;
}

export function freePlanSunsetEmail(
  params: FreePlanSunsetEmailParams
): RenderedEmail {
  const { endsAt, region, canTrial } = params;
  const offerDelete = params.offerDelete !== false;
  const base = params.appUrl.replace(/\/+$/, '');
  const date = freePlanEndDateLabel(endsAt); // 27 October 2026
  const dayMonth = date.replace(/\s+\d{4}$/, ''); // 27 October
  const name = (params.userName || '').trim();
  const orgs = params.orgNames.map((o) => (o || '').trim()).filter(Boolean);
  const several = orgs.length > 1;
  const named = orgs.map((o) => strong(escapeHtml(o))).join(', ');
  const subject = orgs.length
    ? `Your workspace${several ? 's' : ''} ${named} ${several ? 'stay' : 'stays'}`
    : 'Your workspace stays';
  const yours = several ? 'your workspaces' : 'your workspace';

  const keep = canTrial
    ? paragraph(
        `To keep ${yours}, your scheduled posts and your connected channels, start the ${TRIAL_DAYS}-day trial. Standard is then ${escapeHtml(
          priceLine(region)
        )}. Cancel in Billing at least 24 hours before the trial ends and you won't be charged.`
      )
    : paragraph(
        `To keep ${yours}, your scheduled posts and your connected channels, choose a plan. Standard is ${escapeHtml(
          priceLine(region)
        )}, and you can cancel anytime in Billing.`
      );

  const leave = offerDelete
    ? paragraph(
        `If you'd rather leave, you can delete your account. It signs you out, disconnects your channels and cancels your scheduled posts straight away. Here's ${link(
          'what is erased, and when',
          `${base}/data-deletion#what-we-keep`
        )}. The button opens Hookpost (sign in if asked); choose Delete Account there and confirm.`
      ) + button('Delete my account', `${base}${DELETE_PATH}`)
    : '';
  // They own other workspaces, so /billing may open one of those.
  const scope = offerDelete
    ? ''
    : paragraph(
        `This is only about ${named || yours}: your other workspaces and their plans don't change. Pick ${
          several ? 'each of these' : 'it'
        } in the workspace menu at the top of Hookpost before you ${
          canTrial ? 'start the trial' : 'choose a plan'
        }.`
      );
  const orDelete = offerDelete ? ', or delete your account' : '';

  return buildEmail(`Your Hookpost Free plan ends on ${dayMonth}`, {
    preheader: canTrial
      ? `Start the ${TRIAL_DAYS}-day trial to keep posting${orDelete}.`
      : `Choose a plan to keep posting${orDelete}.`,
    kind: 'transactional',
    reason: 'You received this email because you own a Hookpost workspace on the Free plan.',
    body:
      heading(`Your Free plan ends on ${dayMonth}`) +
      paragraph(name ? `Hi ${escapeHtml(name)},` : 'Hi,') +
      paragraph(
        `We're ending Hookpost's Free plan. ${subject} on it until ${strong(
          date
        )}. After that, Hookpost won't publish for ${
          several ? 'them' : 'it'
        } without a plan, so posts scheduled after that date won't go out. Your channels and posts stay in your account.`
      ) +
      keep +
      scope +
      button(canTrial ? `Start my ${TRIAL_DAYS}-day trial` : 'Choose a plan', `${base}/billing`) +
      leave +
      paragraph('Questions? Just reply to this email.', { muted: true, small: true }) +
      signoff('Team Hookpost'),
  });
}
