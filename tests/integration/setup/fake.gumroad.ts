/**
 * A Gumroad API on 127.0.0.1, answering the two calls Hookpost makes the way
 * Gumroad documents them (gumroad.com/api, Licenses and Sales):
 *
 *   POST /licenses/verify  form: product_id, license_key, increment_uses_count
 *       200 { success, uses, purchase: {...} }, or 404 { success: false,
 *       message } for an unknown key ("That license does not exist for the
 *       provided product."), a disabled one ("This license key has been
 *       disabled.") or a revoked purchase ("Access to the purchase associated
 *       with this license has expired.").
 *   GET /sales/:id         Authorization: Bearer <token>
 *       200 { success, sale: { id, product_id, license_key, ... } }, 401 for
 *       another token, 404 for an unknown sale.
 *
 * install() starts it and points GumroadClient at it, so the real client
 * (fetch, form encoding, status handling) runs; nothing reaches gumroad.com.
 * A test adds licenses with addLicense() and changes them (refund, cancel)
 * by editing the returned purchase. Used by the integration suite and the
 * E2E backend (tests/e2e/server/backend.ts).
 */
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { GumroadClient } from '@hookpost/nestjs-libraries/services/gumroad.client';

export interface FakeLicense {
  key: string;
  productId: string;
  uses: number;
  disabled: boolean;
  revoked: boolean;
  /** The purchase as /licenses/verify returns it; edit to refund or cancel. */
  purchase: Record<string, any>;
}

let seq = 0;
const run = Math.random().toString(36).slice(2, 6).toUpperCase();
const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');

export class FakeGumroad {
  licenses: FakeLicense[] = [];
  calls: Array<{ method: string; path: string; form?: Record<string, string>; auth?: string }> = [];
  /** The access token GET /sales accepts. */
  token = 'gumroad-integration-token';
  /** Answer 503 to everything, as an outage would. */
  down = false;
  /** Hold every answer this long, so calls made at once really overlap. */
  delayMs = 0;
  private server?: Server;
  private originalBase?: string;

  async install(): Promise<this> {
    if (this.server) return this;
    this.server = createServer((req, res) => {
      this.handle(req)
        .then(({ status, body }) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        })
        .catch((e) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, message: String(e) }));
        });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.originalBase = GumroadClient.apiBase;
    GumroadClient.apiBase = `http://127.0.0.1:${port}`;
    return this;
  }

  async uninstall() {
    if (this.originalBase !== undefined) GumroadClient.apiBase = this.originalBase;
    this.originalBase = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      // fetch keeps its connections alive; close them so the process can exit.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }

  /**
   * A purchase with a license key. recurrence null is a one-time product;
   * every other field defaults to an active membership paid today.
   */
  addLicense(opts: {
    productId: string;
    recurrence?: string | null;
    key?: string;
    purchase?: Record<string, any>;
  }): FakeLicense {
    const n = ++seq;
    const key = opts.key || `${hex(8)}-${hex(8)}-${hex(8)}-${run}${String(n).padStart(4, '0')}`;
    const saleId = `FAKE${run}-sale-${n}==`;
    const license: FakeLicense = {
      key,
      productId: opts.productId,
      uses: 0,
      disabled: false,
      revoked: false,
      purchase: {
        seller_id: 'fake-seller==',
        product_id: opts.productId,
        product_name: 'Hookpost (fake)',
        permalink: 'fake',
        email: `buyer-${n}@gumroad-fake.invalid`,
        price: 1900,
        currency: 'usd',
        quantity: 1,
        sale_id: saleId,
        sale_timestamp: new Date().toISOString(),
        subscription_id: opts.recurrence === null ? null : `fake-sub-${n}==`,
        variants: '',
        license_key: key,
        recurrence: opts.recurrence === undefined ? 'monthly' : opts.recurrence,
        refunded: false,
        disputed: false,
        dispute_won: false,
        id: saleId,
        created_at: new Date().toISOString(),
        custom_fields: [],
        chargebacked: false,
        subscription_ended_at: null,
        subscription_cancelled_at: null,
        subscription_failed_at: null,
        ...opts.purchase,
      },
    };
    this.licenses.push(license);
    return license;
  }

  verifyCalls(key?: string) {
    return this.calls.filter(
      (c) => c.path === '/licenses/verify' && (!key || c.form?.license_key === key)
    );
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: any }> {
    const url = new URL(req.url || '/', 'http://fake');
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
    const form = Object.fromEntries(new URLSearchParams(raw));
    const auth = String(req.headers.authorization || '');
    this.calls.push({
      method: req.method || '',
      path: url.pathname,
      ...(raw ? { form } : {}),
      ...(auth ? { auth } : {}),
    });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.down) return { status: 503, body: { success: false, message: 'Service unavailable' } };

    if (req.method === 'POST' && url.pathname === '/licenses/verify') {
      const license = this.licenses.find(
        (l) => l.productId === form.product_id && l.key === form.license_key
      );
      if (!license) {
        return {
          status: 404,
          body: { success: false, message: 'That license does not exist for the provided product.' },
        };
      }
      if (license.disabled) {
        return { status: 404, body: { success: false, message: 'This license key has been disabled.' } };
      }
      if (license.revoked) {
        return {
          status: 404,
          body: {
            success: false,
            message: 'Access to the purchase associated with this license has expired.',
          },
        };
      }
      // Gumroad: anything but "false" counts a use.
      if (form.increment_uses_count !== 'false') license.uses++;
      return { status: 200, body: { success: true, uses: license.uses, purchase: license.purchase } };
    }

    const sale = /^\/sales\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && sale) {
      if (auth !== `Bearer ${this.token}`) {
        return { status: 401, body: { success: false, message: 'The access token is invalid' } };
      }
      const id = decodeURIComponent(sale[1]);
      const license = this.licenses.find((l) => l.purchase.sale_id === id);
      if (!license) return { status: 404, body: { success: false, message: 'Not found' } };
      return {
        status: 200,
        body: {
          success: true,
          sale: {
            id,
            product_id: license.productId,
            license_key: license.key,
            license_disabled: license.disabled,
            license_uses: license.uses,
            refunded: !!license.purchase.refunded,
            chargedback: !!license.purchase.chargebacked,
            subscription_id: license.purchase.subscription_id,
          },
        },
      };
    }
    return { status: 404, body: { success: false, message: `No route ${req.method} ${url.pathname}` } };
  }
}
