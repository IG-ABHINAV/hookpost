/**
 * scripts/cleanup-expired-media.js: which posts' videos are purged, and which
 * URLs it may delete from the shared bucket.
 *   pnpm exec jest -c apps/backend/jest.config.ts cleanup-expired-media
 */
jest.mock('@prisma/client', () => ({ PrismaClient: class {} }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: class {}, DeleteObjectCommand: class {} }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  expiredPublishedPostsWhere,
  isOurUrl,
  pendingPostsUsing,
} = require('./cleanup-expired-media.js');

describe('cleanup-expired-media', () => {
  it('includes deleted posts, whose videos were never purged before', () => {
    const cutoff = new Date('2026-10-04T00:00:00Z');
    const where = expiredPublishedPostsWhere(cutoff);
    expect(where).toEqual({
      state: { in: ['PUBLISHED', 'POSTED_MANUALLY'] },
      publishDate: { lte: cutoff },
    });
    expect('deletedAt' in where).toBe(false);
  });

  it('keeps a video that a scheduled, draft or failed post still uses', () => {
    // A failed post shares the file with its group's published posts and
    // needs it to be retried
    const where = pendingPostsUsing('https://media.hookstep.in/v.mp4');
    expect(where.image).toEqual({ contains: 'https://media.hookstep.in/v.mp4' });
    expect(where.OR).toContainEqual({
      deletedAt: null,
      state: { in: ['QUEUE', 'DRAFT', 'ERROR', 'REMINDER_SENT'] },
    });
  });

  // A post the plan gate stopped ("Choose a plan to continue.") is ERROR like
  // any failed one, so its video survives the purge and is still there when
  // the workspace pays again and the user reschedules the post.
  it('keeps the video of a post stopped because the plan ended', () => {
    const where = pendingPostsUsing('https://media.hookstep.in/paused.mp4');
    expect(where.OR[0]).toEqual({
      deletedAt: null,
      state: { in: ['QUEUE', 'DRAFT', 'ERROR', 'REMINDER_SENT'] },
    });
    expect(where.OR[0].state.in).toContain('ERROR');
  });

  // "Remind me to post": the reminder email and page link the file until
  // the user has posted it from the app, even when another channel of the
  // same group published (and started its 7 days) long before
  it('keeps the file of a reminder that was sent and not posted yet', () => {
    const where = pendingPostsUsing('https://media.hookstep.in/reel.mp4');
    expect(where.OR[0].state.in).toContain('REMINDER_SENT');
  });

  // Discord posts a file over its upload limit as a link to our URL, so the
  // published message keeps pointing at the file. Purging it 7 days later
  // left the Discord post with a dead link. Deleting the post in Hookpost
  // doesn't remove the Discord message, so deleted ones count too.
  it('keeps a video that a published Discord post links to', () => {
    const where = pendingPostsUsing('https://media.hookstep.in/big.mp4');
    expect(where.image).toEqual({
      contains: 'https://media.hookstep.in/big.mp4',
    });
    expect(where.OR).toContainEqual({
      state: 'PUBLISHED',
      integration: { providerIdentifier: { in: ['discord'] } },
    });
    expect(where).not.toHaveProperty('deletedAt');
  });

  it('deletes only URLs under the bucket URL', () => {
    const base = 'https://media.hookstep.in';
    expect(isOurUrl('https://media.hookstep.in/Ab3dE6gH9j.mp4', base)).toBe(true);
    expect(isOurUrl('https://cdn.example.com/Ab3dE6gH9j.mp4', base)).toBe(false);
    expect(isOurUrl('https://media.hookstep.in.evil.com/x.mp4', base)).toBe(false);
    expect(isOurUrl('', base)).toBe(false);
  });
});
