import 'reflect-metadata';

// SubscriptionService.personHadBefore and recordBillingIdentities: the
// first-month offer (and the trial) once per person (razorpay.mapping.ts).
// Which tie is followed, what counts, who is never refused. The repository
// is an in-memory fake; tests/integration/billing-first-month-offer-once
// runs the same against Postgres.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.offer-once

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { billingIdentityHash } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

const ORG = 'org-new';
const facts = (extra: any = {}) => ({
  id: ORG,
  createdAt: new Date('2026-10-30T00:00:00Z'),
  allowTrial: true,
  isTrailing: true,
  subscription: null,
  users: [],
  _count: { users: 0 },
  ...extra,
});

/**
 * `had`: the workspaces workspacesThatHad says had it. The other fields are
 * what each lookup finds.
 */
const setup = (o: {
  facts?: any;
  owners?: string[];
  methods?: Array<{ kind: string; hash: string }>;
  recorded?: Array<{ organizationId: string; kind: string }>;
  byChannel?: string[];
  ownedByEmail?: Array<{ email: string; organizationId: string }>;
  had?: string[];
}) => {
  const repo: Record<string, jest.Mock> = {
    getPlanFacts: jest.fn(async () => o.facts ?? facts()),
    ownerEmails: jest.fn(async () => o.owners ?? ['owner@example.com']),
    ownPaymentMethodHashes: jest.fn(async () => o.methods ?? []),
    workspacesWithBillingIdentity: jest.fn(async () => o.recorded ?? []),
    workspacesSharingAnyChannel: jest.fn(async () => o.byChannel ?? []),
    workspacesOwnedByEmail: jest.fn(async () => o.ownedByEmail ?? []),
    workspacesThatHad: jest.fn(async (ids: string[]) =>
      ids.filter((id) => (o.had ?? []).includes(id))
    ),
    saveBillingIdentities: jest.fn(async (rows: any[]) => ({ count: rows.length })),
  };
  const service = new SubscriptionService(repo as any, {} as any, {} as any, {} as any);
  return { service, repo };
};

