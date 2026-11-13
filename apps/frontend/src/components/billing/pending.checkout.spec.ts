/**
 * After approving the UPI mandate on Android, Chrome often reloads the tab
 * while the customer is in PhonePe or GPay, so Razorpay's success handler
 * never runs, and the page can load before our webhook has created the plan.
 * On 21 Oct the first trial customer was shown "Start 7-day trial" again for a
 * trial he had just approved. The tab now remembers the checkout it opened,
 * and the paywall waits for the plan instead of offering the trial again.
 *   pnpm exec jest -c apps/frontend/jest.config.ts pending.checkout
 */
import { act, renderHook, waitFor } from '@testing-library/react';

const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
const mockMutate = jest.fn();
jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: (...args: unknown[]) => mockMutate(...args),
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/react/form/button', () => ({ Button: () => null }));
jest.mock('@hookpost/frontend/components/billing/start.free', () => ({
  useStartFree: () => ({ startFree: jest.fn(), starting: false }),
}));
const mockAfterCheckout = jest.fn();
jest.mock('@hookpost/frontend/components/billing/razorpay.billing', () => {
  const actual = jest.requireActual(
    '@hookpost/frontend/components/billing/razorpay.billing'
  );
  return {
    ...actual,
    afterCheckout: (...args: unknown[]) => mockAfterCheckout(...args),
  };
});

import {
  checkoutOpenInThisPage,
  forgetPendingCheckout,
  PENDING_CHECKOUT_KEY,
  PENDING_CHECKOUT_LEAVE_AFTER_MS,
  PENDING_CHECKOUT_MAX_AGE_MS,
  PENDING_CHECKOUT_TIMEOUT_MS,
  readPendingCheckout,
  rememberPendingCheckout,
  setCheckoutOpenInThisPage,
  waitForPendingCheckout,
} from '@hookpost/frontend/components/billing/pending.checkout';
import { usePendingCheckout } from '@hookpost/frontend/components/billing/use.pending.checkout';
import { openRazorpayCheckout } from '@hookpost/frontend/components/billing/razorpay.billing';

const NOW = Date.UTC(2026, 9, 21, 7, 39, 11);

const memoryStore = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  setCheckoutOpenInThisPage(false);
});

describe('the remembered checkout', () => {
  it('round-trips the subscription id, when it was opened and whether it is a trial', () => {
    const store = memoryStore();
    rememberPendingCheckout({ id: 'sub_TqTkGhl1DyWEMN', at: NOW, trial: true }, store);
    expect(readPendingCheckout(NOW + 30_000, store)).toEqual({
      id: 'sub_TqTkGhl1DyWEMN',
      at: NOW,
      trial: true,
    });
    forgetPendingCheckout(store);
    expect(readPendingCheckout(NOW, store)).toBeNull();
  });

  it('drops one that is too old, from the future, or not ours', () => {
    const store = memoryStore();
    rememberPendingCheckout({ id: 'sub_1', at: NOW, trial: true }, store);
    expect(readPendingCheckout(NOW + PENDING_CHECKOUT_MAX_AGE_MS + 1, store)).toBeNull();
    expect(store.data.has(PENDING_CHECKOUT_KEY)).toBe(false);

    rememberPendingCheckout({ id: 'sub_1', at: NOW + 60_000, trial: true }, store);
    expect(readPendingCheckout(NOW, store)).toBeNull();

    store.setItem(PENDING_CHECKOUT_KEY, 'not json');
    expect(readPendingCheckout(NOW, store)).toBeNull();
    store.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({ id: '', at: NOW }));
    expect(readPendingCheckout(NOW, store)).toBeNull();
  });

  it('works without storage at all', () => {
    expect(() => rememberPendingCheckout({ id: 'x', at: NOW, trial: true }, null)).not.toThrow();
    expect(readPendingCheckout(NOW, null)).toBeNull();
  });
});

