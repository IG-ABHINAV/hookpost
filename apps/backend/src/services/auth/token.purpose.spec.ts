// Every token Hookpost signs: a login session (JWT_SECRET) or one of the
// TOKEN_PURPOSE kinds (a key derived from JWT_SECRET for that purpose). Each
// verifier takes its own kind only. Until 22 Oct 2026 every kind was a plain
// JWT_SECRET token and no verifier told them apart.
//   pnpm exec jest -c apps/backend/jest.config.ts token.purpose

import { sign } from 'jsonwebtoken';
import {
  AuthService,
  isSessionPayload,
  TOKEN_PURPOSE,
  TokenPurpose,
} from '@hookpost/helpers/auth/auth.service';

const JWT_SECRET = 'token-purpose-spec-secret';
const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, JWT_SECRET };
});
afterAll(() => {
  process.env = { ...ENV };
});

const PURPOSES = Object.values(TOKEN_PURPOSE) as TokenPurpose[];
const claims = { id: 'user-1', email: 'a@b.co', orgId: 'org-1', billing: 'ULTIMATE' };

describe('purpose tokens', () => {
  it('there is one purpose per kind, all different', () => {
    expect(new Set(PURPOSES).size).toBe(PURPOSES.length);
  });

  it.each(PURPOSES)('a %s token verifies for its own purpose only', (purpose) => {
    const token = AuthService.signPurposeJWT(purpose, claims);
    expect(AuthService.verifyPurposeJWT(purpose, token)).toMatchObject({ ...claims, purpose });
    for (const other of PURPOSES.filter((p) => p !== purpose)) {
      expect(() => AuthService.verifyPurposeJWT(other, token)).toThrow();
    }
    expect(() => AuthService.verifySessionJWT(token)).toThrow();
    // Not even the raw JWT_SECRET check passes: it has its own key.
    expect(() => AuthService.verifyJWT(token)).toThrow();
  });

  it.each(PURPOSES)('a session, and a plain JWT_SECRET token claiming %s, are not that purpose', (purpose) => {
    expect(() => AuthService.verifyPurposeJWT(purpose, AuthService.signSessionJWT({ ...claims, password: null }))).toThrow();
    expect(() => AuthService.verifyPurposeJWT(purpose, sign({ ...claims, purpose }, JWT_SECRET))).toThrow();
  });

  it('a purpose token past its expiry is refused', () => {
    const token = AuthService.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      { ...claims, iat: Math.floor(Date.now() / 1000) - 3 * 86400 },
      { expiresIn: '2d' }
    );
    expect(() => AuthService.verifyPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, token)).toThrow();
  });

  it('the keys change with JWT_SECRET', () => {
    const token = AuthService.signPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, claims);
    process.env.JWT_SECRET = 'another-secret';
    expect(() => AuthService.verifyPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, token)).toThrow();
  });

  it('an unsigned (alg none) token is refused', () => {
    const none = sign({ ...claims, purpose: TOKEN_PURPOSE.PLAN_CHANGE }, '', { algorithm: 'none' });
    expect(() => AuthService.verifyPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, none)).toThrow();
    expect(() => AuthService.verifySessionJWT(sign({ id: 'user-1' }, '', { algorithm: 'none' }))).toThrow();
  });
});

describe('login sessions', () => {
  it('a session is the user row and verifies as one', () => {
    const session = AuthService.signSessionJWT({ id: 'user-1', email: 'a@b.co', activated: true, password: null });
    expect(AuthService.verifySessionJWT(session)).toMatchObject({ id: 'user-1' });
  });

  it.each([
    ['a reset link from before 22 Oct', { id: 'user-1', expires: '2099-01-01 00:00:00' }],
    ['an invite link from before 22 Oct', { id: 'abcde', orgId: 'org-1', timeLimit: '2099-01-01 00:00:00' }],
    ['a token that names a purpose', { id: 'user-1', purpose: 'anything' }],
    ['a token with no id', { discount: true }],
    ['a token with an empty id', { id: '' }],
    ['a token whose id is not a string', { id: 42 }],
  ])('%s is not a session', (_label, payload) => {
    expect(isSessionPayload(payload)).toBe(false);
    expect(() => AuthService.verifySessionJWT(sign(payload, JWT_SECRET))).toThrow();
  });

  it.each([undefined, '', 42, 'not-a-token'])('%p is not a session', (token) => {
    expect(() => AuthService.verifySessionJWT(token)).toThrow();
  });
});
