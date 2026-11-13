import { Injectable, Logger } from '@nestjs/common';
import {
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { TavilySearch } from '@langchain/tavily';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import dayjs from 'dayjs';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { z } from 'zod';
import { langchainChatModel } from '@hookpost/nestjs-libraries/openai/ai.provider';
import { MediaService } from '@hookpost/nestjs-libraries/database/prisma/media/media.service';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { GeneratorDto } from '@hookpost/nestjs-libraries/dtos/generator/generator.dto';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  generateAndUploadImage,
  pictureFailureMessage,
} from '@hookpost/nestjs-libraries/openai/generated.image';
import {
  linksIn,
  NO_INVENTED_FACTS_RULE,
  sourceText,
  stripInventedLinks,
} from '@hookpost/nestjs-libraries/openai/invented.links';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';

const tools = !process.env.TAVILY_API_KEY
  ? []
  : [new TavilySearch({ maxResults: 3 })];
const toolNode = new ToolNode(tools);

// Built per call so a provider switch (ai.provider.ts) needs no code change.
const model = () => langchainChatModel(0.7);

interface WorkflowChannelsState {
  messages: BaseMessage[];
  orgId: string;
  question: string;
  hook?: string;
  fresearch?: string;
  /** The workspace's own links and emails (signatures, agency website). */
  workspaceLinks?: string[];
  category?: string;
  topic?: string;
  date?: string;
  format: 'one_short' | 'one_long' | 'thread_short' | 'thread_long';
  tone: 'personal' | 'company';
  content?: {
    content: string;
    prompt?: string;
    image?: string;
  }[];
  isPicture?: boolean;
  /**
   * Set when pictures were asked for and some or all could not be made. The
   * posts are still returned; the page shows this next to them.
   */
  pictureError?: string;
  popularPosts?: { content: string; hook: string }[];
}

const category = z.object({
  category: z.string().describe('The category for the post'),
});

const topic = z.object({
  topic: z.string().describe('The topic for the post'),
});

const hook = z.object({
  hook: z
    .string()
    .describe(
      'Hook for the new post, don\'t take it from "the request of the user"'
    ),
});

const contentZod = (
  isPicture: boolean,
  format: 'one_short' | 'one_long' | 'thread_short' | 'thread_long'
) => {
  const content = z.object({
    // There was a `website` field here asking for "the root domain of the
    // brand"; nothing read it, and it invited the model to make up domains.
    content: z.string().describe('Content for the new post'),
    ...(isPicture
      ? {
          prompt: z
            .string()
            .describe(
              "Prompt to generate a picture for this post later, make sure it doesn't contain brand names and make it very descriptive in terms of style"
            ),
        }
      : {}),
  });

  return z.object({
    content:
      format === 'one_short' || format === 'one_long'
        ? content
        : z.array(content).min(2).describe(`Content for the new post`),
  });
};

