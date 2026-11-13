import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { MediumSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/medium.settings.dto';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';

// Medium no longer issues integration tokens (Settings > Security and apps has
// no "Integration tokens" section, checked 26 Oct 2026), so the provider is in
// RETIRED_PROVIDERS and Add Channel never offers it. A token created before
// that still works, which is what these messages are for.
const MISSING_KEY =
  'Paste your Medium integration token to connect Medium.';
const INVALID_KEY =
  'Medium did not accept this integration token. Check that it was copied in full and has not been revoked in Medium.';

export class MediumProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Medium has lenient publishing limits
  identifier = 'medium';
  name = 'Medium';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'markdown' as const;
  dto = MediumSettingsDto;
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

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    // The connect form sends base64 of {"apiKey": "..."}. A code that is not
    // that (bad base64, not JSON, no key) used to throw from JSON.parse before
    // the try below, and the connect answered a bare "Authentication failed".
    let apiKey = '';
    try {
      const body = JSON.parse(
        Buffer.from(String(params?.code ?? ''), 'base64').toString()
      );
      apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    } catch (err) {
      return MISSING_KEY;
    }

    if (!apiKey) {
      return MISSING_KEY;
    }

    // A token is printable ASCII. Anything else (a pasted space or accent)
    // cannot go in a header: fetch throws a TypeError, which would read as
    // "Could not reach Medium".
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      return INVALID_KEY;
    }

    let response: Response;
    try {
      response = await fetch('https://api.medium.com/v1/me', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (err) {
      return 'Could not reach Medium, please try again in a minute.';
    }

    // A wrong or revoked token is a 401 {"errors":[{"message":"Token was
    // invalid.","code":6003}]} (checked live on 26 Oct 2026).
    if (response.status === 401 || response.status === 403) {
      return INVALID_KEY;
    }

    if (!response.ok) {
      return `Medium did not answer (HTTP ${response.status}), please try again in a minute.`;
    }

    let user: any;
    try {
      user = (await response.json())?.data;
    } catch (err) {
      return 'Medium sent an unexpected answer, please try again in a minute.';
    }

    if (!user?.id) {
      return INVALID_KEY;
    }

    return {
      refreshToken: '',
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: apiKey,
      id: String(user.id),
      name: user.name || user.username || '',
      picture: user.imageUrl || '',
      username: user.username || '',
    };
  }

  @Tool({ description: 'List of publications', dataSchema: [] })
  async publications(accessToken: string, _: any, id: string) {
    const { data } = await (
      await fetch(`https://api.medium.com/v1/users/${id}/publications`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    return data;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { settings } = postDetails?.[0] || { settings: {} };
    const { data } = await (
      await fetch(
        settings?.publication
          ? `https://api.medium.com/v1/publications/${settings?.publication}/posts`
          : `https://api.medium.com/v1/users/${id}/posts`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: settings.title,
            contentFormat: 'markdown',
            content: postDetails?.[0].message,
            ...(settings.canonical ? { canonicalUrl: settings.canonical } : {}),
            ...(settings?.tags?.length
              ? { tags: settings?.tags?.map((p: any) => p.value) }
              : {}),
            publishStatus: settings?.publication ? 'draft' : 'public',
          }),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      )
    ).json();

    return [
      {
        id: postDetails?.[0].id,
        status: 'completed',
        postId: data.id,
        releaseURL: data.url,
      },
    ];
  }
}
