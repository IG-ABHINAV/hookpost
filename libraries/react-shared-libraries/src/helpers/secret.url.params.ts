// No 'use client' and no imports: the (app) layout inlines a script built from
// SECRET_URL_PARAMS (components/launches/connect.handoff.ts), and the Sentry
// set-up uses the scrubbers on the server and in the browser.

/**
 * URL parameters that carry a secret: an OAuth code (or, from an old link, a
 * channel's credentials), a connect handoff id, X's oauth_verifier, TikTok
 * Business's auth_code and MeWe's loginRequestToken.
 */
export const SECRET_URL_PARAMS = [
  'code',
  'handoff',
  'oauth_verifier',
  'auth_code',
  'loginRequestToken',
] as const;

const SECRET_PARAM = new RegExp(
  `(^|[?&#])((?:${SECRET_URL_PARAMS.join('|')})=)[^&#\\s"'<>]*`,
  'g'
);

/**
 * `text` (a URL, a query string, a log line) with the value of every secret
 * URL parameter in it replaced.
 */
export const scrubSecretParams = (text: string): string =>
  text.replace(SECRET_PARAM, '$1$2[Filtered]');

/**
 * Every string inside `value` scrubbed, in place (objects and arrays are
 * walked, cycles and depth bounded). For telemetry events: Sentry names the
 * page-load span and Replay's navigation entry after the browser's record of
 * the page load, which keeps the URL the page was opened with even after
 * connect.handoff.ts took the code out of the address bar.
 */
export function scrubSecretsDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: any, depth: number): any => {
    if (typeof node === 'string') {
      return node.indexOf('=') === -1 ? node : scrubSecretParams(node);
    }
    if (!node || typeof node !== 'object' || depth > 32 || seen.has(node)) {
      return node;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i], depth + 1);
      return node;
    }
    for (const key of Object.keys(node)) {
      try {
        node[key] = walk(node[key], depth + 1);
      } catch {
        // A frozen or read-only field: leave it.
      }
    }
    return node;
  };
  return walk(value, 0);
}

/**
 * A Sentry event, transaction, breadcrumb or Replay recording event with the
 * secrets taken out (initialize.sentry.next.basic.ts). Also the request's
 * query string when Sentry holds it as pairs or an object, not a string.
 */
export function scrubSentryEvent<T>(event: T): T {
  const scrubbed: any = scrubSecretsDeep(event);
  const query = scrubbed?.request?.query_string;
  const secret = (name: unknown) =>
    (SECRET_URL_PARAMS as readonly string[]).includes(String(name));
  if (Array.isArray(query)) {
    scrubbed.request.query_string = query.map((pair: any) =>
      Array.isArray(pair) && secret(pair[0]) ? [pair[0], '[Filtered]'] : pair
    );
  } else if (query && typeof query === 'object') {
    for (const name of Object.keys(query)) {
      if (secret(name)) query[name] = '[Filtered]';
    }
  }
  return scrubbed;
}
