import {
  knownTrialDays,
  planGateMessage,
  PlanGateCode,
  TRIAL_DAYS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { getContext } from '@hookpost/nestjs-libraries/chat/async.storage';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

export interface McpPlanRefusal {
  code: PlanGateCode;
  message: string;
  /** The workspace's own trial length, for TRIAL_REQUIRED (trialDaysFor). */
  days?: number;
}

/**
 * Why this workspace may not use MCP, or null when it may: needs_trial
 * (TRIAL_REQUIRED) and locked (PLAN_REQUIRED) are refused, workspaces on the
 * Free plan from before the cutoff are not.
 *
 * `planGate` is SubscriptionService.planGate, called WITHOUT the request's
 * country: the caller here is an AI client's server, not the customer. While
 * both cutoffs are empty it reads nothing and nobody is refused. A gate that
 * cannot be read refuses nobody.
 *
 * `trialDays` is SubscriptionService.trialDaysFor, so TRIAL_REQUIRED names the
 * workspace's own trial length (7 for one the Free plan sunset notice
 * promised 7 to); without it, or when it fails, TRIAL_DAYS.
 */
export async function mcpPlanRefusal(
  planGate: (organizationId: string) => Promise<PlanGateCode | null>,
  org: { id?: string } | null | undefined,
  trialDays?: (organizationId: string) => Promise<number>
): Promise<McpPlanRefusal | null> {
  if (!org?.id) return null;
  const gate = await planGate(org.id).catch(() => null);
  if (!gate) return null;
  const days =
    gate === 'TRIAL_REQUIRED' && trialDays
      ? await trialDays(org.id).catch(() => TRIAL_DAYS)
      : TRIAL_DAYS;
  return { code: gate, message: planGateMessage(gate, days), days };
}

/** utm_source on the Billing link a refused tool call hands the assistant. */
export const MCP_PAYWALL_SOURCE = 'mcp_paywall';

/**
 * Where a refused tool call sends the user: Billing on the app, which for a
 * workspace without a plan is the paywall itself (PlanGateScreen on /billing
 * skips the connect step) with the plans in the currency the server picks
 * for that visitor (/billing/pricing-context). Signed out, the app's
 * middleware sends them through /auth and back here.
 */
export function mcpBillingUrl(frontendUrl = process.env.FRONTEND_URL): string {
  const path = `/billing?utm_source=${MCP_PAYWALL_SOURCE}`;
  return frontendUrl ? new URL(path, frontendUrl).toString() : path;
}

/**
 * What a refused tool call says: one plain paragraph the assistant (Claude,
 * ChatGPT, Cursor) relays to the user as it is, with the link to start the
 * trial. On 27 Oct 2026 twelve sign-ups came in through the Claude connector
 * and none started the trial; inside Claude this sentence is the only
 * paywall they see.
 */
export function mcpPlanRefusalText(
  refusal: McpPlanRefusal,
  frontendUrl = process.env.FRONTEND_URL
): string {
  const url = mcpBillingUrl(frontendUrl);
  if (refusal.code === 'TRIAL_REQUIRED') {
    const days = knownTrialDays(refusal.days);
    return `Hookpost needs an active plan to do this. Start your ${days}-day trial here: ${url} (it takes about a minute), then ask me again.`;
  }
  return `Hookpost needs an active plan to do this. This workspace has no active plan or trial; choose a plan here: ${url} (it takes about a minute), then ask me again.`;
}

/**
 * Every MCP endpoint (OAuth: /mcp-oauth for ChatGPT, /mcp-oauth-claude; API
 * key: /mcp, /mcp/:key, /sse/:key) lets a workspace without a plan through
 * `initialize` and `tools/list` (no cost, nothing of the workspace read), and
 * every tool call answers with mcpPlanRefusalText instead (the route puts the
 * refusal in the request context as `planRefusal`). A 402 failed the
 * connection with a generic error, so the user never learned why. The API-key
 * endpoints answered 402 until 27 Oct 2026.
 *
 * Returns copies of the tools whose execute refuses before the tool runs; the
 * originals (used by the API-key endpoints and the in-app agent) are
 * untouched. The check is here, in one place, rather than in each tool.
 */
export function gateToolsByPlan<T extends Record<string, any>>(tools: T): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (!tool || typeof tool.execute !== 'function') return [name, tool];
      const gated = Object.assign(
        Object.create(Object.getPrototypeOf(tool)),
        tool
      );
      gated.execute = async (...args: any[]) => {
        const context = getContext();
        // Fails closed: these copies only serve the OAuth routes, which always
        // run them inside runWithContext. Without one the plan is unknown.
        const message = !context
          ? 'Hookpost could not check this workspace\'s plan. Try again.'
          : context.planRefusal
          ? mcpPlanRefusalText(context.planRefusal)
          : null;
        if (message) {
          // Mastra's MCP server answers a result of this shape (its
          // ValidationError, isValidationError) as `isError: true` with
          // exactly `message` as the text. A thrown Error would reach the
          // client as a MastraError JSON blob that also echoes the arguments.
          return { error: true, message, validationErrors: [] };
        }
        return tool.execute(...args);
      };
      return [name, gated];
    })
  ) as T;
}

/**
 * What ask_hookpost answers when the workspace has no AI to spend: a Free
 * plan (no AI), a plan that has ended or whose payment is failing, or a
 * monthly allowance used up. Relayed by the assistant as it is.
 */
export function mcpNoAiText(frontendUrl = process.env.FRONTEND_URL): string {
  return `Hookpost AI isn't available on this workspace right now: its plan doesn't include AI, this month's AI allowance is used up, or its last payment didn't go through. See Billing: ${mcpBillingUrl(frontendUrl)}. Scheduling and the other tools still work.`;
}

/**
 * The agent the API-key MCP endpoints expose as ask_hookpost, metered like
 * the in-app agent (/copilot/agent): each question takes one `ai_text`
 * credit before the model runs, and gets it back if the model fails
 * (`useCredit` is SubscriptionService.useCreditForOrganizationId). Until
 * 2 Nov 2026 it ran the model with no check at all, so every workspace's API
 * key, a Free one's included, was free use of the model at Hookpost's cost.
 *
 * Mastra turns an agent into the ask_<key> tool by calling its `generate`,
 * so only that is replaced; everything else is the agent's own, called on
 * the agent itself. A refusal is the result shape Mastra answers as
 * `isError: true` with the message as the text (as in gateToolsByPlan).
 */
export function meterAgentByCredits<T extends { generate: (...args: any[]) => any }>(
  agent: T,
  useCredit: (organizationId: string, run: () => Promise<any>) => Promise<any>
): T {
  const generate = async (...args: any[]) => {
    const organizationId = getContext()?.auth?.id;
    if (!organizationId) {
      return {
        error: true,
        message: "Hookpost could not check this workspace's plan. Try again.",
        validationErrors: [],
      };
    }
    try {
      return await useCredit(organizationId, () => agent.generate(...args));
    } catch (e) {
      if (e instanceof CreditsExceededError) {
        return { error: true, message: mcpNoAiText(), validationErrors: [] };
      }
      throw e;
    }
  };
  return new Proxy(agent, {
    get(target, prop) {
      if (prop === 'generate') return generate;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
