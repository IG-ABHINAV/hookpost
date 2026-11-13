/**
 * Sign-up attribution end to end: the hp_attr cookie the marketing pages
 * write is stored with the new workspace for every sign-up method (email,
 * Google, Google One Tap, GitHub), CompleteRegistration goes to Meta's
 * Conversions API with the click id and the event id the browser pixel
 * reuses, an existing account signing in records nothing, and the
 * super-admin report counts sign-ups, trials and paid per campaign.
 *
 * Meta is not called: TrackService.track is replaced by a spy (and has no
 * token here anyway). Google's ID tokens are signed with a test key, GitHub's
 * profile lookup is stubbed; nothing leaves the machine.
 */
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail } from './setup/api';
import { addChannel, db, disconnectDb, makeSuperAdmin } from './setup/db';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { SignupAttributionService } from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import { GithubProvider } from '@hookpost/backend/services/auth/providers/github.provider';

const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SEEN = Date.now() - 3600_000;
const RUN = randomUUID().slice(0, 8);

const attr = (campaign: string, extra: Record<string, unknown> = {}) =>
  encodeURIComponent(
    JSON.stringify({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: campaign,
      fbclid: `IwAR${RUN}`,
      landing_path: '/claude',
      referrer: 'https://l.instagram.com/',
      first_seen_at: SEEN,
      ...extra,
    })
  );

