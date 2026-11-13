/**
 * What the marketplace gateway trusts (marketplace.gateway.ts): the shared
 * secret, the plan token, the subscriber id, and that neither secret ever
 * reaches Sentry.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.gateway
 */
import {
  billingValue,
  gatewaySecrets,
  matchGatewaySecret,
  normalizePlanName,
  planTokenTable,
  resolveCallPlan,
  resolveMagicapiPlan,
  resolvePlanToken,
  scrubSecretHeaders,
  sha256Hex,
  singleHeader,
  subscriberTag,
  validSubscriberId,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';

const CURRENT = 'c'.repeat(40);
const NEXT = 'n'.repeat(48);

describe('gateway secret', () => {
  it('matches the current and the next secret during a rotation, by index', () => {
    expect(matchGatewaySecret(CURRENT, [CURRENT, NEXT])).toBe(0);
    expect(matchGatewaySecret(NEXT, [CURRENT, NEXT])).toBe(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong', 'w'.repeat(40)],
    ['a different length', CURRENT + 'x'],
    ['a prefix', CURRENT.slice(0, 39)],
    ['not a string', ['a', 'b']],
  ])('refuses a %s secret', (_name, value) => {
    expect(matchGatewaySecret(value as any, [CURRENT, NEXT])).toBe(-1);
  });

  it('refuses everything while none is configured', () => {
    expect(matchGatewaySecret(CURRENT, [])).toBe(-1);
  });

  it('reads the comma list per product and drops entries under 32 characters', () => {
    const env = { MKT_GATEWAY_SECRETS_SOCIAL: ` ${CURRENT} , short, ${NEXT} ` };
    expect(gatewaySecrets('social', env)).toEqual([CURRENT, NEXT]);
    expect(gatewaySecrets('x', env)).toEqual([]);
    expect(gatewaySecrets('social', { MKT_GATEWAY_SECRETS_SOCIAL: 'changeme' })).toEqual([]);
  });
});

describe('plan token', () => {
  const trialToken = 't'.repeat(43);
  const proToken = 'p'.repeat(43);
  const env = {
    MKT_PLAN_TOKEN_HASHES: [
      `${sha256Hex(trialToken)}=social:trial`,
      `${sha256Hex(proToken).toUpperCase()}=x:pro`,
      `${sha256Hex('u'.repeat(40))}=social:platinum`,
      'not-a-hash=social:pro',
    ].join(','),
  };

  it('names the plan by the token hash, for its own product only', () => {
    expect(resolvePlanToken(trialToken, 'social', env)).toMatchObject({ product: 'social', plan: 'trial' });
    expect(resolvePlanToken(proToken, 'x', env)).toMatchObject({ product: 'x', plan: 'pro' });
    expect(resolvePlanToken(proToken, 'social', env)).toBeNull();
  });

  it('refuses an unknown, short or missing token', () => {
    expect(resolvePlanToken('z'.repeat(43), 'social', env)).toBeNull();
    expect(resolvePlanToken('short', 'social', env)).toBeNull();
    expect(resolvePlanToken(undefined, 'social', env)).toBeNull();
  });

  it('drops entries naming a plan that does not exist or a malformed hash', () => {
    expect(planTokenTable(env).size).toBe(2);
  });
});

describe('subscriber id and headers', () => {
  it('takes api.market cuids only', () => {
    expect(validSubscriberId('cll8kolno0000l808v6p3xvax')).toBe(true);
    expect(validSubscriberId('CLL8KOLNO0000L808V6P3XVAX')).toBe(false);
    expect(validSubscriberId('short')).toBe(false);
    expect(validSubscriberId('cll8kolno0000l808v6p3xvax; drop')).toBe(false);
    expect(validSubscriberId(undefined)).toBe(false);
  });

  it('refuses a repeated header rather than picking one of its values', () => {
    expect(singleHeader(['a', 'b'])).toBeUndefined();
    expect(singleHeader('a')).toBe('a');
  });

  it('tags a subscriber with 8 hex characters', () => {
    expect(subscriberTag('cll8kolno0000l808v6p3xvax')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('writes the billing header the way api.market reads it', () => {
    expect(billingValue(0)).toBe('API=0;');
    expect(billingValue(11)).toBe('API=11;');
    expect(billingValue(-3)).toBe('API=0;');
    expect(billingValue(NaN)).toBe('API=0;');
  });
});

describe('scrubSecretHeaders (Sentry beforeSend)', () => {
  it('filters the gateway secret and plan token, whatever their case', () => {
    const event = {
      request: {
        headers: {
          'x-hookpost-gateway': CURRENT,
          'X-Hookpost-Plan': 'secret-plan-token',
          'x-magicapi-user': 'cll8kolno0000l808v6p3xvax',
        },
      },
    };
    const scrubbed = scrubSecretHeaders(event);
    expect(JSON.stringify(scrubbed)).not.toContain(CURRENT);
    expect(JSON.stringify(scrubbed)).not.toContain('secret-plan-token');
    expect(scrubbed.request.headers['x-magicapi-user']).toBe('cll8kolno0000l808v6p3xvax');
  });

  it("filters RapidAPI's proxy secret and a keyed marketplace's key too", () => {
    const event = {
      request: {
        headers: {
          'X-RapidAPI-Proxy-Secret': 'rapid-proxy-secret-value',
          'x-hookpost-marketplace-key': 'keyed-marketplace-key-value',
          'x-rapidapi-user': 'jane',
        },
      },
    };
    const text = JSON.stringify(scrubSecretHeaders(event));
    expect(text).not.toContain('rapid-proxy-secret-value');
    expect(text).not.toContain('keyed-marketplace-key-value');
    expect(event.request.headers['x-rapidapi-user']).toBe('jane');
  });

  it('leaves an event without headers alone', () => {
    expect(scrubSecretHeaders({})).toEqual({});
  });
});

describe("api.market's plan name (x-magicapi-plan)", () => {
  it.each([
    ['Free trial', 'trial'],
    ['Standard', 'standard'],
    ['Pro', 'pro'],
    ['free trial', 'trial'],
    ['FREE TRIAL', 'trial'],
    ['  Free   trial  ', 'trial'],
    ['Free\ttrial', 'trial'],
    ['Free\u00a0Trial', 'trial'],
    [' standard', 'standard'],
    ['PRO\n', 'pro'],
    ['Tester', 'pro'],
    [' TESTER ', 'pro'],
    ['Free', 'trial'],
    [' FREE\t', 'trial'],
  ])('maps %j on Social to %s', (name, plan) => {
    const resolved = resolveMagicapiPlan(name, 'social');
    expect(resolved).toMatchObject({ product: 'social', plan });
  });

  it.each([
    ['an unknown plan', 'Enterprise'],
    ['a near miss of Tester', 'Testers'],
    ['the private Starter', 'Starter'],
    ['a near miss', 'Pro+'],
    ['a near miss of Free', 'Freee'],
    ['a substring', 'Fre'],
    ['a superstring', 'Pro plan'],
    ['an object key', 'constructor'],
    ['another inherited key', '__proto__'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a repeated name past 64 characters', 'pro '.repeat(20)],
    ['a comma-joined repeat', 'Free trial, Pro'],
    ['full-width look-alike letters', '\uff30\uff52\uff4f'],
    ['a look-alike ordinal a', 'St\u00aandard'],
  ])('refuses %s', (_n, name) => {
    expect(resolveMagicapiPlan(name, 'social')).toBeNull();
  });

  it('refuses a non-string, and a name longer than 64 characters', () => {
    for (const v of [undefined, null, 1, ['Pro'], { pro: 1 }]) {
      expect(resolveMagicapiPlan(v, 'social')).toBeNull();
    }
    expect(resolveMagicapiPlan('Pro' + ' '.repeat(70), 'social')).toBeNull();
  });

  it('names no plan on a product without a name table (LinkedIn, X, Validator stay on plan tokens)', () => {
    for (const product of ['linkedin', 'x', 'validate'] as const) {
      expect(resolveMagicapiPlan('Pro', product)).toBeNull();
      expect(resolveMagicapiPlan('Free trial', product)).toBeNull();
      expect(resolveMagicapiPlan('Tester', product)).toBeNull();
      expect(resolveMagicapiPlan('Free', product)).toBeNull();
    }
  });

  it('normalizes case and whitespace only, no Unicode folding', () => {
    expect(normalizePlanName('\uff30ro')).toBe('\uff50ro');
    expect(normalizePlanName('  FREE \t TRIAL ')).toBe('free trial');
  });
});

describe('the plan of a call', () => {
  const TOKEN = 'plan-token-' + 'p'.repeat(30);
  const env = { MKT_PLAN_TOKEN_HASHES: `${sha256Hex(TOKEN)}=social:pro` };

  it('takes a plan token that resolves over the plan name', () => {
    expect(resolveCallPlan({ planToken: TOKEN, magicapiPlan: 'Free trial' }, 'social', env)).toMatchObject({
      source: 'plan_token',
      plan: { plan: 'pro' },
    });
  });

  it('falls back to the plan name when there is no token or it names nothing', () => {
    for (const planToken of [undefined, '', 'unknown-token-' + 'u'.repeat(20)]) {
      expect(resolveCallPlan({ planToken, magicapiPlan: 'Standard' }, 'social', env)).toMatchObject({
        source: 'magicapi_plan',
        plan: { plan: 'standard' },
      });
    }
  });

  it("does not take another product's token", () => {
    const xEnv = { MKT_PLAN_TOKEN_HASHES: `${sha256Hex(TOKEN)}=x:pro` };
    expect(resolveCallPlan({ planToken: TOKEN }, 'social', xEnv)).toBeNull();
    expect(resolveCallPlan({ planToken: TOKEN, magicapiPlan: 'Free trial' }, 'social', xEnv)).toMatchObject({
      source: 'magicapi_plan',
      plan: { plan: 'trial' },
    });
  });

  it("takes api.market's review plan, Tester, as Pro on Social", () => {
    expect(resolveCallPlan({ magicapiPlan: 'Tester' }, 'social', env)).toMatchObject({
      source: 'magicapi_plan',
      plan: { product: 'social', plan: 'pro' },
    });
  });

  it("takes api.market's free plan name, Free, as the trial on Social", () => {
    expect(resolveCallPlan({ magicapiPlan: 'Free' }, 'social', env)).toMatchObject({
      source: 'magicapi_plan',
      plan: { product: 'social', plan: 'trial' },
    });
  });

  it('names no plan with neither', () => {
    expect(resolveCallPlan({}, 'social', env)).toBeNull();
    expect(resolveCallPlan({ magicapiPlan: 'Enterprise' }, 'social', env)).toBeNull();
  });
});
