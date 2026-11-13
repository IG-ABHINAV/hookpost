/**
 * The Gumroad rules (gumroad.license.ts), without a database or a network:
 * reading POST /v2/licenses/verify, mapping a product and its recurrence to
 * a plan, one license per workspace, and what the daily re-check does for a
 * purchase that is active, cancelled, refunded or failed.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts gumroad.license
 */
import {
  bindDecision,
  endedRedeemError,
  GUMROAD_REDEEM_ERRORS,
  gumroadIdentifier,
  gumroadProducts,
  gumroadRedeemEnabled,
  GumroadPurchase,
  isGumroadIdentifier,
  normalizeLicenseKey,
  parseVerifyResponse,
  periodForRecurrence,
  planOnFileBlocksRedeem,
  purchaseStanding,
  statusAfter,
  sweepAction,
  tierForProduct,
  verifyStanding,
} from './gumroad.license';

const NOW = new Date('2026-10-24T12:00:00Z');
const YESTERDAY = '2026-10-23T12:00:00Z';
const NEXT_WEEK = '2026-10-31T12:00:00Z';

/** Gumroad's own example response (help article 76), as the API sends it. */
const verified = (purchase: Record<string, unknown> = {}) => ({
  success: true,
  uses: 3,
  purchase: {
    seller_id: 'kL0psVL2admJSYRNs-OCMg==',
    product_id: '32-nPAicqbLj8B_WswVlMw==',
    product_name: 'licenses demo product',
    permalink: 'QMGY',
    email: 'customer@example.com',
    price: 0,
    currency: 'usd',
    sale_id: 'FO8TXN-dbxYaBdahG97Y-Q==',
    sale_timestamp: '2021-01-05T19:38:56Z',
    subscription_id: 'GDzW4_aBdQc-o7Gbjng7lw==',
    variants: '',
    license_key: '85DB562A-C11D4B06-A2335A6B-8C079166',
    recurrence: 'monthly',
    refunded: false,
    disputed: false,
    dispute_won: false,
    id: 'FO8TXN-dvaYbBbahG97a-Q==',
    created_at: '2021-01-05T19:38:56Z',
    custom_fields: [],
    chargebacked: false,
    subscription_ended_at: null,
    subscription_cancelled_at: null,
    subscription_failed_at: null,
    ...purchase,
  },
});

const purchaseOf = (fields: Record<string, unknown> = {}): GumroadPurchase => {
  const result = parseVerifyResponse(200, verified(fields));
  if (result.kind !== 'valid') throw new Error(`expected valid, got ${result.kind}`);
  return result.purchase;
};

describe('reading POST /v2/licenses/verify', () => {
  it('a verified membership: the sale, product, recurrence and dates', () => {
    const result = parseVerifyResponse(200, verified());
    expect(result).toEqual({
      kind: 'valid',
      uses: 3,
      purchase: {
        saleId: 'FO8TXN-dbxYaBdahG97Y-Q==',
        productId: '32-nPAicqbLj8B_WswVlMw==',
        recurrence: 'monthly',
        refunded: false,
        chargebacked: false,
        disputed: false,
        disputeWon: false,
        cancelledAt: null,
        endedAt: null,
        failedAt: null,
        test: false,
        // For the owner's sale alert: Gumroad's cents, in dollars.
        price: 0,
        currency: 'usd',
      },
    });
  });

  it("the sale's price and currency, when Gumroad sends them, for the owner's alert", () => {
    expect(purchaseOf({ price: 2900, currency: 'usd' })).toMatchObject({ price: 29, currency: 'usd' });
    const none = purchaseOf({ price: null, currency: '' });
    expect(none).not.toHaveProperty('price');
    expect(none).not.toHaveProperty('currency');
    expect(purchaseOf({ price: 'abc' })).not.toHaveProperty('price');
  });

  it('reads the three membership dates and the refund flags', () => {
    const p = purchaseOf({
      refunded: true,
      chargebacked: 'true',
      disputed: true,
      dispute_won: true,
      subscription_cancelled_at: NEXT_WEEK,
      subscription_ended_at: YESTERDAY,
      subscription_failed_at: 'not a date',
      test: true,
    });
    expect(p).toMatchObject({
      refunded: true,
      chargebacked: true,
      disputed: true,
      disputeWon: true,
      cancelledAt: new Date(NEXT_WEEK),
      endedAt: new Date(YESTERDAY),
      failedAt: null,
      test: true,
    });
  });

  it('falls back to purchase.id when sale_id is missing', () => {
    expect(purchaseOf({ sale_id: undefined }).saleId).toBe('FO8TXN-dvaYbBbahG97a-Q==');
  });

  it.each([
    ['That license does not exist for the provided product.', 'not_found'],
    ['This license key has been disabled.', 'disabled'],
    ['Access to the purchase associated with this license has expired.', 'revoked'],
  ])('404 "%s" is %s', (message, kind) => {
    expect(parseVerifyResponse(404, { success: false, message })).toEqual({ kind, message });
  });

  it.each([
    [500, { success: false, message: "The 'product_id' parameter is required" }],
    [429, {}],
    [503, { message: 'Gumroad answered 503 with a non-JSON body.' }],
    [200, { success: true }],
    [200, { success: false }],
    [404, { error: 'not json from gumroad' }],
  ])('%s %j decides nothing (unavailable)', (status, body) => {
    expect(parseVerifyResponse(status, body).kind).toBe('unavailable');
  });
});

