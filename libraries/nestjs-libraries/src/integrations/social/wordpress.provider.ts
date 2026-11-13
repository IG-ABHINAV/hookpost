import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { WordpressDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/wordpress.dto';
import slugify from 'slugify';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';
import { getSsrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';

// What the connect form collects. `api` is only set when the site's REST API
// is not at {domain}/wp-json/ (plain permalinks, or WordPress installed
// somewhere other than the address the user typed) - see discoverApi.
export type WordpressCredentials = {
  domain: string;
  username: string;
  password: string;
  api?: string;
};

// The connect form base64-encodes the credentials into the callback URL's
// query string without URL-encoding them, and Next parses that query with
// URLSearchParams, so every "+" in the base64 arrives as a space (a domain
// with "~" in it is enough to produce one). Base64 never contains spaces, so
// putting them back is lossless.
export const decodeWordpressToken = (token: string): WordpressCredentials =>
  JSON.parse(
    Buffer.from(String(token || '').replace(/ /g, '+'), 'base64').toString()
  );

const encodeWordpressToken = (credentials: WordpressCredentials) =>
  Buffer.from(JSON.stringify(credentials)).toString('base64');

// Users paste the address with whitespace, a trailing slash, or straight from
// the admin screen (".../wp-admin/"), each of which used to build a broken
// REST URL.
export const normalizeWordpressDomain = (domain: string) =>
  String(domain || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/(wp-admin|wp-login\.php|wp-json)(\/.*)?$/i, '')
    .replace(/\/+$/, '');

// A REST URL for `route`. The REST root is {domain}/wp-json/ with pretty
// permalinks, or {domain}/?rest_route=/ without them, where extra query
// parameters have to follow with "&".
export const wordpressUrl = (
  site: Pick<WordpressCredentials, 'domain' | 'api'>,
  route: string,
  query = ''
) => {
  const root = site.api || `${site.domain}/wp-json/`;
  const path = route.replace(/^\/+/, '');
  if (root.indexOf('rest_route=') > -1) {
    return `${root}${path}${query ? `&${query}` : ''}`;
  }
  return `${root.replace(/\/?$/, '/')}${path}${query ? `?${query}` : ''}`;
};

const basicAuth = (credentials: WordpressCredentials) =>
  `Basic ${Buffer.from(
    `${String(credentials.username || '').trim()}:${credentials.password || ''}`
  ).toString('base64')}`;

// Without tags or the closing full stop, so it can sit inside our sentences.
const stripTags = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/<[^>]+>/g, '')
        .trim()
        .replace(/[.\s]+$/, '')
    : '';

// WordPress REST errors are {"code","message","data":{"status"}}.
export const parseWordpressError = (body: string) => {
  try {
    const parsed = JSON.parse(body);
    return {
      code: typeof parsed?.code === 'string' ? parsed.code : '',
      message: stripTags(parsed?.message).slice(0, 300),
    };
  } catch (err) {
    return { code: '', message: '' };
  }
};

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch (err) {
    return false;
  }
};

// Same host, ignoring a leading "www." - the http->https and www<->apex
// redirects every host does. Credentials are only re-sent to such a target.
const sameSite = (first: string, second: string) => {
  try {
    const a = new URL(first);
    const b = new URL(second);
    return (
      a.hostname.replace(/^www\./i, '').toLowerCase() ===
        b.hostname.replace(/^www\./i, '').toLowerCase() &&
      a.port === b.port &&
      !(a.protocol === 'https:' && b.protocol === 'http:')
    );
  } catch (err) {
    return false;
  }
};

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

