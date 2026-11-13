import { referrerHost, signupDetails, signupSource } from './signup.source';

describe('signupSource: the admin Users page source label', () => {
  it('no attribution row is unknown (null), not direct', () => {
    expect(signupSource(null)).toBeNull();
    expect(signupSource(undefined)).toBeNull();
  });

  it('utm source / campaign wins over click ids and the referrer', () => {
    expect(
      signupSource({
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'hp_search_alt_23oct',
        gclid: 'abc',
        referrer: 'https://www.google.com/',
        landingPath: '/alternatives',
      })
    ).toEqual({
      label: 'google / hp_search_alt_23oct',
      kind: 'utm',
      campaign: 'hp_search_alt_23oct',
      landingPath: '/alternatives',
    });
    expect(
      signupSource({ utmSource: 'meta', utmMedium: 'paid_social', referrer: 'https://l.facebook.com/' })
        ?.label
    ).toBe('meta / paid_social');
    expect(
      signupSource({ utmSource: 'meta', utmMedium: 'paid_social', utmCampaign: 'hp_in_sales_23oct' })?.label
    ).toBe('meta / hp_in_sales_23oct');
    expect(signupSource({ utmSource: 'newsletter' })?.label).toBe('newsletter');
  });

  it('a blank utm_source falls through to the next signal', () => {
    expect(signupSource({ utmSource: '   ', referrer: 'https://claude.ai/' })?.label).toBe('claude.ai');
  });

  it('click ids without utm name the ad network', () => {
    expect(signupSource({ gclid: 'x' })).toMatchObject({ label: 'google (gclid)', kind: 'click_id' });
    expect(signupSource({ fbclid: 'x' })?.label).toBe('meta (fbclid)');
    expect(signupSource({ ttclid: 'x' })?.label).toBe('tiktok (ttclid)');
    expect(signupSource({ msclkid: 'x' })?.label).toBe('bing (msclkid)');
  });

  it('a referral is named by its host (Claude directory, ChatGPT, Google organic)', () => {
    expect(signupSource({ referrer: 'https://claude.ai/', landingPath: '/auth' })).toEqual({
      label: 'claude.ai',
      kind: 'referral',
      campaign: null,
      landingPath: '/auth',
    });
    expect(signupSource({ referrer: 'https://chatgpt.com/c/123?x=1' })?.label).toBe('chatgpt.com');
    expect(signupSource({ referrer: 'https://www.google.com/' })?.label).toBe('google.com');
    expect(signupSource({ referrer: 'https://cursor.directory/mcp/hookpost' })?.label).toBe(
      'cursor.directory'
    );
  });

  it("Meta's link shims read as the site, not as l.facebook.com", () => {
    expect(signupSource({ referrer: 'https://l.facebook.com/' })?.label).toBe('facebook.com');
    expect(signupSource({ referrer: 'https://lm.facebook.com/l.php?u=x' })?.label).toBe('facebook.com');
    expect(signupSource({ referrer: 'https://l.instagram.com/' })?.label).toBe('instagram.com');
  });

  it("our own sites as referrer, or nothing at all, is direct", () => {
    expect(signupSource({ referrer: 'https://hookpost.hookstep.in/pricing' })).toMatchObject({
      label: 'direct',
      kind: 'direct',
    });
    expect(signupSource({ referrer: 'https://hookstep.in/' })?.label).toBe('direct');
    expect(signupSource({ landingPath: '/pricing' })).toEqual({
      label: 'direct',
      kind: 'direct',
      campaign: null,
      landingPath: '/pricing',
    });
  });

  it('a referrer that is not a URL still gives a host; app referrers keep the package', () => {
    expect(referrerHost('claude.ai/new')).toBe('claude.ai');
    expect(referrerHost('android-app://com.google.android.gm/')).toBe('com.google.android.gm');
    expect(referrerHost('')).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });

  it('long or odd values are trimmed to 60 characters', () => {
    const long = 'x'.repeat(200);
    expect(signupSource({ utmSource: long })!.label.length).toBe(60);
    expect(signupSource({ utmSource: 'a\n b', utmCampaign: long })!.campaign!.length).toBe(60);
    expect(signupSource({ utmSource: 'a', utmCampaign: long })!.label).toBe(`a / ${'x'.repeat(60)}`);
    expect(signupSource({ utmSource: 'a\n b' })!.label).toBe('a b');
  });
});

describe('signupDetails: the admin user panel', () => {
  it('a Claude-directory sign-up, in plain fields', () => {
    expect(
      signupDetails({
        user: { createdAt: new Date('2026-10-27T04:49:00Z'), providerName: 'GOOGLE', signupCountry: 'IN', signupCity: 'Jaipur' },
        attribution: {
          method: 'GOOGLE_ONE_TAP',
          referrer: 'https://claude.ai/',
          landingPath: '/auth',
          device: 'desktop',
          country: 'IN',
          firstChannelAt: new Date('2026-10-27T04:49:40Z'),
        },
        channels: 1,
        posts: 0,
        workspaceId: 'org-1',
      })
    ).toEqual({
      workspaceId: 'org-1',
      source: { label: 'claude.ai', kind: 'referral', campaign: null, landingPath: '/auth' },
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrerHost: 'claude.ai',
      landingPath: '/auth',
      country: 'IN',
      city: 'Jaipur',
      device: 'desktop',
      inApp: null,
      method: 'GOOGLE_ONE_TAP',
      signedUpAt: '2026-10-27T04:49:00.000Z',
      firstChannelAt: '2026-10-27T04:49:40.000Z',
      trialStartedAt: null,
      paidAt: null,
      channels: 1,
      posts: 0,
    });
  });

  it('no attribution row: the user row fills country and method, the first channel falls back', () => {
    const d = signupDetails({
      user: { createdAt: '2026-10-13T08:16:00Z', providerName: 'GOOGLE', signupCountry: 'IN' },
      attribution: null,
      firstChannelFallback: '2026-10-13T09:00:00Z',
      channels: 2,
      posts: 3,
      workspaceId: 'org-2',
    });
    expect(d).toMatchObject({
      source: null,
      country: 'IN',
      method: 'GOOGLE',
      device: null,
      firstChannelAt: '2026-10-13T09:00:00.000Z',
      channels: 2,
      posts: 3,
    });
  });

  it('an ad sign-up keeps every utm field, and trial/paid dates', () => {
    const d = signupDetails({
      user: { createdAt: '2026-10-23T15:05:00Z' },
      attribution: {
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'hp_search_alt_23oct',
        trialStartedAt: '2026-10-23T15:07:00Z',
        paidAt: 'not a date',
      },
      channels: 1,
      posts: 0,
      workspaceId: null,
    });
    expect(d).toMatchObject({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'hp_search_alt_23oct',
      trialStartedAt: '2026-10-23T15:07:00.000Z',
      paidAt: null,
      firstChannelAt: null,
    });
  });
});
