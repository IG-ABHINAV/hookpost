/**
 * Offline check of the pricing tables and the server-side currency rules.
 * Pure: no network, no database, no .env. Run with:
 *   bun scripts/pricing/test-dynamic-pricing.ts
 *
 * The server decides the currency
 * (libraries/nestjs-libraries/src/services/billing.currency.ts): rupees for
 * everyone while USD_CHECKOUT is off, which is how it ships. The jest specs
 * next to that file cover the same rules in more depth.
 */

import {
  getPricing,
  getCurrencyConfig,
  pricingINR,
  pricingUSD,
  CURRENCY_CONFIG,
} from '../../libraries/nestjs-libraries/src/database/prisma/subscriptions/pricing';
import {
  buildPricingContext,
  currencyCountry,
  decideCheckoutCurrency,
  entitlementLocks,
  resolveRegion,
  usdCheckoutMode,
} from '../../libraries/nestjs-libraries/src/services/billing.currency';

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passed++;
  console.log(`  [PASS] ${message}`);
}

const LUT = 'AD0910260000000';
const quiet = () => undefined;

/** What a signed-out visitor is shown and charged under this environment. */
const ctx = (headers: Record<string, string>, tz: string, env: Record<string, string> = {}) =>
  buildPricingContext({
    decision: decideCheckoutCurrency({
      subject: {
        country: currencyCountry({ requestCountry: resolveRegion(headers, tz).country, tz }),
      },
      env,
      warn: quiet,
    }),
    region: resolveRegion(headers, tz),
  });

console.log('--> 1. Region signals (cf-ipcountry on the backend, plus the browser timezone)');
assert(resolveRegion({ 'cf-ipcountry': 'IN' }, 'America/New_York').ipSaysIndia, 'Indian IP is India');
assert(resolveRegion({ 'cf-ipcountry': 'US' }, 'Asia/Kolkata').tzSaysIndia, 'Kolkata timezone is India');
assert(resolveRegion({ 'cf-ipcountry': 'US' }, 'Asia/Calcutta').tzSaysIndia, 'Calcutta timezone is India');
assert(resolveRegion({ 'cf-ipcountry': 'XX' }, '').country === null, 'XX is no country');
assert(resolveRegion({ 'cf-ipcountry': 'T1' }, '').country === null, 'T1 (Tor) is no country');
assert(resolveRegion({ 'x-country': 'IN' }, '').country === null, 'x-country is never read');

console.log('\n--> 2. With USD_CHECKOUT off (how it ships) everyone is shown and charged rupees');
for (const [country, tz] of [
  ['IN', 'Asia/Kolkata'],
  ['IN', 'America/New_York'],
  ['US', 'Asia/Kolkata'],
  ['US', 'America/New_York'],
  ['GB', 'Europe/London'],
  ['DE', 'Europe/Berlin'],
  ['XX', 'UTC'],
]) {
  const c = ctx({ 'cf-ipcountry': country }, tz);
  assert(
    c.chargeCurrency === 'INR' && c.displayCurrency === 'INR' && c.prices.STANDARD.month === 599,
    `${country} / ${tz}: shown and charged ₹599`
  );
}

console.log('\n--> 3. The USD switch');
assert(usdCheckoutMode({}, quiet) === 'off', 'unset is off');
assert(usdCheckoutMode({ USD_CHECKOUT: 'yes' }, quiet) === 'off', 'anything unknown is off');
assert(usdCheckoutMode({ USD_CHECKOUT: ' On ' }, quiet) === 'on', 'on is on');
const on = { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT };
assert(ctx({ 'cf-ipcountry': 'US' }, 'America/New_York', on).chargeCurrency === 'USD', 'on + LUT: a US visitor is charged USD');
assert(ctx({ 'cf-ipcountry': 'US' }, 'America/New_York', on).prices.STANDARD.month === 19, '... and shown $19, the price charged');
assert(ctx({ 'cf-ipcountry': 'IN' }, 'Asia/Kolkata', on).chargeCurrency === 'INR', 'on + LUT: India stays on rupees');
assert(ctx({ 'cf-ipcountry': 'US' }, 'Asia/Kolkata', on).chargeCurrency === 'INR', 'a Kolkata clock behind a foreign IP stays on rupees');
assert(
  ctx({ 'cf-ipcountry': 'US' }, 'America/New_York', { USD_CHECKOUT: 'on' }).chargeCurrency === 'INR',
  'on without an LUT charges rupees'
);
assert(
  ctx({ 'cf-ipcountry': 'DE' }, 'Europe/Berlin', { ...on, USD_EXCLUDED_COUNTRIES: 'EU27' }).chargeCurrency === 'INR',
  'an excluded country is charged rupees'
);
assert(
  ctx({ 'cf-ipcountry': 'US' }, 'America/New_York', { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co' }).chargeCurrency === 'INR',
  'allowlist mode never moves a signed-out visitor'
);

console.log('\n--> 4. The currency lock');
const live = { identifier: 'sub_x', isLifetime: false, deletedAt: null, cancelAt: null };
assert(entitlementLocks({ row: live, remoteStatus: 'active' }), 'active locks');
assert(entitlementLocks({ row: live, remoteStatus: 'authenticated' }), 'authenticated locks');
assert(!entitlementLocks({ row: live, remoteStatus: 'halted' }), 'halted does not lock');
assert(!entitlementLocks({ row: live, remoteStatus: 'pending' }), 'pending does not lock');
assert(
  decideCheckoutCurrency({ lockedCurrency: 'USD', env: {}, warn: quiet }).chargeCurrency === 'USD',
  'a live USD plan keeps dollars'
);
assert(
  decideCheckoutCurrency({ lockedCurrency: 'INR', subject: { country: 'US' }, env: on, warn: quiet }).chargeCurrency === 'INR',
  'a live INR plan stays INR even with USD on'
);
assert(
  decideCheckoutCurrency({ lockedCurrency: 'EUR', env: {}, warn: quiet }).allowed === false,
  'a live plan in a currency nobody sells refuses checkout'
);

console.log('\n--> 5. Prices of the plans on sale');
assert(pricingINR.FREE.month_price === 0, 'Free is ₹0');
assert(pricingINR.STANDARD.month_price === 599, 'INR Standard is ₹599/mo');
assert(pricingINR.STANDARD.year_price === 5990, 'INR Standard is ₹5,990/yr');
assert(pricingINR.PRO.month_price === 1999, 'INR Pro is ₹1,999/mo');
assert(pricingUSD.STANDARD.month_price === 19, 'USD Standard is $19/mo');
assert(pricingUSD.STANDARD.year_price === 190, 'USD Standard is $190/yr');
assert(pricingUSD.PRO.month_price === 29, 'USD Pro is $29/mo');
assert(pricingUSD.PRO.year_price === 290, 'USD Pro is $290/yr');

console.log('\n--> 6. Lookups');
assert(getPricing('INR').STANDARD.month_price === 599, 'getPricing("INR")');
assert(getPricing('usd').STANDARD.month_price === 19, 'getPricing is case-insensitive');
assert(getPricing('NOPE').STANDARD.month_price === 599, 'an unknown currency gets the INR table');
assert(getPricing().STANDARD.month_price === 599, 'no currency gets the INR table');
assert(getCurrencyConfig().symbol === '₹', 'getCurrencyConfig defaults to ₹');
assert(CURRENCY_CONFIG.USD.symbol === '$' && CURRENCY_CONFIG.INR.symbol === '₹', 'symbols');

console.log(`\nAll ${passed} pricing checks passed.`);
