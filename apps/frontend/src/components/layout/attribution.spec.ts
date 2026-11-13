/**
 * First-touch attribution (libraries/helpers/src/utils/attribution.ts): the
 * inline script the marketing pages and /auth run, executed here exactly as
 * shipped, and the cookie reader the backend uses at sign-up.
 *   pnpm exec jest -c apps/frontend/jest.config.ts attribution
 */
import {
  ATTRIBUTION_CAPTURE_SCRIPT,
  ATTRIBUTION_COOKIE,
  deviceClass,
  firstTouch,
  inAppBrowser,
  isTagged,
  MAX_CLICK_ID,
  MAX_SERVER_COOKIE,
  readAttributionCookie,
  serverAttributionUpdate,
  toFbc,
} from '@hookpost/helpers/utils/attribution';

/**
 * A Meta click id as long as real ones: in production's access log of 19-22
 * Oct, 44 of 61 fbclids were longer than 150 characters, up to 201.
 */
const LONG_FBCLID = `IwZXh0bgNhZW0BMABhZGlkAasT_${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv-Wx_aem_'.repeat(5)}`.slice(0, 200);

const clearCookies = () => {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
};

/** Loads `url` with `referrer` and runs the shipped script. */
const visit = (url: string, referrer = '') => {
  window.history.replaceState({}, '', url);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
  // eslint-disable-next-line no-new-func
  new Function(ATTRIBUTION_CAPTURE_SCRIPT)();
};

const stored = () => {
  const m = document.cookie.match(new RegExp(`(?:^|; )${ATTRIBUTION_COOKIE}=([^;]*)`));
  return m ? readAttributionCookie(m[1]) : null;
};

beforeEach(() => clearCookies());

