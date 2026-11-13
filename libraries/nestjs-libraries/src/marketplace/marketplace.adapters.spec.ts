/**
 * The marketplace adapters (marketplace.adapters.ts): which marketplace a
 * call came through, its secret, its subscriber and plan, and its billing
 * header, for api.market, RapidAPI and a keyed marketplace. Pure, no Nest.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.adapters
 */
import {
  adapterById,
  adapterConfigured,
  apiMarketAdapter,
  isRefusal,
  KEYED_NAME_HEADER,
  KEYED_SECRET_HEADER,
  keyedAdapter,
  keyedConfigs,
  marketplaceAdapters,
  pickAdapter,
  planNameTable,
  rapidApiAdapter,
  rapidApiBillingObject,
  rapidApiPlan,
  SHARED_SUBSCRIBER,
  sourceLabel,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import { sha256Hex } from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';

const API_SECRET = 'a'.repeat(40);
const RAPID_SECRET = 'r'.repeat(30);
const ZYLA_SECRET = 'z'.repeat(40);
const TOKEN = 'plan-token-' + 'p'.repeat(30);
const CUID = 'cll8kolno0000l808v6p3xvax';

const env = {
  MKT_GATEWAY_SECRETS_SOCIAL: API_SECRET,
  MKT_PLAN_TOKEN_HASHES: `${sha256Hex(TOKEN)}=social:pro`,
  MKT_RAPIDAPI_SECRETS_SOCIAL: RAPID_SECRET,
  MKT_RAPIDAPI_SECRETS_VALIDATE: `${RAPID_SECRET},${'n'.repeat(30)}`,
  MKT_KEYED_MARKETPLACES: 'zyla, apilayer ,bad name,rapidapi,api_market,zyla',
  MKT_KEYED_ZYLA_SECRETS_SOCIAL: ZYLA_SECRET,
  MKT_KEYED_ZYLA_LABEL: 'Zyla API Hub',
  MKT_KEYED_ZYLA_USER_HEADER: 'X-Zyla-User',
  MKT_KEYED_ZYLA_PLAN_HEADER: 'x-zyla-plan',
  MKT_KEYED_ZYLA_PLANS: 'social:Basic=trial,social:Pro Plan=pro,validate:Basic=starter',
  MKT_KEYED_ZYLA_BILLING_HEADER: 'x-zyla-units',
  MKT_KEYED_APILAYER_SECRETS_VALIDATE: 'l'.repeat(40),
  MKT_KEYED_APILAYER_SECRETS_SOCIAL: 'm'.repeat(40),
  MKT_KEYED_APILAYER_DEFAULT_PLAN_VALIDATE: 'starter',
  MKT_KEYED_APILAYER_DEFAULT_PLAN_SOCIAL: 'standard',
};

const zyla = () => marketplaceAdapters(env).find((a) => a.id === 'ZYLA')!;
const apilayer = () => marketplaceAdapters(env).find((a) => a.id === 'APILAYER')!;

describe('the registry', () => {
  it('has api.market, RapidAPI and each valid keyed name once, never shadowing a built-in', () => {
    expect(marketplaceAdapters(env).map((a) => a.id)).toEqual(['API_MARKET', 'RAPIDAPI', 'ZYLA', 'APILAYER']);
    expect(keyedConfigs({ MKT_KEYED_MARKETPLACES: 'direct,API_MARKET,unknown,apimarket,eden' }).map((c) => c.id)).toEqual(['EDEN']);
  });

  it('names sources for the admin page', () => {
    expect(sourceLabel('DIRECT', env)).toBe('Direct (hookpost.hookstep.in)');
    expect(sourceLabel('API_MARKET', env)).toBe('api.market');
    expect(sourceLabel('RAPIDAPI', env)).toBe('RapidAPI');
    expect(sourceLabel('ZYLA', env)).toBe('Zyla API Hub');
    expect(sourceLabel('GONE', env)).toBe('GONE');
    expect(adapterById('GONE', env)).toBeNull();
  });

  it('is configured only where a long enough secret is set', () => {
    expect(adapterConfigured(apiMarketAdapter, env)).toBe(true);
    expect(adapterConfigured(rapidApiAdapter, {})).toBe(false);
    expect(adapterConfigured(rapidApiAdapter, { MKT_RAPIDAPI_SECRETS_X: 'short' })).toBe(false);
    expect(rapidApiAdapter.secrets('validate', env)).toHaveLength(2);
  });
});

describe('pickAdapter: exactly one marketplace per call', () => {
  it.each([
    [{ 'x-hookpost-gateway': 'x' }, 'API_MARKET'],
    [{ 'x-rapidapi-proxy-secret': 'x' }, 'RAPIDAPI'],
    [{ [KEYED_NAME_HEADER]: 'Zyla' }, 'ZYLA'],
    [{ [KEYED_NAME_HEADER]: 'apilayer' }, 'APILAYER'],
  ])('%j is %s', (headers, id) => {
    const pick = pickAdapter(headers, env);
    expect(pick.kind).toBe('one');
    expect(pick.kind === 'one' && pick.adapter.id).toBe(id);
  });

  it('is none without a marker, or with an unknown keyed name', () => {
    expect(pickAdapter({}, env).kind).toBe('none');
    expect(pickAdapter({ [KEYED_NAME_HEADER]: 'eden' }, env).kind).toBe('none');
    expect(pickAdapter({ 'x-rapidapi-user': 'someone', 'x-magicapi-user': CUID }, env).kind).toBe('none');
  });

  it('refuses two markers at once (a buyer cannot be read as another marketplace\'s)', () => {
    const pick = pickAdapter({ 'x-hookpost-gateway': API_SECRET, 'x-rapidapi-proxy-secret': RAPID_SECRET }, env);
    expect(pick).toEqual({ kind: 'several', ids: ['API_MARKET', 'RAPIDAPI'] });
  });
});

describe('api.market (as before adapters)', () => {
  it('matches its secret, reads the plan token and x-magicapi-user, bills X-Magicapi-Billing', () => {
    const h = { 'x-hookpost-gateway': API_SECRET, 'x-hookpost-plan': TOKEN, 'x-magicapi-user': CUID };
    expect(apiMarketAdapter.matchSecret(h, 'social', env)).toBe(0);
    expect(apiMarketAdapter.matchSecret({ ...h, 'x-hookpost-gateway': RAPID_SECRET }, 'social', env)).toBe(-1);
    expect(apiMarketAdapter.identify(h, 'social', env)).toMatchObject({ subscriber: CUID, plan: { plan: 'pro' } });
    expect(apiMarketAdapter.billingHeaders(3)).toEqual({ 'X-Magicapi-Billing': 'API=3;' });
    expect(apiMarketAdapter.billingHeaders(-1)).toEqual({ 'X-Magicapi-Billing': 'API=0;' });
  });

  it('keeps its identifier, workspace name, Redis subscriber and retry id byte for byte', () => {
    expect(apiMarketAdapter.identifier('social', CUID)).toBe(`apimkt:social:${CUID}`);
    expect(apiMarketAdapter.workspaceName('1a2b3c4d')).toBe('api.market subscriber 1a2b3c4d');
    expect(apiMarketAdapter.subscriberKey(CUID)).toBe(CUID);
    expect(apiMarketAdapter.requestId({ 'x-request-id': 'r-1' })).toBe('r-1');
    expect(apiMarketAdapter.unauthorizedMessage).toBe('Call this API through api.market.');
  });

  it('refuses an unknown plan before the subscriber, and a malformed subscriber', () => {
    const noPlan = apiMarketAdapter.identify({ 'x-magicapi-user': 'BAD' }, 'social', env);
    expect(noPlan).toMatchObject({ status: 403, error: 'unknown_plan' });
    const bad = apiMarketAdapter.identify({ 'x-hookpost-plan': TOKEN, 'x-magicapi-user': 'Not-A-Cuid' }, 'social', env);
    expect(bad).toMatchObject({ status: 400, error: 'invalid_subscriber' });
  });

  it('does not read RapidAPI\'s headers', () => {
    const r = apiMarketAdapter.identify(
      { 'x-rapidapi-user': 'someone', 'x-rapidapi-subscription': 'PRO' },
      'social',
      env
    );
    expect(isRefusal(r)).toBe(true);
  });
});

describe('RapidAPI', () => {
  const h = (over: Record<string, unknown> = {}) => ({
    'x-rapidapi-proxy-secret': RAPID_SECRET,
    'x-rapidapi-user': 'jane.doe-99',
    'x-rapidapi-subscription': 'PRO',
    ...over,
  });

  it('matches the per-product proxy secret, constant-time, both during a rotation', () => {
    expect(rapidApiAdapter.matchSecret(h(), 'social', env)).toBe(0);
    expect(rapidApiAdapter.matchSecret(h({ 'x-rapidapi-proxy-secret': 'n'.repeat(30) }), 'validate', env)).toBe(1);
    expect(rapidApiAdapter.matchSecret(h({ 'x-rapidapi-proxy-secret': 'n'.repeat(30) }), 'social', env)).toBe(-1);
    expect(rapidApiAdapter.matchSecret(h({ 'x-rapidapi-proxy-secret': [RAPID_SECRET, RAPID_SECRET] }), 'social', env)).toBe(-1);
    expect(rapidApiAdapter.matchSecret(h(), 'x', env)).toBe(-1);
    // api.market's secret is not RapidAPI's.
    expect(rapidApiAdapter.matchSecret(h({ 'x-rapidapi-proxy-secret': API_SECRET }), 'social', env)).toBe(-1);
  });

  it.each([
    ['BASIC', 'trial'],
    ['basic', 'trial'],
    ['PRO', 'standard'],
    ['ULTRA', 'pro'],
    ['MEGA', 'pro'],
  ])('maps %s to the Social %s plan by default', (sub, plan) => {
    expect(rapidApiPlan(sub, 'social', {})?.plan).toBe(plan);
  });

  it('maps by tier on every product', () => {
    expect(rapidApiPlan('PRO', 'linkedin', {})?.plan).toBe('creator');
    expect(rapidApiPlan('ULTRA', 'x', {})?.plan).toBe('pro');
    expect(rapidApiPlan('MEGA', 'validate', {})?.plan).toBe('scale');
  });

  it.each([['CUSTOM'], [''], ['PRO, BASIC'], ['constructor'], ['__proto__'], ['x'.repeat(80)]])(
    'refuses %j',
    (sub) => {
      expect(rapidApiPlan(sub, 'social', {})).toBeNull();
    }
  );

  it('takes MKT_RAPIDAPI_PLANS over the defaults, per product', () => {
    const e = { MKT_RAPIDAPI_PLANS: 'social:PRO=pro,social:CUSTOM=standard' };
    expect(rapidApiPlan('PRO', 'social', e)?.plan).toBe('pro');
    expect(rapidApiPlan('custom', 'social', e)?.plan).toBe('standard');
    // Social is mapped, so the defaults no longer apply to it...
    expect(rapidApiPlan('BASIC', 'social', e)).toBeNull();
    // ...but still do to the others.
    expect(rapidApiPlan('BASIC', 'x', e)?.plan).toBe('trial');
  });

  it('reads the user and plan, scoped so they never meet an api.market subscriber', () => {
    const id = rapidApiAdapter.identify(h(), 'social', env);
    expect(id).toMatchObject({ subscriber: 'jane.doe-99', plan: { plan: 'standard' }, planSource: 'subscription' });
    expect(rapidApiAdapter.subscriberKey('jane.doe-99')).toBe('rapidapi:jane.doe-99');
    expect(rapidApiAdapter.subscriberKey(CUID)).not.toBe(apiMarketAdapter.subscriberKey(CUID));
    expect(rapidApiAdapter.identifier('social', 'jane')).toBe('apimkt:social:rapidapi:jane');
    expect(rapidApiAdapter.workspaceName('1a2b3c4d')).toBe('RapidAPI subscriber 1a2b3c4d');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['repeated', ['a', 'b']],
    ['with a space', 'jane doe'],
    ['with a slash', 'a/b'],
    ['too long', 'a'.repeat(65)],
  ])('refuses a %s user with 400', (_n, user) => {
    expect(rapidApiAdapter.identify(h({ 'x-rapidapi-user': user }), 'social', env)).toMatchObject({
      status: 400,
      error: 'invalid_subscriber',
    });
  });

  it('refuses an unknown or missing subscription with 403', () => {
    for (const sub of [undefined, 'CUSTOM', 'GOLD']) {
      expect(rapidApiAdapter.identify(h({ 'x-rapidapi-subscription': sub }), 'social', env)).toMatchObject({
        status: 403,
        error: 'unknown_plan',
      });
    }
  });

  it('bills X-RapidAPI-Billing: <object>=N, and trusts no buyer x-request-id', () => {
    expect(rapidApiAdapter.billingHeaders(20, {})).toEqual({ 'X-RapidAPI-Billing': 'Credits=20' });
    expect(rapidApiAdapter.billingHeaders(0, { MKT_RAPIDAPI_BILLING_OBJECT: 'Units' })).toEqual({
      'X-RapidAPI-Billing': 'Units=0',
    });
    expect(rapidApiBillingObject({ MKT_RAPIDAPI_BILLING_OBJECT: 'a,b=c' })).toBe('Credits');
    expect(rapidApiAdapter.requestId({ 'x-request-id': 'chosen-by-buyer' })).toBeUndefined();
  });
});

describe('a keyed marketplace', () => {
  const h = (over: Record<string, unknown> = {}) => ({
    [KEYED_NAME_HEADER]: 'zyla',
    [KEYED_SECRET_HEADER]: ZYLA_SECRET,
    'x-zyla-user': 'buyer@example.com',
    'x-zyla-plan': 'Pro  plan',
    ...over,
  });

  it('reads its config from .env, header names lower-cased', () => {
    expect(keyedConfigs(env)[0]).toEqual({
      name: 'zyla',
      id: 'ZYLA',
      label: 'Zyla API Hub',
      userHeader: 'x-zyla-user',
      planHeader: 'x-zyla-plan',
      billingHeader: 'x-zyla-units',
    });
  });

  it('matches only its own key for the product', () => {
    expect(zyla().matchSecret(h(), 'social', env)).toBe(0);
    expect(zyla().matchSecret(h(), 'validate', env)).toBe(-1);
    // Another keyed marketplace's key is not this one's.
    expect(zyla().matchSecret(h({ [KEYED_SECRET_HEADER]: 'm'.repeat(40) }), 'social', env)).toBe(-1);
    expect(apilayer().matchSecret(h({ [KEYED_SECRET_HEADER]: ZYLA_SECRET }), 'social', env)).toBe(-1);
  });

  it('maps its plan names, and refuses one it does not know', () => {
    expect(zyla().identify(h(), 'social', env)).toMatchObject({
      subscriber: 'buyer@example.com',
      plan: { plan: 'pro' },
    });
    expect(zyla().identify(h({ 'x-zyla-plan': 'Enterprise' }), 'social', env)).toMatchObject({ status: 403 });
    expect(zyla().identify(h({ 'x-zyla-plan': undefined }), 'social', env)).toMatchObject({ status: 403 });
  });

  it('needs a buyer id when it has a user header, and never one with a colon (Redis keys are colon-joined)', () => {
    expect(zyla().identify(h({ 'x-zyla-user': undefined }), 'social', env)).toMatchObject({ status: 400 });
    expect(zyla().identify(h({ 'x-zyla-user': 'a b' }), 'social', env)).toMatchObject({ status: 400 });
    expect(zyla().identify(h({ 'x-zyla-user': 'u1:x' }), 'social', env)).toMatchObject({ status: 400 });
  });

  it('without a buyer header, ignores a plan header: the shared subscriber keeps one plan', () => {
    const e = { ...env, MKT_KEYED_APILAYER_PLAN_HEADER: 'x-plan', MKT_KEYED_APILAYER_PLANS: 'validate:Big=scale' };
    const a = marketplaceAdapters(e).find((m) => m.id === 'APILAYER')!;
    expect(a.identify({ 'x-plan': 'Big' }, 'validate', e)).toMatchObject({ plan: { plan: 'starter' }, planSource: 'default' });
  });

  it('scopes secret-hit counters per marketplace, api.market as before', () => {
    expect(apiMarketAdapter.secretHitScope('social')).toBe('social');
    expect(rapidApiAdapter.secretHitScope('social')).toBe('RAPIDAPI:social');
    expect(zyla().secretHitScope('x')).toBe('ZYLA:x');
  });

  it('without a user header, sells only the validator, to one shared subscriber', () => {
    expect(apilayer().identify({}, 'validate', env)).toMatchObject({
      subscriber: SHARED_SUBSCRIBER,
      plan: { plan: 'starter' },
      planSource: 'default',
      shared: true,
    });
    // A real buyer named "shared" elsewhere is not the shared subscriber.
    expect((rapidApiAdapter.identify({ 'x-rapidapi-user': 'shared', 'x-rapidapi-subscription': 'PRO' }, 'social', env) as any).shared).toBeUndefined();
    // A product with channels and posts would put every buyer in one workspace.
    expect(apilayer().identify({}, 'social', env)).toMatchObject({ status: 400, error: 'invalid_subscriber' });
  });

  it('scopes its subscribers and bills in its own header, or not at all', () => {
    expect(zyla().subscriberKey('u')).toBe('zyla:u');
    expect(zyla().identifier('social', 'u')).toBe('apimkt:social:zyla:u');
    expect(zyla().billingHeaders(7)).toEqual({ 'x-zyla-units': '7' });
    expect(apilayer().billingHeaders(7)).toEqual({});
    expect(zyla().unauthorizedMessage).toBe('Call this API through Zyla API Hub.');
    expect(zyla().probe).toBe(false);
  });

  it('a config with junk header names has none', () => {
    const a = keyedAdapter({ name: 'x1', id: 'X1', label: 'x1' });
    expect(a.billingHeaders(1)).toEqual({});
    expect(keyedConfigs({ MKT_KEYED_MARKETPLACES: 'xy', MKT_KEYED_XY_USER_HEADER: 'bad header!' })[0].userHeader).toBeUndefined();
  });
});

describe('planNameTable', () => {
  it('drops unknown products and plans and keeps names normalised', () => {
    const t = planNameTable('social:Free  Trial=trial,nope:A=trial,social:B=nope,garbage,social:=pro');
    expect([...t.keys()]).toEqual(['social:free trial']);
  });
});
