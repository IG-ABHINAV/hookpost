/**
 * Every provider the add-channel screen can offer, checked once: a unique
 * identifier, the methods the connect flow and the post workflow call, a
 * positive length limit, and a connect URL (or custom-fields state) that
 * carries a state and points at our own callback. Covers the long tail that
 * has no spec of its own (GMB, TikTok Business, Dribbble, Kick, Twitch,
 * Mastodon, Farcaster, VK, Medium, Whop, Skool, MeWe, Tumblr, ...).
 *
 * Network-free: X is left out of the URL check because building its link asks
 * X for an OAuth 1.0a request token (x.provider.spec.ts covers X).
 */
import 'reflect-metadata';

// nostr-tools pulls in ESM-only @noble packages jest's CommonJS runtime cannot
// parse; Node can require() them (as in nostr.provider.spec.ts).
jest.mock('nostr-tools', () =>
  (process as any).getBuiltinModule('module').createRequire(__filename)('nostr-tools')
);

import {
  IntegrationManager,
  RETIRED_PROVIDERS,
  socialIntegrationList,
} from '@hookpost/nestjs-libraries/integrations/integration.manager';

const FRONTEND = 'https://app.example.test';
const saved = { ...process.env };

beforeAll(() => {
  process.env.FRONTEND_URL = FRONTEND;
  // Any *_CLIENT_ID / *_APP_ID style variable a URL builder reads gets a fake
  // value; none of them is sent anywhere.
  for (const key of [
    'FACEBOOK_APP_ID', 'INSTAGRAM_APP_ID', 'THREADS_APP_ID', 'LINKEDIN_CLIENT_ID',
    'YOUTUBE_CLIENT_ID', 'PINTEREST_CLIENT_ID', 'TIKTOK_CLIENT_ID', 'DISCORD_CLIENT_ID',
    'SLACK_ID', 'DRIBBBLE_CLIENT_ID', 'KICK_CLIENT_ID', 'TWITCH_CLIENT_ID',
    'MASTODON_CLIENT_ID', 'VK_ID', 'GOOGLE_GMB_CLIENT_ID', 'WHOP_CLIENT_ID',
    'TUMBLR_CLIENT_ID', 'MEWE_CLIENT_ID', 'SKOOL_CLIENT_ID',
  ]) {
    process.env[key] = `${key.toLowerCase()}-test`;
  }
});
afterAll(() => {
  process.env = saved;
});

const EDITORS = ['none', 'normal', 'markdown', 'html'];

