import { takeEarlyResponse } from './early.fetch';
export interface Params {
  baseUrl: string;
  beforeRequest?: (url: string, options: RequestInit) => Promise<RequestInit>;
  afterRequest?: (
    url: string,
    options: RequestInit,
    response: Response
  ) => Promise<boolean>;
}
/** The cookies that carry a session or pick a workspace (session.cookies.ts). */
export const SESSION_COOKIES = ['auth', 'showorg', 'impersonate'] as const;

let hostOnlyCopiesCleared = false;

/**
 * With secure cookies the backend keeps the session in httpOnly cookies on
 * the registrable domain (.hookstep.in). Under NOT_SECURED this frontend also
 * wrote readable copies itself (layout.context.tsx setCookie): one on that
 * domain, which the backend replaces with an httpOnly cookie on the next
 * request (AuthMiddleware, upgradeReadableSession), and a host-only one,
 * which no Set-Cookie for the domain can reach. A host-only copy outlives
 * sign-outs and the stop-impersonating button, and the browser may list it
 * before the backend's cookie, so it is removed once per page load, by
 * FetchWrapperComponent before the app makes its first request. Only with
 * secure cookies: under NOT_SECURED the host-only copy is the session (on
 * localhost it is the only copy). A script can never remove an httpOnly
 * cookie, so this touches nothing the backend set.
 */
export function clearHostOnlySessionCookies() {
  if (hostOnlyCopiesCleared || typeof document === 'undefined') return;
  hostOnlyCopiesCleared = true;
  for (const name of SESSION_COOKIES) {
    // No Domain attribute: only the host-only cookie of that name matches.
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

const readableCookie = (name: string) =>
  typeof document === 'undefined'
    ? null
    : document.cookie
        .split(';')
        .find((p) => p.includes(`${name}=`))
        ?.split('=')[1];

export const customFetch = (
  params: Params,
  auth?: string,
  showorg?: string,
  secured: boolean = true
) => {
  return async function newFetch(url: string, options: RequestInit = {}) {
    const loggedAuth =
      typeof window === 'undefined'
        ? undefined
        : new URL(window.location.href).searchParams.get('loggedAuth');
    const newRequestObject = await params?.beforeRequest?.(url, options);
    // Under NOT_SECURED the session lives in readable cookies and travels as
    // headers. With secure cookies the browser sends the httpOnly cookies by
    // itself; a readable `auth` left from NOT_SECURED is still sent as a
    // header, which is how the backend knows to set it again httpOnly.
    const authNonSecuredCookie = readableCookie('auth');
    const authNonSecuredOrg = secured ? null : readableCookie('showorg');
    const authNonSecuredImpersonate = secured
      ? null
      : readableCookie('impersonate');

    const send = () =>
      fetch(params.baseUrl + url, {
        credentials: 'include',
        ...(newRequestObject || options),
        headers: {
          ...(showorg
            ? { showorg }
            : authNonSecuredOrg
            ? { showorg: authNonSecuredOrg }
            : {}),
          ...(options.body instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
          ...(loggedAuth ? { auth: loggedAuth } : {}),
          ...options?.headers,
          ...(auth
            ? { auth }
            : authNonSecuredCookie
            ? { auth: authNonSecuredCookie }
            : {}),
          ...(authNonSecuredImpersonate
            ? { impersonate: authNonSecuredImpersonate }
            : {}),
        },
        // @ts-ignore
        ...(!options.next && options.cache !== 'force-cache'
          ? { cache: options.cache || 'no-store' }
          : {}),
      });

    // Already asked for by the page's HTML (early.fetch.ts): only when this
    // request would go out exactly as the early one did - secure cookies, no
    // session or workspace header of its own, no beforeRequest rewrite. A
    // failed early request is sent again.
    const early =
      secured &&
      !auth &&
      !showorg &&
      !loggedAuth &&
      !authNonSecuredCookie &&
      !newRequestObject
        ? takeEarlyResponse(params.baseUrl + url, options)
        : undefined;

    const fetchRequest = early ? await early.catch(send) : await send();

    if (
      !params?.afterRequest ||
      (await params?.afterRequest?.(url, options, fetchRequest))
    ) {
      return fetchRequest;
    }

    // @ts-ignore
    return new Promise((res) => {}) as Response;
  };
};

export const fetchBackend = customFetch({
  get baseUrl() {
    return process.env.BACKEND_URL!;
  },
});
