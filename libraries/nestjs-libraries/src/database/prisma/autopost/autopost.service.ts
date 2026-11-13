import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AutopostRepository } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { AutopostDto } from '@hookpost/nestjs-libraries/dtos/autopost/autopost.dto';
import dayjs from 'dayjs';
import { END, START, StateGraph } from '@langchain/langgraph';
import { AutoPost, Integration } from '@prisma/client';
import { BaseMessage } from '@langchain/core/messages';
import striptags from 'striptags';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { langchainChatModel } from '@hookpost/nestjs-libraries/openai/ai.provider';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import Parser from 'rss-parser';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
} from '@hookpost/nestjs-libraries/temporal/temporal.search.attribute';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { generateAndUploadImage } from '@hookpost/nestjs-libraries/openai/generated.image';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  findLinks,
  NO_INVENTED_FACTS_RULE,
  normalizeLink,
  stripInventedLinks,
} from '@hookpost/nestjs-libraries/openai/invented.links';
const parser = new Parser();

interface WorkflowChannelsState {
  messages: BaseMessage[];
  integrations: Integration[];
  body: AutoPost;
  description: string;
  image: string;
  id: string;
  load: {
    date: string;
    url: string;
    description: string;
  };
}

// Built per call so a provider switch (ai.provider.ts) needs no code change.
const model = () => langchainChatModel(0.7);

const generateContent = z.object({
  socialMediaPostContent: z
    .string()
    .describe('Content for social media posts max 120 chars'),
});

const dallePrompt = z.object({
  generatedTextToBeSentToDallE: z
    .string()
    .describe('Generated prompt from description to be sent to DallE'),
});

