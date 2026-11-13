import {
  GUMROAD_REDEEM_ERRORS,
  GumroadRedeemErrorCode,
} from '@hookpost/nestjs-libraries/services/gumroad.license';

/** Where a Gumroad buyer manages (cancels, changes) a membership. */
export const GUMROAD_LIBRARY_URL = 'https://app.gumroad.com/library';

// useT()'s t, as plan.features.ts types it.
type Translate = (key: string, fallbackOrOptions: any) => unknown;

/** The translation key of a redeem error code: gumroad_error_<code>. */
export const redeemErrorKey = (code: GumroadRedeemErrorCode) =>
  `gumroad_error_${code.toLowerCase()}`;

/**
 * What the page says when POST /billing/gumroad/redeem fails: the code's own
 * words (GUMROAD_REDEEM_ERRORS, the same English the API sends), translated.
 * Without a code: a member who is not an owner or admin (401, 402, 403), a
 * key the DTO refused (400), or anything else.
 */
export function redeemErrorMessage(
  status: number,
  body: any,
  t: Translate
): string {
  const code = body?.code as GumroadRedeemErrorCode | undefined;
  if (code && code in GUMROAD_REDEEM_ERRORS) {
    return String(t(redeemErrorKey(code), GUMROAD_REDEEM_ERRORS[code].message));
  }
  if (status === 401 || status === 402 || status === 403) {
    return String(
      t(
        'gumroad_error_not_admin',
        'Only the workspace owner or an admin can enter a license key.'
      )
    );
  }
  if (status === 400) {
    return String(
      t(redeemErrorKey('INVALID_KEY'), GUMROAD_REDEEM_ERRORS.INVALID_KEY.message)
    );
  }
  return String(
    t('gumroad_error_failed', 'Something went wrong. Please try again.')
  );
}

/** Standard, Pro. */
export const gumroadPlanName = (tier?: string | null) =>
  tier ? tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase() : '';

/** "1 November 2026", as the cancel copy dates read. */
export const gumroadDate = (at: string | Date) =>
  new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/**
 * The line shown once a key is redeemed: the plan, and its end date when the
 * membership is already cancelled.
 */
export function redeemedMessage(
  result: { tier?: string; cancelAt?: string | null },
  t: Translate
): string {
  const plan = gumroadPlanName(result.tier);
  return result.cancelAt
    ? String(
        t('gumroad_redeemed_until', {
          defaultValue: 'Your {{plan}} plan is active until {{date}}.',
          plan,
          date: gumroadDate(result.cancelAt),
          interpolation: { escapeValue: false },
        })
      )
    : String(
        t('gumroad_redeemed', {
          defaultValue: 'Your {{plan}} plan is active.',
          plan,
          interpolation: { escapeValue: false },
        })
      );
}
