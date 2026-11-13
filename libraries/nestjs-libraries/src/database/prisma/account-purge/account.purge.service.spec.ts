import 'reflect-metadata';
import { createHash } from 'crypto';

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));

import {
  AccountPurgeRepository,
  PURGED_ORGANIZATION_NAME,
} from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.repository';
import {
  AccountPurgeService,
  PurgeFileStore,
} from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.service';

/*
 * An in-memory Prisma: just enough of findMany/findUnique/count/deleteMany/
 * updateMany/update/$transaction, `where` (scalars, null, operators, AND/OR/
 * NOT, relation some/every/none/is/isNot), `select` (nested, _count) and the
 * schema's foreign keys, for the repository's REAL queries to run against
 * seeded rows. Required foreign keys refuse a delete that would orphan a row
 * (as Postgres does), optional ones are set to null.
 */
type Row = Record<string, any>;
type Relation = { model: string; from: string; to: string; many: boolean };
const rel = (model: string, from: string, to: string, many = true): Relation => ({ model, from, to, many });
const RELATIONS: Record<string, Record<string, Relation>> = {
  organization: {
    users: rel('userOrganization', 'id', 'organizationId'),
    post: rel('post', 'id', 'organizationId'),
    media: rel('media', 'id', 'organizationId'),
    Comments: rel('comments', 'id', 'organizationId'),
    signatures: rel('signatures', 'id', 'organizationId'),
    sets: rel('sets', 'id', 'organizationId'),
    webhooks: rel('webhooks', 'id', 'organizationId'),
    autoPost: rel('autoPost', 'id', 'organizationId'),
    thirdParty: rel('thirdParty', 'id', 'organizationId'),
    github: rel('gitHub', 'id', 'organizationId'),
    notifications: rel('notifications', 'id', 'organizationId'),
    tags: rel('tags', 'id', 'orgId'),
    plugs: rel('plugs', 'id', 'organizationId'),
    customers: rel('customer', 'id', 'orgId'),
    credits: rel('credits', 'id', 'organizationId'),
    errors: rel('errors', 'id', 'organizationId'),
    oauthApp: rel('oAuthApp', 'id', 'organizationId'),
    oauthAuthorizations: rel('oAuthAuthorization', 'id', 'organizationId'),
    Integration: rel('integration', 'id', 'organizationId'),
  },
  userOrganization: { user: rel('user', 'userId', 'id', false) },
  media: {
    userPicture: rel('user', 'id', 'pictureId'),
    agencies: rel('socialMediaAgency', 'id', 'logoId'),
    oauthApps: rel('oAuthApp', 'id', 'pictureId'),
  },
  user: {
    items: rel('itemUser', 'id', 'userId'),
    agencies: rel('socialMediaAgency', 'id', 'userId', false),
    oauthAuthorizations: rel('oAuthAuthorization', 'id', 'userId'),
  },
  tagsPosts: { post: rel('post', 'postId', 'id', false) },
  comments: { post: rel('post', 'postId', 'id', false) },
  errors: { post: rel('post', 'postId', 'id', false) },
  integrationsWebhooks: {
    webhook: rel('webhooks', 'webhookId', 'id', false),
    integration: rel('integration', 'integrationId', 'id', false),
  },
  exisingPlugData: { integration: rel('integration', 'integrationId', 'id', false) },
  plugs: { integration: rel('integration', 'integrationId', 'id', false) },
  oAuthAuthorization: { oauthApp: rel('oAuthApp', 'oauthAppId', 'id', false) },
  socialMediaAgency: { user: rel('user', 'userId', 'id', false) },
  socialMediaAgencyNiche: { agency: rel('socialMediaAgency', 'agencyId', 'id', false) },
  affiliate: { commissions: rel('affiliateCommission', 'id', 'affiliateId') },
};
// [child model, column, parent model]
const REQUIRED_FKS: Array<[string, string, string]> = [
  ['comments', 'postId', 'post'],
  ['errors', 'postId', 'post'],
  ['tagsPosts', 'postId', 'post'],
  ['tagsPosts', 'tagId', 'tags'],
  ['post', 'integrationId', 'integration'],
  ['plugs', 'integrationId', 'integration'],
  ['exisingPlugData', 'integrationId', 'integration'],
  ['integrationsWebhooks', 'webhookId', 'webhooks'],
  ['integrationsWebhooks', 'integrationId', 'integration'],
  ['oAuthAuthorization', 'oauthAppId', 'oAuthApp'],
  ['socialMediaAgencyNiche', 'agencyId', 'socialMediaAgency'],
  ['userOrganization', 'organizationId', 'organization'],
  ['affiliateCommission', 'affiliateId', 'affiliate'],
];
const OPTIONAL_FKS: Array<[string, string, string]> = [
  ['user', 'pictureId', 'media'],
  ['socialMediaAgency', 'logoId', 'media'],
  ['oAuthApp', 'pictureId', 'media'],
  ['integration', 'customerId', 'customer'],
  ['post', 'parentPostId', 'post'],
  ['payoutProblems', 'postId', 'post'],
];