describe('provider registry', () => {
  it('identifiers are unique and every listed provider is reachable by id', () => {
    const ids = socialIntegrationList.map((p) => p.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    const manager = new IntegrationManager();
    for (const id of ids) expect(manager.getSocialIntegration(id)?.identifier).toBe(id);
  });

  it('HIDDEN_PROVIDERS hides a provider from the add-channel list only', async () => {
    process.env.HIDDEN_PROVIDERS = 'tumblr, mewe';
    const manager = new IntegrationManager();
    const listed = (await manager.getAllIntegrations()).social.map((p) => p.identifier);
    expect(listed).not.toContain('tumblr');
    expect(listed).not.toContain('mewe');
    expect(manager.getSocialIntegration('tumblr')).toBeDefined();
    delete process.env.HIDDEN_PROVIDERS;
  });

  describe('RETIRED_PROVIDERS (Medium)', () => {
    afterEach(() => {
      delete process.env.HIDDEN_PROVIDERS;
    });
    const listed = async () =>
      (await new IntegrationManager().getAllIntegrations()).social.map((p) => p.identifier);

    it('Medium is retired, and every retired id is a real provider', () => {
      expect(RETIRED_PROVIDERS).toContain('medium');
      const ids = socialIntegrationList.map((p) => p.identifier);
      for (const id of RETIRED_PROVIDERS) expect(ids).toContain(id);
    });

    it('Medium is not offered in Add Channel with HIDDEN_PROVIDERS unset, empty or naming others', async () => {
      for (const value of [undefined, '', ' , ', 'tumblr,mewe']) {
        if (value === undefined) delete process.env.HIDDEN_PROVIDERS;
        else process.env.HIDDEN_PROVIDERS = value;
        expect({ value, listed: (await listed()).includes('medium') }).toEqual({ value, listed: false });
        expect(new IntegrationManager().isHiddenProvider('medium')).toBe(true);
      }
    });

    it('a channel already connected to Medium still resolves: refresh, publish and the reconnect check', () => {
      const manager = new IntegrationManager();
      // getSocialIntegration feeds the post workflow and the refresh service;
      // getAllowedSocialsIntegrations gates GET /integrations/social/:provider
      // (the reconnect link) and the channel list.
      expect(manager.getSocialIntegration('medium')?.identifier).toBe('medium');
      expect(manager.getAllowedSocialsIntegrations()).toContain('medium');
      expect(socialIntegrationList.some((p) => p.identifier === 'medium')).toBe(true);
    });

    it('every other provider is listed exactly as HIDDEN_PROVIDERS says', async () => {
      delete process.env.HIDDEN_PROVIDERS;
      const all = socialIntegrationList.map((p) => p.identifier);
      expect(await listed()).toEqual(all.filter((id) => id !== 'medium'));

      process.env.HIDDEN_PROVIDERS = 'tumblr';
      expect(await listed()).toEqual(all.filter((id) => id !== 'medium' && id !== 'tumblr'));
      for (const id of ['devto', 'hashnode', 'wordpress', 'bluesky', 'linkedin', 'x']) {
        expect(await listed()).toContain(id);
      }
    });

    it('naming Medium in HIDDEN_PROVIDERS too changes nothing', async () => {
      process.env.HIDDEN_PROVIDERS = 'medium';
      const all = socialIntegrationList.map((p) => p.identifier);
      expect(await listed()).toEqual(all.filter((id) => id !== 'medium'));
    });

    it('a provider whose identifier merely contains "medium" is not hidden', () => {
      const manager = new IntegrationManager();
      for (const id of ['medium-v2', 'mediums', 'Medium', ' medium']) {
        expect({ id, hidden: manager.isHiddenProvider(id) }).toEqual({ id, hidden: false });
      }
    });
  });

  describe.each(socialIntegrationList.map((p) => [p.identifier, p] as const))('%s', (id, provider: any) => {
    it('has a name, an editor and a positive length limit', () => {
      expect(typeof provider.name).toBe('string');
      expect(provider.name.trim().length).toBeGreaterThan(0);
      expect(EDITORS).toContain(provider.editor);
      const max = provider.maxLength();
      expect(Number.isFinite(max) && max > 0).toBe(true);
    });

    it('implements what the connect flow and the post workflow call', () => {
      for (const method of ['generateAuthUrl', 'authenticate', 'refreshToken', 'post', 'checkValidity', 'checkPostStatus', 'finalizePost']) {
        expect({ id, method, type: typeof provider[method] }).toEqual({ id, method, type: 'function' });
      }
      expect(Array.isArray(provider.scopes)).toBe(true);
    });

    if (id !== 'x') {
      it('builds a connect URL with a state, back to our own callback', async () => {
        const auth = await provider.generateAuthUrl();
        expect(typeof auth.state).toBe('string');
        expect(auth.state.length).toBeGreaterThan(3);
        expect(typeof auth.codeVerifier).toBe('string');
        if (provider.customFields) {
          // Credentials typed into our own form (Bluesky, Telegram, ...): no
          // third-party consent page.
          expect(Array.isArray(await provider.customFields())).toBe(true);
          return;
        }
        if (/^https?:\/\//.test(auth.url)) {
          const url = new URL(auth.url);
          expect(url.protocol).toBe('https:');
          const all = decodeURIComponent(auth.url);
          // The state round-trips through the provider (or inside its own state blob).
          expect(all).toContain(auth.state);
          // Callback, when the provider takes one in the URL, is ours.
          const redirect = url.searchParams.get('redirect_uri');
          if (redirect) expect(redirect.startsWith(FRONTEND) || /redirectmeto\.com/.test(redirect)).toBe(true);
        }
      });
    }
  });
});
