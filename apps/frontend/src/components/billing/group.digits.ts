/**
 * "1,199" / "₹1,19,990" digit grouping for whole numbers, without Intl.
 *
 * Why not toLocaleString: the first Intl call on a page loads ICU's number
 * formatting data, and the pricing cards made that call while the homepage
 * hydrates (plan prices, feature counts, the yearly line). Measured in
 * headless Chrome on a fresh profile: 7-24 ms for that first call, on the
 * main thread, inside hydration's longest task. Lighthouse's mobile run
 * multiplies main-thread time by 4, so it landed in Total Blocking Time.
 *
 * Output is identical to n.toLocaleString(locale) for every safe integer
 * (group.digits.spec.ts checks both locales against Intl). Anything else (a
 * fraction, -0, NaN, a huge number) still goes to toLocaleString.
 */
export type GroupingLocale = 'en-IN' | 'en-US';

export function groupDigits(n: number, locale: GroupingLocale = 'en-US'): string {
  if (!Number.isSafeInteger(n) || Object.is(n, -0)) return n.toLocaleString(locale);
  const digits = String(Math.abs(n));
  const sign = n < 0 ? '-' : '';
  if (locale === 'en-IN' && digits.length > 3) {
    // Indian grouping: the last three digits, then pairs (1,19,990).
    const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
    return `${sign}${head},${digits.slice(-3)}`;
  }
  return sign + digits.replace(/\B(?=(\d{3})+$)/g, ',');
}
