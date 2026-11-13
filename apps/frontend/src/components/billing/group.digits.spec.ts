/**
 *   pnpm exec jest -c apps/frontend/jest.config.ts group.digits
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupDigits } from './group.digits';

const LOCALES = ['en-IN', 'en-US'] as const;

describe('groupDigits', () => {
  it.each(LOCALES)('matches toLocaleString(%s) for whole numbers', (locale) => {
    const values = [
      0, 1, 9, 10, 99, 100, 599, 999, 1000, 1199, 5990, 9999, 10000, 11990,
      19990, 99999, 100000, 123456, 999999, 1000000, 1234567, 12345678,
      123456789, 1234567890, Number.MAX_SAFE_INTEGER, -1, -599, -1234,
      -123456, -1234567, Number.MIN_SAFE_INTEGER,
    ];
    // Plus every power-of-ten boundary and a deterministic spread.
    for (let p = 1; p <= 15; p++) values.push(10 ** p - 1, 10 ** p, 10 ** p + 1);
    let x = 7;
    for (let i = 0; i < 2000; i++) {
      x = (x * 48271) % 2147483647;
      values.push(x % 10 ** ((i % 13) + 1));
    }
    for (const v of values) {
      expect(groupDigits(v, locale)).toBe(v.toLocaleString(locale));
    }
  });

  it('defaults to en-US', () => {
    expect(groupDigits(1234567)).toBe('1,234,567');
  });

  it('groups rupees the Indian way', () => {
    expect(groupDigits(1199, 'en-IN')).toBe('1,199');
    expect(groupDigits(119990, 'en-IN')).toBe('1,19,990');
    expect(groupDigits(12345678, 'en-IN')).toBe('1,23,45,678');
  });

  it.each(LOCALES)('hands anything but a safe integer to toLocaleString (%s)', (locale) => {
    for (const v of [1.5, 1199.99, -0, NaN, Infinity, 2 ** 60]) {
      expect(groupDigits(v, locale)).toBe(v.toLocaleString(locale));
    }
  });
});

// The homepage's pricing cards render these while the page hydrates. A
// toLocaleString there brings back the ICU load groupDigits exists to avoid.
describe('no Intl number formatting on the homepage hydration path', () => {
  const files = [
    '../../app/(landing)/PricingPlans.client.tsx',
    './plan.features.ts',
    './yearly.copy.ts',
  ];
  it.each(files)('%s formats numbers with groupDigits', (file) => {
    const src = readFileSync(join(__dirname, file), 'utf8')
      // comments may mention it
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\.toLocaleString\(/);
    expect(src).not.toMatch(/\bIntl\./);
  });
});
