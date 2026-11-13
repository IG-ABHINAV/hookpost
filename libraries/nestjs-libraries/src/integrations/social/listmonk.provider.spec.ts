import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ListmonkProvider,
  listmonkMediaHtml,
  normalizeListmonkUrl,
} from '@hookpost/nestjs-libraries/integrations/social/listmonk.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { ListmonkDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/listmonk.dto';

type Reply = {
  status?: number;
  body?: any;
  text?: string;
  redirectedTo?: string;
};

const BASE = 'https://lists.example.com';
const CREDS = { url: BASE, username: 'hookpost', password: 'tok_123' };
const BASIC =
  'Basic ' + Buffer.from('hookpost:tok_123').toString('base64');

// A scripted Listmonk: each request is matched by "METHOD /path" (query
// string dropped) and answered from `replies`. Nothing leaves the process.
const setup = (replies: Record<string, Reply | Reply[] | Error>) => {
  const calls: { key: string; url: string; init: any; body: any }[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const parsed = new URL(url);
    const key = `${init.method || 'GET'} ${parsed.pathname}`;
    let body: any = init.body;
    if (typeof body === 'string' && body.startsWith('{')) {
      body = JSON.parse(body);
    }
    calls.push({ key, url, init, body });
    const reply = replies[key];
    if (reply instanceof Error) {
      throw reply;
    }
    const next = Array.isArray(reply) ? reply.shift() : reply;
    if (!next) {
      throw new Error(`unexpected request ${key}`);
    }
    const status = next.status ?? 200;
    const text =
      next.text !== undefined ? next.text : JSON.stringify(next.body ?? {});
    return {
      status,
      ok: status >= 200 && status < 300,
      redirected: !!next.redirectedTo,
      url: next.redirectedTo || url,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });

  return {
    provider: new ListmonkProvider(),
    calls,
    restore: () => ((global as any).fetch = original),
  };
};

const code = (fields: Record<string, string>) =>
  Buffer.from(JSON.stringify(fields)).toString('base64');

const integration = (fields: Record<string, string> = CREDS): any => ({
  id: 'i1',
  customInstanceDetails: AuthService.fixedEncryption(JSON.stringify(fields)),
});

const post = (overrides: any = {}): any => ({
  id: 'p1',
  message: '<p>Hello subscribers</p>',
  settings: {
    subject: 'October update',
    preview: 'What shipped this month',
    list: '3',
    template: '0',
    ...(overrides.settings || {}),
  },
  media: overrides.media || [],
});

const CAMPAIGN = { data: { id: 42, uuid: 'c-uuid-42', status: 'draft' } };
const RUNNING = { data: { id: 42, status: 'running' } };

