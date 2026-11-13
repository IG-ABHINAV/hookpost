import {
  appUrl,
  buildEmail,
  button,
  callout,
  escapeHtml,
  heading,
  link,
  linkFallback,
  paragraph,
  RenderedEmail,
  steps,
  strong,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';

export interface PostReminderEmailParams {
  postId: string;
  /** The platform, as people call it ("Instagram", "TikTok"). */
  platform: string;
  /** The channel's own name in Hookpost. */
  channel: string;
  /** Plain text, already stripped of the editor's markup. */
  caption: string;
  /** Plain text of the comments posted under it, in order. */
  comments?: string[];
  /** Absolute URLs of the post's files. */
  media: string[];
}

/** Where the reminder email and the in-app notification send people. */
export const reminderUrl = (postId: string) =>
  `${appUrl()}/reminder/${encodeURIComponent(postId)}`;

/**
 * "Remind me to post": Hookpost did not publish this post, the user does it
 * from the platform's own app (that is the only place licensed music can be
 * added). Everything needed is in the email, so it works from a phone with
 * no Hookpost session: the caption to copy, a download link per file, and
 * the reminder page for copy/download/open-the-app in one place.
 *
 * Everything the user wrote (caption, comments, channel name) is escaped.
 */
export function postReminderEmail(
  params: PostReminderEmailParams
): RenderedEmail {
  const { postId, platform, channel, caption, comments = [], media } = params;
  const url = reminderUrl(postId);
  const subject = `Time to post on ${platform}: ${channel}`;

  const asText = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br />');

  const files = media.length
    ? paragraph(strong(media.length === 1 ? 'Your file' : 'Your files')) +
      steps(
        media.map((file, i) =>
          link(
            `Download ${media.length === 1 ? 'the file' : `file ${i + 1}`}`,
            file
          )
        )
      )
    : '';

  const firstComments = comments.filter((c) => c.trim()).length
    ? paragraph(strong(comments.length === 1 ? 'First comment' : 'Comments')) +
      callout(
        comments
          .filter((c) => c.trim())
          .map(asText)
          .join('<hr />')
      )
    : '';

  return buildEmail(subject, {
    preheader: `Your ${platform} post for ${channel} is ready. Add your sound in the app and post it.`,
    kind: 'transactional',
    reason:
      'You received this email because a post in your Hookpost workspace is set to "Remind me to post".',
    body:
      heading(escapeHtml(`Time to post on ${platform}`)) +
      paragraph(
        `Your post for ${strong(
          escapeHtml(channel)
        )} is ready. Hookpost did not publish it: you asked to post it yourself, so you can add music in the ${escapeHtml(
          platform
        )} app.`
      ) +
      steps(
        [
          media.length
            ? `Save ${
                media.length === 1 ? 'the file' : 'the files'
              } below to your phone (or open the post in Hookpost there).`
            : 'Open the post in Hookpost on your phone.',
          `Open ${escapeHtml(platform)}, add your sound and paste the caption.`,
          'Post it, then press "Mark as posted" in Hookpost.',
        ],
        { numbered: true }
      ) +
      button('Open the post in Hookpost', url) +
      linkFallback(url) +
      (caption.trim()
        ? paragraph(strong('Caption')) + callout(asText(caption))
        : '') +
      firstComments +
      files,
  });
}
