/**
 * Secrets in URLs never reach Sentry (secret.url.params.ts, wired into
 * initialize.sentry.next.basic.ts). The page-load span and Replay's
 * navigation entry are named after the browser's record of the page load,
 * which keeps the URL the connect callback was opened with even after the
 * page took the code out of the address bar.
 *   pnpm exec jest -c apps/frontend/jest.config.ts sentry.scrub
 */
const mockInit = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  init: (options: unknown) => mockInit(options),
  consoleLoggingIntegration: () => ({ name: 'ConsoleLogging' }),
}));

import {
  scrubSecretParams,
  scrubSentryEvent,
} from '@hookpost/react/helpers/secret.url.params';
import { initializeSentryBasic } from '@hookpost/react/sentry/initialize.sentry.next.basic';

const CALLBACK = 'https://hookpost.hookstep.in/integrations/social/skool';

describe('scrubSecretParams', () => {
  it.each([
    [`${CALLBACK}?state=s1&code=eyJjb29raWUiOiJTRUNSRVQifQ%3D%3D`, `${CALLBACK}?state=s1&code=[Filtered]`],
    [`${CALLBACK}?code=abc&state=s1`, `${CALLBACK}?code=[Filtered]&state=s1`],
    [`${CALLBACK}?state=s1&handoff=AbC_-123`, `${CALLBACK}?state=s1&handoff=[Filtered]`],
    ['/integrations/social/x?oauth_token=t&oauth_verifier=v', '/integrations/social/x?oauth_token=t&oauth_verifier=[Filtered]'],
    ['/integrations/social/tiktok-business?auth_code=a', '/integrations/social/tiktok-business?auth_code=[Filtered]'],
    ['/integrations/social/mewe#state=s&loginRequestToken=t', '/integrations/social/mewe#state=s&loginRequestToken=[Filtered]'],
    ['code=abc&state=s', 'code=[Filtered]&state=s'],
    ['GET /x?a=1&code=abc HTTP/1.1', 'GET /x?a=1&code=[Filtered] HTTP/1.1'],
  ])('%s', (input, output) => {
    expect(scrubSecretParams(input)).toBe(output);
  });

  it.each([
    [`${CALLBACK}?state=s1&onboarding=true`],
    ['/launches?added=skool&msg=Channel%20added'],
    ['/x?zipcode=12345&barcode=9'],
    ['Error code: E11000 duplicate key'],
  ])('leaves %s alone', (input) => {
    expect(scrubSecretParams(input)).toBe(input);
  });
});

describe('scrubSentryEvent', () => {
  it('a page-load transaction, its spans, the request and breadcrumbs', () => {
    const url = `${CALLBACK}?state=s1&code=SECRET`;
    const event: any = {
      transaction: '/integrations/social/[provider]',
      request: { url, query_string: 'state=s1&code=SECRET', headers: { Referer: url } },
      spans: [{ op: 'browser.navigation', description: url, data: { 'http.url': url } }],
      breadcrumbs: [{ category: 'navigation', data: { from: url, to: '/launches' } }],
      contexts: { trace: { data: { 'url.full': url } }, error: { code: 'ECONNRESET' } },
    };
    const out = scrubSentryEvent(event);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out.request.query_string).toBe('state=s1&code=[Filtered]');
    // A field called "code" that is not a URL is kept: it is how errors say what failed.
    expect(out.contexts.error.code).toBe('ECONNRESET');
  });

  it('a query string held as pairs or as an object', () => {
    expect(
      scrubSentryEvent({ request: { query_string: [['state', 's'], ['code', 'SECRET']] } })
    ).toEqual({ request: { query_string: [['state', 's'], ['code', '[Filtered]']] } });
    expect(
      scrubSentryEvent({ request: { query_string: { state: 's', handoff: 'SECRET' } } })
    ).toEqual({ request: { query_string: { state: 's', handoff: '[Filtered]' } } });
  });

  it('a Replay performance entry for the page load', () => {
    const entry = {
      type: 5,
      data: {
        tag: 'performanceSpan',
        payload: { op: 'navigation.navigate', description: `${CALLBACK}?code=SECRET&state=s` },
      },
    };
    expect(JSON.stringify(scrubSentryEvent(entry))).not.toContain('SECRET');
  });

  it('survives cycles and deep nesting', () => {
    const a: any = { url: '/?code=SECRET' };
    a.self = a;
    let deep: any = { url: '/?code=SECRET' };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    expect(() => scrubSentryEvent({ a, deep })).not.toThrow();
    expect(a.url).toBe('/?code=[Filtered]');
  });
});

describe('initializeSentryBasic wires the scrub into every Sentry hook', () => {
  beforeAll(() => {
    initializeSentryBasic('production', 'https://public@o1.ingest.sentry.io/1', {});
  });
  const options = () => mockInit.mock.calls[0][0];

  it('transactions', () => {
    const out = options().beforeSendTransaction({ transaction: `${CALLBACK}?code=SECRET` });
    expect(out.transaction).toBe(`${CALLBACK}?code=[Filtered]`);
  });

  it('breadcrumbs', () => {
    const out = options().beforeBreadcrumb({ category: 'fetch', data: { url: '/api/x?handoff=SECRET' } });
    expect(out.data.url).toBe('/api/x?handoff=[Filtered]');
  });

  it('errors', () => {
    const out = options().beforeSend({ request: { url: `${CALLBACK}?code=SECRET` } }, {});
    expect(out.request.url).toBe(`${CALLBACK}?code=[Filtered]`);
  });
});
