import 'reflect-metadata';

// /copilot/chat builds CopilotKit's endpoint once per process, not once per
// request: building it is synchronous and blocked the event loop for every
// request beside the page-load handshake (copilot.controller.ts).
//   pnpm exec jest -c apps/backend/jest.config.ts copilot.controller.handler

const handler = jest.fn();
const factory = jest.fn(() => handler);
jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: class {},
  OpenAIAdapter: class {},
  copilotRuntimeNodeHttpEndpoint: (...args: unknown[]) => factory(...(args as [])),
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

describe('/copilot/chat handler', () => {
  it('is built on the first request and reused by every later one', async () => {
    const controller = new CopilotController({} as any, {} as any);
    const handshake = () => ({
      body: {
        operationName: 'availableAgents',
        query: 'query availableAgents { availableAgents { agents { id } } }',
      },
    });
    for (let i = 0; i < 3; i++) {
      await controller.chatAgent({ id: `org-${i}` } as any, handshake() as any, {} as any);
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