describe('waitForPendingCheckout', () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it('stops as soon as the plan exists', async () => {
    const c = clock();
    const check = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(true);
    await expect(
      waitForPendingCheckout({ check, now: c.now, sleep: c.sleep })
    ).resolves.toBe('confirmed');
    expect(check).toHaveBeenCalledTimes(3);
    expect(c.now()).toBe(4000);
  });

  it('asks every 2 s and gives up after 45 s', async () => {
    const c = clock();
    const check = jest.fn().mockResolvedValue(false);
    await expect(
      waitForPendingCheckout({ check, now: c.now, sleep: c.sleep })
    ).resolves.toBe('timeout');
    expect(check).toHaveBeenCalledTimes(23);
    expect(c.now()).toBe(44000);
  });

  it('stops when the page goes away', async () => {
    const c = clock();
    let gone = false;
    const check = jest.fn(async () => {
      gone = true;
      return false;
    });
    await expect(
      waitForPendingCheckout({ check, now: c.now, sleep: c.sleep, stopped: () => gone })
    ).resolves.toBe('stopped');
  });
});

describe('openRazorpayCheckout', () => {
  let modalOptions: any;
  let storedAtOpen: string | null;
  beforeEach(() => {
    modalOptions = null;
    storedAtOpen = null;
    (window as any).Razorpay = class {
      constructor(options: any) {
        modalOptions = options;
      }
      on() {}
      open() {
        storedAtOpen = window.sessionStorage.getItem(PENDING_CHECKOUT_KEY);
      }
    };
  });
  afterEach(() => {
    delete (window as any).Razorpay;
  });

  it('remembers the subscription right before the modal opens, and forgets it when closed', async () => {
    await openRazorpayCheckout({
      subscriptionId: 'sub_TqTkGhl1DyWEMN',
      verify: async () => ({ ok: true, trial: true }),
      rememberPending: { trial: true },
    });
    expect(JSON.parse(storedAtOpen!)).toMatchObject({
      id: 'sub_TqTkGhl1DyWEMN',
      trial: true,
    });
    expect(checkoutOpenInThisPage()).toBe(true);

    modalOptions.modal.ondismiss();
    expect(window.sessionStorage.getItem(PENDING_CHECKOUT_KEY)).toBeNull();
    expect(checkoutOpenInThisPage()).toBe(false);
  });

  it('forgets it once this page saw the payment succeed', async () => {
    // The real afterCheckout navigates, which jsdom only reports.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await openRazorpayCheckout({
      subscriptionId: 'sub_1',
      verify: async () => ({ ok: true, trial: true }),
      rememberPending: { trial: true },
    });
    await modalOptions.handler({
      razorpay_payment_id: 'pay_1',
      razorpay_subscription_id: 'sub_1',
      razorpay_signature: 'sig',
    });
    expect(window.sessionStorage.getItem(PENDING_CHECKOUT_KEY)).toBeNull();
    expect(checkoutOpenInThisPage()).toBe(false);
  });

  it('leaves nothing behind for the Billing page checkouts that do not ask', async () => {
    await openRazorpayCheckout({
      subscriptionId: 'sub_2',
      verify: async () => ({ ok: true }),
    });
    expect(storedAtOpen).toBeNull();
  });
});

