/**
 * Every t('key', 'English default') on the finish-trial screen and in the
 * Reactivate / Change payment method dialog has its key in the English
 * locale, with the same text. A key missing from translation.json is not
 * offered to translators, and other languages show the English default.
 *   pnpm exec jest -c apps/frontend/jest.config.ts billing.translations
 */
import * as fs from 'fs';
import * as path from 'path';

const en = require('../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json');

/** t('key', '...') or t('key', "..."), across line breaks. */
function keysWithDefaults(file: string) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const found: Array<[string, string]> = [];
  const re =
    /\bt\(\s*'([a-z0-9_]+)'\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // The literal without its quotes, escapes such as \' undone.
    found.push([m[1], m[2].slice(1, -1).replace(/\\(.)/g, '$1')]);
  }
  return found;
}

describe('English locale', () => {
  it('has every finish_trial_* string the finish-trial screen uses', () => {
    const used = keysWithDefaults('finish.trial.tsx');
    const finishKeys = used.map(([key]) => key).filter((k) => k.startsWith('finish_trial_'));
    expect(finishKeys).toEqual(
      expect.arrayContaining([
        'finish_trial_not_charged',
        'finish_trial_refused',
        'finish_trial_no_subscription',
        'finish_trial_failed',
        'finish_trial_failed_body',
        'finish_trial_failed_unknown',
        'finish_trial_unconfirmed',
        'finish_trial_unconfirmed_body',
      ])
    );
    for (const [key, fallback] of used) {
      expect([key, en[key]]).toEqual([key, fallback]);
    }
  });

  it('has the line under the current plan price', () => {
    const used = keysWithDefaults('plan.card.price.tsx');
    expect(used.map(([key]) => key)).toEqual(['billing_your_price_since_subscribed']);
    for (const [key, fallback] of used) {
      expect([key, en[key]]).toEqual([key, fallback]);
    }
  });

  it('has every string of the Reactivate / Change payment method dialog', () => {
    const used = keysWithDefaults('replacement.mandate.ts');
    expect(used.length).toBeGreaterThanOrEqual(15);
    for (const [key, fallback] of used) {
      expect([key, en[key]]).toEqual([key, fallback]);
    }
  });
});
