/**
 * The pure helpers behind the super-admin Refunds page: money, what a
 * payment's refund state reads as, and folding refunds made on the page into
 * the payment rows and the refund history before Razorpay lists them.
 *   pnpm exec jest -c apps/frontend/jest.config.ts refunds.helpers
 */
import {
  historyRowsFromResults,
  madeFromLabel,
  mergeHistory,
  money,
  moneyTotals,
  nextLocalRefunds,
  RefundHistoryRow,
  RefundPayment,
  refundState,
  refundStatusLabel,
  withLocalRefund,
} from './refunds.helpers';

const pay = (over: Partial<RefundPayment> = {}): RefundPayment => ({
  id: 'pay_A0000000000001',
  status: 'captured',
  amount: 69900,
  amountRefunded: 0,
  refundable: 69900,
  refundStatus: null,
  currency: 'INR',
  method: 'upi',
  email: 'buyer@example.com',
  description: 'Hookpost Standard',
  international: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  hookpost: true,
  service: 'hookpost',
  organizationId: 'org-1',
  organizationName: 'Acme',
  subscriptionId: 'sub_1',
  ...over,
});

const row = (id: string, createdAt: string, over: Partial<RefundHistoryRow> = {}): RefundHistoryRow => ({
  id,
  paymentId: 'pay_A0000000000001',
  amount: 100,
  currency: 'INR',
  status: 'processed',
  createdAt,
  reference: null,
  paymentFound: true,
  paymentAmount: 69900,
  email: 'buyer@example.com',
  description: null,
  madeFrom: 'dashboard',
  madeBy: null,
  reason: null,
  hookpost: true,
  service: 'hookpost',
  organizationId: 'org-1',
  organizationName: 'Acme',
  subscriptionId: 'sub_1',
  ...over,
});

describe('money / moneyTotals', () => {
  it('formats minor units in the currency, rupees the Indian way', () => {
    expect(money(69900, 'INR')).toBe('₹699.00');
    expect(money(12345678, 'INR')).toBe('₹1,23,456.78');
    expect(money(100, 'USD')).toBe('$1.00');
    expect(money(0, 'USD')).toBe('$0.00');
  });

  it('a missing amount is zero, a missing currency is rupees', () => {
    expect(money(undefined as any, 'INR')).toBe('₹0.00');
    expect(money(500, '')).toBe('₹5.00');
  });

  it('a currency code Intl does not know still prints, never throws', () => {
    expect(money(1234, 'NOPE')).toBe('12.34 NOPE');
  });

  it('totals per currency join with +, and nothing reads as a dash', () => {
    expect(moneyTotals({ INR: 69900, USD: 100 })).toBe('₹699.00 + $1.00');
    expect(moneyTotals({})).toBe('—');
  });
});

describe('refundState', () => {
  it('a captured payment with nothing refunded', () => {
    expect(refundState(pay())).toEqual({ kind: 'none', label: 'Not refunded', detail: null });
  });

  it('partly refunded: what went back, of what, and what is left', () => {
    expect(refundState(pay({ amountRefunded: 69300, refundable: 600 }))).toEqual({
      kind: 'partial',
      label: 'Partly refunded',
      detail: '₹693.00 of ₹699.00 refunded · ₹6.00 left',
    });
  });

  it('partly refunded but no longer captured: what is left is worked out, not read', () => {
    const s = refundState(pay({ status: 'failed', amountRefunded: 100, refundable: 0 }));
    expect(s.kind).toBe('partial');
    expect(s.detail).toBe('₹1.00 of ₹699.00 refunded · ₹698.00 left');
  });

  it("fully refunded, by Razorpay's status or by the amount", () => {
    expect(refundState(pay({ status: 'refunded', amountRefunded: 69900, refundable: 0 }))).toEqual({
      kind: 'full',
      label: 'Fully refunded',
      detail: '₹699.00 refunded',
    });
    expect(refundState(pay({ amountRefunded: 69900, refundable: 0 })).kind).toBe('full');
    // Razorpay says refunded but sent no amount: the whole payment went back.
    expect(refundState(pay({ status: 'refunded', amountRefunded: 0 })).detail).toBe('₹699.00 refunded');
  });

  it('more refunded than paid (a bad figure) still reads as full, not as something left', () => {
    expect(refundState(pay({ amountRefunded: 80000, refundable: 0 })).kind).toBe('full');
  });

  it('a negative refunded figure counts as nothing refunded', () => {
    expect(refundState(pay({ amountRefunded: -5 })).kind).toBe('none');
  });

  it.each([
    ['failed', 'Payment failed'],
    ['authorized', 'Not captured'],
    ['created', 'Payment created'],
    ['', 'Not paid'],
  ])('never charged (%s): nothing to refund, says %s', (status, label) => {
    expect(refundState(pay({ status, refundable: 0 }))).toEqual({ kind: 'unpaid', label, detail: null });
  });
});