describe('the capture script', () => {
  it('records utm_*, click ids, the landing path and the referrer, without query strings', () => {
    const before = Date.now();
    visit(
      '/claude?utm_source=meta&utm_medium=paid_social&utm_campaign=hp_ww_22oct&utm_content=face&utm_term=claude&fbclid=IwAR123abc&gclid=G-1&ttclid=T-1&msclkid=M-1&email=someone%40x.com',
      'https://l.instagram.com/path?u=secret'
    );
    const a = stored()!;
    expect(a).toMatchObject({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'hp_ww_22oct',
      utm_content: 'face',
      utm_term: 'claude',
      fbclid: 'IwAR123abc',
      gclid: 'G-1',
      ttclid: 'T-1',
      msclkid: 'M-1',
      landing_path: '/claude',
      referrer: 'https://l.instagram.com/path',
    });
    expect(a.first_seen_at).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(a)).not.toContain('someone');
  });

  it('keeps the first tagged touch: a later ad click does not overwrite it', () => {
    visit('/mcp?utm_source=google&utm_campaign=first');
    visit('/pricing?utm_source=meta&utm_campaign=second&fbclid=abc');
    expect(stored()).toMatchObject({ utm_source: 'google', utm_campaign: 'first' });
    expect(stored()!.fbclid).toBeUndefined();
  });

  it('an untagged first visit gives way to the first tagged one', () => {
    visit('/', 'https://www.google.com/');
    expect(stored()).toMatchObject({ landing_path: '/', referrer: 'https://www.google.com/' });
    expect(isTagged(stored())).toBe(false);
    visit('/start?utm_source=meta&utm_campaign=ad');
    expect(stored()).toMatchObject({ utm_source: 'meta', utm_campaign: 'ad', landing_path: '/start' });
    // ...and is then kept.
    visit('/?utm_source=x');
    expect(stored()!.utm_source).toBe('meta');
  });

  it('an untagged visit does not replace an untagged first touch', () => {
    visit('/alternatives/buffer', 'https://chatgpt.com/');
    visit('/pricing', 'https://news.ycombinator.com/');
    expect(stored()).toMatchObject({ landing_path: '/alternatives/buffer', referrer: 'https://chatgpt.com/' });
  });

  it('ignores our own pages as referrer, and a broken cookie is replaced, not fatal', () => {
    document.cookie = `${ATTRIBUTION_COOKIE}=%7Bnot-json; Path=/`;
    visit('/auth?utm_campaign=direct_to_auth', `${window.location.origin}/pricing`);
    expect(stored()).toMatchObject({ utm_campaign: 'direct_to_auth', landing_path: '/auth' });
    expect(stored()!.referrer).toBeUndefined();
  });

  it('caps every value, so the cookie stays small', () => {
    visit(`/?utm_campaign=${'x'.repeat(5000)}`);
    expect(stored()!.utm_campaign!.length).toBe(150);
    expect(document.cookie.length).toBeLessThan(1200);
  });

  it('keeps a 200-character fbclid whole: a click id is never shortened', () => {
    expect(LONG_FBCLID).toHaveLength(200);
    visit(`/claude?utm_source=meta&utm_campaign=${'c'.repeat(400)}&fbclid=${LONG_FBCLID}&gclid=${'G'.repeat(MAX_CLICK_ID)}`);
    const a = stored()!;
    expect(a.fbclid).toBe(LONG_FBCLID);
    expect(a.gclid).toHaveLength(MAX_CLICK_ID);
    // utm values are still cut.
    expect(a.utm_campaign).toHaveLength(150);
  });

  it('drops a click id longer than the limit instead of cutting it', () => {
    visit(`/claude?utm_source=meta&fbclid=${'F'.repeat(MAX_CLICK_ID + 1)}`);
    expect(stored()).toMatchObject({ utm_source: 'meta' });
    expect(stored()!.fbclid).toBeUndefined();
    // Alone, an over-long click id is not a tag: the visit counts as untagged.
    clearCookies();
    visit(`/claude?fbclid=${'F'.repeat(MAX_CLICK_ID + 1)}`);
    expect(isTagged(stored())).toBe(false);
  });

  it('stays under the browser\'s 4096-byte cookie limit: the referrer gives way first', () => {
    // 150-character utm values with 40 spaces (%20 in the cookie), every
    // click id at its longest: over the limit with the referrer, under without.
    const spaced = encodeURIComponent(`${'a '.repeat(40)}${'a'.repeat(150)}`.slice(0, 150));
    const ids = ['gclid', 'fbclid', 'ttclid', 'msclkid'].map((k) => `${k}=${'x'.repeat(MAX_CLICK_ID)}`).join('&');
    const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map((k) => `${k}=${spaced}`).join('&');
    visit(`/claude/${'p'.repeat(300)}?${utm}&${ids}`, `https://example.com/${'r'.repeat(400)}`);
    const raw = document.cookie.match(new RegExp(`(?:^|; )${ATTRIBUTION_COOKIE}=([^;]*)`));
    expect(raw).not.toBeNull();
    expect(raw![1].length).toBeLessThanOrEqual(3800);
    const a = stored()!;
    expect(a.referrer).toBeUndefined();
    expect(a.fbclid).toHaveLength(MAX_CLICK_ID);
    expect(a.utm_term).toHaveLength(150);
  });

  it('writes nothing it cannot fit, and keeps what it had', () => {
    visit('/', 'https://www.google.com/');
    const before = document.cookie;
    // Five utm values of 150 "é" are 4,500 bytes once encoded, on their own.
    const wide = encodeURIComponent('é'.repeat(150));
    visit(`/claude?utm_source=${wide}&utm_medium=${wide}&utm_campaign=${wide}&utm_content=${wide}&utm_term=${wide}`);
    expect(document.cookie).toBe(before);
    expect(stored()).toMatchObject({ landing_path: '/', referrer: 'https://www.google.com/' });
  });

  it('writes nothing on a reset or activation link: the path is the secret', () => {
    visit('/auth/forgot/eyJhbGciOiJIUzI1NiJ9.reset-token.sig', 'https://mail.google.com/mail/u/0/');
    expect(document.cookie).not.toContain(ATTRIBUTION_COOKIE);
    visit('/auth/activate/eyJhbGciOiJIUzI1NiJ9.activation-code.sig?utm_source=email');
    expect(document.cookie).not.toContain(ATTRIBUTION_COOKIE);
    // The pages without a token still count.
    visit('/auth/forgot');
    expect(stored()).toMatchObject({ landing_path: '/auth/forgot' });
  });
});

