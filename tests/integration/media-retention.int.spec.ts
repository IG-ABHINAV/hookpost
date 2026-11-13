/**
 * Media retention after a plan ends (owner, 29 Oct 2026; trial.policy.ts,
 * MediaRetentionService), against the real database and a fake bucket:
 *  - day 0 the notice (once), day 23 the reminder (once), day 30 the media of
 *    the workspace's unpublished posts and its library uploads leave the
 *    bucket; post text, channels, settings and published posts stay, queued
 *    posts become ERROR so nothing publishes a missing file;
 *  - a plan bought again at any time before day 30 stops it;
 *  - only workspaces with nothing to post on are on the clock (every plan
 *    state), never our own, a marketplace one or a deleted one;
 *  - the plan-ended email is the day-0 notice when one goes out (one email,
 *    not two), and gives it back when it fails;
 *  - dry run writes, sends and removes nothing.
 * Break-it: a file another workspace uses, a draft pointing at someone
 * else's file, an outside link, a profile picture, a storage failure, two
 * runs at once, a late run, the time zone edge, and the migration twice.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts media-retention
 */
process.env.EMAIL_PROVIDER = 'resend';

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient, State } from '@prisma/client';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { clearResendSends, resendSendsTo, setResendFailure } from './setup/fake.resend';
import { TEST_DATABASE_URL } from './setup/test-env';
import {
  MEDIA_REMOVED_AFTER_PLAN_MESSAGE,
  MediaRetentionService,
} from '@hookpost/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  mediaReminderFrom,
  mediaRemoveAt,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const DAY = 86400_000;
const BUCKET = 'https://bucket.test';
const CUTOFF = '2026-10-19T00:00:00Z';
const ROOT = join(__dirname, '..', '..');
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const MIGRATION = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/media-retention.migration.sql');

