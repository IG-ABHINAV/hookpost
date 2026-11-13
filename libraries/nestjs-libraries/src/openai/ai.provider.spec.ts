import 'reflect-metadata';

// Gemini on Vertex AI replaced OpenAI as the default AI provider (paid by the
// Google Cloud credits); OpenAI stays behind AI_PROVIDER=openai and the
// per-feature overrides. Everything here is mocked: no request leaves the
// process. The live counterpart is ai.provider.live.spec.ts (VERTEX_LIVE=1).
//   pnpm exec jest -c apps/backend/jest.config.ts ai.provider.spec

const getAccessToken = jest.fn(async () => 'ya29.test-token');
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({ getAccessToken })),
}));

const openaiCtor = jest.fn();
const parse = jest.fn();
const create = jest.fn();
const stream = jest.fn();
const imagesGenerate = jest.fn();
jest.mock('openai', () => {
  const OpenAI = jest.fn().mockImplementation((options) => {
    openaiCtor(options);
    return {
      chat: { completions: { parse, create, stream } },
      images: { generate: imagesGenerate },
    };
  });
  return { __esModule: true, default: OpenAI };
});

const chatOpenAICtor = jest.fn();
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((options) => {
    chatOpenAICtor(options);
    return { options };
  }),
}));

import {
  aiConfigured,
  aiModel,
  aiProvider,
  agentLanguageModel,
  chatModelId,
  langchainChatModel,
  prepareVertexChatBody,
  SKIP_THOUGHT_SIGNATURE,
  vertexFetch,
  vertexGenerateImage,
  vertexImageModels,
  vertexListPublisherModels,
  vertexOpenAiBaseUrl,
} from '@hookpost/nestjs-libraries/openai/ai.provider';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import { generationError } from '@hookpost/nestjs-libraries/openai/generation.error';
import { base64ImageDataUrl } from '@hookpost/nestjs-libraries/upload/data.url';
import {
  copilotServiceAdapter,
  withNoInventedFactsRule,
} from '@hookpost/nestjs-libraries/chat/copilot.adapter';
import { NO_INVENTED_FACTS_RULE } from '@hookpost/nestjs-libraries/openai/invented.links';

const AI_ENV = [
  'AI_PROVIDER',
  'AI_TEXT_PROVIDER',
  'AI_AGENT_PROVIDER',
  'AI_IMAGE_PROVIDER',
  'VERTEX_PROJECT',
  'VERTEX_LOCATION',
  'VERTEX_CREDENTIALS_FILE',
  'VERTEX_TEXT_MODEL',
  'VERTEX_AGENT_MODEL',
  'AI_IMAGE_MODEL',
  'VERTEX_FALLBACK_MODELS',
  'VERTEX_IMAGE_FALLBACK_MODELS',
  'VERTEX_REASONING_EFFORT',
  'OPENAI_API_KEY',
  'OPENAI_TEXT_MODEL',
  'OPENAI_AGENT_MODEL',
  'OPENAI_IMAGE_MODEL',
  'AI_TIMEOUT_MS',
];
const saved: Record<string, string | undefined> = {};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const image = (data: string, mimeType = 'image/jpeg') => ({
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ inlineData: { mimeType, data } }] },
    },
  ],
});

const fetchMock = jest.fn();
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of AI_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.VERTEX_PROJECT = 'proj-1';
  process.env.OPENAI_API_KEY = 'sk-test';
  global.fetch = fetchMock as any;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // as if the startup lookup had found it (no model-list request)
  vertexImageModels.set('gemini-nano-banana-2.1');
});

