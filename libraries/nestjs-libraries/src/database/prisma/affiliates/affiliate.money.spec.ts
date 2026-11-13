/**
 * The affiliate programme moves real money, so before any payout automation
 * is built on it: every rule it pays by, and the ways it could be made to pay
 * wrongly. The repository is an in-memory stand-in that keeps the database's
 * unique indexes (Affiliate.code, AffiliateReferral.organizationId,
 * AffiliateCommission.paymentId), so a race resolves the way Postgres
 * resolves it. Nothing here touches Razorpay or the network.
 */
import 'reflect-metadata';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);

import { BadRequestException } from '@nestjs/common';
import {
  AffiliateService,
  normaliseAffiliateCode,
  normaliseUtr,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  AFFILIATE_MIN_PAYOUT_INR,
  AFFILIATE_MIN_PAYOUT_USD,
  commissionWindowOpen,
  payoutDue,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';

const DAY = 86400 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const monthsAgo = (n: number, extraMs = 0) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return new Date(d.getTime() + extraMs);
};

class UniqueViolation extends Error {
  code = 'P2002';
}

/** The three affiliate tables, with their unique indexes. */
function fakeDb() {
  const affiliates: any[] = [];
  const referrals: any[] = [];
  const commissions: any[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  // A tick between the read and the write, as a real round trip has, so two
  // concurrent calls both pass a find-then-create check.
  const tick = () => new Promise((r) => setImmediate(r));

  const repo = {
    findByUser: jest.fn(async (userId: string) => affiliates.find((a) => a.userId === userId) || null),
    findById: jest.fn(async (aid: string) => affiliates.find((a) => a.id === aid) || null),
    findByCode: jest.fn(async (code: string) => affiliates.find((a) => a.code === code) || null),
    findCoupon: jest.fn(async () => null),
    createCoupon: jest.fn(async () => ({})),
    create: jest.fn(async (data: any) => {
      const row = { id: id('aff'), active: true, createdAt: new Date(), ...data };
      affiliates.push(row);
      return row;
    }),
    setActive: jest.fn(async (aid: string, active: boolean) => {
      const a = affiliates.find((x) => x.id === aid)!;
      a.active = active;
      return a;
    }),
    findReferral: jest.fn(async (organizationId: string) => {
      await tick();
      const r = referrals.find((x) => x.organizationId === organizationId);
      return r ? { ...r, affiliate: affiliates.find((a) => a.id === r.affiliateId) } : null;
    }),
    createReferral: jest.fn(async (affiliateId: string, organizationId: string) => {
      await tick();
      if (referrals.some((r) => r.organizationId === organizationId)) {
        throw new UniqueViolation('AffiliateReferral_organizationId_key');
      }
      const row = { id: id('ref'), affiliateId, organizationId, createdAt: new Date() };
      referrals.push(row);
      return row;
    }),
    countReferrals: jest.fn(async (aid: string) => referrals.filter((r) => r.affiliateId === aid).length),
    findCommissionByPayment: jest.fn(async (paymentId: string) => {
      await tick();
      return commissions.find((c) => c.paymentId === paymentId) || null;
    }),
    createCommission: jest.fn(async (data: any) => {
      await tick();
      if (commissions.some((c) => c.paymentId === data.paymentId)) {
        throw new UniqueViolation('AffiliateCommission_paymentId_key');
      }
      const row = { id: id('com'), status: 'PENDING', paidAt: null, paidNote: null, createdAt: new Date(), ...data };
      commissions.push(row);
      return row;
    }),
    allCommissions: jest.fn(async (aid: string) => commissions.filter((c) => c.affiliateId === aid)),
    listCommissions: jest.fn(async (aid: string) => commissions.filter((c) => c.affiliateId === aid)),
    listAffiliates: jest.fn(async () =>
      affiliates.map((a) => ({
        ...a,
        _count: { referrals: referrals.filter((r) => r.affiliateId === a.id).length },
        commissions: commissions.filter((c) => c.affiliateId === a.id),
      }))
    ),
    listPendingCommissions: jest.fn(async () => commissions.filter((c) => c.status === 'PENDING')),
    findCommissionsByIds: jest.fn(async (ids: string[]) => commissions.filter((c) => ids.includes(c.id))),
    findPaidByNote: jest.fn(async (note: string) =>
      commissions.find((c) => c.status === 'PAID' && c.paidNote === note) || null
    ),
    markPaid: jest.fn(async (ids: string[], note: string | null) => {
      let count = 0;
      for (const c of commissions) {
        if (ids.includes(c.id) && c.status === 'PENDING') {
          Object.assign(c, { status: 'PAID', paidAt: new Date(), paidNote: note });
          count++;
        }
      }
      return { count };
    }),
    voidCommission: jest.fn(async (cid: string, note: string | null) => {
      const c = commissions.find((x) => x.id === cid && x.status === 'PENDING');
      if (c) Object.assign(c, { status: 'VOID', paidNote: note });
      return { count: c ? 1 : 0 };
    }),
    voidCommissionByPayment: jest.fn(async (paymentId: string, note: string) => {
      const c = commissions.find((x) => x.paymentId === paymentId && x.status === 'PENDING');
      if (c) Object.assign(c, { status: 'VOID', paidNote: note });
      return { count: c ? 1 : 0 };
    }),
  };

  const service = new AffiliateService(repo as any);
  const logger = (service as any).logger;
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  /** An affiliate who owns workspace `org-<code>`, joined as user `user-<code>`. */
  const affiliate = (code: string, over: Record<string, any> = {}) => {
    const row = {
      id: id('aff'),
      userId: `user-${code}`,
      organizationId: `org-${code}`,
      code,
      name: code,
      email: `${code}@example.test`,
      commissionPercent: 30,
      commissionMonths: 0,
      active: true,
      createdAt: new Date(),
      ...over,
    };
    affiliates.push(row);
    return row;
  };
  const refer = (a: any, organizationId: string, createdAt = new Date()) => {
    const row = { id: id('ref'), affiliateId: a.id, organizationId, createdAt };
    referrals.push(row);
    return row;
  };
  return { service, repo, affiliates, referrals, commissions, affiliate, refer, warn, error };
}

const org = (orgId: string, createdAt: Date = new Date()) => ({ id: orgId, createdAt } as any);
const user = (userId: string) => ({ id: userId } as any);
const charge = (paymentId: string, amount: number, over: Record<string, any> = {}) => ({
  id: paymentId,
  amount,
  currency: 'INR',
  status: 'captured',
  ...over,
});

// -----------------------------------------------------------------------------

describe('attribution by the ?ref cookie (GET /user/self)', () => {
  it('a new workspace is credited to the code, typed in any case and with spaces', async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    await t.service.attribute('  ASHA123 ', org('org-new'), user('user-new'));
    expect(t.referrals).toEqual([expect.objectContaining({ affiliateId: a.id, organizationId: 'org-new' })]);
  });

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(41)],
    ['SQL', "x' OR '1'='1"],
    ['path', '../admin'],
    ['unicode lookalike', 'аsha123'],
    ['a code nobody holds', 'nobody999'],
  ])('a %s code credits nobody', async (_label, code) => {
    const t = fakeDb();
    t.affiliate('asha123');
    await t.service.attribute(code as any, org('org-new'), user('user-new'));
    expect(t.referrals).toHaveLength(0);
    expect(t.repo.createReferral).not.toHaveBeenCalled();
  });

  it.each([
    ['created now', 0, true],
    ['6 days old', 6, true],
    ['7 days and 23 hours old (whole days are counted)', 7 + 23 / 24, true],
    ['8 days old', 8, false],
    ['a year old', 365, false],
  ])('a workspace %s: credited %s', async (_label, age, credited) => {
    const t = fakeDb();
    t.affiliate('asha123');
    await t.service.attribute('asha123', org('org-w', daysAgo(age as number)), user('user-w'));
    expect(t.referrals).toHaveLength(credited ? 1 : 0);
  });

  it('no self-referral: not the affiliate\'s own workspace, not a second one they create', async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    await t.service.attribute('asha123', org(a.organizationId), user('someone-else'));
    await t.service.attribute('asha123', org('org-second'), user(a.userId));
    expect(t.referrals).toHaveLength(0);
  });

  it('one referral per workspace: a second link never takes it over', async () => {
    const t = fakeDb();
    const first = t.affiliate('asha123');
    t.affiliate('ravi456');
    await t.service.attribute('asha123', org('org-new'), user('user-new'));
    await t.service.attribute('ravi456', org('org-new'), user('user-new'));
    expect(t.referrals).toEqual([expect.objectContaining({ affiliateId: first.id })]);
  });

  it('two tabs loading at once: one referral, and neither request fails', async () => {
    const t = fakeDb();
    t.affiliate('asha123');
    t.affiliate('ravi456');
    await expect(
      Promise.all([
        t.service.attribute('asha123', org('org-new'), user('user-new')),
        t.service.attribute('ravi456', org('org-new'), user('user-new')),
        t.service.attribute('asha123', org('org-new'), user('user-new')),
      ])
    ).resolves.toBeDefined();
    expect(t.referrals).toHaveLength(1);
  });

  it('a paused affiliate\'s link credits nobody', async () => {
    const t = fakeDb();
    t.affiliate('asha123', { active: false });
    await t.service.attribute('asha123', org('org-new'), user('user-new'));
    expect(t.referrals).toHaveLength(0);
  });

  it('a database failure never reaches the page load', async () => {
    const t = fakeDb();
    t.affiliate('asha123');
    t.repo.findReferral.mockRejectedValueOnce(new Error('connection reset'));
    await expect(t.service.attribute('asha123', org('org-new'), user('u'))).resolves.toBeUndefined();
  });
});

