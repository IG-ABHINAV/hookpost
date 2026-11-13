import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OAuthService } from '@hookpost/nestjs-libraries/database/prisma/oauth/oauth.service';
import { EmailNotVerifiedException } from '@hookpost/nestjs-libraries/services/email.verification';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { User, Organization } from '@prisma/client';
import { AuthorizeOAuthQueryDto, ApproveOAuthDto } from '@hookpost/nestjs-libraries/dtos/oauth/authorize-oauth.dto';
import { TokenExchangeDto } from '@hookpost/nestjs-libraries/dtos/oauth/token-exchange.dto';
import { RegisterClientDto } from '@hookpost/nestjs-libraries/dtos/oauth/register-client.dto';

/**
 * Client credentials from an `Authorization: Basic` header (client_secret_basic,
 * RFC 6749 section 2.3.1: each part form-urlencoded before base64), or null
 * when the header is not Basic. A malformed one is invalid_client.
 */
export function basicClientCredentials(
  authorization?: string
): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+(\S+)\s*$/i.exec(authorization || '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const invalid = () =>
    new HttpException(
      { error: 'invalid_client', error_description: 'Malformed Basic credentials' },
      HttpStatus.UNAUTHORIZED
    );
  if (colon <= 0) throw invalid();
  const formDecode = (value: string) =>
    decodeURIComponent(value.replace(/\+/g, ' '));
  try {
    return {
      clientId: formDecode(decoded.slice(0, colon)),
      clientSecret: formDecode(decoded.slice(colon + 1)),
    };
  } catch {
    throw invalid();
  }
}

@ApiTags('OAuth')
@Controller('/oauth')
export class OAuthController {
  constructor(private _oauthService: OAuthService) {}

  // Dynamic Client Registration (RFC 7591), used by MCP clients like Claude
  @Post('/register')
  @HttpCode(201)
  async register(@Body() body: RegisterClientDto) {
    return this._oauthService.registerDynamicClient(body);
  }

  @Get('/authorize')
  async authorize(@Query() query: AuthorizeOAuthQueryDto) {
    const app = await this._oauthService.validateAuthorizationRequest(
      query.client_id,
      {
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
      }
    );

    return {
      app: {
        name: app.name,
        description: app.description,
        picture: app.picture,
        clientId: app.clientId,
        redirectUrl: app.redirectUrl,
      },
      state: query.state,
    };
  }

  // RFC 6749 section 5.1: 200 OK (Nest's default for POST is 201), never cached.
  @Post('/token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async token(
    @Body() body: TokenExchangeDto,
    @Headers('authorization') authorization?: string
  ) {
    if (body.grant_type !== 'authorization_code') {
      throw new HttpException(
        { error: 'unsupported_grant_type' },
        HttpStatus.BAD_REQUEST
      );
    }

    // ChatGPT and other clients may authenticate with a Basic header instead
    // of client_id/client_secret in the body. Both at once must agree.
    const basic = basicClientCredentials(authorization);
    if (basic && body.client_id && body.client_id !== basic.clientId) {
      throw new HttpException(
        { error: 'invalid_client', error_description: 'client_id does not match the Basic credentials' },
        HttpStatus.UNAUTHORIZED
      );
    }
    if (basic && body.client_secret && body.client_secret !== basic.clientSecret) {
      throw new HttpException(
        { error: 'invalid_client', error_description: 'Use one client authentication method' },
        HttpStatus.UNAUTHORIZED
      );
    }

    return this._oauthService.exchangeCodeForToken(
      body.code,
      basic?.clientId || body.client_id,
      basic?.clientSecret || body.client_secret,
      body.code_verifier,
      body.redirect_uri
    );
  }

  @Get('/userinfo')
  async userinfo(@Headers('authorization') authorization?: string) {
    return this._oauthService.getUserInfo(authorization);
  }

  @Post('/userinfo')
  async userinfoPost(@Headers('authorization') authorization?: string) {
    return this._oauthService.getUserInfo(authorization);
  }
}

@ApiTags('OAuth')
@Controller('/oauth')
export class OAuthAuthorizedController {
  constructor(private _oauthService: OAuthService) {}

  @Post('/authorize')
  async approveOrDeny(
    @Body() body: ApproveOAuthDto,
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    const app = await this._oauthService.validateAuthorizationRequest(
      body.client_id,
      {
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      }
    );

    // Dynamic clients redirect to their validated redirect_uri,
    // static apps keep using the one stored on the app
    const redirectTarget = app.dynamic ? body.redirect_uri! : app.redirectUrl;

    // Approving hands the app a token that outlives this session (MCP, the
    // CLI): only once the user's email is confirmed. Denying is always fine.
    if (body.action !== 'deny' && user?.activated !== true) {
      throw new EmailNotVerifiedException(
        'Confirm your email address to connect an app to Hookpost. Open the link we emailed you, or send a new one from the banner at the top of Hookpost.'
      );
    }

    if (body.action === 'deny') {
      const redirectUrl = new URL(redirectTarget);
      redirectUrl.searchParams.set('error', 'access_denied');
      if (body.state) {
        redirectUrl.searchParams.set('state', body.state);
      }
      return { redirect: redirectUrl.toString() };
    }

    const code = await this._oauthService.createAuthorizationCode(
      app.id,
      user.id,
      org.id,
      app.dynamic
        ? {
            codeChallenge: body.code_challenge,
            codeChallengeMethod: body.code_challenge_method,
            redirectUri: body.redirect_uri,
          }
        : undefined
    );

    const redirectUrl = new URL(redirectTarget);
    redirectUrl.searchParams.set('code', code);
    if (body.state) {
      redirectUrl.searchParams.set('state', body.state);
    }
    return { redirect: redirectUrl.toString() };
  }
}