describe('sign-up attribution', () => {
  let t: TestApp;
  let track: jest.SpyInstance;
  let admin: Session;
  const CLIENT_ID = 'attribution-test.apps.googleusercontent.com';
  const KID = 'attribution-key';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v: object | Buffer) =>
    (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
  const googleIdToken = (claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: `g-${randomUUID()}`,
      email: uniqueEmail('attr-google'),
      email_verified: true,
      name: 'Attribution Test',
      iat: now,
      exp: now + 600,
      ...claims,
    })}`;
    return `${head}.${b64(sign('RSA-SHA256', Buffer.from(head), privateKey))}`;
  };
  const savedClientId = process.env.YOUTUBE_CLIENT_ID;

  beforeAll(async () => {
    process.env.YOUTUBE_CLIENT_ID = CLIENT_ID;
    jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      format: 'PEM',
    } as any);
    t = await startApp();
    track = jest.spyOn(TrackService.prototype, 'track').mockResolvedValue(undefined as any);
    admin = await t.api.register({ company: 'Attribution HQ' });
    await makeSuperAdmin((await admin.self()).id);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (savedClientId === undefined) delete process.env.YOUTUBE_CLIENT_ID;
    else process.env.YOUTUBE_CLIENT_ID = savedClientId;
    await t?.close();
    await disconnectDb();
  });
  beforeEach(() => track.mockClear());

  const rowFor = async (email: string) => {
    const user = await db().user.findFirstOrThrow({
      where: { email },
      include: { organizations: true },
    });
    return {
      user,
      row: await db().signupAttribution.findUnique({
        where: { organizationId: user.organizations[0].organizationId },
      }),
    };
  };

  it('email: stores the first touch with the workspace and reports CompleteRegistration with the same event id', async () => {
    const email = uniqueEmail('attr-email');
    const res = await t.api.post(
      '/auth/register',
      { email, password: 'Correct-Horse-9', company: 'Attr Co', provider: 'LOCAL' },
      {
        cookies: { hp_attr: attr(`email_${RUN}`), _fbp: 'fb.1.1729590000000.987654321' },
        headers: { 'user-agent': IG_UA, 'cf-ipcountry': 'IN', referer: 'http://localhost:4200/auth?x=1' },
      }
    );
    expect(res.status).toBe(200);
    const { user, row } = await rowFor(email);
    expect(res.body.eventId).toBe(`reg_${user.id}`);
    expect(row).toMatchObject({
      userId: user.id,
      method: 'LOCAL',
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmCampaign: `email_${RUN}`,
      fbclid: `IwAR${RUN}`,
      fbc: `fb.1.${SEEN}.IwAR${RUN}`,
      fbp: 'fb.1.1729590000000.987654321',
      landingPath: '/claude',
      referrer: 'https://l.instagram.com/',
      device: 'mobile',
      inApp: 'instagram',
      country: 'IN',
      eventId: `reg_${user.id}`,
    });
    expect(row!.firstSeenAt!.getTime()).toBe(SEEN);
    expect(track).toHaveBeenCalledWith(
      `reg_${user.id}`,
      expect.any(String),
      IG_UA,
      TrackEnum.CompleteRegistration,
      {},
      `fb.1.${SEEN}.IwAR${RUN}`,
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({ fbp: 'fb.1.1729590000000.987654321' })
    );
  });

  it('a real-length fbclid (200 characters) is stored and sent to Meta whole, never shortened', async () => {
    // 44 of 61 fbclids in production's access log of 19-22 Oct were longer
    // than 150 characters, up to 201.
    const fbclid = `IwZXh0bgNhZW0BMABhZGlk_${RUN}_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);
    expect(fbclid).toHaveLength(200);
    const email = uniqueEmail('attr-long-fbclid');
    const res = await t.api.post(
      '/auth/register',
      { email, password: 'Correct-Horse-9', company: 'Attr Co', provider: 'LOCAL' },
      { cookies: { hp_attr: attr(`long_${RUN}`, { fbclid }) } }
    );
    expect(res.status).toBe(200);
    const { user, row } = await rowFor(email);
    expect(row).toMatchObject({ fbclid, fbc: `fb.1.${SEEN}.${fbclid}` });
    expect(track).toHaveBeenCalledWith(
      `reg_${user.id}`,
      expect.any(String),
      expect.any(String),
      TrackEnum.CompleteRegistration,
      {},
      `fb.1.${SEEN}.${fbclid}`,
      expect.objectContaining({ id: user.id }),
      expect.anything()
    );

    // The fbclid cookie (/public/t keeps the id it is given whole) wins over
    // a shortened copy in hp_attr.
    const second = uniqueEmail('attr-fbclid-cookie');
    const res2 = await t.api.post(
      '/auth/register',
      { email: second, password: 'Correct-Horse-9', company: 'Attr Co', provider: 'LOCAL' },
      { cookies: { hp_attr: attr(`cut_${RUN}`, { fbclid: fbclid.slice(0, 150) }), fbclid } }
    );
    expect(res2.status).toBe(200);
    expect((await rowFor(second)).row).toMatchObject({ fbclid, fbc: `fb.1.${SEEN}.${fbclid}` });
  });

  // Safari (ITP) keeps the script-written hp_attr for 7 days, 24 hours after
  // a decorated ad click. The marketing pages post it with their ViewContent
  // to /public/t, and the backend keeps an HttpOnly copy, hp_attr_s.
  it('the server copy: /public/t keeps the first touch in hp_attr_s, and a sign-up after Safari dropped hp_attr still records the ad', async () => {
    const touch = {
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: `itp_${RUN}`,
      fbclid: `IwAR${RUN}`,
      landing_path: '/claude',
      first_seen_at: SEEN,
    };
    const view = { tt: TrackEnum.ViewContent, additional: { content_name: '/claude' } };
    const first = await t.api.post('/public/t', { ...view, attr: { ...touch, evil: '<script>' } });
    expect(first.status).toBe(200);
    const line = first.headers.getSetCookie().find((l) => l.startsWith('hp_attr_s='));
    expect(line).toBeDefined();
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).not.toMatch(/;\s*Domain=/i);
    const copy = line!.split(';')[0].slice('hp_attr_s='.length);
    expect(JSON.parse(decodeURIComponent(copy))).toEqual(touch);

    // Days later Safari has dropped hp_attr, and a direct visit wrote an
    // untagged one: its ViewContent does not replace the copy.
    const direct = { landing_path: '/pricing', first_seen_at: Date.now() - 60_000 };
    const later = await t.api.post('/public/t', { ...view, attr: direct }, { cookies: { hp_attr_s: copy } });
    expect(later.status).toBe(200);
    expect(later.headers.getSetCookie().some((l) => l.startsWith('hp_attr_s='))).toBe(false);

    const email = uniqueEmail('attr-itp');
    const res = await t.api.post(
      '/auth/register',
      { email, password: 'Correct-Horse-9', company: 'Attr Co', provider: 'LOCAL' },
      { cookies: { hp_attr: encodeURIComponent(JSON.stringify(direct)), hp_attr_s: copy } }
    );
    expect(res.status).toBe(200);
    expect((await rowFor(email)).row).toMatchObject({
      utmSource: 'meta',
      utmCampaign: `itp_${RUN}`,
      fbclid: `IwAR${RUN}`,
      fbc: `fb.1.${SEEN}.IwAR${RUN}`,
      landingPath: '/claude',
    });

    // Nothing posted, or nothing valid: no cookie.
    for (const attr of [undefined, 'garbage', { evil: 'x' }]) {
      const none = await t.api.post('/public/t', { ...view, attr });
      expect(none.status).toBe(200);
      expect(none.headers.getSetCookie().some((l) => l.startsWith('hp_attr_s='))).toBe(false);
    }

    // A link stuffed to every limit still gets a small copy (MAX_SERVER_COOKIE).
    const long = (c: string) => c.repeat(500);
    const stuffed = {
      utm_source: 's'.repeat(150), utm_medium: 'm'.repeat(150), utm_campaign: 'c'.repeat(150), utm_content: 'o'.repeat(150), utm_term: 't'.repeat(150),
      gclid: long('g'), fbclid: long('f'), ttclid: long('t'), msclkid: long('k'),
      landing_path: `/claude/${'p'.repeat(192)}`, referrer: `https://example.com/${'r'.repeat(280)}`,
      first_seen_at: SEEN,
    };
    const big = await t.api.post('/public/t', { ...view, attr: stuffed });
    const bigLine = big.headers.getSetCookie().find((l) => l.startsWith('hp_attr_s='));
    expect(bigLine).toBeDefined();
    expect(bigLine!.split(';')[0].slice('hp_attr_s='.length).length).toBeLessThanOrEqual(1536);
  });

  it('Google (redirect flow, the token posted to /auth/register): recorded as GOOGLE', async () => {
    const email = uniqueEmail('attr-google-redirect');
    const res = await t.api.post(
      '/auth/register',
      { provider: 'GOOGLE', providerToken: googleIdToken({ email }), company: 'My workspace' },
      { cookies: { hp_attr: attr(`google_${RUN}`) }, headers: { 'user-agent': MAC_UA } }
    );
    expect(res.status).toBe(200);
    const { user, row } = await rowFor(email);
    expect(res.body.eventId).toBe(`reg_${user.id}`);
    expect(row).toMatchObject({ method: 'GOOGLE', utmCampaign: `google_${RUN}`, device: 'desktop', inApp: null });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('Google One Tap: recorded once; tapping again signs in and records nothing', async () => {
    const email = uniqueEmail('attr-onetap');
    const sub = `g-${randomUUID()}`;
    const first = await t.api.post(
      '/auth/oauth/google/one-tap',
      { credential: googleIdToken({ sub, email }) },
      { cookies: { hp_attr: attr(`onetap_${RUN}`) } }
    );
    expect(first.status).toBe(200);
    const { user, row } = await rowFor(email);
    expect(first.body).toEqual({ login: true, registered: true, eventId: `reg_${user.id}` });
    expect(row).toMatchObject({ method: 'GOOGLE_ONE_TAP', utmCampaign: `onetap_${RUN}` });

    track.mockClear();
    const again = await t.api.post(
      '/auth/oauth/google/one-tap',
      { credential: googleIdToken({ sub, email }) },
      { cookies: { hp_attr: attr(`other_${RUN}`) } }
    );
    expect(again.body).toEqual({ login: true, registered: false });
    expect(track).not.toHaveBeenCalled();
    expect((await rowFor(email)).row!.utmCampaign).toBe(`onetap_${RUN}`);
  });

  it('GitHub: recorded as GITHUB', async () => {
    const email = uniqueEmail('attr-github');
    jest.spyOn(GithubProvider.prototype, 'getUser').mockResolvedValueOnce({
      id: `gh-${randomUUID()}`,
      email,
      emailVerified: true,
    });
    const res = await t.api.post(
      '/auth/register',
      { provider: 'GITHUB', providerToken: 'gho_test', company: 'My workspace' },
      { cookies: { hp_attr: attr(`github_${RUN}`, { gclid: 'G-CLICK' }) } }
    );
    expect(res.status).toBe(200);
    expect((await rowFor(email)).row).toMatchObject({ method: 'GITHUB', utmCampaign: `github_${RUN}`, gclid: 'G-CLICK' });
  });

  it('no cookie, or a forged one: the account is still created, recorded as untagged', async () => {
    for (const cookies of [undefined, { hp_attr: '%7Bnot-json' }, { hp_attr: encodeURIComponent('{"evil":"<script>"}') }]) {
      const email = uniqueEmail('attr-none');
      const res = await t.api.post(
        '/auth/register',
        { email, password: 'Correct-Horse-9', company: 'None Co', provider: 'LOCAL' },
        { cookies }
      );
      expect(res.status).toBe(200);
      expect((await rowFor(email)).row).toMatchObject({ method: 'LOCAL', utmCampaign: null, utmSource: null });
    }
  });

  it('an existing account signing in records nothing', async () => {
    const s = await t.api.register({ company: 'Existing Co' });
    track.mockClear();
    const res = await t.api.post(
      '/auth/login',
      { email: s.email, password: s.password, provider: 'LOCAL' },
      { cookies: { hp_attr: attr(`login_${RUN}`) } }
    );
    expect(res.status).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect((await rowFor(s.email)).row!.utmCampaign).toBeNull();
  });

  it('the super-admin report counts sign-ups, trials and paid per campaign; others are refused', async () => {
    const campaign = `report_${RUN}`;
    const emails = [uniqueEmail('rep1'), uniqueEmail('rep2'), uniqueEmail('rep3')];
    for (const [i, email] of emails.entries()) {
      const res = await t.api.post(
        '/auth/register',
        { email, password: 'Correct-Horse-9', company: 'Report Co', provider: 'LOCAL' },
        { cookies: { hp_attr: attr(campaign) }, headers: { 'user-agent': i === 0 ? MAC_UA : IG_UA } }
      );
      expect(res.status).toBe(200);
    }
    const service = t.get<SignupAttributionService>(SignupAttributionService);
    const org = async (email: string) => (await rowFor(email)).row!.organizationId;
    await service.markTrialStarted(await org(emails[0]));
    await service.markTrialStarted(await org(emails[1]));
    await service.markPaid(await org(emails[1]));
    // Connect-first: one connects a channel at once, one 20 minutes after
    // signing up (both count as channels, one within the 10-minute window),
    // and the third never does.
    await addChannel(await org(emails[0]), 'bluesky');
    const late = await addChannel(await org(emails[1]), 'bluesky');
    const signedUp = (await db().organization.findUniqueOrThrow({ where: { id: await org(emails[1]) } })).createdAt;
    await db().integration.update({
      where: { id: late.id },
      data: { createdAt: new Date(signedUp.getTime() + 20 * 60_000) },
    });

    const report = await admin.get('/admin/attribution?days=1');
    expect(report.status).toBe(200);
    expect(report.body.rows).toContainEqual({
      campaign,
      source: 'meta',
      medium: 'paid_social',
      signups: 3,
      channels: 2,
      channelsFast: 1,
      trials: 2,
      paid: 1,
      mobile: 2,
      inApp: 2,
    });
    expect(report.body.totals.signups).toBeGreaterThanOrEqual(3);
    expect(report.body.totals.channelsFast).toBeGreaterThanOrEqual(1);
    expect(report.body.totals.mobileShare).toBeGreaterThan(0);

    const customer = await t.api.register({ company: 'Not Admin Co' });
    expect((await customer.get('/admin/attribution?days=1')).status).toBe(403);
    expect((await t.api.get('/admin/attribution?days=1')).status).toBe(401);
  });
});
