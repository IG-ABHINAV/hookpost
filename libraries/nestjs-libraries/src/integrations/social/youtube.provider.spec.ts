import 'reflect-metadata';

const thumbnailsSet = jest.fn();
const reportsQuery = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })) },
    youtube: jest.fn(() => ({ thumbnails: { set: thumbnailsSet } })),
    youtubeAnalytics: jest.fn(() => ({ reports: { query: reportsQuery } })),
  },
}));

import { YoutubeProvider } from '@hookpost/nestjs-libraries/integrations/social/youtube.provider';

const pendingData = {
  uploadUri: 'https://upload',
  videoSize: 100,
  path: 'https://x/a.mp4',
  uploadedBytes: 100,
  thumbnail: 'https://x/t.png',
  videoId: 'VID1',
};

const setup = () => {
  const provider: any = new YoutubeProvider();
  provider.getSsrfSafeAxios = () => async () => ({ data: 'STREAM' });
  return provider;
};

describe('YoutubeProvider thumbnail failure', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    thumbnailsSet.mockReset();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('keeps the post published when only the thumbnail upload fails', async () => {
    thumbnailsSet.mockRejectedValue({
      response: { data: { error: { errors: [{ reason: 'forbidden' }], message: 'youtube.thumbnail' } } },
    });

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(res).toEqual({
      status: 'completed',
      postId: 'VID1',
      releaseURL: 'https://www.youtube.com/watch?v=VID1',
      warning: expect.any(String),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VID1'));
  });

  // Google's real answer for a channel that isn't phone-verified (the
  // 28 Sep - 18 Oct 2026).
  it('tells the user to verify the channel when YouTube refuses custom covers', async () => {
    thumbnailsSet.mockRejectedValue({
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message:
              "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
            errors: [{ domain: 'youtube.thumbnail', reason: 'forbidden' }],
          },
        },
      },
    });

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(res.status).toBe('completed');
    expect(res.warning).toContain('verified channel');
    expect(res.warning).toContain('https://www.youtube.com/verify');
  });

  it('does not blame verification when the cover itself was the problem', async () => {
    thumbnailsSet.mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: "The provided image content is invalid.",
            errors: [{ domain: 'youtube.thumbnail', reason: 'invalidImage' }],
          },
        },
      },
    });

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(res.status).toBe('completed');
    expect(res.warning).toContain("didn't accept your custom cover image");
    expect(res.warning).not.toContain('verif');
  });

  it('returns the video URL as before when the thumbnail is set', async () => {
    thumbnailsSet.mockResolvedValue({});

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(thumbnailsSet).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      status: 'completed',
      postId: 'VID1',
      releaseURL: 'https://www.youtube.com/watch?v=VID1',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('has nothing to warn about when the post has no cover', async () => {
    const res = await setup().finalizePost(
      'tok',
      { ...pendingData, thumbnail: '' },
      {} as any
    );

    expect(thumbnailsSet).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('warning');
  });

  // The cover is fetched from our own storage before YouTube sees it. A 403
  // from that GET (Cloudflare, a private object) carries statusText
  // "Forbidden", which is not YouTube refusing an unverified channel.
  it('does not blame verification when our storage refused the cover', async () => {
    const provider = setup();
    provider.getSsrfSafeAxios = () => async () => {
      throw {
        message: 'Request failed with status code 403',
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: '<html><head><title>403 Forbidden</title></head></html>',
        },
      };
    };

    const res = await provider.finalizePost('tok', pendingData, {} as any);

    expect(res.status).toBe('completed');
    expect(thumbnailsSet).not.toHaveBeenCalled();
    expect(res.warning).toContain("didn't accept your custom cover image");
    expect(res.warning).not.toContain('verif');
  });

  // A real GaxiosError serializes its request config (headers, the media
  // stream) before the response, so Google's domain and reason land past the
  // 4000-char cut on the BadBody details. That is what happened on 19 Oct 2026
  // (post cmvf09zjg0000incwodn6i9rt): only the mapped message said why.
  const bigConfig = { config: { body: 'x'.repeat(6000) } };

  it('tells the user to verify when the raw error was truncated out of the details', async () => {
    thumbnailsSet.mockRejectedValue({
      ...bigConfig,
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message:
              "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
            errors: [{ domain: 'youtube.thumbnail', reason: 'forbidden' }],
          },
        },
      },
    });

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('custom thumbnail could not be set: Your account is not verified')
    );
    expect(res.status).toBe('completed');
    expect(res.warning).toContain('verified channel');
    expect(res.warning).toContain('https://www.youtube.com/verify');
  });

  it('reads the verified-channel case from the mapped message alone', () => {
    const warning = YoutubeProvider.thumbnailWarning({
      message:
        'Your account is not verified, we have uploaded your video but we could not set the thumbnail. Please verify your account and try again.',
      details: [{ json: '{"config":{"body":"xxxx… [truncated 4638 chars]' }],
    });

    expect(warning).toContain('verified channel');
    expect(warning).toContain('https://www.youtube.com/verify');
  });

  it('does not blame verification for a bad cover image even when truncated', async () => {
    thumbnailsSet.mockRejectedValue({
      ...bigConfig,
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: 'The provided image content is invalid.',
            errors: [{ domain: 'youtube.thumbnail', reason: 'invalidImage' }],
          },
        },
      },
    });

    const res = await setup().finalizePost('tok', pendingData, {} as any);

    expect(res.status).toBe('completed');
    expect(res.warning).toContain("didn't accept your custom cover image");
    expect(res.warning).not.toContain('verif');
  });

  it('only maps thumbnail errors to "not verified" when YouTube said forbidden', () => {
    const provider = new YoutubeProvider();
    const notVerified = /account is not verified/i;

    expect(
      provider.handleErrors(
        '{"errors":[{"domain":"youtube.thumbnail","reason":"forbidden"}]}'
      )?.value
    ).toMatch(notVerified);
    expect(
      provider.handleErrors(
        '{"errors":[{"domain":"youtube.thumbnail","reason":"invalidImage"}]}'
      )?.value ?? ''
    ).not.toMatch(notVerified);
  });
});

describe('YoutubeProvider.analytics units', () => {
  it('marks Average View Duration as seconds and Average View Percentage as percent', async () => {
    reportsQuery.mockResolvedValue({
      data: {
        columnHeaders: [
          { name: 'day' },
          { name: 'averageViewDuration' },
          { name: 'averageViewPercentage' },
        ],
        rows: [['2026-10-13', 29.4, 70.96]],
      },
    });

    const result = await new YoutubeProvider().analytics('ch', 'tok', 7);

    expect(
      result.find((p) => p.label === 'Average View Duration')
    ).toMatchObject({ average: true, format: 'duration' });
    expect(
      result.find((p) => p.label === 'Average View Percentage')
    ).toMatchObject({ average: true, format: 'percent' });
  });
});
