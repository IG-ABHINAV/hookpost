/**
 * The composer: what it says when a save fails, the character badge, the
 * previews, and the shared checkbox it uses for channel settings.
 *   pnpm exec jest -c apps/frontend/jest.config.ts composer
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// The real useT suspends until the locale files load
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

// Only the X provider's limit is under test, not these ESM-heavy widgets
jest.mock('@hookpost/frontend/components/launches/internal.channels', () => ({
  InternalChannels: () => null,
}));
jest.mock(
  '@hookpost/frontend/components/new-launch/finisher/thread.finisher',
  () => ({ ThreadFinisher: () => null })
);
jest.mock('@hookpost/frontend/components/media/media.component', () => ({
  MediaComponent: () => null,
}));

import {
  isPastScheduleTime,
  postSaveError,
  submitPost,
} from '@hookpost/frontend/components/new-launch/post.save.error';
import XProvider from '@hookpost/frontend/components/new-launch/providers/x/x.provider';
import { getProviderSettingsMeta } from '@hookpost/frontend/components/new-launch/providers/high.order.provider';
import { pickGlobalDisplayLimit } from '@hookpost/frontend/components/launches/information.component';
import { GeneralPreviewComponent } from '@hookpost/frontend/components/launches/general.preview.component';
import { IntegrationContext } from '@hookpost/frontend/components/launches/helpers/use.integration';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import { Checkbox } from '@hookpost/react/form/checkbox';
import { DatePicker } from '@hookpost/frontend/components/launches/helpers/date.picker';
import dayjs from 'dayjs';

const fallback = 'Could not save the post, please try again';
const limitReached = "Not saved: your plan's limit is reached";
// jsdom has no Response; this one, like the real body, can be read once
const response = (status: number, body: unknown) => {
  let read = false;
  return {
    status,
    ok: status < 400,
    json: async () => {
      if (read) {
        throw new TypeError('Body has already been consumed.');
      }
      read = true;
      return body;
    },
  } as unknown as Response;
};

describe('postSaveError (POST /posts refused the save)', () => {
  it('names the channel for a validation error', async () => {
    await expect(
      postSaveError(
        response(400, {
          statusCode: 400,
          provider: 'x',
          name: 'Hookstep',
          message: 'X allows up to 4 pictures per post',
        }),
        fallback
      )
    ).resolves.toBe('Hookstep: X allows up to 4 pictures per post');
  });

  it('shows the first message of a DTO validation error', async () => {
    await expect(
      postSaveError(
        response(400, {
          statusCode: 400,
          message: ['first problem', 'second problem'],
          error: 'Bad Request',
        }),
        fallback
      )
    ).resolves.toBe('first problem');
  });

  it('says the plan limit was reached after the plan dialog read the body', async () => {
    const paywall = response(402, { message: 'You have used all 30 posts' });
    await paywall.json();
    await expect(postSaveError(paywall, fallback, limitReached)).resolves.toBe(
      limitReached
    );
  });

  it('falls back for a server error or no response', async () => {
    await expect(
      postSaveError(
        response(500, { statusCode: 500, message: 'Internal server error' }),
        fallback
      )
    ).resolves.toBe(fallback);
    await expect(postSaveError(undefined, fallback)).resolves.toBe(fallback);
  });
});

describe('submitPost (the composer only closes on a save that went through)', () => {
  const messages = { fallback, limitReached };

  it.each([
    [
      400,
      { message: 'X allows up to 4 pictures per post' },
      'X allows up to 4 pictures per post',
    ],
    [402, { message: 'You have used all 30 posts' }, limitReached],
    [500, { message: 'Internal server error' }, fallback],
  ])(
    'reports a %s and tells the caller nothing was saved',
    async (status, body, shown) => {
      const res = response(status, body);
      if (status === 402) {
        // the plan dialog in layout.context reads it first
        await res.json();
      }
      const fetch = jest.fn().mockResolvedValue(res);
      const onError = jest.fn();
      await expect(
        submitPost(fetch, { type: 'schedule' }, messages, onError)
      ).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledWith('/posts', {
        method: 'POST',
        body: JSON.stringify({ type: 'schedule' }),
      });
      expect(onError).toHaveBeenCalledWith(shown);
    }
  );

  it('hands back the response of a save that went through', async () => {
    const res = response(201, [{ postId: 'p1' }]);
    const onError = jest.fn();
    await expect(
      submitPost(jest.fn().mockResolvedValue(res), {}, messages, onError)
    ).resolves.toBe(res);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('isPastScheduleTime (Add to calendar with a time that has gone)', () => {
  const now = dayjs('2026-10-14T16:00:00');

  it('asks for a schedule earlier today', () => {
    expect(
      isPastScheduleTime('schedule', dayjs('2026-10-14T09:00:00'), now)
    ).toBe(true);
  });

  it('does not ask for a later time, Post now, an update or a draft', () => {
    expect(
      isPastScheduleTime('schedule', dayjs('2026-10-14T16:30:00'), now)
    ).toBe(false);
    for (const type of ['now', 'update', 'draft']) {
      expect(isPastScheduleTime(type, dayjs('2026-10-14T09:00:00'), now)).toBe(
        false
      );
    }
  });
});

describe('pickGlobalDisplayLimit (character badge in global mode)', () => {
  it('shows the channel furthest over its limit, not one that is fine', () => {
    // Threads counts bytes, so the same text is longer there
    const threads = { limit: 500, count: 644 };
    const pinterest = { limit: 500, count: 636 };
    const youtube = { limit: 5000, count: 636 };
    expect(pickGlobalDisplayLimit([threads, pinterest, youtube])).toBe(threads);
  });

  it('shows the smallest limit while every channel is within it', () => {
    const x = { limit: 280, count: 100 };
    const linkedin = { limit: 3000, count: 100 };
    expect(pickGlobalDisplayLimit([linkedin, x])).toBe(x);
    expect(pickGlobalDisplayLimit([])).toBeNull();
  });
});

describe('X character limit', () => {
  const limit = getProviderSettingsMeta(XProvider)!.maximumCharacters as (
    additionalSettings: any,
    settings?: any
  ) => number;

  it('is the article limit for a long-form article, as the server allows', () => {
    expect(limit([], { post_type: 'article' })).toBe(100000);
    expect(
      limit([{ title: 'Verified', value: true }], { post_type: 'article' })
    ).toBe(100000);
  });

  it('stays 280, or 4000 for a verified account, for a tweet', () => {
    expect(limit([], { post_type: 'post' })).toBe(280);
    expect(limit([{ title: 'Verified', value: true }], {})).toBe(4000);
    expect(limit([])).toBe(280);
  });
});

describe('GeneralPreviewComponent', () => {
  const channel = (extra: any = {}) => ({
    id: 'int-1',
    name: 'Hookstep',
    identifier: 'bluesky',
    picture: 'https://media.hookstep.in/avatar.png',
    display: 'hookstep.bsky.social',
    additionalSettings: '[]',
    ...extra,
  });

  const renderPreview = (content: string, integration: any) =>
    render(
      React.createElement(
        IntegrationContext.Provider,
        {
          value: {
            date: dayjs(),
            integration,
            allIntegrations: [],
            value: [{ id: 'v1', content, image: [] }],
          },
        },
        React.createElement(GeneralPreviewComponent, {
          maximumCharacters: 300,
        })
      )
    );

  const mention = (id: string, label: string) =>
    `<span data-type="mention" data-mention-id="${id}" data-label="${label}">@${label}</span>`;

  afterEach(() => {
    cleanup();
    useLaunchStore.getState().reset();
  });

  it('highlights every mention, not only the first', () => {
    useLaunchStore.getState().setCurrent('int-1');
    const { container } = renderPreview(
      `<p>Hi ${mention('acme', 'Acme')} and ${mention('beta', 'Beta Co')}</p>`,
      channel()
    );
    expect(container.textContent).not.toContain('[[[');
    expect(container.textContent).toContain('@Beta Co');
  });

  it('shows the first selected channel in global mode, not "Global Edit"', () => {
    useLaunchStore.getState().setCurrent('global');
    useLaunchStore.setState({
      selectedIntegrations: [{ integration: channel(), settings: {} } as any],
    });
    const { container } = renderPreview('<p>hello</p>', channel());
    expect(screen.getByText('Hookstep')).toBeTruthy();
    expect(container.textContent).not.toContain('Global Edit');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://media.hookstep.in/avatar.png'
    );
  });

  it('only gives a verified X account the verified tick', () => {
    useLaunchStore.getState().setCurrent('int-1');
    const plain = renderPreview('<p>hello</p>', channel());
    expect(
      plain.container.querySelector('[data-testid="icon-verified"]')
    ).toBeNull();
    expect(plain.container.textContent).not.toContain('@username');
    plain.unmount();

    const verified = renderPreview(
      '<p>hello</p>',
      channel({
        identifier: 'x',
        additionalSettings: '[{"title":"Verified","value":true}]',
      })
    );
    expect(
      verified.container.querySelector('[data-testid="icon-verified"]')
    ).not.toBeNull();
  });
});

describe('Checkbox', () => {
  const renderBox = (checked: boolean, onChange = jest.fn()) => {
    render(
      React.createElement(Checkbox, {
        disableForm: true,
        checked,
        label: 'Trial Reel',
        onChange,
      })
    );
    return {
      box: screen.getByRole('checkbox', { name: 'Trial Reel' }),
      onChange,
    };
  };

  it('is a focusable checkbox that says whether it is ticked', () => {
    const { box } = renderBox(false);
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(box.getAttribute('tabindex')).toBe('0');
    // an unticked box is drawn as an outline, not the filled "on" square
    expect(box.className).not.toContain('bg-forth');
  });

  it('toggles with Space from the keyboard', () => {
    const { box, onChange } = renderBox(false);
    fireEvent.keyDown(box, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith({
      target: { name: undefined, value: true },
    });
  });

  it('is filled when ticked', () => {
    const { box } = renderBox(true);
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.className).toContain('bg-forth');
  });
});

describe('DatePicker', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-14T08:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not offer a past day, which would publish at once', () => {
    const onChange = jest.fn();
    render(
      React.createElement(DatePicker, {
        date: dayjs('2026-10-14T10:00:00'),
        onChange,
      })
    );
    fireEvent.click(screen.getByText(/2026/));
    const day = (label: string) =>
      screen
        .getAllByRole('button')
        .find((b) => b.textContent === label)! as HTMLButtonElement;

    expect(day('7').disabled).toBe(true);
    fireEvent.click(day('7'));
    expect(onChange).not.toHaveBeenCalled();

    expect(day('14').disabled).toBe(false);
    fireEvent.click(day('20'));
    expect(onChange.mock.calls[0][0].format('YYYY-MM-DD')).toBe('2026-10-20');
  });
});