describe('ListmonkProvider', () => {
  let restore: () => void = () => undefined;
  const secret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'listmonk-spec-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = secret;
  });

  afterEach(() => restore());

  describe('connect', () => {
    it('connects with an API user and names the channel after the site', async () => {
      const t = setup({
        'GET /api/settings': {
          body: {
            data: {
              'app.site_name': 'Acme Weekly',
              'app.logo_url': '/uploads/logo.png',
            },
          },
        },
      });
      restore = t.restore;
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      const auth: any = await t.provider.authenticate({
        code: code(CREDS),
        codeVerifier: '',
      });

      expect(t.calls).toHaveLength(1);
      expect(t.calls[0].url).toBe(`${BASE}/api/settings`);
      expect(t.calls[0].init.headers.Authorization).toBe(BASIC);
      expect(auth).toMatchObject({
        id: Buffer.from(BASE).toString('base64'),
        name: 'Acme Weekly',
        username: 'Acme Weekly',
        picture: `${BASE}/uploads/logo.png`,
      });
      // The token columns are stored in the clear: never the credentials.
      expect(auth.accessToken).toMatch(/^listmonk-\w{24}$/);
      expect(auth.accessToken).not.toContain(
        Buffer.from('hookpost:tok_123').toString('base64')
      );
      // The old code logged the decoded body, password included.
      expect(JSON.stringify(log.mock.calls)).not.toContain('tok_123');
      log.mockRestore();
    });

    it('accepts the address bar URL (trailing slash or /admin) and stores one channel id', async () => {
      for (const url of [`${BASE}/`, `${BASE}/admin/campaigns`, `${BASE}/api`]) {
        const t = setup({
          'GET /api/settings': { body: { data: { 'app.site_name': 'A' } } },
        });
        const auth: any = await t.provider.authenticate({
          code: code({ ...CREDS, url }),
          codeVerifier: '',
        });
        t.restore();
        expect(t.calls[0].url).toBe(`${BASE}/api/settings`);
        expect(auth.id).toBe(Buffer.from(BASE).toString('base64'));
      }
      expect(normalizeListmonkUrl(' https://x.io/newsletter/admin/ ')).toBe(
        'https://x.io/newsletter'
      );
      expect(normalizeListmonkUrl('https://admin.example.com')).toBe(
        'https://admin.example.com'
      );
    });

    it('explains that a login password is not an API token', async () => {
      // Exactly what demo.listmonk.app answered to a bad token on 2026-10-20.
      const t = setup({
        'GET /api/settings': {
          status: 403,
          body: { message: 'invalid API credentials' },
        },
      });
      restore = t.restore;

      const auth = await t.provider.authenticate({
        code: code(CREDS),
        codeVerifier: '',
      });

      expect(typeof auth).toBe('string');
      expect(auth).toContain('API username and token');
      expect(auth).toContain('login password does not work');
    });

    it('still connects an API user that may not read settings', async () => {
      const t = setup({
        'GET /api/settings': {
          status: 403,
          body: { message: 'permission denied: settings:get' },
        },
        'GET /api/lists': { body: { data: { results: [{ id: 3, name: 'News' }] } } },
      });
      restore = t.restore;

      const auth: any = await t.provider.authenticate({
        code: code(CREDS),
        codeVerifier: '',
      });

      expect(t.calls.map((c) => c.key)).toEqual([
        'GET /api/settings',
        'GET /api/lists',
      ]);
      expect(auth).toMatchObject({ name: 'lists.example.com', picture: '' });
    });

    it('says when the URL is not a Listmonk install', async () => {
      const t = setup({
        'GET /api/settings': { status: 200, text: '<!doctype html><html></html>' },
      });
      restore = t.restore;
      await expect(
        t.provider.authenticate({ code: code(CREDS), codeVerifier: '' })
      ).resolves.toContain('No Listmonk API found at https://lists.example.com');
    });

    it('says when the host cannot be reached, instead of "invalid credentials"', async () => {
      const t = setup({
        'GET /api/settings': Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' },
        }),
      });
      restore = t.restore;
      await expect(
        t.provider.authenticate({ code: code(CREDS), codeVerifier: '' })
      ).resolves.toContain('Could not reach https://lists.example.com');
    });

    it('refuses private IP addresses, which the DNS-lookup guard never sees', async () => {
      const t = setup({});
      restore = t.restore;
      for (const url of [
        'http://127.0.0.1:3000',
        'http://169.254.169.254',
        'http://10.0.0.5:9000',
        'http://[::1]:9000',
      ]) {
        await expect(
          t.provider.authenticate({ code: code({ ...CREDS, url }), codeVerifier: '' })
        ).resolves.toContain('private network address');
      }
      expect(t.calls).toHaveLength(0);
    });

    it('asks for the https address when http redirects', async () => {
      const t = setup({
        'GET /api/settings': {
          body: { data: {} },
          redirectedTo: `${BASE}/api/settings`,
        },
      });
      restore = t.restore;
      await expect(
        t.provider.authenticate({
          code: code({ ...CREDS, url: 'http://lists.example.com' }),
          codeVerifier: '',
        })
      ).resolves.toBe(
        `http://lists.example.com redirects to ${BASE}. Connect with ${BASE} instead.`
      );
    });

    it('labels the fields as an API user and token', async () => {
      const fields = await new ListmonkProvider().customFields();
      expect(fields.map((f) => [f.key, f.label])).toEqual([
        ['url', 'Listmonk URL'],
        ['username', 'API username'],
        ['password', 'API token'],
      ]);
      const [url] = fields;
      const parts = url.validation.split('/');
      const regex = new RegExp(parts.slice(1, -1).join('/'), parts.pop());
      expect(regex.test('Https://Lists.Example.com/')).toBe(true);
    });
  });

  describe('composer lookups', () => {
    it('loads every list, not just the first page of 20', async () => {
      const t = setup({
        'GET /api/lists': {
          body: {
            data: {
              results: Array.from({ length: 25 }, (_, i) => ({
                id: i + 1,
                name: `L${i + 1}`,
              })),
            },
          },
        },
      });
      restore = t.restore;

      const lists = await t.provider.list('', {}, '', integration());
      expect(t.calls[0].url).toBe(
        `${BASE}/api/lists?minimal=true&per_page=all`
      );
      expect(lists).toHaveLength(25);
    });

    it('returns no lists instead of crashing when there are none', async () => {
      const t = setup({ 'GET /api/lists': { body: { data: [] } } });
      restore = t.restore;
      await expect(t.provider.list('', {}, '', integration())).resolves.toEqual(
        []
      );
    });

    it('offers campaign templates only', async () => {
      const t = setup({
        'GET /api/templates': {
          body: {
            data: [
              { id: 1, name: 'Default campaign template', type: 'campaign' },
              { id: 2, name: 'Default archive template', type: 'campaign' },
              { id: 3, name: 'Sample transactional template', type: 'tx' },
              { id: 4, name: 'Visual', type: 'campaign_visual' },
            ],
          },
        },
      });
      restore = t.restore;
      const templates = await t.provider.templates('', {}, '', integration());
      expect(templates.map((x: any) => x.id)).toEqual([0, 1, 2]);
    });
  });

  describe('publishing', () => {
    it('sends a text-only post as a running campaign', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': { body: RUNNING },
      });
      restore = t.restore;

      const [res] = await t.provider.post('id', 'tok', [post()], integration());

      expect(t.calls.map((c) => c.key)).toEqual([
        'POST /api/campaigns',
        'PUT /api/campaigns/42/status',
      ]);
      const sent = t.calls[0].body;
      expect(t.calls[0].init.headers.Authorization).toBe(BASIC);
      expect(sent).toMatchObject({
        name: 'october-update',
        type: 'regular',
        content_type: 'html',
        subject: 'October update',
        lists: [3],
      });
      expect(sent).not.toHaveProperty('template_id');
      expect(sent.body).toContain('<p>Hello subscribers</p>');
      expect(sent.body).toContain('What shipped this month');
      expect(sent.body).not.toContain('<img');
      expect(t.calls[1].body).toEqual({ status: 'running' });
      expect(res).toEqual({
        id: 'p1',
        status: 'completed',
        releaseURL: `${BASE}/admin/campaigns/42`,
        postId: 'c-uuid-42',
      });
    });

    it('embeds an attached image in the email instead of dropping it', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': { body: RUNNING },
      });
      restore = t.restore;

      await t.provider.post(
        'id',
        'tok',
        [
          post({
            media: [
              {
                type: 'image',
                path: '/var/uploads/2026/10/a.png',
                url: 'https://media.hookstep.in/2026/10/a.png',
                alt: 'Chart "Q3"',
              },
            ],
            settings: { template: '5' },
          }),
        ],
        integration()
      );

      const sent = t.calls[0].body;
      expect(sent.body).toContain(
        '<img src="https://media.hookstep.in/2026/10/a.png" alt="Chart &quot;Q3&quot;"'
      );
      expect(sent.template_id).toBe(5);
    });

    it('sends a video as a link over its cover, since email cannot play it', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': { body: RUNNING },
      });
      restore = t.restore;

      await t.provider.post(
        'id',
        'tok',
        [
          post({
            media: [
              {
                // updateMedia() labels every item "image"; the extension is
                // what says it is a video.
                type: 'image',
                path: 'https://media.hookstep.in/clip.mp4',
                thumbnail: 'https://media.hookstep.in/clip.jpg',
              },
            ],
          }),
        ],
        integration()
      );

      expect(t.calls[0].body.body).toContain(
        '<a href="https://media.hookstep.in/clip.mp4"><img src="https://media.hookstep.in/clip.jpg"'
      );
      expect(listmonkMediaHtml([{ type: 'video', path: 'https://x/v.mov' }])).toBe(
        '<p><a href="https://x/v.mov">Watch the video</a></p>'
      );
      await expect(
        t.provider.mediaNotices([[{ path: 'https://x/v.mp4' }]])
      ).resolves.toHaveLength(1);
      await expect(
        t.provider.mediaNotices([[{ path: 'https://x/a.png' }]])
      ).resolves.toEqual([]);
    });

    it('names a non-Latin subject instead of sending an empty name', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': { body: RUNNING },
      });
      restore = t.restore;
      await t.provider.post(
        'id',
        'tok',
        [post({ settings: { subject: 'दिवाली ऑफ़र' } })],
        integration()
      );
      expect(t.calls[0].body.name).toBe('दिवाली ऑफ़र');
    });

    it('escapes the preview text it puts in the HTML', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': { body: RUNNING },
      });
      restore = t.restore;
      await t.provider.post(
        'id',
        'tok',
        [post({ settings: { preview: 'Tips & <tricks>' } })],
        integration()
      );
      expect(t.calls[0].body.body).toContain('Tips &amp; &lt;tricks&gt;');
    });

    it('refuses to send without a list, before calling Listmonk', async () => {
      const t = setup({});
      restore = t.restore;
      await expect(
        t.provider.post('id', 'tok', [post({ settings: { list: '' } })], integration())
      ).rejects.toThrow('Pick a Listmonk list');
      expect(t.calls).toHaveLength(0);
    });

    it('asks for a reconnect when the API token was revoked', async () => {
      const t = setup({
        'POST /api/campaigns': {
          status: 403,
          body: { message: 'invalid API credentials' },
        },
      });
      restore = t.restore;
      const err = await t.provider
        .post('id', 'tok', [post()], integration())
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(RefreshToken);
      expect(err.message).toContain('Reconnect the channel');
    });

    it('names the missing permission, and says the draft was not sent', async () => {
      const t = setup({
        'POST /api/campaigns': { body: CAMPAIGN },
        'PUT /api/campaigns/42/status': {
          status: 403,
          body: { message: 'permission denied: campaigns:send' },
        },
      });
      restore = t.restore;
      const err = await t.provider
        .post('id', 'tok', [post()], integration())
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('"campaigns:send" permission');
      expect(err.message).toContain('saved in Listmonk as a draft and was not sent');
    });

    it('explains a rejected list', async () => {
      const t = setup({
        'POST /api/campaigns': {
          status: 400,
          body: { message: 'Invalid list IDs.' },
        },
      });
      restore = t.restore;
      await expect(
        t.provider.post('id', 'tok', [post()], integration())
      ).rejects.toThrow('Listmonk did not accept the list');
    });

    it('never starts "campaign undefined" when the create answer has no id', async () => {
      // What an http:// URL that 301s to https:// produces: the POST is
      // replayed as a GET and the campaign list comes back.
      const t = setup({
        'POST /api/campaigns': { body: { data: { results: [] } } },
      });
      restore = t.restore;
      await expect(
        t.provider.post('id', 'tok', [post()], integration())
      ).rejects.toThrow('did not return a campaign id');
      expect(t.calls).toHaveLength(1);
    });
  });

  describe('settings DTO', () => {
    const errors = async (value: any) =>
      (await validate(plainToInstance(ListmonkDto, value))).map(
        (e) => e.property
      );

    it('lets the preview line be left out', async () => {
      await expect(errors({ subject: 'S', list: '3' })).resolves.toEqual([]);
    });

    it('requires a list', async () => {
      await expect(errors({ subject: 'S', list: '' })).resolves.toEqual([
        'list',
      ]);
    });
  });
});
