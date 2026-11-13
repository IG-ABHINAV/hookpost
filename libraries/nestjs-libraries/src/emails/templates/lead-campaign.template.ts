/**
 * Lead nurture drip for free workspaces: day 1, day 3 and day 7 after signup,
 * plus the activation nudges (ACT_*) for people who signed up but never
 * connected a channel, or connected one and never scheduled a post. The
 * timing and the recipient rules live in scripts/lead-campaign/run-lead-drip.js.
 * Sent by scripts/lead-campaign/run-lead-drip.js (cron on the server), which
 * uses an esbuild bundle of this file, so keep imports to import-free modules
 * (the email layout and the pricing table). After changing this file, run
 * scripts/lead-campaign/build-lead-email.sh and commit the regenerated bundle.
 *
 * Prices come from the live pricing table rather than being typed in here, so
 * the email can never quote a price the checkout does not charge. Checkout
 * charges INR only until Phase 2 (PHASE2.md), so every lead gets rupee prices,
 * whatever their IP suggests.
 */
import {
  buildEmail,
  button,
  details,
  escapeHtml,
  heading,
  paragraph,
  signoff,
  steps,
  strong,
} from '../layout/email.layout';
import {
  HOOKPOST_PRICE,
  pricingINR,
  pricingUSD,
} from '../../database/prisma/subscriptions/pricing';

// Re-exported so the drip script gets the signer from the same bundle.
export {
  dripUnsubscribeToken,
  dripUnsubscribeUrl,
  dripUnsubscribeCode,
  readDripUnsubscribeToken,
  DRIP_UNSUBSCRIBE_PREFIX,
} from '../drip-unsubscribe';

export type LeadStage =
  | 'STAGE_1_LAUNCH'
  | 'STAGE_2_FEATURES'
  | 'STAGE_3_FOUNDER'
  | 'ACT_1_CONNECT'
  | 'ACT_2_CONNECT'
  | 'ACT_3_FIRST_POST';

export interface LeadEmailParams {
  userName?: string | null;
  orgName?: string | null;
  email: string;
  // Ignored until Phase 2 (PHASE2.md): checkout charges INR only, so the email
  // always quotes rupees. Kept so run-lead-drip.js and the previews still type.
  currency?: 'INR' | 'USD';
  stage: LeadStage;
  discountCode?: string;
  appUrl?: string;
  /** Signed one-click unsubscribe link (dripUnsubscribeUrl). Falls back to mailto. */
  unsubscribeUrl?: string;
}

// What the LAUNCH50 coupon row in prod does (scripts/create-launch50.ts):
// percentOff 50 buys a half-price Razorpay plan, so every payment of that
// subscription is discounted, on any paid tier; it applies to new
// subscriptions only, expires at the end of 31 Dec 2026 and stops after 100
// workspaces. Keep this copy in step with that row.
const DISCOUNT_PERCENT = 50;
const CODE_TERMS = `${DISCOUNT_PERCENT}% off every payment, for the first 100 workspaces that subscribe by 31 Dec 2026`;

function money(amount: number, isINR: boolean): string {
  // Half of Rs 599 is Rs 299.50, which is what checkout charges
  const options = Number.isInteger(amount)
    ? {}
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return isINR
    ? `₹${amount.toLocaleString('en-IN', options)}`
    : `$${amount.toLocaleString('en-US', options)}`;
}

