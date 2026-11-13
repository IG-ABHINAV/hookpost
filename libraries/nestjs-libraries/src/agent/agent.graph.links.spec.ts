import 'reflect-metadata';

// Generated posts must not carry links nobody gave the model (26 Oct 2026: a
// live run wrote "hookpost.com"), and must not carry a placeholder either:
// posts often go out unread, and auto-post has no human at all. The
// generator's hook and content, and the auto-post text, go through
// stripInventedLinks: an invented link becomes a real one (the request's, the
// workspace's, the feed item's) or is removed cleanly. The model is mocked
// here; ai.provider.live.spec.ts runs it on Vertex.
//   pnpm exec jest -c apps/backend/jest.config.ts agent.graph.links

const mockPrompts: string[] = [];
let mockReply: unknown;
jest.mock('@hookpost/nestjs-libraries/openai/ai.provider', () => {
  const { RunnableLambda } = jest.requireActual('@langchain/core/runnables');
  return {
    ...jest.requireActual('@hookpost/nestjs-libraries/openai/ai.provider'),
    langchainChatModel: () => ({
      withStructuredOutput: () =>
        RunnableLambda.from(async (prompt: { toString(): string }) => {
          mockPrompts.push(prompt.toString());
          return mockReply;
        }),
    }),
  };
});
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

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository',
  () => ({ AutopostRepository: class {} })
);

// AgentGraphService reads the workspace's links through OrganizationService,
// whose import chain builds a Resend client that throws without RESEND_API_KEY.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { AgentGraphService } from '@hookpost/nestjs-libraries/agent/agent.graph.service';
import { NO_INVENTED_FACTS_RULE } from '@hookpost/nestjs-libraries/openai/invented.links';
import { AutopostService } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.service';

const PLACEHOLDER = /\[(?:link|email)\]/i;

const organizations = (sources: string[] | Error = []) => ({
  getLinkSources: jest.fn(async () => {
    if (sources instanceof Error) throw sources;
    return sources;
  }),
});

const service = (org = organizations()) =>
  new AgentGraphService({} as any, {} as any, {} as any, {} as any, org as any);

const research = [
  new ToolMessage({
    tool_call_id: 't1',
    content:
      '{"results":[{"url":"https://news.example.com/ai-schedulers","content":"AI schedulers grow"}]}',
  }),
];

const state = (request: string, over: Record<string, unknown> = {}) =>
  ({
    messages: [new HumanMessage(request)],
    orgId: 'org-1',
    question: '',
    format: 'one_short',
    tone: 'company',
    popularPosts: [],
    fresearch: research,
    hook: 'Posting every day is hard.',
    ...over,
  } as any);

