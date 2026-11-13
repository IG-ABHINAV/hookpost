import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import {
  isXProvider,
  X_LINKS_NOT_INCLUDED,
  xPostHasLink,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';
import { PostsRepository } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.repository';
import { CreatePostDto } from '@hookpost/nestjs-libraries/dtos/posts/create.post.dto';
import dayjs from 'dayjs';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import {
  Integration,
  Post,
  Media,
  From,
  CreationMethod,
  State,
} from '@prisma/client';
import { GetPostsDto } from '@hookpost/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@hookpost/nestjs-libraries/dtos/posts/get.posts.list.dto';
import { pick, shuffle } from 'lodash';
import { CreateGeneratedPostsDto } from '@hookpost/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import utc from 'dayjs/plugin/utc';
import { MediaService } from '@hookpost/nestjs-libraries/database/prisma/media/media.service';
import { ShortLinkService } from '@hookpost/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@hookpost/nestjs-libraries/dtos/posts/create.tag.dto';
import {
  minifyPostsList,
  minifyPosts,
} from '@hookpost/helpers/utils/posts.list.minify';
import axios from 'axios';
import sharp from 'sharp';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { Readable } from 'stream';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
dayjs.extend(utc);
import * as Sentry from '@sentry/nestjs';
import { TemporalService } from 'nestjs-temporal-core';
import { terminatePostWorkflows } from '@hookpost/nestjs-libraries/temporal/post.workflows';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
  postId as postIdSearchParam,
} from '@hookpost/nestjs-libraries/temporal/temporal.search.attribute';
import { AnalyticsData } from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { timer } from '@hookpost/helpers/utils/timer';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { EmailNotVerifiedException } from '@hookpost/nestjs-libraries/services/email.verification';
import {
  isPostType,
  POST_TYPES,
} from '@hookpost/nestjs-libraries/dtos/posts/post.types';
import { RefreshToken } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { hasExtension } from '@hookpost/helpers/utils/has.extension';
import { stripLinks } from '@hookpost/helpers/utils/strip.links';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { stripHtmlValidation } from '@hookpost/helpers/utils/strip.html.validation';
import { countLength } from '@hookpost/helpers/utils/count.length';
import {
  findMissingMedia,
  MEDIA_REMOVED_MESSAGE,
  mediaPathsOf,
} from '@hookpost/nestjs-libraries/upload/missing.media';

// Thrown inside createPost's transaction to roll it back without an error.
class NothingSaved extends Error {}

type PostWithConditionals = Post & {
  integration?: Integration;
  childrenPost: Post[];
};

// The parts of a post's channel the composer needs. The full row also holds
// the channel's OAuth token and refresh token, which must never leave the
// server (the same fields /public/posts/:id preview returns).
const browserSafeIntegration = (integration?: Integration | null) =>
  integration
    ? pick(integration, [
        'id',
        'name',
        'picture',
        'providerIdentifier',
        'profile',
        'disabled',
      ])
    : integration;