export function generateLeadEmail(params: LeadEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const {
    userName,
    orgName,
    email,
    stage,
    discountCode = 'LAUNCH50',
    appUrl = 'https://hookpost.hookstep.in',
  } = params;

  const displayName = userName || (email ? email.split('@')[0] : 'there');
  // The one plan on sale, at the price every page shows (pricing.ts
  // HOOKPOST_PRICE: $7 shown, charged in INR at checkout). No rupee figure.
  const plan = pricingUSD.HOOKPOST;
  const monthly = money(HOOKPOST_PRICE.displayUsd, false);
  void pricingINR;
  const name = escapeHtml(displayName);
  const code = escapeHtml(discountCode);
  const base = appUrl.replace(/\/+$/, '');
  const unsubscribeUrl =
    params.unsubscribeUrl || 'mailto:support@hookstep.in?subject=Unsubscribe';
  // Opens the app on the "Connect Channels" step (components/onboarding).
  const connectUrl = `${base}/launches?onboarding=true`;
  const founder = signoff('Mohan Bhanushali', 'Founder, Hookpost');

  if (stage === 'ACT_1_CONNECT') {
    return buildEmail('Connect your first channel in 2 minutes', {
      preheader: 'Hookpost can only post once a channel is connected. Here is the quickest way.',
      kind: 'marketing',
      unsubscribeUrl,
      body:
        paragraph(`Hi ${name},`) +
        paragraph(
          `Thanks for signing up for Hookpost. One thing is missing before it can post anything for you: a connected channel.`
        ) +
        paragraph(
          `Pick LinkedIn, Instagram, Facebook, X or YouTube, sign in to it, and you're done. It takes about two minutes, and you can disconnect any time.`
        ) +
        button('Connect a channel', connectUrl) +
        paragraph(
          'Stuck on a login screen or a permission? Reply to this email and tell me where. I read every reply.',
          { muted: true, small: true }
        ) +
        founder,
    });
  }

  if (stage === 'ACT_2_CONNECT') {
    return buildEmail('Still want to schedule posts with Hookpost?', {
      preheader: 'Your workspace has no channel yet. Two minutes fixes that.',
      kind: 'marketing',
      unsubscribeUrl,
      body:
        paragraph(`Hi ${name},`) +
        paragraph(
          `Your Hookpost workspace still has no channel connected, so nothing can be scheduled yet.`
        ) +
        paragraph(
          `Most people start with one account, usually LinkedIn or Instagram, and add the rest later. Once it's connected, write one post and Hookpost sizes it for each channel.`
        ) +
        button('Connect your first channel', connectUrl) +
        paragraph(
          `If Hookpost isn't what you were looking for, a one-line reply telling me why would help a lot.`,
          { muted: true, small: true }
        ) +
        founder,
    });
  }

  if (stage === 'ACT_3_FIRST_POST') {
    return buildEmail('Your channel is connected. Schedule your first post?', {
      preheader: 'Write it once, pick a time, and Hookpost publishes it for you.',
      kind: 'marketing',
      unsubscribeUrl,
      body:
        paragraph(`Hi ${name},`) +
        paragraph(
          `You've connected a channel to Hookpost, which is the hard part. You haven't scheduled a post yet, so here's the short version:`
        ) +
        steps(
          [
            `Open the calendar and click ${strong('Create Post')}.`,
            `Write your post, or let the AI draft it from one line.`,
            `Pick a time and click ${strong('Add to calendar')}. Hookpost publishes it then.`,
          ],
          { numbered: true }
        ) +
        button('Schedule your first post', `${base}/launches`) +
        paragraph(
          'If something stopped you, reply and tell me. I read every reply.',
          { muted: true, small: true }
        ) +
        founder,
    });
  }

  if (stage === 'STAGE_3_FOUNDER') {
    return buildEmail('Quick question about your Hookpost setup', {
      preheader: 'Personal brand or client accounts? Reply and tell me.',
      kind: 'marketing',
      unsubscribeUrl,
      body:
        paragraph(`Hi ${name},`) +
        paragraph(
          `Mohan here, founder of Hookpost. You signed up a week ago${
            orgName ? ` for ${strong(escapeHtml(orgName))}` : ''
          }, and I wanted to check how setup is going.`
        ) +
        paragraph(
          'Are you posting for your own brand, or managing accounts for clients?'
        ) +
        paragraph(
          'If anything got in the way, like connecting a channel or choosing a plan, reply to this email and tell me. I read and answer every reply myself.'
        ) +
        signoff('Mohan Bhanushali', 'Founder, Hookpost'),
    });
  }

  if (stage === 'STAGE_2_FEATURES') {
    return buildEmail('One post, every channel: how Hookpost works', {
      preheader: 'The calendar, AI drafts and the Claude/Cursor integration, in one minute.',
      kind: 'marketing',
      unsubscribeUrl,
      body:
        heading('One post, every channel') +
        paragraph(`Hi ${name}, here's what most people set up in their first week on Hookpost:`) +
        steps([
          `${strong('Calendar.')} See and drag every scheduled post for LinkedIn, X, Instagram, Facebook and YouTube in one view.`,
          `${strong('AI drafts.')} Turn one idea into a post sized for each platform, with hashtags.`,
          `${strong('Claude and Cursor.')} Schedule posts from your editor through the Hookpost MCP server or CLI.`,
        ]) +
        button('Open your calendar', `${base}/launches`) +
        paragraph(
          `When you're ready to upgrade, Hookpost is ${monthly}/month, and code ${strong(code)} takes ${CODE_TERMS}.`,
          { muted: true, small: true }
        ) +
        signoff('The Hookpost team'),
    });
  }

  // STAGE_1_LAUNCH
  return buildEmail(`${DISCOUNT_PERCENT}% off Hookpost with ${discountCode}`, {
    preheader: `Hookpost is ${monthly}/month; your code takes ${DISCOUNT_PERCENT}% off every payment.`,
    kind: 'marketing',
    unsubscribeUrl,
    body:
      heading('Your Hookpost offer') +
      paragraph(`Hi ${name},`) +
      paragraph(
        `Thanks for signing up for Hookpost${
          orgName ? ` for ${strong(escapeHtml(orgName))}` : ''
        }. When you need more than your free posts, Hookpost is ${monthly}/month for ${plan.channel} channels and ${plan.posts_per_month} posts a month, and code ${strong(
          code
        )} takes ${DISCOUNT_PERCENT}% off every payment for as long as you stay subscribed.`
      ) +
      details([
        ['Hookpost', `${monthly}/month, billed monthly`],
        ['Channels', `${plan.channel}`],
        ['Scheduled posts', `${plan.posts_per_month} a month`],
        ['AI credits', `${plan.ai_credits} a month`],
        ['Your code', `${code} (${CODE_TERMS})`],
      ]) +
      button('See plans', `${base}/billing`) +
      paragraph(
        'Need a plan for a team or several client brands? Reply to this email and we\'ll help you pick.',
        { muted: true, small: true }
      ) +
      signoff('The Hookpost team'),
  });
}
