import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /billing/order: open a one-time checkout for one month of the plan
 * (one.time.plan.ts). No amount, plan or currency: the server sets all three.
 * `tz` is the browser's timezone, one of the location signals for the
 * currency (billing.currency.ts currencyCountry).
 */
export class BillingOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

/** POST /billing/order/verify: Razorpay Checkout's handshake for an order. */
export class BillingOrderVerifyDto {
  @IsString()
  @Matches(/^order_[A-Za-z0-9]{1,40}$/)
  razorpay_order_id: string;

  @IsString()
  @Matches(/^pay_[A-Za-z0-9]{1,40}$/)
  razorpay_payment_id: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  razorpay_signature: string;
}

/** POST /billing/order/saved-card/remove: the Razorpay token to delete. */
export class BillingSavedCardRemoveDto {
  @IsString()
  @Matches(/^token_[A-Za-z0-9]{1,40}$/)
  tokenId: string;
}
