/**
 * A small HTTP client for the backend under test, with a signed-in session.
 * The backend runs with NOT_SECURED, so it returns the session in `auth` and
 * `showorg` headers instead of Secure cookies; Session sends them back the way
 * the frontend's customFetch does.
 */
import { inviteRef } from '@hookpost/backend/services/auth/invite.ref';

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface RequestOptions {
  body?: any;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  raw?: BodyInit;
}

/**
 * The token in an invite URL from POST /settings/team: /invite/<token> since
 * 25 Oct 2026 (it was /?org=<token>, which Cloudflare's cache of "/" hid).
 */
export const inviteTokenFrom = (url: string) => {
  const match = /\/invite\/([^/?#]+)$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`not an invite link: ${url}`);
  return decodeURIComponent(match[1]);
};

/** The origin the app's pages are served from (FRONTEND_URL of the backend under test). */
export const appOrigin = () => new URL(process.env.FRONTEND_URL || 'http://localhost:4200').origin;

let counter = 0;
/** A unique, valid email per call (tests share one database). */
export const uniqueEmail = (tag = 'user') =>
  `${tag}.${Date.now().toString(36)}.${(counter++).toString(36)}@hookpost-test.invalid`;

export class Api {
  constructor(readonly baseUrl: string) {}

  async request<T = any>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    let body: BodyInit | undefined = options.raw;
    if (options.body !== undefined) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.cookies) {
      headers.cookie = Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  get<T = any>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }
  post<T = any>(path: string, body?: any, options: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...options, body });
  }
  put<T = any>(path: string, body?: any, options: RequestOptions = {}) {
    return this.request<T>('PUT', path, { ...options, body });
  }
  delete<T = any>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, options);
  }

  /** Registers a new email/password account and returns its session. */
  async register(
    opts: { email?: string; password?: string; company?: string; cookies?: Record<string, string> } = {}
  ): Promise<Session> {
    const email = opts.email || uniqueEmail();
    const password = opts.password || 'Correct-Horse-9';
    const res = await this.post(
      '/auth/register',
      {
        email,
        password,
        company: opts.company || 'Integration Co',
        provider: 'LOCAL',
      },
      { cookies: opts.cookies }
    );
    if (res.status !== 200 || !res.headers.get('auth')) {
      throw new Error(`register failed: ${res.status} ${res.text}`);
    }
    return new Session(this, res.headers.get('auth')!, email, password, res.headers.get('showorg') || undefined);
  }

  async login(email: string, password: string): Promise<Session> {
    const res = await this.post('/auth/login', {
      email,
      password,
      provider: 'LOCAL',
    });
    if (res.status !== 200 || !res.headers.get('auth')) {
      throw new Error(`login failed: ${res.status} ${res.text}`);
    }
    return new Session(this, res.headers.get('auth')!, email, password);
  }

  /** Public API v1 call with an API key (or pos_ OAuth token). */
  publicApi<T = any>(key: string, method: string, path: string, body?: any) {
    return this.request<T>(method, `/public/v1${path}`, {
      body,
      headers: { authorization: key },
    });
  }
}

export class Session {
  constructor(
    readonly api: Api,
    readonly auth: string,
    readonly email: string,
    readonly password: string,
    public showorg?: string
  ) {}

  private withAuth(options: RequestOptions = {}): RequestOptions {
    return {
      ...options,
      headers: {
        auth: this.auth,
        ...(this.showorg ? { showorg: this.showorg } : {}),
        ...(options.headers || {}),
      },
    };
  }

  request<T = any>(method: string, path: string, options?: RequestOptions) {
    return this.api.request<T>(method, path, this.withAuth(options));
  }
  get<T = any>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }
  post<T = any>(path: string, body?: any, options: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...options, body });
  }
  put<T = any>(path: string, body?: any, options: RequestOptions = {}) {
    return this.request<T>('PUT', path, { ...options, body });
  }
  delete<T = any>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * The Join question for an invite this browser holds (GET /user/invite),
   * as the /invite page asks it: the token in the httpOnly invite_pending
   * cookie that the proxy sets on the GET of /invite/<token>.
   */
  inviteQuestion<T = any>(token: string) {
    return this.get<T>('/user/invite', { cookies: { invite_pending: token } });
  }

  /**
   * Presses Join on the question for `token`, as the /invite page does
   * (since 25 Oct 2026 the only way a signed-in account joins a team): JSON,
   * the app's Origin, the invite in its cookie and the `ref` naming that
   * invite. The ref is worked out from the token, as anyone holding a link
   * can, so a used or forged link is pressed as hard as a fresh one.
   * `ref` and `origin` override those, for the tests that try otherwise.
   */
  async acceptInvite<T = any>(token: string, opts: { ref?: string; origin?: string } = {}) {
    const ref = opts.ref ?? inviteRef(token);
    return this.post<T>(
      '/user/invite/accept',
      { ref },
      {
        cookies: { invite_pending: token },
        headers: { origin: opts.origin ?? appOrigin() },
      }
    );
  }

  async self() {
    const res = await this.get('/user/self');
    if (res.status !== 200) throw new Error(`/user/self ${res.status} ${res.text}`);
    return res.body as { id: string; orgId: string; email: string; [k: string]: any };
  }
}
