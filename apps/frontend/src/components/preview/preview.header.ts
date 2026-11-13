// The public post page (/p/:id) header and channel line.

// Facebook pages and LinkedIn store no handle, and YouTube stores its handle
// with the '@' already on it. Returns '' when there is nothing to show.
export const previewHandle = (profile?: string | null) =>
  (profile || '').trim().replace(/^@+/, '');

// A failed or draft post never went out, so the header must not call its
// date a publication date.
export const previewDateLabel = (
  state: string | undefined,
  t: (key: string, fallback: string) => string
) => {
  switch (state) {
    case 'PUBLISHED':
      return t('preview_published_on', 'Published:');
    case 'QUEUE':
      return t('preview_scheduled_for', 'Scheduled for:');
    case 'ERROR':
      return t(
        'preview_failed_was_scheduled_for',
        'Publishing failed. It was scheduled for:'
      );
    case 'DRAFT':
      return t('preview_draft_planned_for', 'Draft, planned for:');
    case 'REMINDER_SENT':
      return t('preview_reminder_sent', 'Reminder sent, to post by hand:');
    case 'POSTED_MANUALLY':
      return t('preview_posted_manually', 'Posted from the app:');
    default:
      return t('publication_date', 'Publication Date:');
  }
};
