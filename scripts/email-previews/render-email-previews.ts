/**
 * Renders every email Hookpost sends, with realistic sample data, to static
 * files for review. Nothing is sent.
 *
 *   scripts/email-previews/render.sh [out-dir]      (default: tmp/email-previews)
 *
 * Writes <name>.html and <name>.txt per email plus an index.html. The inputs
 * mirror what each caller passes, so a preview is what a customer would get.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  htmlToText,
  isRenderedEmail,
  RenderedEmail,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import { notificationEmail } from '@hookpost/nestjs-libraries/emails/templates/notification.email';
import {
  activationEmail,
  loginChangedEmail,
  passwordResetEmail,
  teamInviteEmail,
} from '@hookpost/nestjs-libraries/emails/templates/auth.emails';
import { agencyListedEmail } from '@hookpost/nestjs-libraries/emails/templates/agency.emails';
import {
  supportAutoReplyEmail,
  supportReplyEmail,
} from '@hookpost/nestjs-libraries/emails/templates/support.emails';
import {
  paymentFailedEmail,
  refundEmail,
  subscriptionCancelledEmail,
  subscriptionWelcomeEmail,
  trialAccessEndingEmail,
  workspacePausedEmail,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';
import {
  chargeStoppedEmail,
  duplicateChargeRefundedEmail,
  planCorrectedEndedEmail,
  planRestoredEmail,
  refundEndedPlanEmail,
} from '@hookpost/nestjs-libraries/emails/templates/account.correction.emails';
import { generateLeadEmail } from '@hookpost/nestjs-libraries/emails/templates/lead-campaign.template';
import { freePlanSunsetEmail } from '@hookpost/nestjs-libraries/emails/templates/free-plan-sunset.template';
import {
  cancelNoteEmail,
  chatbaseRefundNoteEmail,
} from '@hookpost/nestjs-libraries/emails/templates/admin.alert.email';
import { ownerSaleAlertEmail } from '@hookpost/nestjs-libraries/emails/templates/owner.sales.alert.email';

process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://hookpost.hookstep.in';
const APP = process.env.FRONTEND_URL;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImNtMDEifQ.sample-token';

/** What EmailService.sendEmailSync does with (subject, html). */
function viaEmailService(subject: string, html: string): RenderedEmail {
  return isRenderedEmail(html)
    ? { subject, html, text: htmlToText(html) }
    : notificationEmail(subject, html);
}

/** Same markup the digest workflow builds. */
function digestFragment(messages: string[]): string {
  return messages
    .map((m, i) =>
      i < messages.length - 1
        ? `<p style="margin:0 0 12px 0;padding:0 0 12px 0;border-bottom:1px solid #E6E9EF;">${m}</p>`
        : `<p style="margin:0 0 16px 0;">${m}</p>`
    )
    .join('');
}

type Preview = { name: string; trigger: string; email: RenderedEmail };

