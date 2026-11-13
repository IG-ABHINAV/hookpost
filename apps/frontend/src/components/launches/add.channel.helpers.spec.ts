/**
 * Add Channel says what LinkedIn connects: the personal-profile tile, a greyed
 * "LinkedIn Page" with a "Soon" badge right after it while Pages are hidden,
 * and "Channel added" after a first connect instead of "Channel updated".
 * A refused connect link (the plan's 402) is never followed.
 *   pnpm exec jest -c apps/frontend/jest.config.ts add.channel.helpers
 */
import {
  addChannelLabel,
  afterConnect,
  blockedReason,
  canUseBlockedChannels,
  CHANNEL_ALREADY_CONNECTED,
  extensionCookiesMessage,
  channelSavedMessage,
  comingSoonTiles,
  fetchConnectLink,
  NOT_AVAILABLE_YET,
  orderAddChannelTiles,
  providerName,
  providerReturnedError,
  withComingSoon,
  withoutConnectNotice,
} from '@hookpost/frontend/components/launches/add.channel.helpers';

// One user reopened /launches?added=linkedin&msg=Channel%20Updated four times
// over 6-15 Oct; each time the toast showed again and channel_added fired.
describe('withoutConnectNotice', () => {
  it('drops added and msg once they have been shown', () => {
    expect(withoutConnectNotice('?added=linkedin&msg=Channel%20added')).toBe('');
    expect(withoutConnectNotice('?msg=This%20channel%20is%20already%20connected')).toBe('');
  });

  it('keeps everything else, onboarding included', () => {
    expect(
      withoutConnectNotice('?added=x&msg=Channel%20added&onboarding=true&week=3')
    ).toBe('onboarding=true&week=3');
  });

  it('keeps added while the page picker needs it (continue=)', () => {
    expect(withoutConnectNotice('?added=facebook&continue=ch-1')).toBeNull();
    expect(withoutConnectNotice('?added=facebook&continue=ch-1&msg=hi')).toBe(
      'added=facebook&continue=ch-1'
    );
  });

  it('nothing to remove: null, so the URL is left alone', () => {
    expect(withoutConnectNotice('')).toBeNull();
    expect(withoutConnectNotice('?onboarding=true')).toBeNull();
  });
});

describe('providerReturnedError (the consent screen answered no)', () => {
  it('a normal callback is not one', () => {
    expect(providerReturnedError({ code: 'c', state: 's' })).toBeNull();
    expect(providerReturnedError(undefined)).toBeNull();
  });

  it('Meta, Google, TikTok, LinkedIn and X cancels all read as cancelled', () => {
    for (const params of [
      { error: 'access_denied', error_reason: 'user_denied' },
      { error: 'access_denied' },
      { error: 'user_cancelled_login' },
      { error: 'user_cancelled_authorize' },
      { error: 'something', error_reason: 'user_denied' },
      { denied: 'oauth-token' },
    ]) {
      expect(providerReturnedError(params)).toEqual({ cancelled: true, code: 'user_denied' });
    }
  });

  it('another error keeps the provider code and its description', () => {
    expect(
      providerReturnedError({ error: 'invalid_scope', error_description: 'Bad+scope' })
    ).toEqual({ cancelled: false, code: 'invalid_scope', detail: 'Bad scope' });
    expect(providerReturnedError({ error: 'server_error' })).toEqual({
      cancelled: false,
      code: 'server_error',
      detail: 'server_error',
    });
  });

  it('names providers the way people know them', () => {
    expect(providerName('x')).toBe('X');
    expect(providerName('instagram-standalone')).toBe('Instagram');
    expect(providerName('linkedin-page')).toBe('LinkedIn');
    expect(providerName('lemmy')).toBe('Lemmy');
  });
});

// No outsider ever finished an Instagram login (instagram-standalone) connect: its Instagram
// Login permissions never passed Meta App Review, so a customer ends on
// Instagram's "Insufficient developer role" page (13 and 21 Oct).
describe('channels that are not open yet', () => {
  const customer = canUseBlockedChannels({ admin: false, email: 'rk@gmail.com' });

  it('Instagram without a Page is blocked for a customer, and points to the Instagram via Facebook Page tile', () => {
    expect(customer).toBe(false);
    const reason = blockedReason('instagram-standalone', customer);
    expect(reason).toContain('Instagram via Facebook Page');
    expect(reason).toContain('Facebook Page');
  });

  it('Instagram via Facebook Page, Threads and Facebook stay open', () => {
    for (const id of ['instagram', 'threads', 'facebook', 'x', 'linkedin', 'youtube']) {
      expect(blockedReason(id, customer)).toBeNull();
    }
  });

  // Medium never reaches Add Channel (the backend's RETIRED_PROVIDERS), so it
  // needs no greyed tile, and an admin is not offered it either.
  it('Medium has no greyed-tile entry: it is not listed at all', () => {
    expect(NOT_AVAILABLE_YET.medium).toBeUndefined();
  });

  it('platform admins and @hookstep.in accounts can still connect them', () => {
    const admin = canUseBlockedChannels({ admin: true, email: 'someone@gmail.com' });
    const reviewer = canUseBlockedChannels({ email: ' Meta-Reviewer@Hookstep.in ' });
    expect(admin).toBe(true);
    expect(reviewer).toBe(true);
    expect(blockedReason('instagram-standalone', admin)).toBeNull();
    expect(blockedReason('instagram-standalone', reviewer)).toBeNull();
  });

  it('no user loaded yet counts as a customer', () => {
    expect(canUseBlockedChannels(undefined)).toBe(false);
    expect(canUseBlockedChannels({ email: 'x@hookstep.in.evil.com' })).toBe(false);
  });
});

