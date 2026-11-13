/**
 * The AI text allowance (pricing.ts ai_generation_count): counted per billing
 * month from the subscription's start, spent only by a real generation, and
 * refused with 402 once spent, before anything reaches OpenAI. Image credits
 * share the same accounting (subscription.repository.ts useCredit).
 *
 * No call here reaches OpenAI: every request that would is one the allowance
 * refuses first.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan } from './setup/db';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

describe('AI credits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  async function workspace(tier?: 'STANDARD' | 'PRO'): Promise<{ s: Session; orgId: string }> {
    const s = await t.api.register();
    const { orgId } = await s.self();
    if (tier) await givePlan(orgId, tier);
    return { s, orgId };
  }

  const spend = (organizationId: string, type: string, n: number, createdAt?: Date) =>
    db().credits.createMany({
      data: Array.from({ length: n }, () => ({ organizationId, type, credits: 1, ...(createdAt ? { createdAt } : {}) })),
    });

  const generate = (s: Session, path = '/copilot/chat') =>
    s.post(path, { operationName: 'generateCopilotResponse', query: 'mutation generateCopilotResponse { x }', variables: {} });

  it('Standard and Pro start the month with their published allowance', async () => {
    for (const tier of ['STANDARD', 'PRO'] as const) {
      const { s } = await workspace(tier);
      expect((await s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: pricing[tier].ai_generation_count });
      expect((await s.get('/copilot/credits?type=ai_images')).body).toEqual({ credits: pricing[tier].image_generation_count });
    }
  });

  it('Free has no AI allowance', async () => {
    const { s } = await workspace();
    expect((await s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: 0 });
  });

  it('use this month counts; use before the subscription started does not', async () => {
    const { s, orgId } = await workspace('STANDARD');
    await spend(orgId, 'ai_text', 7);
    await spend(orgId, 'ai_text', 50, new Date(Date.now() - 40 * 86400_000));
    await spend(orgId, 'ai_images', 3);
    expect((await s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: pricing.STANDARD.ai_generation_count - 7 });
    expect((await s.get('/copilot/credits?type=ai_images')).body).toEqual({ credits: pricing.STANDARD.image_generation_count - 3 });
  });

  it('a spent allowance refuses the next generation with 402 and records nothing', async () => {
    const { s, orgId } = await workspace('STANDARD');
    await spend(orgId, 'ai_text', pricing.STANDARD.ai_generation_count);
    const before = await db().credits.count({ where: { organizationId: orgId } });
    const res = await generate(s);
    expect(res.status).toBe(402);
    expect(await db().credits.count({ where: { organizationId: orgId } })).toBe(before);
    expect((await generate(s, '/copilot/agent')).status).toBe(402);
  });

  it('the copilot handshake on every page load is never charged and never refused', async () => {
    const { s, orgId } = await workspace();
    // Free: zero allowance. The handshake must still answer, or the whole
    // app layout (which CopilotKit wraps) stops rendering.
    const res = await s.post('/copilot/chat', {
      operationName: 'availableAgents',
      query: 'query availableAgents { availableAgents { agents { name id description } } }',
      variables: {},
    });
    expect(res.status).not.toBe(402);
    expect(res.status).toBeLessThan(500);
    expect(await db().credits.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('another workspace\'s use is not counted', async () => {
    const a = await workspace('STANDARD');
    const b = await workspace('STANDARD');
    await spend(a.orgId, 'ai_text', 25);
    expect((await b.s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: pricing.STANDARD.ai_generation_count });
  });
});