describe('withLocalRefund', () => {
  it('nothing made here, or a figure the server already has: the row is unchanged', () => {
    const p = pay({ amountRefunded: 500, refundable: 69400 });
    expect(withLocalRefund(p)).toBe(p);
    expect(withLocalRefund(p, 0)).toBe(p);
    expect(withLocalRefund(p, 500)).toBe(p);
    expect(withLocalRefund(p, 300)).toBe(p);
  });

  it('a partial refund made here lowers what is left at once', () => {
    expect(withLocalRefund(pay(), 600)).toMatchObject({
      amountRefunded: 600,
      refundable: 69300,
      status: 'captured',
      refundStatus: 'partial',
    });
  });

  it('a full refund made here: nothing left, status refunded', () => {
    expect(withLocalRefund(pay(), 69900)).toMatchObject({
      amountRefunded: 69900,
      refundable: 0,
      status: 'refunded',
      refundStatus: 'full',
    });
  });

  it('more than the payment is clamped to the payment', () => {
    expect(withLocalRefund(pay(), 99999)).toMatchObject({ amountRefunded: 69900, refundable: 0 });
  });

  it('a payment that is not captured never shows anything refundable', () => {
    expect(withLocalRefund(pay({ status: 'failed', refundable: 0 }), 100).refundable).toBe(0);
  });

  it('does not change the row it was given', () => {
    const p = pay();
    withLocalRefund(p, 600);
    expect(p.amountRefunded).toBe(0);
  });
});

describe('nextLocalRefunds', () => {
  const before = (m: Record<string, number>) => (id: string) => m[id] || 0;

  it('adds only refunds that went through and moved money', () => {
    const next = nextLocalRefunds(
      {},
      [
        { paymentId: 'pay_1', status: 'refunded', amount: 600 },
        { paymentId: 'pay_2', status: 'refused', amount: 100, error: 'not ours' },
        { paymentId: 'pay_3', status: 'failed', error: 'down' },
        { paymentId: 'pay_4', status: 'refunded' },
      ],
      before({ pay_1: 100 })
    );
    expect(next).toEqual({ pay_1: 700 });
  });

  it('a second refund on the same payment builds on the first, not on the stale server figure', () => {
    const first = nextLocalRefunds({}, [{ paymentId: 'pay_1', status: 'refunded', amount: 600 }], before({}));
    const second = nextLocalRefunds(first, [{ paymentId: 'pay_1', status: 'refunded', amount: 400 }], before({}));
    expect(second).toEqual({ pay_1: 1000 });
  });

  it('a reload that already counts the first refund is not counted twice', () => {
    const first = { pay_1: 600 };
    // The server now says 600 too; a new 400 makes 1000, not 1600.
    expect(
      nextLocalRefunds(first, [{ paymentId: 'pay_1', status: 'refunded', amount: 400 }], before({ pay_1: 600 }))
    ).toEqual({ pay_1: 1000 });
  });

  it('does not change the map it was given', () => {
    const prev = { pay_1: 1 };
    nextLocalRefunds(prev, [{ paymentId: 'pay_1', status: 'refunded', amount: 5 }], before({}));
    expect(prev).toEqual({ pay_1: 1 });
  });
});