describe('comingSoonTiles', () => {
  const live = [{ identifier: 'linkedin' }, { identifier: 'x' }];

  it('shows LinkedIn Page as coming soon while the provider is hidden', () => {
    expect(comingSoonTiles(live, false)).toEqual([
      expect.objectContaining({
        identifier: 'linkedin-page',
        name: 'LinkedIn Page',
        after: 'linkedin',
      }),
    ]);
  });

  it('says why when tapped, and what works now', () => {
    expect(comingSoonTiles(live, false)[0].reason).toBe(
      "LinkedIn Pages are waiting on LinkedIn's approval. You can connect your personal profile now."
    );
  });

  it('drops it the day linkedin-page is listed for real', () => {
    expect(
      comingSoonTiles([...live, { identifier: 'linkedin-page' }], false)
    ).toEqual([]);
  });

  it('never offers it on an invite link', () => {
    expect(comingSoonTiles(live, true)).toEqual([]);
  });
});

describe('withComingSoon', () => {
  const soon = comingSoonTiles([], false);
  const ids = (tiles: ReturnType<typeof withComingSoon>) =>
    tiles.map((tile) =>
      tile.kind === 'soon' ? `soon:${tile.item.identifier}` : tile.item.identifier
    );

  it('puts LinkedIn Page right after the personal-profile LinkedIn', () => {
    expect(
      ids(
        withComingSoon(
          [{ identifier: 'x' }, { identifier: 'linkedin' }, { identifier: 'youtube' }],
          soon
        )
      )
    ).toEqual(['x', 'linkedin', 'soon:linkedin-page', 'youtube']);
  });

  it('at the end when LinkedIn itself is not listed', () => {
    expect(ids(withComingSoon([{ identifier: 'x' }], soon))).toEqual([
      'x',
      'soon:linkedin-page',
    ]);
  });

  it('nothing extra when nothing is coming soon', () => {
    expect(ids(withComingSoon([{ identifier: 'linkedin' }], []))).toEqual([
      'linkedin',
    ]);
  });
});

describe('channelSavedMessage', () => {
  it('a first connect is "Channel added", a reconnect "Channel updated"', () => {
    expect(channelSavedMessage(false)).toBe('Channel added');
    expect(channelSavedMessage(true)).toBe('Channel updated');
  });
});

describe('afterConnect', () => {
  it('a new channel goes to the calendar as added, onboarding kept', () => {
    expect(
      afterConnect({ provider: 'youtube', reconnected: false, onboarding: true })
    ).toEqual({
      path: '/launches?added=youtube&msg=Channel%20added&onboarding=true',
      message: 'Channel added',
    });
    expect(afterConnect({ provider: 'x', reconnected: true }).path).toBe(
      '/launches?added=x&msg=Channel%20updated'
    );
  });

  // 21 Oct: Back after connecting YouTube re-sent the spent code and showed
  // "This connect link was already used" three times.
  it('a repeat of a connect that already succeeded is no error and no second "added"', () => {
    const done = afterConnect({
      provider: 'youtube',
      onboarding: true,
      alreadyConnected: true,
    });
    expect(done).toEqual({
      path: '/launches?msg=This%20channel%20is%20already%20connected',
      message: CHANNEL_ALREADY_CONNECTED,
    });
    expect(done.path).not.toContain('added=');
  });
});

