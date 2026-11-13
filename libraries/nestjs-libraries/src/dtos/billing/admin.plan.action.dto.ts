import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** How long a reason may be; the same cap the refund reason uses. */
export const PLAN_ACTION_REASON_MAX = 200;
/** Long enough to be a sentence. "oops" explains nothing a year from now. */
export const PLAN_ACTION_REASON_MIN = 10;

export class AdminEndPlanDto {
  @IsString()
  @MinLength(1)
  organizationId: string;

  /** Why the plan is being ended; kept in PlanActionAudit, shown to nobody else. */
  @IsString()
  @MinLength(PLAN_ACTION_REASON_MIN, {
    message: `reason must say what happened, in at least ${PLAN_ACTION_REASON_MIN} characters`,
  })
  @MaxLength(PLAN_ACTION_REASON_MAX)
  reason: string;

  /** Which correction email the customer gets; NONE sends them nothing. */
  @IsString()
  @IsIn(['PLAN_CORRECTED_ENDED', 'REFUND_ENDED_PLAN', 'CHARGE_STOPPED', 'NONE'])
  correction: string;

  /** Tick for an internal or test workspace: the owner is still alerted. */
  @IsOptional()
  @IsBoolean()
  skipCustomerEmail?: boolean;

  /** For REFUND_ENDED_PLAN: the date of the refund we failed to act on. */
  @IsOptional()
  @IsDateString()
  refundedOn?: string;
}

export class AdminRestorePlanDto {
  @IsString()
  @MinLength(1)
  organizationId: string;

  @IsString()
  @MinLength(PLAN_ACTION_REASON_MIN, {
    message: `reason must say what happened, in at least ${PLAN_ACTION_REASON_MIN} characters`,
  })
  @MaxLength(PLAN_ACTION_REASON_MAX)
  reason: string;

  @IsString()
  @IsIn(['STANDARD', 'TEAM', 'PRO', 'ULTIMATE', 'HOOKPOST'])
  tier: string;

  @IsString()
  @IsIn(['MONTHLY', 'YEARLY'])
  period: string;

  @IsOptional()
  @IsBoolean()
  skipCustomerEmail?: boolean;

  /** ISO date: when a gift plan ends (Free Pro until <date>). */
  @IsOptional()
  @IsDateString()
  until?: string;
}
