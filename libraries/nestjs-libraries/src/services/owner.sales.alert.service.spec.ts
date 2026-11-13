import 'reflect-metadata';
import {
  OwnerSalesAlertService,
  ownerAlertRecipients,
  razorpayKeyTestReason,
} from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import {
  amountLabel,
  cleanLine,
  defang,
  OwnerSaleAlert,
  ownerSaleAlertEmail,
  planLabel,
} from '@hookpost/nestjs-libraries/emails/templates/owner.sales.alert.email';

// The owner's sale alert on its own: who it goes to, exactly-once, what it
// says, and that nothing it does can throw into a webhook. Redis and Resend
// are fakes; nothing leaves the machine.

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);

const redisData = new Map<string, string>();
const redisLists = new Map<string, string[]>();
let redisDown = false;
let listsDown = false;
// ioredis with maxRetriesPerRequest: null queues commands while Redis is away.
let redisHangs = false;
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (redisHangs) return new Promise(() => undefined);
      // A network round trip, so two callers interleave.
      await new Promise((r) => setImmediate(r));
      if (redisDown) throw new Error('ECONNREFUSED');
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      if (redisDown) throw new Error('ECONNREFUSED');
      return redisData.delete(key) ? 1 : 0;
    }),
    get: jest.fn(async (key: string) => {
      if (redisHangs) return new Promise(() => undefined);
      return redisData.get(key) ?? null;
    }),
    rpush: jest.fn(async (key: string, value: string) => {
      if (redisDown || listsDown) throw new Error('ECONNREFUSED');
      const list = redisLists.get(key) || [];
      list.push(value);
      redisLists.set(key, list);
      return list.length;
    }),
    lpop: jest.fn(async (key: string) => {
      if (redisDown || listsDown) throw new Error('ECONNREFUSED');
      return redisLists.get(key)?.shift() ?? null;
    }),
    expire: jest.fn(async () => 1),
  },
}));
const pending = () => redisLists.get('owner-sales-alert:pending') || [];

