import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  BadBody,
  SocialAbstract,
  ValidityMedia,
} from '../social.abstract';
import {
  AuthTokenDetails,
  MediaContent,
  PostDetails,
  PostResponse,
  SocialProvider,
} from './social.integrations.interface';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { ListmonkDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/listmonk.dto';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import slugify from 'slugify';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';
import { getSsrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { isBlockedIp } from '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import net from 'node:net';

type ListmonkInstance = { url: string; username: string; password: string };

// A self-hosted box that accepts the TCP connection and never answers would
// otherwise hold the connect request open until the browser gives up.
const CONNECT_TIMEOUT_MS = 20_000;

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|avi|mkv)(?:[?#]|$)/i;

const INVALID_CREDENTIALS =
  'Listmonk did not accept this API username and token. In Listmonk open Admin → Users, create a user with the type "API", and paste its username and the token Listmonk shows you. Your Listmonk login password does not work here (on Listmonk v3 or older, use the admin username and password).';

const REVOKED_CREDENTIALS =
  'Listmonk no longer accepts this channel’s API username and token (the API user may have been deleted or its token regenerated). Reconnect the channel with a valid Listmonk API user.';

// People paste what is in their address bar: a trailing slash, the /admin
// page, or the /api base. The API always lives at {root}/api, so each of
// those used to turn into "//api/settings" (404 page) or "/admin/api/..."
// (redirect to the login page), and the user was told "Invalid credentials".
export const normalizeListmonkUrl = (raw: string) =>
  (raw || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\/(admin|api)(\/.*)?$/i, '')
    .replace(/\/+$/, '');

const escapeHtml = (value: string) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// updateMedia() hands providers the public URL as `url` next to `path`;
// `path` is a local file path when uploads are stored on disk. An email can
// only show what the reader's mail client can download, so only http(s) URLs
// are usable.
const publicMediaUrl = (media: MediaContent & { url?: string }) =>
  [media.url, media.path].find(
    (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
  );

const isVideo = (path?: string) => !!path && VIDEO_EXTENSION.test(path);

// Attached media used to be dropped without a word: the email went out with
// the text only. Images are embedded inline (that is how newsletters show
// pictures; attachments are not), and a video, which no mail client plays
// inline, becomes a link - over its cover image when there is one.
export const listmonkMediaHtml = (media: MediaContent[] = []) =>
  media
    .map((item) => {
      const url = publicMediaUrl(item);
      if (!url) {
        return '';
      }

      const alt = escapeHtml(item.alt || '');
      if (isVideo(url) || item.type === 'video') {
        const cover =
          item.thumbnail && /^https?:\/\//i.test(item.thumbnail)
            ? item.thumbnail
            : '';
        return cover
          ? `<p><a href="${escapeHtml(url)}"><img src="${escapeHtml(
              cover
            )}" alt="${alt || 'Watch the video'}" style="max-width:100%;height:auto;" /></a></p>`
          : `<p><a href="${escapeHtml(url)}">Watch the video</a></p>`;
      }

      return `<p><img src="${escapeHtml(
        url
      )}" alt="${alt}" style="max-width:100%;height:auto;" /></p>`;
    })
    .filter(Boolean)
    .join('\n');

export const listmonkCampaignBody = (
  message: string,
  preview = '',
  media: MediaContent[] = []
) => `
<style>
.content {
  padding: 20px;
  font-size: 15px;
  line-height: 1.6;
}
</style>
<div class="hidden-preheader"
       style="display:none !important; visibility:hidden; opacity:0; overflow:hidden;
              max-height:0; max-width:0; line-height:1px; font-size:1px; color:transparent;
              mso-hide:all;">
    <!-- A short visible decoy (optional): shows as "." or short text in preview -->
    ${escapeHtml(preview || '')}
    <!-- Then invisible padding to eat up preview characters -->
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    <!-- Repeat the trio (zero-width space, zero-width non-joiner, nbsp, BOM) a bunch of times -->
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
    &#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;&#8203;&zwnj;&nbsp;&#65279;
  </div>

  <div class="content">
    ${message}
    ${listmonkMediaHtml(media)}
  </div>
`;

export class ListmonkProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 100; // Bluesky has moderate rate limits
  identifier = 'listmonk';
  name = 'ListMonk';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'html' as const;
  dto = ListmonkDto;

  maxLength() {
    return 100000000;
  }

  // The connect form used to ask for "Username" and "Password". Since
  // Listmonk v4 the API only accepts an API user and its token (a normal
  // user's login password is rejected with "invalid API credentials"), so
  // users typing their login could never connect. The keys stay the same so
  // stored channels keep working.
  async customFields() {
    return [
      {
        key: 'url',
        label: 'Listmonk URL',
        defaultValue: '',
        hint: 'The address of your Listmonk install, for example https://lists.example.com',
        validation: `/^(https?:\\/\\/)(?:\\S+(?::\\S*)?@)?(?:(?:localhost)|(?:\\d{1,3}(?:\\.\\d{1,3}){3})|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63})(?::\\d{2,5})?(?:\\/[^\\s?#]*)?(?:\\?[^\\s#]*)?(?:#[^\\s]*)?$/i`,
        type: 'text' as const,
      },
      {
        key: 'username',
        label: 'API username',
        hint: 'In Listmonk: Admin → Users → New, user type "API". Its role needs lists:get_all, templates:get, campaigns:manage_all and campaigns:send.',
        validation: `/^.+$/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        label: 'API token',
        hint: 'The token Listmonk shows when you create the API user. Your login password does not work here.',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    // Listmonk answers both a wrong token and a missing permission with 403
    // {"message": "..."}; only the first one is fixed by reconnecting.
    if (
      (status === 401 || status === 403) &&
      /invalid API credentials|invalid session/i.test(body)
    ) {
      return { type: 'refresh-token', value: REVOKED_CREDENTIALS };
    }

    const permission = body.match(/permission denied:?\s*([\w:.-]+)/i);
    if (status === 403 && permission) {
      return {
        type: 'bad-body',
        value: `The Listmonk API user is missing the "${permission[1]}" permission. Add it to the user's role in Listmonk (Admin → Users → User roles) and try again.`,
      };
    }

    if (status === 400 && /invalid list id/i.test(body)) {
      return {
        type: 'bad-body',
        value:
          'Listmonk did not accept the list. Pick a list in the post settings, and make sure the API user’s role can access it.',
      };
    }

    if (status === 404) {
      return {
        type: 'bad-body',
        value:
          'Listmonk answered "not found" (HTTP 404). Check that the channel’s Listmonk URL is the address of your install, and that the list and template still exist.',
      };
    }

    return undefined;
  }

  private parseInstance(raw: string): ListmonkInstance {
    const body = JSON.parse(raw || '{}') || {};
    return {
      url: normalizeListmonkUrl(String(body.url || '')),
      username: String(body.username || '').trim(),
      password: String(body.password || '').trim(),
    };
  }

  private instance(integration: Integration) {
    return this.parseInstance(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );
  }

  private authorization(instance: ListmonkInstance) {
    return (
      'Basic ' +
      Buffer.from(`${instance.username}:${instance.password}`).toString(
        'base64'
      )
    );
  }

  // Connect-time call: reports what went wrong in words the user can act on,
  // instead of collapsing every failure (wrong URL, unreachable host, missing
  // permission) into "Invalid credentials".
  private async probe(
    instance: ListmonkInstance,
    path: string
  ): Promise<{ data?: any; status: number; error?: string }> {
    let response: Response;
    try {
      response = await fetch(instance.url + path, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization(instance),
        },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
      });
    } catch (err: any) {
      const reason = `${err?.message || ''} ${err?.cause?.message || ''} ${
        err?.cause?.code || ''
      }`;
      if (/Blocked IP/i.test(reason)) {
        return {
          status: 0,
          error: `${instance.url} points to a private network address, which Hookpost cannot reach. Use the public address of your Listmonk install.`,
        };
      }
      return {
        status: 0,
        error: /timeout|abort/i.test(reason)
          ? `${instance.url} did not answer within ${
              CONNECT_TIMEOUT_MS / 1000
            } seconds. Check that your Listmonk install is reachable from the internet.`
          : `Could not reach ${instance.url}. Check the address and that your Listmonk install is reachable from the internet.`,
      };
    }

    const text = await response.text().catch(() => '');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    // An http:// address that redirects to https:// works for this GET, but
    // the campaign POST would be turned into a GET by a 301/302 and the post
    // would fail later. Ask for the final address up front.
    const requested = path.split('?')[0];
    if (response.redirected && response.url) {
      const final = new URL(response.url);
      if (final.pathname.endsWith(requested)) {
        const base = normalizeListmonkUrl(
          `${final.origin}${final.pathname.slice(
            0,
            final.pathname.length - requested.length
          )}`
        );
        if (base !== instance.url) {
          return {
            status: response.status,
            error: `${instance.url} redirects to ${base}. Connect with ${base} instead.`,
          };
        }
      }
    }

    if (response.status === 200 && json && typeof json === 'object' && 'data' in json) {
      return { status: 200, data: json.data };
    }

    const message = typeof json?.message === 'string' ? json.message : '';
    if (
      response.status === 401 ||
      (response.status === 403 &&
        /invalid API credentials|invalid session|api_key|token/i.test(message))
    ) {
      return { status: response.status, error: INVALID_CREDENTIALS };
    }

    if (response.status === 403 && /permission denied/i.test(message)) {
      return { status: 403, error: message };
    }

    if (response.status === 429) {
      return {
        status: 429,
        error: 'Listmonk is rate limiting requests right now. Try again in a minute.',
      };
    }

    if (response.status >= 500) {
      return {
        status: response.status,
        error: `Listmonk at ${instance.url} returned an error (HTTP ${response.status}). Try again in a few minutes.`,
      };
    }

    if (response.status === 200 || response.status === 404 || !json) {
      return {
        status: response.status,
        error: `No Listmonk API found at ${instance.url}. Enter the address of your Listmonk install, for example https://lists.example.com.`,
      };
    }

    return {
      status: response.status,
      error: `Listmonk refused the connection (HTTP ${response.status}${
        message ? `: ${message}` : ''
      }).`,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let instance: ListmonkInstance;
    try {
      instance = this.parseInstance(
        Buffer.from(params.code, 'base64').toString()
      );
    } catch {
      return 'Fill in the Listmonk URL, API username and API token.';
    }

    if (!instance.url || !instance.username || !instance.password) {
      return 'Fill in the Listmonk URL, API username and API token.';
    }

    let parsed: URL;
    try {
      parsed = new URL(instance.url);
    } catch {
      return `${instance.url} is not a valid address. Use the address of your Listmonk install, for example https://lists.example.com.`;
    }
    const host = parsed.host;

    // The SSRF-safe dispatcher checks addresses in its DNS lookup, and Node
    // never runs a lookup for an IP literal: http://127.0.0.1:3000 or
    // http://10.0.0.5 went straight through. The URL is fixed at connect
    // time, so refusing it here keeps it out of every later call too.
    const literal = parsed.hostname.replace(/^\[|\]$/g, '');
    if (getSsrfSafeDispatcher() && net.isIP(literal) && isBlockedIp(literal)) {
      return `${instance.url} points to a private network address, which Hookpost cannot reach. Use the public address of your Listmonk install.`;
    }

    // /api/settings only supplies the channel name and logo, and needs
    // settings:get. A least-privilege API user without it is still a working
    // channel, so fall back to /api/lists to check the credentials.
    let settings: any = {};
    const settingsCall = await this.probe(instance, '/api/settings');
    if (settingsCall.error) {
      if (!/permission denied/i.test(settingsCall.error)) {
        return settingsCall.error;
      }

      const listsCall = await this.probe(
        instance,
        '/api/lists?minimal=true&per_page=all'
      );
      if (listsCall.error) {
        return /permission denied/i.test(listsCall.error)
          ? `The Listmonk API user cannot read lists (${listsCall.error}). Give its role lists:get_all in Listmonk (Admin → Users → User roles).`
          : listsCall.error;
      }
    } else {
      settings = settingsCall.data || {};
    }

    const siteName = String(settings['app.site_name'] || '').trim() || host;
    const logo = String(settings['app.logo_url'] || '').trim();
    let picture = '';
    try {
      picture = logo ? new URL(logo, instance.url + '/').toString() : '';
    } catch {
      picture = '';
    }

    // The credentials themselves live (encrypted) in customInstanceDetails,
    // which is all post/list/templates read. The token columns are stored in
    // the clear, so they get an opaque marker instead of base64(user:token),
    // and nothing derived from the secret.
    const marker = `listmonk-${makeId(24)}`;

    return {
      refreshToken: marker,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: marker,
      id: Buffer.from(instance.url).toString('base64'),
      name: siteName,
      picture,
      username: siteName,
    };
  }

  @Tool({ description: 'List of available lists', dataSchema: [] })
  async list(
    token: string,
    data: any,
    internalId: string,
    integration: Integration
  ) {
    const instance = this.instance(integration);

    // Without minimal/per_page the API returns the first 20 lists only.
    const response = await (
      await this.fetch(`${instance.url}/api/lists?minimal=true&per_page=all`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization(instance),
        },
      })
    ).json();

    // minimal=true answers {"data": []} when there are no lists, and
    // {"data": {"results": [...]}} otherwise.
    const lists = Array.isArray(response?.data)
      ? response.data
      : response?.data?.results || [];

    return lists.map((p: any) => ({ id: p.id, name: p.name }));
  }

  @Tool({ description: 'List of available templates', dataSchema: [] })
  async templates(
    token: string,
    data: any,
    internalId: string,
    integration: Integration
  ) {
    const instance = this.instance(integration);

    const response = await (
      await this.fetch(`${instance.url}/api/templates?no_body=true`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization(instance),
        },
      })
    ).json();

    // Transactional and visual-builder templates cannot wrap an HTML
    // campaign; offering them only produced a failed send.
    const templates = (Array.isArray(response?.data) ? response.data : [])
      .filter((p: any) => !p.type || p.type === 'campaign');

    return [
      { id: 0, name: 'Default' },
      ...templates.map((p: any) => ({ id: p.id, name: p.name })),
    ];
  }

  override async mediaNotices(
    posts: Array<ValidityMedia[]>
  ): Promise<string[]> {
    const videos = (posts || [])
      .flat()
      .filter((item) => isVideo(item?.path));
    return videos.length
      ? [
          'Email cannot play video, so Listmonk will send the video as a link (over its cover image when it has one).',
        ]
      : [];
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<ListmonkDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const instance = this.instance(integration);
    const [firstPost] = postDetails;
    const settings: Partial<ListmonkDto> = firstPost?.settings || {};

    const listId = Number(settings.list);
    if (!Number.isInteger(listId) || listId <= 0) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Pick a Listmonk list in the post settings before sending.'
      );
    }

    const subject = String(settings.subject || '').trim();
    if (!subject) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Add an email subject in the post settings before sending.'
      );
    }

    // slugify(strict) drops every non-Latin character, so a Hindi or emoji
    // subject became an empty name and Listmonk refused the campaign with
    // "Invalid length for name".
    const name =
      slugify(subject, { lower: true, strict: true, trim: true }).slice(
        0,
        200
      ) || subject.slice(0, 200);

    const templateId = Number(settings.template);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: this.authorization(instance),
    };

    const created = await (
      await this.fetch(
        `${instance.url}/api/campaigns`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name,
            type: 'regular',
            content_type: 'html',
            subject,
            lists: [listId],
            body: listmonkCampaignBody(
              firstPost.message,
              settings.preview || '',
              firstPost.media || []
            ),
            ...(Number.isInteger(templateId) && templateId > 0
              ? { template_id: templateId }
              : {}),
          }),
        },
        this.identifier
      )
    ).json();

    const campaignId = created?.data?.id;
    if (!campaignId) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(created ?? {}).slice(0, 2000),
        '{}',
        'Listmonk did not return a campaign id, so nothing was sent. Check that the channel’s Listmonk URL is the https address of your install.'
      );
    }

    // A new campaign is a draft; this is what actually sends it. If it is
    // refused the email has not gone out, and the draft is left in Listmonk.
    try {
      await this.fetch(
        `${instance.url}/api/campaigns/${campaignId}/status`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ status: 'running' }),
        },
        this.identifier
      );
    } catch (err: any) {
      if (err instanceof BadBody) {
        throw new BadBody(
          this.identifier,
          (err.details?.[0] as any)?.json || '{}',
          '{}',
          `${err.message} The campaign "${subject}" was saved in Listmonk as a draft and was not sent.`
        );
      }
      throw err;
    }

    return [
      {
        id: firstPost.id,
        status: 'completed',
        // The API preview URL answers 403 in a browser; the admin page opens
        // for anyone signed in to Listmonk.
        releaseURL: `${instance.url}/admin/campaigns/${campaignId}`,
        postId: String(created.data.uuid || campaignId),
      },
    ];
  }
}