const same = (a: any, b: any) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const makeDb = (seed: Record<string, Row[]>) => {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  // Reads never create a table, so a snapshot of `tables` only changes on writes.
  const table = (name: string): Row[] => tables[name] || [];
  const writes: string[] = [];

  const related = (model: string, row: Row, field: string) => {
    const r = RELATIONS[model]?.[field];
    if (!r) throw new Error(`fake prisma: no relation ${model}.${field}`);
    return table(r.model).filter((x) => x[r.to] !== null && x[r.to] !== undefined && x[r.to] === row[r.from]);
  };

  const matchScalar = (value: any, cond: any): boolean => {
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond).every(([op, arg]: [string, any]) => {
      const missing = value === null || value === undefined;
      switch (op) {
        case 'equals': return matchScalar(value, arg);
        case 'not': return arg === null ? !missing : !missing && !matchScalar(value, arg);
        case 'in': return !missing && arg.some((a: any) => same(value, a));
        case 'notIn': return !missing && !arg.some((a: any) => same(value, a));
        case 'lt': return !missing && value < arg;
        case 'lte': return !missing && value <= arg;
        case 'gt': return !missing && value > arg;
        case 'gte': return !missing && value >= arg;
        case 'startsWith': return !missing && String(value).startsWith(arg);
        case 'endsWith': return !missing && String(value).endsWith(arg);
        case 'contains': return !missing && String(value).includes(arg);
        default: throw new Error(`fake prisma: operator ${op}`);
      }
    });
  };

  const match = (model: string, row: Row, where: any): boolean =>
    Object.entries(where || {}).every(([key, cond]: [string, any]) => {
      if (key === 'AND') return [].concat(cond).every((w: any) => match(model, row, w));
      if (key === 'OR') return cond.some((w: any) => match(model, row, w));
      if (key === 'NOT') return ![].concat(cond).some((w: any) => match(model, row, w));
      const r = RELATIONS[model]?.[key];
      if (!r) return matchScalar(row[key], cond);
      const rows = related(model, row, key);
      if (r.many) {
        if ('some' in cond) return rows.some((x) => match(r.model, x, cond.some));
        if ('every' in cond) return rows.every((x) => match(r.model, x, cond.every));
        if ('none' in cond) return !rows.some((x) => match(r.model, x, cond.none));
        throw new Error(`fake prisma: list filter on ${model}.${key}`);
      }
      const one = rows[0];
      if (cond === null) return !one;
      if ('isNot' in cond) return cond.isNot === null ? !!one : !one || !match(r.model, one, cond.isNot);
      if ('is' in cond) return cond.is === null ? !one : !!one && match(r.model, one, cond.is);
      return !!one && match(r.model, one, cond);
    });

  const pick = (model: string, row: Row, select?: any): Row => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, spec] of Object.entries(select) as Array<[string, any]>) {
      if (!spec) continue;
      if (key === '_count') {
        out._count = {};
        for (const field of Object.keys(spec.select)) {
          out._count[field] = related(model, row, field).length;
        }
        continue;
      }
      const r = RELATIONS[model]?.[key];
      if (!r) {
        out[key] = row[key];
        continue;
      }
      const rows = related(model, row, key).filter((x) => !spec.where || match(r.model, x, spec.where));
      const shape = (x: Row) => pick(r.model, x, spec === true ? undefined : spec.select);
      out[key] = r.many ? rows.map(shape) : rows[0] ? shape(rows[0]) : null;
    }
    return out;
  };

  const remove = (model: string, doomed: Row[]) => {
    const ids = new Set(doomed.map((r) => r.id));
    for (const [child, column, parent] of REQUIRED_FKS) {
      if (parent !== model) continue;
      const orphan = table(child).find((c) => ids.has(c[column]) && !(child === model && ids.has(c.id)));
      if (orphan) {
        throw new Error(`foreign key ${child}.${column} still points at ${model} ${orphan[column]}`);
      }
    }
    for (const [child, column, parent] of OPTIONAL_FKS) {
      if (parent !== model) continue;
      table(child).forEach((c) => {
        if (ids.has(c[column])) c[column] = null;
      });
    }
    if (tables[model]) tables[model] = tables[model].filter((r) => !doomed.includes(r));
  };

  const delegate = (model: string) => ({
    findMany: jest.fn(async (args: any = {}) => {
      let rows = table(model).filter((r) => match(model, r, args.where));
      if (args.orderBy) {
        const [[field, dir]] = Object.entries(args.orderBy) as any;
        rows = [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) => pick(model, r, args.select));
    }),
    findUnique: jest.fn(async (args: any) => {
      const row = table(model).find((r) => match(model, r, args.where));
      return row ? pick(model, row, args.select) : null;
    }),
    count: jest.fn(async (args: any = {}) => table(model).filter((r) => match(model, r, args.where)).length),
    deleteMany: jest.fn(async (args: any = {}) => {
      writes.push(`${model}.deleteMany`);
      const doomed = table(model).filter((r) => match(model, r, args.where));
      remove(model, doomed);
      return { count: doomed.length };
    }),
    updateMany: jest.fn(async (args: any) => {
      writes.push(`${model}.updateMany`);
      const rows = table(model).filter((r) => match(model, r, args.where));
      rows.forEach((r) => Object.assign(r, args.data));
      return { count: rows.length };
    }),
    update: jest.fn(async (args: any) => {
      writes.push(`${model}.update`);
      const row = table(model).find((r) => match(model, r, args.where));
      if (!row) throw new Error(`fake prisma: no ${model} to update`);
      Object.assign(row, args.data);
      return { ...row };
    }),
  });

  const models = [
    'organization', 'user', 'userOrganization', 'post', 'tagsPosts', 'comments', 'errors',
    'tags', 'media', 'signatures', 'sets', 'webhooks', 'integrationsWebhooks', 'autoPost',
    'thirdParty', 'gitHub', 'notifications', 'credits', 'plugs', 'exisingPlugData', 'customer',
    'integration', 'oAuthAuthorization', 'oAuthApp', 'itemUser', 'socialMediaAgency',
    'socialMediaAgencyNiche', 'affiliate', 'affiliateCommission', 'messagesGroup',
    'mastra_threads', 'mastra_messages', 'mastra_resources', 'mastra_scorers',
    'mastra_workflow_snapshot', 'subscription', 'usedCodes', 'payoutProblems',
  ];
  const client: any = {};
  models.forEach((m) => (client[m] = delegate(m)));
  // One shared state: a transaction body sees and changes the same rows.
  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return { client, tables, writes };
};

