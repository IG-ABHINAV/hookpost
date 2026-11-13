import { INestApplication } from '@nestjs/common';
import { Request, Response } from 'express';
import { MastraService } from '@hookpost/nestjs-libraries/chat/mastra.service';
import { MCPServer } from '@mastra/mcp';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { OAuthService } from '@hookpost/nestjs-libraries/database/prisma/oauth/oauth.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  gateToolsByPlan,
  mcpPlanRefusal,
  meterAgentByCredits,
} from '@hookpost/nestjs-libraries/chat/mcp.plan.gate';
import { runWithContext } from './async.storage';
import { createOAuthMiddleware } from './oauth-middleware';
import { mcpTokenFromHeaders } from './mcp.api-key';
const fixAcceptHeader = (req: Request) => {
  const value = 'application/json, text/event-stream';
  req.headers.accept = value;
  const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === 'accept');
  if (idx !== -1) {
    req.rawHeaders[idx + 1] = value;
  } else {
    req.rawHeaders.push('Accept', value);
  }
};

const openAiOAuthClientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
const enableOidcEmailClaims = Boolean(openAiOAuthClientId);
const oauthScopes = [
  ...(enableOidcEmailClaims ? ['openid', 'email'] : []),
  'mcp:read',
  'mcp:write',
];

