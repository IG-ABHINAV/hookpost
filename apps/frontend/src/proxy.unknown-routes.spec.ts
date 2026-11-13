/**
 * @jest-environment node
 *
 * An anonymous request to a URL that is not a page must get Next's own 404, not
 * a 307 to the sign-up form (audit IDX-03). The signed-in app and the public
 * pages must behave exactly as before.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import { NextRequest } from 'next/server';
import { proxy } from '@hookpost/frontend/proxy';

const get = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`https://hookpost.hookstep.in${path}`, { headers }));

const location = (res: Response) => res.headers.get('location');

// A session the proxy counts as signed in: a JWT whose exp is in the future
// (proxy.ts only reads exp; the backend checks the signature).
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SESSION = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  id: 'user-1',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.signature`;

describe('proxy: anonymous visitor on a URL that is not a page', () => {
  it.each([
    '/this-page-does-not-exist-xyz',
    '/feed',
    '/old-blog/some-post',
    '/wp-admin/install',
  ])('%s falls through to the 404 instead of redirecting to /auth', async (p) => {
    const res = await get(p);
    expect(res.status).toBe(200); // NextResponse.next(): Next renders the 404
    expect(location(res)).toBeNull();
  });
});

describe('proxy: anonymous visitor on the signed-in app', () => {
  it.each([
    '/launches',
    '/launches/week',
    '/analytics',
    '/settings',
    '/media',
    '/plugs',
    '/agents',
    '/agents/abc123',
    '/third-party',
    '/affiliate',
    '/admin/users',
    '/err',
  ])('%s still goes to /auth', async (p) => {
    const res = await get(p);
    expect(res.status).toBe(307);
    expect(new URL(location(res)!).pathname).toBe('/auth');
  });

  it.each([
    ['/billing', '/billing'],
    ['/billing/lifetime', '/billing/lifetime'],
    ['/billing?plan=standard', '/billing?plan=standard'],
  ])(
    '%s goes to the login form and comes back to %s after sign-in',
    async (p, back) => {
      const res = await get(p);
      expect(res.status).toBe(307);
      const to = new URL(location(res)!);
      expect(to.origin).toBe('https://hookpost.hookstep.in');
      expect(to.pathname).toBe('/auth/login');
      expect(to.searchParams.get('returnUrl')).toBe(back);
    }
  );

  // Claude's connector sends a new visitor here; without returnUrl they signed
  // up, landed on /launches and the connector never got its code.
  const AUTHORIZE =
    '/oauth/authorize?response_type=code&client_id=pcd_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=xyz&code_challenge_method=S256&state=s1&scope=claudeai';

  it('/oauth/authorize goes to the sign-up form and comes back to the same request', async () => {
    const res = await get(AUTHORIZE);
    expect(res.status).toBe(307);
    const to = new URL(location(res)!);
    expect(to.origin).toBe('https://hookpost.hookstep.in');
    expect(to.pathname).toBe('/auth');
    expect(to.searchParams.get('returnUrl')).toBe(AUTHORIZE);
    // Only returnUrl: the authorize params are not spread onto /auth any more.
    expect([...to.searchParams.keys()]).toEqual(['returnUrl']);
  });

  it('/oauth/authorize after a session ended goes to the login form with returnUrl', async () => {
    const res = await get(AUTHORIZE, { cookie: 'hp_logged_in=1' });
    const to = new URL(location(res)!);
    expect(to.pathname).toBe('/auth/login');
    expect(to.searchParams.get('returnUrl')).toBe(AUTHORIZE);
  });

  it('leaves a signed-in /oauth/authorize alone', async () => {
    const res = await get(AUTHORIZE, { cookie: `auth=${SESSION}` });
    expect(location(res)).toBeNull();
  });

  it('builds returnUrl from its own path, never from a returnUrl it was given', async () => {
    const res = await get('/billing?returnUrl=https://evil.example/');
    const back = new URL(location(res)!).searchParams.get('returnUrl')!;
    expect(back.startsWith('/billing?')).toBe(true);
    expect(new URL(back, 'https://hookpost.hookstep.in').origin).toBe(
      'https://hookpost.hookstep.in'
    );
  });

  it('leaves a signed-in /billing alone', async () => {
    const res = await get('/billing', { cookie: `auth=${SESSION}` });
    expect(location(res)).toBeNull();
  });

  it('keeps the provider hint for /settings', async () => {
    const res = await get('/settings?code=abc');
    expect(location(res)).toContain('/auth?code=abc&provider=');
  });

  it.each(['/login', '/signin', '/sign-in', '/register', '/signup', '/dashboard'])(
    '%s (a spelling of "sign in") still goes to /auth',
    async (p) => {
      const res = await get(p);
      expect(res.status).toBe(307);
      expect(new URL(location(res)!).pathname).toBe('/auth');
    }
  );
});

describe('proxy: routes that must never be touched by the 404 change', () => {
  it.each([
    '/auth',
    '/auth/login',
    '/auth/register',
    '/auth/forgot/abc',
    '/p/AbC123',
    '/provider/add',
    '/mcp-oauth-claude',
    '/.well-known/security.txt',
    '/.well-known/oauth-protected-resource',
    '/integrations/social/x',
    '/pricing',
    '/alternatives/postiz',
    '/compare/buffer-vs-hootsuite',
    '/vs/hootsuite',
    '/guides/claude-mcp-social-media',
    '/redeem',
    '/sitemap.xml',
    '/robots.txt',
  ])('%s is served, not redirected', async (p) => {
    const res = await get(p);
    expect(location(res)).toBeNull();
  });

  it('/redeem is served to a signed-in visitor too (the Gumroad receipt links it)', async () => {
    const res = await get('/redeem', { cookie: `auth=${SESSION}` });
    expect(location(res)).toBeNull();
  });

  it('/ stays the homepage for anonymous visitors', async () => {
    expect(location(await get('/'))).toBeNull();
  });

  it('/ still sends a signed-in visitor to the app', async () => {
    const res = await get('/', { cookie: `auth=${SESSION}` });
    expect(res.status).toBe(307);
    expect(new URL(location(res)!).pathname).toBe('/launches');
  });

  it('an unknown URL is also left alone for a signed-in visitor', async () => {
    const res = await get('/this-page-does-not-exist-xyz', {
      cookie: `auth=${SESSION}`,
    });
    expect(location(res)).toBeNull();
  });
});

describe('proxy: capitalised marketing URLs', () => {
  it('308s /Pricing to /pricing', async () => {
    const res = await get('/Pricing');
    expect(res.status).toBe(308);
    expect(location(res)).toBe('https://hookpost.hookstep.in/pricing');
  });

  it('keeps the rest of the path and the query string', async () => {
    const res = await get('/Alternatives/Postiz?utm_source=x');
    expect(res.status).toBe(308);
    expect(location(res)).toBe(
      'https://hookpost.hookstep.in/alternatives/postiz?utm_source=x'
    );
  });

  it('does not lowercase case-sensitive app ids', async () => {
    expect(location(await get('/p/AbC123'))).toBeNull();
    expect(
      location(await get('/Agents/AbC123', { cookie: `auth=${SESSION}` }))
    ).toBeNull();
    expect(location(await get('/auth/forgot/AbC123'))).toBeNull();
  });
});