/* ---------------------------------- seed ---------------------------------- */

const NOW = new Date('2026-10-11T03:00:00Z');
const OLD = new Date('2026-08-01T10:00:00Z'); // 71 days before NOW
const RECENT = new Date('2026-10-01T10:00:00Z'); // 10 days before NOW
const R2 = 'https://media.hookstep.in';
const md5 = (v: string) => createHash('md5').update(v).digest('hex');

const seed = () => ({
  user: [
    { id: 'u-live', email: 'live@example.com', name: 'Live', deletedAt: null, pictureId: 'm-avatar' },
    { id: 'u-old', email: 'deleted_abc_12345', name: md5('Old'), lastName: null, providerId: md5('g-1'), deletedAt: OLD, pictureId: null },
    { id: 'u-old-affiliate', email: 'deleted_def_12345', name: md5('Aff'), deletedAt: OLD, pictureId: null },
    { id: 'u-recent', email: 'deleted_ghi_12345', name: md5('Recent'), deletedAt: RECENT, pictureId: null },
    { id: 'u-shared-owner', email: 'deleted_jkl_12345', name: md5('Owner'), deletedAt: OLD, pictureId: null },
    { id: 'u-shared-member', email: 'member@example.com', name: 'Member', deletedAt: null, pictureId: null },
  ],
  organization: [
    { id: 'org-live', name: 'Live workspace', apiKey: 'key-live', description: null, deletedAt: null, paymentId: 'cust_live' },
    { id: 'org-old', name: 'Jo Bakes', apiKey: null, description: null, deletedAt: OLD, paymentId: 'cust_old' },
    { id: 'org-recent', name: 'Recent', apiKey: null, description: null, deletedAt: RECENT, paymentId: null },
    { id: 'org-shared', name: 'Shared', apiKey: null, description: null, deletedAt: OLD, paymentId: null },
  ],
  userOrganization: [
    { id: 'uo-1', userId: 'u-live', organizationId: 'org-live' },
    { id: 'uo-2', userId: 'u-old', organizationId: 'org-old' },
    { id: 'uo-3', userId: 'u-recent', organizationId: 'org-recent' },
    { id: 'uo-4', userId: 'u-shared-owner', organizationId: 'org-shared' },
    { id: 'uo-5', userId: 'u-shared-member', organizationId: 'org-shared' },
  ],
  integration: [
    { id: 'i-live', organizationId: 'org-live', internalId: 'acct-live', rootInternalId: 'acct-live', name: 'Live', token: 'tok-live', refreshToken: 'r-live', picture: `${R2}/LivePic001.png`, profile: 'live', customerId: null, deletedAt: null },
    { id: 'i-old', organizationId: 'org-old', internalId: md5('acct-old'), rootInternalId: md5('acct-old'), name: md5('Jo Bakes'), token: md5('tok'), refreshToken: md5('r'), picture: `${R2}/OldPic0001.png`, profile: md5('jobakes'), customInstanceDetails: null, customerId: 'cust-1', deletedAt: OLD },
    { id: 'i-recent', organizationId: 'org-recent', internalId: 'x', rootInternalId: 'x', name: 'n', token: 't', picture: null, deletedAt: RECENT },
    { id: 'i-shared', organizationId: 'org-shared', internalId: 'y', rootInternalId: 'y', name: 'n', token: 't', picture: null, deletedAt: OLD },
  ],
  customer: [{ id: 'cust-1', orgId: 'org-old', name: 'Client A' }],
  post: [
    { id: 'p-live', organizationId: 'org-live', integrationId: 'i-live', content: 'live post', image: JSON.stringify([{ path: `${R2}/SharedFile.png` }]), parentPostId: null, deletedAt: null },
    { id: 'p-old', organizationId: 'org-old', integrationId: 'i-old', content: 'old post', parentPostId: null, deletedAt: OLD,
      image: JSON.stringify([{ id: 'm1', path: `${R2}/OldVideo01.mp4`, thumbnail: `${R2}/OldThumb01.jpg` }, { path: 'https://cdn.example.com/photo.jpg' }, { path: `${R2}/SharedFile.png` }, { path: `${R2}/Avatar0001.png` }]) },
    { id: 'p-old-comment', organizationId: 'org-old', integrationId: 'i-old', content: 'thread part', parentPostId: 'p-old', image: null, deletedAt: OLD },
    { id: 'p-recent', organizationId: 'org-recent', integrationId: 'i-recent', content: 'recent', parentPostId: null, image: null, deletedAt: RECENT },
    { id: 'p-shared', organizationId: 'org-shared', integrationId: 'i-shared', content: 'shared', parentPostId: null, image: null, deletedAt: OLD },
  ],
  comments: [
    { id: 'c-old', organizationId: 'org-old', postId: 'p-old', userId: 'u-old', content: 'looks good' },
    { id: 'c-live', organizationId: 'org-live', postId: 'p-live', userId: 'u-old', content: 'by a deleted member, in a live workspace' },
  ],
  errors: [{ id: 'e-old', organizationId: 'org-old', postId: 'p-old', message: 'boom' }],
  tags: [{ id: 't-old', orgId: 'org-old', name: 'launch' }],
  tagsPosts: [{ id: 'tp-1', postId: 'p-old', tagId: 't-old' }],
  media: [
    { id: 'm-old', organizationId: 'org-old', path: `${R2}/OldVideo01.mp4`, thumbnail: `${R2}/OldThumb01.jpg` },
    { id: 'm-avatar', organizationId: 'org-old', path: `${R2}/Avatar0001.png`, thumbnail: null },
    { id: 'm-live', organizationId: 'org-live', path: `${R2}/SharedFile.png`, thumbnail: null },
  ],
  signatures: [{ id: 's-old', organizationId: 'org-old', content: 'Jo, Head Baker' }],
  sets: [{ id: 'set-old', organizationId: 'org-old', content: '{}' }],
  webhooks: [{ id: 'w-old', organizationId: 'org-old', url: 'https://hooks.example.com/secret' }],
  integrationsWebhooks: [{ id: 'iw-1', integrationId: 'i-old', webhookId: 'w-old' }],
  autoPost: [{ id: 'a-old', organizationId: 'org-old', url: 'https://jobakes.example/rss' }],
  thirdParty: [{ id: 'tp-old', organizationId: 'org-old', apiKey: '' }],
  gitHub: [{ id: 'gh-old', organizationId: 'org-old', token: '' }],
  notifications: [{ id: 'n-old', organizationId: 'org-old', content: 'Your post failed' }],
  credits: [{ id: 'cr-old', organizationId: 'org-old', credits: 3 }],
  plugs: [{ id: 'pl-old', organizationId: 'org-old', integrationId: 'i-old', data: '{}' }],
  exisingPlugData: [{ id: 'ep-old', integrationId: 'i-old', value: 'x' }],
  oAuthApp: [
    { id: 'app-old', organizationId: 'org-old', name: 'Jo Bakes Tools', description: 'posts for Jo', pictureId: null, redirectUrl: 'https://jobakes.example/cb', redirectUris: null, clientSecret: 'enc', clientId: 'pca_1', deletedAt: OLD },
  ],
  oAuthAuthorization: [
    { id: 'oa-in-old', organizationId: 'org-old', userId: 'u-old', oauthAppId: 'app-mcp' },
    { id: 'oa-to-old-app', organizationId: 'org-live', userId: 'u-live', oauthAppId: 'app-old' },
    { id: 'oa-live', organizationId: 'org-live', userId: 'u-live', oauthAppId: 'app-mcp' },
    { id: 'oa-old-user-in-live', organizationId: 'org-live', userId: 'u-old', oauthAppId: 'app-mcp' },
  ],
  mastra_threads: [{ id: 'th-old', resourceId: 'org-old' }, { id: 'th-live', resourceId: 'org-live' }],
  mastra_messages: [{ id: 'msg-old', thread_id: 'th-old', resourceId: 'org-old' }, { id: 'msg-live', thread_id: 'th-live', resourceId: 'org-live' }],
  mastra_resources: [{ id: 'org-old' }, { id: 'org-live' }],
  subscription: [{ id: 'sub-old', organizationId: 'org-old' }],
  usedCodes: [{ id: 'code-old', orgId: 'org-old', code: 'LTD1' }],
  itemUser: [{ id: 'iu-old', userId: 'u-old', key: 'seen-tour' }, { id: 'iu-live', userId: 'u-live', key: 'seen-tour' }],
  socialMediaAgency: [{ id: 'ag-old', userId: 'u-old', name: 'Jo Agency', logoId: null }],
  socialMediaAgencyNiche: [{ id: 'nic-1', agencyId: 'ag-old', niche: 'food' }],
  affiliate: [
    { id: 'aff-none', userId: 'u-old', name: 'Jo', email: 'jo@example.com', payoutDetails: 'jo@upi', active: false },
    { id: 'aff-owed', userId: 'u-old-affiliate', name: 'Aff', email: 'aff@example.com', payoutDetails: 'aff@upi', active: false },
  ],
  affiliateCommission: [{ id: 'com-1', affiliateId: 'aff-owed', status: 'PENDING' }],
});

