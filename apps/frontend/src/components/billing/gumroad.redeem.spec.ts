/**
 * "Bought on Gumroad? Enter your license key" (gumroad.redeem.tsx): what the
 * page says for each answer of POST /billing/gumroad/redeem, and that every
 * string it shows is in the English locale, in the same words as the API.
 *   pnpm exec jest -c apps/frontend/jest.config.ts gumroad.redeem
 */
import * as fs from 'fs';
import * as path from 'path';
import { GUMROAD_REDEEM_ERRORS } from '@hookpost/nestjs-libraries/services/gumroad.license';
import {
  redeemedMessage,
  redeemErrorKey,
  redeemErrorMessage,
} from './gumroad.redeem.copy';

const en = require('../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json');

/** A t() that answers from the English locale, falling back like i18next. */
const t = (key: string, fallback: any) => {
  const options = typeof fallback === 'string' ? { defaultValue: fallback } : fallback;
  const template: string = en[key] ?? options.defaultValue;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ''));
};

/** t('key', '...') literals in a file, as billing.translations.spec.ts reads them. */
function keysWithDefaults(file: string) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const found: Array<[string, string]> = [];
  const re = /\bt\(\s*'([a-z0-9_]+)'\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    found.push([m[1], m[2].slice(1, -1).replace(/\\(.)/g, '$1')]);
  }
  return found;
}

/** t('key', { defaultValue: '...' }) literals. */
function keysWithDefaultValue(file: string) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const found: Array<[string, string]> = [];
  const re = /\bt\(\s*'([a-z0-9_]+)'\s*,\s*\{\s*defaultValue:\s*(?:\n\s*)?('(?:[^'\\]|\\.)*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    found.push([m[1], m[2].slice(1, -1).replace(/\\(.)/g, '$1')]);
  }
  return found;
}

describe('English locale', () => {
  it('has every string of the redeem field and the Gumroad plan panel, word for word', () => {
    const used = [
      ...keysWithDefaults('gumroad.redeem.tsx'),
      ...keysWithDefaults('gumroad.redeem.copy.ts'),
      ...keysWithDefaultValue('gumroad.redeem.tsx'),
      ...keysWithDefaultValue('gumroad.redeem.copy.ts'),
    ];
    expect(used.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        'gumroad_redeem_link',
        'gumroad_redeem_button',
        'gumroad_plan_title',
        'gumroad_redeemed',
        'gumroad_redeemed_until',
        'gumroad_error_not_admin',
      ])
    );
    for (const [key, fallback] of used) {
      expect([key, en[key]]).toEqual([key, fallback]);
    }
  });

  it('has every redeem error the API can send, in the API’s own words', () => {
    for (const [code, { message }] of Object.entries(GUMROAD_REDEEM_ERRORS)) {
      const key = redeemErrorKey(code as keyof typeof GUMROAD_REDEEM_ERRORS);
      expect([key, en[key]]).toEqual([key, message]);
    }
  });
});

describe('what the field says', () => {
  it('a known code: its own message', () => {
    expect(redeemErrorMessage(409, { code: 'LICENSE_IN_USE', message: 'x' }, t)).toBe(
      GUMROAD_REDEEM_ERRORS.LICENSE_IN_USE.message
    );
    expect(redeemErrorMessage(400, { code: 'NOT_A_SUBSCRIPTION' }, t)).toContain('one-time payment');
    expect(redeemErrorMessage(429, { code: 'RATE_LIMITED' }, t)).toBe(
      'Too many attempts. Try again in a few minutes.'
    );
  });

  it('a member who is not an owner or admin', () => {
    for (const status of [401, 402, 403]) {
      expect(redeemErrorMessage(status, { message: 'Forbidden' }, t)).toBe(
        'Only the workspace owner or an admin can enter a license key.'
      );
    }
  });

  it('a key the API refused before Gumroad (validation): the invalid-key words', () => {
    expect(redeemErrorMessage(400, { message: ['licenseKey must be shorter'] }, t)).toBe(
      GUMROAD_REDEEM_ERRORS.INVALID_KEY.message
    );
  });

  it('no answer at all', () => {
    expect(redeemErrorMessage(0, null, t)).toBe('Something went wrong. Please try again.');
    expect(redeemErrorMessage(500, { code: 'SOMETHING_NEW' }, t)).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('redeemed: the plan, and the end date of a cancelled membership', () => {
    expect(redeemedMessage({ tier: 'PRO', cancelAt: null }, t)).toBe('Your Pro plan is active.');
    expect(
      redeemedMessage({ tier: 'STANDARD', cancelAt: '2026-11-01T10:00:00.000Z' }, t)
    ).toBe('Your Standard plan is active until 1 November 2026.');
  });
});