beforeEach(() => {
  mockPrompts.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('post generator: links the model was not given', () => {
  const request =
    'Write a post announcing Hookpost, our AI social media scheduler. Tell people where to sign up.';

  it('with no real link, removes an invented domain cleanly (no [link])', async () => {
    mockReply = {
      content: { content: 'Schedule a month in an hour.\nSign up at hookpost.com today!' },
    };
    const out = await service().generateContent(state(request));
    expect(out.content).toEqual({
      content: 'Schedule a month in an hour.\nSign up today!',
    });
    expect(mockPrompts[0]).toContain(NO_INVENTED_FACTS_RULE);
  });

  it('uses the workspace website in place of an invented one', async () => {
    mockReply = {
      content: { content: 'Schedule a month in an hour.\nSign up at hookpost.com today!' },
    };
    const out = await service().generateContent(
      state(request, { workspaceLinks: ['https://hookpost.hookstep.in', 'support@hookstep.in'] })
    );
    expect(out.content).toEqual({
      content: 'Schedule a month in an hour.\nSign up at https://hookpost.hookstep.in today!',
    });
  });

  it('gives the model the workspace links in the content prompt', async () => {
    mockReply = { content: { content: 'Hello' } };
    await service().generateContent(
      state(request, { workspaceLinks: ['https://hookpost.hookstep.in'] })
    );
    expect(mockPrompts[0]).toMatch(
      /Links from the workspace settings[^\n]*\n\s*https:\/\/hookpost\.hookstep\.in/
    );
    mockPrompts.length = 0;
    await service().generateContent(state(request));
    expect(mockPrompts[0]).toMatch(/Links from the workspace settings[^\n]*\n\s*none/);
  });

  it('keeps links from the request and from the research, in a thread too', async () => {
    mockReply = {
      content: [
        { content: 'Start at https://hookpost.hookstep.in' },
        { content: 'Context: https://news.example.com/ai-schedulers' },
        { content: 'Docs: docs.hookpost.io' },
        { content: 'Thanks for reading 🙏\n[link]' },
      ],
    };
    const out = await service().generateContent(
      state('Announce Hookpost, link https://hookpost.hookstep.in', {
        format: 'thread_short',
      })
    );
    // each part is checked on its own: the invented docs link and the
    // placeholder become the link from the request
    expect(out.content).toEqual([
      { content: 'Start at https://hookpost.hookstep.in' },
      { content: 'Context: https://news.example.com/ai-schedulers' },
      { content: 'Docs: https://hookpost.hookstep.in' },
      { content: 'Thanks for reading 🙏\nhttps://hookpost.hookstep.in' },
    ]);
  });

  it('with no real link, a thread part that was only an invented link is left out', async () => {
    mockReply = {
      content: [
        { content: 'AI scheduling saves hours every week.' },
        { content: 'Docs: docs.hookpost.io' },
        { content: 'Thanks for reading 🙏\n[link]' },
      ],
    };
    const out = await service().generateContent(state(request, { format: 'thread_short' }));
    expect(out.content).toEqual([
      { content: 'AI scheduling saves hours every week.' },
      { content: 'Thanks for reading 🙏' },
    ]);
  });

  it('checks the hook as well, keeping Hindi and emoji', async () => {
    mockReply = { hook: 'अब हाथ से पोस्ट करना बंद 🚀\nhookpost.ai fixes that.' };
    const out = await service().generateHook(state(request));
    expect(out.hook).toBe('अब हाथ से पोस्ट करना बंद 🚀');
    expect(out.hook).not.toMatch(PLACEHOLDER);
    expect(mockPrompts[0]).toContain(NO_INVENTED_FACTS_RULE);
  });

  it('no longer asks the model for a brand website', async () => {
    mockReply = { content: { content: 'Hello' } };
    await service().generateContent(state(request));
    expect(mockPrompts[0]).not.toMatch(/root domain of the brand/);
  });

  it('loads the workspace links with the research', async () => {
    const org = organizations([
      '<p>Follow <a href="https://acme.in">acme.in</a> · team@acme.in</p>',
      'https://acme.in',
    ]);
    const out = await service(org).saveResearch(
      state(request, { messages: [new HumanMessage(request), ...research] })
    );
    expect(org.getLinkSources).toHaveBeenCalledWith('org-1');
    expect(out.workspaceLinks).toEqual(['https://acme.in', 'team@acme.in']);
    expect(out.fresearch).toHaveLength(1);
  });

  it('a failed workspace lookup does not fail the generation', async () => {
    const warn = jest.spyOn(require('@nestjs/common').Logger, 'warn').mockImplementation(() => undefined);
    const out = await service(organizations(new Error('db down'))).saveResearch(state(request));
    expect(out.workspaceLinks).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('auto-post: links the feed item did not have', () => {
  const autopost = () =>
    new AutopostService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

  const item = {
    url: 'https://blog.example.org/post-1',
    description: 'Acme ships AI scheduling. Pricing at https://acme.example/pricing',
    date: '',
  };

  it('keeps the feed URL and links in the item, removes made-up ones', async () => {
    mockReply = {
      socialMediaPostContent:
        'New: AI scheduling 🚀\nRead https://blog.example.org/post-1 or try acme.io',
    };
    const out = await autopost().generateDescription({
      body: { generateContent: true },
      load: item,
    } as any);
    expect(out.description).toBe(
      'New: AI scheduling 🚀\nRead https://blog.example.org/post-1'
    );
    expect(mockPrompts[0]).toContain(NO_INVENTED_FACTS_RULE);
  });

  it('puts the feed item URL in place of an invented link', async () => {
    mockReply = {
      socialMediaPostContent: 'Acme ships AI scheduling 🚀\nFull story: acme-blog.com/ai',
    };
    const out = await autopost().generateDescription({
      body: { generateContent: true },
      load: item,
    } as any);
    expect(out.description).toBe(
      'Acme ships AI scheduling 🚀\nFull story: https://blog.example.org/post-1'
    );
    // and the URL is not added a second time under the post
    expect(AutopostService.postText(out.description, item.url)).toBe(
      'Acme ships AI scheduling 🚀\n\nFull story: https://blog.example.org/post-1'
    );
  });

  it('a placeholder becomes the feed item URL too', async () => {
    mockReply = { socialMediaPostContent: 'Acme ships AI scheduling 🚀 [link]' };
    const out = await autopost().generateDescription({
      body: { generateContent: true },
      load: item,
    } as any);
    expect(out.description).toBe('Acme ships AI scheduling 🚀 https://blog.example.org/post-1');
  });
});

describe('auto-post: the text that is posted', () => {
  it('adds the item URL under the post when the text does not link to it', () => {
    expect(AutopostService.postText('Big news\nRead it', 'https://x.test/a')).toBe(
      'Big news\n\nRead it\n\nhttps://x.test/a'
    );
  });

  it('does not repeat the URL the text already has (any spelling)', () => {
    expect(AutopostService.postText('Read www.x.test/a/', 'https://x.test/a')).toBe(
      'Read www.x.test/a/'
    );
  });

  it('never writes "undefined" when the feed item has no link', () => {
    expect(AutopostService.postText('Big news', undefined)).toBe('Big news');
    expect(AutopostService.postText('', 'https://x.test/a')).toBe('https://x.test/a');
  });
});