afterEach(() => {
  for (const key of AI_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  global.fetch = realFetch;
});

describe('provider selection', () => {
  it('with nothing chosen, an install with only an OpenAI key stays on OpenAI', () => {
    delete process.env.VERTEX_PROJECT;
    expect(aiProvider('text')).toBe('openai');
    delete process.env.OPENAI_API_KEY;
    expect(aiProvider('text')).toBe('vertex');
    process.env.AI_PROVIDER = 'vertex';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(aiProvider('text')).toBe('vertex');
  });

  it('refuses a project or location that is not a plain id, before any token', async () => {
    const base = jest.fn(async () => json(200, {}));
    process.env.VERTEX_LOCATION = 'evil.test/x?';
    await expect(
      vertexFetch(base as any)(
        'https://aiplatform.googleapis.com/v1/x/chat/completions',
        { method: 'POST', body: '{}' }
      )
    ).rejects.toThrow('invalid VERTEX_LOCATION');
    process.env.VERTEX_LOCATION = 'global';
    process.env.VERTEX_PROJECT = 'proj/../other';
    await expect(vertexGenerateImage('x')).rejects.toThrow('VERTEX_PROJECT');
    expect(base).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('an install without any AI still boots: building the clients never throws', () => {
    delete process.env.VERTEX_PROJECT;
    delete process.env.OPENAI_API_KEY;
    expect(() => agentLanguageModel()).not.toThrow();
    expect(() => langchainChatModel(0)).not.toThrow();
    expect(() => copilotServiceAdapter()).not.toThrow();
    expect(() => new OpenaiService()).not.toThrow();
  });

  it('defaults to Gemini on Vertex for every kind of call', () => {
    for (const feature of ['text', 'agent', 'image'] as const) {
      expect(aiProvider(feature)).toBe('vertex');
    }
    expect(chatModelId('text')).toBe('google/gemini-3.8-flash');
    expect(chatModelId('agent')).toBe('google/gemini-3.8-flash');
    expect(aiModel('image')).toBe('gemini-nano-banana-2.1');
  });

  it('AI_PROVIDER=openai moves everything back to OpenAI with its old models', () => {
    process.env.AI_PROVIDER = 'openai';
    expect(chatModelId('text')).toBe('gpt-4.1-mini');
    expect(chatModelId('agent')).toBe('gpt-4.1-mini');
    expect(aiModel('image')).toBe('gpt-image-1-mini');
    process.env.OPENAI_TEXT_MODEL = 'gpt-5-mini';
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-1';
    expect(chatModelId('text')).toBe('gpt-5-mini');
    expect(aiModel('image')).toBe('gpt-image-1');
  });

  it('a per-feature override wins over AI_PROVIDER', () => {
    process.env.AI_PROVIDER = 'vertex';
    process.env.AI_IMAGE_PROVIDER = 'OpenAI ';
    expect(aiProvider('image')).toBe('openai');
    expect(aiProvider('text')).toBe('vertex');
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_AGENT_PROVIDER = 'vertex';
    expect(aiProvider('agent')).toBe('vertex');
    expect(aiProvider('text')).toBe('openai');
  });

  it('model names come from the VERTEX_* variables, agent falling back to text', () => {
    process.env.VERTEX_TEXT_MODEL = 'gemini-3.6-flash';
    expect(chatModelId('agent')).toBe('google/gemini-3.6-flash');
    process.env.VERTEX_AGENT_MODEL = 'gemini-3.1-pro-preview';
    expect(chatModelId('agent')).toBe('google/gemini-3.1-pro-preview');
  });

  it('the image model is the resolved one; before any lookup, AI_IMAGE_MODEL then the static chain', () => {
    vertexImageModels.set('gemini-3.10-flash-image');
    expect(aiModel('image')).toBe('gemini-3.10-flash-image');
    vertexImageModels.set(undefined);
    expect(aiModel('image')).toBe('gemini-nano-banana-2.1');
    process.env.AI_IMAGE_MODEL = 'gemini-3.2-flash-image';
    expect(aiModel('image')).toBe('gemini-3.2-flash-image');
  });

  it('is configured only with what the chosen provider needs', () => {
    process.env.AI_PROVIDER = 'vertex';
    expect(aiConfigured('text')).toBe(true);
    delete process.env.VERTEX_PROJECT;
    expect(aiConfigured('text')).toBe(false);
    process.env.AI_PROVIDER = 'openai';
    expect(aiConfigured('text')).toBe(true);
    delete process.env.OPENAI_API_KEY;
    expect(aiConfigured('text')).toBe(false);
  });

  it('builds the global and the regional Vertex URLs', () => {
    expect(vertexOpenAiBaseUrl()).toBe(
      'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/endpoints/openapi'
    );
    process.env.VERTEX_LOCATION = 'us-central1';
    expect(vertexOpenAiBaseUrl()).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/endpoints/openapi'
    );
  });
});

describe('prepareVertexChatBody', () => {
  const toolCall = (id: string, extra?: unknown) => ({
    id,
    type: 'function',
    function: { name: 'pick', arguments: '{}' },
    ...(extra ? { extra_content: extra } : {}),
  });

  it('gives a tool call that lost its thought signature the documented placeholder', () => {
    const out = prepareVertexChatBody({
      model: 'google/gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall('a'), toolCall('b')],
        },
        { role: 'tool', tool_call_id: 'a', content: 'ok' },
      ],
    });
    for (const call of out.messages[1].tool_calls) {
      expect(call.extra_content.google.thought_signature).toBe(
        SKIP_THOUGHT_SIGNATURE
      );
    }
    expect(out.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('keeps a real signature', () => {
    const out = prepareVertexChatBody({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            toolCall('a', { google: { thought_signature: 'REAL' } }),
          ],
        },
      ],
    });
    expect(
      out.messages[0].tool_calls[0].extra_content.google.thought_signature
    ).toBe('REAL');
  });

  it('sends developer messages as system, which is all Vertex accepts', () => {
    const out = prepareVertexChatBody({
      messages: [{ role: 'developer', content: 'rules' }],
    });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'rules' });
  });

  it('asks for low reasoning effort unless told otherwise', () => {
    expect(prepareVertexChatBody({ messages: [] }).reasoning_effort).toBe(
      'low'
    );
    expect(
      prepareVertexChatBody({ messages: [], reasoning_effort: 'high' })
        .reasoning_effort
    ).toBe('high');
    process.env.VERTEX_REASONING_EFFORT = 'medium';
    expect(prepareVertexChatBody({ messages: [] }).reasoning_effort).toBe(
      'medium'
    );
    process.env.VERTEX_REASONING_EFFORT = '';
    expect(prepareVertexChatBody({ messages: [] })).not.toHaveProperty(
      'reasoning_effort'
    );
  });
});