const fakeStore = (fail: string[] = []) => {
  const removed: string[] = [];
  const store: PurgeFileStore & { removed: string[] } = {
    removed,
    ownsFile: (url: string) => url.startsWith(`${R2}/`),
    removeFile: jest.fn(async (url: string) => {
      if (fail.includes(url)) throw new Error('R2 said no');
      removed.push(url);
    }),
  };
  return store;
};

const setup = (data = seed()) => {
  const db = makeDb(data);
  const repository = new AccountPurgeRepository(
    { model: db.client } as any,
    { model: db.client } as any
  );
  return { db, repository, service: new AccountPurgeService(repository) };
};

const snapshot = (tables: Record<string, Row[]>, keep: (row: Row) => boolean) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [name, rows.filter(keep)])
    )
  );

// Rows of live or recently deleted accounts and of workspaces that are live,
// recently deleted or still have a live member. (u-shared-owner was deleted
// long ago, so its own user row may be anonymised; its workspace may not.)
const belongsToLive = (row: Row) =>
  ['org-live', 'org-recent', 'org-shared'].includes(row.organizationId) ||
  ['org-live', 'org-recent', 'org-shared'].includes(row.orgId) ||
  ['org-live', 'org-recent', 'org-shared'].includes(row.id) ||
  ['u-live', 'u-recent', 'u-shared-member'].includes(row.userId) ||
  ['u-live', 'u-recent', 'u-shared-member'].includes(row.id);

