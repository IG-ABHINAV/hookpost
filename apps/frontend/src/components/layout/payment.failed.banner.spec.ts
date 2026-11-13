/**
 * "Your last payment didn't go through. Pay from a different account" over
 * the app while the plan's last charge failed (pending or halted at
 * Razorpay), and who the app asks GET /billing/payment-issue for.
 *   pnpm exec jest -c apps/frontend/jest.config.ts payment.failed.banner
 */
import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
const mockTwa = { current: false };
jest.mock('@hookpost/frontend/components/layout/twa.component', () => ({
  useIsTwa: () => mockTwa.current,
}));
const mockUser: { current: any } = { current: null };
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => mockUser.current,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').createElement('a', { href, ...rest }, children),
}));

import {
  checksPaymentIssue,
  PaymentFailedBanner,
  paymentFailedNotice,
} from '@hookpost/frontend/components/layout/payment.failed.banner';

const admin = { role: 'SUPERADMIN', planState: 'active', isLifetime: false };

const answer = (status: string | null, ok = true) =>
  mockFetch.mockResolvedValue({ ok, json: async () => ({ status }) });

const renderBanner = () =>
  render(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      createElement(PaymentFailedBanner)
    )
  );

beforeEach(() => {
  mockFetch.mockReset();
  mockTwa.current = false;
  mockUser.current = { ...admin };
});

describe('paymentFailedNotice', () => {
  it('pending (Razorpay retrying): the message and the way to pay from another account', () => {
    expect(paymentFailedNotice('pending')).toEqual({
      message: "Your last payment didn't go through. AI and X are paused until it does.",
      label: 'Pay from a different account',
      href: '/billing?pay=another-account',
    });
  });

  it('halted (retries over): says the plan is ending, same button', () => {
    expect(paymentFailedNotice('halted')).toEqual({
      message:
        "Your last payment didn't go through and the retries have stopped, so your plan is ending. AI and X are already paused.",
      label: 'Pay from a different account',
      href: '/billing?pay=another-account',
    });
  });

  it('active, or nothing known: no banner', () => {
    expect(paymentFailedNotice(null)).toBeNull();
    expect(paymentFailedNotice(undefined)).toBeNull();
    expect(paymentFailedNotice('active' as any)).toBeNull();
  });
});

describe('checksPaymentIssue', () => {
  it('a workspace admin with a plan on file (active, trialing, cancelling)', () => {
    for (const planState of ['active', 'trialing', 'cancelling']) {
      expect(checksPaymentIssue({ ...admin, planState })).toBe(true);
      expect(checksPaymentIssue({ ...admin, role: 'ADMIN', planState })).toBe(true);
    }
  });

  it('never for a member, a lifetime plan, no plan, or the Play app', () => {
    expect(checksPaymentIssue({ ...admin, role: 'USER' })).toBe(false);
    expect(checksPaymentIssue({ ...admin, isLifetime: true })).toBe(false);
    for (const planState of ['free', 'free_posts', 'needs_trial', 'locked', null]) {
      expect(checksPaymentIssue({ ...admin, planState })).toBe(false);
    }
    expect(checksPaymentIssue({ ...admin, isTwa: true })).toBe(false);
  });
});

describe('PaymentFailedBanner', () => {
  it('pending: shown, the button goes to Change payment method on Billing', async () => {
    answer('pending');
    renderBanner();
    const banner = await screen.findByTestId('payment-failed-banner');
    expect(banner.textContent).toContain("Your last payment didn't go through.");
    expect(
      screen.getByRole('link', { name: 'Pay from a different account' }).getAttribute('href')
    ).toBe('/billing?pay=another-account');
    expect(mockFetch).toHaveBeenCalledWith('/billing/payment-issue');
  });

  it('halted: shown, says the plan is ending', async () => {
    answer('halted');
    renderBanner();
    expect((await screen.findByTestId('payment-failed-banner')).textContent).toContain(
      'your plan is ending'
    );
  });

  it('active, or the request refused: nothing', async () => {
    answer(null);
    const { container, unmount } = renderBanner();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    unmount();

    answer('pending', false);
    const refused = renderBanner();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(refused.container.innerHTML).toBe('');
  });

  it('a member or a workspace without a plan never asks', async () => {
    answer('pending');
    mockUser.current = { ...admin, role: 'USER' };
    const { container } = renderBanner();
    mockUser.current = { ...admin, planState: 'free_posts' };
    renderBanner();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });
});