describe('vertexFetch', () => {
  const url = `${'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/endpoints/openapi'}/chat/completions`;
  const body = (model = 'google/gemini-3.8-flash') =>
    JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });

  it("replaces the client's key with the service account's access token", async () => {
    const base = jest.fn(async () => json(200, { ok: true }));
    await vertexFetch(base as any)(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer vertex-ai', 'X-Other': '1' },
      body: body(),
    });
    const [, init] = base.mock.calls[0] as any;
    expect(init.headers.get('authorization')).toBe('Bearer ya29.test-token');
    expect(init.headers.get('x-other')).toBe('1');
    expect(JSON.parse(init.body).reasoning_effort).toBe('low');
  });

  it('a busy model (429) is retried with each fallback model, in order', async () => {
    process.env.VERTEX_FALLBACK_MODELS =
      'gemini-3.6-flash, gemini-3.5-flash-lite';
    const base = jest
      .fn()
      .mockResolvedValueOnce(
        json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
      )
      .mockResolvedValueOnce(
        json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    const res = await vertexFetch(base)(url, { method: 'POST', body: body() });
    expect(res.status).toBe(200);
    expect(
      base.mock.calls.map((c: any) => JSON.parse(c[1].body).model)
    ).toEqual([
      'google/gemini-3.8-flash',
      'google/gemini-3.6-flash',
      'google/gemini-3.5-flash-lite',
    ]);
  });

  it('returns the last 429 when every model is busy, for the client to report', async () => {
    const base = jest.fn(async () =>
      json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
    );
    const res = await vertexFetch(base as any)(url, {
      method: 'POST',
      body: body(),
    });
    expect(res.status).toBe(429);
    // the primary plus the default fallback (gemini-3.5-flash-lite)
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('does not retry another error, and does not repeat the primary as a fallback', async () => {
    process.env.VERTEX_FALLBACK_MODELS = 'gemini-3.8-flash';
    const base = jest.fn(async () => json(400, { error: 'bad' }));
    await vertexFetch(base as any)(url, { method: 'POST', body: body() });
    expect(base).toHaveBeenCalledTimes(1);
    const busy = jest.fn(async () => json(429, {}));
    await vertexFetch(busy as any)(url, { method: 'POST', body: body() });
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it('passes a non-chat Vertex request through untouched, but authorized', async () => {
    const base = jest.fn(async () => json(200, {}));
    await vertexFetch(base as any)(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/models',
      { method: 'GET' }
    );
    const [, init] = base.mock.calls[0] as any;
    expect(init.body).toBeUndefined();
    expect(init.headers.get('authorization')).toBe('Bearer ya29.test-token');
  });

  it('never sends the Google token anywhere but Vertex', async () => {
    const base = jest.fn(async () => json(200, {}));
    for (const other of [
      'https://example.test/chat/completions',
      'http://aiplatform.googleapis.com/v1/x',
      'https://aiplatform.googleapis.com.evil.test/v1/x',
      'https://evil.test/?https://aiplatform.googleapis.com',
    ]) {
      await expect(
        vertexFetch(base as any)(other, { method: 'POST', body: '{}' })
      ).rejects.toThrow('refusing to send the Google token');
    }
    expect(base).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('frees a busy (429) response before trying the next model', async () => {
    const cancel = jest.fn(async () => undefined);
    const busy = json(429, {});
    Object.defineProperty(busy, 'body', { value: { cancel } });
    const base = jest
      .fn()
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(json(200, { ok: true }));
    await vertexFetch(base)(url, { method: 'POST', body: body() });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('vertexGenerateImage', () => {
  it('asks the image model for one picture in the given ratio', async () => {
    fetchMock.mockResolvedValue(json(200, image('/9j/AAAA')));
    await expect(vertexGenerateImage('a cat', '3:4')).resolves.toBe('/9j/AAAA');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-nano-banana-2.1:generateContent'
    );
    expect(init.headers.Authorization).toBe('Bearer ya29.test-token');
    const sent = JSON.parse(init.body);
    expect(sent.contents[0].parts[0].text).toBe('a cat');
    expect(sent.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '3:4', imageSize: '1K' },
    });
  });

  it('a prompt Google blocks is a safety rejection the user sees (422)', async () => {
    fetchMock.mockResolvedValue(
      json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })
    );
    const err = await vertexGenerateImage('x').catch((e) => e);
    const http = generationError(err);
    expect(http.getStatus()).toBe(422);
    expect(http.message).toContain('Flagged categories: prohibited_content');
  });

  it('skips interim thought images and keeps the final picture', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: { mimeType: 'image/png', data: 'iVBORdraft' },
                },
                { inlineData: { mimeType: 'image/jpeg', data: '/9j/final' } },
              ],
            },
          },
        ],
      })
    );
    await expect(vertexGenerateImage('x')).resolves.toBe('/9j/final');
  });

  it('a picture the model declines (NO_IMAGE) is a safety rejection too', async () => {
    fetchMock.mockResolvedValue(
      json(200, { candidates: [{ finishReason: 'NO_IMAGE' }] })
    );
    const err = await vertexGenerateImage('x').catch((e) => e);
    expect(generationError(err).getStatus()).toBe(422);
  });

  it('an IMAGE_SAFETY finish names the category', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }],
      })
    );
    const err = await vertexGenerateImage('x').catch((e) => e);
    expect(generationError(err).message).toContain('image_safety');
  });

  it('a busy image model (429) is retried with the fallback image model', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
      )
      .mockResolvedValueOnce(json(200, image('iVBORfallback')));
    await expect(vertexGenerateImage('x')).resolves.toBe('iVBORfallback');
    expect(fetchMock.mock.calls.map((c) => c[0].split('/models/')[1])).toEqual([
      'gemini-nano-banana-2.1:generateContent',
      'gemini-3.1-flash-lite-image:generateContent',
    ]);
  });

  it('a process that has not resolved yet looks the model up first, then draws with it', async () => {
    vertexImageModels.set(undefined);
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          publisherModels: [
            {
              name: 'publishers/google/models/gemini-3.1-flash-image',
              launchStage: 'GA',
            },
            {
              name: 'publishers/google/models/gemini-3.9-flash-image',
              launchStage: 'GA',
            },
            {
              name: 'publishers/google/models/gemini-4-flash-image-preview',
              launchStage: 'PUBLIC_PREVIEW',
            },
          ],
        })
      )
      .mockResolvedValueOnce(json(200, image('/9j/NEW')));
    await expect(vertexGenerateImage('x')).resolves.toBe('/9j/NEW');
    const [listUrl, listInit] = fetchMock.mock.calls[0];
    expect(listUrl).toBe(
      'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100'
    );
    expect(listInit.headers['x-goog-user-project']).toBe('proj-1');
    expect(fetchMock.mock.calls[1][0]).toContain(
      '/models/gemini-nano-banana-2.1:generateContent'
    );
  });

  it('a failed model lookup draws with AI_IMAGE_MODEL, falling back to the static chain on a 429', async () => {
    vertexImageModels.set(undefined);
    process.env.AI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
    fetchMock
      .mockResolvedValueOnce(json(403, { error: { message: 'denied' } }))
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, image('/9j/OK')));
    await expect(vertexGenerateImage('x')).resolves.toBe('/9j/OK');
    expect(
      fetchMock.mock.calls.slice(1).map((c) => c[0].split('/models/')[1])
    ).toEqual([
      'gemini-3.1-flash-lite-image:generateContent',
      'gemini-nano-banana-2.1:generateContent',
    ]);
  });

  it('the model list is read page by page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          publisherModels: [
            { name: 'publishers/google/models/a', launchStage: 'GA' },
          ],
          nextPageToken: 'p2',
        })
      )
      .mockResolvedValueOnce(
        json(200, { publisherModels: [{ name: 'publishers/google/models/b' }] })
      );
    await expect(vertexListPublisherModels()).resolves.toEqual([
      { id: 'publishers/google/models/a', launchStage: 'GA' },
      { id: 'publishers/google/models/b', launchStage: undefined },
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain('pageToken=p2');
  });

  it('a quota error is a 429 the user can retry, not a safety message', async () => {
    fetchMock.mockImplementation(async () =>
      json(429, {
        error: {
          code: 429,
          message: 'Resource exhausted.',
          status: 'RESOURCE_EXHAUSTED',
        },
      })
    );
    const http = generationError(
      await vertexGenerateImage('x').catch((e) => e)
    );
    expect(http.getStatus()).toBe(429);
    expect(http.message).toMatch(/try again in a minute/);
  });

  it('a server error or a text-only answer is a generic failure (500)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>oops</html>', { status: 503 })
    );
    expect(
      generationError(
        await vertexGenerateImage('x').catch((e) => e)
      ).getStatus()
    ).toBe(500);
    fetchMock.mockResolvedValueOnce(
      json(200, {
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: 'I cannot' }] } },
        ],
      })
    );
    const err = await vertexGenerateImage('x').catch((e) => e);
    expect(err.message).toContain('returned no image');
    expect(generationError(err).getStatus()).toBe(500);
  });

  it('a request that hangs past AI_TIMEOUT_MS is aborted, and is a 504', async () => {
    process.env.AI_TIMEOUT_MS = '20';
    // never answers; only the abort signal ends it
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason)
          )
        )
    );
    const http = generationError(
      await vertexGenerateImage('x').catch((e) => e)
    );
    expect(http.getStatus()).toBe(504);
  });
});