describe('usePendingCheckout', () => {
  it('does nothing without a remembered checkout', async () => {
    const { result } = renderHook(() => usePendingCheckout());
    await act(async () => undefined);
    expect(result.current.view).toBe('none');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('after a reload, waits for the webhook and then starts the trial instead of showing the paywall', async () => {
    rememberPendingCheckout({ id: 'sub_TqTkGhl1DyWEMN', at: Date.now(), trial: true });
    mockFetch.mockResolvedValue(json({ status: { identifier: 'sub_TqTkGhl1DyWEMN' } }));

    renderHook(() => usePendingCheckout());

    await waitFor(() =>
      expect(mockAfterCheckout).toHaveBeenCalledWith('sub_TqTkGhl1DyWEMN')
    );
    expect(mockFetch).toHaveBeenCalledWith('/billing/check/sub_TqTkGhl1DyWEMN');
    expect(mockMutate).toHaveBeenCalledWith('/user/self');
    expect(window.sessionStorage.getItem(PENDING_CHECKOUT_KEY)).toBeNull();
  });

  it('a paid-plan checkout reloads rather than going to the trial page', async () => {
    rememberPendingCheckout({ id: 'sub_paid', at: Date.now(), trial: false });
    mockFetch.mockResolvedValue(json({ status: { identifier: 'sub_paid' } }));
    renderHook(() => usePendingCheckout());
    await waitFor(() => expect(mockAfterCheckout).toHaveBeenCalledWith(null));
  });

  it('shows "Confirming" while the webhook has not arrived', async () => {
    rememberPendingCheckout({ id: 'sub_slow', at: Date.now(), trial: true });
    mockFetch.mockResolvedValue(json({ status: null }));
    const { result, unmount } = renderHook(() => usePendingCheckout());
    await waitFor(() => expect(result.current.view).toBe('confirming'));
    expect(result.current.trial).toBe(true);
    unmount();
  });

  it('leaves the waiting to the modal when it is open in this page', async () => {
    rememberPendingCheckout({ id: 'sub_open', at: Date.now(), trial: true });
    setCheckoutOpenInThisPage(true);
    const { result } = renderHook(() => usePendingCheckout());
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => undefined);
    expect(result.current.view).toBe('none');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('"Back to plans" forgets the checkout', async () => {
    rememberPendingCheckout({ id: 'sub_gone', at: Date.now(), trial: true });
    mockFetch.mockResolvedValue(json({ status: null }));
    const { result, unmount } = renderHook(() => usePendingCheckout());
    await waitFor(() => expect(result.current.view).toBe('confirming'));
    act(() => result.current.startOver());
    expect(result.current.view).toBe('none');
    expect(window.sessionStorage.getItem(PENDING_CHECKOUT_KEY)).toBeNull();
    unmount();
  });

  describe('a reload that was not an approval', () => {
    // The key also survives a reload after the customer cancelled in GPay or
    // PhonePe, or a refresh with the modal open: the wait must not trap them.
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('offers "Back to plans" after 10 s while it is still checking', async () => {
      rememberPendingCheckout({ id: 'sub_cancelled', at: Date.now(), trial: true });
      mockFetch.mockResolvedValue(json({ status: null }));
      const { result, unmount } = renderHook(() => usePendingCheckout());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(result.current.view).toBe('confirming');
      expect(result.current.canStartOver).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(PENDING_CHECKOUT_LEAVE_AFTER_MS - 1000);
      });
      expect(result.current.canStartOver).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(result.current.view).toBe('confirming');
      expect(result.current.canStartOver).toBe(true);
      unmount();
    });

    it('"Back to plans" stops the wait: no more checks, no timeout screen later', async () => {
      rememberPendingCheckout({ id: 'sub_cancelled', at: Date.now(), trial: true });
      mockFetch.mockResolvedValue(json({ status: null }));
      const { result, unmount } = renderHook(() => usePendingCheckout());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(PENDING_CHECKOUT_LEAVE_AFTER_MS);
      });
      expect(result.current.canStartOver).toBe(true);
      const checksBefore = mockFetch.mock.calls.length;

      act(() => result.current.startOver());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(PENDING_CHECKOUT_TIMEOUT_MS);
      });

      expect(result.current.view).toBe('none');
      expect(result.current.canStartOver).toBe(false);
      expect(mockFetch.mock.calls.length).toBe(checksBefore);
      expect(mockAfterCheckout).not.toHaveBeenCalled();
      unmount();
    });

    it('the timeout screen always has "Back to plans"', async () => {
      rememberPendingCheckout({ id: 'sub_never', at: Date.now(), trial: true });
      mockFetch.mockResolvedValue(json({ status: null }));
      const { result, unmount } = renderHook(() => usePendingCheckout());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(PENDING_CHECKOUT_TIMEOUT_MS);
      });
      expect(result.current.view).toBe('timeout');
      expect(result.current.canStartOver).toBe(true);
      unmount();
    });
  });
});