describe('historyRowsFromResults', () => {
  const NOW = new Date('2026-10-26T12:00:00.000Z');

  it('one row per refund that went through, with the payment it belongs to', () => {
    const p = pay();
    const rows = historyRowsFromResults(
      [
        { paymentId: p.id, status: 'refunded', amount: 600, currency: 'INR', refundId: 'rfnd_1', refundStatus: 'processed' },
        { paymentId: p.id, status: 'refused', error: 'no' },
        // Went through but Razorpay gave no refund id: nothing to key it by.
        { paymentId: p.id, status: 'refunded', amount: 1 },
      ],
      (id) => (id === p.id ? p : undefined),
      'admin@hookstep.in',
      NOW
    );
    expect(rows).toEqual([
      {
        id: 'rfnd_1',
        paymentId: p.id,
        amount: 600,
        currency: 'INR',
        status: 'processed',
        createdAt: NOW.toISOString(),
        reference: null,
        paymentFound: true,
        paymentAmount: 69900,
        email: 'buyer@example.com',
        description: 'Hookpost Standard',
        madeFrom: 'tool',
        madeBy: 'admin@hookstep.in',
        reason: null,
        hookpost: true,
        service: 'hookpost',
        organizationId: 'org-1',
        organizationName: 'Acme',
        subscriptionId: 'sub_1',
      },
    ]);
  });

  it('a payment no longer on screen: pending, currency from the result, assumed Hookpost', () => {
    const [r] = historyRowsFromResults(
      [{ paymentId: 'pay_gone', status: 'refunded', amount: 100, currency: 'USD', refundId: 'rfnd_2' }],
      () => undefined,
      null,
      NOW
    );
    expect(r).toMatchObject({
      status: 'pending',
      currency: 'USD',
      paymentFound: false,
      paymentAmount: null,
      email: null,
      hookpost: true,
      madeBy: null,
    });
  });

  it("another product's payment stays marked as another product's", () => {
    const vet = pay({ hookpost: false, service: 'vetnow', organizationId: null });
    const [r] = historyRowsFromResults(
      [{ paymentId: vet.id, status: 'refunded', amount: 100, refundId: 'rfnd_3' }],
      () => vet,
      'a@b.c',
      NOW
    );
    expect(r).toMatchObject({ hookpost: false, service: 'vetnow', currency: 'INR' });
  });
});

describe('mergeHistory', () => {
  it("Razorpay's rows with the ones made here on top, newest first", () => {
    const server = [row('rfnd_old', '2026-10-01T00:00:00.000Z'), row('rfnd_mid', '2026-10-10T00:00:00.000Z')];
    const local = [row('rfnd_new', '2026-10-26T00:00:00.000Z', { madeFrom: 'tool' })];
    expect(mergeHistory(server, local, 'hookpost').map((r) => r.id)).toEqual([
      'rfnd_new',
      'rfnd_mid',
      'rfnd_old',
    ]);
  });

  it('once Razorpay lists a refund made here, its row replaces the local copy', () => {
    const local = [row('rfnd_1', '2026-10-26T00:00:00.000Z', { status: 'pending', madeFrom: 'tool' })];
    const server = [row('rfnd_1', '2026-10-25T23:59:00.000Z', { status: 'processed', reference: 'ARN1' })];
    const merged = mergeHistory(server, local, 'all');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ status: 'processed', reference: 'ARN1' });
  });

  it('a refund on two loaded pages shows once', () => {
    const r = row('rfnd_1', '2026-10-20T00:00:00.000Z');
    expect(mergeHistory([r, { ...r }], [], 'all')).toHaveLength(1);
  });

  it("Hookpost scope leaves out local rows of another product's payments; all products keeps them", () => {
    const local = [
      row('rfnd_hp', '2026-10-26T00:00:00.000Z'),
      row('rfnd_vet', '2026-10-26T00:01:00.000Z', { hookpost: false, service: 'vetnow' }),
    ];
    expect(mergeHistory([], local, 'hookpost').map((r) => r.id)).toEqual(['rfnd_hp']);
    expect(mergeHistory([], local, 'all').map((r) => r.id)).toEqual(['rfnd_vet', 'rfnd_hp']);
  });

  it('does not reorder the arrays it was given', () => {
    const server = [row('a', '2026-10-01T00:00:00.000Z'), row('b', '2026-10-02T00:00:00.000Z')];
    mergeHistory(server, [], 'all');
    expect(server.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('labels', () => {
  it('where a refund was made', () => {
    expect(madeFromLabel({ madeFrom: 'tool' })).toBe('This tool');
    expect(madeFromLabel({ madeFrom: 'dashboard' })).toBe('Razorpay dashboard');
    expect(madeFromLabel({ madeFrom: 'other' })).toBe('Outside this tool');
  });

  it("Razorpay's refund status, and anything new passes through", () => {
    expect(refundStatusLabel('processed')).toBe('Processed');
    expect(refundStatusLabel('pending')).toBe('Pending');
    expect(refundStatusLabel('failed')).toBe('Failed');
    expect(refundStatusLabel('on_hold')).toBe('on_hold');
  });
});
