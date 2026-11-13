import 'reflect-metadata';

// POST /posts/generator streams the agent's events, so an AI failure after
// the stream has started ends it with an error event. Its message comes from
// generationError: a safety rejection, a busy provider and a timeout each say
// what happened; anything else stays the generic message.
//   pnpm exec jest -c apps/backend/jest.config.ts posts.controller.generator

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/agent/agent.graph.service', () => ({
  AgentGraphService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/short-linking/short.link.service',
  () => ({ ShortLinkService: class {} })
);

import { PostsController } from '@hookpost/backend/api/routes/posts.controller';

const run = async (err: unknown) => {
  const written: string[] = [];
  const res: any = {
    setHeader: jest.fn(),
    write: (chunk: string) => written.push(chunk),
    end: jest.fn(),
  };
  const agent = {
    start: () =>
      (async function* () {
        yield { name: 'agent' };
        throw err;
      })(),
  };
  const controller = new PostsController({} as any, agent as any, {} as any);
  await controller.generatePosts({ id: 'org-1' } as any, {} as any, res);
  expect(res.end).toHaveBeenCalled();
  return JSON.parse(written[written.length - 1]);
};

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /posts/generator error event', () => {
  it('names a safety rejection', async () => {
    const last = await run(
      new Error('Your request was rejected by the safety system: declined')
    );
    expect(last).toEqual({
      name: 'error',
      error: true,
      message: expect.stringContaining('rejected by the AI safety system'),
    });
  });

  it('says the AI is busy on a provider 429', async () => {
    const last = await run({ status: 429, message: 'Resource exhausted.' });
    expect(last.message).toMatch(/busy right now/);
  });

  it('says it took too long on a timeout', async () => {
    const err = new Error('Request timed out.');
    err.name = 'APIConnectionTimeoutError';
    expect((await run(err)).message).toMatch(/took too long/);
  });

  it('keeps the generic message for anything else', async () => {
    expect((await run(new Error('boom'))).message).toBe(
      'Something went wrong while generating your posts, please try again.'
    );
  });
});