/** The bucket: owns https://bucket.test/<key>, records deletes, can fail some. */
class FakeBucket {
  files = new Set<string>();
  removed: string[] = [];
  failing = new Set<string>();
  // As CloudflareStorage.ownsFile: only flat keys (<id>.<ext>) under the bucket URL.
  ownsFile(url: string) {
    return url.startsWith(`${BUCKET}/`) && /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(url.slice(BUCKET.length + 1));
  }
  async removeFile(url: string) {
    if (this.failing.has(url)) throw new Error('AccessDenied');
    this.removed.push(url);
    this.files.delete(url);
  }
  put(name: string) {
    const url = `${BUCKET}/${name}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    this.files.add(url);
    return url;
  }
}

describe('media retention after a plan ends', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let retention: MediaRetentionService;
  let bucket: FakeBucket;
  const saved = {
    in: process.env.TRIAL_REQUIRED_SINCE_IN,
    enabled: process.env.MEDIA_RETENTION_ENABLED,
    exempt: process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS,
  };
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;
  const made: string[] = [];

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    retention = t.app.get(MediaRetentionService);
  });
  beforeEach(async () => {
    // Each test sees only the workspaces it makes: this file's earlier ones
    // are deleted, so they are off the clock (other files' never point at
    // the fake bucket).
    await db().organization.updateMany({ where: { id: { in: made.splice(0) } }, data: { deletedAt: new Date() } });
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    process.env.MEDIA_RETENTION_ENABLED = 'true';
    bucket = new FakeBucket();
    setResendFailure(null);
    clearResendSends();
  });
  afterAll(async () => {
    for (const [k, v] of [
      ['TRIAL_REQUIRED_SINCE_IN', saved.in],
      ['MEDIA_RETENTION_ENABLED', saved.enabled],
      ['FREE_PLAN_SUNSET_EXEMPT_ORGS', saved.exempt],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setResendFailure(null);
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const run = (now: Date, enabled = true) =>
    retention.run({ enabled, stores: [bucket as any], now });
  const stepOf = (report: Awaited<ReturnType<typeof run>>, orgId: string) =>
    report.workspaces.find((w) => w.id === orgId)?.step;
  const row = (orgId: string) => db().mediaRetention.findUnique({ where: { organizationId: orgId } });
  const retentionMail = (s: Session) =>
    resendSendsTo(s.email).filter((m) => /media/i.test(`${m.subject}`));

  /** An Indian workspace created after the cutoff, its plan or trial used: `locked`. */
  async function workspace(opts: { allowTrial?: boolean } = {}) {
    const s = await t.api.register();
    const self = await s.self();
    await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN', activated: true } });
    await db().organization.update({
      where: { id: self.orgId },
      data: { allowTrial: opts.allowTrial ?? false },
    });
    const channel = await addChannel(self.orgId, 'linkedin');
    made.push(self.orgId);
    return { s, orgId: self.orgId, userId: self.id, channel };
  }

  async function post(
    orgId: string,
    integrationId: string,
    state: State,
    urls: string[],
    extra: { publishDate?: Date; deletedAt?: Date } = {}
  ) {
    return db().post.create({
      data: {
        organizationId: orgId,
        integrationId,
        state,
        content: `text of a ${state} post`,
        group: `g-${Math.random().toString(36).slice(2)}`,
        publishDate: extra.publishDate ?? new Date(Date.now() + 40 * DAY),
        image: JSON.stringify(urls.map((path, i) => ({ id: `m${i}`, path }))),
        deletedAt: extra.deletedAt ?? null,
      },
    });
  }

  const library = (orgId: string, path: string) =>
    db().media.create({ data: { organizationId: orgId, name: 'upload', path } });

  /** A churned workspace with a library upload, a queued and a draft post. */
  async function churned() {
    const w = await workspace();
    const upload = bucket.put('library');
    const queued = bucket.put('queued');
    const draft = bucket.put('draft');
    await library(w.orgId, upload);
    const q = await post(w.orgId, w.channel.id, 'QUEUE', [queued]);
    const d = await post(w.orgId, w.channel.id, 'DRAFT', [draft]);
    return { ...w, upload, queued, draft, q, d };
  }

  describe('the clock', () => {
    it('day 0 notice once, day 23 reminder once, day 30 removal; text, channels and settings stay', async () => {
      const w = await churned();
      const published = bucket.put('published');
      const pub = await post(w.orgId, w.channel.id, 'PUBLISHED', [published], {
        publishDate: new Date(Date.now() - DAY),
      });
      const day0 = new Date();

      // Day 0: the notice, with the date 30 days on (UTC calendar day).
      expect(stepOf(await run(day0), w.orgId)).toBe('notified');
      const r0 = (await row(w.orgId))!;
      expect(r0.noticeSentAt).toEqual(day0);
      expect(r0.removeAt).toEqual(mediaRemoveAt(day0));
      const notice = retentionMail(w.s);
      expect(notice).toHaveLength(1);
      expect(notice[0].subject).toMatch(/kept until/);
      expect(notice[0].text).toContain('Integration Co');
      expect(notice[0].text).toContain('3'); // three files

      // Same day again, and the next day: nothing new.
      await run(day0);
      await run(new Date(day0.getTime() + DAY));
      expect(retentionMail(w.s)).toHaveLength(1);

      // Day 23: the reminder, once.
      const day23 = mediaReminderFrom(r0.removeAt!);
      expect(stepOf(await run(day23), w.orgId)).toBe('reminded');
      await run(new Date(day23.getTime() + 3600_000));
      const mails = retentionMail(w.s);
      expect(mails).toHaveLength(2);
      expect(mails[1].subject).toMatch(/will be removed after/);
      expect(bucket.removed).toEqual([]);

      // A second before the removal: still nothing.
      expect(stepOf(await run(new Date(r0.removeAt!.getTime() - 1000)), w.orgId)).toBe('waiting');
      expect(bucket.removed).toEqual([]);

      // Day 30: the files go.
      const report = await run(r0.removeAt!);
      expect(stepOf(report, w.orgId)).toBe('purged');
      expect(new Set(bucket.removed)).toEqual(new Set([w.upload, w.queued, w.draft]));
      expect(bucket.files.has(published)).toBe(true);

      // The queued post is ERROR with the reason; the draft stays a draft;
      // text and image JSON as they were; the published one untouched.
      const q = await db().post.findUniqueOrThrow({ where: { id: w.q.id } });
      expect(q.state).toBe('ERROR');
      expect(q.error).toBe(MEDIA_REMOVED_AFTER_PLAN_MESSAGE);
      expect(q.content).toBe('text of a QUEUE post');
      expect(q.image).toContain(w.queued);
      const d = await db().post.findUniqueOrThrow({ where: { id: w.d.id } });
      expect(d.state).toBe('DRAFT');
      expect((await db().post.findUniqueOrThrow({ where: { id: pub.id } })).state).toBe('PUBLISHED');
      // The library row is hidden; the channel is untouched.
      const m = await db().media.findFirstOrThrow({ where: { path: w.upload } });
      expect(m.deletedAt).toBeInstanceOf(Date);
      const ch = await db().integration.findUniqueOrThrow({ where: { id: w.channel.id } });
      expect(ch.deletedAt).toBeNull();
      expect(ch.token).toBe(w.channel.token);
      expect((await row(w.orgId))!.purgedAt).toEqual(r0.removeAt);

      // Idempotent: later runs remove and send nothing more.
      const later = await run(new Date(r0.removeAt!.getTime() + 2 * DAY));
      expect(stepOf(later, w.orgId)).toBeUndefined();
      expect(bucket.removed).toHaveLength(3);
      expect(retentionMail(w.s)).toHaveLength(2);
    });

    it('paying again on day 29 stops it: nothing removed, the row is gone', async () => {
      const w = await churned();
      const day0 = new Date();
      await run(day0);
      const removeAt = (await row(w.orgId))!.removeAt!;
      await run(mediaReminderFrom(removeAt));

      // A plan written the way the webhook writes one.
      await t.app.get(SubscriptionService).createOrUpdateSubscription(
        false, `sub_repay_${w.orgId.slice(0, 6)}`, '', 5, 'STANDARD', 'MONTHLY', null, undefined, w.orgId
      );
      expect(await row(w.orgId)).toBeNull();

      await run(removeAt);
      await run(new Date(removeAt.getTime() + DAY));
      expect(bucket.removed).toEqual([]);
      expect(await row(w.orgId)).toBeNull();
      expect((await db().post.findUniqueOrThrow({ where: { id: w.q.id } })).state).toBe('QUEUE');
    });

    it('a plan that slipped past the clearing is still caught right before the removal', async () => {
      const w = await churned();
      await run(new Date());
      const removeAt = (await row(w.orgId))!.removeAt!;
      await run(mediaReminderFrom(removeAt));
      // Written straight to the table, so nothing cleared the row.
      await givePlan(w.orgId);
      expect(await row(w.orgId)).not.toBeNull();
      expect(stepOf(await run(removeAt), w.orgId)).toBe('cleared');
      expect(bucket.removed).toEqual([]);
      expect(await row(w.orgId)).toBeNull();
    });

    it('a workspace with nothing to lose gets no email and nothing is removed', async () => {
      const w = await workspace();
      await post(w.orgId, w.channel.id, 'QUEUE', []);
      expect(stepOf(await run(new Date()), w.orgId)).toBe('waiting');
      expect(retentionMail(w.s)).toHaveLength(0);
      expect((await row(w.orgId))!.noticeSentAt).toBeNull();
    });

    it('dry run: writes, sends and removes nothing, and says what it would do', async () => {
      process.env.MEDIA_RETENTION_ENABLED = '';
      const w = await churned();
      const report = await run(new Date(), false);
      expect(report.mode).toBe('dry-run');
      expect(stepOf(report, w.orgId)).toBe('would-notify');
      expect(report.workspaces.find((x) => x.id === w.orgId)?.files).toBe(3);
      expect(await row(w.orgId)).toBeNull();
      expect(retentionMail(w.s)).toHaveLength(0);
      expect(bucket.removed).toEqual([]);
    });

    it('a run that was down: the late reminder moves the removal a full 7 days out', async () => {
      const w = await churned();
      const day0 = new Date();
      await run(day0);
      const removeAt = (await row(w.orgId))!.removeAt!;
      // First run again only an hour before the removal.
      const late = new Date(removeAt.getTime() - 3600_000);
      expect(stepOf(await run(late), w.orgId)).toBe('reminded');
      const moved = (await row(w.orgId))!.removeAt!;
      expect(moved).toEqual(mediaRemoveAt(late, 7));
      expect(stepOf(await run(removeAt), w.orgId)).toBe('waiting');
      expect(bucket.removed).toEqual([]);
      expect(stepOf(await run(moved), w.orgId)).toBe('purged');
    });

    it('time zone: the named day is over everywhere before anything goes', async () => {
      const w = await churned();
      const day0 = new Date('2026-11-01T23:30:00Z'); // already 2 Nov in India
      await run(day0);
      const r = (await row(w.orgId))!;
      expect(retentionMail(w.s)[0].subject).toContain('1 December 2026');
      // 1 Dec ends at UTC-12 on 2 Dec 12:00 UTC.
      expect(r.removeAt).toEqual(new Date('2026-12-02T12:00:00Z'));
      expect(mediaReminderFrom(r.removeAt!)).toEqual(new Date('2026-11-24T00:00:00Z'));
      expect(stepOf(await run(new Date('2026-11-23T23:59:59Z')), w.orgId)).toBe('waiting');
      expect(stepOf(await run(new Date('2026-11-24T00:00:00Z')), w.orgId)).toBe('reminded');
      expect((await row(w.orgId))!.removeAt).toEqual(r.removeAt); // on time: same date
      expect(retentionMail(w.s)[1].subject).toContain('1 December 2026');
      expect(stepOf(await run(new Date('2026-12-02T11:59:59Z')), w.orgId)).toBe('waiting');
      expect(stepOf(await run(new Date('2026-12-02T12:00:00Z')), w.orgId)).toBe('purged');
    });

    it('a failed email gives the claim back and the next run sends it', async () => {
      const w = await churned();
      setResendFailure('error');
      expect(stepOf(await run(new Date()), w.orgId)).toBe('failed');
      expect((await row(w.orgId))!.noticeSentAt).toBeNull();
      setResendFailure(null);
      expect(stepOf(await run(new Date()), w.orgId)).toBe('notified');
      expect(retentionMail(w.s)).toHaveLength(1);
    });
  });

  describe('who is on the clock', () => {
    const onClock = (orgId: string) => retention.onClock(orgId, new Date());

    it('locked (plan or trial ended): yes; a plan of any kind: no', async () => {
      const w = await workspace();
      expect(await onClock(w.orgId)).toBe(true);
      await givePlan(w.orgId); // active
      expect(await onClock(w.orgId)).toBe(false);
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { cancelAt: new Date(Date.now() + 5 * DAY) },
      }); // cancelling
      expect(await onClock(w.orgId)).toBe(false);
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { cancelAt: null, paymentFailingSince: new Date() },
      }); // dunning
      expect(await onClock(w.orgId)).toBe(false);
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { paymentFailingSince: null, isLifetime: true },
      }); // lifetime
      expect(await onClock(w.orgId)).toBe(false);
      // A cycle-end date that has passed is no plan, before the sweep.
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { isLifetime: false, cancelAt: new Date(Date.now() - 60_000) },
      });
      expect(await onClock(w.orgId)).toBe(true);
    });

    it('a chargeback (disputed): yes', async () => {
      const w = await workspace();
      await db().organization.update({ where: { id: w.orgId }, data: { disputedAt: new Date() } });
      expect(await onClock(w.orgId)).toBe(true);
    });

    it('never paid, free posts: no while some are left or one is still scheduled, yes once spent', async () => {
      const w = await workspace({ allowTrial: true });
      expect((await w.s.self()).planState).toBe('free_posts');
      expect(await onClock(w.orgId)).toBe(false);
      const day = (n: number) => new Date(Date.now() + n * DAY);
      await post(w.orgId, w.channel.id, 'PUBLISHED', [], { publishDate: day(-3) });
      await post(w.orgId, w.channel.id, 'PUBLISHED', [], { publishDate: day(-2) });
      expect(await onClock(w.orgId)).toBe(false);
      const last = await post(w.orgId, w.channel.id, 'QUEUE', [], { publishDate: day(2) });
      expect(await onClock(w.orgId)).toBe(false); // still using it
      await db().post.update({ where: { id: last.id }, data: { state: 'PUBLISHED', publishDate: day(-1) } });
      expect(await onClock(w.orgId)).toBe(true);
    });

    it('grandfathered without a plan after the sunset (needs_trial): yes; on the Free plan: no', async () => {
      const w = await workspace({ allowTrial: true });
      await db().organization.update({
        where: { id: w.orgId },
        data: { createdAt: new Date('2026-09-01T00:00:00Z') },
      });
      expect(await onClock(w.orgId)).toBe(false); // Free plan, no sunset set
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-27T18:29:59Z';
      try {
        expect((await w.s.self()).planState).toBe('needs_trial');
        expect(await onClock(w.orgId)).toBe(true);
      } finally {
        process.env.FREE_PLAN_SUNSET_AT = '';
      }
    });

    it('never our own, a marketplace or a deleted workspace, and never without billing', async () => {
      const own = await workspace();
      await makeSuperAdmin(own.userId);
      expect(await onClock(own.orgId)).toBe(false);

      const exempt = await workspace();
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = exempt.orgId;
      expect(await onClock(exempt.orgId)).toBe(false);
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = saved.exempt ?? '';

      const market = await workspace();
      await db().organization.update({ where: { id: market.orgId }, data: { source: 'API_MARKET' } });
      expect(await onClock(market.orgId)).toBe(false);

      const gone = await workspace();
      await db().organization.update({ where: { id: gone.orgId }, data: { deletedAt: new Date() } });
      expect(await onClock(gone.orgId)).toBe(false);

      const plain = await workspace();
      const key = process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_ID;
      try {
        expect(await onClock(plain.orgId)).toBe(false);
      } finally {
        process.env.RAZORPAY_KEY_ID = key;
      }
    });

    it('a workspace that leaves the clock has its row cleared by the run', async () => {
      const w = await churned();
      await run(new Date());
      expect(await row(w.orgId)).not.toBeNull();
      await makeSuperAdmin(w.userId);
      expect(stepOf(await run(new Date()), w.orgId)).toBe('cleared');
      expect(await row(w.orgId)).toBeNull();
    });
  });

  describe('the plan-ended email is the day-0 notice', () => {
    const postWebhook = (event: string, entities: Record<string, any>) => {
      const signed = FakeRazorpay.signedEvent(event, entities, secret());
      return t.api.request('POST', '/razorpay/webhook', {
        raw: signed.raw,
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
      });
    };

    async function payingWorkspace() {
      const w = await workspace();
      const res = await w.s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
      if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
      const subId: string = res.body.subscriptionId;
      const sub = rzp.authorise(subId);
      await postWebhook('subscription.activated', { subscription: sub });
      const payment = rzp.charge(subId);
      rzp.invoiceFor(subId, payment);
      await postWebhook('subscription.charged', { subscription: rzp.subscriptions.get(subId), payment });
      await library(w.orgId, bucket.put('library'));
      return { ...w, subId, payment };
    }

    async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
      const until = Date.now() + ms;
      for (;;) {
        const got = read();
        if (got.length >= count || Date.now() > until) return got;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it('a chargeback ends the plan: one email with the kept-until date, and the run sends no second', async () => {
      const w = await payingWorkspace();
      const d = rzp.dispute(w.payment.id);
      expect((await postWebhook('payment.dispute.created', { payment: rzp.payments.get(w.payment.id), dispute: d })).status).toBe(201);
      const mail = await eventually(() => resendSendsTo(w.s.email).filter((m) => /dispute/i.test(`${m.subject} ${m.text}`)), 1);
      expect(mail).toHaveLength(1);
      const r = (await row(w.orgId))!;
      expect(r.noticeSentAt).toBeInstanceOf(Date);
      expect(mail[0].text).toContain("We keep this workspace's posts and media until");
      expect(r.removeAt).toEqual(mediaRemoveAt(r.noticeSentAt!));

      await run(new Date());
      expect(retentionMail(w.s)).toHaveLength(0);
    });

    it('a cancel that keeps paid time: no line (the plan is still on), no clock', async () => {
      const w = await payingWorkspace();
      const res = await w.s.post('/billing/cancel', { feedback: 'testing' });
      expect(res.status).toBeLessThan(300);
      const mail = await eventually(() => resendSendsTo(w.s.email).filter((m) => /cancelled/i.test(m.subject)), 1);
      expect(mail.length).toBeGreaterThan(0);
      expect(mail.map((m) => m.text).join(' ')).not.toContain('We keep this workspace');
      expect(await row(w.orgId)).toBeNull();
    });

    it('when that email fails the notice is given back, and the run sends it on its own', async () => {
      const w = await payingWorkspace();
      setResendFailure('error');
      const d = rzp.dispute(w.payment.id);
      await postWebhook('payment.dispute.created', { payment: rzp.payments.get(w.payment.id), dispute: d });
      await new Promise((r) => setTimeout(r, 500));
      setResendFailure(null);
      expect((await row(w.orgId))?.noticeSentAt ?? null).toBeNull();
      expect(stepOf(await run(new Date()), w.orgId)).toBe('notified');
      expect(retentionMail(w.s)).toHaveLength(1);
    });

    it('with the run off, the plan-ended email carries no line and starts no clock', async () => {
      process.env.MEDIA_RETENTION_ENABLED = '';
      const w = await payingWorkspace();
      const d = rzp.dispute(w.payment.id);
      await postWebhook('payment.dispute.created', { payment: rzp.payments.get(w.payment.id), dispute: d });
      const mail = await eventually(() => resendSendsTo(w.s.email).filter((m) => /dispute/i.test(`${m.subject} ${m.text}`)), 1);
      expect(mail[0].text).not.toContain('We keep this workspace');
      expect(await row(w.orgId)).toBeNull();
    });
  });

  describe('break it', () => {
    it('a file another workspace uses stays, wherever it uses it', async () => {
      const w = await churned();
      const other = await workspace();
      await givePlan(other.orgId);
      const inPost = bucket.put('shared-post');
      const inLibrary = bucket.put('shared-library');
      await library(w.orgId, inPost);
      await library(w.orgId, inLibrary);
      await post(other.orgId, other.channel.id, 'PUBLISHED', [inPost], { publishDate: new Date(Date.now() - DAY) });
      await library(other.orgId, inLibrary);
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      const report = await run(r.removeAt!);
      expect(report.workspaces.find((x) => x.id === w.orgId)?.sharedKept).toBe(2);
      expect(bucket.removed).not.toContain(inPost);
      expect(bucket.removed).not.toContain(inLibrary);
      expect(bucket.removed).toContain(w.upload);
    });

    it("a churned draft pointing at another workspace's file cannot get it deleted", async () => {
      const victim = await workspace();
      await givePlan(victim.orgId);
      const theirs = bucket.put('victim');
      await library(victim.orgId, theirs);
      const w = await workspace();
      await post(w.orgId, w.channel.id, 'DRAFT', [theirs, 'https://elsewhere.example/x.jpg']);
      await run(new Date());
      const r = await row(w.orgId);
      // Nothing of its own to lose: no notice at all.
      expect(r!.noticeSentAt).toBeNull();
      await run(new Date(Date.now() + 40 * DAY));
      expect(bucket.removed).toEqual([]);
    });

    it("a profile picture, a deleted post's file and a channel picture stay", async () => {
      const w = await churned();
      const avatar = bucket.put('avatar');
      const pic = await library(w.orgId, avatar);
      await db().user.update({ where: { id: w.userId }, data: { pictureId: pic.id } });
      const channelPic = bucket.put('channel');
      await library(w.orgId, channelPic);
      await db().integration.update({ where: { id: w.channel.id }, data: { picture: channelPic } });
      const deletedPostFile = bucket.put('deleted-post');
      await post(w.orgId, w.channel.id, 'QUEUE', [deletedPostFile], { deletedAt: new Date() });
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      await run(r.removeAt!);
      expect(bucket.removed).not.toContain(avatar);
      expect(bucket.removed).not.toContain(channelPic);
      expect(bucket.removed).not.toContain(deletedPostFile);
      expect(new Set(bucket.removed)).toEqual(new Set([w.upload, w.queued, w.draft]));
    });

    it("a library row aimed at another product's key (save-media takes any name) never deletes it", async () => {
      const w = await churned();
      const tablamigo = `${BUCKET}/tablamigo/avatar/u1/0123456789abcdef.jpg`;
      await library(w.orgId, tablamigo);
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      await run(r.removeAt!);
      expect(bucket.removed).not.toContain(tablamigo);
      expect(new Set(bucket.removed)).toEqual(new Set([w.upload, w.queued, w.draft]));
    });

    it('a file a signature or saved set mentions stays, its own or another workspace\'s', async () => {
      const w = await churned();
      const inOwnSignature = bucket.put('own-signature');
      const inOwnSet = bucket.put('own-set');
      const inOtherSignature = bucket.put('other-signature');
      for (const url of [inOwnSignature, inOwnSet, inOtherSignature]) await library(w.orgId, url);
      await db().signatures.create({
        data: { organizationId: w.orgId, content: `<p>Thanks</p><img src="${inOwnSignature}">`, autoAdd: false },
      });
      await db().sets.create({
        data: { organizationId: w.orgId, name: 'set', content: JSON.stringify({ image: [{ path: inOwnSet }] }) },
      });
      const other = await workspace();
      await givePlan(other.orgId);
      await db().signatures.create({
        data: { organizationId: other.orgId, content: `<img src="${inOtherSignature}">`, autoAdd: false },
      });
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      await run(r.removeAt!);
      for (const url of [inOwnSignature, inOwnSet, inOtherSignature]) {
        expect(bucket.removed).not.toContain(url);
      }
      expect(new Set(bucket.removed)).toEqual(new Set([w.upload, w.queued, w.draft]));
    });

    it('a storage failure leaves the row open; the next run finishes (deleting a gone file again is harmless)', async () => {
      const w = await churned();
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      bucket.failing.add(w.draft);
      expect(stepOf(await run(r.removeAt!), w.orgId)).toBe('failed');
      expect((await row(w.orgId))!.purgedAt).toBeNull();
      bucket.failing.clear();
      expect(stepOf(await run(new Date(r.removeAt!.getTime() + DAY)), w.orgId)).toBe('purged');
      expect(new Set(bucket.removed)).toEqual(new Set([w.upload, w.queued, w.draft]));
      expect([w.upload, w.queued, w.draft].some((f) => bucket.files.has(f))).toBe(false);
      // Done: a later run touches nothing.
      const count = bucket.removed.length;
      await run(new Date(r.removeAt!.getTime() + 2 * DAY));
      expect(bucket.removed).toHaveLength(count);
    });

    it('two runs at once (backend and orchestrator) send one notice and one reminder', async () => {
      const w = await churned();
      const now = new Date();
      await Promise.all([run(now), run(now)]);
      expect(retentionMail(w.s)).toHaveLength(1);
      const r = (await row(w.orgId))!;
      const day23 = mediaReminderFrom(r.removeAt!);
      await Promise.all([run(day23), run(day23)]);
      expect(retentionMail(w.s)).toHaveLength(2);
    });

    it('a later plan-ended email in the same stretch without a plan is not a second notice', async () => {
      const w = await churned();
      const now = new Date();
      await run(now);
      const told = (await row(w.orgId))!;
      // Days later another email about the plan ending (a refund, a late
      // cancel webhook): no new clock, the date stays.
      expect(await retention.claimNoticeAtPlanEnd(w.orgId, new Date(now.getTime() + 5 * DAY))).toBeNull();
      expect((await row(w.orgId))!.removeAt).toEqual(told.removeAt);
      // A plan bought (row cleared) and lost again starts a new clock.
      await t.app.get(SubscriptionService).createOrUpdateSubscription(
        false, `sub_again_${w.orgId.slice(0, 6)}`, '', 5, 'STANDARD', 'MONTHLY', null, undefined, w.orgId
      );
      expect(await row(w.orgId)).toBeNull();
      await db().subscription.deleteMany({ where: { organizationId: w.orgId } });
      const later = new Date(now.getTime() + 10 * DAY);
      const claim = await retention.claimNoticeAtPlanEnd(w.orgId, later);
      expect(claim?.removeAt).toEqual(mediaRemoveAt(later));
    });

    it('a process without the billing key changes nothing, even enabled', async () => {
      const w = await churned();
      await run(new Date());
      const before = await row(w.orgId);
      const key = process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_ID;
      try {
        const report = await run(new Date(Date.now() + 40 * DAY));
        expect(report.workspaces).toEqual([]);
      } finally {
        process.env.RAZORPAY_KEY_ID = key;
      }
      expect(await row(w.orgId)).toEqual(before);
      expect(bucket.removed).toEqual([]);
    });

    it('a plan bought while the files are going keeps the rest', async () => {
      const w = await workspace();
      const files = Array.from({ length: 60 }, (_, i) => bucket.put(`bulk${i}`));
      for (const f of files) await library(w.orgId, f);
      await run(new Date());
      const r = (await row(w.orgId))!;
      await run(mediaReminderFrom(r.removeAt!));
      // The plan lands after the first 10 files are gone.
      const remove = bucket.removeFile.bind(bucket);
      let n = 0;
      bucket.removeFile = async (url: string) => {
        if (++n === 10) await givePlan(w.orgId);
        return remove(url);
      };
      expect(stepOf(await run(r.removeAt!), w.orgId)).toBe('cleared');
      // Other workspaces due on the same day share the run: count only these.
      expect(bucket.removed.filter((u) => files.includes(u))).toHaveLength(25);
      expect(files.filter((f) => bucket.files.has(f))).toHaveLength(35);
      expect(await row(w.orgId)).toBeNull();
    });
  });
});

describe('media-retention.migration.sql', () => {
  const PG_SCHEMA = 'media_retention_migration_check';
  const withSchema = (url: string, schema: string) => {
    const u = new URL(url);
    u.searchParams.set('schema', schema);
    return u.toString();
  };
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  beforeAll(async () => {
    // Today's production schema: schema.prisma without the new model.
    const before = readFileSync(SCHEMA, 'utf8').replace(
      /\n\/\/\/ MEDIA RETENTION AFTER A PLAN ENDS[\s\S]*?\nmodel MediaRetention \{[\s\S]*?\n\}\n/,
      '\n'
    );
    expect(before).not.toContain('MediaRetention');
    const beforeFile = join(mkdtempSync(join(tmpdir(), 'media-retention-migration-')), 'before.prisma');
    writeFileSync(beforeFile, before);
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe(
      `INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES ('org-before-migration', 'Existing', now())`
    );
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

  const apply = () => {
    try {
      execFileSync('psql', ['--version'], { stdio: 'pipe' });
    } catch {
      execFileSync(PRISMA, ['db', 'execute', '--url', url, '--file', MIGRATION], { stdio: 'pipe' });
      return;
    }
    execFileSync('psql', [TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
      env: { ...process.env, PGOPTIONS: `-c search_path=${PG_SCHEMA}` },
      stdio: 'pipe',
    });
  };

  const diff = () => {
    try {
      execFileSync(PRISMA, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--exit-code'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      return 0;
    } catch (e: any) {
      return e.status;
    }
  };

  it('applies twice cleanly, and leaves the database exactly as schema.prisma says', async () => {
    expect(diff()).toBe(2);
    apply();
    apply();
    expect(diff()).toBe(0);
    const orgs = await client.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${PG_SCHEMA}"."Organization"`);
    expect(orgs.map((r) => r.id)).toEqual(['org-before-migration']);
  }, 120_000);
});