describe('product and recurrence to plan', () => {
  const env = {
    GUMROAD_PRODUCT_STANDARD: ' std-product== ',
    GUMROAD_PRODUCT_PRO: 'pro-product==',
  };

  it('each configured product is its plan, Standard first; spaces trimmed', () => {
    expect(gumroadProducts(env)).toEqual([
      { tier: 'STANDARD', productId: 'std-product==' },
      { tier: 'PRO', productId: 'pro-product==' },
    ]);
    expect(tierForProduct('std-product==', env)).toBe('STANDARD');
    expect(tierForProduct('pro-product==', env)).toBe('PRO');
    expect(tierForProduct('someone-elses==', env)).toBeNull();
    expect(tierForProduct(null, env)).toBeNull();
  });

  it('on with either product and the access token; off without a product or without the token', () => {
    const token = { GUMROAD_ACCESS_TOKEN: 'token' };
    expect(gumroadRedeemEnabled({})).toBe(false);
    expect(gumroadRedeemEnabled({ ...token, GUMROAD_PRODUCT_STANDARD: '  ' })).toBe(false);
    expect(gumroadRedeemEnabled({ ...token, GUMROAD_PRODUCT_PRO: 'pro-product==' })).toBe(true);
    // Without the token a later refund could never end the plan.
    expect(gumroadRedeemEnabled({ GUMROAD_PRODUCT_PRO: 'pro-product==' })).toBe(false);
    expect(
      gumroadRedeemEnabled({ GUMROAD_PRODUCT_PRO: 'pro-product==', GUMROAD_ACCESS_TOKEN: ' ' })
    ).toBe(false);
    expect(gumroadProducts({ GUMROAD_PRODUCT_PRO: 'p' })).toEqual([{ tier: 'PRO', productId: 'p' }]);
  });

  it.each([
    ['monthly', 'MONTHLY'],
    ['quarterly', 'MONTHLY'],
    ['biannually', 'MONTHLY'],
    ['yearly', 'YEARLY'],
    ['every_two_years', 'YEARLY'],
    [' Yearly ', 'YEARLY'],
    [null, null],
    ['', null],
    ['weekly', null],
  ])('recurrence %j is %s', (recurrence, period) => {
    expect(periodForRecurrence(recurrence)).toBe(period);
  });

  it('the plan row says where it was paid: gumroad:<sale>', () => {
    expect(gumroadIdentifier('FO8TXN-dbxYaBdahG97Y-Q==')).toBe('gumroad:FO8TXN-dbxYaBdahG97Y-Q==');
    expect(isGumroadIdentifier('gumroad:FO8TXN')).toBe(true);
    expect(isGumroadIdentifier('sub_TYd1D4gZnW0EP2')).toBe(false);
    expect(isGumroadIdentifier(null)).toBe(false);
  });

  it('a pasted key is trimmed and upper-cased; anything that cannot be a key is refused', () => {
    expect(normalizeLicenseKey(' 85db562a-c11d4b06-a2335a6b-8c079166\n')).toBe(
      '85DB562A-C11D4B06-A2335A6B-8C079166'
    );
    expect(normalizeLicenseKey('85DB 562A-C11D4B06')).toBe('85DB562A-C11D4B06');
    for (const bad of ['', 'short', '<script>alert(1)</script>', 'A'.repeat(65), null, 42]) {
      expect(normalizeLicenseKey(bad)).toBeNull();
    }
  });
});

