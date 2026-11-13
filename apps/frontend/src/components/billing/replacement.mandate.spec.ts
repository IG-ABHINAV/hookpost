/**
 * Reactivate and Change payment method: the terms are quoted first (nothing
 * created), and the Razorpay mandate is created only after "Continue to
 * Razorpay". "Not now" used to leave a `created` subscription behind.
 *   pnpm exec jest -c apps/frontend/jest.config.ts replacement.mandate
 */
import {
  CreatedReplacement,
  ReplacementFlowDeps,
  replacementCopy,
  replacementPaths,
  runReplacementMandate,
  sameReplacementTerms,
} from '@hookpost/frontend/components/billing/replacement.mandate';

const t = (_key: string, fallback: string, opts?: Record<string, any>) =>
  fallback.replace(/{{(\w+)}}/g, (_m, name) => opts?.[name] ?? '');

const NOV_13 = '2026-11-13T12:00:00.000Z';

const quote = {
  currency: 'INR',
  billing: 'STANDARD',
  period: 'MONTHLY',
  amount: 699,
  startAt: NOV_13,
  chargeToday: 0,
  unpaid: false,
};
const created: CreatedReplacement & Record<string, any> = {
  ...quote,
  id: 'abc',
  subscriptionId: 'sub_new_1',
  keyId: 'rzp_test_key',
  providerName: 'razorpay',
};

const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

function deps(
  overrides: Partial<ReplacementFlowDeps> & {
    quoteBody?: any;
    quoteStatus?: number;
    createBody?: any;
    createStatus?: number;
    answers?: boolean[];
  } = {}
) {
  const {
    quoteBody = quote,
    quoteStatus = 200,
    createBody = created,
    createStatus = 200,
    answers = [true, true],
    ...rest
  } = overrides;
  const fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/quote')) return json(quoteBody, quoteStatus);
    if (url === '/billing/replacement/discard') return json({ discarded: true });
    if (init?.method === 'POST') return json(createBody, createStatus);
    throw new Error(`unexpected ${url}`);
  });
  const queue = [...answers];
  const d = {
    reason: 'reactivate' as const,
    t,
    currentTierName: 'Standard',
    fetch,
    confirm: jest.fn(async () => !!queue.shift()),
    prepareCheckout: jest.fn(async () => true),
    openCheckout: jest.fn(async () => true),
    warn: jest.fn(),
    ...rest,
  };
  const calls = () =>
    fetch.mock.calls.map(([url, init]) => `${(init as any)?.method || 'GET'} ${url}`);
  return { d, fetch, calls };
}

