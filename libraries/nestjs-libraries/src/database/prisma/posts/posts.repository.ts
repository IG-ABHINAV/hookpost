import {
  PrismaRepository,
  PrismaTransaction,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { serializeError } from '@hookpost/helpers/utils/serialize.error';
import { readablePostError } from '@hookpost/helpers/utils/post.error';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Post as PostBody } from '@hookpost/nestjs-libraries/dtos/posts/create.post.dto';
import {
  APPROVED_SUBMIT_FOR_ORDER,
  CreationMethod,
  Post,
  Prisma,
  State,
} from '@prisma/client';
import { GetPostsDto } from '@hookpost/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@hookpost/nestjs-libraries/dtos/posts/get.posts.list.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import utc from 'dayjs/plugin/utc';
import { v4 as uuidv4 } from 'uuid';
import { CreateTagDto } from '@hookpost/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(utc);

// Post.error is the worker's raw failure: JSON with a stack trace and server
// paths, often cut off. The calendar shows why a post failed, so lists carry
// only the message, and nothing for posts that did not fail.
const withReadableError = <T extends { state: State; error: string | null }>(
  post: T
): T => ({
  ...post,
  error: post.state === State.ERROR ? readablePostError(post.error) : null,
});

// A deleted tag is only soft-deleted and keeps its links to posts.
const liveTags = {
  where: { tag: { deletedAt: null as Date | null } },
  select: { tag: true },
} as const;

