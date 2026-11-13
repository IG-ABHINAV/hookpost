import 'reflect-metadata';
import { XProvider } from '@hookpost/nestjs-libraries/integrations/social/x.provider';

const images = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `https://x/p${i}.png` }));
const video = { path: 'https://x/clip.mp4' };

describe('XProvider.checkValidity (POST /posts/valid)', () => {
  const provider = new XProvider();

  it('accepts up to 4 pictures, or one video, per tweet', async () => {
    await expect(provider.checkValidity([images(4)], {})).resolves.toBe(true);
    await expect(provider.checkValidity([[video]], {})).resolves.toBe(true);
    await expect(provider.checkValidity([[], images(2)], {})).resolves.toBe(
      true
    );
  });

  it('refuses a fifth picture, in the post or in a reply', async () => {
    await expect(provider.checkValidity([images(5)], {})).resolves.toBe(
      'X allows up to 4 pictures per post'
    );
    await expect(
      provider.checkValidity([images(1), images(5)], {})
    ).resolves.toBe('X allows up to 4 pictures per post');
  });

  it('refuses a video together with a picture, in the post or in a reply', async () => {
    await expect(
      provider.checkValidity([[video, ...images(1)]], {})
    ).resolves.toBe('X allows one video per post, without pictures');
    await expect(
      provider.checkValidity([[], [video, video]], {})
    ).resolves.toBe('X allows one video per post, without pictures');
  });

  it('keeps the article rules for long-form posts', async () => {
    await expect(
      provider.checkValidity([images(6)], {
        post_type: 'article',
        article_status: 'published',
      })
    ).resolves.toBe(true);
    await expect(
      provider.checkValidity([[video]], { post_type: 'article' })
    ).resolves.toBe('X articles only support images');
  });
});

describe('XProvider.handleErrors (publishing)', () => {
  const provider = new XProvider();

  // Both shapes stored on 11 Sep 2026: plain v2 body from the tweet call, and
  // the twitter-api-v2 error wrapper from the media upload.
  const plain =
    '{"detail":"credits depleted","status":402,"title":"Payment Required","type":"https://api.x.com/2/problems/credits-depleted"}';
  const wrapped = JSON.stringify({
    type: 'response',
    code: 402,
    error: JSON.parse(plain),
  });

  it('names an empty X API credit balance instead of "Unknown Error"', () => {
    for (const body of [plain, wrapped]) {
      const handled = provider.handleErrors(body);
      expect(handled?.type).toBe('bad-body');
      expect(handled?.value).toMatch(/X posting is temporarily unavailable/);
    }
  });

  it('does not treat a usage cap as a credit problem', () => {
    expect(
      provider.handleErrors('{"type":"https://api.x.com/2/problems/usage-capped"}')?.value
    ).toMatch(/capped/);
  });
});