const sent: any[] = [];
let resendMode: 'ok' | 'error' | 'throw' = 'ok';
const mockSend = jest.fn(async (msg: any) => {
  if (resendMode === 'throw') throw new Error('getaddrinfo ENOTFOUND api.resend.com');
  if (resendMode === 'error') {
    return { data: null, error: { name: 'internal_server_error', message: 'Resend is down' } };
  }
  sent.push(msg);
  return { data: { id: `email_${sent.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const ORG = 'org-7c1f';
const OWNER = 'owner@example.com';

function facts(extra: any = {}) {
  return {
    id: ORG,
    name: 'Chai Point Social',
    createdAt: new Date('2026-10-20T10:00:00Z'),
    users: [
      {
        role: 'SUPERADMIN',
        user: {
          id: 'user-owner',
          email: 'priya@chaipoint.in',
          name: 'Priya',
          lastName: 'Shah',
          signupCountry: 'IN',
          isSuperAdmin: false,
          deletedAt: null,
        },
      },
      {
        role: 'ADMIN',
        user: {
          id: 'user-buyer',
          email: 'ravi@chaipoint.in',
          name: 'Ravi',
          lastName: null,
          signupCountry: 'AE',
          isSuperAdmin: false,
          deletedAt: null,
        },
      },
    ],
    ...extra,
  };
}

function setup(opts: { facts?: any; factsError?: boolean; attribution?: any } = {}) {
  const attribution =
    opts.attribution === undefined
      ? {
          method: 'google',
          utmSource: 'meta',
          utmMedium: 'paid',
          utmCampaign: 'reel-oct',
          fbclid: 'IwAR123',
          gclid: null,
          landingPath: '/mcp',
          country: 'IN',
          device: 'android',
        }
      : opts.attribution;
  const organizations = {
    getSaleAlertFacts: jest.fn(async () => {
      if (opts.factsError) throw new Error('db down');
      const f = opts.facts === undefined ? facts() : opts.facts;
      return f ? { ...f, attribution } : f;
    }),
  };
  const service = new OwnerSalesAlertService(organizations as any);
  service.retryDelaysMs = [0, 1, 1];
  return { service, organizations };
}

const trialAlert = (extra: Partial<OwnerSaleAlert> = {}): OwnerSaleAlert => ({
  event: 'TRIAL_STARTED',
  key: 'start:sub_TrORHomuXcb1gG',
  source: 'razorpay',
  organizationId: ORG,
  tier: 'STANDARD',
  period: 'MONTHLY',
  amount: 599,
  currency: 'INR',
  amountNote: 'first charge on 26 Oct 2026',
  paymentMethod: 'upi',
  ids: { subscription: 'sub_TrORHomuXcb1gG' },
  ...extra,
});

beforeEach(() => {
  redisData.clear();
  redisLists.clear();
  redisDown = false;
  listsDown = false;
  redisHangs = false;
  sent.length = 0;
  resendMode = 'ok';
  mockSend.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  process.env.OWNER_SALES_ALERT_EMAIL = OWNER;
  process.env.RAZORPAY_KEY_ID = 'rzp_live_abc';
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
});

afterAll(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_SALES_ALERT_EMAIL;
  delete process.env.RAZORPAY_KEY_ID;
});

describe('recipients and switches', () => {
  it('reads one or several addresses and drops anything malformed', () => {
    expect(ownerAlertRecipients({ OWNER_SALES_ALERT_EMAIL: 'a@x.com' } as any)).toEqual(['a@x.com']);
    expect(
      ownerAlertRecipients({ OWNER_SALES_ALERT_EMAIL: ' a@x.com, b@y.in ;bad, c@ ,"x"@z.com' } as any)
    ).toEqual(['a@x.com', 'b@y.in']);
    expect(ownerAlertRecipients({} as any)).toEqual([]);
  });

  it('is off without OWNER_SALES_ALERT_EMAIL: nothing sent, nothing claimed', async () => {
    delete process.env.OWNER_SALES_ALERT_EMAIL;
    const { service } = setup();
    expect(await service.notify(trialAlert())).toBe('disabled');
    expect(mockSend).not.toHaveBeenCalled();
    expect(redisData.size).toBe(0);
  });

  it('is off without RESEND_API_KEY', async () => {
    delete process.env.RESEND_API_KEY;
    const { service } = setup();
    expect(await service.notify(trialAlert())).toBe('disabled');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an alert with no key or event', async () => {
    const { service } = setup();
    expect(await service.notify({ ...trialAlert(), key: '  ' })).toBe('invalid');
    expect(await service.notify({ ...trialAlert(), event: '' as any })).toBe('invalid');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a test key is a test; a live key is not', () => {
    expect(razorpayKeyTestReason({ RAZORPAY_KEY_ID: 'rzp_live_x' } as any)).toBeNull();
    expect(razorpayKeyTestReason({ RAZORPAY_KEY_ID: 'rzp_test_x' } as any)).toBe('Razorpay test key');
    expect(razorpayKeyTestReason({} as any)).toBe('Razorpay test key');
  });
});

describe('exactly once', () => {
  it('the same key twice (a Razorpay retry) sends one email', async () => {
    const { service } = setup();
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(await service.notify(trialAlert())).toBe('duplicate');
    expect(sent).toHaveLength(1);
  });

  it('the same key at the same moment (webhook and /razorpay/verify) sends one email', async () => {
    const { service } = setup();
    const outcomes = await Promise.all([
      service.notify(trialAlert()),
      service.notify(trialAlert()),
      service.notify(trialAlert()),
    ]);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('different keys are different emails', async () => {
    const { service } = setup();
    await service.notify(trialAlert());
    await service.notify(trialAlert({ event: 'FIRST_CHARGE', key: 'charge:pay_1' }));
    expect(sent).toHaveLength(2);
  });

  it('Resend down for every attempt: queued with the claim kept; the retry run sends it once', async () => {
    const { service } = setup();
    resendMode = 'error';
    expect(await service.notify(trialAlert())).toBe('queued');
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(pending()).toHaveLength(1);
    // A redelivery meanwhile sends nothing: the claim is kept.
    expect(await service.notify(trialAlert())).toBe('duplicate');

    // Still down at the first run: put back, one more try counted.
    expect(await service.retryPending()).toEqual({ sent: 0, requeued: 1, dropped: 0 });
    expect(JSON.parse(pending()[0]).tries).toBe(1);

    resendMode = 'ok';
    expect(await service.retryPending()).toEqual({ sent: 1, requeued: 0, dropped: 0 });
    expect(await service.retryPending()).toEqual({ sent: 0, requeued: 0, dropped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Trial started/);
    expect(sent[0].html).toContain('Trial started');
    expect(sent[0].to).toEqual([OWNER]);
  });

  it('a queued alert is dropped (and logged) after the last try', async () => {
    const { service } = setup();
    resendMode = 'error';
    await service.notify(trialAlert());
    const item = JSON.parse(pending()[0]);
    redisLists.set('owner-sales-alert:pending', [JSON.stringify({ ...item, tries: 47 })]);
    expect(await service.retryPending()).toEqual({ sent: 0, requeued: 0, dropped: 1 });
    expect(pending()).toHaveLength(0);
  });

  it('the queue cannot be written: the claim is given back, so a redelivery can send it', async () => {
    const { service } = setup();
    resendMode = 'error';
    listsDown = true;
    expect(await service.notify(trialAlert())).toBe('failed');
    expect(redisData.size).toBe(0);
    resendMode = 'ok';
    listsDown = false;
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('a garbled queue entry is skipped, the next one still goes', async () => {
    const { service } = setup();
    resendMode = 'error';
    await service.notify(trialAlert());
    redisLists.get('owner-sales-alert:pending')!.unshift('{not json');
    resendMode = 'ok';
    expect(await service.retryPending()).toEqual({ sent: 1, requeued: 0, dropped: 0 });
  });

  it('the retry run with Redis down does nothing and does not throw', async () => {
    const { service } = setup();
    redisDown = true;
    await expect(service.retryPending()).resolves.toEqual({ sent: 0, requeued: 0, dropped: 0 });
  });

  it('retries a transient failure and sends once', async () => {
    const { service } = setup();
    let calls = 0;
    mockSend.mockImplementationOnce(async () => {
      calls++;
      throw new Error('socket hang up');
    });
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(calls).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('Redis down: the owner still hears about the sale', async () => {
    const { service } = setup();
    redisDown = true;
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('the cancel mark', () => {
  it('marks, reads and clears', async () => {
    const { service } = setup();
    expect(await service.isMarked('cancel:sub_1')).toBe(false);
    await service.mark('cancel:sub_1');
    expect(await service.isMarked('cancel:sub_1')).toBe(true);
    await service.unmark('cancel:sub_1');
    expect(await service.isMarked('cancel:sub_1')).toBe(false);
  });

  it('Redis not answering: mark and isMarked give up within a second (the Cancel button never hangs)', async () => {
    const { service } = setup();
    redisHangs = true;
    const started = Date.now();
    await service.mark('cancel:sub_1');
    expect(await service.isMarked('cancel:sub_1')).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('never throws', () => {
  it('Resend throwing on every attempt resolves (queued), it does not reject', async () => {
    const { service } = setup();
    resendMode = 'throw';
    await expect(service.notify(trialAlert())).resolves.toBe('queued');
  });

  it('Resend throwing and Redis down: resolves "failed", never rejects', async () => {
    const { service } = setup();
    resendMode = 'throw';
    redisDown = true;
    await expect(service.notify(trialAlert())).resolves.toBe('failed');
  });

  it('the database failing still sends the alert, with what is known', async () => {
    const { service } = setup({ factsError: true });
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(sent[0].text).toMatch(/could not be read/);
    expect(sent[0].text).toMatch(/sub_TrORHomuXcb1gG/);
    expect(sent[0].text).toMatch(/₹599/);
  });

  it('an unknown workspace still sends', async () => {
    const { service } = setup({ facts: null, attribution: null });
    expect(await service.notify(trialAlert())).toBe('sent');
    expect(sent[0].text).toMatch(/Signup source: not recorded/);
  });
});

describe('what the email says', () => {
  it('a live trial: subject, plan, amount, customer, source, ids, admin link', async () => {
    const { service } = setup();
    await service.notify(trialAlert());
    const [m] = sent;
    expect(m.to).toEqual([OWNER]);
    expect(m.from).toBe('Hookpost Alerts <support@hookstep.in>');
    expect(m.reply_to).toBeUndefined();
    expect(m.subject).toBe('Trial started: Standard monthly, ₹599 · Priya Shah');
    expect(m.subject).not.toMatch(/[[\]]/);
    // Live money: no badge anywhere.
    expect(m.text).not.toMatch(/Test mode|Internal workspace|TEST/);
    expect(m.html).not.toContain('data-hp-badge');
    expect(m.html).toContain('brand-logo-96.png');
    expect(m.html).toContain('>Trial started: Standard monthly, ₹599</h1>');
    expect(m.text).toContain('Amount: ₹599, first charge on 26 Oct 2026');
    expect(m.text).toContain('Priya Shah approved a mandate for Standard monthly. Nothing has been charged yet.');
    expect(m.text).toContain('Plan: Standard monthly');
    expect(m.text).toContain('Customer: Priya Shah');
    expect(m.text).toContain('Email: priya@chaipoint.in');
    expect(m.text).toContain('Workspace: Chai Point Social');
    expect(m.text).toContain(`Workspace id: ${ORG}`);
    expect(m.text).toContain('Signup country: IN');
    expect(m.text).toContain('utm_campaign=reel-oct');
    expect(m.text).toContain('fbclid=IwAR123');
    expect(m.text).toContain('Razorpay subscription: sub_TrORHomuXcb1gG');
    expect(m.text).toContain(`Open in admin: https://hookpost.hookstep.in/admin/users?q=${ORG}`);
    expect(m.html).toContain(`href="https://hookpost.hookstep.in/admin/users?q=${ORG}"`);
    expect(m.text).toContain('https://dashboard.razorpay.com/app/subscriptions/sub_TrORHomuXcb1gG');
  });

  it('names the member who checked out, not the first member', async () => {
    const { service } = setup();
    await service.notify(trialAlert({ userId: 'user-buyer' }));
    expect(sent[0].subject).toContain('· Ravi');
    expect(sent[0].text).toContain('Email: ravi@chaipoint.in');
    expect(sent[0].text).toContain('Signup country: AE');
  });

  it('a test key: a small "Test mode" badge, never in the subject', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    const { service } = setup();
    await service.notify(trialAlert());
    expect(sent[0].subject).toBe('Trial started: Standard monthly, ₹599 · Priya Shah');
    expect(sent[0].text).toContain('Test mode: Razorpay test key');
    expect(sent[0].html).toMatch(/data-hp-badge[^>]*>Test mode<\/span>/);
  });

  it('a live key is never labelled test', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc';
    const { service } = setup();
    await service.notify(trialAlert());
    expect(`${sent[0].subject}${sent[0].text}${sent[0].html}`).not.toMatch(/test mode|\[TEST\]/i);
  });

  it('an internal workspace (a platform super admin member) on a live key is real money: INTERNAL, never TEST', async () => {
    const f = facts();
    f.users[1].user.isSuperAdmin = true;
    const { service } = setup({ facts: f });
    await service.notify(trialAlert());
    expect(sent[0].subject.startsWith('Trial started')).toBe(true);
    expect(sent[0].text).toContain('Internal workspace');
    expect(sent[0].html).toMatch(/data-hp-badge[^>]*>Internal workspace<\/span>/);
    expect(`${sent[0].subject}${sent[0].text}${sent[0].html}`).not.toMatch(/test mode/i);
  });

  it('a workspace on FREE_PLAN_SUNSET_EXEMPT_ORGS on a live key is INTERNAL', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `other, ${ORG}`;
    const { service } = setup();
    await service.notify(trialAlert());
    expect(sent[0].text).toContain('Internal workspace');
    expect(sent[0].text).not.toMatch(/test mode/i);
  });

  it('a super admin member whose account is deleted does not make it internal', async () => {
    const f = facts();
    f.users[1].user.isSuperAdmin = true;
    (f.users[1].user as any).deletedAt = new Date();
    const { service } = setup({ facts: f });
    await service.notify(trialAlert());
    expect(sent[0].text).not.toMatch(/Internal workspace|Test mode/);
  });

  it('an internal workspace on a test key is fake money: TEST', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    const f = facts();
    f.users[1].user.isSuperAdmin = true;
    const { service } = setup({ facts: f });
    await service.notify(trialAlert());
    expect(sent[0].text).toContain('Test mode: Razorpay test key');
    expect(sent[0].text).not.toContain('Internal workspace');
  });

  it('a Gumroad test purchase is labelled, whatever the Razorpay key', async () => {
    const { service } = setup();
    await service.notify({
      event: 'GUMROAD_REDEEMED',
      key: 'gumroad-redeem:sale_1',
      source: 'gumroad',
      organizationId: ORG,
      tier: 'PRO',
      period: 'MONTHLY',
      amount: 29,
      currency: 'usd',
      ids: { sale: 'sale_1', license: 'lic_1' },
      test: true,
    });
    expect(sent[0].subject).toBe('Gumroad license redeemed: Pro monthly, $29 · Priya Shah');
    expect(sent[0].text).toContain('Test mode: Gumroad test purchase');
    expect(sent[0].text).toContain('Gumroad sale: sale_1');
    expect(sent[0].text).not.toMatch(/dashboard\.razorpay\.com/);
  });

  it('a plan change shows both plans', async () => {
    const { service } = setup();
    await service.notify(
      trialAlert({
        event: 'PLAN_CHANGED',
        key: 'plan:sub_2:PRO:YEARLY',
        tier: 'PRO',
        period: 'YEARLY',
        previousTier: 'STANDARD',
        previousPeriod: 'MONTHLY',
        amount: 19990,
        amountNote: 'new plan price per year',
      })
    );
    expect(sent[0].subject).toContain('Plan changed: Standard monthly → Pro yearly, ₹19,990');
    expect(sent[0].text).toContain('Plan: Standard monthly → Pro yearly');
    expect(sent[0].text).toContain('Priya Shah moved from Standard monthly to Pro yearly.');
  });
});

