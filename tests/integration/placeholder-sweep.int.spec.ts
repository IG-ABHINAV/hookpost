/**
 * The unfinished-connect sweep (IntegrationService.removeStalePlaceholders),
 * against the real database: the SQL filter in getStalePlaceholders plus the
 * service's own check, before PLACEHOLDER_SWEEP=true turns it on in
 * production. Its first run there removes whatever placeholders have piled
 * up since 6 Oct, so this pins exactly which rows it may touch: a two-step
 * login nobody finished, older than STALE_PLACEHOLDER_HOURS. Never a channel
 * that works, one that once published, one being connected right now, a
 * one-step provider's channel (those carry the same internalId = root shape),
 * or a Tumblr or LinkedIn Page row (NEVER_SWEPT in unfinished.connect.ts).
 */
import { startApp, TestApp } from './setup/app';
import { db, disconnectDb } from './setup/db';
import {
  IntegrationService,
  STALE_PLACEHOLDER_HOURS,
} from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';

const HOUR = 60 * 60 * 1000;

describe('placeholder sweep: only unfinished two-step connects older than the cutoff', () => {
  let t: TestApp;
  let sweep: IntegrationService;
  let orgId: string;
  let n = 0;

  /** A row as the connect flow leaves it, then aged with raw SQL (Prisma would stamp updatedAt). */
  const row = async (opts: {
    provider: string;
    internalId?: string;
    root?: string | null;
    inBetweenSteps: boolean;
    createdHoursAgo: number;
    updatedHoursAgo?: number | null;
    deleted?: boolean;
  }) => {
    const id = `sweep-${Date.now()}-${n++}`;
    const internalId = opts.internalId ?? `login-${id}`;
    const created = await db().integration.create({
      data: {
        organizationId: orgId,
        internalId,
        rootInternalId: opts.root === undefined ? internalId : opts.root,
        name: `Sweep ${id}`,
        picture: null,
        providerIdentifier: opts.provider,
        type: 'social',
        token: `token-${id}`,
        refreshToken: `refresh-${id}`,
        profile: `profile_${id}`,
        inBetweenSteps: opts.inBetweenSteps,
      },
    });
    const createdAt = new Date(Date.now() - opts.createdHoursAgo * HOUR);
    const updatedAt =
      opts.updatedHoursAgo === null
        ? null
        : new Date(Date.now() - (opts.updatedHoursAgo ?? opts.createdHoursAgo) * HOUR);
    const deletedAt = opts.deleted ? new Date(Date.now() - HOUR) : null;
    await db().$executeRaw`UPDATE "Integration" SET "createdAt" = ${createdAt}, "updatedAt" = ${updatedAt}, "deletedAt" = ${deletedAt} WHERE id = ${created.id}`;
    return created.id;
  };

  const state = (id: string) =>
    db().integration.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true, token: true },
    });

  beforeAll(async () => {
    t = await startApp();
    sweep = t.get(IntegrationService);
    orgId = (await (await t.api.register({ company: 'Sweep Co' })).self()).orgId;
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  it('removes the stale placeholder and nothing else', async () => {
    const old = STALE_PLACEHOLDER_HOURS + 6;
    const stale = await row({ provider: 'facebook', inBetweenSteps: true, createdHoursAgo: old });
    const staleNeverUpdated = await row({
      provider: 'youtube',
      inBetweenSteps: true,
      createdHoursAgo: old,
      updatedHoursAgo: null,
    });

    const kept: Record<string, string> = {
      // Younger than the cutoff: the user may still pick a page.
      fresh: await row({ provider: 'facebook', inBetweenSteps: true, createdHoursAgo: 2 }),
      // Created long ago, but logged in again an hour ago: a connect in progress.
      reloggedIn: await row({
        provider: 'instagram',
        inBetweenSteps: true,
        createdHoursAgo: old,
        updatedHoursAgo: 1,
      }),
      // A finished page channel a failed token refresh marked in between steps.
      finishedPage: await row({
        provider: 'facebook',
        internalId: `page-${n}`,
        root: `login-of-page-${n}`,
        inBetweenSteps: true,
        createdHoursAgo: old,
      }),
      // A one-step provider: every channel has internalId = root.
      oneStep: await row({ provider: 'x', inBetweenSteps: true, createdHoursAgo: old }),
      // A two-step channel that is not in between steps.
      notBetween: await row({ provider: 'youtube', inBetweenSteps: false, createdHoursAgo: old }),
      // No root id: never a placeholder (every placeholder has had one).
      noRoot: await row({ provider: 'facebook', root: null, inBetweenSteps: true, createdHoursAgo: old }),
      // A finished Tumblr primary blog: its id is the login name, so it has the
      // placeholder shape; a second login left on the page picker put it back
      // in between steps. Tumblr is never swept.
      tumblrBlog: await row({
        provider: 'tumblr',
        internalId: `blogname${n}`,
        root: `blogname${n}`,
        inBetweenSteps: true,
        createdHoursAgo: old,
      }),
      // A personal LinkedIn profile channel (one-step linkedin, no posts)
      // whose owner started a LinkedIn Page connect and left the page picker:
      // the upsert matched the member id and made the row linkedin-page, in
      // between steps, internalId = root. LinkedIn Page is never swept.
      linkedinProfile: await row({
        provider: 'linkedin-page',
        internalId: `member${n}`,
        root: `member${n}`,
        inBetweenSteps: true,
        createdHoursAgo: old,
      }),
    };

    // Placeholder-shaped, but it published once: a live channel.
    const published = await row({ provider: 'facebook', inBetweenSteps: true, createdHoursAgo: old });
    await db().post.create({
      data: {
        organizationId: orgId,
        integrationId: published,
        content: 'went out',
        group: `g-${published}`,
        publishDate: new Date(Date.now() - old * HOUR),
        state: 'PUBLISHED',
        deletedAt: new Date(),
      },
    });
    kept.published = published;

    // Already removed: left exactly as it is.
    const alreadyDeleted = await row({
      provider: 'facebook',
      inBetweenSteps: true,
      createdHoursAgo: old,
      deleted: true,
    });
    const deletedBefore = await state(alreadyDeleted);

    const before: Record<string, { deletedAt: Date | null; token: string }> = {};
    for (const [name, id] of Object.entries(kept)) before[name] = await state(id);

    expect(await sweep.removeStalePlaceholders()).toBe(2);

    for (const id of [stale, staleNeverUpdated]) {
      const after = await state(id);
      expect(after.deletedAt).not.toBeNull();
      // Removed the way a user removes a channel: the token is hashed.
      expect(after.token).not.toMatch(/^token-/);
    }
    for (const [name, id] of Object.entries(kept)) {
      expect({ name, ...(await state(id)) }).toEqual({ name, ...before[name] });
    }
    expect(await state(alreadyDeleted)).toEqual(deletedBefore);

    // Idempotent: a second run (another process, the next interval) is a no-op.
    expect(await sweep.removeStalePlaceholders()).toBe(0);
  });
});
