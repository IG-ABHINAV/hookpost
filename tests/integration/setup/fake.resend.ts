/**
 * Stands in for the `resend` package in the integration suite (jest
 * moduleNameMapper) and in the E2E backend (tests/e2e/server/register.cjs).
 *
 * Most emails leave the backend as a Temporal signal (FakeTemporal records
 * those), but some go straight to Resend: billing notices from
 * razorpay.service.ts (welcome, payment failed, trial ended), the support
 * ticket notification and auto-reply (support-tickets.service.ts), and
 * ResendProvider when EMAIL_PROVIDER=resend. Here each send is recorded and
 * answers like a successful Resend call; nothing reaches api.resend.com.
 *
 * The record lives on globalThis: one list per jest test file, one for the
 * E2E backend process (served on its control port as GET /resend).
 */
export interface ResendSend {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  [key: string]: unknown;
}

const KEY = '__hookpostFakeResendSends';

function store(): ResendSend[] {
  const g = globalThis as unknown as Record<string, ResendSend[]>;
  return (g[KEY] ||= []);
}

/** Every email sent through `resend` since the last clear, oldest first. */
export const resendSends = (): ResendSend[] => [...store()];

/** The ones addressed to `email` (case-insensitive). */
export const resendSendsTo = (email: string): ResendSend[] =>
  store().filter((m) =>
    [m.to].flat().some((to) => String(to).toLowerCase() === email.toLowerCase())
  );

export const clearResendSends = (): void => {
  store().length = 0;
};

/**
 * Make Resend fail, for the "email provider down" tests: 'error' answers
 * like Resend's API refusing (`{ error }`), 'throw' like the network failing.
 * Nothing is recorded while it fails. null puts it back.
 */
const FAIL_KEY = '__hookpostFakeResendFailure';
export const setResendFailure = (mode: 'error' | 'throw' | null): void => {
  (globalThis as any)[FAIL_KEY] = mode;
};

export class Resend {
  readonly emails = {
    send: async (payload: ResendSend) => {
      const failure = (globalThis as any)[FAIL_KEY];
      if (failure === 'throw') throw new Error('fake Resend: connect ETIMEDOUT');
      if (failure === 'error') {
        return { data: null, error: { name: 'internal_server_error', message: 'fake Resend is down' } };
      }
      store().push({ ...payload });
      return { data: { id: `fake-resend-${store().length}` }, error: null };
    },
  };

  readonly batch = {
    send: async (payloads: ResendSend[]) => {
      const data = payloads.map((p) => {
        store().push({ ...p });
        return { id: `fake-resend-${store().length}` };
      });
      return { data: { data }, error: null };
    },
  };

  constructor(readonly apiKey?: string) {}
}

export default Resend;
