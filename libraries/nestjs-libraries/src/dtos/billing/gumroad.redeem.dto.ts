import { IsString, MaxLength } from 'class-validator';

/**
 * POST /billing/gumroad/redeem: the license key from the Gumroad receipt.
 * Its shape is checked by GumroadLicenseService (normalizeLicenseKey), which
 * answers INVALID_KEY in the same words for a typo and an unknown key.
 */
export class GumroadRedeemDto {
  @IsString()
  @MaxLength(100)
  licenseKey: string;
}