const previews: Preview[] = [
  {
    name: '01-activation',
    trigger: 'Email sign-up, and "resend activation" (auth.service.ts)',
    email: activationEmail({ activationUrl: `${APP}/auth/activate/${JWT}` }),
  },
  {
    name: '02-password-reset',
    trigger: 'Forgot password (auth.service.ts forgot)',
    email: passwordResetEmail({ resetUrl: `${APP}/auth/forgot/${JWT}`, expiresInMinutes: 20 }),
  },
  {
    name: '03-team-invite',
    trigger: 'Settings > Teams > invite by email (organization.service.ts inviteTeamMember)',
    email: teamInviteEmail({
      inviterName: 'Priya Sharma',
      inviterEmail: 'priya@chaipoint.in',
      orgName: 'Chai Point Social',
      inviteUrl: `${APP}/?org=${JWT}`,
      expiresInDays: 2,
    }),
  },
  {
    name: '04-login-changed',
    trigger: 'Admin swaps two accounts\' sign-in emails; one to every address involved, old and new (users.service.ts)',
    email: loginChangedEmail({
      changes: [
        { from: 'rahul.verma@gmail.com', to: 'rahul@chaipoint.in' },
        { from: 'rahul@chaipoint.in', to: 'rahul.verma@gmail.com' },
      ],
      recipient: 'rahul.verma@gmail.com',
    }),
  },
  {
    name: '05-agency-listed',
    trigger: 'First save of an agency listing; listed automatically, no review (agencies.service.ts createAgency)',
    email: agencyListedEmail({ agencyName: 'Bombay Pixel Studio' }),
  },
  {
    name: '06-support-auto-reply',
    trigger: 'Contact form submitted: confirmation to the customer (support-tickets.service.ts)',
    email: supportAutoReplyEmail({ ref: 'HP-7K2Q', name: 'Priya', topic: 'Billing' }),
  },
  {
    name: '07-support-reply',
    trigger: 'Admin replies to a ticket from /admin/contact (support-tickets.service.ts reply)',
    email: supportReplyEmail({
      ref: 'HP-7K2Q',
      topic: 'Billing',
      name: 'Priya Sharma',
      reply:
        'Thanks for flagging this. The second charge was a mandate from an older plan; I have cancelled it and the refund of Rs 599 is on its way. It usually shows up in 5-7 working days, depending on your bank.\n\nNothing else changes on your workspace.',
      originalMessage:
        'I was charged twice this month for Standard. Can you check? Workspace is Chai Point Social.',
    }),
  },
  {
    name: '08-subscription-welcome-trial',
    trigger: 'Razorpay subscription authenticated with a trial (razorpay.service.ts)',
    email: subscriptionWelcomeEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
      trialDays: 7,
      firstChargeAt: new Date(Date.now() + 7 * 86_400_000),
    }),
  },
  {
    name: '09-subscription-welcome-paid',
    trigger: 'Razorpay subscription charged (razorpay.service.ts)',
    email: subscriptionWelcomeEmail({
      orgName: 'Chai Point Social',
      billing: 'PRO',
      channels: 30,
      period: 'YEARLY',
      isTrial: false,
    }),
  },
  {
    name: '10-payment-failed',
    trigger: 'Razorpay subscription.pending, once per billing cycle (razorpay.service.ts handleFailedSubscriptionPayment)',
    email: paymentFailedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      amount: 599,
      currency: 'INR',
      reason: 'UPI mandate not approved in time',
      isHalted: false,
    }),
  },
  {
    name: '11-payment-halted',
    trigger: 'Razorpay subscription.halted (razorpay.service.ts)',
    email: paymentFailedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      amount: 5990,
      currency: 'INR',
      reason: 'Bank retries exhausted — subscription renewal halted',
      isHalted: true,
    }),
  },
  {
    name: '11b-subscription-cancelled',
    trigger: 'Razorpay subscription.cancelled mid-cycle (dashboard or customer); plan kept until current_end (razorpay.service.ts handleCancelled)',
    email: subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: new Date(Date.now() + 24 * 86_400_000),
    }),
  },
  {
    name: '11c-subscription-cancelled-ended',
    trigger: 'Razorpay subscription.cancelled at cycle end, or after a refund; plan ends now (razorpay.service.ts handleCancelled)',
    email: subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: null,
    }),
  },
  {
    name: '11g-trial-access-ending',
    trigger: 'Hourly sweep: a cancelled trial whose access ends in 26-48 hours, workspace paused after (razorpay.service.ts sendCancelledTrialReminders)',
    email: trialAccessEndingEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      accessUntil: new Date(Date.now() + 40 * 3_600_000),
      charge: { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod: 'upi' },
      freePlanAvailable: false,
    }),
  },
  {
    name: '11h-workspace-paused',
    trigger: 'Hourly sweep: a cancelled trial has run out and the workspace has no Free plan (razorpay.service.ts endLapsedCancellations)',
    email: workspacePausedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      endedAt: new Date(),
      charge: { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod: 'upi' },
    }),
  },
  {
    name: '11i-plan-corrected-ended',
    trigger:
      'Admin "End plan now", or the billing reconcile job: our records showed a plan that had ended (account.correction.emails.ts)',
    email: planCorrectedEndedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      endedAt: new Date(),
      neverCharged: true,
      endedOn: new Date(Date.now() - 8 * 86_400_000),
      because: 'your trial was cancelled on 21 October',
    }),
  },
  {
    name: '11j-charge-stopped',
    trigger:
      'The billing reconcile job: a mandate that could still have charged after the plan ended (account.correction.emails.ts)',
    email: chargeStoppedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      stoppedAt: new Date(),
      nothingCharged: true,
      wouldHaveChargedOn: new Date(Date.now() + 13 * 86_400_000),
    }),
  },
  {
    name: '11k-plan-restored',
    trigger: 'Admin "Restore plan": a workspace ended or paused by mistake (account.correction.emails.ts)',
    email: planRestoredEmail({
      orgName: 'Chai Point Social',
      billing: 'PRO',
      restoredAt: new Date(),
      wasOffFor: 'from 21 to 29 October',
    }),
  },
  {
    name: '11l-duplicate-charge-refunded',
    trigger: 'Admin Refunds page with "this was a duplicate charge" ticked (account.correction.emails.ts)',
    email: duplicateChargeRefundedEmail({
      orgName: 'Chai Point Social',
      billing: 'PRO',
      amount: 1999,
      currency: 'INR',
      refundId: 'rfnd_R8kq2mYp1xTz9N',
      paymentId: 'pay_R8kp1cN2cQwE4w',
      refundedAt: new Date(),
      because: 'when you moved to Pro on 12 October',
    }),
  },
  {
    name: '11m-refund-ended-plan',
    trigger:
      'Admin "End plan now" with "a refund should have ended it": a refund from before that we did not act on (account.correction.emails.ts)',
    email: refundEndedPlanEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      refundedOn: new Date(Date.now() - 18 * 86_400_000),
      endedAt: new Date(),
      amount: 693,
      currency: 'INR',
    }),
  },
  {
    name: '11d-refund-plan-cancelled',
    trigger: 'Razorpay refund.processed for a cancelled subscription (razorpay.service.ts handleRefund)',
    email: refundEmail({
      orgName: 'Chai Point Social',
      amount: 599,
      currency: 'INR',
      refundId: 'rfnd_R8kq2mYp1xTz9L',
      paymentId: 'pay_R8kp1cN2cQwE4v',
      refundedAt: new Date(),
      billing: 'STANDARD',
      plan: 'cancelled',
    }),
  },
  {
    name: '11e-refund-plan-active',
    trigger: 'Razorpay refund.processed, subscription still live (razorpay.service.ts handleRefund)',
    email: refundEmail({
      orgName: 'Chai Point Social',
      amount: 1400,
      currency: 'INR',
      refundId: 'rfnd_R8kq2mYp1xTz9M',
      paymentId: 'pay_R8kp1cN2cQwE4w',
      refundedAt: new Date(),
      billing: 'PRO',
      plan: 'active',
      nextChargeAt: new Date(Date.now() + 18 * 86_400_000),
    }),
  },
  {
    name: '12-notify-post-published',
    trigger: 'Post published (post workflow inAppNotification, success)',
    email: viaEmailService(
      'Your post is live on Linkedin',
      'Your post is live on Linkedin: https://www.linkedin.com/feed/update/urn:li:share:7244551234567890'
    ),
  },
  {
    name: '13-notify-post-failed',
    trigger: 'Post failed (post workflow inAppNotification, fail)',
    email: viaEmailService(
      "Your Instagram post for Chai Point didn't publish",
      'Instagram rejected the post: The image aspect ratio is not supported (must be between 4:5 and 1.91:1). Open it in Hookpost to fix it and try again.'
    ),
  },
  {
    name: '14-notify-reconnect',
    trigger: 'Channel needs reconnecting (post workflow inAppNotification, info)',
    email: viaEmailService(
      'Reconnect Chai Point on X to keep posting',
      "We couldn't publish to Chai Point on X because the connection needs refreshing. Reconnect the channel in Hookpost, then try the post again."
    ),
  },
  {
    name: '14b-notify-channel-disabled',
    trigger: 'Post to a disabled channel (post workflow inAppNotification, info)',
    email: viaEmailService(
      "We couldn't post to Chai Point on Facebook",
      'Chai Point on Facebook is disabled in Hookpost. Enable the channel, then try the post again.'
    ),
  },
  {
    name: '14c-notify-refresh-failed',
    trigger: 'Token refresh failed (integration.service.ts informAboutRefreshError)',
    email: viaEmailService(
      'Reconnect your Linkedin channel',
      `We couldn't refresh the connection to your Linkedin channel, so posts to it will fail until you reconnect it: ${APP}/launches`
    ),
  },
  {
    name: '15-digest',
    trigger: 'Hourly digest of queued notifications (digest.email.workflow.ts)',
    email: viaEmailService(
      '3 updates from Hookpost',
      digestFragment([
        'Your post is live on Linkedin: https://www.linkedin.com/feed/update/urn:li:share:7244551234567890',
        'Your post is live on Facebook: https://www.facebook.com/61593974081646/posts/1234567890',
        'Threads rejected the post: Media upload timed out after 60 seconds. Open it in Hookpost to fix it and try again.',
      ])
    ),
  },
  {
    name: '16-streak',
    trigger: 'Streak reminder, 22h after last post (streak.workflow.ts)',
    email: viaEmailService(
      'Your posting streak ends in 2 hours',
      '<p>Schedule a post in the next 2 hours to keep your streak going.</p>'
    ),
  },
  {
    name: '17-admin-subscription-cancelled',
    trigger: 'INTERNAL: customer cancels, to EMAIL_FROM_ADDRESS (billing.controller.ts)',
    email: cancelNoteEmail({
      orgName: 'Chai Point Social',
      orgId: 'org-sample-0001',
      customerEmail: 'priya@chaipoint.in',
      feedback: 'We are pausing social for the monsoon quarter.',
    }),
  },
  {
    name: '18-admin-chatbase-refund',
    trigger: 'INTERNAL: refund issued, to EMAIL_FROM_ADDRESS (billing.controller.ts)',
    email: chatbaseRefundNoteEmail({ orgName: 'Chai Point Social', orgId: 'org-sample-0001', amount: 599, currency: 'INR' }),
  },
  ...(['TRIAL_STARTED', 'FIRST_CHARGE', 'HALTED', 'DISPUTE'] as const).map((event, i) => ({
    name: `26-owner-alert-${i + 1}-${event.toLowerCase()}`,
    trigger: `INTERNAL: owner sale alert ${event} (OwnerSalesAlertService, OWNER_SALES_ALERT_EMAIL)`,
    email: ownerSaleAlertEmail(
      {
        event,
        key: `preview:${event}`,
        source: 'razorpay',
        organizationId: 'org-sample-0001',
        tier: 'STANDARD',
        period: 'MONTHLY',
        amount: 599,
        currency: 'INR',
        paymentMethod: 'upi',
        ids: { subscription: 'sub_sample', payment: 'pay_sample' },
        notes: ['A note written by Hookpost'],
      },
      {
        orgName: 'Chai Point Social',
        customerName: 'Priya Shah',
        customerEmail: 'priya@chaipoint.in',
        signupCountry: 'IN',
        testReason: event === 'TRIAL_STARTED' ? 'Razorpay test key' : null,
      }
    ),
  })),
  {
    name: '19-lead-day1-inr',
    trigger: 'Lead drip stage 1, India (scripts/lead-campaign/run-lead-drip.js)',
    email: generateLeadEmail({ userName: 'Akhand', orgName: 'Akhand Foods', email: 'akhand@example.com', currency: 'INR', stage: 'STAGE_1_LAUNCH' }),
  },
  {
    name: '20-lead-day1-outside-india',
    trigger: 'Lead drip stage 1, outside India: same rupee prices, since checkout charges INR only until Phase 2 (run-lead-drip.js)',
    email: generateLeadEmail({ userName: 'Lucian', orgName: 'Twitch Clips', email: 'lucian@example.com', currency: 'USD', stage: 'STAGE_1_LAUNCH' }),
  },
  {
    name: '21-lead-day3-features',
    trigger: 'Lead drip stage 2, day 3 (run-lead-drip.js)',
    email: generateLeadEmail({ userName: 'Gokul', email: 'gokul@example.com', currency: 'INR', stage: 'STAGE_2_FEATURES' }),
  },
  {
    name: '22-lead-day7-founder',
    trigger: 'Lead drip stage 3, day 7 (run-lead-drip.js)',
    email: generateLeadEmail({ userName: null, orgName: 'Massifor', email: 'massifor@example.com', currency: 'USD', stage: 'STAGE_3_FOUNDER' }),
  },
  {
    name: '23-free-plan-sunset-india',
    trigger: 'One-off: grandfathered Free plan ends (scripts/notify-free-plan-sunset.ts), owner in India, trial available',
    email: freePlanSunsetEmail({ userName: 'Akhand', orgNames: ['Akhand Foods'], endsAt: new Date('2026-10-27T18:29:59Z'), region: 'IN', canTrial: true, appUrl: APP }),
  },
  {
    name: '24-free-plan-sunset-unknown-region',
    trigger: 'One-off: grandfathered Free plan ends, owner country unknown (both prices), trial already used',
    email: freePlanSunsetEmail({ userName: null, orgNames: ['Twitch Clips', 'Clips Two'], endsAt: new Date('2026-10-27T18:29:59Z'), region: 'UNKNOWN', canTrial: false, appUrl: APP }),
  },
  {
    name: '25-free-plan-sunset-owns-paid-workspace',
    trigger: 'One-off: grandfathered Free plan ends, owner also owns a workspace with a plan (no Delete button)',
    email: freePlanSunsetEmail({ userName: 'Ritu', orgNames: ['Side Project'], endsAt: new Date('2026-10-27T18:29:59Z'), region: 'GLOBAL', canTrial: true, appUrl: APP, offerDelete: false }),
  },
];

const outDir = path.resolve(process.argv[2] || 'tmp/email-previews');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rows: string[] = [];
for (const p of previews) {
  fs.writeFileSync(path.join(outDir, `${p.name}.html`), p.email.html);
  fs.writeFileSync(path.join(outDir, `${p.name}.txt`), `Subject: ${p.email.subject}\n\n${p.email.text}`);
  rows.push(
    `<tr><td><a href="${p.name}.html">${p.name}</a> · <a href="${p.name}.txt">txt</a></td><td>${esc(
      p.email.subject
    )}</td><td>${p.email.subject.length}</td><td>${esc(p.trigger)}</td></tr>`
  );
}
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Hookpost email previews</title>
<body style="font-family:system-ui;padding:24px"><h1>Hookpost email previews (${previews.length})</h1>
<table cellpadding="6" border="1" style="border-collapse:collapse;font-size:14px"><tr><th>File</th><th>Subject</th><th>Chars</th><th>Trigger</th></tr>${rows.join(
    ''
  )}</table></body>`
);
console.log(`Wrote ${previews.length} previews to ${outDir}`);
