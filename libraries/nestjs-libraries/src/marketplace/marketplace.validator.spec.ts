/**
 * The Social Post Validator (marketplace.validator.ts) must say what
 * Hookpost's own providers say: the same character limit (maxLength) and the
 * same pass or fail on media (checkValidity). When a provider's rule changes
 * and PLATFORM_RULES does not, this fails.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.validator
 */
import { XProvider } from '@hookpost/nestjs-libraries/integrations/social/x.provider';
import { LinkedinProvider } from '@hookpost/nestjs-libraries/integrations/social/linkedin.provider';
import { ThreadsProvider } from '@hookpost/nestjs-libraries/integrations/social/threads.provider';
import { FacebookProvider } from '@hookpost/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@hookpost/nestjs-libraries/integrations/social/instagram.provider';
import { YoutubeProvider } from '@hookpost/nestjs-libraries/integrations/social/youtube.provider';
import { PinterestProvider } from '@hookpost/nestjs-libraries/integrations/social/pinterest.provider';
import { TiktokProvider } from '@hookpost/nestjs-libraries/integrations/social/tiktok.provider';
import { DiscordProvider } from '@hookpost/nestjs-libraries/integrations/social/discord.provider';
import { SlackProvider } from '@hookpost/nestjs-libraries/integrations/social/slack.provider';
import { BlueskyProvider } from '@hookpost/nestjs-libraries/integrations/social/bluesky.provider';
import { MastodonProvider } from '@hookpost/nestjs-libraries/integrations/social/mastodon.provider';
import {
  mediaErrors,
  PLATFORM_RULES,
  validateDraft,
  ValidatorMedia,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.validator';

// The providers themselves (integration.manager.ts would load every network,
// Nostr's ESM-only client included).
const PROVIDERS: any[] = [
  new XProvider(),
  new LinkedinProvider(),
  new ThreadsProvider(),
  new FacebookProvider(),
  new InstagramProvider(),
  new YoutubeProvider(),
  new PinterestProvider(),
  new TiktokProvider(),
  new DiscordProvider(),
  new SlackProvider(),
  new BlueskyProvider(),
  new MastodonProvider(),
];
const provider = (id: string): any => PROVIDERS.find((p) => p.identifier === id);

describe('parity with the providers', () => {
  it.each(PLATFORM_RULES.map((r) => [r.platform, r]))(
    '%s: the same character limit as the provider',
    (platform, rule) => {
      const p = provider(platform as string);
      expect(p).toBeDefined();
      expect(rule.maxChars).toBe(p.maxLength());
    }
  );

  it('X Premium: 4,000, as the provider says for a verified account', () => {
    expect(PLATFORM_RULES.find((r) => r.platform === 'x')!.premiumMaxChars).toBe(
      provider('x').maxLength([{ title: 'Verified', value: true }])
    );
  });

  // Media combinations the providers judge from the paths alone (Pinterest's
  // same-size check fetches the images, so several pictures are left out).
  const combos: Record<string, ('image' | 'video')[][]> = {
    common: [
      [],
      ['image'],
      ['video'],
      ['image', 'image'],
      ['image', 'video'],
      ['video', 'video'],
      ['image', 'image', 'image', 'image'],
      ['image', 'image', 'image', 'image', 'image'],
      Array(11).fill('image'),
    ],
  };
  const asPaths = (kinds: ('image' | 'video')[]) =>
    kinds.map((k, i) => ({ path: `https://media.example/${i}.${k === 'video' ? 'mp4' : 'jpg'}` }));
  const asMedia = (kinds: ('image' | 'video')[]): ValidatorMedia[] => kinds.map((type) => ({ type }));

  for (const rule of PLATFORM_RULES) {
    for (const kinds of combos.common.filter(
      (k) =>
        // Pinterest fetches 2 to 5 pictures to compare their sizes.
        !(rule.platform === 'pinterest' && !k.includes('video') && k.length > 1 && k.length <= 5)
    )) {
      it(
        `${rule.platform}: [${kinds.join(', ')}] passes or fails as the provider says`,
        async () => {
          const verdict = await provider(rule.platform).checkValidity([asPaths(kinds)], {}, []);
          expect(mediaErrors(rule, asMedia(kinds)).length === 0).toBe(verdict === true);
        }
      );
    }
  }
});

describe('validateDraft', () => {
  it('counts X by weight, Threads in UTF-8 bytes and the rest in characters', () => {
    const [x, threads, linkedin] = validateDraft({
      text: '🔥'.repeat(141),
      platforms: ['x', 'threads', 'linkedin'],
    });
    expect(x).toMatchObject({ chars: 282, limit: 280, valid: false });
    expect(threads).toMatchObject({ chars: 564, limit: 500, valid: false });
    expect(linkedin.valid).toBe(true);
  });

  it('passes X Premium up to 4,000', () => {
    const [x] = validateDraft({ text: 'a'.repeat(1000), platforms: ['x'], xPremium: true });
    expect(x).toMatchObject({ valid: true, limit: 4000 });
  });

  it('needs a video for YouTube and media for Instagram', () => {
    const [yt, ig] = validateDraft({ text: 'hello', media: [{ type: 'image' }], platforms: ['youtube', 'instagram'] });
    expect(yt.valid).toBe(false);
    expect(yt.errors.join(' ')).toMatch(/needs a video/);
    expect(ig.valid).toBe(true);
    expect(validateDraft({ text: 'hello', platforms: ['instagram'] })[0].valid).toBe(false);
  });

  it('checks Pinterest image sizes when they are given, and a video cover', () => {
    const [same] = validateDraft({
      text: 'pins',
      media: [
        { type: 'image', width: 1000, height: 1500 },
        { type: 'image', width: 1000, height: 1500 },
      ],
      platforms: ['pinterest'],
    });
    expect(same.valid).toBe(true);
    const [mixed] = validateDraft({
      text: 'pins',
      media: [
        { type: 'image', width: 1000, height: 1500 },
        { type: 'image', width: 1080, height: 1080 },
      ],
      platforms: ['pinterest'],
    });
    expect(mixed.valid).toBe(false);
    expect(validateDraft({ text: 'v', media: [{ type: 'video' }], platforms: ['pinterest'] })[0].valid).toBe(false);
    expect(
      validateDraft({ text: 'v', media: [{ type: 'video', has_cover: true }], platforms: ['pinterest'] })[0].valid
    ).toBe(true);
  });

  it('flags uploads over our limits', () => {
    const [li] = validateDraft({ text: 'big', media: [{ type: 'image', bytes: 11 * 1024 * 1024 }], platforms: ['linkedin'] });
    expect(li.valid).toBe(false);
  });

  it('warns about links where they do not work', () => {
    const [ig] = validateDraft({ text: 'see example.com', media: [{ type: 'image' }], platforms: ['instagram'] });
    expect(ig.valid).toBe(true);
    expect(ig.warnings.join(' ')).toMatch(/not clickable/);
  });

  it('refuses an empty post and names an unknown platform', () => {
    expect(validateDraft({ text: ' ', platforms: ['x'] })[0].valid).toBe(false);
    expect(validateDraft({ text: 'a', platforms: ['myspace'] })[0].errors[0]).toMatch(/Unknown platform/);
  });
});