describe('one license, one workspace', () => {
  it('a key nobody holds binds; its own workspace may redeem it again; anyone else is refused', () => {
    expect(bindDecision(null, 'org-a')).toBe('new');
    expect(bindDecision({ organizationId: 'org-a' }, 'org-a')).toBe('same_org');
    expect(bindDecision({ organizationId: 'org-a' }, 'org-b')).toBe('other_org');
  });

  it('any live plan not paid on Gumroad blocks a redeem, even one set to end', () => {
    expect(planOnFileBlocksRedeem(null)).toBe(false);
    expect(planOnFileBlocksRedeem({ identifier: 'sub_live', cancelAt: null })).toBe(true);
    expect(planOnFileBlocksRedeem({ identifier: 'k3J9x', cancelAt: null })).toBe(true);
    expect(planOnFileBlocksRedeem({ identifier: 'sub_x', isLifetime: true, cancelAt: NEXT_WEEK })).toBe(true);
    // A halted renewal carries its grace date as cancelAt and can still be paid.
    expect(planOnFileBlocksRedeem({ identifier: 'sub_halted', cancelAt: NEXT_WEEK })).toBe(true);
    expect(planOnFileBlocksRedeem({ identifier: 'gumroad:other-sale', cancelAt: null })).toBe(false);
    expect(planOnFileBlocksRedeem({ identifier: 'sub_gone', cancelAt: null, deletedAt: YESTERDAY })).toBe(false);
  });
});

describe('where a purchase stands', () => {
  it('active: nothing refunded, no membership date', () => {
    expect(purchaseStanding(purchaseOf(), NOW)).toEqual({ status: 'ACTIVE' });
  });

  it('refunded or charged back ends it, whatever the dates say', () => {
    expect(purchaseStanding(purchaseOf({ refunded: true }), NOW)).toEqual({ status: 'REFUNDED' });
    expect(purchaseStanding(purchaseOf({ chargebacked: true }), NOW)).toEqual({
      status: 'CHARGEBACKED',
    });
    expect(purchaseStanding(purchaseOf({ disputed: true }), NOW)).toEqual({
      status: 'CHARGEBACKED',
    });
    // A dispute the seller won is money kept.
    expect(purchaseStanding(purchaseOf({ disputed: true, dispute_won: true }), NOW)).toEqual({
      status: 'ACTIVE',
    });
  });

  it('cancelled with paid time left: set to end on that date', () => {
    expect(
      purchaseStanding(purchaseOf({ subscription_cancelled_at: NEXT_WEEK }), NOW)
    ).toEqual({ status: 'CANCELLING', endsAt: new Date(NEXT_WEEK) });
  });

  it('cancelled and the date has passed: ended', () => {
    expect(
      purchaseStanding(purchaseOf({ subscription_cancelled_at: YESTERDAY }), NOW)
    ).toEqual({ status: 'CANCELLED' });
  });

  it('a failed renewal or a fixed-length membership that ran out: ended', () => {
    expect(purchaseStanding(purchaseOf({ subscription_failed_at: YESTERDAY }), NOW)).toEqual({
      status: 'FAILED',
    });
    expect(purchaseStanding(purchaseOf({ subscription_ended_at: YESTERDAY }), NOW)).toEqual({
      status: 'ENDED',
    });
  });

  it('a failure that has happened wins over a cancellation still ahead', () => {
    expect(
      purchaseStanding(
        purchaseOf({ subscription_failed_at: YESTERDAY, subscription_cancelled_at: NEXT_WEEK }),
        NOW
      )
    ).toEqual({ status: 'FAILED' });
  });

  it('a key Gumroad no longer finds, has disabled or revoked is REVOKED; no answer decides nothing', () => {
    for (const kind of ['not_found', 'disabled', 'revoked'] as const) {
      expect(verifyStanding({ kind, message: '' }, NOW)).toEqual({ status: 'REVOKED' });
    }
    expect(verifyStanding({ kind: 'unavailable', message: 'timeout' }, NOW)).toBeNull();
  });

  it('the redeem error for each ended purchase', () => {
    expect(endedRedeemError('REFUNDED')).toBe('REFUNDED');
    expect(endedRedeemError('CHARGEBACKED')).toBe('REFUNDED');
    expect(endedRedeemError('CANCELLED')).toBe('CANCELLED');
    expect(endedRedeemError('FAILED')).toBe('CANCELLED');
    expect(endedRedeemError('ENDED')).toBe('CANCELLED');
    expect(endedRedeemError('REVOKED')).toBe('DISABLED');
  });
});

