#!/usr/bin/env node
/**
 * Writes the OpenAPI files of the Hookpost products sold on api.market, one
 * per product (the file each api.market Source imports):
 *
 *   docs/marketplace/social-scheduler.openapi.json   /api/mkt/v1/social
 *   docs/marketplace/linkedin-carousel.openapi.json  /api/mkt/v1/linkedin
 *   docs/marketplace/x-threads.openapi.json          /api/mkt/v1/x
 *   docs/marketplace/post-validator.openapi.json     /api/mkt/v1/validate
 *   docs/marketplace/probe.openapi.json              /api/mkt/v1/<product>/_probe (private plan only)
 *
 *   node scripts/marketplace/build-openapi.mjs
 *
 * Run it after changing a marketplace route (apps/backend/src/marketplace-api)
 * and commit the JSON. apps/backend/src/marketplace-api/openapi.contract.spec.ts
 * fails when a spec path has no route, a route has no spec path, or a spec
 * says something the copy rules forbid.
 *
 * No security scheme is declared: buyers authenticate with api.market's own
 * key, and api.market adds our gateway secret and plan token itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'marketplace');
const ORIGIN = 'https://hookpost.hookstep.in/api/mkt/v1';

const CONTACT = { name: 'Hookstep support', email: 'support@hookstep.in', url: 'https://hookpost.hookstep.in' };

const BILLING_HEADER = {
  'X-Magicapi-Billing': {
    description: 'Credits this call used, as api.market bills them (API=N;). Reads are API=0;.',
    schema: { type: 'string', example: 'API=1;' },
  },
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({
  'application/json': { schema, ...(example ? { example } : {}) },
});
const ok = (description, schema, example) => ({
  description,
  headers: BILLING_HEADER,
  content: json(schema, example),
});
const error = (description) => ({ description, content: json(ref('Error')) });

const ERRORS = {
  400: error('The request is not valid. Nothing was done or billed.'),
  402: error('Over a plan limit (credits, channels, storage, or a network the plan does not include). Not billed.'),
  404: error('No such channel, post or media in your workspace.'),
  409: error('Conflicts with the current state (already published, duplicate post, same call still running).'),
  429: error('Too many calls, or a daily network limit. Not billed.'),
  503: error('Paused or at capacity. Not billed.'),
};
const errors = (...codes) => Object.fromEntries(codes.map((c) => [String(c), ERRORS[c]]));

const pathParam = (name, description) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});
const queryParam = (name, description, schema = { type: 'string' }) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const SCHEDULE_AT = {
  type: 'string',
  description:
    'When to publish: an ISO 8601 time with a zone ("2026-11-02T09:30:00Z"), "now", or "draft". Trials schedule up to 7 days ahead, paid plans up to 35.',
  example: '2026-11-02T09:30:00Z',
};
const LINK_POLICY = {
  type: 'string',
  enum: ['reject', 'allow'],
  default: 'reject',
  description:
    'X only. "reject" (the default) refuses a tweet with a link with a 400, so you are never charged by surprise. "allow" posts it at 20 credits a tweet (X charges more for posts with links).',
};

const schemas = {
  Error: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', description: 'A stable code, e.g. quota_exceeded, channel_not_found, invalid_thread.', example: 'quota_exceeded' },
      message: { description: 'What went wrong, for a person.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      channel_id: { type: 'string' },
      post_id: { type: 'string' },
      media_id: { type: 'string' },
    },
  },
  ConnectLink: {
    type: 'object',
    required: ['provider', 'url', 'expires_in'],
    properties: {
      provider: { type: 'string', example: 'linkedin' },
      url: {
        type: 'string',
        format: 'uri',
        description:
          'Open this in a browser and sign in to your own account. Treat it like a password: anyone who opens it within the hour connects their account to your workspace.',
      },
      expires_in: { type: 'integer', example: 3600 },
    },
  },
  Channel: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      provider: { type: 'string', example: 'x' },
      name: { type: 'string' },
      picture: { type: ['string', 'null'] },
      profile: { type: ['string', 'null'] },
      disabled: { type: 'boolean' },
      needs_reconnect: { type: 'boolean', description: 'The network refused the token; connect again with ?reconnect=<id>.' },
      pending_page_pick: { type: 'boolean', description: 'Login done but no page or account picked yet.' },
    },
  },
  ChannelList: {
    type: 'object',
    properties: {
      channels: { type: 'array', items: ref('Channel') },
      included: { type: 'integer', description: 'Channels your plan includes.' },
    },
  },
  Deleted: {
    type: 'object',
    properties: { deleted: { type: 'boolean', example: true }, id: { type: 'string' } },
  },
  Media: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      bytes: { type: 'integer' },
      type: { type: 'string', enum: ['image', 'video'] },
    },
  },
  MediaUpload: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description: 'JPEG, PNG, GIF or WebP up to 10 MB, or MP4 up to 200 MB (files over 95 MB: use /media/from-url).',
      },
    },
  },
  MediaFromUrl: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', format: 'uri', description: 'A public http(s) URL of the image or video.' } },
  },
  AcceptedPost: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Use it with GET and DELETE.' },
      channel_id: { type: 'string' },
      provider: { type: 'string' },
      status: { type: 'string', enum: ['scheduled', 'queued', 'draft'] },
      publish_at: { type: 'string', format: 'date-time' },
      credits: { type: 'integer' },
    },
  },
  Accepted: {
    type: 'object',
    properties: {
      posts: { type: 'array', items: ref('AcceptedPost') },
      credits_charged: { type: 'integer' },
    },
  },
  PostItemStatus: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['scheduled', 'published', 'error', 'draft'] },
      url: { type: ['string', 'null'], description: 'The live post, once published.' },
      error: { type: ['string', 'null'] },
    },
  },
  PostStatus: {
    allOf: [
      ref('PostItemStatus'),
      {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          provider: { type: ['string', 'null'] },
          publish_at: { type: 'string', format: 'date-time' },
          replies: { type: 'array', items: ref('PostItemStatus'), description: 'Thread replies, in order.' },
        },
      },
    ],
  },
  Usage: {
    type: 'object',
    properties: {
      product: { type: 'string' },
      plan: { type: 'string' },
      plan_name: { type: 'string' },
      window_start: { type: 'string', format: 'date-time' },
      window_end: { type: 'string', format: 'date-time' },
      credits_included: { type: 'integer' },
      credits_used: { type: 'integer' },
      channels_included: { type: 'integer' },
      channels_used: { type: 'integer' },
      storage_included_bytes: { type: 'integer' },
      storage_used_bytes: { type: 'integer' },
      schedule_horizon_days: { type: 'integer' },
      x_included: { type: 'boolean' },
      x_links_included: { type: 'boolean' },
      thread_cap: { type: 'integer' },
      note: { type: 'string' },
    },
  },
  TweetCheck: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      chars: { type: 'integer', description: 'X weighted characters.' },
      limit: { type: 'integer', description: '280, or 4,000 on X Premium.' },
      has_link: { type: 'boolean' },
      link_stripped: { type: 'boolean' },
      credits: { type: 'integer' },
      errors: { type: 'array', items: { type: 'string' } },
    },
  },
};

const pick = (...names) => Object.fromEntries(names.map((n) => [n, schemas[n]]));

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

const channelsOps = (tag) => ({
  '/channels': {
    get: {
      tags: [tag],
      operationId: 'listChannels',
      summary: 'List connected channels',
      description: 'Your workspace\'s connected accounts. 0 credits.',
      responses: { 200: ok('The channels.', ref('ChannelList')), ...errors(429) },
    },
  },
  '/channels/{id}': {
    delete: {
      tags: [tag],
      operationId: 'deleteChannel',
      summary: 'Disconnect a channel',
      description: 'Removes the channel and its posts that have not published. Frees a channel slot. 0 credits.',
      parameters: [pathParam('id', 'Channel id from GET /channels.')],
      responses: { 200: ok('Removed.', ref('Deleted')), ...errors(404, 429) },
    },
  },
});

const mediaOps = (tag) => ({
  '/media': {
    post: {
      tags: [tag],
      operationId: 'uploadMedia',
      summary: 'Upload an image or video',
      description: 'Stores a file in your workspace for posts (media_ids). 0 credits; counts toward your plan\'s storage. Media is removed 45 days after upload.',
      requestBody: { required: true, content: { 'multipart/form-data': { schema: ref('MediaUpload') } } },
      responses: { 200: ok('Stored.', ref('Media')), ...errors(400, 402, 429), 413: error('File too large.') },
    },
  },
  '/media/from-url': {
    post: {
      tags: [tag],
      operationId: 'uploadMediaFromUrl',
      summary: 'Upload media from a URL',
      description: 'Fetches a public image or video into your workspace. 0 credits; counts toward storage.',
      requestBody: { required: true, content: json(ref('MediaFromUrl'), { url: 'https://example.com/photo.jpg' }) },
      responses: { 200: ok('Stored.', ref('Media')), ...errors(400, 402, 429), 413: error('File too large.') },
    },
  },
});

const usageOp = (tag) => ({
  '/usage': {
    get: {
      tags: [tag],
      operationId: 'getUsage',
      summary: 'Credits, channels and storage used',
      description: 'Our own counters for the current 28-day window, which starts at your first call and need not match api.market\'s month. api.market\'s dashboard is the billing record. 0 credits.',
      responses: { 200: ok('Usage.', ref('Usage')), ...errors(429) },
    },
  },
});

const connectOp = (tag, provider) => ({
  get: {
    tags: [tag],
    operationId: provider ? 'getConnectLink' : 'getConnectLinkForProvider',
    summary: provider ? `Get a link to connect your ${provider} account` : 'Get a link to connect an account',
    description:
      'Returns a sign-in link for your own account on the network. Open it in a browser; when it says "connected", the channel is in GET /channels. The link works once, for an hour, and acts like a password. 0 credits.',
    parameters: [
      ...(provider ? [] : [pathParam('provider', 'A network from GET /providers, e.g. linkedin, x, threads.')]),
      queryParam('reconnect', 'A channel id: connect that channel again (after needs_reconnect).'),
    ],
    responses: { 200: ok('The link.', ref('ConnectLink')), ...errors(400, 402, 404, 429), 502: error('The network did not answer.') },
  },
});

const postOps = (tag, noun = 'post', prefix = '/posts') => ({
  [`${prefix}/{id}`]: {
    get: {
      tags: [tag],
      operationId: `get${noun[0].toUpperCase()}${noun.slice(1)}`,
      summary: `Status of a ${noun}`,
      description: `scheduled, published (with its URL) or error (with the reason)${noun === 'thread' ? ', for every tweet' : ''}. 0 credits.`,
      parameters: [pathParam('id', `The id from the ${noun} you created.`)],
      responses: { 200: ok('The status.', ref('PostStatus')), ...errors(404, 429) },
    },
    delete: {
      tags: [tag],
      operationId: `delete${noun[0].toUpperCase()}${noun.slice(1)}`,
      summary: `Cancel a ${noun} before it publishes`,
      description: 'Cancels it on its channel. Credits are not returned once a post is accepted. A published post can only be deleted on the network. 0 credits.',
      parameters: [pathParam('id', `The id from the ${noun} you created.`)],
      responses: { 200: ok('Cancelled.', ref('Deleted')), ...errors(404, 409, 429) },
    },
  },
});

const spec = ({ file, product, title, description, tags, paths, schemaNames, extraSchemas = {} }) => ({
  file,
  doc: {
    openapi: '3.1.0',
    info: { title, version: '1.0.0', description, contact: CONTACT },
    servers: [{ url: `${ORIGIN}/${product}` }],
    tags,
    paths,
    components: { schemas: { ...pick(...schemaNames), ...extraSchemas } },
  },
});

// ---------------------------------------------------------------------------
// 1. Social Scheduler
// ---------------------------------------------------------------------------

const SOCIAL = 'Social Scheduler';
const social = spec({
  file: 'social-scheduler.openapi.json',
  product: 'social',
  title: 'Hookpost Social Scheduler API',
  description: [
    'Schedule one post to many social networks in one call: LinkedIn, X, Threads, Facebook, Instagram, YouTube, Pinterest, Discord and Slack.',
    'Connect each account with a sign-in link (GET /connect/{provider}); upload media; create posts and threads; read their status.',
    '',
    'Credits: 1 per channel a post goes to; on X, 2 per tweet, or 20 per tweet that has a link (X charges more for those; links are refused unless link_policy is "allow"). Everything else costs 0. Each response reports what it used in X-Magicapi-Billing.',
    'The 7-day trial: 10 credits, 1 channel, no X. Paid plans include X.',
  ].join('\n'),
  tags: [{ name: SOCIAL }],
  paths: {
    '/providers': {
      get: {
        tags: [SOCIAL],
        operationId: 'listProviders',
        summary: 'Networks, limits and settings',
        description: 'Every network this API posts to, with its character limit, media rules, credits and the settings it takes. Needs no connected account. 0 credits.',
        responses: {
          200: ok('The networks.', {
            type: 'object',
            properties: {
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    identifier: { type: 'string' },
                    name: { type: 'string' },
                    max_chars: { type: 'integer' },
                    counting: { type: 'string' },
                    media: { type: ['object', 'null'] },
                    connect: { type: 'boolean' },
                    picks_page_after_login: { type: 'boolean' },
                    credits: { type: 'object' },
                    included_in_plan: { type: 'boolean' },
                    settings: { type: ['object', 'null'], description: 'JSON Schema of the network\'s settings (channels[].settings).' },
                  },
                },
              },
            },
          }),
          ...errors(429),
        },
      },
    },
    '/connect/{provider}': connectOp(SOCIAL),
    ...channelsOps(SOCIAL),
    ...mediaOps(SOCIAL),
    '/posts': {
      get: {
        tags: [SOCIAL],
        operationId: 'listPosts',
        summary: 'List posts in a time range',
        description: 'Posts publishing between from and to (at most 92 days; default: the last 7 and next 35 days). 0 credits.',
        parameters: [
          queryParam('from', 'ISO 8601 start.', { type: 'string', format: 'date-time' }),
          queryParam('to', 'ISO 8601 end.', { type: 'string', format: 'date-time' }),
        ],
        responses: {
          200: ok('The posts.', {
            type: 'object',
            properties: {
              posts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    channel_id: { type: ['string', 'null'] },
                    provider: { type: ['string', 'null'] },
                    status: { type: 'string' },
                    publish_at: { type: 'string', format: 'date-time' },
                    url: { type: ['string', 'null'] },
                  },
                },
              },
            },
          }),
          ...errors(400, 429),
        },
      },
      post: {
        tags: [SOCIAL],
        operationId: 'createPost',
        summary: 'Schedule a post on one or more channels',
        description:
          'The same content goes to every channel; content[0] is the post and content[1..] its thread replies (X tweets, Threads replies). Credits: 1 per channel, X 2 per tweet or 20 per tweet with a link. Held when accepted and not returned on cancel.',
        requestBody: { required: true, content: json(ref('SocialPost'), {
          channels: [{ id: 'clx123channel' }, { id: 'clx456channel', settings: { who_can_reply_post: 'everyone' } }],
          content: [{ text: 'We shipped a new release today.', media_ids: [] }],
          schedule_at: '2026-11-02T09:30:00Z',
        }) },
        responses: { 200: ok('Accepted.', ref('Accepted')), ...errors(400, 402, 404, 409, 429, 503) },
      },
    },
    '/posts/validate': {
      post: {
        tags: [SOCIAL],
        operationId: 'validatePost',
        summary: 'Check and price a post without saving it',
        description: 'Runs every check POST /posts runs and returns the credits it would cost. Saves nothing. 0 credits.',
        requestBody: { required: true, content: json(ref('SocialPost')) },
        responses: {
          200: ok('Valid; what it would cost.', {
            type: 'object',
            properties: {
              valid: { type: 'boolean' },
              credits: { type: 'integer' },
              channels: { type: 'array', items: { type: 'object' } },
            },
          }),
          ...errors(400, 402, 404, 429),
        },
      },
    },
    ...postOps(SOCIAL),
    '/slots/{channel_id}': {
      get: {
        tags: [SOCIAL],
        operationId: 'findSlot',
        summary: 'Next open time slot of a channel',
        description: 'The next of the channel\'s posting times that has no post yet. 0 credits.',
        parameters: [pathParam('channel_id', 'Channel id.')],
        responses: {
          200: ok('The slot.', { type: 'object', properties: { channel_id: { type: 'string' }, date: { type: 'string', format: 'date-time' } } }),
          ...errors(404, 429),
        },
      },
    },
    '/notifications': {
      get: {
        tags: [SOCIAL],
        operationId: 'listNotifications',
        summary: 'Workspace notifications',
        description: 'Publishing errors and notices of your workspace, newest first, 100 a page. 0 credits.',
        parameters: [queryParam('page', 'Page, from 0.', { type: 'integer', minimum: 0 })],
        responses: {
          200: ok('The notifications.', {
            type: 'object',
            properties: {
              notifications: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } },
              },
              has_more: { type: 'boolean' },
            },
          }),
          ...errors(429),
        },
      },
    },
    ...usageOp(SOCIAL),
  },
  schemaNames: [
    'Error', 'ConnectLink', 'Channel', 'ChannelList', 'Deleted', 'Media', 'MediaUpload', 'MediaFromUrl',
    'AcceptedPost', 'Accepted', 'PostItemStatus', 'PostStatus', 'Usage',
  ],
  extraSchemas: {
    SocialPost: {
      type: 'object',
      required: ['channels', 'content', 'schedule_at'],
      properties: {
        channels: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'Channel id from GET /channels.' },
              settings: { type: 'object', description: 'The network\'s settings (GET /providers lists each one\'s schema), e.g. Pinterest board, YouTube title. Discord: channel is the id of a channel in the server you connected; any other is refused (400 channel_not_in_server).' },
            },
          },
        },
        content: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string', description: 'Plain text, posted as typed.' },
              media_ids: { type: 'array', maxItems: 20, items: { type: 'string' } },
            },
          },
        },
        schedule_at: SCHEDULE_AT,
        link_policy: LINK_POLICY,
      },
    },
  },
});

// ---------------------------------------------------------------------------
// 2. LinkedIn Carousel & Post
// ---------------------------------------------------------------------------

const LI = 'LinkedIn';
const linkedin = spec({
  file: 'linkedin-carousel.openapi.json',
  product: 'linkedin',
  title: 'LinkedIn Carousel & Post API',
  description: [
    'Turn 2 to 20 images into a LinkedIn-ready PDF carousel, and publish carousels, posts with an image or video, and text posts to LinkedIn personal profiles.',
    'POST /carousels/render needs no connected account. Posting needs your LinkedIn profile connected once (GET /connect). Company Pages are not supported yet.',
    '',
    'Credits: 1 per render, 1 per carousel or post. Everything else costs 0. Each response reports what it used in X-Magicapi-Billing.',
  ].join('\n'),
  tags: [{ name: LI }],
  paths: {
    '/carousels/render': {
      post: {
        tags: [LI],
        operationId: 'renderCarousel',
        summary: 'Render images as a LinkedIn carousel PDF',
        description: 'One page per image, in order, fitted on white. Square 1080x1080 or portrait 1080x1350 (default). Needs no connected account. The PDF link works for 7 days. 1 credit.',
        requestBody: { required: true, content: json(ref('CarouselRender'), {
          images: ['https://example.com/slide-1.png', 'https://example.com/slide-2.png'],
          title: 'Five lessons from our launch',
          size: 'portrait',
        }) },
        responses: {
          200: ok('The PDF.', {
            type: 'object',
            properties: {
              id: { type: 'string' },
              pdf_url: { type: 'string', format: 'uri' },
              pages: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              bytes: { type: 'integer' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          }),
          ...errors(400, 402, 404, 429),
          413: error('Over 50 MB of images.'),
        },
      },
    },
    '/carousels': {
      post: {
        tags: [LI],
        operationId: 'createCarousel',
        summary: 'Publish a document carousel',
        description: 'Posts the images as a LinkedIn document carousel with your text, now or scheduled. 1 credit.',
        requestBody: { required: true, content: json(ref('LinkedInCarousel'), {
          channel_id: 'clx123channel',
          title: 'Five lessons from our launch',
          images: ['https://example.com/slide-1.png', 'https://example.com/slide-2.png'],
          text: 'What we learned shipping in public.',
          schedule_at: 'now',
        }) },
        responses: { 200: ok('Accepted.', ref('Accepted')), ...errors(400, 402, 404, 409, 429) },
      },
    },
    '/posts': {
      post: {
        tags: [LI],
        operationId: 'createLinkedInPost',
        summary: 'Publish a post',
        description: 'Text, with images or one video from POST /media. 1 credit.',
        requestBody: { required: true, content: json(ref('LinkedInPost'), {
          channel_id: 'clx123channel',
          text: 'Hiring two engineers this month.',
          schedule_at: '2026-11-02T09:30:00Z',
        }) },
        responses: { 200: ok('Accepted.', ref('Accepted')), ...errors(400, 402, 404, 409, 429) },
      },
    },
    ...postOps(LI),
    '/connect': connectOp(LI, 'LinkedIn'),
    ...channelsOps(LI),
    ...mediaOps(LI),
    ...usageOp(LI),
  },
  schemaNames: [
    'Error', 'ConnectLink', 'Channel', 'ChannelList', 'Deleted', 'Media', 'MediaUpload', 'MediaFromUrl',
    'AcceptedPost', 'Accepted', 'PostItemStatus', 'PostStatus', 'Usage',
  ],
  extraSchemas: {
    CarouselRender: {
      type: 'object',
      required: ['images'],
      properties: {
        images: {
          type: 'array',
          minItems: 2,
          maxItems: 20,
          items: { type: 'string' },
          description: 'Image URLs (public http(s)) or media ids from POST /media, in page order. JPEG, PNG, GIF or WebP, 50 MB in all.',
        },
        title: { type: 'string', maxLength: 100 },
        size: { type: 'string', enum: ['square', 'portrait'], default: 'portrait' },
      },
    },
    LinkedInCarousel: {
      type: 'object',
      required: ['channel_id', 'title', 'images', 'text', 'schedule_at'],
      properties: {
        channel_id: { type: 'string' },
        title: { type: 'string', maxLength: 100, description: 'The document title LinkedIn shows.' },
        images: { type: 'array', minItems: 2, maxItems: 20, items: { type: 'string' }, description: 'Image URLs or media ids, in page order.' },
        text: { type: 'string', maxLength: 3000 },
        schedule_at: SCHEDULE_AT,
      },
    },
    LinkedInPost: {
      type: 'object',
      required: ['channel_id', 'text', 'schedule_at'],
      properties: {
        channel_id: { type: 'string' },
        text: { type: 'string', maxLength: 3000 },
        media_ids: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Images, or one video.' },
        schedule_at: SCHEDULE_AT,
      },
    },
  },
});

// ---------------------------------------------------------------------------
// 3. X Threads
// ---------------------------------------------------------------------------

const X = 'X Threads';
const xThreads = spec({
  file: 'x-threads.openapi.json',
  product: 'x',
  title: 'X Thread API',
  description: [
    'Schedule X threads as an array of tweets, with a cost estimate before anything is sent.',
    'POST /threads/estimate needs no connected account: it counts each tweet the way X does (280 characters, 4,000 on X Premium), flags links and media problems, and prices the thread.',
    '',
    'Credits: 2 per tweet; 20 per tweet that has a link (X charges more for those). Links are refused unless link_policy is "allow". Trials take threads of up to 5 tweets and no links. Everything else costs 0. Each response reports what it used in X-Magicapi-Billing.',
  ].join('\n'),
  tags: [{ name: X }],
  paths: {
    '/threads/estimate': {
      post: {
        tags: [X],
        operationId: 'estimateThread',
        summary: 'Check and price a thread',
        description: 'Needs no connected account. 0 credits.',
        requestBody: { required: true, content: json(ref('ThreadEstimate'), {
          tweets: [{ text: 'Thread: how we cut our build time in half 🧵' }, { text: 'Step 1: cache the dependencies.', media_count: 1 }],
        }) },
        responses: {
          200: ok('The check.', {
            type: 'object',
            properties: {
              valid: { type: 'boolean' },
              credits: { type: 'integer' },
              errors: { type: 'array', items: { type: 'string' } },
              tweets: { type: 'array', items: ref('TweetCheck') },
              thread_cap: { type: 'integer' },
              links_included: { type: 'boolean' },
            },
          }),
          ...errors(400, 429),
        },
      },
    },
    '/threads': {
      post: {
        tags: [X],
        operationId: 'createThread',
        summary: 'Schedule a thread',
        description: 'Credits: the sum over tweets (2, or 20 with a link). Up to 50 tweets a day per X account.',
        requestBody: { required: true, content: json(ref('Thread'), {
          channel_id: 'clx123channel',
          tweets: [{ text: 'Thread: how we cut our build time in half 🧵' }, { text: 'Step 1: cache the dependencies.' }],
          schedule_at: '2026-11-02T09:30:00Z',
          who_can_reply: 'everyone',
        }) },
        responses: { 200: ok('Accepted.', ref('Accepted')), ...errors(400, 402, 404, 409, 429, 503) },
      },
    },
    ...postOps(X, 'thread', '/threads'),
    '/connect': connectOp(X, 'X'),
    ...channelsOps(X),
    ...mediaOps(X),
    ...usageOp(X),
  },
  schemaNames: [
    'Error', 'ConnectLink', 'Channel', 'ChannelList', 'Deleted', 'Media', 'MediaUpload', 'MediaFromUrl',
    'AcceptedPost', 'Accepted', 'PostItemStatus', 'PostStatus', 'Usage', 'TweetCheck',
  ],
  extraSchemas: {
    ThreadEstimate: {
      type: 'object',
      required: ['tweets'],
      properties: {
        tweets: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string' },
              media_count: { type: 'integer', minimum: 0, maximum: 10 },
              media_type: { type: 'string', enum: ['image', 'video'] },
            },
          },
        },
        premium: { type: 'boolean', description: 'The account is X Premium (4,000 characters).' },
        link_policy: LINK_POLICY,
      },
    },
    Thread: {
      type: 'object',
      required: ['channel_id', 'tweets', 'schedule_at'],
      properties: {
        channel_id: { type: 'string' },
        tweets: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string' },
              media_ids: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'Up to 4 images, or one video.' },
            },
          },
        },
        schedule_at: SCHEDULE_AT,
        who_can_reply: { type: 'string', enum: ['everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'], default: 'everyone' },
        link_policy: LINK_POLICY,
      },
    },
  },
});

// ---------------------------------------------------------------------------
// 4. Post Validator
// ---------------------------------------------------------------------------

const V = 'Validator';
const validator = spec({
  file: 'post-validator.openapi.json',
  product: 'validate',
  title: 'Social Post Validator API',
  description: [
    'Check a draft against each social network\'s rules before you post it: character limits counted the way each network counts them, media counts and types, and upload sizes.',
    'Nothing to connect, nothing is posted, no network is called.',
    '',
    'Credits: 1 per check (any number of networks). GET /rules costs 0. Each response reports what it used in X-Magicapi-Billing.',
  ].join('\n'),
  tags: [{ name: V }],
  paths: {
    '/check': {
      post: {
        tags: [V],
        operationId: 'checkDraft',
        summary: 'Check a draft for several networks',
        description: '1 credit.',
        requestBody: { required: true, content: json(ref('ValidatorCheck'), {
          text: 'Our spring collection is live.',
          media: [{ type: 'image', bytes: 820000, width: 1080, height: 1350 }],
          platforms: ['x', 'instagram', 'linkedin'],
        }) },
        responses: {
          200: ok('Pass or fail per network.', {
            type: 'object',
            properties: {
              valid: { type: 'boolean', description: 'True when every network passed.' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    platform: { type: 'string' },
                    valid: { type: 'boolean' },
                    chars: { type: 'integer' },
                    limit: { type: 'integer' },
                    errors: { type: 'array', items: { type: 'string' } },
                    warnings: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          }),
          ...errors(400, 402, 429),
        },
      },
    },
    '/rules': {
      get: {
        tags: [V],
        operationId: 'listRules',
        summary: 'The rules checked, per network',
        description: '0 credits.',
        responses: {
          200: ok('The rules.', { type: 'object', properties: { platforms: { type: 'array', items: { type: 'object' } } } }),
          ...errors(429),
        },
      },
    },
    ...usageOp(V),
  },
  schemaNames: ['Error', 'Usage'],
  extraSchemas: {
    ValidatorCheck: {
      type: 'object',
      required: ['text', 'platforms'],
      properties: {
        text: { type: 'string' },
        media: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['image', 'video'] },
              bytes: { type: 'integer', minimum: 0 },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
              duration_s: { type: 'number', minimum: 0 },
              has_cover: { type: 'boolean', description: 'A video with a cover image set on it (Pinterest).' },
            },
          },
        },
        platforms: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: ['x', 'linkedin', 'threads', 'facebook', 'instagram', 'youtube', 'pinterest', 'discord', 'slack', 'bluesky', 'mastodon'] },
        },
        x_premium: { type: 'boolean', description: 'Count X at 4,000 characters.' },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Probe (a private plan's own Source, before launch)
// ---------------------------------------------------------------------------

const probe = {
  file: 'probe.openapi.json',
  doc: {
    openapi: '3.1.0',
    info: {
      title: 'Hookpost gateway probe (private)',
      version: '1.0.0',
      description: 'For the seller only, on a private plan: reports which headers api.market forwards, as names, flags and hash prefixes. Import it as its own Source with the base URL of the product being checked.',
      contact: CONTACT,
    },
    servers: [{ url: `${ORIGIN}/social` }],
    paths: {
      '/_probe': {
        get: {
          operationId: 'probeGet',
          summary: 'What the gateway forwards',
          parameters: [
            queryParam('status', '201 to answer 201 (is a 201 billed?).', { type: 'integer', enum: [200, 201] }),
            queryParam('bill', 'Credits to report in X-Magicapi-Billing.', { type: 'integer', minimum: 0, maximum: 1000 }),
          ],
          responses: { 200: ok('The report.', { type: 'object' }), 201: ok('The report, as a 201.', { type: 'object' }) },
        },
        post: {
          operationId: 'probePost',
          summary: 'What the gateway forwards (POST)',
          parameters: [
            queryParam('status', '201 to answer 201.', { type: 'integer', enum: [200, 201] }),
            queryParam('bill', 'Credits to report in X-Magicapi-Billing.', { type: 'integer', minimum: 0, maximum: 1000 }),
          ],
          responses: { 200: ok('The report.', { type: 'object' }), 201: ok('The report, as a 201.', { type: 'object' }) },
        },
      },
    },
  },
};

mkdirSync(OUT, { recursive: true });
for (const { file, doc } of [social, linkedin, xThreads, validator, probe]) {
  writeFileSync(join(OUT, file), JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote docs/marketplace/${file} (${Object.keys(doc.paths).length} paths)`);
}