export const startMcp = async (app: INestApplication) => {
  const mastraService = app.get(MastraService, { strict: false });
  const organizationService = app.get(OrganizationService, { strict: false });
  const oauthService = app.get(OAuthService, { strict: false });
  const subscriptionService = app.get(SubscriptionService, { strict: false });

  // needs_trial and locked workspaces get no MCP tool calls (mcp.plan.gate.ts):
  // every endpoint connects and refuses each tool call with the reason and
  // the link to start the trial.
  const planRefusalOf = (org: { id?: string } | null | undefined) =>
    mcpPlanRefusal(
      (id) => subscriptionService.planGate(id),
      org,
      (id) => subscriptionService.trialDaysFor(id)
    );

  const resolveAuth = async (token: string) => {
    if (token.startsWith('pos_')) {
      const authorization = await oauthService.getOrgByOAuthToken(token);
      if (!authorization) return null;
      return authorization.organization;
    }
    return organizationService.getOrgByApiKey(token);
  };

  const mastra = await mastraService.mastra();
  const agent = mastra.getAgent('hookpost');
  const tools = await agent.listTools();

  // The Claude connector directory does not accept AI media generation tools,
  // so the directory-facing endpoint hides them. Direct connections
  // (/mcp, /mcp/:id, /sse/:id) and the ChatGPT app keep the full toolset.
  const claudeHiddenTools = [
    'generateImageTool',
    'generateVideoTool',
    'generateVideoOptions',
    'videoFunctionTool',
  ];
  const claudeTools = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !claudeHiddenTools.includes(name))
  ) as typeof tools;

  const serverConfig = {
    name: 'Hookpost MCP',
    version: '1.0.0',
    tools,
    // ask_hookpost runs the model: one ai_text credit per question, as in the
    // app (mcp.plan.gate.ts meterAgentByCredits).
    agents: {
      hookpost: meterAgentByCredits(agent, (organizationId, run) =>
        subscriptionService.useCreditForOrganizationId(
          organizationId,
          'ai_text',
          run
        )
      ),
    },
  };

  const server = new MCPServer(serverConfig);

  // The directory-facing servers don't register the agent - it would be
  // exposed as an annotation-less catch-all ask_hookpost tool, which the
  // ChatGPT and Claude directory reviews reject
  // Their tools refuse a workspace without a plan one call at a time
  // (gateToolsByPlan) instead of failing the connector with a bare 402.
  const oauthServer = new MCPServer({
    name: 'Hookpost MCP',
    version: '1.0.0',
    tools: gateToolsByPlan(tools),
  });

  const claudeOauthServer = new MCPServer({
    name: 'Hookpost MCP',
    version: '1.0.0',
    tools: gateToolsByPlan(claudeTools),
  });

  // The API-key endpoints (/mcp, /mcp/:key, /sse/:key) for a workspace
  // without a plan: the same tools, each refusing with the reason, and no
  // agent (ask_hookpost would run the model before any tool is called).
  // A workspace with a plan keeps `server` (tools and agent) as before.
  const gatedKeyConfig = {
    name: 'Hookpost MCP',
    version: '1.0.0',
    tools: gateToolsByPlan(tools),
  };
  const gatedKeyServer = new MCPServer(gatedKeyConfig);

  const oauthResource = new URL('/mcp-oauth', process.env.NEXT_PUBLIC_BACKEND_URL!).toString();
  const oauthMiddleware = createOAuthMiddleware({
    oauth: {
      resource: oauthResource,
      authorizationServers: [oauthResource],
      scopesSupported: oauthScopes,
      validateToken: async (token: string) => {
        const org = await resolveAuth(token);
        if (!org) {
          return { valid: false, error: 'invalid_token', errorDescription: 'Invalid API Key or OAuth token' };
        }
        return { valid: true, subject: token };
      },
    },
    mcpPath: '/mcp-oauth',
  });

  // Same authorization server as /mcp-oauth, only the protected resource differs
  const claudeOauthResource = new URL('/mcp-oauth-claude', process.env.NEXT_PUBLIC_BACKEND_URL!).toString();
  const claudeOauthMiddleware = createOAuthMiddleware({
    oauth: {
      resource: claudeOauthResource,
      authorizationServers: [oauthResource],
      scopesSupported: oauthScopes,
      validateToken: async (token: string) => {
        const org = await resolveAuth(token);
        if (!org) {
          return { valid: false, error: 'invalid_token', errorDescription: 'Invalid API Key or OAuth token' };
        }
        return { valid: true, subject: token };
      },
    },
    mcpPath: '/mcp-oauth-claude',
  });

  // OpenAI's domain check for the ChatGPT apps directory: the exact token from
  // the OpenAI Platform dashboard, as plain text. nginx sends this one path to
  // the backend (nginx.hookpost.conf); unset, it stays a 404.
  const openAiAppChallenge = process.env.OPENAI_APP_CHALLANGE?.trim();
  if (openAiAppChallenge) {
    app.use('/.well-known/openai-apps-challenge', (req: Request, res: Response, next: () => void) => {
      if (req.path !== '/' && req.path !== '') {
        next();
        return;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(openAiAppChallenge);
    });
  }

  app.use('/.well-known/oauth-protected-resource', async (req: Request, res: Response, next: () => void) => {
    // Only the /mcp-oauth and /mcp-oauth-claude resources are OAuth-protected.
    // Answering discovery on any other path (including the root, which clients
    // fall back to) makes them demand OAuth for /mcp/:id too
    if (req.path !== '/mcp-oauth' && req.path !== '/mcp-oauth-claude') {
      next();
      return;
    }

    const url = new URL('/.well-known/oauth-protected-resource', process.env.NEXT_PUBLIC_BACKEND_URL);
    const middleware = req.path === '/mcp-oauth-claude' ? claudeOauthMiddleware : oauthMiddleware;
    await middleware(req, res, url);
  });

  app.use('/.well-known/oauth-authorization-server', async (req: Request, res: Response, next: () => void) => {
    if (req.path !== '/mcp-oauth') {
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'max-age=3600');
    res.json({
      // RFC 8414: metadata served at /.well-known/oauth-authorization-server/mcp-oauth
      // belongs to the path-based issuer <backend>/mcp-oauth
      issuer: oauthResource,
      authorization_endpoint: `${process.env.FRONTEND_URL}/oauth/authorize`,
      token_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/token`,
      registration_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/register`,
      ...(enableOidcEmailClaims && {
        userinfo_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/userinfo`,
      }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: oauthScopes,
    });
  });

  app.use('/.well-known/openid-configuration', async (req: Request, res: Response, next: () => void) => {
    if (req.path !== '/mcp-oauth' || !enableOidcEmailClaims) {
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'max-age=3600');
    res.json({
      issuer: oauthResource,
      authorization_endpoint: `${process.env.FRONTEND_URL}/oauth/authorize`,
      token_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/token`,
      registration_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/register`,
      userinfo_endpoint: `${process.env.NEXT_PUBLIC_OVERRIDE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/userinfo`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: oauthScopes,
      subject_types_supported: ['public'],
      claims_supported: ['sub', 'email', 'email_verified'],
    });
  });

  app.use('/mcp-oauth', async (req: Request, res: Response, next: () => void) => {
    // Skip if this is the /mcp/:id route
    if (req.path !== '/' && req.path !== '') {
      next();
      return;
    }

    const url = new URL('/mcp-oauth', process.env.NEXT_PUBLIC_BACKEND_URL);

    const result = await oauthMiddleware(req, res, url);
    if (!result.proceed) return;

    const token = result.tokenValidation?.subject;
    const auth = await resolveAuth(token!);
    if (!auth) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Could not resolve organization' });
      return;
    }
    const planRefusal = await planRefusalOf(auth);

    fixAcceptHeader(req);
    await runWithContext({ requestId: token!, auth, planRefusal }, async () => {
      await oauthServer.startHTTP({
        url: url,
        httpPath: url.pathname,
        options: {
          serverless: true,
          enableJsonResponse: true,
        },
        req,
        res,
      });
    });
  });

  app.use('/mcp-oauth-claude', async (req: Request, res: Response, next: () => void) => {
    // Skip if this is the /mcp/:id route
    if (req.path !== '/' && req.path !== '') {
      next();
      return;
    }

    const url = new URL('/mcp-oauth-claude', process.env.NEXT_PUBLIC_BACKEND_URL);

    const result = await claudeOauthMiddleware(req, res, url);
    if (!result.proceed) return;

    const token = result.tokenValidation?.subject;
    const auth = await resolveAuth(token!);
    if (!auth) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Could not resolve organization' });
      return;
    }
    const planRefusal = await planRefusalOf(auth);

    fixAcceptHeader(req);
    await runWithContext({ requestId: token!, auth, planRefusal }, async () => {
      await claudeOauthServer.startHTTP({
        url: url,
        httpPath: url.pathname,
        options: {
          serverless: true,
          enableJsonResponse: true,
        },
        req,
        res,
      });
    });
  });

  app.use('/mcp', async (req: Request, res: Response, next: () => void) => {
    // Skip if this is the /mcp/:id route
    if (req.path !== '/' && req.path !== '') {
      next();
      return;
    }

    // @ts-ignore
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    // Authorization: Bearer <key>, or x-hookpost-api-key when a gateway
    // (Smithery) reserves Authorization. Authorization wins if both are sent.
    const token = mcpTokenFromHeaders(req.headers);
    if (!token) {
      res.status(401).send('Missing Authorization header');
      return;
    }

    // @ts-ignore
    req.auth = await resolveAuth(token);
    // @ts-ignore
    if (!req.auth) {
      res.status(401).send('Invalid API Key or OAuth token');
      return;
    }
    // @ts-ignore
    const planRefusal = await planRefusalOf(req.auth);

    const url = new URL('/mcp', process.env.NEXT_PUBLIC_BACKEND_URL);

    fixAcceptHeader(req);
    // @ts-ignore
    await runWithContext({ requestId: token, auth: req.auth, planRefusal }, async () => {
      await (planRefusal ? gatedKeyServer : server).startHTTP({
        url,
        httpPath: url.pathname,
        options: {
          serverless: true,
          enableJsonResponse: true,
        },
        req,
        res,
      });
    });
  });

  app.use('/mcp/:id', async (req: Request, res: Response) => {
    // @ts-ignore
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    // @ts-ignore
    req.auth = await organizationService.getOrgByApiKey(req.params.id);
    // @ts-ignore
    if (!req.auth) {
      res.status(400).send('Invalid API Key');
      return;
    }
    // @ts-ignore
    const planRefusal = await planRefusalOf(req.auth);

    const url = new URL(
      `/mcp/${req.params.id}`,
      process.env.NEXT_PUBLIC_BACKEND_URL
    );

    fixAcceptHeader(req);
    await runWithContext(
      // @ts-ignore
      { requestId: req.params.id, auth: req.auth, planRefusal },
      async () => {
        await (planRefusal ? gatedKeyServer : server).startHTTP({
          url,
          httpPath: url.pathname,
          options: {
            serverless: true,
            enableJsonResponse: true,
          },
          req,
          res,
        });
      }
    );
  });

  app.use(['/sse/:id', '/message/:id'], async (req: Request, res: Response) => {
    // @ts-ignore
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    // @ts-ignore
    req.auth = await organizationService.getOrgByApiKey(req.params.id);
    // @ts-ignore
    if (!req.auth) {
      res.status(400).send('Invalid API Key');
      return;
    }
    // @ts-ignore
    const planRefusal = await planRefusalOf(req.auth);

    const url = new URL(req.originalUrl, process.env.NEXT_PUBLIC_BACKEND_URL);

    await runWithContext(
      // @ts-ignore
      { requestId: req.params.id, auth: req.auth, planRefusal },
      async () => {
        await new MCPServer(planRefusal ? gatedKeyConfig : serverConfig).startSSE({
          url,
          ssePath: `/sse/${req.params.id}`,
          messagePath: `/message/${req.params.id}`,
          req,
          res,
        });
      }
    );
  });
};
