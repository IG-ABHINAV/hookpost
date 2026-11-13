/**
 * The sign-up and sign-in pages let Google sign a returning account in by
 * itself (One Tap auto-select), except when the page was opened from a team
 * invite: then only a sign-in the visitor chose may redeem it (review of
 * 6b39f4692; the backend checks select_by as well).
 *   pnpm exec jest -c apps/frontend/jest.config.ts layout.one-tap
 */
import React from 'react';

let cookieJar: Record<string, string> = {};
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in cookieJar ? { name, value: cookieJar[name] } : undefined),
  }),
}));
jest.mock('@hookpost/react/translation/get.translation.service.backend', () => ({
  getT: async () => (key: string, fallback: string) => fallback ?? key,
}));
const OneTap = jest.fn(() => null);
jest.mock('@hookpost/frontend/components/auth/google-one-tap', () => ({
  GoogleOneTap: (props: unknown) => OneTap(props),
}));
jest.mock('@hookpost/frontend/components/affiliates/ref-capture', () => ({ RefCapture: () => null }));
jest.mock('@hookpost/frontend/components/auth/testimonial.component', () => ({ TestimonialComponent: () => null }));
jest.mock('@hookpost/frontend/components/ui/logo-text.component', () => ({ LogoTextComponent: () => null }));
jest.mock('next/dynamic', () => () => () => null);
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
}));

import AuthLayout from '@hookpost/frontend/app/(app)/auth/layout';
import { GoogleOneTap } from '@hookpost/frontend/components/auth/google-one-tap';

/** The props the layout gives GoogleOneTap. */
async function oneTapProps(): Promise<Record<string, unknown>> {
  const tree = await AuthLayout({ children: null });
  let found: Record<string, unknown> | undefined;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === GoogleOneTap) found = node.props;
    walk(node.props?.children);
  };
  walk(tree);
  if (!found) throw new Error('GoogleOneTap not rendered');
  return found;
}

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnZpdGUiOjF9.c2lnbmF0dXJl';

beforeEach(() => {
  cookieJar = {};
});

it('no invite: auto-select as before', async () => {
  expect(await oneTapProps()).toMatchObject({ autoSelect: true });
});

it('opened from an invite (the org cookie): the card shows, but Google may not pick for the visitor', async () => {
  cookieJar = { org: TOKEN };
  expect(await oneTapProps()).toMatchObject({ autoSelect: false });
});

it('an org cookie that is not an invite token changes nothing', async () => {
  cookieJar = { org: 'garbage' };
  expect(await oneTapProps()).toMatchObject({ autoSelect: true });
});
