// context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlanGateCode } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

type Ctx = {
  requestId: string;
  auth: any; // replace with your org type if you have it, e.g. Organization
  // Set on the MCP endpoints for a workspace without a plan: every tool call
  // answers with it (mcp.plan.gate.ts gateToolsByPlan).
  planRefusal?: { code: PlanGateCode; message: string; days?: number } | null;
};

const als = new AsyncLocalStorage<Ctx>();

export function runWithContext<T>(ctx: Ctx, fn: () => Promise<T> | T) {
  return als.run(ctx, fn);
}

export function getContext(): Ctx | undefined {
  return als.getStore();
}

export function getAuth<T = any>(): T | undefined {
  return als.getStore()?.auth as T | undefined;
}

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
