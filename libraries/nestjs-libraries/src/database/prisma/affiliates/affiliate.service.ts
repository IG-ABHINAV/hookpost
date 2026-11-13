import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import dayjs from 'dayjs';
import { AffiliateRepository } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository';

import {
  AFFILIATE_COMMISSION_PERCENT,
  AFFILIATE_DEFAULT_COMMISSION_MONTHS,
  AFFILIATE_MAX_COMMISSION_MONTHS,
  AFFILIATE_MAX_COMMISSION_PERCENT,
  AFFILIATE_COUPON_PERCENT,
  commissionWindowOpen,
  payoutDue,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';

/** How long after a workspace is created a referral can still be attached. */
const ATTRIBUTION_WINDOW_DAYS = 7;
/**
 * Every affiliate code is also a checkout coupon for their audience, so a
 * buyer who types it (or arrives on their link, which pre-fills it) gets this
 * much off and the affiliate is credited even if the cookie was lost. The
 * programme's terms live in affiliate.terms.ts.
 */
export { AFFILIATE_COUPON_PERCENT };
/** Codes are lowercase letters, digits and dashes, as typed into a ?ref= link. */
const CODE_RE = /^[a-z0-9-]{3,40}$/;

export const normaliseAffiliateCode = (raw?: string | null) => {
  const code = (raw || '').trim().toLowerCase();
  return CODE_RE.test(code) ? code : null;
};

/**
 * A bank transfer's reference as typed into mark-paid: a UPI or IMPS RRN (12
 * digits), a NEFT UTR (16) or an RTGS UTR (22), letters and digits only.
 * Spaces are dropped and letters upper-cased. Null when it is not one.
 */
export const normaliseUtr = (raw?: string | null) => {
  const utr = (raw || '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{12,22}$/.test(utr) && /\d/.test(utr) ? utr : null;
};

type Money = Record<string, number>;

/** The deal an affiliate has now, to fix on a referral made now. */
const termsOf = (a: { commissionPercent: number; commissionMonths: number }) => ({
  commissionPercent: a.commissionPercent,
  commissionMonths: a.commissionMonths,
});
const add = (m: Money, currency: string, v: number) => {
  m[currency] = (m[currency] || 0) + v;
  return m;
};

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(private _affiliateRepository: AffiliateRepository) {}

  /**
   * Join the programme. Idempotent: an existing affiliate is returned as is.
   * The code is readable (first name + 3 digits) so it survives being said
   * out loud in a video or typed from a screenshot.
   */
  async join(user: User, org: Organization, payoutDetails?: string) {
    const existing = await this._affiliateRepository.findByUser(user.id);
    if (existing) return existing;

    const base =
      (user.name || user.email.split('@')[0])
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 16) || 'hp';

    for (let attempt = 0; attempt < 20; attempt++) {
      const code = `${base}${Math.floor(100 + Math.random() * 900)}`;
      // The code doubles as a coupon, so it must be free in both tables.
      if (
        (await this._affiliateRepository.findByCode(code)) ||
        (await this._affiliateRepository.findCoupon(code))
      ) {
        continue;
      }
      const affiliate = await this._affiliateRepository.create({
        userId: user.id,
        organizationId: org.id,
        code,
        name: user.name || user.email.split('@')[0],
        email: user.email,
        payoutDetails: payoutDetails?.trim().slice(0, 500) || null,
        // Written out rather than left to the column defaults, which have
        // differed between production and the schema. The standard deal
        // since 3 Nov 2026: 30% for 12 months (affiliate.terms.ts).
        commissionPercent: AFFILIATE_COMMISSION_PERCENT,
        commissionMonths: AFFILIATE_DEFAULT_COMMISSION_MONTHS,
      });
      await this._affiliateRepository.createCoupon(
        code,
        AFFILIATE_COUPON_PERCENT,
        affiliate.id
      );
      return affiliate;
    }
    throw new Error('Could not allocate an affiliate code');
  }

  /**
   * The affiliate deleted their account: their code stops crediting anyone.
   * `active` gates attribution, commissions and the code's checkout discount
   * (validateCoupon), so this one flag covers all three. Commissions already
   * recorded stay for the payout and tax records.
   */
  async deactivateForDeletedAccount(userId: string) {
    const affiliate = await this._affiliateRepository.findByUser(userId);
    if (!affiliate || !affiliate.active) {
      return false;
    }
    await this._affiliateRepository.setActive(affiliate.id, false);
    this.logger.log(
      `Affiliate ${affiliate.id} deactivated: account ${userId} deleted`
    );
    return true;
  }

  updatePayout(userId: string, payoutDetails: string) {
    return this._affiliateRepository.updatePayout(
      userId,
      payoutDetails.trim().slice(0, 500) || null
    );
  }

  /** The signed-in affiliate's own dashboard. Null when they have not joined. */
  async getMine(userId: string) {
    const affiliate = await this._affiliateRepository.findByUser(userId);
    if (!affiliate) return null;

    const [referrals, all, recent] = await Promise.all([
      this._affiliateRepository.countReferrals(affiliate.id),
      this._affiliateRepository.allCommissions(affiliate.id),
      this._affiliateRepository.listCommissions(affiliate.id, 25),
    ]);

    const pending: Money = {};
    const paid: Money = {};
    const payingCustomers = new Set<string>();
    for (const c of all) {
      if (c.status === 'VOID') continue;
      payingCustomers.add(c.organizationId);
      add(c.status === 'PAID' ? paid : pending, c.currency, c.commission);
    }

    return {
      code: affiliate.code,
      couponPercent: AFFILIATE_COUPON_PERCENT,
      active: affiliate.active,
      commissionPercent: affiliate.commissionPercent,
      commissionMonths: affiliate.commissionMonths,
      payoutDetails: affiliate.payoutDetails,
      referrals,
      payingCustomers: payingCustomers.size,
      pending,
      paid,
      recent: recent.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        amount: c.amount,
        commission: c.commission,
        currency: c.currency,
        status: c.status,
      })),
    };
  }

  /**
   * Attach a new workspace to the affiliate whose link brought it in. Called
   * from GET /user/self, which every signed-in page load hits, so it covers
   * every way of registering (email, Google, One Tap, OAuth) from one place.
   * Only workspaces created in the last ATTRIBUTION_WINDOW_DAYS qualify, so an
   * existing customer who later clicks someone's link is never re-attributed.
   * Never throws.
   */
  async attribute(rawCode: string | undefined, org: Organization, user: User) {
    try {
      const code = normaliseAffiliateCode(rawCode);
      if (!code || !org?.id) return;
      if (dayjs().diff(dayjs(org.createdAt), 'day') > ATTRIBUTION_WINDOW_DAYS) {
        return;
      }
      if (await this._affiliateRepository.findReferral(org.id)) return;

      const affiliate = await this._affiliateRepository.findByCode(code);
      if (!affiliate || !affiliate.active) return;
      // No self-referrals: not their own workspace, not a second workspace
      // they created themselves.
      if (affiliate.organizationId === org.id || affiliate.userId === user.id) {
        return;
      }

      await this._affiliateRepository.createReferral(
        affiliate.id,
        org.id,
        termsOf(affiliate)
      );
      this.logger.log(`Workspace ${org.id} referred by affiliate ${code}`);
    } catch (e) {
      // A unique-index race (two tabs loading at once) lands here too.
      this.logger.warn(`Affiliate attribution skipped: ${(e as Error).message}`);
    }
  }

  /**
   * A buyer used an affiliate's code as a coupon at checkout. That is an
   * explicit choice, so unlike the cookie it has no workspace-age limit, but
   * it still never overrides an existing referral and never pays an affiliate
   * for their own workspace. `memberUserIds` are the workspace's users.
   * Called from the subscription webhook before the first charge, so the
   * commission on that charge is recorded. Never throws.
   */
  async attributeByCoupon(
    rawCode: string | undefined,
    orgId: string | undefined,
    memberUserIds: string[]
  ) {
    try {
      const code = normaliseAffiliateCode(rawCode);
      if (!code || !orgId) return;
      if (await this._affiliateRepository.findReferral(orgId)) return;

      const affiliate = await this._affiliateRepository.findByCode(code);
      if (!affiliate || !affiliate.active) return;
      if (
        affiliate.organizationId === orgId ||
        memberUserIds.includes(affiliate.userId)
      ) {
        return;
      }

      await this._affiliateRepository.createReferral(
        affiliate.id,
        orgId,
        termsOf(affiliate)
      );
      this.logger.log(`Workspace ${orgId} referred by coupon ${code}`);
    } catch (e) {
      this.logger.warn(
        `Affiliate coupon attribution skipped: ${(e as Error).message}`
      );
    }
  }

  /**
   * Record the commission on one captured Razorpay payment. Idempotent on the
   * payment id, because Razorpay retries webhooks. Never throws: a failure here
   * must not make the charge webhook fail and re-run provisioning.
   *
   * Every captured charge of the referred workspace earns it, monthly and
   * yearly alike, on the terms fixed when the customer was referred (the
   * referral's own percent and window; the affiliate's for older rows). A
   * window of 0 has no end while the affiliate is active.
   */
  async recordCommission(orgId: string | undefined, payment: any) {
    try {
      if (!orgId || !payment?.id || !(payment.amount > 0)) return;
      if (payment.status && payment.status !== 'captured') return;

      const referral = await this._affiliateRepository.findReferral(orgId);
      if (!referral?.affiliate?.active) return;

      const { affiliate } = referral;
      const percent = referral.commissionPercent ?? affiliate.commissionPercent;
      const months = referral.commissionMonths ?? affiliate.commissionMonths;
      if (!commissionWindowOpen(months, referral.createdAt)) {
        return;
      }

      if (await this._affiliateRepository.findCommissionByPayment(payment.id)) {
        return;
      }

      await this._affiliateRepository.createCommission({
        affiliateId: affiliate.id,
        organizationId: orgId,
        paymentId: payment.id,
        amount: payment.amount,
        commission: Math.round((payment.amount * percent) / 100),
        currency: payment.currency || 'INR',
      });
    } catch (e) {
      this.logger.error(
        `Affiliate commission for payment ${payment?.id} failed: ${(e as Error).message}`
      );
    }
  }

  // --- Admin -----------------------------------------------------------------

  async adminOverview() {
    const [affiliates, pending] = await Promise.all([
      this._affiliateRepository.listAffiliates(),
      this._affiliateRepository.listPendingCommissions(),
    ]);
    return {
      affiliates: affiliates.map((a) => {
        const pendingMoney: Money = {};
        const paidMoney: Money = {};
        for (const c of a.commissions) {
          if (c.status === 'PENDING') add(pendingMoney, c.currency, c.commission);
          if (c.status === 'PAID') add(paidMoney, c.currency, c.commission);
        }
        return {
          id: a.id,
          name: a.name,
          email: a.email,
          code: a.code,
          active: a.active,
          payoutDetails: a.payoutDetails,
          commissionPercent: a.commissionPercent,
          commissionMonths: a.commissionMonths,
          referrals: a._count.referrals,
          pending: pendingMoney,
          paid: paidMoney,
          payoutDue: payoutDue(pendingMoney),
          createdAt: a.createdAt,
        };
      }),
      pendingCommissions: pending,
    };
  }

  /**
   * Record one bank transfer to one affiliate. The transfer's UTR is
   * required, the commissions must all be that affiliate's, and a UTR
   * already recorded for someone else is refused: one transfer pays one
   * person. Only PENDING rows change, so a second click changes nothing.
   */
  async markPaid(ids: string[], note?: string) {
    const utr = normaliseUtr(note);
    if (!utr) {
      throw new BadRequestException(
        'Enter the transfer reference: a UTR or UPI reference, 12 to 22 letters and digits.'
      );
    }
    const rows = await this._affiliateRepository.findCommissionsByIds([
      ...new Set(ids),
    ]);
    const pending = rows.filter((r) => r.status === 'PENDING');
    if (!pending.length) return { count: 0 };
    const affiliateIds = new Set(pending.map((r) => r.affiliateId));
    if (affiliateIds.size > 1) {
      throw new BadRequestException(
        'One transfer pays one affiliate: select one affiliate\'s commissions.'
      );
    }
    const used = await this._affiliateRepository.findPaidByNote(utr);
    if (used && !affiliateIds.has(used.affiliateId)) {
      throw new BadRequestException(
        'This transfer reference is already recorded for another affiliate.'
      );
    }
    return this._affiliateRepository.markPaid(
      pending.map((r) => r.id),
      utr
    );
  }

  /**
   * A refund of `paymentId` was processed, or a chargeback on it was lost:
   * the commission on it is void if it has not been paid yet. One already
   * paid is left for the owner to recover by hand, and logged. Idempotent;
   * never throws, so it cannot fail the webhook.
   */
  async voidForRefund(
    paymentId: string | undefined,
    refundId?: string,
    reason: 'refund' | 'chargeback' = 'refund'
  ) {
    try {
      if (!paymentId) return;
      const { count } = await this._affiliateRepository.voidCommissionByPayment(
        paymentId,
        `${reason} ${refundId || ''}`.trim()
      );
      if (count) {
        this.logger.log(`Affiliate commission on ${paymentId} void: ${reason}`);
        return;
      }
      const row = await this._affiliateRepository.findCommissionByPayment(
        paymentId
      );
      if (row?.status === 'PAID') {
        this.logger.warn(
          `Payment ${paymentId} had a ${reason} after its affiliate commission ${row.id} was paid: recover it by hand`
        );
      }
    } catch (e) {
      this.logger.error(
        `Voiding the affiliate commission on ${paymentId} failed: ${(e as Error).message}`
      );
    }
  }

  voidCommission(id: string, note?: string) {
    return this._affiliateRepository.voidCommission(
      id,
      note?.slice(0, 500) || null
    );
  }

  /**
   * An admin sets an affiliate's deal: a percent, a duration in months, or 0
   * for "while partner active". It applies to customers they refer from now
   * on; customers already referred keep the terms they were referred under.
   */
  async setTerms(
    id: string,
    terms: { commissionPercent?: number; commissionMonths?: number }
  ) {
    const data: { commissionPercent?: number; commissionMonths?: number } = {};
    if (terms.commissionPercent !== undefined) {
      const p = terms.commissionPercent;
      if (!Number.isInteger(p) || p < 1 || p > AFFILIATE_MAX_COMMISSION_PERCENT) {
        throw new BadRequestException(
          `Commission must be a whole percent from 1 to ${AFFILIATE_MAX_COMMISSION_PERCENT}.`
        );
      }
      data.commissionPercent = p;
    }
    if (terms.commissionMonths !== undefined) {
      const m = terms.commissionMonths;
      if (!Number.isInteger(m) || m < 0 || m > AFFILIATE_MAX_COMMISSION_MONTHS) {
        throw new BadRequestException(
          `Duration must be 0 (while partner active) or 1 to ${AFFILIATE_MAX_COMMISSION_MONTHS} months.`
        );
      }
      data.commissionMonths = m;
    }
    if (!Object.keys(data).length) {
      throw new BadRequestException('Nothing to change.');
    }
    if (!(await this._affiliateRepository.findById(id))) {
      throw new BadRequestException('No such affiliate.');
    }
    const updated = await this._affiliateRepository.setTerms(id, data);
    this.logger.log(
      `Affiliate ${id} terms: ${updated.commissionPercent}% / ${updated.commissionMonths} months`
    );
    return {
      id: updated.id,
      commissionPercent: updated.commissionPercent,
      commissionMonths: updated.commissionMonths,
    };
  }

  setActive(id: string, active: boolean) {
    return this._affiliateRepository.setActive(id, active);
  }
}