@Injectable()
export class AgentGraphService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _openaiService: OpenaiService,
    private _subscriptionService: SubscriptionService,
    private _organizationService: OrganizationService
  ) {}
  static state = () =>
    new StateGraph<WorkflowChannelsState>({
      channels: {
        messages: {
          reducer: (currentState, updateValue) =>
            currentState.concat(updateValue),
          default: () => [],
        },
        fresearch: null,
        workspaceLinks: null,
        format: null,
        tone: null,
        question: null,
        orgId: null,
        hook: null,
        content: null,
        date: null,
        category: null,
        popularPosts: null,
        topic: null,
        isPicture: null,
        pictureError: null,
      },
    });

  async startCall(state: WorkflowChannelsState) {
    const runTools = model().bindTools(tools);
    const response = await ChatPromptTemplate.fromTemplate(
      `
    Today is ${dayjs().format()}, You are an assistant that gets a social media post or requests for a social media post.
    You research should be on the most possible recent data.
    You concat the text of the request together with an internet research based on the text.
    {text}
    `
    )
      .pipe(runTools)
      .invoke({
        text: state.messages[state.messages.length - 1].content,
      });

    return { messages: [response] };
  }

  async saveResearch(state: WorkflowChannelsState) {
    const content = state.messages.filter((f) => f instanceof ToolMessage);
    return {
      fresearch: content,
      workspaceLinks: await this.workspaceLinks(state.orgId),
    };
  }

  // The workspace has no website field; its signatures and its members'
  // agency profiles are where its own links live. A failed lookup only means
  // the post gets no workspace link.
  private async workspaceLinks(orgId: string): Promise<string[]> {
    try {
      return linksIn(await this._organizationService.getLinkSources(orgId));
    } catch (err) {
      Logger.warn(
        `Generator: workspace links not loaded: ${(err as Error)?.message || err}`,
        'AgentGraphService'
      );
      return [];
    }
  }

  async findCategories(state: WorkflowChannelsState) {
    const allCategories = await this._postsService.findAllExistingCategories();
    const structuredOutput = model().withStructuredOutput(category);
    const { category: outputCategory } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets a text that will be later summarized into a social media post
        and classify it to one of the following categories: {categories}
        text: {text}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        categories: allCategories.map((p) => p.category).join(', '),
        text: state.fresearch,
      });

    return {
      category: outputCategory,
    };
  }

  async findTopic(state: WorkflowChannelsState) {
    const allTopics = await this._postsService.findAllExistingTopicsOfCategory(
      state?.category!
    );
    if (allTopics.length === 0) {
      return { topic: null };
    }

    const structuredOutput = model().withStructuredOutput(topic);
    const { topic: outputTopic } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets a text that will be later summarized into a social media post
        and classify it to one of the following topics: {topics}
        text: {text}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        topics: allTopics.map((p) => p.topic).join(', '),
        text: state.fresearch,
      });

    return {
      topic: outputTopic,
    };
  }

  async findPopularPosts(state: WorkflowChannelsState) {
    const popularPosts = await this._postsService.findPopularPosts(
      state.category!,
      state.topic
    );
    return { popularPosts };
  }

  async generateHook(state: WorkflowChannelsState) {
    const structuredOutput = model().withStructuredOutput(hook);
    const { hook: outputHook } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets content for a social media post, and generate only the hook.
        The hook is the 1-2 sentences of the post that will be used to grab the attention of the reader.
        You will be provided existing hooks you should use as inspiration.
        - Avoid weird hook that starts with "Discover the secret...", "The best...", "The most...", "The top..."
        - Make sure it sounds ${state.tone}
        - Use ${state.tone === 'personal' ? '1st' : '3rd'} person mode
        - Make sure it's engaging
        - Don't be cringy
        - Use simple english
        - Make sure you add "\n" between the lines
        - Don't take the hook from "request of the user"
        - ${NO_INVENTED_FACTS_RULE}

        <!-- BEGIN request of the user -->
        {request}
        <!-- END request of the user -->
        
        <!-- BEGIN existing hooks -->
        {hooks}
        <!-- END existing hooks -->
        
        <!-- BEGIN current content -->
        {text}
        <!-- END current content -->
       
      `
    )
      .pipe(structuredOutput)
      .invoke({
        request: state.messages[0].content,
        hooks: state.popularPosts!.map((p) => p.hook).join('\n'),
        text: state.fresearch,
      });

    return {
      hook: this.withoutInventedLinks(state, outputHook, 'hook'),
    };
  }

  async generateContent(state: WorkflowChannelsState) {
    const structuredOutput = model().withStructuredOutput(
      contentZod(!!state.isPicture, state.format)
    );
    const { content: outputContent } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets existing hook of a social media, content and generate only the content.
        - Don't add any hashtags
        - Make sure it sounds ${state.tone}
        - Use ${state.tone === 'personal' ? '1st' : '3rd'} person mode
        - ${
          state.format === 'one_short' || state.format === 'thread_short'
            ? 'Post should be maximum 200 chars to fit twitter'
            : 'Post should be long'
        }
        - ${
          state.format === 'one_short' || state.format === 'one_long'
            ? 'Post should have only 1 item'
            : 'Post should have minimum 2 items'
        }
        - Use the hook as inspiration
        - Make sure it's engaging
        - Don't be cringy
        - Use simple english
        - The Content should not contain the hook
        - Try to put some call to action at the end of the post
        - Make sure you add "\n" between the lines
        - Add "\n" after every "."
        - ${NO_INVENTED_FACTS_RULE}
        
        Hook:
        {hook}
        
        User request:
        {request}
        
        Links from the workspace settings (use one only where the post needs a link):
        {links}
        
        current content information:
        {information}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        hook: state.hook,
        request: state.messages[0].content,
        links: (state.workspaceLinks || []).join('\n') || 'none',
        information: state.fresearch,
      });

    const items = Array.isArray(outputContent) ? outputContent : [outputContent];
    const all = items.map((item) => ({
      ...item,
      content: this.withoutInventedLinks(state, item.content || '', 'content'),
    }));
    // A thread part that was nothing but an invented link is left out rather
    // than posted empty.
    const withText = all.filter((item) => item.content.trim());
    const checked = withText.length ? withText : all;

    return {
      content: Array.isArray(outputContent) ? checked : checked[0],
    };
  }

  // The prompts tell the model not to invent links (NO_INVENTED_FACTS_RULE);
  // this catches the ones it writes anyway. A link counts as given when it is
  // in the user's request, the research results or the workspace's links. An
  // invented one becomes a link from the request or the workspace, or is
  // taken out: the post may go out unread, so never a placeholder.
  private withoutInventedLinks(
    state: WorkflowChannelsState,
    text: string,
    field: string
  ) {
    const request = sourceText(state.messages?.[0]?.content);
    const workspace = (state.workspaceLinks || []).join('\n');
    const { text: checked, removed, replaced } = stripInventedLinks(
      text,
      [request, sourceText(state.fresearch), workspace],
      { preferred: [request, workspace] }
    );
    if (removed.length) {
      Logger.warn(
        `Generator ${field}: ${removed.length} link(s) not in the input (${removed.join(', ')}); ` +
          `${replaced.length} replaced with a real link, ${removed.length - replaced.length} removed`,
        'AgentGraphService'
      );
    }
    return checked;
  }

  async fixArray(state: WorkflowChannelsState) {
    if (state.format === 'one_short' || state.format === 'one_long') {
      return {
        content: [state.content],
      };
    }

    return {};
  }

  // A picture that cannot be made (the image model refuses the prompt, a
  // quota, a storage error) does not fail the whole generation: the posts come
  // back without it and pictureError says what happened. It used to throw, and
  // the user lost every post they had waited a minute for.
  //
  // Each picture takes one of the workspace's monthly ai_images credits, like
  // the media library's "Generate image" (media.service.ts). The route only
  // checks the plan's AI flag, and a thread can have any number of posts, so
  // without the credit every run could make unlimited paid images. The credit
  // covers just the OpenAI call: it is released if that call fails, and kept
  // once the picture exists even if storing it fails. Out of credits, the
  // picture is not attempted and its post comes back without one.
  async generatePictures(state: WorkflowChannelsState) {
    if (!state.isPicture) {
      return {};
    }

    const items = state.content || [];
    const failures: unknown[] = [];
    const content = await Promise.all(
      items.map(async (p) => {
        if (!p.prompt) {
          return p;
        }
        try {
          const image = await generateAndUploadImage(
            p.prompt,
            (prompt) =>
              this._subscriptionService.useCreditForOrganizationId(
                state.orgId,
                'ai_images',
                () => this._openaiService.generateImage(prompt)
              ),
            this.storage
          );
          return { ...p, image };
        } catch (err) {
          failures.push(err);
          return p;
        }
      })
    );

    return failures.length
      ? { content, pictureError: pictureFailureMessage(failures, items.length) }
      : { content };
  }

  // The pictures are already stored (generatePictures); this adds them to the
  // workspace's media library, which is the shape the composer takes.
  async uploadPictures(state: WorkflowChannelsState) {
    const failures: unknown[] = [];
    const all = await Promise.all(
      (state.content || []).map(async (p) => {
        if (!p.image) {
          return p;
        }
        try {
          const media = await this._mediaService.saveFile(
            state.orgId,
            p.image.split('/').pop()!,
            p.image
          );
          return {
            ...p,
            image: media,
          };
        } catch (err) {
          failures.push(err);
          const { image: _unsaved, ...withoutImage } = p;
          return withoutImage;
        }
      })
    );

    return failures.length && !state.pictureError
      ? {
          content: all,
          pictureError: pictureFailureMessage(failures, all.length),
        }
      : { content: all };
  }

  async isGeneratePicture(state: WorkflowChannelsState) {
    if (state.isPicture) {
      return 'generate-picture';
    }

    return 'post-time';
  }

  async postDateTime(state: WorkflowChannelsState) {
    return { date: await this._postsService.findFreeDateTime(state.orgId) };
  }

  start(orgId: string, body: GeneratorDto) {
    const state = AgentGraphService.state();
    const workflow = state
      .addNode('agent', this.startCall.bind(this))
      .addNode('research', toolNode)
      .addNode('save-research', this.saveResearch.bind(this))
      .addNode('find-category', this.findCategories.bind(this))
      .addNode('find-topic', this.findTopic.bind(this))
      .addNode('find-popular-posts', this.findPopularPosts.bind(this))
      .addNode('generate-hook', this.generateHook.bind(this))
      .addNode('generate-content', this.generateContent.bind(this))
      .addNode('generate-content-fix', this.fixArray.bind(this))
      .addNode('generate-picture', this.generatePictures.bind(this))
      .addNode('upload-pictures', this.uploadPictures.bind(this))
      .addNode('post-time', this.postDateTime.bind(this))
      .addEdge(START, 'agent')
      .addEdge('agent', 'research')
      .addEdge('research', 'save-research')
      .addEdge('save-research', 'find-category')
      .addEdge('find-category', 'find-topic')
      .addEdge('find-topic', 'find-popular-posts')
      .addEdge('find-popular-posts', 'generate-hook')
      .addEdge('generate-hook', 'generate-content')
      .addEdge('generate-content', 'generate-content-fix')
      .addConditionalEdges(
        'generate-content-fix',
        this.isGeneratePicture.bind(this)
      )
      .addEdge('generate-picture', 'upload-pictures')
      .addEdge('upload-pictures', 'post-time')
      .addEdge('post-time', END);

    const app = workflow.compile();

    return app.streamEvents(
      {
        messages: [new HumanMessage(body.research)],
        isPicture: body.isPicture,
        format: body.format,
        tone: body.tone,
        orgId,
      },
      {
        streamMode: 'values',
        version: 'v2',
      }
    );
  }
}
