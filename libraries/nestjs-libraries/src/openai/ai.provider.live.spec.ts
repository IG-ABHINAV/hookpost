import 'reflect-metadata';

// Real calls to Gemini on Vertex AI, through the same code the app runs. A
// handful of small prompts (about US$0.10 a run). Skipped unless VERTEX_LIVE=1,
// so the unit suite and CI never reach Google:
//
//   VERTEX_LIVE=1 VERTEX_PROJECT=jr-consulting-co \
//   VERTEX_CREDENTIALS_FILE=/path/to/vertex-sa.json \
//   pnpm exec jest -c apps/backend/jest.config.ts ai.provider.live --runInBand
//
// The service account needs only roles/aiplatform.user. The Mastra agent
// (Jest cannot load @mastra/core) is covered by scripts/ai-agent-smoke.ts.

jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple: jest.fn() }) },
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

// AgentGraphService reads the workspace's links through OrganizationService,
// whose import chain builds a Resend client that throws without RESEND_API_KEY.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { z } from 'zod';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import { AgentGraphInsertService } from '@hookpost/nestjs-libraries/agent/agent.graph.insert.service';
import { generationError } from '@hookpost/nestjs-libraries/openai/generation.error';
import {
  aiClient,
  chatModelId,
  langchainChatModel,
} from '@hookpost/nestjs-libraries/openai/ai.provider';
import { HumanMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { AgentGraphService } from '@hookpost/nestjs-libraries/agent/agent.graph.service';
import {
  findLinks,
  normalizeLink,
} from '@hookpost/nestjs-libraries/openai/invented.links';

const live = process.env.VERTEX_LIVE === '1' ? describe : describe.skip;

jest.setTimeout(180_000);

live('Gemini on Vertex AI (live)', () => {
  const ai = new OpenaiService();

  beforeAll(() => {
    process.env.AI_PROVIDER = 'vertex';
  });

  it('structured output: a picture prompt', async () => {
    const prompt = await ai.generatePromptForPicture(
      'a cosy coffee shop at dawn, watercolor'
    );
    expect(prompt.length).toBeGreaterThan(80);
  });

  it('structured output with a length limit: a thread split', async () => {
    const { posts } = await ai.separatePosts(
      'We shipped dark mode today. It took three weeks because every chart had to be redrawn. Thanks to everyone who asked for it, you can turn it on in Settings > Appearance. Next up: keyboard shortcuts for the calendar.',
      120
    );
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const post of posts) {
      expect(typeof post).toBe('string');
      expect(post.length).toBeLessThanOrEqual(120);
    }
  });

  it('structured output: video slides', async () => {
    const slides = await ai.generateSlidesFromText(
      'Three tips for better LinkedIn posts: start with a hook, keep paragraphs short, end with a question.'
    );
    expect(slides.length).toBeGreaterThanOrEqual(3);
    expect(slides.length).toBeLessThanOrEqual(5);
    expect(slides[0]).toEqual(
      expect.objectContaining({
        imagePrompt: expect.any(String),
        voiceText: expect.any(String),
      })
    );
  });

  it('voice text', async () => {
    const voice = await ai.generateVoiceFromText(
      'Big news - our scheduler now supports Bluesky threads!'
    );
    expect(voice.length).toBeGreaterThan(10);
  });

  it('several candidates in one request (n), parsed as before', async () => {
    const posts = await ai.generatePosts(
      'Hookpost lets you schedule posts to 20+ social networks from one calendar.'
    );
    expect(posts).toHaveLength(10);
    expect(posts.filter((p: any[]) => p.length > 0).length).toBeGreaterThan(5);
  });

  it('an image, vertical, as base64 JPEG or PNG', async () => {
    const base64 = await ai.generateImage(
      'a red bicycle leaning on a white wall, photo',
      true
    );
    expect(base64?.length).toBeGreaterThan(10_000);
    expect(base64!.startsWith('/9j/') || base64!.startsWith('iVBOR')).toBe(
      true
    );
  });

  it('an image prompt the model refuses becomes a clean 422', async () => {
    const err = await ai
      .generateImage('graphic photo of a person being beheaded, gore')
      .then(() => undefined)
      .catch((e) => e);
    // The model may also draw something harmless; only a refusal is checked.
    if (err) {
      expect(generationError(err).getStatus()).toBe(422);
    }
  });

  it('LangChain structured output (the generator and auto-post nodes)', async () => {
    const out = await ChatPromptTemplate.fromTemplate(
      'Classify this post into one of: {categories}\npost: {post}'
    )
      .pipe(
        langchainChatModel(0).withStructuredOutput(
          z.object({ category: z.string().describe('The category') })
        )
      )
      .invoke({
        categories: 'Marketing, Engineering, Sales',
        post: 'We cut our build times in half by caching node_modules.',
      });
    expect(out.category).toBe('Engineering');
  });

  it('LangChain with no tools bound, as the generator runs without Tavily', async () => {
    const out = await ChatPromptTemplate.fromTemplate('{text}')
      .pipe(langchainChatModel(0.7).bindTools([]))
      .invoke({ text: 'Say hello in five words.' });
    expect(String(out.content).length).toBeGreaterThan(0);
  });

  it('the popular-posts classifier end to end (category, topic, hook)', async () => {
    const svc = new AgentGraphInsertService({
      createPopularPosts: jest.fn(),
    } as any);
    const post =
      'Most founders write their LinkedIn posts at midnight. Here is why scheduling them for 8am doubled our reach.';
    const state = { messages: [new HumanMessage(post)] } as any;
    const { category } = (await svc.findCategory(state)) as any;
    const { hook } = (await svc.findHook(state)) as any;
    expect(category.length).toBeGreaterThan(0);
    expect(post).toContain(hook.trim().slice(0, 20));
  });

  it('non-English input keeps its language', async () => {
    const { posts } = await ai.separatePosts(
      'हमारा सोशल मीडिया शेड्यूलर अब पूरी तरह हिंदी में उपलब्ध है। आप अपने सभी पोस्ट एक ही कैलेंडर से शेड्यूल कर सकते हैं। आज ही आज़माएँ और अपनी टीम के साथ साझा करें।',
      80
    );
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const post of posts) {
      expect(post).toMatch(/[\u0900-\u097F]/);
    }
  });

  it('a history whose tool calls lost their thought signature (CopilotKit)', async () => {
    const res = await aiClient().chat.completions.create({
      model: chatModelId('text'),
      messages: [
        { role: 'system', content: 'You help schedule posts.' },
        { role: 'user', content: 'Pick the X channel.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'pickChannel', arguments: '{"name":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'X selected' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'pickChannel',
            description: 'Select a channel',
            parameters: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        },
      ],
    });
    expect(res.choices[0].message.content?.length).toBeGreaterThan(0);
  });

  it('streaming with tools, as CopilotKit calls it', async () => {
    const stream = aiClient().chat.completions.stream({
      model: chatModelId('text'),
      stream: true,
      messages: [
        { role: 'system', content: 'Use the tool to set the post text.' },
        { role: 'user', content: 'Write a one-line post about Mondays.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'setText',
            description: 'Set the editor text',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
      ],
    });
    let sawTool = false;
    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.name) {
        sawTool = true;
      }
    }
    expect(sawTool).toBe(true);
  });

  it('a very long input (~60k characters) still splits', async () => {
    const paragraph =
      'Scheduling posts in advance frees your mornings and keeps your feed consistent. ';
    const { posts } = await ai.separatePosts(paragraph.repeat(750), 280);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('a timeout becomes a clean 504', async () => {
    const before = process.env.AI_TIMEOUT_MS;
    process.env.AI_TIMEOUT_MS = '50';
    try {
      const err = await ai
        .generateImage('a cat')
        .then(() => undefined)
        .catch((e) => e);
      expect(generationError(err).getStatus()).toBe(504);
    } finally {
      if (before === undefined) delete process.env.AI_TIMEOUT_MS;
      else process.env.AI_TIMEOUT_MS = before;
    }
  });
});

// The whole post generator (research -> category -> topic -> hook -> content)
// on Vertex, with a request that tempted it to make up "hookpost.com" on 26
// Oct 2026. DB calls are stubbed; the workspace's links come from a stubbed
// signature. Prints what the model wrote and what the guard changed; fails if
// the post carries a link that was not given, or any placeholder.
//   VERTEX_LIVE=1 ... pnpm exec jest -c apps/backend/jest.config.ts ai.provider.live -t "invent"
live('Post generator on Vertex: no invented links (live)', () => {
  beforeAll(() => {
    process.env.AI_PROVIDER = 'vertex';
  });

  const posts = {
    findAllExistingCategories: async () => [
      { category: 'Marketing' },
      { category: 'Technology' },
    ],
    findAllExistingTopicsOfCategory: async () => [],
    findPopularPosts: async () => [],
    findFreeDateTime: async () => '2026-10-27T10:00:00',
  };

  const run = async (research: string, format: string, signatures: string[]) => {
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const svc = new AgentGraphService(
      posts as any,
      {} as any,
      {} as any,
      {} as any,
      { getLinkSources: async () => signatures } as any
    );
    let last: any;
    for await (const event of svc.start('org-live', {
      research,
      format,
      tone: 'company',
      isPicture: false,
    } as any)) {
      const out = (event as any).data?.output;
      if ((event as any).event === 'on_chain_end' && out?.content && out?.hook) {
        last = out;
      }
    }
    const guardNotes = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return { last, guardNotes };
  };

  it.each([
    [
      'one_short',
      'Write a post announcing Hookpost, our new AI social media scheduler with a free trial. Tell people where to sign up and include the link.',
      ['<p>Hookpost · <a href="https://hookpost.hookstep.in">hookpost.hookstep.in</a> · support@hookstep.in</p>'],
    ],
    [
      'thread_short',
      'Write a launch thread for Hookpost, an AI tool that plans and schedules social posts. Mention the pricing page and where to download it.',
      [],
    ],
  ])('%s: %s', async (format, research, signatures) => {
    const { last, guardNotes } = await run(research, format, signatures as string[]);
    const items = (last.content as any[]).map((p) => p.content as string);
    const text = [last.hook, ...items].join('\n---\n');
    // eslint-disable-next-line no-console
    console.log(
      `[${format}, workspace links: ${signatures.length ? 'yes' : 'none'}] generated:\n${text}\n\nguard: ${
        guardNotes.length ? guardNotes.join(' | ') : 'nothing changed (the prompt rule held)'
      }`
    );
    const given = new Set(findLinks([research, ...signatures].join('\n')).map(normalizeLink));
    const invented = findLinks(text).filter((l) => !given.has(normalizeLink(l)));
    expect(invented).toEqual([]);
    expect(text).not.toMatch(/hookpost\.(com|io|ai|app|co)\b/i);
    expect(text).not.toMatch(/\[(?:[^\]\n]{0,25}\s)?(?:link|url|website|email)[^\]\n]{0,30}\]|<link>|\{\{?link\}?\}/i);
    for (const item of items) expect(item.trim()).not.toBe('');
  });
});