describe('runReplacementMandate', () => {
  it('"Not now" on the quoted terms creates nothing on Razorpay', async () => {
    const { d, calls } = deps({ answers: [false] });

    await expect(runReplacementMandate(d)).resolves.toBe('declined');

    expect(calls()).toEqual(['GET /billing/reactivate/quote']);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    const [message, approve, title, cancel] = (d.confirm.mock.calls[0] as any[]) || [];
    expect(message).toContain('₹699/month');
    expect(message).toContain('The first charge on the new mandate is ₹699 on 13 Nov 2026.');
    expect([approve, title, cancel]).toEqual([
      'Continue to Razorpay',
      'Reactivate subscription',
      'Not now',
    ]);
    expect(d.prepareCheckout).not.toHaveBeenCalled();
    expect(d.openCheckout).not.toHaveBeenCalled();
  });

  it('"Continue to Razorpay" creates the mandate, then opens checkout on it', async () => {
    const { d, calls } = deps({ reason: 'payment_method' });

    await expect(runReplacementMandate(d)).resolves.toBe('checkout');

    expect(calls()).toEqual([
      'GET /billing/payment-method/quote',
      'POST /billing/payment-method',
    ]);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect((d.confirm.mock.calls[0] as any[])[2]).toBe('Change payment method');
    expect(d.openCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_new_1', keyId: 'rzp_test_key' }),
      '₹699/month from 13 Nov 2026'
    );
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('the same date written another way is not a change of terms', async () => {
    const { d } = deps({
      createBody: { ...created, startAt: '2026-11-13T17:30:00+05:30' },
    });

    await expect(runReplacementMandate(d)).resolves.toBe('checkout');
    expect(d.confirm).toHaveBeenCalledTimes(1);
  });

  it('terms that changed after the quote are shown again before checkout, and checkout states the new ones', async () => {
    // The paid time ran out between the quote and the click: now it is
    // charged on approval, not on 13 Nov.
    const { d } = deps({
      createBody: { ...created, startAt: null, chargeToday: 699 },
      answers: [true, true],
    });

    await expect(runReplacementMandate(d)).resolves.toBe('checkout');

    expect(d.confirm).toHaveBeenCalledTimes(2);
    const [message, approve, title] = d.confirm.mock.calls[1] as any[];
    expect(title).toBe('The terms have changed');
    expect(approve).toBe('Continue to Razorpay');
    expect(message).toContain('These terms changed while checkout was being set up.');
    expect(message).toContain(
      "₹699 is charged when you approve it, because the time you've paid for ends in the next few minutes."
    );
    expect(message).not.toContain('13 Nov 2026');
    expect((d.openCheckout.mock.calls[0] as any[])[1]).toBe('₹699/month');
  });

  it('new terms turned down: the unapproved mandate is withdrawn and checkout never opens', async () => {
    const { d, calls } = deps({
      createBody: { ...created, amount: 799 },
      answers: [true, false],
    });

    await expect(runReplacementMandate(d)).resolves.toBe('declined_changed');

    expect(calls()).toEqual([
      'GET /billing/reactivate/quote',
      'POST /billing/reactivate',
      'POST /billing/replacement/discard',
    ]);
    const discard = d.fetch.mock.calls[2] as any[];
    expect(JSON.parse(discard[1].body)).toEqual({ subscriptionId: 'sub_new_1' });
    expect((d.confirm.mock.calls[1] as any[])[0]).toContain('₹799/month');
    expect(d.openCheckout).not.toHaveBeenCalled();
  });

  it('a quote the server refuses shows its reason and creates nothing', async () => {
    const { d, calls } = deps({
      quoteStatus: 409,
      quoteBody: {
        statusCode: 409,
        message: "Your plan's next payment is being taken right now. Please try again in a few minutes, once it has gone through.",
      },
    });

    await expect(runReplacementMandate(d)).resolves.toBe('failed');

    expect(calls()).toEqual(['GET /billing/reactivate/quote']);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledWith(
      "Your plan's next payment is being taken right now. Please try again in a few minutes, once it has gone through."
    );
  });

  it('a create the server refuses after the quote shows its reason, and opens nothing', async () => {
    const { d } = deps({
      createStatus: 400,
      createBody: { statusCode: 400, message: 'This plan has already ended. Choose a plan above to subscribe again.' },
    });

    await expect(runReplacementMandate(d)).resolves.toBe('failed');
    expect(d.warn).toHaveBeenCalledWith(
      'This plan has already ended. Choose a plan above to subscribe again.'
    );
    expect(d.openCheckout).not.toHaveBeenCalled();
  });

  it('a network error on the quote falls back to the generic message', async () => {
    const { d } = deps();
    d.fetch.mockRejectedValueOnce(new Error('offline'));

    await expect(runReplacementMandate(d)).resolves.toBe('failed');
    expect(d.warn).toHaveBeenCalledWith(
      'We could not start checkout. Please try again, or email support@hookstep.in.'
    );
  });

  it('checkout.js that cannot load: nothing is created', async () => {
    const { d, calls } = deps({ prepareCheckout: jest.fn(async () => false) });

    await expect(runReplacementMandate(d)).resolves.toBe('unavailable');

    expect(calls()).toEqual(['GET /billing/reactivate/quote']);
    expect(d.warn).toHaveBeenCalledWith(
      'Checkout is currently unavailable. Please try again shortly.'
    );
  });

  it('checkout that could not open after the create: the mandate is withdrawn', async () => {
    const { d, calls } = deps({ openCheckout: jest.fn(async () => false) });

    await expect(runReplacementMandate(d)).resolves.toBe('unavailable');

    expect(calls()).toEqual([
      'GET /billing/reactivate/quote',
      'POST /billing/reactivate',
      'POST /billing/replacement/discard',
    ]);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('checkout that throws while opening: the mandate is withdrawn too', async () => {
    const { d, calls } = deps({
      openCheckout: jest.fn(async () => {
        throw new TypeError('window.Razorpay is not a constructor');
      }),
    });

    await expect(runReplacementMandate(d)).resolves.toBe('unavailable');

    expect(calls()).toEqual([
      'GET /billing/reactivate/quote',
      'POST /billing/reactivate',
      'POST /billing/replacement/discard',
    ]);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });
});

describe('replacementCopy', () => {
  it('reactivate, first charge later', () => {
    const copy = replacementCopy(t, 'reactivate', quote, 'Standard');
    expect(copy.message).toBe(
      "Razorpay can't undo a cancellation, so keeping Standard means approving a new autopay mandate for the same plan at ₹699/month. Nothing is charged today (your bank may hold a small verification amount and return it). The first charge on the new mandate is ₹699 on 13 Nov 2026. Your current mandate is cancelled once the new one is approved. If you close checkout, nothing changes."
    );
    expect(copy.title).toBe('Reactivate subscription');
    expect(copy.amountLabel).toBe('₹699/month from 13 Nov 2026');
  });

  it('change payment method after a failed renewal, yearly, in dollars', () => {
    const copy = replacementCopy(
      t,
      'payment_method',
      { currency: 'USD', billing: 'PRO', period: 'YEARLY', amount: 199.5, startAt: null, unpaid: true },
      'Pro'
    );
    expect(copy.message).toContain(
      "UPI Autopay and e-mandates can't be edited, so paying another way means approving a new mandate for Pro at $199.50/year."
    );
    expect(copy.message).toContain(
      "$199.50 is charged when you approve it, because your last payment didn't go through."
    );
    expect(copy.amountLabel).toBe('$199.50/year');
  });
});

describe('sameReplacementTerms', () => {
  it.each([
    ['amount', { amount: 799 }],
    ['currency', { currency: 'USD' }],
    ['plan', { billing: 'PRO' }],
    ['period', { period: 'YEARLY' }],
    ['first charge date', { startAt: '2026-11-14T12:00:00.000Z' }],
    ['charged on approval instead', { startAt: null }],
    ['unpaid flag', { unpaid: true }],
  ])('a different %s is a change', (_label, change) => {
    expect(sameReplacementTerms(quote, { ...quote, ...(change as any) })).toBe(false);
  });

  it('identical terms are the same', () => {
    expect(sameReplacementTerms(quote, { ...created })).toBe(true);
  });
});

describe('replacementPaths', () => {
  it('quotes and creates on the matching routes', () => {
    expect(replacementPaths('reactivate')).toEqual({
      quote: '/billing/reactivate/quote',
      create: '/billing/reactivate',
    });
    expect(replacementPaths('payment_method')).toEqual({
      quote: '/billing/payment-method/quote',
      create: '/billing/payment-method',
    });
  });
});