/* ---------------------------------- tests --------------------------------- */

describe('AccountPurgeService dry run', () => {
  it('reports what it would erase and writes nothing, files included', async () => {
    const { db, service } = setup();
    const store = fakeStore();
    const before = JSON.stringify(db.tables);
    const lines: string[] = [];

    const report = await service.run({ enabled: false, now: NOW, stores: [store], log: (l) => lines.push(l) });

    expect(report.mode).toBe('dry-run');
    expect(db.writes).toEqual([]);
    expect(store.removeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(db.tables)).toBe(before);

    expect(report.organizations.map((o) => [o.id, o.status])).toEqual([['org-old', 'would-purge']]);
    expect(report.organizations[0].rows).toMatchObject({ post: 2, media: 2, Comments: 1, aiThreads: 1 });
    expect(report.organizations[0].files).toEqual({
      toDelete: 3, // video, thumbnail, channel picture
      deleted: 0,
      usedElsewhere: 1, // SharedFile.png is a live workspace's media too
      notOurs: 1, // cdn.example.com
      keptMedia: 1, // the live account's avatar
    });
    expect(report.users.map((u) => [u.id, u.status])).toEqual(
      expect.arrayContaining([['u-old', 'would-purge'], ['u-old-affiliate', 'would-purge'], ['u-shared-owner', 'would-purge']])
    );
    expect(report.organizationsHeldByMembers).toBe(1);
    expect(lines.join('\n')).toContain('Dry run: nothing was written');
  });

  it('is the default unless ACCOUNT_PURGE_ENABLED is exactly true', async () => {
    const { db, service } = setup();
    for (const enabled of [undefined, 'true', 1, 'yes'] as any[]) {
      const report = await service.run({ enabled, now: NOW, stores: [fakeStore()] });
      expect(report.mode).toBe('dry-run');
    }
    expect(db.writes).toEqual([]);
  });
});

