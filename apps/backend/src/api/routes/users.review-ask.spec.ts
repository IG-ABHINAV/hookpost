import 'reflect-metadata';

// The review card's routes over real HTTP, through Nest's ValidationPipe and
// cookie-parser as main.ts installs them: GET /user/review-ask answers only
// `ask` (never why not), POST takes JSON only with a known action (and a
// known target for `clicked`), and while an admin impersonates the user
// neither route reads or records anything for that user. ReviewAskService
// is a fake here; tests/integration/review-ask.int.spec.ts runs the real one.
//   pnpm exec jest -c apps/backend/jest.config.ts users.review-ask

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

const USER = { id: 'user-1', email: 'jo@example.com', activated: true };
const reviewAsk = {
  status: jest.fn(async () => ({ ask: true, moment: 'POSTS_PUBLISHED' })),
  record: jest.fn(async () => ({ ok: true })),
};

let app: INestApplication;
let base: string;
const savedNotSecured = process.env.NOT_SECURED;

beforeAll(async () => {
  delete process.env.NOT_SECURED;
  const moduleRef = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [
      { provide: SubscriptionService, useValue: {} },
      { provide: RazorpayService, useValue: {} },
      { provide: AuthService, useValue: {} },
      { provide: OrganizationService, useValue: {} },
      { provide: UsersService, useValue: {} },
      { provide: TrackService, useValue: {} },
      { provide: AffiliateService, useValue: {} },
      { provide: ReviewAskService, useValue: reviewAsk },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());
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
  if (savedNotSecured === undefined) delete process.env.NOT_SECURED;
  else process.env.NOT_SECURED = savedNotSecured;
});

beforeEach(() => jest.clearAllMocks());

const post = (body: unknown, opts: { type?: string; cookie?: string } = {}) =>
  fetch(`${base}/user/review-ask`, {
    method: 'POST',
    headers: {
      'content-type': opts.type || 'application/json',
      cookie: opts.cookie || 'auth=session',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /user/review-ask', () => {
  it('answers only whether the card is due', async () => {
    const res = await fetch(`${base}/user/review-ask`, { headers: { cookie: 'auth=session' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ask: true });
    expect(reviewAsk.status).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), false);
  });

  it('never says why not (no reason reaches the page)', async () => {
    reviewAsk.status.mockResolvedValueOnce({ ask: false, reason: 'internal domain hookstep.in' } as any);
    const res = await fetch(`${base}/user/review-ask`, { headers: { cookie: 'auth=session' } });
    expect(await res.json()).toEqual({ ask: false });
  });

  it('tells the service an admin is impersonating', async () => {
    await fetch(`${base}/user/review-ask`, { headers: { cookie: 'auth=session; impersonate=user-1' } });
    expect(reviewAsk.status).toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe('POST /user/review-ask', () => {
  it.each([
    [{ action: 'shown' }, 'shown', undefined],
    [{ action: 'dismissed' }, 'dismissed', undefined],
    [{ action: 'clicked', target: 'g2' }, 'clicked', 'g2'],
    [{ action: 'clicked', target: 'play' }, 'clicked', 'play'],
  ])('%j is recorded (200)', async (body, action, target) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reviewAsk.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER.id }),
      false,
      action,
      target
    );
  });

  it.each([
    [{}],
    [{ action: 'rated' }],
    [{ action: 'clicked' }],
    [{ action: 'clicked', target: 'trustpilot' }],
    [{ action: ['shown'] }],
  ])('%j is refused with 400, nothing recorded', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(reviewAsk.record).not.toHaveBeenCalled();
  });

  it.each([
    ['application/x-www-form-urlencoded', 'action=shown'],
    ['text/plain', '{"action":"shown"}'],
  ])('a cross-site form (%s) cannot spend the ask: refused, nothing recorded', async (type, body) => {
    const res = await post(body, { type });
    expect([400, 415]).toContain(res.status);
    expect(reviewAsk.record).not.toHaveBeenCalled();
  });

  it('while impersonating, the service is told so (and records nothing)', async () => {
    reviewAsk.record.mockResolvedValueOnce({ ok: false });
    const res = await post({ action: 'shown' }, { cookie: 'auth=session; impersonate=user-1' });
    expect(await res.json()).toEqual({ ok: false });
    expect(reviewAsk.record).toHaveBeenCalledWith(expect.anything(), true, 'shown', undefined);
  });
});