describe('readAttributionCookie (what the backend accepts)', () => {
  it('keeps known keys only, as trimmed strings within limits', () => {
    const raw = JSON.stringify({
      utm_source: '  meta ',
      utm_campaign: 'c\u0000\u0007',
      evil: 'x',
      landing_path: 'https://not-a-path',
      referrer: 'javascript:alert(1)',
      first_seen_at: Date.now(),
      gclid: 42,
    });
    const a = readAttributionCookie(raw)!;
    expect(a).toEqual({ utm_source: 'meta', utm_campaign: 'c', first_seen_at: expect.any(Number) });
  });

  it('drops a reset or activation path stored before the script skipped them', () => {
    for (const landing_path of ['/auth/forgot/tok.en.sig', '/auth/activate/co.de.sig']) {
      expect(readAttributionCookie(JSON.stringify({ utm_source: 'meta', landing_path }))).toEqual({ utm_source: 'meta' });
    }
    expect(readAttributionCookie(JSON.stringify({ landing_path: '/auth/activate' }))).toEqual({
      landing_path: '/auth/activate',
    });
  });

  it('a click id comes back whole, or not at all when it is over the limit', () => {
    expect(readAttributionCookie(JSON.stringify({ fbclid: LONG_FBCLID }))).toEqual({ fbclid: LONG_FBCLID });
    expect(
      readAttributionCookie(JSON.stringify({ utm_source: 'meta', fbclid: 'F'.repeat(MAX_CLICK_ID + 1) }))
    ).toEqual({ utm_source: 'meta' });
  });

  it('reads the decoded form (Express) and the encoded one (document.cookie)', () => {
    const json = JSON.stringify({ utm_source: 'meta' });
    expect(readAttributionCookie(json)).toEqual({ utm_source: 'meta' });
    expect(readAttributionCookie(encodeURIComponent(json))).toEqual({ utm_source: 'meta' });
  });

  it('nothing usable is null', () => {
    for (const raw of [undefined, '', 'garbage', '[]', '{}', 'null', JSON.stringify({ first_seen_at: 1 })]) {
      expect(readAttributionCookie(raw)).toBeNull();
    }
  });
});