@Injectable()
export class PostsRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _popularPosts: PrismaRepository<'popularPosts'>,
    private _comments: PrismaRepository<'comments'>,
    private _tags: PrismaRepository<'tags'>,
    private _tagsPosts: PrismaRepository<'tagsPosts'>,
    private _errors: PrismaRepository<'errors'>,
    private _transaction: PrismaTransaction,
    private _userOrganization: PrismaRepository<'userOrganization'>,
    private _marketplaceAccount: PrismaRepository<'marketplaceAccount'>
  ) {}

  /**
   * True when the workspace may publish (PostsService.workspaceCanPublish):
   *  - someone in it has confirmed their email: an active member (not
   *    disabled, not deleted) whose account is activated. A workspace made
   *    by a password sign-up has none until its owner opens the emailed link
   *    (or signs in with Google on the same address); or
   *  - it is an api.market subscriber's workspace: the gateway provisions it
   *    with no users at all (marketplace.account.repository.ts) for a caller
   *    api.market itself authenticated, and only the gateway can make that
   *    row. "No members" alone never passes: a squatter could empty their
   *    own workspace and keep its API key.
   */
  async organizationCanPublish(orgId: string) {
    const verified = await this._userOrganization.model.userOrganization.count({
      where: {
        organizationId: orgId,
        disabled: false,
        user: { activated: true, deletedAt: null },
      },
    });
    if (verified > 0) {
      return true;
    }
    const marketplace =
      await this._marketplaceAccount.model.marketplaceAccount.count({
        where: { organizationId: orgId },
      });
    return marketplace > 0;
  }

  // Runs `fn` in one interactive transaction: everything written through the
  // `tx` it receives commits together or not at all. Used by POST /posts so
  // a channel that fails to save takes the channels saved before it back out.
  transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this._transaction.model.$transaction(fn, {
      timeout: 30000,
      maxWait: 10000,
    });
  }

  searchForMissingThreeHoursPosts() {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
          deletedAt: null,
        },
        publishDate: {
          gte: dayjs.utc().subtract(2, 'day').toDate(),
          lt: dayjs.utc().toDate(),
        },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        organizationId: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
        publishDate: true,
      },
    });
  }

  getOldPosts(orgId: string, date: string) {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        organizationId: orgId,
        publishDate: {
          lte: dayjs(date).toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'desc',
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  updateImages(id: string, images: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        image: images,
      },
    });
  }

  getPostUrls(orgId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        releaseURL: true,
      },
    });
  }

  async getPosts(
    orgId: string,
    query: GetPostsDto,
    includeAttachments = false
  ) {
    // Use the provided start and end dates directly
    const startDate = dayjs.utc(query.startDate).toDate();
    const endDate = dayjs.utc(query.endDate).toDate();

    const list = await this._post.model.post.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                organizationId: orgId,
              },
            ],
          },
          {
            OR: [
              {
                publishDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                intervalInDays: {
                  not: null,
                },
              },
            ],
          },
        ],
        integration: {
          deletedAt: null,
          organizationId: orgId,
          ...(query.customer ? { customerId: query.customer } : {}),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        releaseId: true,
        state: true,
        intervalInDays: true,
        group: true,
        creationMethod: true,
        settings: true,
        error: true,
        remind: true,
        ...(includeAttachments ? { image: true } : {}),
        tags: liveTags,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
      },
    });

    return list.map(withReadableError).reduce((all, post) => {
      if (!post.intervalInDays) {
        return [...all, post];
      }

      const addMorePosts = [];
      let startingDate = dayjs.utc(post.publishDate);
      while (dayjs.utc(endDate).isSameOrAfter(startingDate)) {
        if (dayjs(startingDate).isSameOrAfter(dayjs.utc(post.publishDate))) {
          addMorePosts.push({
            ...post,
            publishDate: startingDate.toDate(),
            actualDate: post.publishDate,
          });
        }

        startingDate = startingDate.add(post.intervalInDays, 'days');
      }

      return [...all, ...addMorePosts];
    }, [] as any[]);
  }

  async getPostsList(orgId: string, query: GetPostsListDto) {
    const page = query.page || 0;
    const limit = query.limit || 20;
    const skip = page * limit;

    const stateFilter = query.state || 'all';
    const stateAndDate =
      stateFilter === 'scheduled'
        ? {
            state: State.QUEUE,
          }
        : stateFilter === 'draft'
        ? { state: State.DRAFT }
        : stateFilter === 'published'
        ? { state: { in: [State.PUBLISHED, State.POSTED_MANUALLY] } }
        : {
            state: {
              in: [
                State.QUEUE,
                State.DRAFT,
                State.PUBLISHED,
                State.ERROR,
                State.REMINDER_SENT,
                State.POSTED_MANUALLY,
              ],
            },
          };

    // "Scheduled" means what is still to come, so it is the only tab restricted
    // to future posts and the only one ordered soonest-first. Every other tab
    // spans history and reads newest-first. Restricting "all"/"draft" to future
    // posts would contradict their own state filters, which include PUBLISHED
    // and ERROR - posts that are in the past by definition - and hid them.
    const orderDirection: 'asc' | 'desc' =
      stateFilter === 'scheduled' ? 'asc' : 'desc';

    const where = {
      AND: [
        {
          OR: [
            {
              organizationId: orgId,
            },
          ],
        },
      ],
      ...stateAndDate,
      ...(stateFilter === 'scheduled'
        ? { publishDate: { gte: dayjs.utc().toDate() } }
        : {}),
      deletedAt: null as Date | null,
      parentPostId: null as string | null,
      intervalInDays: null as number | null,

      integration: {
        deletedAt: null as any,
        organizationId: orgId,
        ...(query.customer
          ? {
              customerId: query.customer,
            }
          : {}),
      },
    };

    const [posts, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          publishDate: orderDirection,
        },
        select: {
          id: true,
          content: true,
          publishDate: true,
          releaseURL: true,
          releaseId: true,
          state: true,
          intervalInDays: true,
          group: true,
          creationMethod: true,
          error: true,
          remind: true,
          tags: liveTags,
          integration: {
            select: {
              id: true,
              providerIdentifier: true,
              name: true,
              picture: true,
            },
          },
        },
      }),
      this._post.model.post.count({ where }),
    ]);

    return {
      posts: posts.map(withReadableError),
      total,
      page,
      limit,
      hasMore: skip + posts.length < total,
    };
  }

  async deletePost(orgId: string, group: string) {
    await this._post.model.post.updateMany({
      where: {
        organizationId: orgId,
        group,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
      },
      select: {
        id: true,
      },
    });
  }

  getPostsByGroup(orgId: string, group: string) {
    return this._post.model.post.findMany({
      where: {
        group,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        integration: true,
        tags: {
          select: {
            tag: true,
          },
        },
      },
    });
  }

  getPost(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        ...(includeIntegration
          ? {
              integration: true,
              tags: {
                select: {
                  tag: true,
                },
              },
            }
          : {}),
        childrenPost: true,
      },
    });
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state: 'PUBLISHED',
        releaseURL,
        releaseId: postId,
        // A post that failed once (e.g. ERROR "No Post" from the pre-16 Oct
        // Free-plan gate) and later published kept the old error text, so
        // any count of `error IS NOT NULL` reported live posts as failures.
        error: null,
      },
    });
  }

  // Only one reminder per scheduled post: the first caller moves the queued
  // root to REMINDER_SENT, a retried activity or a second run finds nothing
  // to move (count 0) and sends nothing.
  claimReminder(orgId: string, id: string) {
    return this._post.model.post.updateMany({
      where: {
        id,
        organizationId: orgId,
        parentPostId: null,
        deletedAt: null,
        remind: true,
        state: 'QUEUE',
      },
      data: {
        state: 'REMINDER_SENT',
        error: null,
      },
    });
  }

  // The reminder could not be sent: back in the queue, so the retry (or the
  // missing-posts sweep) sends it.
  releaseReminder(orgId: string, id: string) {
    return this._post.model.post.updateMany({
      where: {
        id,
        organizationId: orgId,
        state: 'REMINDER_SENT',
      },
      data: {
        state: 'QUEUE',
      },
    });
  }

  // "Mark as posted" on the reminder page. Also before the reminder went
  // out (the user posted early): the workflow then finds nothing to claim.
  markPostedManually(orgId: string, id: string) {
    return this._post.model.post.updateMany({
      where: {
        id,
        organizationId: orgId,
        parentPostId: null,
        deletedAt: null,
        remind: true,
        state: { in: ['QUEUE', 'REMINDER_SENT', 'POSTED_MANUALLY'] },
      },
      data: {
        state: 'POSTED_MANUALLY',
        error: null,
      },
    });
  }

  updateReleaseId(id: string, orgId: string, releaseId: string) {
    return this._post.model.post.update({
      where: {
        id,
        organizationId: orgId,
        releaseId: 'missing',
      },
      data: {
        releaseId: String(releaseId),
      },
    });
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    const update = await this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state,
        // serializeError, not JSON.stringify: stringify returns '{}' for a real
        // Error (message/stack are non-enumerable) and THROWS on a circular
        // one. The throw happened here, inside the data literal, before the
        // update ran - so a provider error carrying a fetch/Axios response made
        // changeState itself fail and left the post stuck in its old state
        // instead of ERROR.
        ...(err ? { error: serializeError(err) } : {}),
      },
      include: {
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });

    if (state === 'ERROR' && err && body) {
      try {
        await this._errors.model.errors.create({
          data: {
            message: serializeError(err),
            organizationId: update.organizationId,
            platform: update.integration.providerIdentifier,
            postId: update.id,
            body: serializeError(body),
          },
        });
      } catch (err) {}
    }

    return update;
  }

  getErrorsByPostIds(postIds: string[]) {
    return this._errors.model.errors.findMany({
      where: {
        postId: { in: postIds },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async changeDate(
    orgId: string,
    id: string,
    date: string,
    isDraft: boolean,
    action: 'schedule' | 'update' = 'schedule'
  ) {
    return this._post.model.post.update({
      where: {
        organizationId: orgId,
        id,
      },
      data: {
        publishDate: dayjs(date).toDate(),
        // schedule: set state to QUEUE (or DRAFT if it was a draft)
        // update: don't change the state
        ...(action === 'schedule'
          ? {
              state: isDraft ? 'DRAFT' : 'QUEUE',
              releaseId: null,
              releaseURL: null,
              // The post is queued afresh, so why the last attempt failed no
              // longer applies: a post stopped by the plan gate and then
              // rescheduled kept "Choose a plan to continue." on its row.
              error: null,
            }
          : {}),
      },
    });
  }

  countPostsFromDay(orgId: string, date: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: date,
        },
        OR: [
          {
            deletedAt: null,
            state: {
              in: ['QUEUE'],
            },
          },
          {
            // a reminder counts like a publish: it went out, by hand
            state: { in: ['PUBLISHED', 'REMINDER_SENT', 'POSTED_MANUALLY'] },
          },
        ],
      },
    });
  }

  async createOrUpdatePost(
    state: 'draft' | 'schedule' | 'now' | 'update',
    orgId: string,
    date: string,
    body: PostBody,
    tags: { value: string; label: string }[],
    creationMethod: CreationMethod,
    inter?: number,
    // Keep the existing group instead of rotating it, so open clients
    // (calendar) holding the group stay valid. Used by out-of-band updates
    // (agent / MCP / public API); the dashboard keeps the rotate-and-sweep.
    keepGroup = false,
    // Inside PostsRepository.transaction: write through its client so the
    // save commits or rolls back with the rest of the request.
    tx?: Prisma.TransactionClient
  ) {
    const db = {
      post: tx?.post ?? this._post.model.post,
      tags: tx?.tags ?? this._tags.model.tags,
      tagsPosts: tx?.tagsPosts ?? this._tagsPosts.model.tagsPosts,
    };
    const posts: Post[] = [];
    const uuid = uuidv4();
    const group = keepGroup && body.group ? body.group : uuid;

    for (const value of body.value) {
      const updateData = (type: 'create' | 'update') => ({
        publishDate: dayjs(date).toDate(),
        integration: {
          connect: {
            id: body.integration.id,
            organizationId: orgId,
          },
        },
        ...(posts?.[posts.length - 1]?.id
          ? {
              parentPost: {
                connect: {
                  id: posts[posts.length - 1]?.id,
                },
              },
            }
          : type === 'update'
          ? {
              parentPost: {
                disconnect: true,
              },
            }
          : {}),
        content: value.content,
        delay: value.delay || 0,
        group,
        intervalInDays: inter ? +inter : null,
        approvedSubmitForOrder: APPROVED_SUBMIT_FOR_ORDER.NO,
        ...(type === 'create' ? { creationMethod } : {}),
        ...(state === 'update'
          ? // 'update' keeps an existing row's state. A root it would create
            // (PostsService refuses that; this is the second line) is a
            // draft: left unset, Prisma's default is QUEUE, which the hourly
            // sweep publishes. Replies follow their root, as before.
            type === 'create' && !posts.length
            ? { state: 'DRAFT' as const }
            : {}
          : {
              state:
                state === 'draft' ? ('DRAFT' as const) : ('QUEUE' as const),
            }),
        image: JSON.stringify(value.image),
        settings: JSON.stringify(body.settings),
        // Not sent (public API, MCP, older clients): a new post publishes
        // automatically, as before, and an update keeps what it had.
        ...(body.remind !== undefined ? { remind: !!body.remind } : {}),
        organization: {
          connect: {
            id: orgId,
          },
        },
      });

      posts.push(
        await db.post.upsert({
          // Scoped to the caller's workspace: an id from another workspace
          // (the share link exposes it) creates a new post instead of
          // rewriting theirs.
          where: {
            id: value.id || uuidv4(),
            organizationId: orgId,
          },
          create: { ...updateData('create') },
          update: {
            ...updateData('update'),
            lastMessage: {
              disconnect: true,
            },
            submittedForOrder: {
              disconnect: true,
            },
          },
        })
      );

      if (posts.length === 1) {
        await db.tagsPosts.deleteMany({
          where: {
            post: {
              id: posts[0].id,
            },
          },
        });

        if (tags.length) {
          const tagsList = await db.tags.findMany({
            where: {
              orgId: orgId,
              // a deleted tag keeps its name; never link it again
              deletedAt: null,
              name: {
                in: tags.map((tag) => tag.label).filter((f) => f),
              },
            },
          });

          if (tagsList.length) {
            await db.post.update({
              where: {
                id: posts[posts.length - 1].id,
              },
              data: {
                tags: {
                  createMany: {
                    data: tagsList.map((tag) => ({
                      tagId: tag.id,
                    })),
                  },
                },
              },
            });
          }
        }
      }
    }

    const previousPost = body.group
      ? (
          await db.post.findFirst({
            where: {
              organizationId: orgId,
              group: body.group,
              deletedAt: null,
              parentPostId: null,
            },
            select: {
              id: true,
            },
          })
        )?.id!
      : undefined;

    // Both sweeps stay inside the caller's workspace, so a group id taken
    // from someone else's share link cannot delete their post.
    if (body.group && !keepGroup) {
      await db.post.updateMany({
        where: {
          organizationId: orgId,
          group: body.group,
          deletedAt: null,
        },
        data: {
          parentPostId: null,
          deletedAt: new Date(),
        },
      });
    }

    // keepGroup: the updated rows still carry the old group, so sweep only the
    // rows dropped from it (removed comments) by id instead of by group.
    if (body.group && keepGroup) {
      await db.post.updateMany({
        where: {
          organizationId: orgId,
          group: body.group,
          deletedAt: null,
          id: {
            notIn: posts.map((p) => p.id),
          },
        },
        data: {
          parentPostId: null,
          deletedAt: new Date(),
        },
      });
    }

    return { previousPost, posts };
  }

  async submit(id: string, order: string, buyerOrganizationId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        submittedForOrderId: order,
        approvedSubmitForOrder: 'WAITING_CONFIRMATION',
        submittedForOrganizationId: buyerOrganizationId,
      },
      select: {
        id: true,
        description: true,
        submittedForOrder: {
          select: {
            messageGroupId: true,
          },
        },
      },
    });
  }

  updateMessage(id: string, messageId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        lastMessageId: messageId,
      },
    });
  }

  getPostById(id: string, org?: string) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(org ? { organizationId: org } : {}),
      },
      include: {
        integration: true,
        submittedForOrder: {
          include: {
            posts: {
              where: {
                state: 'PUBLISHED',
              },
            },
            ordersItems: true,
            seller: {
              select: {
                id: true,
                account: true,
              },
            },
          },
        },
      },
    });
  }

  findAllExistingCategories() {
    return this._popularPosts.model.popularPosts.findMany({
      select: {
        category: true,
      },
      distinct: ['category'],
    });
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
      },
      select: {
        topic: true,
      },
      distinct: ['topic'],
    });
  }

  findPopularPosts(category: string, topic?: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
        ...(topic ? { topic } : {}),
      },
      select: {
        content: true,
        hook: true,
      },
    });
  }

  createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._popularPosts.model.popularPosts.create({
      data: {
        category: 'category',
        topic: 'topic',
        content: 'content',
        hook: 'hook',
      },
    });
  }

  async getPostsCountsByDates(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs
  ) {
    const dates = await this._post.model.post.findMany({
      where: {
        deletedAt: null,
        organizationId: orgId,
        publishDate: {
          in: times.map((time) => {
            return date.clone().add(time, 'minutes').toDate();
          }),
        },
      },
    });

    return times.filter(
      (time) =>
        date.clone().add(time, 'minutes').isAfter(dayjs.utc()) &&
        !dates.find((dateFind) => {
          return (
            dayjs
              .utc(dateFind.publishDate)
              .diff(date.clone().startOf('day'), 'minutes') == time
          );
        })
    );
  }

  // Read only by GET /public/posts/:id/comments, which needs no login: no
  // workspace id, and no deleted comments. userId stays because the page
  // numbers commenters by it (User 1, User 2).
  async getComments(postId: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
        deletedAt: null,
      },
      select: {
        id: true,
        content: true,
        userId: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async getTags(orgId: string) {
    return this._tags.model.tags.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.create({
      data: {
        orgId,
        name: body.name,
        color: body.color,
      },
    });
  }

  // Scoped to the caller's workspace like deleteTag; by id alone, PUT
  // /posts/tags/:id renamed another workspace's tag.
  // A tag of another workspace, or one deleted in another tab, is a 404, not
  // the 500 a Prisma update throws when its where matches nothing.
  async editTag(id: string, orgId: string, body: CreateTagDto) {
    const { count } = await this._tags.model.tags.updateMany({
      where: {
        id,
        orgId,
        deletedAt: null,
      },
      data: {
        name: body.name,
        color: body.color,
      },
    });
    if (!count) {
      throw new NotFoundException('Tag not found');
    }
    // Deleted between the two statements (another tab): still a 404, not a
    // 200 with an empty body.
    const tag = await this._tags.model.tags.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  // Same rules as editTag: by id alone a Prisma update threw (500) for a tag
  // of another workspace or a missing id. One already deleted is a 404 too;
  // the tag list ignores the status and simply refreshes.
  async deleteTag(id: string, orgId: string) {
    const { count } = await this._tags.model.tags.updateMany({
      where: {
        id,
        orgId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });
    if (!count) {
      throw new NotFoundException('Tag not found');
    }
    const tag = await this._tags.model.tags.findFirst({
      where: { id, orgId },
    });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    content: string
  ) {
    return this._comments.model.comments.create({
      data: {
        organizationId: orgId,
        userId,
        postId,
        content,
      },
    });
  }

  async getPostByForWebhookId(postId: string) {
    return this._post.model.post.findMany({
      where: {
        id: postId,
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  async getPostsSince(orgId: string, since: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: new Date(since),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }
}
