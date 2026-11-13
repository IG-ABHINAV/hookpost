import {
  appUrl,
  buildEmail,
  button,
  callout,
  details,
  escapeHtml,
  heading,
  paragraph,
  RenderedEmail,
  strong,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import {
  MEDIA_RETENTION_REMINDER_DAYS,
  mediaKeptUntilLabel,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/**
 * Media retention after a plan ends (trial.policy.ts, MediaRetentionService).
 * The day-0 notice is a line in the email that already tells the workspace
 * its plan ended (mediaKeptSentence, from RazorpayService), or, where no such
 * email went out, mediaRetentionNoticeEmail. Then one reminder.
 */

const WHAT_GOES =
  'the media files of its scheduled, draft and failed posts, and the uploads in its media library';
const WHAT_STAYS = 'Post text, channels and settings stay.';

/**
 * What a plan-ended email adds when it is the day-0 notice (billing.emails.ts
 * afterPlanLine, RazorpayService claims it), so the workspace gets one email
 * on the day its plan ends, not two.
 */
export function mediaKeptSentence(removeAt: Date): string {
  return `We keep this workspace's posts and media until ${strong(
    mediaKeptUntilLabel(removeAt)
  )}. Choose a plan before then to keep everything. After that date we remove ${WHAT_GOES}. ${WHAT_STAYS}`;
}

/**
 * The day-0 notice on its own: a workspace on the clock whose plan ended
 * without an email that carried the line (a workspace that had already
 * churned when this shipped, a Gumroad or admin end, a failed send).
 */
export function mediaRetentionNoticeEmail(params: {
  orgName: string;
  removeAt: Date;
  files: number;
}): RenderedEmail {
  const { orgName, removeAt, files } = params;
  const until = mediaKeptUntilLabel(removeAt);
  return buildEmail(`Your Hookpost media is kept until ${until}`, {
    preheader: `Choose a plan before ${until} to keep everything.`,
    kind: 'transactional',
    body:
      heading('Your media is kept until ' + escapeHtml(until)) +
      paragraph(
        `${strong(
          escapeHtml(orgName)
        )} has no Hookpost plan right now. We keep its posts and media until ${strong(
          until
        )}. After that date we remove ${WHAT_GOES}. ${WHAT_STAYS}`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Media files', String(files)],
        ['Kept until', until],
      ]) +
      button('Choose a plan', `${appUrl()}/billing`) +
      paragraph(
        'Choosing a plan before then keeps everything. You can also download any file you want from the media library first. Questions? Reply to this email.',
        { muted: true, small: true }
      ),
  });
}

/** MEDIA_RETENTION_REMINDER_DAYS before the removal, once. */
export function mediaRetentionReminderEmail(params: {
  orgName: string;
  removeAt: Date;
  files: number;
}): RenderedEmail {
  const { orgName, removeAt, files } = params;
  const until = mediaKeptUntilLabel(removeAt);
  return buildEmail(
    `Your Hookpost media will be removed after ${until}`,
    {
      preheader: `${MEDIA_RETENTION_REMINDER_DAYS} days left: choose a plan to keep it.`,
      kind: 'transactional',
      body:
        heading('Your media will be removed soon') +
        callout(
          `${files} media file${files === 1 ? '' : 's'} in ${strong(
            escapeHtml(orgName)
          )} will be removed after ${strong(until)}.`
        ) +
        paragraph(
          `The workspace still has no Hookpost plan. After ${strong(
            until
          )} we remove ${WHAT_GOES}. ${WHAT_STAYS}`
        ) +
        button('Choose a plan', `${appUrl()}/billing`) +
        paragraph(
          'Choosing a plan before then keeps everything. You can also download any file you want from the media library first. Questions? Reply to this email.',
          { muted: true, small: true }
        ),
    }
  );
}
