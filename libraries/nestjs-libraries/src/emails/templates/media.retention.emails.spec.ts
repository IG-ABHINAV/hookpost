/**
 * The media retention emails (media.retention.emails.ts) and the line a
 * plan-ended email carries when it is the day-0 notice (billing.emails.ts).
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts media.retention.emails
 */
import {
  mediaKeptSentence,
  mediaRetentionNoticeEmail,
  mediaRetentionReminderEmail,
} from './media.retention.emails';
import {
  paymentDisputedEmail,
  planEndedEmail,
  refundEmail,
  subscriptionCancelledEmail,
  workspacePausedEmail,
} from './billing.emails';
import { mediaRemoveAt } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const removeAt = mediaRemoveAt(new Date('2026-11-01T09:00:00Z')); // named 1 December 2026
const LINE = "We keep this workspace's posts and media until 1 December 2026.";

describe('the notice and the reminder', () => {
  it('notice: the date, the count, what goes, what stays, a plan button', () => {
    const e = mediaRetentionNoticeEmail({ orgName: 'Chai Co', removeAt, files: 12 });
    expect(e.subject).toBe('Your Hookpost media is kept until 1 December 2026');
    expect(e.text).toContain('Chai Co has no Hookpost plan right now');
    expect(e.text).toContain('12');
    expect(e.text).toMatch(/media files of its scheduled, draft and failed posts, and the uploads in its media library/);
    expect(e.text).toContain('Post text, channels and settings stay.');
    expect(e.html).toContain('/billing');
  });

  it('reminder: 7 days left, the same date, singular for one file', () => {
    const e = mediaRetentionReminderEmail({ orgName: 'Chai Co', removeAt, files: 1 });
    expect(e.subject).toBe('Your Hookpost media will be removed after 1 December 2026');
    expect(e.text).toContain('1 media file in Chai Co will be removed after 1 December 2026');
    expect(mediaRetentionReminderEmail({ orgName: 'X', removeAt, files: 3 }).text).toContain('3 media files');
  });

  it('a workspace name is escaped, never HTML', () => {
    const e = mediaRetentionNoticeEmail({ orgName: '<img src=x onerror=alert(1)>', removeAt, files: 1 });
    expect(e.html).not.toContain('<img src=x');
    expect(e.html).toContain('&lt;img');
  });
});

describe('the plan-ended emails carry the line only when they are the notice', () => {
  const free = { freePlanAvailable: false, freePlanEndsAt: null };
  const cases: Array<[string, (k: Date | null) => { text: string }]> = [
    ['plan ended', (k) => planEndedEmail({ orgName: 'A', billing: 'STANDARD', endedAt: new Date(), ...free, mediaKeptUntil: k })],
    ['cancelled, ended now', (k) => subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, ...free, mediaKeptUntil: k })],
    ['first charge failed, plan ended', (k) => subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, unpaidFirstChargeEnded: true, ...free, mediaKeptUntil: k })],
    ['unpaid renewal ended', (k) => subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, unpaidRenewalEnded: true, ...free, mediaKeptUntil: k })],
    ['refund ended it', (k) => refundEmail({ orgName: 'A', amount: 599, currency: 'INR', refundId: 'rfnd_1', paymentId: 'pay_1', refundedAt: new Date(), billing: 'STANDARD', plan: 'cancelled', endedByRefund: true, ...free, mediaKeptUntil: k })],
    ['dispute', (k) => paymentDisputedEmail({ orgName: 'A', billing: 'STANDARD', paymentId: 'pay_1', disputedAt: new Date(), ...free, mediaKeptUntil: k })],
    ['trial ended, paused', (k) => workspacePausedEmail({ orgName: 'A', billing: 'STANDARD', endedAt: new Date(), mediaKeptUntil: k })],
  ];
  it.each(cases)('%s', (_name, render) => {
    expect(render(removeAt).text).toContain(LINE);
    expect(render(null).text).not.toContain('We keep this workspace');
  });

  it('a cancel that keeps paid time never says it, even if given a date', () => {
    const e = subscriptionCancelledEmail({
      orgName: 'A', billing: 'STANDARD', accessUntil: new Date(Date.now() + 9 * 86400_000), ...free, mediaKeptUntil: removeAt,
    });
    expect(e.text).not.toContain('We keep this workspace');
    expect(e.text).toContain('your channels and posts are kept, and their media files for 30 days');
  });

  it('the sentence names the day and what goes', () => {
    expect(mediaKeptSentence(removeAt)).toContain('<strong');
    expect(mediaKeptSentence(removeAt)).toMatch(/Choose a plan before then to keep everything\. After that date we remove/);
  });
});
