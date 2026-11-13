/**
 * TikTok commercial content disclosure, the part of TikTok's Content Sharing
 * Guidelines ("Required UX Implementation") the Direct Post audit checks: once
 * "Disclose Video Content" is on, the creator must be able to pick "Your brand"
 * and/or "Branded content", see the label each one applies, be kept out of the
 * private/branded combination, and be shown the Branded Content Policy.
 *   pnpm exec jest -c apps/frontend/jest.config.ts tiktok.disclosure
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';

jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: any) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
}));

const creatorInfo = {
  creator_nickname: 'Hookpost AI',
  creator_username: 'hookpost_ai',
  privacy_level_options: [
    'PUBLIC_TO_EVERYONE',
    'MUTUAL_FOLLOW_FRIENDS',
    'SELF_ONLY',
  ],
  comment_disabled: false,
  duet_disabled: false,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
  hookpost_direct_post_audited: true,
};
jest.mock(
  '@hookpost/frontend/components/launches/helpers/use.custom.provider.function',
  () => ({
    useCustomProviderFunction: () => ({ get: jest.fn(async () => creatorInfo) }),
  })
);

jest.mock('@hookpost/frontend/components/launches/helpers/use.integration', () => ({
  useIntegration: () => ({
    integration: { id: 'tiktok-1', identifier: 'tiktok' },
    value: [{ content: 'hello', image: [{ path: 'https://cdn.test/a.mp4' }] }],
  }),
}));

const setPublishBlocked = jest.fn();
jest.mock('@hookpost/frontend/components/new-launch/store', () => ({
  useLaunchStore: (selector: any) => selector({ setPublishBlocked }),
}));

// The real form, so Checkbox and Select read and write it through
// useFormContext exactly as they do in the composer.
let formApi: any;
jest.mock('@hookpost/frontend/components/launches/helpers/use.values', () => ({
  useSettings: () => formApi,
}));

// withProvider drags in the whole composer; only the settings screen is under
// test here.
jest.mock('@hookpost/frontend/components/new-launch/providers/high.order.provider', () => ({
  PostComment: { COMMENT: 'comment' },
  withProvider: () => () => null,
}));
jest.mock(
  '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.preview',
  () => ({ TiktokPreview: () => null })
);
jest.mock(
  '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.music',
  () => ({ TikTokMusicSelector: () => null })
);
jest.mock(
  '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.location',
  () => ({ TikTokLocationSelector: () => null })
);

import { TikTokSettings } from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.provider';
import { TikTokDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';

// The same form withProvider builds for a channel's settings tab.
// withProvider only passes `values` when the post already has settings
// (high.order.provider.tsx:139), so saved is undefined for a new post.
let saved: Record<string, unknown> | undefined;
const Harness: React.FC = () => {
  const form = useForm({
    resolver: classValidatorResolver(TikTokDto),
    ...(saved ? { values: { ...saved } } : {}),
    mode: 'all',
    criteriaMode: 'all',
    reValidateMode: 'onChange',
  });
  formApi = form;
  return React.createElement(
    FormProvider,
    form as any,
    React.createElement(TikTokSettings, {})
  );
};

const open = async (settings?: Record<string, unknown>) => {
  saved = settings;
  // creator_info resolves on a microtask, and the effects it feeds write back
  // into the form, so the first render settles inside act().
  let utils: ReturnType<typeof render>;
  await act(async () => {
    utils = render(React.createElement(Harness));
  });
  return utils!;
};

/** Tick a Checkbox by its label, the way a creator does. */
const tick = (label: string) => {
  const box = screen.getByRole('checkbox', { name: label });
  act(() => {
    fireEvent.click(box);
  });
  return box;
};

/** The block holding the two sub-options. */
const subOptions = () =>
  screen.getByRole('checkbox', { name: 'Your brand' }).parentElement!
    .parentElement!;

/**
 * The copy sits in a div next to a <br/>, so getByText's exact match misses it.
 * Match the innermost element that carries the text, not every ancestor.
 */
const hasText = (needle: string) =>
  screen.queryAllByText((_content, element) => {
    if (!element?.textContent?.includes(needle)) {
      return false;
    }
    return !Array.from(element.children).some((child) =>
      child.textContent?.includes(needle)
    );
  }).length > 0;

const CHOOSE =
  'You need to indicate if your content promotes yourself, a third party, or both.';

beforeEach(() => {
  jest.clearAllMocks();
  saved = undefined;
});

