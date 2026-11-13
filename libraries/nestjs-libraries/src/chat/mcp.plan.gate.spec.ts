// MCP refusal for a workspace that has to start its trial or choose a plan
// first: gateToolsByPlan (every MCP route in start.mcp.ts: connect, then each
// tool call refuses with mcpPlanRefusalText).
//   pnpm exec jest -c apps/backend/jest.config.ts mcp.plan.gate

import { createTool, isValidationError } from '@mastra/core/tools';
import { z } from 'zod';
import {
  gateToolsByPlan,
  mcpBillingUrl,
  mcpPlanRefusal,
  mcpPlanRefusalText,
  meterAgentByCredits,
} from '@hookpost/nestjs-libraries/chat/mcp.plan.gate';
import { runWithContext } from '@hookpost/nestjs-libraries/chat/async.storage';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

// Red team, 2 Nov 2026: ask_hookpost (the agent the API-key endpoints expose)
// ran the model with no AI check and no credit, for any workspace's API key,
// a Free one's included.
describe('meterAgentByCredits (ask_hookpost)', () => {
  class FakeAgent {
    // A private field, as Mastra's Agent has: every call must reach the
    // agent itself, not the wrapper.
    #description = 'Hookpost assistant';
    name = 'hookpost';
    generate = jest.fn(async (message: string, _opts?: any) => ({ text: `answer to ${message}` }));
    getDescription() {
      return this.#description;
    }
  }

  it('a workspace with AI left: one credit, then the model', async () => {
    const agent = new FakeAgent();
    const useCredit = jest.fn(async (_org: string, run: () => Promise<any>) => run());
    const metered = meterAgentByCredits(agent, useCredit);

    const out = await runWithContext({ requestId: 'k', auth: { id: 'org-1' } }, () =>
      metered.generate('hello', { x: 1 })
    );

    expect(out).toEqual({ text: 'answer to hello' });
    expect(useCredit).toHaveBeenCalledTimes(1);
    expect(useCredit.mock.calls[0][0]).toBe('org-1');
    expect(agent.generate).toHaveBeenCalledWith('hello', { x: 1 });
  });

  it('no AI to spend (Free plan, plan ended, payment failing, allowance used up): refused, the model never runs', async () => {
    const agent = new FakeAgent();
    const useCredit = jest.fn(async () => {
      throw new CreditsExceededError('ai_text');
    });
    const metered = meterAgentByCredits(agent, useCredit);

    const out: any = await runWithContext({ requestId: 'k', auth: { id: 'org-free' } }, () =>
      metered.generate('write 100 posts')
    );

    expect(out).toEqual({
      error: true,
      message: expect.stringContaining("Hookpost AI isn't available on this workspace"),
      validationErrors: [],
    });
    expect(isValidationError(out)).toBe(true);
    expect(out.message).toContain('/billing?utm_source=mcp_paywall');
    expect(agent.generate).not.toHaveBeenCalled();
  });

  it('outside a request (no workspace): refused, nothing metered or run', async () => {
    const agent = new FakeAgent();
    const useCredit = jest.fn();
    const out: any = await meterAgentByCredits(agent, useCredit).generate('hi');
    expect(out).toMatchObject({ error: true, message: expect.stringMatching(/could not check/) });
    expect(useCredit).not.toHaveBeenCalled();
    expect(agent.generate).not.toHaveBeenCalled();
  });

  it('a model failure is not a refusal: it is thrown (useCredit has given the credit back)', async () => {
    const agent = new FakeAgent();
    agent.generate.mockRejectedValueOnce(new Error('provider down'));
    const metered = meterAgentByCredits(agent, async (_o, run) => run());
    await expect(
      runWithContext({ requestId: 'k', auth: { id: 'org-1' } }, () => metered.generate('hi'))
    ).rejects.toThrow('provider down');
  });

  it('everything else is the agent own: name, description, `in` checks', () => {
    const agent = new FakeAgent();
    const metered = meterAgentByCredits(agent, jest.fn());
    expect('generate' in metered).toBe(true);
    expect(metered.name).toBe('hookpost');
    expect(metered.getDescription()).toBe('Hookpost assistant');
    expect(metered.generate).not.toBe(agent.generate);
  });
});

describe('mcpPlanRefusal', () => {
  it('the code, the reason and the trial length, or null', async () => {
    expect(await mcpPlanRefusal(async () => 'TRIAL_REQUIRED', { id: 'org' }, async () => 7)).toEqual({
      code: 'TRIAL_REQUIRED',
      message: 'Start your 7-day trial to schedule and publish posts.',
      days: 7,
    });
    expect(await mcpPlanRefusal(async () => 'PLAN_REQUIRED', { id: 'org' })).toEqual({
      code: 'PLAN_REQUIRED',
      message: 'Choose a plan to continue.',
      days: 3,
    });
    expect(await mcpPlanRefusal(async () => null, { id: 'org' })).toBeNull();
    expect(await mcpPlanRefusal(async () => { throw new Error('db down'); }, { id: 'org' })).toBeNull();
    expect(await mcpPlanRefusal(jest.fn() as any, undefined)).toBeNull();
  });

  // A workspace the Free plan sunset email of 21 Oct promised a 7-day trial is
  // told 7 here too; a lookup that fails gives TRIAL_DAYS (3).
  it('a trial-length lookup that fails gives TRIAL_DAYS', async () => {
    const refusal = await mcpPlanRefusal(async () => 'TRIAL_REQUIRED', { id: 'org' }, async () => {
      throw new Error('db down');
    });
    expect(refusal).toMatchObject({ days: 3, message: 'Start your 3-day trial to schedule and publish posts.' });
  });
});

