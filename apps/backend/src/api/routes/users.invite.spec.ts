import 'reflect-metadata';

// The Join question's routes over real HTTP, through Nest's own body parsers
// and cookie-parser as main.ts installs them (25 Oct 2026). A signed-in
// account joins a team only by POST /user/invite/accept from the app's own
// page: a cross-site form (urlencoded, multipart, text/plain), a request
// without the app's Origin, a GET, or a click on a page that showed another
// invite must all be refused before anything is redeemed. AuthService is a
// fake here; tests/integration/invite-link.int.spec.ts runs the real one.
//   pnpm exec jest -c apps/backend/jest.config.ts users.invite

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
jest.mock('@hookpost/backend/services/auth/auth.service', () => ({
  AuthService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.service',
  () => ({ ReviewAskService: class {} })
);

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { UsersController } from './users.controller';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { AuthService } from '@hookpost/backend/services/auth/auth.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import { ReviewAskService } from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.service';
import { inviteRef } from '@hookpost/backend/services/auth/invite.ref';

const APP = 'https://hookpost.hookstep.in';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnZpdGUiOjF9.c2lnbmF0dXJl';
const OTHER = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnZpdGUiOjJ9.c2lnbmF0dXJl';
const INVITE = { orgId: 'org-team', id: 'inv01', role: 'USER', timeLimit: '2999-01-01 00:00:00' };
const USER = { id: 'user-1', email: 'jo@example.com', activated: true };

const auth = {
  getOrgFromCookie: jest.fn((t?: string) => (t === TOKEN || t === OTHER ? { ...INVITE } : false)),
  pendingInvite: jest.fn(async () => ({ valid: true, team: 'Acme', inviter: null, member: false, confirmEmail: false, ref: inviteRef(TOKEN) })),
  redeemInvite: jest.fn(async (_u: unknown, invite: unknown) =>
    invite ? { outcome: 'joined', organizationId: INVITE.orgId } : null
  ),
};

let app: INestApplication;
let base: string;
const saved = { FRONTEND_URL: process.env.FRONTEND_URL, NOT_SECURED: process.env.NOT_SECURED, MAIN_URL: process.env.MAIN_URL };

beforeAll(async () => {
  process.env.FRONTEND_URL = APP;
  delete process.env.NOT_SECURED;
  delete process.env.MAIN_URL;
  const moduleRef = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [
      { provide: SubscriptionService, useValue: {} },
      { provide: RazorpayService, useValue: {} },
      { provide: AuthService, useValue: auth },
      { provide: OrganizationService, useValue: {} },
      { provide: UsersService, useValue: {} },
      { provide: TrackService, useValue: {} },
      { provide: AffiliateService, useValue: {} },
      { provide: ReviewAskService, useValue: {} },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());
  // auth.middleware's part: a signed-in account, its session cookie sent.
  app.use((req: any, _res: any, next: any) => {
    req.user = { ...USER };
    req.org = { id: 'org-own' };
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => jest.clearAllMocks());

const send = (
  method: string,
  path: string,
  opts: { type?: string; body?: string | FormData; origin?: string | null; cookie?: string | null } = {}
) => {
  const headers: Record<string, string> = {};
  if (opts.type) headers['content-type'] = opts.type;
  if (opts.origin !== null) headers.origin = opts.origin ?? APP;
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? `auth=session; invite_pending=${TOKEN}`;
  return fetch(`${base}${path}`, { method, headers, body: opts.body, redirect: 'manual' });
};
const json = (path: string, body: unknown, opts: { origin?: string | null; cookie?: string | null } = {}) =>
  send('POST', path, { type: 'application/json', body: JSON.stringify(body), ...opts });
const setCookie = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

describe('GET /user/invite: the question, never a join', () => {
  it('reads the invite in the httpOnly cookie for the signed-in user', async () => {
    const res = await send('GET', '/user/invite');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, team: 'Acme', ref: inviteRef(TOKEN) });
    expect(auth.pendingInvite).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), TOKEN);
    expect(auth.redeemInvite).not.toHaveBeenCalled();
    // Asking changes nothing in the browser either.
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a token in the query or a body is not read', async () => {
    await send('GET', `/user/invite?org=${OTHER}&token=${OTHER}`, { cookie: 'auth=session' });
    expect(auth.pendingInvite).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('there is no GET (or HEAD) that accepts, and /user/join-org is gone', async () => {
    for (const [method, path] of [
      ['GET', '/user/invite/accept'],
      ['HEAD', '/user/invite/accept'],
      ['GET', `/user/invite/accept?ref=${inviteRef(TOKEN)}`],
      ['GET', '/user/join-org'],
    ]) {
      expect((await send(method, path)).status).toBe(404);
    }
    expect((await json('/user/join-org', { org: TOKEN })).status).toBe(404);
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });
});

describe('POST /user/invite/accept: a cross-site page cannot join anyone', () => {
  const ref = inviteRef(TOKEN);

  it('urlencoded, multipart and text/plain forms: 415, nothing redeemed', async () => {
    const multipart = new FormData();
    multipart.append('ref', ref);
    for (const res of [
      await send('POST', '/user/invite/accept', { type: 'application/x-www-form-urlencoded', body: `ref=${ref}` }),
      await send('POST', '/user/invite/accept', { body: multipart }),
      // The text/plain trick: a form whose body happens to be JSON.
      await send('POST', '/user/invite/accept', { type: 'text/plain', body: `{"ref":"${ref}","x":"="}` }),
      await send('POST', '/user/invite/accept', { type: 'text/plain; x=application/json', body: JSON.stringify({ ref }) }),
      await send('POST', '/user/invite/accept', {}),
    ]) {
      expect(res.status).toBe(415);
      expect(setCookie(res, 'invite_pending')).toBeUndefined();
      expect(setCookie(res, 'showorg')).toBeUndefined();
    }
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['no Origin', null],
    ['Origin: null', 'null'],
    ['another site', 'https://evil.example'],
    ['a sibling *.hookstep.in host (same site, so the Lax cookie is sent)', 'https://media.hookstep.in'],
    ['plain http', 'http://hookpost.hookstep.in'],
  ])('JSON from %s: 403, nothing redeemed', async (_what, origin) => {
    const res = await json('/user/invite/accept', { ref }, { origin });
    expect(res.status).toBe(403);
    expect(setCookie(res, 'invite_pending')).toBeUndefined();
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('a ref for another invite (another link opened since the page asked): 409, nothing redeemed, the question kept', async () => {
    for (const bad of [inviteRef(OTHER), '', 'x', undefined, 42]) {
      const res = await json('/user/invite/accept', { ref: bad });
      expect(res.status).toBe(409);
      expect((await res.json()).invite).toBe('changed');
      expect(setCookie(res, 'invite_pending')).toBeUndefined();
    }
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('the token in the body is ignored: only the cookie the GET of the link set counts', async () => {
    const res = await json('/user/invite/accept', { ref: inviteRef(OTHER), org: OTHER, token: OTHER }, { cookie: 'auth=session' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: null, invite: 'invalid' });
    expect(auth.redeemInvite).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), false);
  });

  it("the app's JSON with the ref it was shown: redeemed once for that user, the question answered", async () => {
    const res = await json('/user/invite/accept', { ref });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: INVITE.orgId, invite: 'joined' });
    expect(auth.redeemInvite).toHaveBeenCalledTimes(1);
    expect(auth.redeemInvite).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), INVITE);
    const pending = setCookie(res, 'invite_pending')!;
    expect(pending).toMatch(/^invite_pending=;/);
    expect(pending).toMatch(/Domain=\.hookstep\.in/);
    expect(pending).toMatch(/Path=\//);
    expect(pending).toMatch(/HttpOnly/);
    expect(pending).toMatch(/Secure/);
    expect(pending).toMatch(/SameSite=Lax/i);
    // Expired now (express turns maxAge -1 into Max-Age=-1 and an Expires in the past).
    expect(pending).toMatch(/Max-Age=-1;/);
    expect(setCookie(res, 'hp_invite')).toMatch(/^hp_invite=joined;/);
    expect(setCookie(res, 'showorg')).toMatch(/^showorg=org-team;/);
    // The sign-in invite cookie is not touched.
    expect(setCookie(res, 'org')).toBeUndefined();
  });

  it('an outcome without a workspace (held, full, invalid) answers the question without switching workspace', async () => {
    for (const outcome of ['held', 'full', 'unavailable', 'invalid', 'error']) {
      auth.redeemInvite.mockResolvedValueOnce({ outcome } as any);
      const res = await json('/user/invite/accept', { ref });
      expect(await res.json()).toEqual({ id: null, invite: outcome });
      expect(setCookie(res, 'hp_invite')).toMatch(new RegExp(`^hp_invite=${outcome};`));
      expect(setCookie(res, 'invite_pending')).toMatch(/^invite_pending=;/);
      expect(setCookie(res, 'showorg')).toBeUndefined();
    }
  });
});

describe('POST /user/invite/dismiss ("Not now")', () => {
  it('removes the question and redeems nothing', async () => {
    const res = await json('/user/invite/dismiss', {});
    expect(res.status).toBe(200);
    expect(setCookie(res, 'invite_pending')).toMatch(/^invite_pending=; Max-Age=-1;/);
    expect(setCookie(res, 'hp_invite')).toBeUndefined();
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('the same CSRF checks as Join', async () => {
    expect((await send('POST', '/user/invite/dismiss', { type: 'application/x-www-form-urlencoded', body: 'a=1' })).status).toBe(415);
    expect((await json('/user/invite/dismiss', {}, { origin: 'https://evil.example' })).status).toBe(403);
  });
});