@Injectable()
export class PostsService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _postRepository: PostsRepository,
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _mediaService: MediaService,
    private _shortLinkService: ShortLinkService,
    private _openaiService: OpenaiService,
    private _temporalService: TemporalService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _subscriptionService: SubscriptionService
  ) {}

  searchForMissingThreeHoursPosts() {
    return this._postRepository.searchForMissingThreeHoursPosts();
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._postRepository.updatePost(id, postId, releaseURL);
  }

  async getMissingContent(
    orgId: string,
    postId: string,
    forceRefresh = false
  ): Promise<{ id: string; url: string }[]> {
    const post = await this._postRepository.getPostById(postId, orgId);
    if (!post || post.releaseId !== 'missing') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      post.integration.providerIdentifier
    );

    if (!integrationProvider.missing) {
      return [];
    }

    const getIntegration = post.integration!;

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this._integrationService.disconnectChannel(orgId, getIntegration);
        return [];
      }
    }

    try {
      return await integrationProvider.missing(
        getIntegration.internalId,
        getIntegration.token
      );
    } catch (e) {
      console.log(e);
      if (e instanceof RefreshToken) {
        return this.getMissingContent(orgId, postId, true);
      }
    }

    return [];
  }

  async getPostById(postId: string, orgId: string) {
    return this._postRepository.getPostById(postId, orgId);
  }

  async updateReleaseId(orgId: string, postId: string, releaseId: string) {
    return this._postRepository.updateReleaseId(postId, orgId, releaseId);
  }

  async checkPostAnalytics(
    orgId: string,
    postId: string,
    date: number,
    forceRefresh = false
  ): Promise<AnalyticsData[] | { missing: true }> {
    const post = await this._postRepository.getPostById(postId, orgId);
    if (!post || !post.releaseId) {
      return [];
    }

    if (post.releaseId === 'missing') {
      return { missing: true };
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      post.integration.providerIdentifier
    );

    if (!integrationProvider.postAnalytics) {
      return [];
    }

    const getIntegration = post.integration!;

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this._integrationService.disconnectChannel(orgId, getIntegration);
        return [];
      }
    }

    // const getIntegrationData = await ioRedis.get(
    //   `integration:${orgId}:${post.id}:${date}`
    // );
    // if (getIntegrationData) {
    //   return JSON.parse(getIntegrationData);
    // }

    try {
      const loadAnalytics = await integrationProvider.postAnalytics(
        getIntegration.internalId,
        getIntegration.token,
        post.releaseId,
        date
      );
      await ioRedis.set(
        `integration:${orgId}:${post.id}:${date}`,
        JSON.stringify(loadAnalytics),
        'EX',
        !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
          ? 1
          : 3600
      );
      return loadAnalytics;
    } catch (e) {
      console.log(e);
      if (e instanceof RefreshToken) {
        return this.checkPostAnalytics(orgId, postId, date, true);
      }
    }

    return [];
  }

  async getStatistics(orgId: string, id: string) {
    const getPost = await this.getPostsRecursively(id, true, orgId, true);
    const content = getPost.map((p) => p.content);
    const shortLinksTracking = await this._shortLinkService.getStatistics(
      content
    );

    return {
      clicks: shortLinksTracking,
    };
  }

  async mapTypeToPost(
    body: CreatePostDto,
    organization: string,
    replaceDraft: boolean = false
  ): Promise<CreatePostDto> {
    if (!body?.posts?.every((p) => p?.integration?.id)) {
      throw new BadRequestException('All posts must have an integration id');
    }

    const mappedValues = {
      ...body,
      type: replaceDraft ? 'schedule' : body?.type,
      posts: await Promise.all(
        body?.posts?.map(async (post) => {
          const integration = await this._integrationService.getIntegrationById(
            organization,
            post.integration.id
          );

          if (!integration) {
            throw new BadRequestException(
              `Integration with id ${post.integration.id} not found`
            );
          }

          return {
            type: replaceDraft ? 'schedule' : body?.type,
            ...post,
            settings: {
              ...(post.settings || ({} as any)),
              __type: integration.providerIdentifier,
            },
          };
        }) || []
      ),
    };

    const validationPipe = new ValidationPipe({
      skipMissingProperties: false,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    });

    return await validationPipe.transform(mappedValues, {
      type: 'body',
      metatype: CreatePostDto,
    });
  }

  async getPostsRecursively(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ): Promise<PostWithConditionals[]> {
    const post = await this._postRepository.getPost(
      id,
      includeIntegration,
      orgId,
      isFirst
    );

    if (!post) {
      return [];
    }

    return [
      post!,
      ...(post?.childrenPost?.length
        ? await this.getPostsRecursively(
            post?.childrenPost?.[0]?.id,
            false,
            orgId,
            false
          )
        : []),
    ];
  }

  async getPosts(
    orgId: string,
    query: GetPostsDto,
    includeAttachments = false
  ) {
    const posts = await this._postRepository.getPosts(
      orgId,
      query,
      includeAttachments
    );

    if (!includeAttachments) {
      return posts;
    }

    return posts.map(({ image, ...post }) => {
      let attachments = [];
      try {
        attachments = JSON.parse(image || '[]');
      } catch (err) {}
      return {
        ...post,
        attachments: attachments.map((a: any) => ({
          id: a.id,
          path: a.path,
          thumbnail: a.thumbnail || null,
        })),
      };
    });
  }

  async getPostsMinified(orgId: string, query: GetPostsDto) {
    return minifyPosts({
      posts: await this._postRepository.getPosts(orgId, query),
    });
  }

  async getPostsList(orgId: string, query: GetPostsListDto) {
    return minifyPostsList(
      await this._postRepository.getPostsList(orgId, query)
    );
  }

  async updateMedia(id: string, imagesList: any[], convertToJPEG = false) {
    try {
      let imageUpdateNeeded = false;
      const getImageList = await Promise.all(
        (
          await Promise.all(
            (imagesList || []).map(async (p: any) => {
              if (!p.path && p.id) {
                imageUpdateNeeded = true;
                return this._mediaService.getMediaById(p.id);
              }

              return p;
            })
          )
        )
          .map((m) => {
            return {
              ...m,
              url:
                m.path.indexOf('http') === -1
                  ? process.env.FRONTEND_URL +
                    '/' +
                    process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
                    m.path
                  : m.path,
              type: 'image',
              path:
                m.path.indexOf('http') === -1
                  ? process.env.UPLOAD_DIRECTORY + m.path
                  : m.path,
              // The cover a user picks on a video is stored the same way as
              // `path` - sometimes a bare key, sometimes a full URL - but it
              // was handed to the providers untouched, so a relative one was
              // useless to every platform that wants a cover URL.
              ...(m.thumbnail
                ? {
                    thumbnail:
                      m.thumbnail.indexOf('http') === -1
                        ? process.env.UPLOAD_DIRECTORY + m.thumbnail
                        : m.thumbnail,
                  }
                : {}),
            };
          })
          .map(async (m) => {
            if (!convertToJPEG) {
              return m;
            }

            if (hasExtension(m.path, 'png')) {
              imageUpdateNeeded = true;
              const response = await axios.get(m.url, {
                responseType: 'arraybuffer',
              });

              const imageBuffer = Buffer.from(response.data);

              // Use sharp to get the metadata of the image
              const buffer = await sharp(imageBuffer)
                .jpeg({ quality: 100 })
                .toBuffer();

              const { path, originalname } = await this.storage.uploadFile({
                buffer,
                mimetype: 'image/jpeg',
                size: buffer.length,
                path: '',
                fieldname: '',
                destination: '',
                stream: new Readable(),
                filename: '',
                originalname: '',
                encoding: '',
              });

              return {
                ...m,
                name: originalname,
                url:
                  path.indexOf('http') === -1
                    ? process.env.FRONTEND_URL +
                      '/' +
                      process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
                      path
                    : path,
                type: 'image',
                path:
                  path.indexOf('http') === -1
                    ? process.env.UPLOAD_DIRECTORY + path
                    : path,
              };
            }

            return m;
          })
      );

      if (imageUpdateNeeded) {
        await this._postRepository.updateImages(
          id,
          JSON.stringify(getImageList)
        );
      }

      return getImageList;
    } catch (err: any) {
      return imagesList;
    }
  }

  async getPostGroupDebugExport(orgId: string, group: string) {
    const loadAll = await this._postRepository.getPostsByGroup(orgId, group);
    const errors = await this._postRepository.getErrorsByPostIds(
      loadAll.map((p) => p.id)
    );
    const posts = this.arrangePostsByGroup(loadAll, undefined);
    if (!posts.length) {
      throw new NotFoundException('Post not found');
    }
    const rootPost = posts[0] as any;

    return {
      type: 'draft' as const,
      shortLink: false,
      date: rootPost.publishDate.toISOString(),
      tags:
        rootPost.tags?.map((t: any) => ({
          value: t.tag.id,
          label: t.tag.name,
        })) || [],
      posts: [
        {
          integration: { id: 'REPLACE_WITH_LOCAL_INTEGRATION_ID' },
          // No group: creating a post with an existing group replaces that
          // group's posts, so importing would delete the original. It is
          // kept below as _debug.originalGroup.
          settings: JSON.parse(rootPost.settings || '{}'),
          value: posts.map((post) => ({
            content: post.content,
            image: JSON.parse(post.image || '[]'),
            delay: post.delay || 0,
          })),
        },
      ],
      _debug: {
        providerIdentifier: rootPost.integration?.providerIdentifier,
        providerName: rootPost.integration?.name,
        state: rootPost.state,
        error: rootPost.error,
        errors: errors.map((e) => ({
          message: e.message,
          platform: e.platform,
          body: e.body,
          createdAt: e.createdAt,
        })),
        originalGroup: group,
        originalPublishDate: rootPost.publishDate,
        exportedAt: new Date().toISOString(),
      },
    };
  }

  async getPostsByGroup(orgId: string, group: string) {
    const convertToJPEG = false;
    const loadAll = await this._postRepository.getPostsByGroup(orgId, group);
    const posts = this.arrangePostsByGroup(loadAll, undefined);
    // Deleted, or another organisation's group
    if (!posts.length) {
      throw new NotFoundException('Post not found');
    }

    return {
      group: posts?.[0]?.group,
      posts: await Promise.all(
        (posts || []).map(async (post) => ({
          ...post,
          integration: browserSafeIntegration(post.integration),
          image: await this.updateMedia(
            post.id,
            JSON.parse(post.image || '[]'),
            convertToJPEG
          ),
        }))
      ),
      integrationPicture: posts[0]?.integration?.picture,
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };
  }

  arrangePostsByGroup(all: any, parent?: string): PostWithConditionals[] {
    const findAll = all
      .filter((p: any) =>
        !parent ? !p.parentPostId : p.parentPostId === parent
      )
      .map(({ integration, ...all }: any) => ({
        ...all,
        ...(!parent ? { integration } : {}),
      }));

    return [
      ...findAll,
      ...(findAll.length
        ? findAll.flatMap((p: any) => this.arrangePostsByGroup(all, p.id))
        : []),
    ];
  }

  // GET /public/posts/:id, the page a share link opens. It needs no login, so
  // it returns only what that page shows. The full row also carries the
  // workspace id, the group, the channel settings, tags and, for a failed
  // post, the worker's error with its stack trace and the platform response.
  async getPublicPreview(id: string) {
    return (await this.getPostsRecursively(id, true)).map((post) => ({
      ...pick(post, ['id', 'content', 'image', 'publishDate', 'state']),
      ...(post.integration
        ? {
            integration: pick(post.integration, [
              'id',
              'name',
              'picture',
              'providerIdentifier',
              'profile',
            ]),
          }
        : {}),
    }));
  }

  async getPost(orgId: string, id: string, convertToJPEG = false) {
    const posts = await this.getPostsRecursively(id, true, orgId, true);
    if (!posts.length) {
      throw new NotFoundException('Post not found');
    }
    const list = {
      group: posts?.[0]?.group,
      posts: await Promise.all(
        (posts || []).map(async (post) => ({
          ...post,
          integration: browserSafeIntegration(post.integration),
          image: await this.updateMedia(
            post.id,
            JSON.parse(post.image || '[]'),
            convertToJPEG
          ),
        }))
      ),
      integrationPicture: posts[0]?.integration?.picture,
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };

    return list;
  }

  async getOldPosts(orgId: string, date: string) {
    return this._postRepository.getOldPosts(orgId, date);
  }

  public async updateTags(orgId: string, post: Post[]): Promise<Post[]> {
    const plainText = JSON.stringify(post);
    const extract = Array.from(
      plainText.match(/\(post:[a-zA-Z0-9-_]+\)/g) || []
    );
    if (!extract.length) {
      return post;
    }

    const ids = (extract || []).map((e) =>
      e.replace('(post:', '').replace(')', '')
    );
    const urls = await this._postRepository.getPostUrls(orgId, ids);
    const newPlainText = ids.reduce((acc, value) => {
      const findUrl = urls?.find?.((u) => u.id === value)?.releaseURL || '';
      return acc.replace(
        new RegExp(`\\(post:${value}\\)`, 'g'),
        findUrl.split(',')[0]
      );
    }, plainText);

    return this.updateTags(orgId, JSON.parse(newPlainText) as Post[]);
  }

  public async checkInternalPlug(
    integration: Integration,
    orgId: string,
    id: string,
    settings: any
  ) {
    const plugs = Object.entries(settings).filter(([key]) => {
      return key.indexOf('plug-') > -1;
    });

    if (plugs.length === 0) {
      return [];
    }

    const parsePlugs = plugs.reduce((all, [key, value]) => {
      const [_, name, identifier] = key.split('--');
      all[name] = all[name] || { name };
      all[name][identifier] = value;
      return all;
    }, {} as any);

    const list: {
      name: string;
      integrations: { id: string }[];
      delay: string;
      active: boolean;
    }[] = Object.values(parsePlugs);

    return (list || []).flatMap((trigger) => {
      return (trigger?.integrations || []).flatMap((int) => ({
        type: 'internal-plug',
        post: id,
        originalIntegration: integration.id,
        integration: int.id,
        plugName: trigger.name,
        orgId: orgId,
        delay: +trigger.delay,
        information: trigger,
      }));
    });
  }

  public async checkPlugs(
    orgId: string,
    providerName: string,
    integrationId: string
  ) {
    const loadAllPlugs = this._integrationManager.getAllPlugs();
    const getPlugs = await this._integrationService.getPlugs(
      orgId,
      integrationId
    );

    const currentPlug = loadAllPlugs.find((p) => p.identifier === providerName);

    return getPlugs
      .filter((plug) => {
        return currentPlug?.plugs?.some(
          (p: any) => p.methodName === plug.plugFunction
        );
      })
      .map((plug) => {
        const runPlug = currentPlug?.plugs?.find(
          (p: any) => p.methodName === plug.plugFunction
        )!;
        return {
          type: 'global',
          plugId: plug.id,
          delay: runPlug.runEveryMilliseconds,
          totalRuns: runPlug.totalRuns,
        };
      });
  }

  async deletePost(orgId: string, group: string) {
    const post = await this._postRepository.deletePost(orgId, group);

    if (post?.id) {
      await terminatePostWorkflows(this._temporalService, post.id);
    }

    // A successful delete used to answer `{ error: true }`, which read as a
    // failure to anyone consuming the public API (the n8n node surfaced it
    // verbatim). Nothing reads this body in-app, so report it honestly.
    return { success: true, id: post?.id ?? null };
  }

  async countPostsFromDay(orgId: string, date: Date) {
    return this._postRepository.countPostsFromDay(orgId, date);
  }

  getPostByForWebhookId(id: string) {
    return this._postRepository.getPostByForWebhookId(id);
  }

  async startWorkflow(
    taskQueue: string,
    postId: string,
    orgId: string,
    state: State
  ) {
    try {
      const workflows = this._temporalService.client
        .getRawClient()
        ?.workflow.list({
          query: `postId="${postId}" AND ExecutionStatus="Running"`,
        });

      for await (const executionInfo of workflows) {
        try {
          const workflow = await this._temporalService.client.getWorkflowHandle(
            executionInfo.workflowId
          );
          if (
            workflow &&
            (await workflow.describe()).status.name !== 'TERMINATED'
          ) {
            await workflow.terminate();
          }
        } catch (err) {}
      }
    } catch (err) {}

    if (state === 'DRAFT') {
      return;
    }

    try {
      await this._temporalService.client
        .getRawClient()
        ?.workflow.start('postWorkflowV114', {
          workflowId: `post_${postId}`,
          taskQueue: 'main',
          workflowIdConflictPolicy: 'TERMINATE_EXISTING',
          args: [
            {
              taskQueue: taskQueue,
              postId: postId,
              organizationId: orgId,
            },
          ],
          typedSearchAttributes: new TypedSearchAttributes([
            {
              key: postIdSearchParam,
              value: postId,
            },
            {
              key: organizationId,
              value: orgId,
            },
          ]),
        });
    } catch (err) {
      // The post stays saved without a workflow; leave a trace of why.
      console.error(
        `Could not start the publish workflow of post ${postId}`,
        err
      );
    }
  }

  /**
   * Server-side validation that used to live on the client (`checkValidity` +
   * the manage modal loop). Runs the provider's settings DTO validation, the
   * provider `checkValidity` (media rules) and the empty-content / too-long
   * character checks. Returns one result per post so the frontend can show the
   * same toasts it did before — and so `/posts` can refuse to create invalid
   * posts.
   */
  async validatePosts(
    orgId: string,
    posts: Array<{
      integration: { id: string };
      value: Array<{
        content?: string;
        image?: Array<{ path: string; thumbnail?: string }>;
      }>;
      settings?: any;
    }>
  ) {
    return Promise.all(
      (posts || []).map(async (post) => {
        const integration = await this._integrationService.getIntegrationById(
          orgId,
          post?.integration?.id
        );

        if (!integration) {
          throw new BadRequestException(
            `Integration with id ${post?.integration?.id} not found`
          );
        }

        const provider = this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );

        let additionalSettings: any[] = [];
        try {
          additionalSettings = JSON.parse(
            integration.additionalSettings || '[]'
          );
        } catch {
          additionalSettings = [];
        }

        const settings = post.settings || {};
        const media = (post.value || []).map((p) => p.image || []);

        // Settings DTO validation — mirrors the client `form.trigger()`.
        let valid = true;
        let settingsError = '';
        if (provider?.dto) {
          const instance = plainToInstance(provider.dto, settings, {
            enableImplicitConversion: false,
          });
          const validationErrors = await validate(instance as object, {
            skipMissingProperties: false,
          });
          settingsError = this.firstValidationError(validationErrors);
          valid = validationErrors.length === 0;
        }

        // Provider-specific media validation (the old client `checkValidity`).
        let errors: string | true = true;
        try {
          errors = await provider.checkValidity(
            media,
            settings,
            additionalSettings
          );
        } catch (err: any) {
          errors = err?.message || 'Invalid media';
        }

        // X with a link, on a plan that has no X link posts (HOOKPOST):
        // refused here, so the composer says so before saving, and the
        // create route (which runs this too) cannot be bypassed.
        if (
          errors === true &&
          isXProvider(integration.providerIdentifier) &&
          (post.value || []).some((v) => xPostHasLink(v.content || '')) &&
          (await this._subscriptionService.xLinksBlocked(orgId))
        ) {
          errors = X_LINKS_NOT_INCLUDED;
        }

        // Things worth a heads-up that don't block the save (e.g. Discord
        // posting an over-limit file as a link). Never fails validation.
        let notices: string[] = [];
        try {
          notices =
            (await provider.mediaNotices?.(
              media,
              settings,
              additionalSettings
            )) || [];
        } catch {
          notices = [];
        }

        const maximumCharacters = provider.maxLength(
          additionalSettings,
          settings
        );

        // Blank lines and spaces alone are empty, as the create DTO's
        // ValidContent sees them; otherwise /posts/valid passes and the save
        // fails with a raw validation error.
        const emptyContent = (post.value || []).some((a) => {
          const strip = stripHtmlValidation('normal', a.content || '', true);
          const length = countLength(
            integration.providerIdentifier,
            strip.trim()
          );
          return length === 0 && (a.image || []).length === 0;
        });

        const tooLong = (post.value || []).some((a) => {
          const strip = stripHtmlValidation('normal', a.content || '', true);
          const counted = countLength(integration.providerIdentifier, strip);
          return counted > (maximumCharacters || 1000000);
        });

        return {
          id: integration.id,
          identifier: integration.providerIdentifier,
          name: integration.name,
          valid,
          settingsError,
          errors,
          notices,
          emptyContent,
          tooLong,
          maximumCharacters,
        };
      })
    );
  }

  /** Returns the first class-validator message (incl. nested children), or ''. */
  private firstValidationError(errors: any[]): string {
    for (const e of errors || []) {
      if (e?.constraints) {
        return Object.values(e.constraints as Record<string, string>)[0] || '';
      }
      const child = e?.children?.length
        ? this.firstValidationError(e.children)
        : '';
      if (child) {
        return child;
      }
    }
    return '';
  }

  /** Which of these media paths are our own uploads that no longer exist. */
  findMissingMedia(paths: unknown[]) {
    return findMissingMedia(Array.isArray(paths) ? paths : []);
  }

  // Requeuing a post publishes it and its comments (the same channel's posts
  // in its group), so their files must still exist.
  private async guardThreadAgainstMissingMedia(
    orgId: string,
    post: Pick<Post, 'group' | 'integrationId' | 'image'>
  ) {
    const thread = (
      (await this._postRepository.getPostsByGroup(orgId, post.group)) || []
    ).filter((p) => p.integrationId === post.integrationId);
    await this.guardAgainstMissingMedia(
      mediaPathsOf(
        (thread.length ? thread : [post]).map((p) => ({
          value: [{ image: this.parseImages(p.image) }],
        }))
      )
    );
  }

  private parseImages(image?: string | null): Array<{ path?: string }> {
    try {
      const parsed = JSON.parse(image || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Publishing with one of our files that is gone (a failed post retried after
  // the 7-day purge removed its video) sent the platform a dead link and failed
  // again. Refuse it with what to do instead. Only publishing is checked:
  // drafts and updates are not held up, and links to other sites never are.
  private async guardAgainstMissingMedia(paths: string[]) {
    if (!paths.length) {
      return;
    }
    if ((await this.findMissingMedia(paths)).length) {
      throw new BadRequestException(MEDIA_REMOVED_MESSAGE);
    }
  }

  // A schedule-type save targeting an already-PUBLISHED post republishes it to
  // the platform: require the explicit `republish` opt-in instead. The message
  // doubles as the confirmation dialog for API/MCP automation.
  private guardAgainstRepublish(
    post: {
      state: State;
      publishDate: Date;
      integration?: { providerIdentifier: string };
    } | null,
    source: 'createPost' | 'changeDate'
  ) {
    // A post the user published themselves from a reminder is just as live
    if (post?.state !== 'PUBLISHED' && post?.state !== 'POSTED_MANUALLY') {
      return;
    }

    const howToUpdate =
      source === 'createPost' ? `use type 'update'` : `use action 'update'`;

    throw new BadRequestException(
      `This post was already published on ${dayjs
        .utc(post.publishDate)
        .format(
          'YYYY-MM-DD HH:mm'
        )} UTC. Saving it this way would publish it again to ${
        post.integration?.providerIdentifier || 'the channel'
      }. To edit without republishing, ${howToUpdate}. To intentionally publish again, pass republish: true.`
    );
  }

  /**
   * A FREE_POSTS_USED refusal from createPost made specific for the
   * signed-in user (SubscriptionService.forUser): names their own other
   * workspace that still has free posts with that account, never anyone
   * else's. Anything else comes back unchanged.
   */
  freePostsRefusalFor(error: unknown, userId: string | undefined) {
    return this._subscriptionService.forUser(error, userId);
  }

  async createPost(
    orgId: string,
    body: CreatePostDto,
    creationMethod: CreationMethod,
    keepGroup = false
  ): Promise<any[]> {
    // Every per-channel step that can refuse or throw (the republish guard,
    // shortlinks) runs for all channels before any is saved. Otherwise a later
    // channel failing would leave an earlier one saved and publishing while
    // the composer reports an error, and its retry would create it again.
    const prepared: {
      post: CreatePostDto['posts'][number];
      type: CreatePostDto['type'];
    }[] = [];
    // Only the four types. The repository saves anything that is not 'draft'
    // as QUEUE, and the public API used to put the raw type back after
    // validating its own: no type, or "whatever", was published (review of
    // f4bee956b, 25 Oct 2026).
    if (!isPostType(body?.type)) {
      throw new BadRequestException(
        `type must be one of ${POST_TYPES.join(', ')}`
      );
    }
    const publishing = body.type === 'schedule' || body.type === 'now';

    // A reminder is sent once: postWorkflowV114 does not repeat it, so a
    // repeating reminder would show on the calendar and never arrive
    if (body.inter && (body.posts || []).some((post) => post.remind)) {
      throw new BadRequestException(
        '"Remind me to post" cannot repeat. Turn off Repeat Post, or turn off the reminder.'
      );
    }

    // 'update' changes a post that exists in this workspace. A new root saved
    // under it took Prisma's default state, QUEUE, and the hourly sweep of
    // QUEUE posts would have published it.
    if (body.type === 'update') {
      for (const post of body.posts) {
        const id = post.value?.[0]?.id;
        if (!id || !(await this._postRepository.getPostById(id, orgId))) {
          throw new BadRequestException(
            `type 'update' changes a post that exists, and ${
              id ? `there is no post ${id} in this workspace` : 'no post id was given'
            }. Save it as a draft, or schedule it.`
          );
        }
      }
    }

    // Every way a post arrives (composer, public API, MCP, CLI, autopost)
    // ends here, so this is where an unconfirmed workspace is stopped. Only a
    // draft is saved without the check.
    if (body.type !== 'draft') {
      await this.guardUnverifiedWorkspace(orgId);
    }

    // And where a workspace on its free posts (trial.policy.ts free_posts)
    // is held to FREE_POST_LIMIT: a new post past them, drafts included, is
    // refused with FREE_POSTS_USED. An edit is a save that carries a post
    // this workspace has, on any of its channels. Carrying an id is not
    // enough: the composer gives every new value a random one (makeId). A
    // save that puts a post on a channel that gave its free posts in another
    // workspace is refused too, an edit moving a post there included
    // (channelsGainingPosts, read only for a workspace on its free posts).
    await this._subscriptionService.assertFreePostAllowed(orgId, {
      newPost:
        body.type !== 'update' && !(await this.savesExistingPost(orgId, body)),
      repeats: !!body.inter,
      channelsGainingPosts: () => this.channelsGainingPosts(orgId, body),
    });

    // Refusals first, for every channel, before any shortlink is made. The
    // republish guard goes ahead of the media one: an older published post's
    // video is usually purged, and the answer it needs is "use type update",
    // not "upload the file again".
    if (publishing && !body.republish) {
      for (const post of body.posts) {
        if (post.value?.[0]?.id) {
          this.guardAgainstRepublish(
            await this._postRepository.getPostById(post.value[0].id, orgId),
            'createPost'
          );
        }
      }
    }
    if (publishing) {
      await this.guardAgainstMissingMedia(mediaPathsOf(body.posts as any));
    }

    for (const post of body.posts) {
      // Saving a published post as a draft would turn it back into one, and
      // its next Schedule would then publish it again past the guard above.
      // Keep it published and save the edits only, as type 'update' does.
      let type = body.type;
      if (type === 'draft' && post.value?.[0]?.id) {
        const existing = await this._postRepository.getPostById(
          post.value[0].id,
          orgId
        );
        if (
          existing?.state === 'PUBLISHED' ||
          existing?.state === 'POSTED_MANUALLY'
        ) {
          type = 'update';
        }
      }
      const provider = this._integrationManager.getSocialIntegration(
        (post.settings as any)?.__type
      );
      const removeLinks = !!provider?.stripLinks?.();

      const messages = (post.value || []).map((p) => p.content);
      // No point shortlinking links on platforms that strip them out anyway
      const updateContent =
        !body.shortLink || removeLinks
          ? messages
          : await this._shortLinkService.convertTextToShortLinks(
              orgId,
              messages
            );

      post.value = (post.value || []).map((p, i) => ({
        ...p,
        content: removeLinks ? stripLinks(updateContent[i]) : updateContent[i],
      }));

      prepared.push({ post, type });
    }

    // All channels are written in one transaction: a database error on a
    // later channel rolls back the ones saved before it, so the composer's
    // error is the whole truth and its retry does not duplicate them.
    let saved: {
      post: CreatePostDto['posts'][number];
      type: CreatePostDto['type'];
      root: Post;
    }[];
    try {
      saved = await this._postRepository.transaction(async (tx) => {
        const list: typeof saved = [];
        for (const { post, type } of prepared) {
          const { posts } = await this._postRepository.createOrUpdatePost(
            type,
            orgId,
            type === 'now' ? dayjs().format('YYYY-MM-DDTHH:mm:00') : body.date,
            post,
            body.tags,
            creationMethod,
            body.inter,
            keepGroup,
            tx
          );

          // Nothing saved for this channel (it had no content): the request
          // answers [] as before, so keep none of the others either.
          if (!posts?.length) {
            throw new NothingSaved();
          }
          list.push({ post, type, root: posts[0] });
        }
        return list;
      });
    } catch (err) {
      if (err instanceof NothingSaved) {
        return [] as any[];
      }
      throw err;
    }

    // Workflows read the posts, so they start only once all are committed.
    // A channel whose start fails keeps its saved post, as before, and does
    // not stop the others from starting.
    const postList = [];
    for (const { post, type, root } of saved) {
      if (type !== 'update') {
        const failed = (err: unknown) =>
          console.error(
            `Could not start the publish workflow of post ${root.id}`,
            err
          );
        try {
          this.startWorkflow(
            post.settings.__type.split('-')[0].toLowerCase(),
            root.id,
            orgId,
            root.state
          ).catch(failed);
        } catch (err) {
          failed(err);
        }
      }

      Sentry.metrics.count('post_created', 1);
      postList.push({
        postId: root.id,
        integration: post.integration.id,
      });
    }

    return postList;
  }

  // Update ONLY the provider settings of a not-yet-published post (scheduled or
  // draft). The passed keys are merged into the existing settings; content and
  // publish date stay as they are, so the running publish workflow is left
  // untouched (type "update"). Shared by the agent/MCP tool and the public API
  // PUT /posts/:id/settings so both go through one path.
  async updatePostSettings(
    orgId: string,
    postId: string,
    settings: Record<string, any>,
    creationMethod: CreationMethod
  ): Promise<{ postId: string; publishDate: string }> {
    // Ordered as post -> comments, root includes integration and tags.
    const ordered = await this.getPostsRecursively(postId, true, orgId, true);

    const [root] = ordered;
    if (!root) {
      throw new NotFoundException('Post not found');
    }

    if (root.parentPostId) {
      throw new BadRequestException(
        'This id belongs to a comment, pass the id of the main post'
      );
    }

    if (root.state !== 'QUEUE' && root.state !== 'DRAFT') {
      throw new BadRequestException(
        'Only scheduled posts that were not published yet (or drafts) can be updated'
      );
    }

    if (
      root.state === 'QUEUE' &&
      dayjs.utc(root.publishDate).isBefore(dayjs.utc())
    ) {
      throw new BadRequestException(
        'The publish time of this post already passed, it cannot be updated'
      );
    }

    const integration = (root as any).integration;

    let existingSettings: Record<string, any>;
    try {
      existingSettings = JSON.parse(root.settings || '{}');
    } catch (err) {
      existingSettings = {};
    }

    // Merge: only the passed keys change, everything else stays.
    const mergedSettings = {
      ...existingSettings,
      ...(settings || {}),
      __type: integration.providerIdentifier,
    };

    // Keep the existing content/ids so the posts are updated in place (the
    // workflow identity is preserved) - only the settings differ.
    const value = ordered.map((p) => {
      let image = [];
      try {
        image = JSON.parse(p.image || '[]');
      } catch (err) {}
      return {
        id: p.id,
        content: p.content,
        delay: p.delay || 0,
        image,
      };
    });

    // Same server-side validation as the dashboard / public create route.
    const [validation] = await this.validatePosts(orgId, [
      {
        integration: { id: integration.id },
        settings: mergedSettings,
        value: value.map((p) => ({ content: p.content, image: p.image })),
      },
    ]);

    if (validation.emptyContent) {
      throw new BadRequestException(
        `${validation.name}: Your post should have at least one character or one image.`
      );
    }

    if (root.state !== 'DRAFT') {
      if (!validation.valid) {
        throw new BadRequestException(
          `${validation.name}: ${
            validation.settingsError || 'Please fix your settings'
          }`
        );
      }

      if (validation.errors !== true) {
        throw new BadRequestException(
          `${validation.name}: ${validation.errors}`
        );
      }

      if (validation.tooLong) {
        throw new BadRequestException(
          `${validation.name}: The maximum characters is ${validation.maximumCharacters}`
        );
      }
    }

    const date = dayjs.utc(root.publishDate).format('YYYY-MM-DDTHH:mm:ss');

    const [output] = await this.createPost(
      orgId,
      {
        date,
        // Settings-only update: keep the current state and leave the running
        // publish workflow alone.
        type: 'update',
        shortLink: false,
        tags: ((root as any).tags || []).map((t: any) => ({
          value: t.tag.name,
          label: t.tag.name,
        })),
        posts: [
          {
            integration,
            group: root.group,
            settings: mergedSettings,
            value,
          },
        ],
      } as any,
      creationMethod,
      // Keep the group stable: a client may have the calendar open while the
      // settings are updated out of band, and the calendar links posts by group.
      true
    );

    if (!output) {
      throw new BadRequestException('Failed to update the post');
    }

    return {
      postId: output.postId,
      publishDate: date,
    };
  }

  async separatePosts(content: string, len: number) {
    return this._openaiService.separatePosts(content, len);
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    return this._postRepository.changeState(id, state, err, body);
  }

  /** True for the one caller that gets to send this post's reminder. */
  async claimReminder(orgId: string, id: string) {
    const { count } = await this._postRepository.claimReminder(orgId, id);
    return count > 0;
  }

  releaseReminder(orgId: string, id: string) {
    return this._postRepository.releaseReminder(orgId, id);
  }

  /**
   * What the reminder page (/reminder/:id) and the reminder email show: the
   * caption as plain text to paste, the comments, each file's public URL,
   * and where to publish it by hand. Scoped to the workspace like getPost:
   * a post of another workspace is a 404.
   */
  async getReminder(orgId: string, id: string) {
    const { posts } = await this.getPost(orgId, id);
    const [root, ...comments] = posts as any[];
    if (!root || root.parentPostId) {
      throw new NotFoundException('Post not found');
    }

    const provider = this._integrationManager.getSocialIntegration(
      root.integration?.providerIdentifier
    );
    const asText = (content: string) =>
      stripHtmlValidation('normal', content || '', true).trim();

    return {
      id: root.id,
      group: root.group,
      state: root.state as State,
      remind: !!root.remind,
      publishDate: root.publishDate,
      caption: asText(root.content),
      comments: comments.map((c) => asText(c.content)).filter(Boolean),
      media: ((root.image || []) as any[])
        .filter((m: any) => m?.url)
        .map(
          (m: any): { url: string; video: boolean } => ({
            url: m.url,
            video: /\.(mp4|mov|m4v|webm)(\?|$)/i.test(m.url),
          })
        ),
      integration: {
        name: root.integration?.name,
        picture: root.integration?.picture,
        providerIdentifier: root.integration?.providerIdentifier,
      },
      platform:
        provider?.appLink?.name ||
        (provider?.name || root.integration?.providerIdentifier || '').split(
          '\n'
        )[0],
      appLink: provider?.appLink || null,
    };
  }

  /**
   * "Mark as posted" from the reminder page: the user published it from the
   * platform's own app. Only a reminder post of this workspace, and never one
   * Hookpost published or that failed.
   */
  async markPostedManually(orgId: string, id: string) {
    const { count } = await this._postRepository.markPostedManually(orgId, id);
    if (!count) {
      const post = await this._postRepository.getPostById(id, orgId);
      if (!post || post.deletedAt) {
        throw new NotFoundException('Post not found');
      }
      throw new BadRequestException(
        'Only a post set to "Remind me to post" can be marked as posted'
      );
    }

    return { id, state: 'POSTED_MANUALLY' as State };
  }

  /**
   * Nothing is published from a workspace in which nobody has confirmed their
   * email (EmailNotVerifiedException, 403 EMAIL_NOT_VERIFIED). Drafts are
   * not publishing and are never refused. Runs after the plan check (the
   * route's PoliciesGuard), so a workspace without a plan still meets the
   * paywall first.
   */
  /** Whether any channel of this save carries a live post of the workspace. */
  private async savesExistingPost(orgId: string, body: CreatePostDto) {
    for (const post of body.posts || []) {
      const id = post.value?.[0]?.id;
      // A deleted one is not: its id would otherwise make any save an edit.
      const existing = id && (await this._postRepository.getPostById(id, orgId));
      if (existing && !existing.deletedAt) {
        return true;
      }
    }
    return false;
  }

  /**
   * The channels this save puts a post on that it is not on yet: every
   * channel of a new value, and the channel an edit moves its post to
   * (createOrUpdatePost connects the post to the channel the save names).
   */
  private async channelsGainingPosts(orgId: string, body: CreatePostDto) {
    const ids = new Set<string>();
    for (const post of body.posts || []) {
      const channel = post.integration?.id;
      if (!channel) continue;
      const id = post.value?.[0]?.id;
      const existing = id && (await this._postRepository.getPostById(id, orgId));
      if (!existing || existing.deletedAt || existing.integrationId !== channel) {
        ids.add(channel);
      }
    }
    return [...ids];
  }

  private async guardUnverifiedWorkspace(orgId: string) {
    if (!(await this.workspaceCanPublish(orgId))) {
      throw new EmailNotVerifiedException();
    }
  }

  /**
   * Someone in the workspace has confirmed their email. Also asked by the
   * publisher itself (PostActivity), right before a post goes out, for posts
   * that reach it by any other way (the hourly sweep, a repeating post).
   */
  workspaceCanPublish(orgId: string) {
    return this._postRepository.organizationCanPublish(orgId);
  }

  async changePostStatus(
    orgId: string,
    id: string,
    status: 'draft' | 'schedule'
  ) {
    const getPostById = await this._postRepository.getPostById(id, orgId);
    if (!getPostById) {
      throw new BadRequestException('Post not found');
    }

    if (status === 'schedule') {
      await this.guardUnverifiedWorkspace(orgId);
      await this.guardThreadAgainstMissingMedia(orgId, getPostById);
    }

    const state: State = status === 'draft' ? 'DRAFT' : 'QUEUE';
    await this._postRepository.changeState(id, state);

    try {
      await this.startWorkflow(
        getPostById.integration.providerIdentifier.split('-')[0].toLowerCase(),
        getPostById.id,
        orgId,
        state
      );
    } catch (err) {}

    return { id, state };
  }

  async changeDate(
    orgId: string,
    id: string,
    date: string,
    action: 'schedule' | 'update' = 'schedule',
    republish = false
  ) {
    const getPostById = await this._postRepository.getPostById(id, orgId);

    if (action === 'schedule' && !republish) {
      this.guardAgainstRepublish(getPostById, 'changeDate');
    }

    // A draft moved on the calendar stays a draft (the repository keeps
    // isDraft), so it publishes nothing and its files are not checked.
    if (
      action === 'schedule' &&
      getPostById &&
      getPostById.state !== 'DRAFT'
    ) {
      await this.guardUnverifiedWorkspace(orgId);
      await this.guardThreadAgainstMissingMedia(orgId, getPostById);
    }

    // schedule: Set status to QUEUE and change date (reschedule the post)
    // update: Just change the date without changing the status
    const newDate = await this._postRepository.changeDate(
      orgId,
      id,
      date,
      getPostById.state === 'DRAFT',
      action
    );

    if (action === 'schedule') {
      try {
        await this.startWorkflow(
          getPostById.integration.providerIdentifier
            .split('-')[0]
            .toLowerCase(),
          getPostById.id,
          orgId,
          getPostById.state === 'DRAFT' ? 'DRAFT' : 'QUEUE'
        );
      } catch (err) {}
    }

    return newDate;
  }

  async generatePostsDraft(orgId: string, body: CreateGeneratedPostsDto) {
    const getAllIntegrations = (
      await this._integrationService.getIntegrationsList(orgId)
    ).filter((f) => !f.disabled && f.providerIdentifier !== 'reddit');

    // const posts = chunk(body.posts, getAllIntegrations.length);
    const allDates = dayjs()
      .isoWeek(body.week)
      .year(body.year)
      .startOf('isoWeek');

    const dates = [...new Array(7)].map((_, i) => {
      return allDates.add(i, 'day').format('YYYY-MM-DD');
    });

    const findTime = (): string => {
      const totalMinutes = Math.floor(Math.random() * 144) * 10;

      // Convert total minutes to hours and minutes
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      // Format hours and minutes to always be two digits
      const formattedHours = hours.toString().padStart(2, '0');
      const formattedMinutes = minutes.toString().padStart(2, '0');
      const randomDate =
        shuffle(dates)[0] + 'T' + `${formattedHours}:${formattedMinutes}:00`;

      if (dayjs(randomDate).isBefore(dayjs())) {
        return findTime();
      }

      return randomDate;
    };

    for (const integration of getAllIntegrations) {
      for (const toPost of body.posts) {
        const group = makeId(10);
        const randomDate = findTime();

        await this.createPost(
          orgId,
          {
            type: 'draft',
            date: randomDate,
            order: '',
            shortLink: false,
            tags: [],
            posts: [
              {
                group,
                integration: {
                  id: integration.id,
                },
                settings: {
                  __type: integration.providerIdentifier as any,
                  title: '',
                  tags: [],
                  subreddit: [],
                },
                value: [
                  ...toPost.list.map((l) => ({
                    id: '',
                    content: l.post,
                    delay: 0,
                    image: [],
                  })),
                  {
                    id: '',
                    delay: 0,
                    content: `Check out the full story here:\n${
                      body.postId || body.url
                    }`,
                    image: [],
                  },
                ],
              },
            ],
          },
          'WEB'
        );
      }
    }
  }

  findAllExistingCategories() {
    return this._postRepository.findAllExistingCategories();
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._postRepository.findAllExistingTopicsOfCategory(category);
  }

  findPopularPosts(category: string, topic?: string) {
    return this._postRepository.findPopularPosts(category, topic);
  }

  async findFreeDateTime(orgId: string, integrationId?: string) {
    const findTimes = await this._integrationService.findFreeDateTime(
      orgId,
      integrationId
    );
    // No posting times at all (every time removed from the schedule, every
    // channel disabled, or an unknown channel id): no day can ever have a
    // free slot, so the search below would never end.
    if (!findTimes.length) {
      return this.fallbackFreeDateTime();
    }
    return this.findFreeDateTimeRecursive(
      orgId,
      findTimes,
      dayjs.utc().startOf('day')
    );
  }

  private fallbackFreeDateTime() {
    return dayjs.utc().add(10, 'minute').format('YYYY-MM-DDTHH:mm:00');
  }

  async createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._postRepository.createPopularPosts(post);
  }

  private async findFreeDateTimeRecursive(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs,
    daysLeft = 366
  ): Promise<string> {
    // Every slot booked for a year ahead: stop searching
    if (daysLeft <= 0) {
      return this.fallbackFreeDateTime();
    }

    const list = await this._postRepository.getPostsCountsByDates(
      orgId,
      times,
      date
    );

    if (!list.length) {
      return this.findFreeDateTimeRecursive(
        orgId,
        times,
        date.add(1, 'day'),
        daysLeft - 1
      );
    }

    const num = list.reduce<null | number>((prev, curr) => {
      if (prev === null || prev > curr) {
        return curr;
      }
      return prev;
    }, null) as number;

    return date.clone().add(num, 'minutes').format('YYYY-MM-DDTHH:mm:00');
  }

  getComments(postId: string) {
    return this._postRepository.getComments(postId);
  }

  getTags(orgId: string) {
    return this._postRepository.getTags(orgId);
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._postRepository.createTag(orgId, body);
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._postRepository.editTag(id, orgId, body);
  }

  deleteTag(id: string, orgId: string) {
    return this._postRepository.deleteTag(id, orgId);
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    comment: string
  ) {
    return this._postRepository.createComment(orgId, userId, postId, comment);
  }
}