const baseNameOf = (path: string) =>
  String(path || '')
    .split(/[?#]/)[0]
    .split('/')
    .pop() || '';

const extensionOf = (path: string) => {
  const base = baseNameOf(path);
  return base.indexOf('.') > -1
    ? (base.split('.').pop() || '').toLowerCase()
    : '';
};

// Header values must be ASCII, and WordPress needs a filename with the right
// extension to accept the upload.
export const wordpressFileName = (path: string) => {
  const clean = baseNameOf(path)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '');
  const extension = extensionOf(path) || 'jpg';
  return clean && clean.indexOf('.') > -1
    ? clean
    : `hookpost-${makeId(8)}.${extension}`;
};

const escapeAttribute = (value: string) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const AUTH_CODES = [
  'incorrect_password',
  'invalid_username',
  'invalid_email',
  'application_passwords_disabled',
  'application_passwords_disabled_for_user',
];

// One message per reason WordPress gives (wp_authenticate_application_password
// in wp-includes/user.php), so the user knows which field or setting to fix.
export const wordpressAuthMessage = (
  code: string,
  message: string,
  status: number,
  domain: string
) => {
  switch (code) {
    case 'invalid_username':
    case 'invalid_email':
      return "WordPress doesn't recognise that username. Use the username or email you sign in to WordPress with.";
    case 'incorrect_password':
      return 'WordPress rejected the password. Paste an Application Password (wp-admin > Users > Profile > Application Passwords), not your normal login password.';
    case 'application_passwords_disabled':
      return 'Application Passwords are turned off on this site. WordPress only enables them over HTTPS (behind Cloudflare or another proxy it may not detect HTTPS), and some security plugins turn them off.';
    case 'application_passwords_disabled_for_user':
      return 'Application Passwords are disabled for this WordPress user. Ask the site administrator to allow them, or connect a different user.';
  }

  if (code === 'rest_not_logged_in' || (status === 401 && !code)) {
    if (/^http:\/\//i.test(domain)) {
      return "Application Passwords only work over HTTPS. Use your site's https:// address.";
    }
    return 'WordPress ignored the login. Create an Application Password first (wp-admin > Users > Profile > Application Passwords): until one exists, WordPress does not check it. If you already have one, your host or a security plugin is removing the Authorization header.';
  }

  return `WordPress refused the request (HTTP ${status})${
    message ? `: ${message}` : ''
  }. A security plugin or firewall may be blocking the REST API.`;
};

export class WordpressProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'wordpress';
  name = 'WordPress';
  isBetweenSteps = false;
  editor = 'html' as const;
  scopes = [] as string[];
  override maxConcurrentJob = 5; // WordPress self-hosted typically has generous limits
  dto = WordpressDto;
  maxLength() {
    return 100000;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  // Application Passwords never expire, so there is nothing to refresh: a
  // revoked one sends the user to reconnect (see handleErrors).
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

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    const { code, message } = parseWordpressError(body);

    // The Application Password was revoked or the user lost access: only a
    // reconnect fixes it.
    if (AUTH_CODES.includes(code)) {
      return {
        type: 'refresh-token',
        value: wordpressAuthMessage(code, message, status, ''),
      };
    }

    if (code === 'rest_cannot_create' && status === 401) {
      return {
        type: 'bad-body',
        value:
          'WordPress did not receive the login. Your host or a security plugin is removing the Authorization header.',
      };
    }

    // Contributors can't upload media, Contributors and Subscribers can't
    // publish, and so on. WordPress's own message names the missing right.
    if (
      code === 'rest_cannot_create' ||
      code === 'rest_cannot_publish' ||
      code === 'rest_cannot_assign_term' ||
      code === 'rest_cannot_edit_others'
    ) {
      return {
        type: 'bad-body',
        value: `${
          message || 'The connected WordPress user is not allowed to do this'
        }. Connect a WordPress user with the Author role or higher.`,
      };
    }

    if (code === 'rest_no_route') {
      return {
        type: 'bad-body',
        value:
          'WordPress has no endpoint for the selected post type. Pick another type in the WordPress settings of this post.',
      };
    }

    if (status === 413) {
      return {
        type: 'bad-body',
        value:
          'The file is larger than your WordPress host accepts (HTTP 413). Use a smaller file or raise the upload limit on the host.',
      };
    }

    if (code.indexOf('rest_upload') === 0) {
      return {
        type: 'bad-body',
        value: `WordPress could not store the file: ${message || code}.`,
      };
    }

    // A firewall in front of the site (Cloudflare's "Just a moment..."
    // challenge, a WAF) answers with an HTML page, not a WordPress error.
    if (status === 403 && !code) {
      return {
        type: 'bad-body',
        value:
          'A firewall in front of your WordPress site (e.g. Cloudflare bot protection) blocked the request (HTTP 403). Allow requests to /wp-json/ from Hookpost.',
      };
    }

    // WordPress inserts the post before it runs save hooks, assigns terms and
    // so on, so a 500 here usually means the post exists. this.fetch retries a
    // bare 500 three times, which published the same article up to four
    // times. Stop and tell the user to look instead.
    if (status >= 500) {
      return {
        type: 'bad-body',
        value: `WordPress hit a server error (HTTP ${status})${
          message ? `: ${message}` : ''
        }. The post may have been published anyway, so check your site before posting again.`,
      };
    }

    return undefined;
  }

  async customFields() {
    return [
      {
        key: 'domain',
        label: 'Domain URL',
        validation: `/^https?:\\/\\/(?:www\\.)?[\\w\\-]+(\\.[\\w\\-]+)+([\\/?#][^\\s]*)?$/`,
        type: 'text' as const,
        hint: "Your WordPress site's address, e.g. https://example.com",
      },
      {
        key: 'username',
        label: 'Username',
        validation: `/.+/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        label: 'Application Password',
        validation: `/.+/`,
        type: 'password' as const,
        hint: 'Not your login password. In wp-admin open Users > Profile > Application Passwords, add one named Hookpost and paste it here.',
      },
    ];
  }

  // The cover becomes the featured image, which WordPress only accepts as an
  // image: a video there was uploaded and then silently dropped.
  override async checkValidity(
    posts: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    const cover = settings?.main_image?.path;
    if (cover && !MIME_TYPES[extensionOf(cover)]?.startsWith('image/')) {
      return 'The WordPress cover picture must be an image.';
    }
    return true;
  }

  private async requestMe(
    site: Pick<WordpressCredentials, 'domain' | 'api'>,
    auth: string
  ): Promise<{ response?: Response; text: string; error?: unknown }> {
    try {
      const response = await fetch(wordpressUrl(site, 'wp/v2/users/me'), {
        headers: { Authorization: auth },
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
      });
      const text = await response.text().catch(() => '');
      return { response, text };
    } catch (error) {
      return { text: '', error };
    }
  }

  // fetch drops the Authorization header when a redirect leaves the origin,
  // so a site that redirects http->https or apex->www answered "not logged
  // in" to perfectly good credentials. Follow those to the final address;
  // anything else is a different site and the user has to type it.
  private redirectedSite(
    site: Pick<WordpressCredentials, 'domain' | 'api'>,
    response: Response
  ): { domain: string } | { error: string } | undefined {
    if (!response.redirected || !response.url) {
      return undefined;
    }
    const from = wordpressUrl(site, 'wp/v2/users/me');
    const to = new URL(response.url);
    if (new URL(from).origin === to.origin) {
      return undefined;
    }
    const routeAt = to.href.search(/\/wp-json\/wp\/v2\/users\/me\/?(\?.*)?$/);
    if (!sameSite(from, to.href) || routeAt < 0) {
      return {
        error: `Your WordPress address redirects to ${to.origin}. Enter that address as the Domain URL.`,
      };
    }
    return { domain: normalizeWordpressDomain(to.href.slice(0, routeAt)) };
  }

  // WordPress advertises its REST root on every page:
  // Link: <https://example.com/wp-json/>; rel="https://api.w.org/"
  // (https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/)
  private async discoverApi(domain: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${domain}/`, {
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
      });
      await response.body?.cancel().catch(() => {});
      const link = response.headers.get('link') || '';
      return link.match(/<([^>]+)>\s*;\s*rel="https:\/\/api\.w\.org\/"/)?.[1];
    } catch (err) {
      return undefined;
    }
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let credentials: WordpressCredentials;
    try {
      credentials = decodeWordpressToken(params.code);
    } catch (err) {
      return 'Could not read the connection details. Please connect again.';
    }

    const auth = basicAuth(credentials);
    let site: { domain: string; api?: string } = {
      domain: normalizeWordpressDomain(credentials.domain),
    };
    const unreachable =
      'Could not reach your WordPress site. Check the Domain URL and that the site is publicly accessible.';

    let attempt = await this.requestMe(site, auth);
    if (attempt.error || !attempt.response) {
      console.log(attempt.error);
      return unreachable;
    }

    const moved = this.redirectedSite(site, attempt.response);
    if (moved && 'error' in moved) {
      return moved.error;
    }
    if (moved && 'domain' in moved) {
      site = { domain: moved.domain };
      attempt = await this.requestMe(site, auth);
      if (attempt.error || !attempt.response) {
        console.log(attempt.error);
        return unreachable;
      }
    }

    // Nothing at /wp-json/: plain permalinks, or the REST API lives under
    // another path than the address typed. Ask the site where it is.
    if (
      attempt.response.status === 404 ||
      (attempt.response.ok && !isJson(attempt.text))
    ) {
      const api = await this.discoverApi(site.domain);
      if (api && api !== wordpressUrl(site, '')) {
        if (!sameSite(site.domain, api)) {
          return `Your WordPress REST API is at ${api}. Enter that site's address as the Domain URL.`;
        }
        const domain = normalizeWordpressDomain(
          api.replace(/\/?(\?rest_route=.*|wp-json\/?.*)$/, '')
        );
        site = {
          domain,
          ...(api === `${domain}/wp-json/` ? {} : { api }),
        };
        attempt = await this.requestMe(site, auth);
        if (attempt.error || !attempt.response) {
          console.log(attempt.error);
          return unreachable;
        }
      }
    }

    const { response, text } = attempt;

    if (!response.ok) {
      const { code, message } = parseWordpressError(text);
      // Log what WordPress actually returned so failures can be diagnosed
      // without guessing. Never the credentials.
      console.log(
        `WordPress auth failed for ${site.domain} (HTTP ${response.status})`,
        JSON.stringify({
          code,
          message,
          ...(code ? {} : { body: text.slice(0, 300) }),
        })
      );

      if (response.status === 404) {
        return `No WordPress REST API found at ${site.domain}. Check that this is your WordPress site's address; if it is, the REST API is turned off (some security plugins do this).`;
      }

      if ([400, 401, 403].includes(response.status)) {
        return wordpressAuthMessage(
          code,
          message,
          response.status,
          site.domain
        );
      }

      return `WordPress returned an unexpected error (HTTP ${response.status})${
        message ? `: ${message}` : ''
      }. Make sure the REST API is enabled and Application Passwords are available.`;
    }

    // Even on a 200, a security plugin / maintenance page can return HTML
    // instead of JSON.
    let data: any;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return 'WordPress did not return a valid response. The REST API may be disabled or blocked by a security plugin.';
    }

    if (!data || typeof data.id !== 'number') {
      return 'WordPress did not return the user for these credentials. The REST API may be blocked by a security plugin.';
    }

    const { id, name, avatar_urls } = data;

    const biggestImage = Object.keys(avatar_urls || {}).reduce(
      (all, current) => Math.max(all, Number(current) || 0),
      0
    );

    return {
      refreshToken: '',
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: encodeWordpressToken({
        domain: site.domain,
        username: String(credentials.username || '').trim(),
        password: credentials.password,
        ...(site.api ? { api: site.api } : {}),
      }),
      id: `${site.domain}_${id}`,
      name: name || credentials.username,
      picture: avatar_urls?.[String(biggestImage)] || '',
      username: String(credentials.username || '').trim(),
    };
  }

  // Custom provider functions below are invoked from the backend HTTP endpoint
  // (`/integrations/function`) - which is NOT a Temporal activity - so they must
  // use a plain `fetch` (with the SSRF guard) rather than `this.fetch`, which
  // calls `Context.current()` and throws outside an activity. This mirrors how
  // `authenticate` issues its request.
  private async wpGet(token: string, route: string, query = '') {
    const credentials = decodeWordpressToken(token);

    const response = await fetch(wordpressUrl(credentials, route, query), {
      headers: {
        Authorization: basicAuth(credentials),
      },
      // @ts-ignore - undici-only option; blocks SSRF to internal IPs
      dispatcher: getSsrfSafeDispatcher(),
    });

    const text = await response.text();
    if (!response.ok) {
      const { code, message } = parseWordpressError(text);
      throw new Error(
        message || code || `WordPress returned HTTP ${response.status}`
      );
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('WordPress did not return a valid response');
    }
  }

  @Tool({
    description: 'Get list of post types',
    dataSchema: [],
  })
  async postTypes(token: string) {
    const postTypes = await this.wpGet(token, 'wp/v2/types');

    return Object.entries<any>(postTypes || {}).reduce((all, [key, value]) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.rest_base !== 'string' ||
        key.indexOf('wp_') > -1 ||
        key.indexOf('nav_') > -1 ||
        key === 'attachment'
      ) {
        return all;
      }

      // Post types registered under another namespace (WP 5.9+ reports it)
      // are not reachable at wp/v2/{rest_base}.
      const namespace = value.rest_namespace || 'wp/v2';
      all.push({
        id:
          namespace === 'wp/v2'
            ? value.rest_base
            : `${namespace}/${value.rest_base}`,
        name: value.name,
      });

      return all;
    }, [] as Array<{ id: string; name: string }>);
  }

  @Tool({
    description: 'Get list of categories',
    dataSchema: [],
  })
  async categoriesList(token: string) {
    const categories = await this.wpGet(
      token,
      'wp/v2/categories',
      'per_page=100'
    );

    return (Array.isArray(categories) ? categories : []).map(
      (category: any) => ({
        id: category.id,
        name: category.name,
      })
    );
  }

  @Tool({
    description: 'Get list of tags',
    dataSchema: [],
  })
  async tagsList(token: string) {
    const tags = await this.wpGet(token, 'wp/v2/tags', 'per_page=100');

    return (Array.isArray(tags) ? tags : []).map((tag: any) => ({
      id: tag.id,
      name: tag.name,
    }));
  }

  // Raw-body upload (POST /wp/v2/media with Content-Disposition), streamed
  // from storage so a video is never held in memory. WordPress refuses the
  // upload without a Content-Type, and PHP behind some servers can't read a
  // chunked body, so both it and Content-Length are always sent.
  private async uploadMedia(
    credentials: WordpressCredentials,
    path: string,
    alt?: string
  ): Promise<{ id: number; source_url: string; mime_type: string }> {
    const fileName = wordpressFileName(path);
    const contentType =
      MIME_TYPES[extensionOf(fileName)] || 'application/octet-stream';
    const size = await this.mediaSize(path, this.identifier);

    const uploaded: any = await this.runStreamedUpload(async () => {
      const stream = await this.mediaStream(path, this.identifier);
      const response = await fetch(
        wordpressUrl(
          credentials,
          'wp/v2/media',
          alt ? `alt_text=${encodeURIComponent(alt)}` : ''
        ),
        {
          method: 'POST',
          headers: {
            Authorization: basicAuth(credentials),
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': String(size),
          },
          body: stream as any,
          // Required by undici when streaming a request body.
          duplex: 'half',
          // @ts-ignore - undici-only option; blocks SSRF to internal IPs
          dispatcher: getSsrfSafeDispatcher(),
        } as any
      );

      const text = await response.text().catch(() => '');
      if (response.status !== 200 && response.status !== 201) {
        throw { response: { status: response.status, data: text || '{}' } };
      }

      try {
        return JSON.parse(text);
      } catch (err) {
        return undefined;
      }
    }, this.identifier);

    if (!uploaded || typeof uploaded.id !== 'number') {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `WordPress did not confirm the upload of ${fileName}. Nothing was published.`
      );
    }

    return {
      id: uploaded.id,
      source_url: uploaded.source_url || '',
      mime_type: uploaded.mime_type || contentType,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<WordpressDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const credentials = decodeWordpressToken(accessToken);
    const [first] = postDetails;
    const settings: Partial<WordpressDto> = first?.settings || {};

    // Pages and custom post types live at wp/v2/{rest_base}; types from
    // another namespace carry it ("ns/v1/base").
    const type = settings.type || 'posts';
    if (!/^[\w-]+(\/[\w.-]+)*$/.test(type)) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Invalid WordPress post type. Pick a type in the WordPress settings of this post.'
      );
    }
    const route = type.indexOf('/') > -1 ? type : `wp/v2/${type}`;

    let featuredMedia: number | undefined;
    if (settings.main_image?.path) {
      featuredMedia = (
        await this.uploadMedia(
          credentials,
          settings.main_image.path,
          settings.main_image.alt
        )
      ).id;
    }

    // Pictures and videos attached in the editor used to be dropped without a
    // word. Upload them and place them after the text, as the preview shows.
    const content = [first?.message || ''];
    for (const media of first?.media || []) {
      if (!media?.path) {
        continue;
      }
      const uploaded = await this.uploadMedia(
        credentials,
        media.path,
        media.alt
      );
      const src = escapeAttribute(uploaded.source_url);
      content.push(
        uploaded.mime_type.indexOf('video/') === 0
          ? `<figure class="wp-block-video"><video controls src="${src}"></video></figure>`
          : `<figure class="wp-block-image"><img src="${src}" alt="${escapeAttribute(
              media.alt || ''
            )}"/></figure>`
      );
    }

    const slug = settings.title
      ? slugify(settings.title, { lower: true, strict: true, trim: true })
      : '';

    const categories = (settings.categories || [])
      .map((category) => Number(category))
      .filter((category) => !isNaN(category));
    const tags = (settings.tags || [])
      .map((tag) => Number(tag))
      .filter((tag) => !isNaN(tag));

    const response = await this.fetch(
      wordpressUrl(credentials, route),
      {
        headers: {
          Authorization: basicAuth(credentials),
          'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
          title: settings.title,
          content: content.join('\n'),
          ...(slug ? { slug } : {}),
          status: settings.status || 'publish',
          ...(categories.length ? { categories } : {}),
          ...(tags.length ? { tags } : {}),
          ...(featuredMedia ? { featured_media: featuredMedia } : {}),
        }),
      },
      this.identifier
    );

    const text = await response.text().catch(() => '');
    let submit: any;
    try {
      submit = JSON.parse(text);
    } catch (err) {
      submit = undefined;
    }

    // A 200 without the new post (a redirect that turned the POST into a GET
    // returns the post list, a caching plugin returns HTML) used to be stored
    // as published with postId "undefined".
    if (!submit || Array.isArray(submit) || typeof submit.id !== 'number') {
      throw new BadBody(
        this.identifier,
        text.slice(0, 2000) || '{}',
        '{}',
        "WordPress answered without the new post, so we can't confirm it was published. Check your site before posting again."
      );
    }

    return [
      {
        id: first.id,
        status: 'completed',
        postId: String(submit.id),
        releaseURL: submit.link || '',
      },
    ];
  }
}
