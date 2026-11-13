/**
 * The refund policy (owner, 29 Oct 2026; refund-terms.ts) as the customer
 * reads it: /terms, /refund-policy, the home page FAQ and the billing FAQ say
 * the same thing, and no page anywhere offers a money-back guarantee or a
 * self-serve refund.
 */
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { render } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => React.createElement('a', { href, ...rest }, children),
}));
jest.mock('@hookpost/frontend/app/(landing)/site-nav', () => ({ SiteNav: () => null }));

import TermsPage from '@hookpost/frontend/app/(landing)/terms/page';
import RefundPolicyPage from '@hookpost/frontend/app/(landing)/refund-policy/page';
import { FAQ_DATA } from '@hookpost/frontend/app/(landing)/LandingFaq';
import {
  NEVER_PROMISED,
  REFUND_FAQ,
  REFUND_ON_REQUEST,
  REFUND_OUR_MISTAKE,
} from '@hookpost/frontend/app/(landing)/refund-terms';

const text = (page: any) => {
  const { container, unmount } = render(React.createElement(page));
  container.querySelectorAll('script').forEach((s) => s.remove());
  const out = (container.textContent || '').replace(/\s+/g, ' ');
  unmount();
  return out;
};

describe('the refund rule', () => {
  it('says: only on request, at our discretion, less the gateway fee and its GST; no money-back guarantee', () => {
    expect(REFUND_ON_REQUEST).toMatch(/not refunded automatically/);
    expect(REFUND_ON_REQUEST).toMatch(/no money-back guarantee/);
    expect(REFUND_ON_REQUEST).toMatch(/email support@hookstep\.in/);
    expect(REFUND_ON_REQUEST).toMatch(/at our discretion/);
    expect(REFUND_ON_REQUEST).toMatch(/less the payment gateway's fee .* and the GST on that fee/);
    // Razorpay's fee is about 2% on Indian methods and up to 3% on a card
    // issued outside India (razorpay.com/pricing), and the refund deducts
    // the real one (refunds.service.ts refundQuote).
    expect(REFUND_ON_REQUEST).toMatch(/about 2%, or about 3% on a card issued outside India/);
    expect(REFUND_OUR_MISTAKE).toMatch(/charged twice for the same period, or charged after cancelling, .* refund it in full, fee included/);
  });

  it('/terms states it word for word', () => {
    const terms = text(TermsPage);
    expect(terms).toContain(REFUND_ON_REQUEST);
    expect(terms).toContain(REFUND_OUR_MISTAKE);
    expect(terms).not.toMatch(/non-refundable once an active billing cycle/);
  });

  it('/refund-policy states it word for word', () => {
    const page = text(RefundPolicyPage);
    expect(page).toContain(REFUND_ON_REQUEST);
    expect(page).toContain(REFUND_OUR_MISTAKE);
  });

  it('the home page FAQ (structured data) and the billing FAQ carry the same answer', () => {
    expect(FAQ_DATA).toContainEqual(REFUND_FAQ);
    const billingFaq = readFileSync(
      join(__dirname, '../../components/billing/faq.component.tsx'),
      'utf8'
    );
    expect(billingFaq).toMatch(/t\('faq_refund_on_request', REFUND_FAQ\.a\)/);
  });

  it('no page, component or email offers a money-back guarantee or a self-serve refund', () => {
    const roots = [
      join(__dirname, '..'),
      join(__dirname, '../../components'),
      join(__dirname, '../../../../../libraries/nestjs-libraries/src/emails'),
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules') walk(path);
        } else if (/\.(tsx?|html)$/.test(name) && !/\.spec\./.test(name) && !/refund-terms\.ts$/.test(name)) {
          files.push(path);
        }
      }
    };
    roots.forEach(walk);
    const offenders = files.flatMap((f) => {
      const body = readFileSync(f, 'utf8');
      return NEVER_PROMISED.filter((re) => re.test(body)).map((re) => `${f}: ${re}`);
    });
    expect(offenders).toEqual([]);
  });
});