// hp_attr_s: the backend's HttpOnly copy of hp_attr, written by /public/t
// from what the marketing page posts with its ViewContent event, because
// Safari keeps the script-written hp_attr for 7 days at most (24 hours after
// a decorated ad click). The sign-up takes firstTouch(hp_attr, hp_attr_s).
describe('the server copy of the first touch (hp_attr_s)', () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const AD = { utm_source: 'meta', utm_campaign: 'hp_ww', fbclid: 'IwAR-ad', landing_path: '/claude', first_seen_at: NOW - 10 * DAY };
  const DIRECT = { landing_path: '/', first_seen_at: NOW - DAY };

  it('firstTouch: tagged over untagged, then the earlier; a tie goes to the first argument', () => {
    expect(firstTouch(DIRECT, AD)).toBe(AD);
    expect(firstTouch(AD, DIRECT)).toBe(AD);
    const laterAd = { ...AD, utm_campaign: 'later', first_seen_at: NOW - DAY };
    expect(firstTouch(laterAd, AD)).toBe(AD);
    expect(firstTouch(AD, laterAd)).toBe(AD);
    const twin = { ...AD, utm_campaign: 'twin' };
    expect(firstTouch(AD, twin)).toBe(AD);
    expect(firstTouch(twin, AD)).toBe(twin);
    expect(firstTouch(null, DIRECT)).toBe(DIRECT);
    expect(firstTouch(DIRECT, undefined)).toBe(DIRECT);
    expect(firstTouch(null, null)).toBeNull();
    // Undated loses to dated.
    expect(firstTouch({ utm_source: 'x' }, { utm_source: 'y', first_seen_at: NOW })).toEqual({ utm_source: 'y', first_seen_at: NOW });
  });

  it('a posted touch is stored, validated, until 90 days after it was first seen', () => {
    const update = serverAttributionUpdate(undefined, { ...AD, evil: '<script>' }, NOW)!;
    expect(JSON.parse(update.value)).toEqual(AD);
    expect(update.expires.getTime()).toBe(AD.first_seen_at + 90 * DAY);
    // The raw cookie value is accepted as well.
    expect(serverAttributionUpdate(undefined, encodeURIComponent(JSON.stringify(AD)), NOW)!.value).toBe(update.value);
  });

  it('nothing to write: the same touch, a later one, an untagged one over a tagged one, junk', () => {
    const stored = JSON.stringify(AD);
    expect(serverAttributionUpdate(stored, AD, NOW)).toBeNull();
    expect(serverAttributionUpdate(stored, { ...AD, utm_campaign: 'later', first_seen_at: NOW - DAY }, NOW)).toBeNull();
    expect(serverAttributionUpdate(stored, DIRECT, NOW)).toBeNull();
    for (const posted of [undefined, null, 'garbage', ['utm_source'], 42, { evil: 'x' }, { first_seen_at: NOW }]) {
      expect(serverAttributionUpdate(undefined, posted, NOW)).toBeNull();
    }
    // A touch older than the 90-day window is not stored at all.
    expect(serverAttributionUpdate(undefined, { ...AD, first_seen_at: NOW - 91 * DAY }, NOW)).toBeNull();
  });

  it('a tagged touch replaces an untagged one, and an earlier tagged one a later', () => {
    expect(JSON.parse(serverAttributionUpdate(JSON.stringify(DIRECT), AD, NOW)!.value)).toEqual(AD);
    const later = JSON.stringify({ ...AD, utm_campaign: 'later', first_seen_at: NOW - DAY });
    expect(JSON.parse(serverAttributionUpdate(later, AD, NOW)!.value).utm_campaign).toBe('hp_ww');
    // A broken stored value is replaced.
    expect(serverAttributionUpdate('%7Bnot-json', DIRECT, NOW)).not.toBeNull();
  });

  it('a reset or activation path is never stored', () => {
    const update = serverAttributionUpdate(undefined, { utm_source: 'meta', landing_path: '/auth/forgot/tok.en.sig', first_seen_at: NOW }, NOW)!;
    expect(JSON.parse(update.value)).toEqual({ utm_source: 'meta', first_seen_at: NOW });
  });

  // hp_attr_s goes out with every request for 90 days next to hp_attr (up
  // to 3,800 bytes) and the session, and the edge refuses an oversized
  // Cookie header; so a link cannot make the copy big.
  it('stays within 1,536 bytes: the referrer goes first, then the landing path, then all but one click id', () => {
    const encoded = (u: { value: string }) => encodeURIComponent(u.value).length;
    expect(MAX_SERVER_COOKIE).toBe(1536);
    // A real ad touch is kept whole, referrer and all.
    const real = { ...AD, fbclid: LONG_FBCLID, referrer: 'https://l.facebook.com/' };
    expect(JSON.parse(serverAttributionUpdate(undefined, real, NOW)!.value)).toEqual(real);

    // Every click id at its longest, a 200-character path and a
    // 300-character referrer, with 60-character utm values: about 3,000
    // bytes encoded. What is left is the utm tags, the first click id and
    // the time.
    const utm = { utm_source: 'u'.repeat(60), utm_medium: 'm'.repeat(60), utm_campaign: 'c'.repeat(60), utm_content: 'o'.repeat(60), utm_term: 't'.repeat(60) };
    const clicks = { gclid: 'g'.repeat(MAX_CLICK_ID), fbclid: 'f'.repeat(MAX_CLICK_ID), ttclid: 't'.repeat(MAX_CLICK_ID), msclkid: 'm'.repeat(MAX_CLICK_ID) };
    const big = {
      ...utm,
      ...clicks,
      landing_path: `/claude/${'p'.repeat(192)}`,
      referrer: `https://example.com/${'r'.repeat(280)}`,
      first_seen_at: NOW,
    };
    expect(encodeURIComponent(JSON.stringify(big)).length).toBeGreaterThan(3000);
    const update = serverAttributionUpdate(undefined, big, NOW)!;
    expect(encoded(update)).toBeLessThanOrEqual(MAX_SERVER_COOKIE);
    expect(JSON.parse(update.value)).toEqual({ ...utm, gclid: clicks.gclid, first_seen_at: NOW });

    // The capture script's own worst case (150-character utm values with 40
    // spaces each, every click id at its longest) is over it even with one
    // click id: nothing is written, and hp_attr alone carries that touch.
    const spaced = `${'a '.repeat(40)}${'a'.repeat(150)}`.slice(0, 150);
    const stuffed = { ...big, utm_source: spaced, utm_medium: spaced, utm_campaign: spaced, utm_content: spaced, utm_term: spaced };
    expect(serverAttributionUpdate(undefined, stuffed, NOW)).toBeNull();

    // Two click ids fit without the long path and referrer: both stay.
    const two = { utm_source: 'meta', fbclid: clicks.fbclid, msclkid: clicks.msclkid, landing_path: big.landing_path, referrer: big.referrer, first_seen_at: NOW };
    const twoCopy = JSON.parse(serverAttributionUpdate(undefined, two, NOW)!.value);
    expect(twoCopy).toMatchObject({ fbclid: clicks.fbclid, msclkid: clicks.msclkid });
    expect(encodeURIComponent(JSON.stringify(twoCopy)).length).toBeLessThanOrEqual(MAX_SERVER_COOKIE);

    // Five 150-character "é" values are over it on their own: nothing is written.
    const wide = 'é'.repeat(150);
    expect(
      serverAttributionUpdate(undefined, { utm_source: wide, utm_medium: wide, utm_campaign: wide, utm_content: wide, utm_term: wide }, NOW)
    ).toBeNull();
  });

  it('an untagged touch is small enough to keep whole, referrer included', () => {
    const referred = { landing_path: `/${'p'.repeat(199)}`, referrer: `https://example.com/${'r'.repeat(280)}`, first_seen_at: NOW - DAY };
    expect(JSON.parse(serverAttributionUpdate(undefined, referred, NOW)!.value)).toEqual(referred);
  });

  it('Safari dropped hp_attr after an ad visit, and a direct visit wrote a new one: the copy keeps the ad', () => {
    visit('/claude?utm_source=meta&utm_campaign=hp_ww&fbclid=IwAR-ad');
    const posted = stored();
    const copy = serverAttributionUpdate(undefined, posted)!;
    clearCookies(); // ITP's cap
    visit('/pricing');
    expect(isTagged(stored())).toBe(false);
    // The direct visit's post does not replace the copy...
    expect(serverAttributionUpdate(copy.value, stored())).toBeNull();
    // ...and the sign-up takes the ad over the direct visit.
    expect(firstTouch(stored(), readAttributionCookie(copy.value))).toMatchObject({
      utm_campaign: 'hp_ww',
      fbclid: 'IwAR-ad',
      landing_path: '/claude',
    });
  });
});

