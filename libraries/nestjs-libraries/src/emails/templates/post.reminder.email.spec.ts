/**
 * The "Remind me to post" email (postWorkflowV114 -> sendPostReminder): it
 * carries everything needed to post from a phone with no Hookpost session,
 * and escapes everything the user wrote.
 *   pnpm exec jest -c apps/backend/jest.config.ts post.reminder.email
 */
import { postReminderEmail, reminderUrl } from './post.reminder.email';
import { isRenderedEmail } from '@hookpost/nestjs-libraries/emails/layout/email.layout';

const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
beforeEach(() => {
  process.env.FRONTEND_URL = 'https://app.example.test/';
});
afterAll(() => {
  if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
});

const base = {
  postId: 'post_1',
  platform: 'TikTok',
  channel: 'Sacred Smiles',
  caption: 'Line one\nLine two #fyp',
  comments: ['link in bio'],
  media: ['https://media.example/a.mp4', 'https://media.example/b.jpg'],
};

describe('postReminderEmail', () => {
  it('names the platform and channel in the subject, and is a finished email', () => {
    const email = postReminderEmail(base);
    expect(email.subject).toBe('Time to post on TikTok: Sacred Smiles');
    expect(isRenderedEmail(email.html)).toBe(true);
    expect(email.text).toContain('Time to post on TikTok');
  });

  it('links the reminder page as a button and as a plain fallback link', () => {
    const { html, text } = postReminderEmail(base);
    expect(reminderUrl('post_1')).toBe('https://app.example.test/reminder/post_1');
    expect(html.match(/https:\/\/app\.example\.test\/reminder\/post_1/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Open the post in Hookpost');
    expect(text).toContain('https://app.example.test/reminder/post_1');
  });

  it('has a download link for every file, numbered when there are several', () => {
    const { html } = postReminderEmail(base);
    expect(html).toContain('href="https://media.example/a.mp4"');
    expect(html).toContain('href="https://media.example/b.jpg"');
    expect(html).toContain('Download file 1');
    expect(html).toContain('Download file 2');
    expect(postReminderEmail({ ...base, media: [base.media[0]] }).html).toContain(
      'Download the file'
    );
  });

  it('carries the caption with its line breaks and the comment', () => {
    const { html } = postReminderEmail(base);
    expect(html).toContain('Line one<br />Line two #fyp');
    expect(html).toContain('link in bio');
    expect(html).toContain('First comment');
  });

  it('escapes what the user wrote: caption, comments and channel name', () => {
    const hostile = `<img src=x onerror="alert(1)">`;
    const { html, subject } = postReminderEmail({
      ...base,
      channel: hostile,
      caption: hostile,
      comments: [hostile],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    // the subject is a header, not HTML
    expect(subject).toContain(hostile);
  });

  it('leaves out the caption, comments and files blocks when there are none', () => {
    const { html } = postReminderEmail({ ...base, caption: '  ', comments: [], media: [] });
    expect(html).not.toContain('>Caption<');
    expect(html).not.toContain('First comment');
    expect(html).not.toContain('Download');
    expect(html).toContain('Open the post in Hookpost');
  });
});
