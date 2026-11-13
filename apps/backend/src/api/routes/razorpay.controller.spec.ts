import 'reflect-metadata';
import { createHmac } from 'crypto';

// Forwarding Tablamigo's events from Hookpost's Razorpay webhook. fetch and
// Razorpay are fakes; nothing leaves the machine.

jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
const mockRequest = jest.fn();
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

import { RazorpayController } from './razorpay.controller';
import {
  forwardToTablamigo,
  isTablamigoEvent,
  signForward,
  TABLAMIGO_FORWARD_HEADER,
} from '@hookpost/nestjs-libraries/services/tablamigo.forward';

const SECRET = 'forward-secret-for-tests';
const tick = () => new Promise((r) => setTimeout(r, 0));

const tmSub = { id: 'sub_tm', notes: { service: 'tablamigo', user_id: 'u1' } };
const tmPay = { id: 'pay_tm', notes: { service: 'tablamigo', user_id: 'u1' } };

function controller() {
  const service = {
    validateRequest: jest.fn((raw: Buffer) => JSON.parse(raw.toString('utf8'))),
    handleWebhook: jest.fn(async () => ({ ok: true, handled: true })),
  };
  return { ctrl: new RazorpayController(service as any), service };
}
const req = (event: any) => {
  const raw = Buffer.from(JSON.stringify(event));
  return { raw, req: { rawBody: raw, headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': 'evt_1' } } as any };
};

let fetchMock: jest.Mock;
beforeEach(() => {
  process.env.TABLAMIGO_FORWARD_SECRET = SECRET;
  delete process.env.TABLAMIGO_FORWARD_URL;
  mockRequest.mockReset();
  fetchMock = jest.fn(async () => new Response('{"ok":true}', { status: 200 }));
  (global as any).fetch = fetchMock;
});

describe('Tablamigo forwarding', () => {
  it('forwards a Tablamigo subscription event byte for byte, signed, and Hookpost does not handle it', async () => {
    const { ctrl, service } = controller();
    const { raw, req: r } = req({ event: 'subscription.cancelled', payload: { subscription: { entity: tmSub } } });
    expect(await ctrl.webhook(r)).toEqual({ ok: true });
    await tick();
    expect(service.handleWebhook).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tablamigo-api.hookstep.in/billing/razorpay/webhook');
    expect(Buffer.compare(init.body, raw)).toBe(0);
    expect(init.headers[TABLAMIGO_FORWARD_HEADER]).toBe(createHmac('sha256', SECRET).update(raw).digest('hex'));
    expect(init.headers['x-razorpay-event-id']).toBe('evt_1');
    expect(init.signal).toBeDefined();
  });

  it('a refund event without a payment is identified by fetching the payment', async () => {
    mockRequest.mockResolvedValue(tmPay);
    const { ctrl, service } = controller();
    const { req: r } = req({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_tm', notes: { comment: '' } } } } });
    await ctrl.webhook(r);
    await tick(); await tick();
    expect(mockRequest).toHaveBeenCalledWith('GET', '/payments/pay_tm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The refund itself carries no service tag, so Hookpost's handler still sees
    // it and rejects it there by the payment's notes.
    expect(service.handleWebhook).toHaveBeenCalled();
  });

  it('never forwards a Hookpost event', async () => {
    const { ctrl, service } = controller();
    const { req: r } = req({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_h', notes: { service: 'hookpost' } } } } });
    expect(await ctrl.webhook(r)).toEqual({ ok: true, handled: true });
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.handleWebhook).toHaveBeenCalled();
  });

  it('a hanging or failing Tablamigo never delays or fails the webhook', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const { ctrl } = controller();
    const { req: r } = req({ event: 'payment.captured', payload: { payment: { entity: tmPay } } });
    const started = Date.now();
    expect(await ctrl.webhook(r)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const logs: string[] = [];
    expect(await forwardToTablamigo(Buffer.from('{}'), { event: 'x', payload: { payment: { entity: tmPay } } }, {
      fetchPayment: async () => null, log: (m) => logs.push(m),
    })).toBe('failed');
    expect(logs[0]).toContain('ECONNREFUSED');
  });

  it('does nothing without the shared secret', async () => {
    delete process.env.TABLAMIGO_FORWARD_SECRET;
    const out = await forwardToTablamigo(Buffer.from('{}'), { payload: { payment: { entity: tmPay } } }, { fetchPayment: async () => null, log: () => undefined });
    expect(out).toBe('no_secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('identifies events positively', async () => {
    const none = async () => null;
    expect(await isTablamigoEvent({ payload: { payment: { entity: { notes: [] } } } }, none)).toBe(false);
    expect(await isTablamigoEvent({ payload: { subscription: { entity: { notes: { service: 'vetnow' } } } } }, none)).toBe(false);
    expect(await isTablamigoEvent({ payload: { order: { entity: { notes: { service: 'tablamigo' } } } } }, none)).toBe(true);
    expect(signForward('abc', 'k')).toBe(createHmac('sha256', 'k').update('abc').digest('hex'));
  });
});

describe('POST /razorpay/verify', () => {
  const body = {
    razorpay_payment_id: 'pay_1',
    razorpay_subscription_id: 'sub_1',
    razorpay_signature: 'sig',
  };
  const verifyWith = (sync: () => Promise<any>, valid = true) => {
    const service = {
      syncSubscriptionById: jest.fn(sync),
      noteInternationalInrAuth: jest.fn(async () => false),
    };
    const ctrl = new RazorpayController(service as any);
    (ctrl as any).client = { verifySubscriptionPayment: jest.fn(() => valid) };
    return { ctrl, service };
  };

  it('says whether the checkout started a new trial', async () => {
    const { ctrl, service } = verifyWith(async () => ({ ok: true, trial: true }));
    expect(await ctrl.verify(body)).toEqual({ ok: true, trial: true });
    expect(service.syncSubscriptionById).toHaveBeenCalledWith('sub_1');
  });

  it('a plan that charges now, or a switch during a trial, is not a new trial', async () => {
    const { ctrl } = verifyWith(async () => ({ ok: true, trial: false }));
    expect(await ctrl.verify(body)).toEqual({ ok: true, trial: false });
  });

  it('when the sync fails the answer is still ok, and not a trial', async () => {
    const { ctrl } = verifyWith(async () => {
      throw new Error('Razorpay down');
    });
    expect(await ctrl.verify(body)).toEqual({ ok: true, trial: false });
  });

  it('a bad signature is refused before anything is synced', async () => {
    const { ctrl, service } = verifyWith(async () => ({ ok: true, trial: true }), false);
    await expect(ctrl.verify(body)).rejects.toThrow('Invalid payment signature');
    expect(service.syncSubscriptionById).not.toHaveBeenCalled();
    expect(service.noteInternationalInrAuth).not.toHaveBeenCalled();
  });

  // PR-4: a foreign card on a rupee mandate is logged, never refused.
  it('checks the card of a verified payment without waiting for it', async () => {
    let release: (v: boolean) => void = () => undefined;
    const { ctrl, service } = verifyWith(async () => ({ ok: true, trial: true }));
    service.noteInternationalInrAuth.mockImplementation(
      () => new Promise<boolean>((r) => (release = r))
    );
    // Answers while the card check is still pending.
    expect(await ctrl.verify(body)).toEqual({ ok: true, trial: true });
    expect(service.noteInternationalInrAuth).toHaveBeenCalledWith('sub_1', 'pay_1');
    release(true);
  });
});