describe('TikTok commercial content disclosure', () => {
  // The defect behind this file: the two options were three blocks below the
  // toggle (after the label notice and the explanation), ~200px down a pane
  // that shows about 440px and does not scroll on its own, so ticking the
  // toggle appeared to do nothing but print the "you need to indicate..."
  // notice. They belong directly under the toggle, as TikTok's Required UX
  // Implementation shows them.
  it('puts the options directly under the disclosure toggle', async () => {
    await open();
    const toggle = screen.getByRole('checkbox', {
      name: 'Disclose Video Content',
    });
    // Checkbox renders the box inside its own row div.
    const toggleRow = toggle.parentElement!;
    expect(toggleRow.nextElementSibling).toBe(subOptions());
  });

  // Hidden, not unmounted: TikTokDto requires both booleans, so an unmounted
  // field would save as undefined. It must not be reachable while hidden.
  it('keeps both options registered but out of reach while disclosure is off', async () => {
    await open();
    expect(subOptions().className).toContain('invisible');
    for (const name of ['Your brand', 'Branded content']) {
      const box = screen.getByRole('checkbox', { name });
      expect(box.getAttribute('aria-disabled')).toBe('true');
      expect(box.getAttribute('tabindex')).toBe('-1');
      act(() => {
        fireEvent.click(box);
      });
    }
    expect(formApi.getValues('brand_organic_toggle')).toBe(false);
    expect(formApi.getValues('brand_content_toggle')).toBe(false);
  });

  it('ticking disclosure renders both sub-options with their labels', async () => {
    await open();
    expect(subOptions().className).toContain('invisible');

    tick('Disclose Video Content');

    expect(subOptions().className).not.toContain('invisible');
    expect(subOptions().className).not.toContain('h-0');
    // Throws if the label text is not on screen.
    screen.getByText('Your brand');
    screen.getByText('Branded content');
    expect(hasText('You are promoting yourself or your own brand.')).toBe(true);
    expect(hasText('This video will be classified as Brand Organic.')).toBe(
      true
    );
    expect(hasText('You are promoting another brand or a third party.')).toBe(
      true
    );
    expect(hasText('This video will be classified as Branded Content.')).toBe(
      true
    );
    // Nothing picked yet, so the warning is still the one on screen.
    expect(hasText(CHOOSE)).toBe(true);
  });

  it('Your brand labels the post as Promotional content', async () => {
    await open();
    tick('Disclose Video Content');
    tick('Your brand');

    expect(formApi.getValues('brand_organic_toggle')).toBe(true);
    expect(
      hasText('Your video will be labeled as "Promotional content".')
    ).toBe(true);
    expect(hasText(CHOOSE)).toBe(false);
  });

  it('Branded content labels the post as Paid partnership', async () => {
    await open();
    tick('Disclose Video Content');
    tick('Branded content');

    expect(formApi.getValues('brand_content_toggle')).toBe(true);
    expect(hasText('Your video will be labeled as "Paid partnership".')).toBe(
      true
    );
  });

  it('adds the Branded Content Policy link once branded content is on', async () => {
    await open();
    tick('Disclose Video Content');
    expect(screen.queryByText('Branded Content Policy')).toBeNull();

    tick('Branded content');

    expect(
      screen.getByText('Branded Content Policy').getAttribute('href')
    ).toBe('https://www.tiktok.com/legal/page/global/bc-policy/en');
  });

  it('branded content cannot be private: "Only me" is disabled with the reason', async () => {
    await open();
    tick('Disclose Video Content');
    tick('Branded content');

    const onlyMe = screen.getByRole('option', {
      name: /Only me/,
    }) as HTMLOptionElement;
    expect(onlyMe.disabled).toBe(true);
    expect(onlyMe.textContent).toContain(
      'Branded content visibility cannot be set to private.'
    );
  });

  it('privacy "Only me" disables the Branded content box instead', async () => {
    await open();
    tick('Disclose Video Content');
    act(() => {
      formApi.setValue('privacy_level', 'SELF_ONLY', { shouldValidate: true });
    });

    const box = screen.getByRole('checkbox', { name: 'Branded content' });
    expect(box.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      fireEvent.click(box);
    });
    expect(formApi.getValues('brand_content_toggle')).toBeFalsy();
  });

  it('posting stays blocked until one option is ticked', async () => {
    await open();
    tick('Disclose Video Content');
    expect(setPublishBlocked).toHaveBeenLastCalledWith('tiktok-1', CHOOSE);

    tick('Your brand');
    expect(setPublishBlocked).toHaveBeenLastCalledWith('tiktok-1', '');
  });

  // jsdom has no scrollIntoView, hence the optional call in the component.
  it('brings the options into view on the switch, not on every render', async () => {
    const scrollIntoView = jest.fn();
    (Element.prototype as any).scrollIntoView = scrollIntoView;
    try {
      await open();
      expect(scrollIntoView).not.toHaveBeenCalled();

      tick('Disclose Video Content');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      // Picking an option re-renders; it must not scroll again.
      tick('Your brand');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      tick('Disclose Video Content');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as any).scrollIntoView;
    }
  });

  // A post saved before `disclose` existed can carry a brand toggle with no
  // disclosure. The box is out of reach while disclosure reads off, so the way
  // out has to be the toggle itself: switching it on and off again clears both.
  it('a stored toggle with no disclosure can still be cleared', async () => {
    await open({
      content_posting_method: 'DIRECT_POST',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      brand_content_toggle: true,
    });
    expect(formApi.getValues('brand_content_toggle')).toBe(true);
    expect(formApi.getValues('disclose')).toBeFalsy();
    expect(
      screen
        .getByRole('checkbox', { name: 'Branded content' })
        .getAttribute('aria-disabled')
    ).toBe('true');

    tick('Disclose Video Content');
    expect(
      screen
        .getByRole('checkbox', { name: 'Branded content' })
        .getAttribute('aria-disabled')
    ).toBeNull();
    tick('Disclose Video Content');

    expect(formApi.getValues('brand_content_toggle')).toBe(false);
    // Falsy, not false: a field absent from the saved settings stays undefined
    // because react-hook-form's `values` reset drops the `register(...,
    // { value: false })` default. Pre-existing and not specific to TikTok -
    // every provider's boolean settings behave this way on a saved post.
    expect(formApi.getValues('brand_organic_toggle')).toBeFalsy();
  });

  it('turning disclosure back off clears both choices', async () => {
    await open();
    tick('Disclose Video Content');
    tick('Your brand');
    tick('Disclose Video Content');

    expect(formApi.getValues('brand_organic_toggle')).toBe(false);
    expect(formApi.getValues('brand_content_toggle')).toBe(false);
    expect(setPublishBlocked).toHaveBeenLastCalledWith('tiktok-1', '');
  });
});
