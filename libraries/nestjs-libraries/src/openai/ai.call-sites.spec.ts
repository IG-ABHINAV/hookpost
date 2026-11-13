import 'reflect-metadata';

// Every place Hookpost calls an AI model, with the provider mocked: each one
// must reach Gemini on Vertex by default (google/<model>, the Vertex base
// URL), keep its prompt's structured output, and keep the AI credit
// accounting it had on OpenAI. ai.provider.spec.ts covers the provider layer
// itself; ai.provider.live.spec.ts makes the same calls for real.
//   pnpm exec jest -c apps/backend/jest.config.ts ai.call-sites

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: async () => 'ya29.test-token',
  })),
}));

// LangChain: record the model each node builds and what it asks of it.
const built: any[] = [];
const structured: any[] = [];
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((options) => {
    const model = {
      options,
      withStructuredOutput: (schema: any) => {
        structured.push({ options, keys: Object.keys(schema.shape) });
        return { kind: 'structured', schema };
      },
      bindTools: (tools: any[]) => ({ kind: 'tools', tools }),
    };
    built.push(model);
    return model;
  }),
}));
const answers: Record<string, unknown> = {};
jest.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromTemplate: () => ({
      pipe: (runnable: any) => ({
        invoke: async () =>
          runnable.kind === 'structured'
            ? answers[Object.keys(runnable.schema.shape)[0]]
            : { content: 'research' },
      }),
    }),
  },
}));

const uploadSimple = jest.fn(
  async (path: string) => `https://cdn.test/${path.slice(5, 15)}`
);
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple }) },
}));
for (const mod of [
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository',
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  '@hookpost/nestjs-libraries/database/prisma/media/media.repository',
  '@hookpost/nestjs-libraries/videos/video.manager',
]) {
  jest.mock(mod, () => new Proxy({}, { get: () => class {} }));
}
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

// AgentGraphService reads the workspace's links through OrganizationService,
// whose import chain builds a Resend client that throws without RESEND_API_KEY.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { HumanMessage } from '@langchain/core/messages';
import { AgentGraphService } from '@hookpost/nestjs-libraries/agent/agent.graph.service';
import { AgentGraphInsertService } from '@hookpost/nestjs-libraries/agent/agent.graph.insert.service';
import { AutopostService } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.service';
import { MediaService } from '@hookpost/nestjs-libraries/database/prisma/media/media.service';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import { vertexImageModels } from '@hookpost/nestjs-libraries/openai/ai.provider';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

const VERTEX_URL =
  'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const jpeg = (data = '/9j/PIC') =>
  json(200, {
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data } }] },
      },
    ],
  });

// SubscriptionService.useCredit(ForOrganizationId): `left` credits, released
// when the call fails (subscription.image-credits.spec.ts has the real one).
const credits = (left = 10) => {
  const used: string[] = [];
  const run = async (type: string, func: () => Promise<unknown>) => {
    if (left <= 0) throw new CreditsExceededError(type);
    left--;
    try {
      const out = await func();
      used.push(type);
      return out;
    } catch (err) {
      left++;
      throw err;
    }
  };
  return {
    used,
    left: () => left,
    useCredit: jest.fn(
      (_org: unknown, type: string, func: () => Promise<unknown>) =>
        run(type, func)
    ),
    useCreditForOrganizationId: jest.fn(
      (_org: string, type: string, func: () => Promise<unknown>) =>
        run(type, func)
    ),
  };
};

const fetchMock = jest.fn();
const realFetch = global.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  built.length = 0;
  structured.length = 0;
  delete process.env.AI_PROVIDER;
  delete process.env.AI_TEXT_PROVIDER;
  delete process.env.AI_IMAGE_PROVIDER;
  delete process.env.VERTEX_TEXT_MODEL;
  process.env.VERTEX_PROJECT = 'proj-1';
  global.fetch = fetchMock as any;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  // as if the startup lookup had found it (no model-list request)
  vertexImageModels.set('gemini-nano-banana-2.1');
});

afterAll(() => {
  process.env = savedEnv;
  global.fetch = realFetch;
});

