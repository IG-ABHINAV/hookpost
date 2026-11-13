// The CSRF checks of routes a cross-site page must not be able to reach
// (json.only.ts): JSON only, and for joining a team, an Origin of the app.
//   pnpm exec jest -c apps/backend/jest.config.ts json.only
import { HttpException } from '@nestjs/common';
import {
  appOrigins,
  assertAppOrigin,
  assertJsonRequest,
} from '@hookpost/backend/services/auth/json.only';
import { inviteRef, inviteRefMatches } from '@hookpost/backend/services/auth/invite.ref';

const req = (headers: Record<string, string | undefined>) => ({ headers } as any);
const status = (fn: () => void) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as HttpException).getStatus();
  }
};

const saved = { FRONTEND_URL: process.env.FRONTEND_URL, MAIN_URL: process.env.MAIN_URL };
beforeEach(() => {
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  delete process.env.MAIN_URL;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('assertJsonRequest', () => {
  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
    'text/plain; x=application/json',
    '',
    undefined,
  ])('%s: 415', (type) => {
    expect(status(() => assertJsonRequest(req({ 'content-type': type })))).toBe(415);
  });

  it('application/json (any case, with a charset): through', () => {
    expect(status(() => assertJsonRequest(req({ 'content-type': 'application/json' })))).toBe(200);
    expect(status(() => assertJsonRequest(req({ 'content-type': 'Application/JSON; charset=utf-8' })))).toBe(200);
  });
});

describe('assertAppOrigin', () => {
  it("the app's own origin: through", () => {
    expect(status(() => assertAppOrigin(req({ origin: 'https://hookpost.hookstep.in' })))).toBe(200);
  });

  it.each([
    ['no Origin', undefined],
    ['"null" (a sandboxed frame or a file)', 'null'],
    ['another site', 'https://evil.example'],
    ['a sibling host on the same site', 'https://media.hookstep.in'],
    ['the parent domain', 'https://hookstep.in'],
    ['plain http', 'http://hookpost.hookstep.in'],
    ['another port', 'https://hookpost.hookstep.in:8443'],
    ['a look-alike', 'https://hookpost.hookstep.in.evil.example'],
    ['a path glued on', 'https://hookpost.hookstep.in/'],
    ['the MCP inspector CORS allows in development', 'http://localhost:6274'],
  ])('%s: 403', (_what, origin) => {
    expect(status(() => assertAppOrigin(req({ origin })))).toBe(403);
  });

  it('MAIN_URL counts when it is set, as CORS does; a bad URL adds nothing', () => {
    process.env.MAIN_URL = 'https://app.example.com/some/path';
    expect(appOrigins()).toEqual(new Set(['https://hookpost.hookstep.in', 'https://app.example.com']));
    expect(status(() => assertAppOrigin(req({ origin: 'https://app.example.com' })))).toBe(200);
    process.env.MAIN_URL = 'not a url';
    expect(appOrigins()).toEqual(new Set(['https://hookpost.hookstep.in']));
  });

  it('no FRONTEND_URL at all: nothing passes', () => {
    delete process.env.FRONTEND_URL;
    expect(status(() => assertAppOrigin(req({ origin: 'https://hookpost.hookstep.in' })))).toBe(403);
  });
});

describe('inviteRef', () => {
  const token = 'aaa.bbb.ccc';
  it('is short, stable and URL-safe, and differs per token', () => {
    expect(inviteRef(token)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(inviteRef(token)).toBe(inviteRef(token));
    expect(inviteRef('aaa.bbb.ccd')).not.toBe(inviteRef(token));
  });

  it('matches only its own token', () => {
    expect(inviteRefMatches(token, inviteRef(token))).toBe(true);
    for (const ref of [inviteRef('x.y.z'), '', undefined, null, 42, { ref: 1 }, `${inviteRef(token)}x`, inviteRef(token).slice(1)]) {
      expect(inviteRefMatches(token, ref)).toBe(false);
    }
  });
});