describe('fetchConnectLink', () => {
  // A fetch Response as layout.context.tsx hands it back: a 402 arrives
  // unread, its body naming the billing page.
  const response = (status: number, body: unknown) => {
    const json = jest.fn(async () => body);
    return {
      res: { ok: status >= 200 && status < 300, status, json } as any,
      json,
    };
  };
  const BILLING = {
    statusCode: 402,
    message: 'The Free plan includes 2 channels.',
    trial: true,
    url: 'https://hookpost.hookstep.in/billing',
  };

  it('a 402 on /integrations/social/x (plan dialog dismissed) is not a link, and the page stays put', async () => {
    const before = window.location.href;
    const { res, json } = response(402, BILLING);
    const fetch = jest.fn(async () => res);

    const link = await fetchConnectLink(fetch, '/integrations/social/x');
    // What every Add Channel path does with it.
    if (link.url) {
      window.location.href = link.url;
    }

    expect(fetch).toHaveBeenCalledWith('/integrations/social/x');
    expect(link).toEqual({ url: null, planRefused: true });
    // The billing URL in the body is never read as the provider's login page.
    expect(json).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it('the provider login page when the link was created', async () => {
    const { res } = response(200, { url: 'https://x.com/i/oauth2/authorize?state=s1' });
    await expect(
      fetchConnectLink(async () => res, '/integrations/social/x')
    ).resolves.toEqual({
      url: 'https://x.com/i/oauth2/authorize?state=s1',
      planRefused: false,
    });
  });

  it('a failure the caller reports: a 500, { err: true }, no url, or no network', async () => {
    const failed = { url: null, planRefused: false };
    await expect(
      fetchConnectLink(async () => response(500, { message: 'Integration not allowed' }).res, '/p')
    ).resolves.toEqual(failed);
    await expect(
      fetchConnectLink(async () => response(200, { err: true }).res, '/p')
    ).resolves.toEqual(failed);
    await expect(
      fetchConnectLink(async () => response(200, {}).res, '/p')
    ).resolves.toEqual(failed);
    await expect(
      fetchConnectLink(async () => {
        throw new TypeError('Failed to fetch');
      }, '/p')
    ).resolves.toEqual(failed);
  });
});

describe('extensionCookiesMessage (the extension found no platform session)', () => {
  // What the extension answers GET_COOKIES with in this browser before anyone
  // has logged in to Skool. Its error is written for developers; the toast
  // showed it verbatim ("... User may need to log in to Skool.").
  const signedOut = {
    success: false,
    provider: 'skool',
    error: 'Missing required cookies: client_id, auth_token. User may need to log in to Skool.',
    missingCookies: ['client_id', 'auth_token'],
  };

  it('tells the person to log in to Skool in this browser, without cookie names', () => {
    const message = extensionCookiesMessage(signedOut, 'skool');
    expect(message).toBe(
      "You're not logged in to Skool in this browser. Log in at skool.com, then try connecting again."
    );
    expect(message).not.toMatch(/cookie|client_id|auth_token|User may/i);
  });

  it('uses the provider name for another extension provider', () => {
    expect(extensionCookiesMessage({ ...signedOut, provider: 'x' }, 'x')).toBe(
      "You're not logged in to X in this browser. Log in there, then try connecting again."
    );
  });

  it('any other failure: a plain retry message, not the raw error', () => {
    expect(extensionCookiesMessage({ success: false, error: 'Failed to extract cookies: boom' }, 'skool')).toBe(
      "Couldn't read your Skool login from the Hookpost extension. Reload this page and try again."
    );
    expect(extensionCookiesMessage(undefined, 'skool')).toBe(
      "Couldn't read your Skool login from the Hookpost extension. Reload this page and try again."
    );
  });
});

// 4 of the 10 people who tried a channel (25 Oct - 8 Nov) picked the
// Facebook-login Instagram, got 0 Pages and left.
describe('the Instagram tiles in Add Channel', () => {
  const tiles = [
    { identifier: 'x', name: 'X' },
    { identifier: 'linkedin', name: 'LinkedIn' },
    { identifier: 'instagram', name: 'Instagram\n(Facebook Business)' },
    { identifier: 'facebook', name: 'Facebook Page' },
    { identifier: 'instagram-standalone', name: 'Instagram\n(Standalone)' },
    { identifier: 'threads', name: 'Threads' },
  ];
  const ids = (list: Array<{ identifier: string }>) => list.map((t) => t.identifier);
  const gate = NOT_AVAILABLE_YET['instagram-standalone'];
  const mutable = NOT_AVAILABLE_YET as Record<string, string>;
  afterEach(() => {
    mutable['instagram-standalone'] = gate;
  });

  it('name what each needs: no Page for Instagram login, a linked Page for the Facebook one', () => {
    expect(addChannelLabel(tiles[4])).toBe('Instagram\n(no Facebook Page needed)');
    expect(addChannelLabel(tiles[2])).toBe(
      'Instagram via Facebook Page\n(Business account + linked Page)'
    );
  });

  it('every other tile keeps the provider name', () => {
    expect(addChannelLabel(tiles[0])).toBe('X');
    expect(addChannelLabel(tiles[3])).toBe('Facebook Page');
  });

  it('when Instagram login is open to the viewer, it comes right before the Facebook-login Instagram', () => {
    expect(ids(orderAddChannelTiles(tiles, true))).toEqual([
      'x',
      'linkedin',
      'instagram-standalone',
      'instagram',
      'facebook',
      'threads',
    ]);
    delete mutable['instagram-standalone'];
    expect(ids(orderAddChannelTiles(tiles, false)).indexOf('instagram-standalone')).toBe(2);
  });

  it('while it waits on Meta, a customer gets it last (greyed), and the open tiles keep their order', () => {
    expect(ids(orderAddChannelTiles(tiles, false))).toEqual([
      'x',
      'linkedin',
      'instagram',
      'facebook',
      'threads',
      'instagram-standalone',
    ]);
  });

  it('without the Facebook-login Instagram listed, nothing moves; the input is not changed', () => {
    const without = tiles.filter((t) => t.identifier !== 'instagram');
    const before = ids(without);
    expect(ids(orderAddChannelTiles(without, true))).toEqual(before);
    expect(ids(without)).toEqual(before);
  });
});