const expectVertexModels = () => {
  expect(built.length).toBeGreaterThan(0);
  for (const model of built) {
    expect(model.options.model).toBe('google/gemini-3.8-flash');
    expect(model.options.configuration.baseURL).toBe(
      `${VERTEX_URL}/endpoints/openapi`
    );
  }
};

describe('post generator (AgentGraphService)', () => {
  const posts = {
    findAllExistingCategories: jest.fn(async () => [{ category: 'Tech' }]),
    findAllExistingTopicsOfCategory: jest.fn(async () => [{ topic: 'AI' }]),
    findPopularPosts: jest.fn(async () => [{ hook: 'h', content: 'c' }]),
  };

  it('research, category, topic, hook and content all run on Gemini', async () => {
    Object.assign(answers, {
      category: { category: 'Tech' },
      topic: { topic: 'AI' },
      hook: { hook: 'Most posts are boring.' },
      content: { content: [{ content: 'one' }, { content: 'two' }] },
    });
    const svc = new AgentGraphService(
      posts as any,
      {} as any,
      {} as any,
      {} as any,
      { getLinkSources: async () => [] } as any
    );
    const state: any = {
      messages: [new HumanMessage('write about AI editing')],
      fresearch: 'notes',
      tone: 'personal',
      format: 'thread_short',
      popularPosts: [{ hook: 'h' }],
    };
    await svc.startCall(state);
    expect((await svc.findCategories(state)).category).toBe('Tech');
    expect((await svc.findTopic({ ...state, category: 'Tech' })).topic).toBe(
      'AI'
    );
    expect((await svc.generateHook(state)).hook).toBe('Most posts are boring.');
    expect((await svc.generateContent(state)).content).toHaveLength(2);
    expectVertexModels();
    // Gemini 3 keeps its default temperature
    expect(built.every((m) => !('temperature' in m.options))).toBe(true);
    expect(structured.map((s) => s.keys[0])).toEqual([
      'category',
      'topic',
      'hook',
      'content',
    ]);
  });

  it('pictures come from Gemini, one ai_images credit each, stored as JPEG', async () => {
    fetchMock.mockImplementation(async () => jpeg());
    const sub = credits(5);
    const svc = new AgentGraphService(
      posts as any,
      {} as any,
      new OpenaiService(),
      sub as any,
      { getLinkSources: async () => [] } as any
    );
    const out: any = await svc.generatePictures({
      orgId: 'org-1',
      isPicture: true,
      content: [
        { content: 'a', prompt: 'a red bicycle' },
        { content: 'b', prompt: 'a blue kite' },
      ],
    } as any);
    expect(out.pictureError).toBeUndefined();
    expect(sub.used).toEqual(['ai_images', 'ai_images']);
    expect(sub.left()).toBe(3);
    expect(uploadSimple.mock.calls.map((c) => c[0])).toEqual([
      'data:image/jpeg;base64,/9j/PIC',
      'data:image/jpeg;base64,/9j/PIC',
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${VERTEX_URL}/publishers/google/models/gemini-nano-banana-2.1:generateContent`
    );
  });

  it('a picture Gemini refuses gives its credit back and says the safety system rejected it', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { candidates: [{ finishReason: 'NO_IMAGE' }] })
    );
    const sub = credits(5);
    const svc = new AgentGraphService(
      posts as any,
      {} as any,
      new OpenaiService(),
      sub as any,
      { getLinkSources: async () => [] } as any
    );
    const out: any = await svc.generatePictures({
      orgId: 'org-1',
      isPicture: true,
      content: [{ content: 'a', prompt: 'x' }],
    } as any);
    expect(sub.used).toEqual([]);
    expect(sub.left()).toBe(5); // the credit came back
    expect(out.pictureError).toContain('The AI safety system rejected');
    expect(out.content[0].image).toBeUndefined();
  });

  it('out of image credits: Gemini is never called', async () => {
    const svc = new AgentGraphService(
      posts as any,
      {} as any,
      new OpenaiService(),
      credits(0) as any,
      { getLinkSources: async () => [] } as any
    );
    const out: any = await svc.generatePictures({
      orgId: 'org-1',
      isPicture: true,
      content: [{ content: 'a', prompt: 'x' }],
    } as any);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.pictureError).toContain('out of AI image credits');
  });
});

describe('popular posts classifier (AgentGraphInsertService)', () => {
  it('category, topic and hook run on Gemini', async () => {
    Object.assign(answers, {
      category: { category: 'Tech' },
      topic: { topic: 'AI' },
      hook: { hook: 'Most posts are boring.' },
    });
    const svc = new AgentGraphInsertService({} as any);
    const state: any = { messages: [new HumanMessage('post')] };
    expect(await svc.findCategory(state)).toEqual({ category: 'Tech' });
    expect(await svc.findTopic(state)).toEqual({ topic: 'AI' });
    expect(await svc.findHook(state)).toEqual({
      hook: 'Most posts are boring.',
    });
    expectVertexModels();
  });
});

describe('RSS auto-post (AutopostService)', () => {
  it('writes the post and the picture prompt on Gemini, and draws on Gemini', async () => {
    Object.assign(answers, {
      socialMediaPostContent: { socialMediaPostContent: 'New on the blog' },
      generatedTextToBeSentToDallE: {
        generatedTextToBeSentToDallE: 'a lighthouse',
      },
    });
    fetchMock.mockImplementation(async () => jpeg('/9j/LIGHT'));
    const sub = credits(3);
    const svc = new AutopostService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new OpenaiService(),
      sub as any
    );
    const state: any = {
      body: { organizationId: 'org-1', generateContent: true },
      load: { description: 'A post about lighthouses' },
      description: '',
    };
    const written: any = await svc.generateDescription(state);
    expect(written.description).toBe('New on the blog');
    const pictured: any = await svc.generatePicture(state);
    expect(pictured.image).toMatch(/^https:\/\/cdn\.test\//);
    expect(uploadSimple).toHaveBeenCalledWith(
      'data:image/jpeg;base64,/9j/LIGHT'
    );
    expect(sub.used).toEqual(['ai_images']);
    expectVertexModels();
  });
});

describe('media library and the agent tool (MediaService.generateImage)', () => {
  it('writes the picture prompt on Gemini, then draws it, for one credit', async () => {
    const create = jest.fn();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.endsWith('/chat/completions')) {
        create(JSON.parse(init.body));
        return json(200, {
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'google/gemini-3.8-flash',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '{"prompt":"a detailed cat"}',
              },
            },
          ],
        });
      }
      return jpeg('/9j/CAT');
    });
    const sub = credits(2);
    const media = new MediaService(
      {} as any,
      new OpenaiService(),
      sub as any,
      {} as any
    );
    await expect(
      media.generateImage('cat', { id: 'org-1' } as any, true)
    ).resolves.toBe('/9j/CAT');
    expect(create.mock.calls[0][0].model).toBe('google/gemini-3.8-flash');
    expect(create.mock.calls[0][0].response_format.type).toBe('json_schema');
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).contents[0].parts[0].text
    ).toBe('a detailed cat');
    expect(sub.used).toEqual(['ai_images']);
  });

  it('a refused picture is a 422 for the user and costs no credit', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { promptFeedback: { blockReason: 'SAFETY' } })
    );
    const sub = credits(2);
    const media = new MediaService(
      {} as any,
      new OpenaiService(),
      sub as any,
      {} as any
    );
    const err = await media
      .generateImage('x', { id: 'org-1' } as any)
      .catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(sub.used).toEqual([]);
    expect(sub.left()).toBe(2);
  });

  it('a Vertex quota error is a 429 for the user and costs no credit', async () => {
    fetchMock.mockImplementation(async () =>
      json(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Resource exhausted.',
        },
      })
    );
    const sub = credits(2);
    const media = new MediaService(
      {} as any,
      new OpenaiService(),
      sub as any,
      {} as any
    );
    const err = await media
      .generateImage('x', { id: 'org-1' } as any)
      .catch((e) => e);
    expect(err.getStatus()).toBe(429);
    expect(sub.used).toEqual([]);
    expect(sub.left()).toBe(2);
  });
});
