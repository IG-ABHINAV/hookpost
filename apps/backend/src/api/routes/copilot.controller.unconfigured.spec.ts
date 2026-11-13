import 'reflect-metadata';

// /copilot/chat on a server without an AI provider (no VERTEX_PROJECT, no
// OPENAI_API_KEY): a generation is refused with 503 and costs nothing, but
// CopilotKit's page-load handshake still reaches the runtime, because it wraps
// the whole app layout.
//   pnpm exec jest -c apps/backend/jest.config.ts copilot.controller.unconfigured

const handler = jest.fn();
jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: class {},
  OpenAIAdapter: class {},
  copilotRuntimeNodeHttpEndpoint: () => handler,
  copilotRuntimeNextJSAppRouterEndpoint: () => ({ handleRequest: jest.fn() }),
}));
jest.mock('@ag-ui/mastra', () => ({ MastraAgent: class {} }));
jest.mock('@mastra/core/di', () => ({ RequestContext: class {} }));
jest.mock('@hookpost/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

import { CopilotController } from '@hookpost/backend/api/routes/copilot.controller';

const saved = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  for (const key of [
    'AI_PROVIDER',
    'AI_TEXT_PROVIDER',
    'VERTEX_PROJECT',
    'OPENAI_API_KEY',
  ]) {
    delete process.env[key];
  }
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  process.env = saved;
});

const setup = () => {
  const subscription = { checkCredits: jest.fn(), useCredit: jest.fn() };
  const controller = new CopilotController(subscription as any, {} as any);
  const res: any = { status: jest.fn(() => res), json: jest.fn() };
  return { controller, subscription, res };
};

describe('/copilot/chat without an AI provider', () => {
  it('refuses a generation with 503 and takes no credit', async () => {
    const { controller, subscription, res } = setup();
    await controller.chatAgent(
      { id: 'org-1' } as any,
      {
        body: {
          operationName: 'generateCopilotResponse',
          query: 'mutation generateCopilotResponse { x }',
        },
      } as any,
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(subscription.checkCredits).not.toHaveBeenCalled();
    expect(subscription.useCredit).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('still answers the page-load handshake', async () => {
    const { controller, res } = setup();
    const req: any = {
      body: {
        operationName: 'availableAgents',
        query: 'query availableAgents { availableAgents { agents { id } } }',
      },
    };
    await controller.chatAgent({ id: 'org-1' } as any, req, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(req, res);
  });
});