describe('OpenaiService on Vertex', () => {
  const service = new OpenaiService();

  it('text calls go to the Vertex OpenAI endpoint as google/<model>', async () => {
    parse.mockResolvedValue({
      choices: [{ message: { parsed: { prompt: 'long prompt' } } }],
    });
    await expect(service.generatePromptForPicture('a cat')).resolves.toBe(
      'long prompt'
    );
    expect(openaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/endpoints/openapi',
        fetch: expect.any(Function),
        maxRetries: 2,
        timeout: 120_000,
      })
    );
    expect(parse.mock.calls[0][0].model).toBe('google/gemini-3.8-flash');
    expect(parse.mock.calls[0][0].response_format.type).toBe('json_schema');
  });

  it('every text method keeps its schema and sends the Vertex model', async () => {
    parse.mockImplementation(async (params: any) => ({
      choices: [
        {
          message: {
            parsed: {
              voice: 'hello...',
              posts: ['one', 'two'],
              post: 'short',
              slides: [{ imagePrompt: 'p', voiceText: 'v' }],
            },
          },
        },
      ],
    }));
    create.mockResolvedValue({
      choices: [{ message: { content: '[{"post":"hi"}]' } }],
    });
    await service.generateVoiceFromText('x');
    await service.separatePosts('x', 280);
    await service.generateSlidesFromText('x');
    await service.generatePosts('x');
    for (const call of [...parse.mock.calls, ...create.mock.calls]) {
      expect(call[0].model).toBe('google/gemini-3.8-flash');
    }
    expect(
      parse.mock.calls.map((c) => c[0].response_format.json_schema.name)
    ).toEqual(['voice', 'separatePosts', 'slides']);
    // generatePosts asks for five candidates per prompt, as before
    expect(create.mock.calls.every((c) => c[0].n === 5)).toBe(true);
  });

  it('pictures come from the Gemini image model, 3:4 when vertical', async () => {
    fetchMock.mockResolvedValue(json(200, image('/9j/BBBB')));
    await expect(service.generateImage('a cat', true)).resolves.toBe(
      '/9j/BBBB'
    );
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.imageConfig
    ).toEqual({
      aspectRatio: '3:4',
      imageSize: '1K',
    });
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('AI_IMAGE_PROVIDER=openai keeps gpt-image for pictures only', async () => {
    process.env.AI_IMAGE_PROVIDER = 'openai';
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: 'iVBORw0' }] });
    await expect(service.generateImage('a cat', true)).resolves.toBe('iVBORw0');
    expect(imagesGenerate).toHaveBeenCalledWith({
      prompt: 'a cat',
      model: 'gpt-image-1-mini',
      size: '1024x1536',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LangChain, the agent and CopilotKit follow the switch', () => {
  it('LangChain goes to Vertex without a temperature (Gemini 3 wants its default)', () => {
    langchainChatModel(0.7);
    const options = chatOpenAICtor.mock.calls[0][0];
    expect(options.model).toBe('google/gemini-3.8-flash');
    expect(options.configuration.baseURL).toContain('/endpoints/openapi');
    expect(options.configuration.fetch).toEqual(expect.any(Function));
    expect(options).not.toHaveProperty('temperature');
  });

  it('LangChain on OpenAI keeps the temperature each node asked for', () => {
    process.env.AI_PROVIDER = 'openai';
    langchainChatModel(0);
    expect(chatOpenAICtor.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        model: 'gpt-4.1-mini',
        temperature: 0,
        apiKey: 'sk-test',
      })
    );
  });

  it('the agent uses the Chat Completions API on Vertex (no Responses API there)', () => {
    const model: any = agentLanguageModel();
    expect(model.modelId).toBe('google/gemini-3.8-flash');
    expect(model.provider).toBe('vertex.chat');
    process.env.AI_PROVIDER = 'openai';
    expect((agentLanguageModel() as any).modelId).toBe('gpt-4.1-mini');
  });

  it('CopilotKit streams through our client, keeping the system role', async () => {
    stream.mockReturnValue('the-stream');
    const adapter: any = copilotServiceAdapter();
    expect(adapter.model).toBe('google/gemini-3.8-flash');
    expect(adapter.keepSystemRole).toBe(true);
    expect(
      adapter.openai.beta.chat.completions.stream({
        a: 1,
        model: 'google/gemini-4-argon',
      })
    ).toBe('the-stream');
    // the browser cannot pick another (paid) model
    expect(stream).toHaveBeenCalledWith({
      a: 1,
      messages: [
        { role: 'system', content: expect.stringContaining('[link]') },
      ],
      model: 'google/gemini-3.8-flash',
    });
  });

  it('CopilotKit: the no-invented-links rule joins the browser system prompt', () => {
    const adapter: any = copilotServiceAdapter();
    const messages = [
      { role: 'system', content: 'You help schedule posts.' },
      { role: 'user', content: 'Write a launch post' },
    ];
    adapter.openai.beta.chat.completions.stream({ messages });
    const sent = stream.mock.calls[stream.mock.calls.length - 1][0].messages;
    expect(sent).toHaveLength(2);
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toMatch(/^You help schedule posts\.\n\n/);
    expect(sent[0].content).toContain(NO_INVENTED_FACTS_RULE);
    expect(sent[1]).toBe(messages[1]);
    // the caller's array is not changed
    expect(messages[0].content).toBe('You help schedule posts.');
    // OpenAI path: CopilotKit sends the system prompt as `developer`
    expect(
      withNoInventedFactsRule([{ role: 'developer', content: 'x' }])[0].content
    ).toContain(NO_INVENTED_FACTS_RULE);
    // no system prompt at all: one is added in front
    expect(withNoInventedFactsRule([{ role: 'user', content: 'hi' }])).toEqual([
      {
        role: 'system',
        content: expect.stringContaining(NO_INVENTED_FACTS_RULE),
      },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('CopilotKit on OpenAI uses the OpenAI model, also pinned', () => {
    process.env.AI_PROVIDER = 'openai';
    const adapter: any = copilotServiceAdapter();
    expect(adapter.model).toBe('gpt-4.1-mini');
    expect(adapter.keepSystemRole).toBe(false);
    adapter.openai.beta.chat.completions.stream({ model: 'gpt-5' });
    expect(stream).toHaveBeenCalledWith({
      model: 'gpt-4.1-mini',
      messages: [expect.objectContaining({ role: 'system' })],
    });
    expect(openaiCtor).toHaveBeenLastCalledWith({ apiKey: 'sk-test' });
  });
});

describe('generationError', () => {
  it('reports a provider quota as retryable (429)', () => {
    expect(
      generationError({
        status: 429,
        message: '429 Too Many Requests',
      }).getStatus()
    ).toBe(429);
    expect(generationError(new Error('RESOURCE_EXHAUSTED')).getStatus()).toBe(
      429
    );
  });

  it('reports a timeout as 504', () => {
    const e = new Error('Request timed out.');
    e.name = 'APIConnectionTimeoutError';
    expect(generationError(e).getStatus()).toBe(504);
    expect(generationError(new Error('Request timed out.')).getStatus()).toBe(
      504
    );
    // a database or other timeout is not the AI's
    expect(
      generationError(new Error('Connection to db timed out')).getStatus()
    ).toBe(500);
  });

  it("OpenAI's insufficient_quota (our own bill) is not reported as 'busy'", () => {
    expect(
      generationError({
        status: 429,
        code: 'insufficient_quota',
        message: '429 You exceeded your current quota',
      }).getStatus()
    ).toBe(500);
  });

  it('still reports an OpenAI safety rejection as before', () => {
    const http = generationError(
      new Error(
        '400 Your request was rejected by the safety system, safety_violations=[sexual]'
      )
    );
    expect(http.getStatus()).toBe(422);
    expect(http.message).toContain('Flagged categories: sexual');
  });
});

describe('base64ImageDataUrl', () => {
  it('labels Gemini JPEG and OpenAI PNG correctly', () => {
    expect(base64ImageDataUrl('/9j/4AAQ')).toBe(
      'data:image/jpeg;base64,/9j/4AAQ'
    );
    expect(base64ImageDataUrl('iVBORw0K')).toBe(
      'data:image/png;base64,iVBORw0K'
    );
    expect(base64ImageDataUrl('UklGRiQ')).toBe(
      'data:image/webp;base64,UklGRiQ'
    );
    expect(base64ImageDataUrl(undefined)).toBe('data:image/png;base64,');
  });
});
