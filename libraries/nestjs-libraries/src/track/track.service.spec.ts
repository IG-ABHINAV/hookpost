/**
 * What TrackService hands Meta's Conversions API: the event id (which Meta
 * matches against the browser pixel's eventID), fbc in Meta's
 * fb.1.<ms>.<fbclid> form (the bare click id it used to send cannot be
 * matched), fbp, a hashed external id and the page. Nothing at all without
 * FACEBOOK_PIXEL_ACCESS_TOKEN.
 *   pnpm exec jest -c apps/backend/jest.config.ts track.service
 */
const calls: Record<string, unknown[]> = {};
const record = (name: string) =>
  function (this: unknown, value: unknown) {
    (calls[name] ||= []).push(value);
    return this;
  };
const execute = jest.fn(async () => ({ events_received: 1 }));

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  UserData: class {
    setClientIpAddress = record('ip');
    setClientUserAgent = record('ua');
    setFbc = record('fbc');
    setFbp = record('fbp');
    setEmail = record('email');
    setExternalId = record('externalId');
  },
  CustomData: class {
    setValue = record('value');
    setCurrency = record('currency');
  },
  ServerEvent: class {
    setEventName = record('eventName');
    setEventTime = record('eventTime');
    setActionSource = record('actionSource');
    setEventSourceUrl = record('sourceUrl');
    setEventId = record('eventId');
    setUserData = record('userData');
    setCustomData = record('customData');
  },
  EventRequest: class {
    constructor(token: string, pixel: string) {
      (calls.request ||= []).push([token, pixel]);
    }
    setEvents = record('events');
    execute = execute;
  },
}));

import { createHash } from 'crypto';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';

const load = (env: Record<string, string | undefined>) => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  let Service: any;
  jest.isolateModules(() => {
    Service = require('@hookpost/nestjs-libraries/track/track.service').TrackService;
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return new Service();
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  execute.mockClear();
});

describe('TrackService.track', () => {
  const user = { id: 'user-1', email: 'new@example.com' } as any;

  it('a sign-up: event id, fbc from the click id and its first-seen time, fbp, hashed ids, page', async () => {
    const track = load({ FACEBOOK_PIXEL_ACCESS_TOKEN: 'token', NEXT_PUBLIC_FACEBOOK_PIXEL: '1834060401105252' });
    await track.track(
      'reg_user-1',
      '203.0.113.9',
      'UA',
      TrackEnum.CompleteRegistration,
      {},
      'IwAR0abc',
      user,
      { fbp: 'fb.1.1729590000000.123', sourceUrl: 'https://hookpost.hookstep.in/auth', fbclidSeenAt: 1729600000000 }
    );
    expect(calls.eventName).toEqual(['CompleteRegistration']);
    expect(calls.eventId).toEqual(['reg_user-1']);
    expect(calls.fbc).toEqual(['fb.1.1729600000000.IwAR0abc']);
    expect(calls.fbp).toEqual(['fb.1.1729590000000.123']);
    expect(calls.email).toEqual([sha('new@example.com')]);
    expect(calls.externalId).toEqual([sha('user-1')]);
    expect(calls.sourceUrl).toEqual(['https://hookpost.hookstep.in/auth']);
    expect(calls.request).toEqual([['token', '1834060401105252']]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('an fbc value (the pixel\'s _fbc) is passed through unchanged', async () => {
    const track = load({ FACEBOOK_PIXEL_ACCESS_TOKEN: 'token', NEXT_PUBLIC_FACEBOOK_PIXEL: '1' });
    await track.track('e', '', '', TrackEnum.ViewContent, {}, 'fb.1.1729500000000.ABC');
    expect(calls.fbc).toEqual(['fb.1.1729500000000.ABC']);
    expect(calls.fbp).toBeUndefined();
    expect(calls.sourceUrl).toBeUndefined();
  });

  it('sends nothing without FACEBOOK_PIXEL_ACCESS_TOKEN', async () => {
    const track = load({ FACEBOOK_PIXEL_ACCESS_TOKEN: undefined, NEXT_PUBLIC_FACEBOOK_PIXEL: '1' });
    await track.track('e', '', '', TrackEnum.CompleteRegistration, {}, 'IwAR', user);
    expect(execute).not.toHaveBeenCalled();
    expect(calls.request).toBeUndefined();
  });
});
