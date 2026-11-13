/**
 * The two Gumroad API calls Hookpost makes, over plain fetch like
 * RazorpayClient: verifying a license key (POST /v2/licenses/verify, no
 * token needed) and reading a sale back (GET /v2/sales/:id, needs an access
 * token with the view_sales scope). Answers come back as status and parsed
 * body; what they mean is decided in gumroad.license.ts. Only a request that
 * never got an answer (network, timeout) throws.
 *
 * Neither the license key nor the token is ever put in a URL or a message.
 */

export class GumroadUnavailableError extends Error {}

export interface GumroadAnswer {
  status: number;
  body: any;
}

export class GumroadClient {
  /**
   * Where the API is. The integration and E2E suites point it at their local
   * fake (tests/integration/setup/fake.gumroad.ts); nothing else changes it.
   */
  static apiBase = 'https://api.gumroad.com/v2';
  static timeoutMs = 10_000;

  verifyLicense(
    productId: string,
    licenseKey: string,
    incrementUsesCount: boolean
  ): Promise<GumroadAnswer> {
    return this.request('POST', '/licenses/verify', {
      form: {
        product_id: productId,
        license_key: licenseKey,
        increment_uses_count: incrementUsesCount ? 'true' : 'false',
      },
    });
  }

  getSale(saleId: string, accessToken: string): Promise<GumroadAnswer> {
    return this.request('GET', `/sales/${encodeURIComponent(saleId)}`, {
      token: accessToken,
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { form?: Record<string, string>; token?: string }
  ): Promise<GumroadAnswer> {
    let res: Response;
    try {
      res = await fetch(`${GumroadClient.apiBase}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.form
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.form ? { body: new URLSearchParams(options.form).toString() } : {}),
        signal: AbortSignal.timeout(GumroadClient.timeoutMs),
      });
    } catch (e: any) {
      throw new GumroadUnavailableError(
        `Gumroad ${method} ${path.split('/').slice(0, 2).join('/')} got no answer: ${
          e?.name || 'error'
        }`
      );
    }
    const raw = await res.text().catch(() => '');
    let body: any = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: `Gumroad answered ${res.status} with a non-JSON body.` };
      }
    }
    return { status: res.status, body };
  }
}