describe('attribution by coupon (subscription.authenticated)', () => {
  it('the code as a coupon credits a workspace of any age, upper-case as checkout stores it', async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    await t.service.attributeByCoupon('ASHA123', 'org-old', ['user-old']);
    expect(t.referrals).toEqual([expect.objectContaining({ affiliateId: a.id, organizationId: 'org-old' })]);
  });

  it('no self-referral: not their own workspace, nor one they are a member of', async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    await t.service.attributeByCoupon('ASHA123', a.organizationId, ['user-x']);
    await t.service.attributeByCoupon('ASHA123', 'org-team', ['user-owner', a.userId]);
    expect(t.referrals).toHaveLength(0);
  });

  it('never overrides a referral already made by a link', async () => {
    const t = fakeDb();
    const first = t.affiliate('asha123');
    t.affiliate('ravi456');
    await t.service.attribute('asha123', org('org-new'), user('user-new'));
    await t.service.attributeByCoupon('RAVI456', 'org-new', ['user-new']);
    expect(t.referrals).toEqual([expect.objectContaining({ affiliateId: first.id })]);
  });

  it('an ordinary coupon, a paused affiliate\'s code, or no workspace: nobody is credited', async () => {
    const t = fakeDb();
    t.affiliate('paused1', { active: false });
    await t.service.attributeByCoupon('LAUNCH50', 'org-a', []);
    await t.service.attributeByCoupon('PAUSED1', 'org-b', []);
    await t.service.attributeByCoupon('ASHA123', undefined, []);
    expect(t.referrals).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------

describe('commission on a captured charge', () => {
  const referred = (over: Record<string, any> = {}, referredAt = new Date()) => {
    const t = fakeDb();
    const a = t.affiliate('asha123', over);
    t.refer(a, 'org-c', referredAt);
    return { ...t, a };
  };

  it('30% of a Standard month (₹599) and a Standard year (₹5,990), in paise', async () => {
    const t = referred();
    await t.service.recordCommission('org-c', charge('pay_m', 59900));
    await t.service.recordCommission('org-c', charge('pay_y', 599000));
    expect(t.commissions.map((c) => [c.paymentId, c.amount, c.commission, c.currency, c.status])).toEqual([
      ['pay_m', 59900, 17970, 'INR', 'PENDING'],
      ['pay_y', 599000, 179700, 'INR', 'PENDING'],
    ]);
  });

  it.each([
    // amount (paise) -> commission (paise): rounded to the nearest paisa, half up
    [1, 0],
    [2, 1],
    [5, 2],
    [99, 30],
    [333, 100],
    [53910, 16173], // ₹599 less the 10% affiliate coupon
    [49900, 14970],
    [69900, 20970],
  ])('%i paise earns %i paise, a whole number', async (amount, expected) => {
    const t = referred();
    await t.service.recordCommission('org-c', charge(`pay_${amount}`, amount));
    expect(t.commissions[0].commission).toBe(expected);
    expect(Number.isInteger(t.commissions[0].commission)).toBe(true);
  });

  it('a dollar charge earns in cents and stays in dollars; a charge with no currency is rupees', async () => {
    const t = referred();
    await t.service.recordCommission('org-c', charge('pay_usd', 1900, { currency: 'USD' }));
    await t.service.recordCommission('org-c', charge('pay_inr', 59900, { currency: undefined }));
    expect(t.commissions.map((c) => [c.currency, c.commission])).toEqual([
      ['USD', 570],
      ['INR', 17970],
    ]);
    // The dashboard never adds dollars to rupees.
    const mine = await t.service.getMine(t.a.userId);
    expect(mine!.pending).toEqual({ USD: 570, INR: 17970 });
  });

  it.each([
    ['zero', { amount: 0 }],
    ['negative', { amount: -59900 }],
    ['NaN', { amount: Number.NaN }],
    ['missing', { amount: undefined }],
    ['a string that is not a number', { amount: 'lots' }],
    ['no payment id', { id: undefined }],
    ['failed', { status: 'failed' }],
    ['only authorized', { status: 'authorized' }],
    ['already refunded', { status: 'refunded' }],
  ])('a charge with %s amount or state earns nothing', async (_label, over) => {
    const t = referred();
    await t.service.recordCommission('org-c', { ...charge('pay_x', 59900), ...over });
    expect(t.commissions).toHaveLength(0);
  });

  it('no workspace, or a workspace nobody referred: nothing', async () => {
    const t = referred();
    await t.service.recordCommission(undefined, charge('pay_1', 59900));
    await t.service.recordCommission('org-unreferred', charge('pay_2', 59900));
    expect(t.commissions).toHaveLength(0);
  });

  it('a redelivered webhook is not paid twice', async () => {
    const t = referred();
    for (let i = 0; i < 3; i++) await t.service.recordCommission('org-c', charge('pay_dup', 59900));
    expect(t.commissions).toHaveLength(1);
  });

  it('ten deliveries of one charge at once: one commission, and none of them throws', async () => {
    const t = referred();
    await expect(
      Promise.all(Array.from({ length: 10 }, () => t.service.recordCommission('org-c', charge('pay_race', 59900))))
    ).resolves.toHaveLength(10);
    expect(t.commissions).toHaveLength(1);
    expect(t.commissions[0].commission).toBe(17970);
  });

  it('a redelivery after the commission was voided does not bring it back', async () => {
    const t = referred();
    await t.service.recordCommission('org-c', charge('pay_v', 59900));
    await t.service.voidForRefund('pay_v', 'rfnd_1');
    await t.service.recordCommission('org-c', charge('pay_v', 59900));
    expect(t.commissions.map((c) => c.status)).toEqual(['VOID']);
  });

  it('a paused affiliate earns nothing while paused, and earns again once resumed', async () => {
    const t = referred({ active: false });
    await t.service.recordCommission('org-c', charge('pay_paused', 59900));
    expect(t.commissions).toHaveLength(0);
    await t.service.setActive(t.a.id, true);
    await t.service.recordCommission('org-c', charge('pay_resumed', 59900));
    expect(t.commissions.map((c) => c.paymentId)).toEqual(['pay_resumed']);
  });

  it('a database failure is logged and never fails the charge webhook', async () => {
    const t = referred();
    t.repo.createCommission.mockRejectedValueOnce(new Error('deadlock'));
    await expect(t.service.recordCommission('org-c', charge('pay_e', 59900))).resolves.toBeUndefined();
    expect(t.error).toHaveBeenCalled();
  });
});

describe('the 12-month window (an affiliate on a limited deal)', () => {
  it.each([
    ['1 month in', monthsAgo(1), true],
    ['11 months in', monthsAgo(11), true],
    ['an hour before 12 months', monthsAgo(12, 3600 * 1000), true],
    ['12 months to the minute', monthsAgo(12, -60 * 1000), false],
    ['13 months in', monthsAgo(13), false],
  ])('a charge %s earns: %s', async (_label, referredAt, earns) => {
    const t = fakeDb();
    const a = t.affiliate('deal12', { commissionMonths: 12 });
    t.refer(a, 'org-c', referredAt as Date);
    await t.service.recordCommission('org-c', charge('pay_w', 59900));
    expect(t.commissions).toHaveLength(earns ? 1 : 0);
  });

  it('lifetime (0) still earns five years on', async () => {
    const t = fakeDb();
    const a = t.affiliate('life0', { commissionMonths: 0 });
    t.refer(a, 'org-c', monthsAgo(60));
    await t.service.recordCommission('org-c', charge('pay_l', 59900));
    expect(t.commissions).toHaveLength(1);
  });

  it('month ends and leap days do not stretch or cut the window', () => {
    // Referred on 31 Jan: one month runs to the end of February.
    expect(commissionWindowOpen(1, '2027-01-31T10:00:00Z', new Date('2027-02-28T23:59:00Z'))).toBe(true);
    expect(commissionWindowOpen(1, '2027-01-31T10:00:00Z', new Date('2027-03-31T10:00:00Z'))).toBe(false);
    // Referred on 29 Feb 2028: 12 months end on 1 Mar 2029.
    expect(commissionWindowOpen(12, '2028-02-29T10:00:00Z', new Date('2029-02-28T10:00:00Z'))).toBe(true);
    expect(commissionWindowOpen(12, '2028-02-29T10:00:00Z', new Date('2029-03-01T10:00:00Z'))).toBe(false);
    // Across a year end.
    expect(commissionWindowOpen(12, '2026-12-15T00:00:00Z', new Date('2027-12-14T23:59:59Z'))).toBe(true);
    expect(commissionWindowOpen(12, '2026-12-15T00:00:00Z', new Date('2027-12-15T00:00:00Z'))).toBe(false);
  });
});

// -----------------------------------------------------------------------------

describe('refunds void the commission', () => {
  const withCommission = async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    t.refer(a, 'org-c');
    await t.service.recordCommission('org-c', charge('pay_r', 59900));
    return { ...t, a };
  };

  it('an unpaid commission is void, with the refund named', async () => {
    const t = await withCommission();
    await t.service.voidForRefund('pay_r', 'rfnd_9');
    expect(t.commissions[0]).toMatchObject({ status: 'VOID', paidNote: 'refund rfnd_9' });
    const mine = await t.service.getMine(t.a.userId);
    expect(mine!.pending).toEqual({});
  });

  it('refund.created then refund.processed (and the hourly sweep): still one void, nothing thrown', async () => {
    const t = await withCommission();
    for (let i = 0; i < 3; i++) await t.service.voidForRefund('pay_r', 'rfnd_9');
    expect(t.commissions.map((c) => c.status)).toEqual(['VOID']);
  });

  it('a commission already paid out stays PAID and the owner is told to recover it', async () => {
    const t = await withCommission();
    await t.service.markPaid([t.commissions[0].id], '412345678901');
    await t.service.voidForRefund('pay_r', 'rfnd_9');
    expect(t.commissions[0].status).toBe('PAID');
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('recover it by hand'));
  });

  it('a refund of a payment with no commission, or no payment id, changes nothing', async () => {
    const t = await withCommission();
    await t.service.voidForRefund('pay_other', 'rfnd_1');
    await t.service.voidForRefund(undefined, 'rfnd_2');
    expect(t.commissions.map((c) => c.status)).toEqual(['PENDING']);
  });

  it('a lost chargeback voids it the same way, named as a chargeback', async () => {
    const t = await withCommission();
    await t.service.voidForRefund('pay_r', 'disp_7', 'chargeback');
    await t.service.voidForRefund('pay_r', 'disp_7', 'chargeback');
    expect(t.commissions[0]).toMatchObject({ status: 'VOID', paidNote: 'chargeback disp_7' });
  });

  it('a chargeback lost after payout leaves it PAID and tells the owner', async () => {
    const t = await withCommission();
    await t.service.markPaid([t.commissions[0].id], '412345678901');
    await t.service.voidForRefund('pay_r', 'disp_7', 'chargeback');
    expect(t.commissions[0].status).toBe('PAID');
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('chargeback'));
  });

  it('never throws into the refund webhook', async () => {
    const t = await withCommission();
    t.repo.voidCommissionByPayment.mockRejectedValueOnce(new Error('db down'));
    await expect(t.service.voidForRefund('pay_r', 'rfnd_1')).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------

describe('minimum payout (₹1,000, or $12)', () => {
  it('the floors', () => {
    expect(AFFILIATE_MIN_PAYOUT_INR).toBe(1000);
    expect(AFFILIATE_MIN_PAYOUT_USD).toBe(12);
  });

  it.each([
    [{}, false],
    [{ INR: 99999 }, false],
    [{ INR: AFFILIATE_MIN_PAYOUT_INR * 100 }, true],
    [{ INR: 100001 }, true],
    [{ USD: 1199 }, false],
    [{ USD: AFFILIATE_MIN_PAYOUT_USD * 100 }, true],
    [{ USD: 1200, INR: 10 }, true],
    [{ USD: 10, INR: 100000 }, true],
    // Never converted: ₹999.99 and $11.99 together are not due.
    [{ USD: 1199, INR: 99999 }, false],
    [{ EUR: 1_000_000 }, false],
  ])('owed %j: due %s', (pending, due) => {
    expect(payoutDue(pending as any)).toBe(due);
  });

  it('a dollar affiliate is due at $12 in the admin overview', async () => {
    const t = fakeDb();
    const a = t.affiliate('sam123');
    t.refer(a, 'org-us');
    // $19 x 2 at 30% = $11.40: not due. A third: $17.10, due.
    for (let i = 0; i < 2; i++) await t.service.recordCommission('org-us', charge(`pay_u${i}`, 1900, { currency: 'USD' }));
    expect((await t.service.adminOverview()).affiliates[0]).toMatchObject({ pending: { USD: 1140 }, payoutDue: false });
    await t.service.recordCommission('org-us', charge('pay_u2', 1900, { currency: 'USD' }));
    expect((await t.service.adminOverview()).affiliates[0]).toMatchObject({ pending: { USD: 1710 }, payoutDue: true });
  });

  it('the admin overview says who is due, counting only what is unpaid', async () => {
    const t = fakeDb();
    const a = t.affiliate('asha123');
    t.refer(a, 'org-1');
    t.refer(a, 'org-2');
    // ₹599 x 5 at 30% = ₹898.50: not due.
    for (let i = 0; i < 5; i++) await t.service.recordCommission('org-1', charge(`pay_a${i}`, 59900));
    let row = (await t.service.adminOverview()).affiliates[0];
    expect(row.pending).toEqual({ INR: 89850 });
    expect(row.payoutDue).toBe(false);
    // One more: ₹1,078.20, due.
    await t.service.recordCommission('org-2', charge('pay_a5', 59900));
    row = (await t.service.adminOverview()).affiliates[0];
    expect(row.payoutDue).toBe(true);
    // A refund takes it back under the floor.
    await t.service.voidForRefund('pay_a5', 'rfnd_x');
    row = (await t.service.adminOverview()).affiliates[0];
    expect(row.pending).toEqual({ INR: 89850 });
    expect(row.payoutDue).toBe(false);
  });
});

describe('admin mark-paid', () => {
  const owed = async () => {
    const t = fakeDb();
    const asha = t.affiliate('asha123');
    const ravi = t.affiliate('ravi456');
    t.refer(asha, 'org-a');
    t.refer(ravi, 'org-r');
    await t.service.recordCommission('org-a', charge('pay_a1', 59900));
    await t.service.recordCommission('org-a', charge('pay_a2', 59900));
    await t.service.recordCommission('org-r', charge('pay_r1', 59900));
    const ids = (paymentIds: string[]) =>
      t.commissions.filter((c) => paymentIds.includes(c.paymentId)).map((c) => c.id);
    return { ...t, asha, ravi, ids };
  };

  it.each([
    ['no reference', undefined],
    ['an empty one', '   '],
    ['a word', 'paid'],
    ['a long word', 'VERIFICATIONS'],
    ['too short', 'UTR 12345'],
    ['too long', 'A'.repeat(23)],
    ['punctuation', '4123-4567-8901'],
    ['markup', '<b>412345678901</b>'],
  ])('refused without a valid UTR: %s', async (_label, note) => {
    const t = await owed();
    await expect(t.service.markPaid(t.ids(['pay_a1']), note as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.repo.markPaid).not.toHaveBeenCalled();
    expect(t.commissions.every((c) => c.status === 'PENDING')).toBe(true);
  });

  it.each([
    ['a UPI reference (12 digits)', '412345678901', '412345678901'],
    ['a NEFT UTR (16)', 'hdfcn52026110312', 'HDFCN52026110312'],
    ['an RTGS UTR (22), spaced', 'SBINR5 2026110312345678', 'SBINR52026110312345678'],
  ])('accepts %s and stores it normalised', async (_label, typed, stored) => {
    expect(normaliseUtr(typed)).toBe(stored);
    const t = await owed();
    await expect(t.service.markPaid(t.ids(['pay_a1', 'pay_a2']), typed)).resolves.toEqual({ count: 2 });
    expect(t.commissions.filter((c) => c.status === 'PAID').map((c) => c.paidNote)).toEqual([stored, stored]);
  });

  it('pressing it twice pays nothing twice', async () => {
    const t = await owed();
    const ids = t.ids(['pay_a1', 'pay_a2']);
    expect(await t.service.markPaid(ids, '412345678901')).toEqual({ count: 2 });
    const paidAt = t.commissions[0].paidAt;
    expect(await t.service.markPaid(ids, '412345678901')).toEqual({ count: 0 });
    expect(t.commissions[0].paidAt).toBe(paidAt);
    expect(await t.service.markPaid([...ids, ...ids], '412345678901')).toEqual({ count: 0 });
  });

  it('one transfer cannot be recorded against two affiliates', async () => {
    const t = await owed();
    await expect(t.service.markPaid(t.ids(['pay_a1', 'pay_r1']), '412345678901')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(t.commissions.every((c) => c.status === 'PENDING')).toBe(true);
  });

  it('a UTR already recorded for another affiliate is refused; the same affiliate may add to it', async () => {
    const t = await owed();
    await t.service.markPaid(t.ids(['pay_a1']), '412345678901');
    await expect(t.service.markPaid(t.ids(['pay_r1']), '412345678901')).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.service.markPaid(t.ids(['pay_a2']), '412345678901')).resolves.toEqual({ count: 1 });
  });

  it('void and already-paid commissions in the selection are left alone', async () => {
    const t = await owed();
    await t.service.voidForRefund('pay_a1', 'rfnd_1');
    expect(await t.service.markPaid(t.ids(['pay_a1', 'pay_a2']), '412345678901')).toEqual({ count: 1 });
    expect(t.commissions.find((c) => c.paymentId === 'pay_a1')!.status).toBe('VOID');
  });

  it('ids that do not exist pay nothing', async () => {
    const t = await owed();
    expect(await t.service.markPaid(['com_nope'], '412345678901')).toEqual({ count: 0 });
  });

  it('a paid commission cannot be voided afterwards', async () => {
    const t = await owed();
    const [id] = t.ids(['pay_a1']);
    await t.service.markPaid([id], '412345678901');
    expect(await t.service.voidCommission(id, 'refunded')).toEqual({ count: 0 });
    expect(t.commissions.find((c) => c.id === id)!.status).toBe('PAID');
  });
});

describe('codes', () => {
  it('normaliseAffiliateCode keeps only what a ?ref= link can carry', () => {
    expect(normaliseAffiliateCode('Asha-123')).toBe('asha-123');
    expect(normaliseAffiliateCode('asha 123')).toBeNull();
    expect(normaliseAffiliateCode('asha;drop')).toBeNull();
    expect(normaliseAffiliateCode(null)).toBeNull();
  });
});
