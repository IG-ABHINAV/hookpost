/**
 * SignupAttributionService.recordSignup: what a new account stores from the
 * hp_attr cookie and the request, and the CompleteRegistration it reports to
 * Meta's Conversions API (fbc, fbp, the event id the browser pixel reuses).
 * Neither the database nor Meta can fail or stall a sign-up.
 *   pnpm exec jest -c apps/backend/jest.config.ts signup-attribution
 */
import 'reflect-metadata';

jest.mock('@hookpost/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));

import {
  registrationEventId,
  SignupAttributionService,
  signupFbclid,
} from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';

const user = { id: 'user-1', email: 'new@example.com' } as any;
const SEEN = Date.UTC(2026, 9, 22, 10, 0, 0);
const cookie = JSON.stringify({
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: 'hp_ww_sales',
  utm_content: 'face_9x16',
  fbclid: 'IwAR0abcDEF123',
  landing_path: '/claude',
  referrer: 'https://l.instagram.com/',
  first_seen_at: SEEN,
});
const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54';

const setup = (create: jest.Mock = jest.fn(async () => ({}))) => {
  const track = { track: jest.fn(async () => undefined) };
  const repo = { model: { signupAttribution: { create, updateMany: jest.fn(async () => ({ count: 1 })) } } };
  const service = new SignupAttributionService(repo as any, {} as any, track as any);
  return { service, track, create, repo };
};

beforeAll(() => {
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
});

describe('SignupAttributionService.recordSignup', () => {
  it('stores the first touch, device, in-app browser and country with the workspace', async () => {
    const { service, create } = setup();
    const eventId = await service.recordSignup({
      organizationId: 'org-1',
      user,
      method: 'LOCAL',
      cookies: { hp_attr: cookie, _fbp: 'fb.1.1729590000000.1234567890' },
      ip: '203.0.113.9',
      userAgent: IG_UA,
      country: 'IN',
      sourceUrl: 'https://hookpost.hookstep.in/auth?utm_source=meta',
    });
    expect(eventId).toBe(registrationEventId('user-1'));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        method: 'LOCAL',
        utmSource: 'meta',
        utmMedium: 'paid_social',
        utmCampaign: 'hp_ww_sales',
        utmContent: 'face_9x16',
        fbclid: 'IwAR0abcDEF123',
        fbc: `fb.1.${SEEN}.IwAR0abcDEF123`,
        fbp: 'fb.1.1729590000000.1234567890',
        landingPath: '/claude',
        referrer: 'https://l.instagram.com/',
        firstSeenAt: new Date(SEEN),
        device: 'mobile',
        inApp: 'instagram',
        country: 'IN',
        eventId: 'reg_user-1',
      }),
    });
  });

  it('reports CompleteRegistration to Meta with fbc, fbp, the event id and our page (no query)', async () => {
    const { service, track } = setup();
    await service.recordSignup({
      organizationId: 'org-1',
      user,
      method: 'GOOGLE',
      cookies: { hp_attr: cookie, _fbp: 'fb.1.1729590000000.1234567890' },
      ip: '203.0.113.9',
      userAgent: IG_UA,
      sourceUrl: 'https://hookpost.hookstep.in/auth?code=secret',
    });
    expect(track.track).toHaveBeenCalledWith(
      'reg_user-1',
      '203.0.113.9',
      IG_UA,
      TrackEnum.CompleteRegistration,
      {},
      `fb.1.${SEEN}.IwAR0abcDEF123`,
      user,
      { fbp: 'fb.1.1729590000000.1234567890', sourceUrl: 'https://hookpost.hookstep.in/auth', fbclidSeenAt: SEEN }
    );
  });

  it("prefers the pixel's own _fbc, and drops cookies that are not Meta's format", async () => {
    const { service, track, create } = setup();
    await service.recordSignup({
      organizationId: 'org-2',
      user,
      method: 'GOOGLE_ONE_TAP',
      cookies: { hp_attr: cookie, _fbc: 'fb.1.1729500000000.PIXELCLICKID99', _fbp: '<script>' },
      sourceUrl: 'https://evil.example/page',
    });
    const data = create.mock.calls[0][0].data;
    expect(data.fbc).toBe('fb.1.1729500000000.PIXELCLICKID99');
    expect(data.fbp).toBeUndefined();
    const extra = (track.track.mock.calls[0] as any[])[7];
    expect(extra.fbp).toBeUndefined();
    // Another site's URL is never sent as our event source.
    expect(extra.sourceUrl).toBeUndefined();
  });

  describe('a real-length fbclid (44 of 61 in production\'s log of 19-22 Oct were over 150 characters)', () => {
    const LONG = `IwZXh0bgNhZW0BMABhZGlkAasT_${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv-Wx_aem_'.repeat(5)}`.slice(0, 200);
    const withFbclid = (fbclid: string) => JSON.stringify({ utm_source: 'meta', fbclid, first_seen_at: SEEN });

    it('is stored whole and becomes the fbc Meta gets', async () => {
      const { service, track, create } = setup();
      await service.recordSignup({ organizationId: 'org-7', user, method: 'LOCAL', cookies: { hp_attr: withFbclid(LONG) } });
      const data = create.mock.calls[0][0].data;
      expect(data.fbclid).toBe(LONG);
      expect(data.fbc).toBe(`fb.1.${SEEN}.${LONG}`);
      expect((track.track.mock.calls[0] as any[])[5]).toBe(`fb.1.${SEEN}.${LONG}`);
    });

    it("the fbclid cookie's whole id wins over a shortened copy of it in hp_attr, dated by hp_attr", async () => {
      const { service, create } = setup();
      await service.recordSignup({
        organizationId: 'org-8',
        user,
        method: 'LOCAL',
        cookies: { hp_attr: withFbclid(LONG.slice(0, 150)), fbclid: LONG },
      });
      const data = create.mock.calls[0][0].data;
      expect(data.fbclid).toBe(LONG);
      expect(data.fbc).toBe(`fb.1.${SEEN}.${LONG}`);
    });

    it('the fbclid cookie fills in when hp_attr has none; a different click in hp_attr stays the first touch', async () => {
      const before = Date.now();
      const { service, create } = setup();
      await service.recordSignup({
        organizationId: 'org-9',
        user,
        method: 'LOCAL',
        cookies: { hp_attr: JSON.stringify({ utm_source: 'google', gclid: 'G-1', first_seen_at: SEEN }), fbclid: LONG },
      });
      const filled = create.mock.calls[0][0].data;
      expect(filled.fbclid).toBe(LONG);
      // Not the Google visit's time: when the click was seen is unknown.
      const at = Number(filled.fbc.split('.')[2]);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(filled.fbc).toBe(`fb.1.${at}.${LONG}`);

      expect(signupFbclid(LONG, 'IwAR_first_touch_click')).toBe('IwAR_first_touch_click');
    });

    it('an fbclid cookie that is not a click id is ignored', () => {
      expect(signupFbclid('<script>alert(1)</script>', undefined)).toBeUndefined();
      expect(signupFbclid('x'.repeat(501), 'IwAR0abcDEF123')).toBe('IwAR0abcDEF123');
      expect(signupFbclid(undefined, 'IwAR0abcDEF123')).toBe('IwAR0abcDEF123');
    });
  });

  it('a reset or activation link is never stored or sent: its path is the secret', async () => {
    const { service, track, create } = setup();
    await service.recordSignup({
      organizationId: 'org-5',
      user,
      method: 'LOCAL',
      cookies: { hp_attr: JSON.stringify({ utm_source: 'meta', landing_path: '/auth/forgot/tok.en.sig' }) },
      sourceUrl: 'https://hookpost.hookstep.in/auth/activate/co.de.sig',
    });
    const data = create.mock.calls[0][0].data;
    expect(data.utmSource).toBe('meta');
    expect(data.landingPath).toBeUndefined();
    expect(((track.track.mock.calls[0] as any[])[7] as any).sourceUrl).toBeUndefined();
  });

  // hp_attr_s: the backend's HttpOnly copy of the first touch (/public/t).
  // Safari drops the script-written hp_attr after 7 days, or 24 hours after
  // an ad click; the copy is what is left by the time the visitor signs up.
  describe('the server copy (hp_attr_s)', () => {
    const DIRECT = JSON.stringify({ landing_path: '/', first_seen_at: SEEN + 10 * 86_400_000 });
    const record = async (cookies: Record<string, string>) => {
      const { service, create } = setup();
      await service.recordSignup({ organizationId: 'org-s', user, method: 'LOCAL', cookies });
      return create.mock.calls[0][0].data;
    };

    it('stands in when hp_attr is gone', async () => {
      expect(await record({ hp_attr_s: cookie })).toMatchObject({
        utmCampaign: 'hp_ww_sales',
        fbclid: 'IwAR0abcDEF123',
        fbc: `fb.1.${SEEN}.IwAR0abcDEF123`,
        landingPath: '/claude',
        firstSeenAt: new Date(SEEN),
      });
    });

    it('a tagged copy wins over an untagged hp_attr written after Safari dropped the first', async () => {
      expect(await record({ hp_attr: DIRECT, hp_attr_s: cookie })).toMatchObject({
        utmCampaign: 'hp_ww_sales',
        landingPath: '/claude',
      });
    });

    it('of two tagged touches the earlier wins, whichever cookie holds it', async () => {
      const later = JSON.stringify({ utm_source: 'google', utm_campaign: 'later', gclid: 'G-2', first_seen_at: SEEN + 86_400_000 });
      expect((await record({ hp_attr: later, hp_attr_s: cookie })).utmCampaign).toBe('hp_ww_sales');
      expect((await record({ hp_attr: cookie, hp_attr_s: later })).utmCampaign).toBe('hp_ww_sales');
    });

    it('hp_attr wins a tie, and a forged copy counts for nothing', async () => {
      const same = JSON.stringify({ utm_source: 'meta', utm_campaign: 'other', first_seen_at: SEEN });
      expect((await record({ hp_attr: cookie, hp_attr_s: same })).utmCampaign).toBe('hp_ww_sales');
      expect(
        await record({ hp_attr: cookie, hp_attr_s: JSON.stringify({ evil: '<script>', first_seen_at: 1 }) })
      ).toMatchObject({ utmCampaign: 'hp_ww_sales' });
      expect(await record({ hp_attr_s: '%7Bnot-json' })).toMatchObject({ utmCampaign: undefined, utmSource: undefined });
    });
  });

  it('no cookie: an untagged row, no fbc', async () => {
    const { service, create } = setup();
    await service.recordSignup({ organizationId: 'org-3', user, method: 'LOCAL', cookies: {}, userAgent: '' });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ utmSource: undefined, fbc: undefined, device: 'desktop', inApp: null });
  });

  it('a database error (no table yet) never fails the sign-up, and Meta still hears of it', async () => {
    const { service, track } = setup(jest.fn(async () => {
      throw new Error('relation "SignupAttribution" does not exist');
    }));
    await expect(
      service.recordSignup({ organizationId: 'org-4', user, method: 'LOCAL', cookies: { hp_attr: cookie } })
    ).resolves.toBe('reg_user-1');
    expect(track.track).toHaveBeenCalled();
  });

  it('Meta failing or hanging never fails or holds up the sign-up', async () => {
    const { service, track } = setup();
    track.track.mockImplementation(() => new Promise(() => undefined));
    await expect(
      service.recordSignup({ organizationId: 'org-5', user, method: 'LOCAL', cookies: {} })
    ).resolves.toBe('reg_user-1');
    track.track.mockRejectedValue(new Error('graph.facebook.com 500'));
    await expect(
      service.recordSignup({ organizationId: 'org-6', user, method: 'LOCAL', cookies: {} })
    ).resolves.toBe('reg_user-1');
  });
});

describe('trial and first charge', () => {
  it('are set once per workspace', async () => {
    const { service, repo } = setup();
    const at = new Date(SEEN);
    await service.markTrialStarted('org-1', at);
    await service.markPaid('org-1', at);
    expect(repo.model.signupAttribution.updateMany).toHaveBeenNthCalledWith(1, {
      where: { organizationId: 'org-1', trialStartedAt: null },
      data: { trialStartedAt: at },
    });
    expect(repo.model.signupAttribution.updateMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-1', paidAt: null },
      data: { paidAt: at },
    });
  });
});
