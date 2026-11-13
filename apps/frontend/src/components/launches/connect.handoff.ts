// No 'use client' here on purpose: the (app) layout, a server component,
// inlines CONNECT_URL_SCRUB_SCRIPT, and a string exported from a client module
// would reach it as a client reference, not as the string (same as twa.ts).
import { SECRET_URL_PARAMS } from '@hookpost/react/helpers/secret.url.params';

/**
 * Channels that connect with credentials instead of an OAuth redirect (the
 * custom-field providers such as Bluesky, Dev.to and WordPress; Skool, whose
 * session cookies the Chrome extension reads; and the "web3" ones, where
 * Moltbook's code is the agent's permanent API key) used to send them to the
 * callback page in its URL:
 *
 *   /integrations/social/skool?state=...&code=<base64 of the cookies>
 *
 * That page loads the Meta pixel, GTM, Sentry, Plausible and Dub, which all
 * read the page URL, and the URL is written to the nginx, Cloudflare and
 * Next.js request logs. Now the Add Channel page POSTs the credentials to
 * the backend, which keeps them for a few minutes under a random one-time id
 * (connect.handoff.ts in nestjs-libraries), and the callback URL carries only
 * that id. The callback page sends the id on, the backend redeems it, and the
 * credentials never come back out.
 */

/** The callback page every connect lands on: /integrations/social/<provider>. */
export const CONNECT_CALLBACK_PREFIX = '/integrations/social/';

/**
 * Query parameters of the callback page that are secrets: an OAuth code (or,
 * from an old link, the credentials themselves), the handoff id, X's
 * oauth_verifier, TikTok Business's auth_code and MeWe's loginRequestToken.
 * The page already has them from the server render (its searchParams prop),
 * so the address bar does not need them. Sentry scrubs the same list.
 */
export const SECRET_CALLBACK_PARAMS = SECRET_URL_PARAMS;

/**
 * The callback page's query string without its secrets, or null when it
 * has none. `state` and `onboarding` stay: a reload with the state still
 * answers "already connected" (finishedConnect) instead of an error.
 */
export const withoutSecretParams = (
  pathname: string,
  search: string
): string | null => {
  if (!pathname.startsWith(CONNECT_CALLBACK_PREFIX)) {
    return null;
  }
  const params = new URLSearchParams(search);
  let changed = false;
  for (const name of SECRET_CALLBACK_PARAMS) {
    if (params.has(name)) {
      params.delete(name);
      changed = true;
    }
  }
  return changed ? params.toString() : null;
};

/**
 * Inlined at the top of <head> on every (app) page (layout.tsx), and run as
 * soon as the parser reaches it. On the callback page it takes the secrets
 * out of the address bar with history.replaceState, so whatever reads
 * location.href or document.URL from then on (and the Referer of the page's
 * own later requests) never sees them.
 *
 * Nothing that reads the URL runs before it. Next.js lists its own chunks
 * above it as async scripts, but Sentry, PostHog, Dub, GTM, the Meta pixel,
 * Plausible, Datafast and Cloudflare's beacon all start from React effects
 * or next/script after hydration, and hydration needs the page's RSC
 * payload, which is inlined at the end of <body>. connect-handoff.spec.ts
 * (E2E) has every chunk write down the URL it sees the moment it runs.
 *
 * The same logic as withoutSecretParams, in ES5, because it is inlined as is.
 */
export const CONNECT_URL_SCRUB_SCRIPT = `(function(){try{var l=window.location;if(l.pathname.indexOf(${JSON.stringify(
  CONNECT_CALLBACK_PREFIX
)})!==0)return;var p=new URLSearchParams(l.search),c=false;${JSON.stringify(
  SECRET_CALLBACK_PARAMS
)}.forEach(function(k){if(p.has(k)){p.delete(k);c=true;}});if(!c)return;var q=p.toString();window.history.replaceState(window.history.state,'',l.pathname+(q?'?'+q:'')+l.hash);}catch(e){}})();`;

/** base64 of the UTF-8 JSON, as the backend reads `code`. */
export const encodeCredentials = (credentials: unknown): string => {
  const json = JSON.stringify(credentials);
  return typeof Buffer !== 'undefined'
    ? Buffer.from(json, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(json)));
};

/** The callback URL for a handed-off connect: no credentials in it. */
export const handoffCallbackPath = (p: {
  provider: string;
  state: string;
  handoff: string;
  onboarding?: boolean;
}) =>
  `${CONNECT_CALLBACK_PREFIX}${encodeURIComponent(
    p.provider
  )}?state=${encodeURIComponent(p.state)}&handoff=${encodeURIComponent(
    p.handoff
  )}${p.onboarding ? '&onboarding=true' : ''}`;

export type HandoffResult = { path: string } | { error: string };

/**
 * Hands the connect's code to the backend (POST /integrations/social-connect/
 * <provider>/handoff, in the body) and answers the callback URL to go to, or
 * the reason it could not. `code` is exactly what the callback used to carry:
 * encodeCredentials(fields) for custom fields and the extension's cookies,
 * the raw value for a web3 provider.
 */
export const handOffConnectCode = async (
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  p: {
    provider: string;
    state: string;
    code: string;
    onboarding?: boolean;
  }
): Promise<HandoffResult> => {
  let response: Response;
  try {
    response = await fetch(
      `/integrations/social-connect/${encodeURIComponent(p.provider)}/handoff`,
      {
        method: 'POST',
        body: JSON.stringify({ state: p.state, code: p.code }),
      }
    );
  } catch {
    return { error: 'Could not connect to the platform' };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.handoff !== 'string') {
    return {
      error:
        (typeof body?.message === 'string' && body.message) ||
        'Could not connect to the platform',
    };
  }
  return {
    path: handoffCallbackPath({
      provider: p.provider,
      state: p.state,
      handoff: body.handoff,
      onboarding: p.onboarding,
    }),
  };
};