@Injectable()
export class AutopostService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _autopostsRepository: AutopostRepository,
    private _temporalService: TemporalService,
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _openaiService: OpenaiService,
    private _subscriptionService: SubscriptionService
  ) {}

  async stopAll(org: string) {
    const getAll = (await this.getAutoposts(org)).filter((f) => f.active);
    for (const autopost of getAll) {
      await this.changeActive(org, autopost.id, false);
    }
  }

  getAutoposts(orgId: string) {
    return this._autopostsRepository.getAutoposts(orgId);
  }

  async createAutopost(orgId: string, body: AutopostDto, id?: string) {
    const data = await this._autopostsRepository.createAutopost(
      orgId,
      body,
      id
    );

    await this.processCron(body.active, orgId, data.id);

    return data;
  }

  /**
   * PUT /autopost/:id: changes an existing autopost only. createAutopost
   * upserts, so an unknown id would otherwise add one without the plan check
   * POST /autopost makes.
   */
  async updateAutopost(orgId: string, id: string, body: AutopostDto) {
    if (!(await this._autopostsRepository.findAutopost(orgId, id))) {
      throw new NotFoundException('Autopost not found');
    }
    return this.createAutopost(orgId, body, id);
  }

  async changeActive(orgId: string, id: string, active: boolean) {
    const data = await this._autopostsRepository.changeActive(
      orgId,
      id,
      active
    );
    await this.processCron(active, orgId, id);
    return data;
  }

  async processCron(active: boolean, orgId: string, id: string) {
    if (active) {
      try {
        return this._temporalService.client
          .getRawClient()
          ?.workflow.start('autoPostWorkflow', {
            workflowId: `autopost-${id}`,
            taskQueue: 'main',
            args: [{ id, immediately: true }],
            typedSearchAttributes: new TypedSearchAttributes([
              {
                key: organizationId,
                value: orgId,
              },
            ]),
          });
      } catch (err) {}
    }

    try {
      return await this._temporalService.terminateWorkflow(`autopost-${id}`);
    } catch (err) {
      return false;
    }
  }

  async deleteAutopost(orgId: string, id: string) {
    const data = await this._autopostsRepository.deleteAutopost(orgId, id);
    await this.processCron(false, orgId, id);
    return data;
  }

  async loadXML(url: string) {
    try {
      const { items } = await parser.parseURL(url);
      const findLast = items.reduce(
        (all: any, current: any) => {
          if (dayjs(current.pubDate).isAfter(all.pubDate)) {
            return current;
          }
          return all;
        },
        { pubDate: dayjs().subtract(100, 'years') }
      );

      return {
        success: true,
        date: findLast.pubDate,
        url: findLast.link,
        description: striptags(
          findLast?.['content:encoded'] ||
            findLast?.content ||
            findLast?.description ||
            ''
        )
          .replace(/\n/g, ' ')
          .trim(),
      };
    } catch (err) {
      /** sent **/
    }

    return { success: false };
  }

  static state = () =>
    new StateGraph<WorkflowChannelsState>({
      channels: {
        messages: {
          reducer: (currentState, updateValue) =>
            currentState.concat(updateValue),
          default: () => [],
        },
        body: null,
        description: null,
        load: null,
        image: null,
        integrations: null,
        id: null,
      },
    });

  async loadUrl(url: string) {
    try {
      const loadDom = new JSDOM(await (await fetch(url)).text());
      loadDom.window.document
        .querySelectorAll('script')
        .forEach((s) => s.remove());
      loadDom.window.document
        .querySelectorAll('style')
        .forEach((s) => s.remove());
      // remove all html, script and styles
      return striptags(loadDom.window.document.body.innerHTML);
    } catch (err) {
      return '';
    }
  }

  async generateDescription(state: WorkflowChannelsState) {
    if (!state.body.generateContent) {
      return {
        ...state,
        description: state.body.content,
      };
    }

    const description =
      state.load.description || (await this.loadUrl(state.load.url));
    if (!description) {
      return {
        ...state,
        description: '',
      };
    }

    const structuredOutput = model().withStructuredOutput(generateContent);
    const { socialMediaPostContent } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets raw 'description' of a content and generate a social media post content.
        Rules:
        - Maximum 100 chars
        - Try to make it a short as possible to fit any social media
        - Add line breaks between sentences (\\n) 
        - Don't add hashtags
        - Add emojis when needed
        - ${NO_INVENTED_FACTS_RULE}
        
        'description':
        {content}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        content: description,
      });

    // Auto-post runs with nobody reading the post, so an invented link is
    // never left as a placeholder: it becomes the feed item's own URL (once),
    // or is taken out. schedulePost adds the item URL under the post unless
    // the text has it already.
    const { text, removed, replaced } = stripInventedLinks(
      socialMediaPostContent,
      [description, state.load.url],
      { preferred: [state.load.url] }
    );
    if (removed.length) {
      Logger.warn(
        `Autopost: ${removed.length} link(s) not in the feed item (${removed.join(', ')}); ` +
          `${replaced.length} replaced with the item URL, ${removed.length - replaced.length} removed`,
        'AutopostService'
      );
    }

    return {
      ...state,
      description: text,
    };
  }

  // The picture is generated with OpenaiService and stored with the upload
  // provider (generated.image.ts): LangChain's DallEAPIWrapper sends
  // response_format, which the gpt-image models reject, and its URL would
  // have expired an hour later anyway. A picture that cannot be made leaves
  // the draft without one rather than failing the run: the feed item would
  // otherwise never be marked as done and fail the same way on every run.
  //
  // The picture takes one of the workspace's monthly ai_images credits, as in
  // the post generator and the media library. Out of credits, the draft goes
  // out without a picture and the image model is never called (the prompt-writing text call still runs).
  async generatePicture(state: WorkflowChannelsState) {
    try {
      const structuredOutput = model().withStructuredOutput(dallePrompt);
      const { generatedTextToBeSentToDallE } =
        await ChatPromptTemplate.fromTemplate(
          `
        You are an assistant that gets description and generate a prompt that will be sent to DallE to generate pictures.
        
        content:
        {content}
      `
        )
          .pipe(structuredOutput)
          .invoke({
            content: state.load.description || state.description,
          });

      const image = await generateAndUploadImage(
        generatedTextToBeSentToDallE,
        (prompt) =>
          this._subscriptionService.useCreditForOrganizationId(
            state.body.organizationId,
            'ai_images',
            () => this._openaiService.generateImage(prompt)
          ),
        this.storage
      );

      return { ...state, image };
    } catch (err) {
      console.error(
        'Autopost picture failed, the draft goes out without one:',
        (err as any)?.error?.message || (err as any)?.message || err
      );
      return { ...state, image: '' };
    }
  }

  /** The post: its text, then the feed item's URL unless the text links to it already. */
  static postText(description: string, url?: string) {
    const text = (description || '').replace(/\n/g, '\n\n');
    const target = url ? normalizeLink(url) : '';
    if (!target || findLinks(text).some((l) => normalizeLink(l) === target)) {
      return text;
    }
    return text ? `${text}\n\n${url}` : url!;
  }

  async schedulePost(state: WorkflowChannelsState) {
    const nextTime = await this._postsService.findFreeDateTime(
      state.integrations[0].organizationId
    );

    await this._postsService.createPost(state.integrations[0].organizationId, {
      date: nextTime + 'Z',
      order: makeId(10),
      shortLink: false,
      type: 'draft',
      tags: [],
      posts: state.integrations.map((i) => ({
        settings: {
          __type: i.providerIdentifier as any,
          title: '',
          tags: [],
          subreddit: [],
        },
        group: makeId(10),
        integration: { id: i.id },
        value: [
          {
            id: makeId(10),
            delay: 0,
            content: AutopostService.postText(state.description, state.load.url),
            image: !state.image
              ? []
              : [
                  {
                    id: makeId(10),
                    name: makeId(10),
                    path: state.image,
                    organizationId: state.integrations[0].organizationId,
                  },
                ],
          },
        ],
      })),
    }, 'AUTOPOST');
  }

  async updateUrl(state: WorkflowChannelsState) {
    await this._autopostsRepository.updateUrl(state.id, state.load.url);
  }

  async startAutopost(id: string) {
    const getPost = await this._autopostsRepository.getAutopost(id);
    if (!getPost || !getPost.active) {
      return;
    }

    const load = await this.loadXML(getPost.url);
    if (!load.success || load.url === getPost.lastUrl) {
      return;
    }

    const integrations = await this._integrationService.getIntegrationsList(
      getPost.organizationId
    );

    const parseIntegrations = JSON.parse(getPost.integrations || '[]') || [];
    const neededIntegrations = integrations.filter((i) =>
      parseIntegrations.some((ii: any) => ii.id === i.id)
    );

    const integrationsToSend =
      parseIntegrations.length === 0 ? integrations : neededIntegrations;
    if (integrationsToSend.length === 0) {
      return;
    }

    const state = AutopostService.state();
    const workflow = state
      .addNode('generate-description', this.generateDescription.bind(this))
      .addNode('generate-picture', this.generatePicture.bind(this))
      .addNode('schedule-post', this.schedulePost.bind(this))
      .addNode('update-url', this.updateUrl.bind(this))
      .addEdge(START, 'generate-description')
      .addConditionalEdges(
        'generate-description',
        (state: WorkflowChannelsState) => {
          if (!state.description) {
            return 'schedule-post';
          }
          if (state.body.addPicture) {
            return 'generate-picture';
          }
          return 'schedule-post';
        }
      )
      .addEdge('generate-picture', 'schedule-post')
      .addEdge('schedule-post', 'update-url')
      .addEdge('update-url', END);

    const app = workflow.compile();
    await app.invoke({
      messages: [],
      id,
      body: getPost,
      load,
      integrations: integrationsToSend,
    });
  }
}
