import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PURCHASABLE_TIERS } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// Derived, never retyped. This used to hardcode
// ['STANDARD','PRO','TEAM','ULTIMATE'], so retiring TEAM and ULTIMATE from the
// UI left the API still accepting them - a POST with billing:'TEAM' would have
// subscribed at Rs1,499 to a plan we no longer sell. Hiding a plan in the
// frontend is not retiring it.
const SUBSCRIBABLE = PURCHASABLE_TIERS.filter((t) => t !== 'FREE');

export class BillingSubscribeDto {
  @IsIn(['MONTHLY', 'YEARLY'])
  period: 'MONTHLY' | 'YEARLY';

  @IsIn(SUBSCRIBABLE)
  billing: (typeof SUBSCRIBABLE)[number];

  // Never picks the currency: the server decides it
  // (RazorpayService.resolveCheckoutCurrency). Only tabs opened before 12 Oct
  // 2026 still send it; when it differs from the server's currency, checkout
  // answers 409 CURRENCY_CHANGED so the stale page reloads.
  @IsOptional()
  @IsIn(['INR', 'USD'])
  currency?: 'INR' | 'USD';

  utm: string;

  dub: string;

  datafast_session_id: string;
  datafast_visitor_id: string;

  // Website coupon code, applied only when a new subscription is created.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  coupon?: string;

  // How the customer said they will pay, which picks the first-month offer
  // put on the subscription (first.month.offer.ts): Razorpay takes one offer
  // per subscription and each offer is for one method. Only read when the
  // checkout gets the offer; it restricts nothing at checkout.
  @IsOptional()
  @IsIn(['upi', 'card'])
  payWith?: 'upi' | 'card';

  // The browser's IANA timezone, as the page also sends it to
  // /billing/pricing-context, so checkout decides the currency on the same
  // facts the page showed prices on (billing.currency.ts). Only consulted
  // when the workspace's creator has no signup country on file.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

