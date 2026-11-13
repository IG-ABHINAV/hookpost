import 'reflect-metadata';
import {
  FacebookProvider,
  metaOAuthError,
} from '@hookpost/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@hookpost/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@hookpost/nestjs-libraries/integrations/social/instagram.standalone.provider';

// Page insights as the Graph API returns them for period=day: each value's
// end_time is the end of the Pacific-time day it covers (07:00 UTC next day).
const insights = {
  data: [
    {
      name: 'page_total_media_view_unique',
      values: [
        { value: 955, end_time: '2026-10-14T07:00:00+0000' },
        { value: 2, end_time: '2026-10-15T07:00:00+0000' },
      ],
    },
    {
      name: 'page_daily_follows',
      values: [
        { value: 0, end_time: '2026-10-14T07:00:00+0000' },
        { value: 1, end_time: '2026-10-15T07:00:00+0000' },
      ],
    },
  ],
};

describe('FacebookProvider.analytics (GET /analytics/:id)', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      json: async () => insights,
    })) as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('dates each value by the day it covers, not the day after', async () => {
    const [views] = await new FacebookProvider().analytics('page', 'tok', 7);
    expect(views.data).toEqual([
      { total: 955, date: '2026-10-13' },
      { total: 2, date: '2026-10-14' },
    ]);
  });

  it('labels page_daily_follows as new followers, not the follower count', async () => {
    const result = await new FacebookProvider().analytics('page', 'tok', 7);
    expect(result.map((p) => p.label)).toEqual([
      'Page Impressions',
      'New followers',
    ]);
  });
});

// The Graph response stored with the four Facebook/Instagram posts that failed
// in production on 2026-10-11 (fbtrace_id dropped). The same tokens published
// again from 2026-10-12 without a reconnect.
const checkpoint = JSON.stringify({
  error: {
    message:
      'You cannot access the app till you log in to www.facebook.com and follow the instructions given.',
    type: 'OAuthException',
    code: 190,
    error_data: '{"checkpoint_url":"https:\\/\\/www.facebook.com"}',
    error_subcode: 459,
  },
});

const oauth190 = (
  error_subcode?: number,
  message = 'Invalid OAuth access token.'
) =>
  JSON.stringify({
    error: { message, type: 'OAuthException', code: 190, error_subcode },
  });

describe('metaOAuthError (Graph API code 190)', () => {
  it("keeps a checkpoint (190/459) a per-post error with Meta's instruction", () => {
    const result = metaOAuthError(checkpoint, 'Facebook');
    expect(result?.type).toBe('bad-body');
    expect(result?.value).toContain('log in to www.facebook.com');
    expect(result?.value).toContain('does not need reconnecting');
  });

  it('treats an unconfirmed user (190/464) the same way', () => {
    expect(
      metaOAuthError(
        oauth190(
          464,
          'Sessions for the user are not allowed because the user is not a confirmed user.'
        ),
        'Facebook'
      )?.type
    ).toBe('bad-body');
  });

  it.each([undefined, 458, 460, 463, 467, 492])(
    'asks for a reconnect for 190/%s',
    (subcode) => {
      const result = metaOAuthError(oauth190(subcode), 'Instagram');
      expect(result?.type).toBe('refresh-token');
      expect(result?.value).toContain('please reconnect the channel');
    }
  );

  it('ignores anything that is not code 190', () => {
    expect(
      metaOAuthError(
        JSON.stringify({
          error: { message: 'x', code: 200, error_subcode: 190 },
        }),
        'Facebook'
      )
    ).toBeUndefined();
    expect(metaOAuthError('<html>502</html>', 'Facebook')).toBeUndefined();
    expect(metaOAuthError('{}', 'Facebook')).toBeUndefined();
  });
});

describe('Meta providers classify code 190', () => {
  const instagram = new InstagramProvider();
  const standalone = new InstagramStandaloneProvider();
  const facebook = new FacebookProvider();

  it('Instagram no longer calls a checkpoint "missing some permissions"', () => {
    const result = instagram.handleErrors(checkpoint, 400);
    expect(result?.type).toBe('bad-body');
    expect(result?.value).not.toContain('missing some permissions');
    expect(result?.value).toContain('log in to www.facebook.com');
  });

  it('Instagram flags a dead token for reconnect instead of a bad_body', () => {
    expect(instagram.handleErrors(oauth190(), 400)?.type).toBe('refresh-token');
    expect(standalone.handleErrors(oauth190(), 400)?.type).toBe(
      'refresh-token'
    );
  });

  it('Facebook recognises the checkpoint instead of leaving it unclassified', () => {
    const result = facebook.handleErrors(checkpoint, 400);
    expect(result?.type).toBe('bad-body');
    expect(result?.value).toContain('does not need reconnecting');
  });

  // Meta also sends checkpoints with the generic prefix ("Error validating
  // access token: You cannot access the app till ..."). The prefix alone must
  // not flag the channel for a reconnect that the checkpoint doesn't need.
  it.each([
    [
      459,
      'Error validating access token: You cannot access the app till you log in to www.facebook.com and follow the instructions given.',
    ],
    [
      464,
      'Error validating access token: Sessions for the user are not allowed because the user is not a confirmed user.',
    ],
  ])(
    'Facebook keeps a prefixed checkpoint (190/%s) a per-post error',
    (subcode, message) => {
      const result = facebook.handleErrors(oauth190(subcode, message), 400);
      expect(result?.type).toBe('bad-body');
      expect(result?.value).toContain('does not need reconnecting');
    }
  );

  it('Facebook flags any other 190 for reconnect', () => {
    expect(
      facebook.handleErrors(oauth190(458, 'Error: app not installed'), 400)
        ?.type
    ).toBe('refresh-token');
  });

  it('keeps the existing Facebook token messages', () => {
    expect(
      facebook.handleErrors(
        oauth190(463, 'Error validating access token: Session has expired'),
        400
      )
    ).toEqual({
      type: 'refresh-token',
      value: 'Please re-authenticate your Facebook account',
    });
  });

  it('leaves non-token Instagram errors alone', () => {
    expect(
      instagram.handleErrors(
        JSON.stringify({
          error: { message: 'x', code: 36003, error_subcode: 2207009 },
        }),
        400
      )?.type
    ).toBe('bad-body');
  });
});
