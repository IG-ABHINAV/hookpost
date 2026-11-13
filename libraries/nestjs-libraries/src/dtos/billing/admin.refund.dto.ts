import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  BULK_REFUND_MAX,
  PAYMENT_ID_RE,
} from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';

export class AdminRefundDto {
  @IsString()
  @Matches(PAYMENT_ID_RE, { message: 'paymentId must be a Razorpay payment id (pay_...)' })
  paymentId: string;

  /**
   * Minor units (paise, cents). Omit for the default: the payment less
   * Razorpay's fee (GST included), or everything left with `full`.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  /** Required to refund a payment that is not Hookpost's. */
  @IsOptional()
  @IsBoolean()
  confirmForeign?: boolean;

  /** Refund without deducting the fee: only for our mistakes. */
  @IsOptional()
  @IsBoolean()
  full?: boolean;

  /** A second charge for something already paid for: the customer is told so. */
  @IsOptional()
  @IsBoolean()
  duplicate?: boolean;
}

export class AdminBulkRefundDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_REFUND_MAX)
  @IsString({ each: true })
  @Matches(PAYMENT_ID_RE, {
    each: true,
    message: 'every payment id must be a Razorpay payment id (pay_...)',
  })
  paymentIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  confirmForeign?: boolean;

  /** Refund every payment without deducting the fee: only for our mistakes. */
  @IsOptional()
  @IsBoolean()
  full?: boolean;
}