describe('the daily re-check: what happens to the plan', () => {
  const ID = 'gumroad:FO8TXN-dbxYaBdahG97Y-Q==';
  const plan = (cancelAt: string | null = null) => ({ identifier: ID, cancelAt });

  it('active, nothing set to end: nothing changes', () => {
    const step = sweepAction({ status: 'ACTIVE' }, plan(), ID);
    expect(step).toEqual({ action: 'keep' });
    expect(statusAfter({ status: 'ACTIVE' }, step)).toBe('ACTIVE');
  });

  it('active again after a renewal or restart: the end date is lifted', () => {
    expect(sweepAction({ status: 'ACTIVE' }, plan(NEXT_WEEK), ID)).toEqual({ action: 'lift' });
  });

  it('cancelled with paid time left: cancelAt set to the end of the paid period', () => {
    const standing = { status: 'CANCELLING' as const, endsAt: new Date(NEXT_WEEK) };
    const step = sweepAction(standing, plan(), ID);
    expect(step).toEqual({ action: 'schedule', endsAt: new Date(NEXT_WEEK) });
    expect(statusAfter(standing, step)).toBe('CANCELLING');
    // Already on file: nothing to write again.
    expect(sweepAction(standing, plan(NEXT_WEEK), ID)).toEqual({ action: 'keep' });
  });

  it.each(['REFUNDED', 'CHARGEBACKED', 'CANCELLED', 'FAILED', 'ENDED', 'REVOKED'] as const)(
    '%s: the plan ends now',
    (status) => {
      const step = sweepAction({ status }, plan(NEXT_WEEK), ID);
      expect(step).toEqual({ action: 'end', status });
      expect(statusAfter({ status }, step)).toBe(status);
    }
  );

  it('a workspace now on another plan (Razorpay, another key, none) is left alone', () => {
    for (const other of [
      { identifier: 'sub_TYd1D4gZnW0EP2', cancelAt: null },
      { identifier: 'gumroad:another-sale', cancelAt: null },
      { identifier: ID, cancelAt: null, deletedAt: YESTERDAY },
      null,
    ]) {
      const step = sweepAction({ status: 'REFUNDED' }, other, ID);
      expect(step).toEqual({ action: 'detach' });
      expect(statusAfter({ status: 'REFUNDED' }, step)).toBe('DETACHED');
    }
  });
});

describe('redeem errors', () => {
  it('every code has a status and a message', () => {
    for (const [code, { status, message }] of Object.entries(GUMROAD_REDEEM_ERRORS)) {
      expect([code, status >= 400 && status < 600]).toEqual([code, true]);
      expect(message.length).toBeGreaterThan(10);
    }
    expect(GUMROAD_REDEEM_ERRORS.LICENSE_IN_USE.status).toBe(409);
  });
});