const ENV = ['FREE_PLAN_SUNSET_EXEMPT_ORGS'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('personHadBefore: the first-month offer once per person', () => {
  it('the no-guard path: a new person with nothing tied to them', async () => {
    const { service, repo } = setup({});
    expect(await service.personHadBefore(ORG)).toEqual({ had: false, by: null, related: [] });
    // The workspace itself is always asked about, with the default sources.
    expect(repo.workspacesThatHad).toHaveBeenCalledWith([ORG], ['PAID', 'OFFER'], expect.any(Set));
  });

  it('the workspace itself had a plan before (cancelled, now buying again)', async () => {
    const { service } = setup({ had: [ORG] });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'workspace' });
  });

  it.each([
    ['plus tag', 'jo.hn+promo@gmail.com', 'john@gmail.com'],
    ['Gmail dots and case', 'J.O.H.N@Gmail.com', 'john@gmail.com'],
    ['googlemail', 'john@googlemail.com', 'john@gmail.com'],
    ['plus tag on another domain', 'ceo+2@acme.in', 'CEO@acme.in'],
  ])('an owner of a workspace that paid, by email (%s)', async (_n, mine, theirs) => {
    const { service, repo } = setup({
      owners: [mine],
      ownedByEmail: [{ email: theirs, organizationId: 'org-paid' }],
      had: ['org-paid'],
    });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'email' });
    // The lookup is narrowed by prefix and domain, and compared exactly here.
    const [, prefix, domains] = repo.workspacesOwnedByEmail.mock.calls[0];
    expect(domains).toContain(theirs.toLowerCase().split('@')[1].replace('googlemail', 'gmail'));
    expect(theirs.toLowerCase().startsWith(prefix)).toBe(true);
  });

  it('a similar address that is another person is not a tie', async () => {
    const { service } = setup({
      owners: ['johnny@gmail.com'],
      ownedByEmail: [{ email: 'john@gmail.com', organizationId: 'org-paid' }],
      had: ['org-paid'],
    });
    expect(await service.personHadBefore(ORG)).toEqual({ had: false, by: null, related: [] });
  });

  it("a deleted account's address (matched by its hash, no @ left) that owned a paying workspace", async () => {
    const { service } = setup({
      ownedByEmail: [{ email: 'deleted_abc_123', organizationId: 'org-gone' }],
      had: ['org-gone'],
    });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'email' });
  });

  it('an owner recorded when another workspace paid (the row outlives the account)', async () => {
    const { service, repo } = setup({
      recorded: [{ organizationId: 'org-old', kind: 'EMAIL' }],
      had: ['org-old'],
    });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'email' });
    const [, keys, sources] = repo.workspacesWithBillingIdentity.mock.calls[0];
    expect(keys).toContainEqual({ kind: 'EMAIL', hash: billingIdentityHash('EMAIL', 'owner@example.com') });
    expect(sources).toEqual(['PAID', 'OFFER']);
  });

  it("a payment method this workspace used that paid elsewhere", async () => {
    const method = { kind: 'UPI', hash: billingIdentityHash('UPI', 'a@ybl') };
    const { service, repo } = setup({
      methods: [method],
      recorded: [{ organizationId: 'org-paid', kind: 'UPI' }],
      had: ['org-paid'],
    });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'method' });
    expect(repo.workspacesWithBillingIdentity.mock.calls[0][1]).toContainEqual(method);
  });

  it('a channel connected (now or before) in a workspace that paid', async () => {
    const { service } = setup({ byChannel: ['org-paid'], had: ['org-paid'] });
    expect(await service.personHadBefore(ORG)).toMatchObject({ had: true, by: 'channel' });
  });

  it('tied workspaces that had nothing come back as related, for the open-checkout check', async () => {
    const { service } = setup({
      byChannel: ['org-free-1'],
      ownedByEmail: [{ email: 'owner@example.com', organizationId: 'org-free-2' }],
    });
    const out = await service.personHadBefore(ORG);
    expect(out.had).toBe(false);
    expect(out.related.sort()).toEqual(['org-free-1', 'org-free-2']);
  });

  it('a disposable email never gets it, whatever else', async () => {
    const { service, repo } = setup({ owners: ['someone@mailinator.com'] });
    expect(await service.personHadBefore(ORG)).toEqual({ had: true, by: 'disposable', related: [] });
    expect(repo.workspacesThatHad).not.toHaveBeenCalled();
  });

  it('one of our own workspaces is never refused: a platform super admin is a member', async () => {
    const { service, repo } = setup({ facts: facts({ _count: { users: 1 } }), had: [ORG] });
    expect(await service.personHadBefore(ORG)).toEqual({ had: false, by: null, related: [] });
    expect(repo.ownerEmails).not.toHaveBeenCalled();
  });

  it('or it is in FREE_PLAN_SUNSET_EXEMPT_ORGS; an exempt workspace never counts against another', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = ORG;
    const internal = setup({ had: [ORG] });
    expect(await internal.service.personHadBefore(ORG)).toMatchObject({ had: false });

    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'org-internal';
    const { service, repo } = setup({ byChannel: ['org-internal'] });
    const out = await service.personHadBefore(ORG);
    expect(repo.workspacesThatHad.mock.calls[0][2].has('org-internal')).toBe(true);
    expect(out.related).toEqual([]);
  });

  it('the trial asks with TRIAL as well (one rule for both)', async () => {
    const { service, repo } = setup({});
    await service.personHadBefore(ORG, ['PAID', 'OFFER', 'TRIAL']);
    expect(repo.workspacesThatHad.mock.calls[0][1]).toEqual(['PAID', 'OFFER', 'TRIAL']);
  });

  it('an unknown workspace: nothing to refuse', async () => {
    const { service } = setup({ facts: null });
    (service as any)._subscriptionRepository.getPlanFacts = jest.fn(async () => null);
    expect(await service.personHadBefore(ORG)).toEqual({ had: false, by: null, related: [] });
  });
});

describe('recordBillingIdentities', () => {
  it('a charge: the workspace, each owner identity once, and the method, hashed', async () => {
    const { service, repo } = setup({ owners: ['Jo.hn+x@gmail.com', 'john@googlemail.com', 'b@acme.in'] });
    await service.recordBillingIdentities(ORG, 'OFFER', {
      payment: { id: 'pay_1', vpa: 'J@YBL' },
      subscriptionId: 'sub_1',
    });
    const rows = repo.saveBillingIdentities.mock.calls[0][0];
    expect(rows.map((r: any) => r.kind)).toEqual(['WORKSPACE', 'EMAIL', 'EMAIL', 'UPI']);
    expect(rows).toContainEqual({
      organizationId: ORG,
      kind: 'EMAIL',
      hash: billingIdentityHash('EMAIL', 'john@gmail.com'),
      source: 'OFFER',
      subscriptionId: 'sub_1',
      paymentId: 'pay_1',
    });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'UPI', hash: billingIdentityHash('UPI', 'j@ybl') }));
    expect(JSON.stringify(rows)).not.toMatch(/ybl|gmail|acme/i);
  });

  it('an ATTEMPT keeps only the method: it claims nothing', async () => {
    const { service, repo } = setup({});
    await service.recordBillingIdentities(ORG, 'ATTEMPT', { payment: { id: 'pay_2', vpa: 'a@ybl' } });
    expect(repo.saveBillingIdentities.mock.calls[0][0].map((r: any) => [r.kind, r.source])).toEqual([
      ['UPI', 'ATTEMPT'],
    ]);
    expect(repo.ownerEmails).not.toHaveBeenCalled();
  });

  it('never throws: a missing table or a failed write is logged and the payment goes on', async () => {
    const { service, repo } = setup({});
    repo.saveBillingIdentities.mockRejectedValueOnce(new Error('relation "BillingIdentity" does not exist'));
    await expect(service.recordBillingIdentities(ORG, 'PAID', {})).resolves.toBeUndefined();
  });
});