describe('AccountPurgeService purge', () => {
  it('erases a workspace deleted more than 30 days ago, keeping what billing and the trial check need', async () => {
    const { db, service } = setup();
    const store = fakeStore();
    const report = await service.run({ enabled: true, now: NOW, stores: [store] });

    expect(report.failed).toBe(0);
    expect(report.organizations.map((o) => [o.id, o.status])).toEqual([['org-old', 'purged']]);
    const t = db.tables;
    const inOld = (rows: Row[]) => rows.filter((r) => r.organizationId === 'org-old' || r.orgId === 'org-old');
    for (const name of ['post', 'comments', 'errors', 'tags', 'signatures', 'sets', 'webhooks', 'autoPost', 'thirdParty', 'gitHub', 'notifications', 'credits', 'plugs', 'customer']) {
      expect([name, inOld(t[name])]).toEqual([name, []]);
    }
    expect(t.tagsPosts).toEqual([]);
    expect(t.exisingPlugData).toEqual([]);
    expect(t.integrationsWebhooks).toEqual([]);
    expect(t.mastra_threads.map((r) => r.id)).toEqual(['th-live']);
    expect(t.mastra_messages.map((r) => r.id)).toEqual(['msg-live']);
    expect(t.mastra_resources.map((r) => r.id)).toEqual(['org-live']);
    // Grants made inside the workspace go. Grants that live workspaces' users
    // gave its developer app are theirs and stay (they no longer work); the
    // app itself is emptied.
    expect(t.oAuthAuthorization.map((r) => r.id).sort()).toEqual(
      ['oa-live', 'oa-old-user-in-live', 'oa-to-old-app'].sort()
    );
    expect(t.oAuthApp.find((a) => a.id === 'app-old')).toMatchObject({
      name: 'Deleted app',
      description: null,
      redirectUrl: '',
      clientSecret: null,
      clientId: 'pca_1',
    });

    // Files: ours and unshared only.
    expect(store.removed.sort()).toEqual([`${R2}/OldPic0001.png`, `${R2}/OldThumb01.jpg`, `${R2}/OldVideo01.mp4`].sort());
    // The avatar a live account uses stays, row and file, even though a post
    // of the deleted workspace showed it too.
    expect(t.media.map((m) => m.id).sort()).toEqual(['m-avatar', 'm-live']);
    expect(store.removed).not.toContain(`${R2}/Avatar0001.png`);

    // The channel: a skeleton with the md5 root the trial check compares.
    expect(t.integration.find((i) => i.id === 'i-old')).toMatchObject({
      internalId: 'purged_i-old',
      rootInternalId: md5('acct-old'),
      name: '',
      token: '',
      refreshToken: null,
      picture: null,
      profile: null,
      customerId: null,
    });
    // The workspace row stays for billing, with nothing personal.
    expect(t.organization.find((o) => o.id === 'org-old')).toMatchObject({
      name: PURGED_ORGANIZATION_NAME,
      apiKey: null,
      description: null,
      paymentId: 'cust_old',
    });
    expect(t.subscription).toHaveLength(1);
    expect(t.usedCodes).toHaveLength(1);
  });

  it('never touches live accounts, recent deletions or a workspace that still has a live member', async () => {
    const data = seed();
    const { db, service } = setup(data);
    const before = snapshot(db.tables, belongsToLive);
    await service.run({ enabled: true, now: NOW, stores: [fakeStore()] });
    const after = snapshot(db.tables, belongsToLive);
    expect(after).toBe(before);
    expect(db.tables.user.find((u) => u.id === 'u-recent')?.email).toBe('deleted_ghi_12345');
    expect(db.tables.organization.find((o) => o.id === 'org-recent')?.name).toBe('Recent');
    expect(db.tables.post.find((p) => p.id === 'p-shared')?.content).toBe('shared');
    expect(db.tables.comments.find((c) => c.id === 'c-live')?.content).toContain('live workspace');
  });

  it('anonymises the deleted accounts themselves, and their affiliate rows by what is owed', async () => {
    const { db, service } = setup();
    await service.run({ enabled: true, now: NOW, stores: [fakeStore()] });
    const old = db.tables.user.find((u) => u.id === 'u-old');
    expect(old).toMatchObject({ email: 'purged_u-old', name: null, lastName: null, providerId: null });
    expect(db.tables.itemUser.map((i) => i.id)).toEqual(['iu-live']);
    expect(db.tables.socialMediaAgency).toEqual([]);
    expect(db.tables.socialMediaAgencyNiche).toEqual([]);
    // Its comment and its (revoked) grant inside a live workspace belong to
    // that workspace and stay.
    expect(db.tables.comments.map((c) => c.id)).toContain('c-live');
    expect(db.tables.oAuthAuthorization.map((r) => r.id)).toContain('oa-old-user-in-live');

    // Never earned anything: nothing kept.
    expect(db.tables.affiliate.find((a) => a.id === 'aff-none')).toMatchObject({
      name: 'Deleted affiliate',
      email: 'purged_aff-none',
      payoutDetails: null,
      active: false,
    });
    // A commission is still owed: name, email and payout details stay so it can be paid.
    expect(db.tables.affiliate.find((a) => a.id === 'aff-owed')).toMatchObject({
      name: 'Aff',
      email: 'aff@example.com',
      payoutDetails: 'aff@upi',
    });
    expect(db.tables.affiliateCommission).toHaveLength(1);
  });

  it('is idempotent: a second run finds nothing and writes nothing', async () => {
    const { db, service } = setup();
    await service.run({ enabled: true, now: NOW, stores: [fakeStore()] });
    db.writes.length = 0;
    const store = fakeStore();
    const again = await service.run({ enabled: true, now: NOW, stores: [store] });
    expect(again.organizations).toEqual([]);
    expect(again.users).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  it('keeps the rows when a file cannot be deleted, so the next run retries and nothing is orphaned', async () => {
    const { db, service } = setup();
    const report = await service.run({
      enabled: true,
      now: NOW,
      stores: [fakeStore([`${R2}/OldVideo01.mp4`])],
    });
    expect(report.organizations[0]).toMatchObject({ id: 'org-old', status: 'failed' });
    expect(report.failed).toBeGreaterThan(0);
    expect(db.tables.post.filter((p) => p.organizationId === 'org-old')).toHaveLength(2);
    expect(db.tables.media.find((m) => m.id === 'm-old')).toBeTruthy();

    const retry = await service.run({ enabled: true, now: NOW, stores: [fakeStore()] });
    expect(retry.organizations[0]).toMatchObject({ id: 'org-old', status: 'purged' });
  });

  it('never goes below 30 days, and respects the batch size', async () => {
    const { db, service } = setup();
    // 5 days would include org-recent; the floor keeps it out.
    const report = await service.run({ enabled: true, now: NOW, minDays: 5, batch: 1, stores: [fakeStore()] });
    expect(report.cutoff.toISOString()).toBe('2026-09-11T03:00:00.000Z');
    expect(report.organizations.map((o) => o.id)).toEqual(['org-old']);
    expect(report.users).toHaveLength(1);
    expect(db.tables.organization.find((o) => o.id === 'org-recent')?.name).toBe('Recent');
  });

  it('skips a target that changed between selection and write', async () => {
    const { db, service, repository } = setup();
    jest.spyOn(repository, 'isOrganizationPurgeable').mockResolvedValue(false);
    jest.spyOn(repository, 'isUserPurgeable').mockResolvedValue(false);
    const store = fakeStore();
    const report = await service.run({ enabled: true, now: NOW, stores: [store] });
    expect(report.organizations.every((o) => o.status === 'skipped')).toBe(true);
    expect(report.users.every((u) => u.status === 'skipped')).toBe(true);
    expect(db.writes).toEqual([]);
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  it('drops the deleted files from the CDN cache when it can, and a cache failure is not fatal', async () => {
    const { service } = setup();
    const purgeCache = jest.fn(async () => {
      throw new Error('cloudflare down');
    });
    const report = await service.run({ enabled: true, now: NOW, stores: [fakeStore()], purgeCache });
    expect(purgeCache).toHaveBeenCalledWith(
      expect.arrayContaining([`${R2}/OldVideo01.mp4`, `${R2}/OldThumb01.jpg`, `${R2}/OldPic0001.png`])
    );
    expect(report.organizations[0].status).toBe('purged');
  });
});