describe('hostile and secret input', () => {
  it('a customer name with newlines cannot add lines or headers', async () => {
    const f = facts();
    f.users[0].user.name = 'Evil\r\nBcc: attacker@x.com\nTest mode: x <b>bold</b>';
    f.name = 'Org\u0000\u2028Name';
    const { service } = setup({ facts: f });
    await service.notify(trialAlert());
    const m = sent[0];
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text.split('\n').some((l: string) => l.startsWith('Test mode'))).toBe(false);
    expect(m.text.split('\n').some((l: string) => l.startsWith('Bcc:'))).toBe(false);
    expect(m.html).not.toContain('<b>bold</b>');
    expect(m.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(m.html).not.toContain('data-hp-badge');
    expect(m.text).toContain('Workspace: Org Name');
  });

  it('links a customer typed (name, workspace, utm values) are not clickable; their email stays as it is', async () => {
    const f = facts();
    f.users[0].user.name = 'Click https://evil.example/login now';
    f.name = 'Visit www.phish.example';
    const { service } = setup({
      facts: f,
      attribution: { utmCampaign: 'http://bad.example/x', referrer: 'https://www.google.com/' },
    });
    await service.notify(trialAlert());
    const all = `${sent[0].subject}\n${sent[0].text}\n${sent[0].html}`;
    expect(all).not.toMatch(/https?:\/\/(evil|bad|www\.google)/);
    expect(all).not.toMatch(/www\.phish\.example/);
    expect(all).toContain('hxxps[://]evil[.]example/login');
    expect(all).toContain('Workspace: Visit www[.]phish[.]example');
    expect(all).toContain('utm_campaign=hxxp[://]bad[.]example/x');
    expect(all).toContain('Email: priya@chaipoint.in');
    // Hookpost's own links are left alone.
    expect(all).toContain(`Open in admin: https://hookpost.hookstep.in/admin/users?q=${ORG}`);
  });

  it('defang', () => {
    expect(defang('https://a.bc/d')).toBe('hxxps[://]a[.]bc/d');
    expect(defang('HTTP://X.ORG')).toBe('hxxp[://]X[.]ORG');
    expect(defang('ftp://files.example')).toBe('ftp[://]files[.]example');
    expect(defang('Acme Inc.')).toBe('Acme Inc.');
    expect(defang('v1.2 rocks')).toBe('v1.2 rocks');
    expect(defang('line\nbreak')).toBe('line break');
  });

  it('subject and lines are capped', () => {
    const long = 'x'.repeat(5000);
    const { subject, text } = ownerSaleAlertEmail(trialAlert({ notes: [long] }), {
      customerName: long,
      orgName: long,
    });
    expect(subject.length).toBeLessThanOrEqual(200);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(420);
  });

  it('only whitelisted fields are written: a payload-shaped alert leaks nothing', () => {
    const payloadish: any = {
      ...trialAlert(),
      // What a careless caller might spread in from a Razorpay payment entity.
      card: { last4: '4242', network: 'Visa', name: 'TEST CARDHOLDER' },
      vpa: 'test@upi',
      contact: '+919000000000',
      token_id: 'token_secret_123',
      signature: 'deadbeef',
      bank: 'HDFC',
      acquirer_data: { rrn: '000000000001' },
    };
    const { subject, text, html } = ownerSaleAlertEmail(payloadish, {});
    const all = `${subject}\n${text}\n${html}`;
    for (const secret of ['4242', 'Visa', 'TEST CARDHOLDER', 'test@upi', '9000000000', 'token_secret', 'deadbeef', 'HDFC', '000000000001']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('helpers', () => {
  it('cleanLine', () => {
    expect(cleanLine(' a \n b\t\u0007c ')).toBe('a b c');
    expect(cleanLine(null)).toBe('');
    expect(cleanLine('abcdef', 4)).toBe('abc…');
  });
  it('planLabel and amountLabel', () => {
    expect(planLabel('STANDARD', 'MONTHLY')).toBe('Standard monthly');
    expect(planLabel('PRO', null)).toBe('Pro');
    expect(planLabel(null, 'YEARLY')).toBe('');
    expect(amountLabel(599, 'INR')).toBe('₹599 INR');
    expect(amountLabel(1, 'usd')).toBe('$1 USD');
    expect(amountLabel(12.5, 'EUR')).toBe('12.50 EUR');
    expect(amountLabel(null, 'INR')).toBe('');
    expect(amountLabel(Number.NaN, 'INR')).toBe('');
  });
});