describe('toFbc', () => {
  it('builds Meta\'s fb.1.<ms>.<fbclid>, and keeps a value that already is one', () => {
    expect(toFbc('IwAR1', 1729600000000)).toBe('fb.1.1729600000000.IwAR1');
    expect(toFbc('fb.1.1729600000000.IwAR1', 5)).toBe('fb.1.1729600000000.IwAR1');
    expect(toFbc(undefined)).toBeUndefined();
  });
});

describe('user agents', () => {
  const UA = {
    instagramIos:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 616577244)',
    facebookAndroid:
      'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/484.0.0.47.109;]',
    linkedinIos:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1456',
    tiktokAndroid:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 trill_360303 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/36.3.3 ByteLocale/en ByteFullLocale/en Region/IN BytedanceWebview/d8a21c6',
    chromeAndroid:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    safariIpad:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    chromeMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };

  it('names the app whose built-in browser it is', () => {
    expect(inAppBrowser(UA.instagramIos)).toBe('instagram');
    expect(inAppBrowser(UA.facebookAndroid)).toBe('facebook');
    expect(inAppBrowser(UA.linkedinIos)).toBe('linkedin');
    expect(inAppBrowser(UA.tiktokAndroid)).toBe('tiktok');
    expect(inAppBrowser(UA.chromeAndroid)).toBeNull();
    expect(inAppBrowser(UA.chromeMac)).toBeNull();
  });

  it('phone, tablet or computer', () => {
    expect(deviceClass(UA.instagramIos)).toBe('mobile');
    expect(deviceClass(UA.tiktokAndroid)).toBe('mobile');
    expect(deviceClass(UA.chromeAndroid)).toBe('mobile');
    expect(deviceClass(UA.safariIpad)).toBe('tablet');
    expect(deviceClass(UA.chromeMac)).toBe('desktop');
    expect(deviceClass('')).toBe('desktop');
  });
});