describe('mcpPlanRefusalText', () => {
  const app = 'https://hookpost.hookstep.in';

  it('needs_trial: what to do, the trial length and the link, as the assistant relays it', () => {
    expect(
      mcpPlanRefusalText({ code: 'TRIAL_REQUIRED', message: 'x', days: 3 }, app)
    ).toBe(
      'Hookpost needs an active plan to do this. Start your 3-day trial here: https://hookpost.hookstep.in/billing?utm_source=mcp_paywall (it takes about a minute), then ask me again.'
    );
  });

  it('names the workspace\'s own trial length (7 for the sunset cohort), else TRIAL_DAYS', () => {
    expect(mcpPlanRefusalText({ code: 'TRIAL_REQUIRED', message: 'x', days: 7 }, app)).toContain('Start your 7-day trial here:');
    expect(mcpPlanRefusalText({ code: 'TRIAL_REQUIRED', message: 'x' }, app)).toContain('Start your 3-day trial here:');
  });

  it('locked: no trial offered, a plan instead, same link', () => {
    const text = mcpPlanRefusalText({ code: 'PLAN_REQUIRED', message: 'x' }, app);
    expect(text).toMatch(/^Hookpost needs an active plan to do this\./);
    expect(text).toContain('choose a plan here: https://hookpost.hookstep.in/billing?utm_source=mcp_paywall');
    expect(text).not.toMatch(/trial here/);
  });

  it('the link is Billing on the app with the MCP paywall source', () => {
    expect(mcpBillingUrl(app)).toBe('https://hookpost.hookstep.in/billing?utm_source=mcp_paywall');
    expect(mcpBillingUrl('https://hookpost.hookstep.in/')).toBe('https://hookpost.hookstep.in/billing?utm_source=mcp_paywall');
    expect(mcpBillingUrl('')).toBe('/billing?utm_source=mcp_paywall');
  });
});

describe('gateToolsByPlan', () => {
  const build = () => {
    const execute = jest.fn(async (input: { n: number }) => ({ doubled: input.n * 2 }));
    const tool = createTool({
      id: 'double',
      description: 'Doubles a number',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      execute,
    });
    return { tool, execute };
  };

  it('runs the tool when the request carries no refusal', async () => {
    const { tool, execute } = build();
    const gated = gateToolsByPlan({ double: tool }).double;
    const out = await runWithContext({ requestId: 'r', auth: { id: 'org' }, planRefusal: null }, () =>
      gated.execute!({ n: 2 }, {} as any)
    );
    expect(out).toEqual({ doubled: 4 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses before the tool runs when the request carries a refusal', async () => {
    const { tool, execute } = build();
    const gated = gateToolsByPlan({ double: tool }).double;
    const out: any = await runWithContext(
      {
        requestId: 'r',
        auth: { id: 'org' },
        planRefusal: { code: 'TRIAL_REQUIRED', message: 'Start your 3-day trial to schedule and publish posts.' },
      },
      () => gated.execute!({ n: 2 }, {} as any)
    );
    // The shape Mastra's MCP server answers as isError with `message` as text.
    expect(out).toEqual({
      error: true,
      message: expect.stringMatching(/^Hookpost needs an active plan to do this\. Start your 3-day trial here: .*\/billing\?utm_source=mcp_paywall \(it takes about a minute\), then ask me again\.$/),
      validationErrors: [],
    });
    expect(isValidationError(out)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the id, description, schemas and annotations, and leaves the original alone', () => {
    const { tool } = build();
    const gated = gateToolsByPlan({ double: tool }).double;
    expect(gated).not.toBe(tool);
    expect(gated.id).toBe('double');
    expect(gated.description).toBe('Doubles a number');
    expect(gated.inputSchema).toBe(tool.inputSchema);
    expect(gated.outputSchema).toBe(tool.outputSchema);
    expect(gated.mcp).toEqual(tool.mcp);
    expect(Object.getPrototypeOf(gated)).toBe(Object.getPrototypeOf(tool));
    expect(gated.execute).not.toBe(tool.execute);
  });

  it('outside a request (no context) it refuses: the plan is unknown', async () => {
    const { tool, execute } = build();
    const out: any = await gateToolsByPlan({ double: tool }).double.execute!({ n: 3 }, {} as any);
    expect(out).toMatchObject({ error: true, message: expect.stringMatching(/could not check/) });
    expect(execute).not.toHaveBeenCalled();
  });
});
