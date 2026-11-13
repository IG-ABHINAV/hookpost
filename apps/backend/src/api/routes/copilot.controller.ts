import {
  Logger,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  Param,
} from '@nestjs/common';
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { MastraAgent } from '@ag-ui/mastra';
import { MastraService } from '@hookpost/nestjs-libraries/chat/mastra.service';
import { Request, Response } from 'express';
import { RequestContext } from '@mastra/core/di';
import { CheckPolicies } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import { copilotRequestIsBillable } from '@hookpost/nestjs-libraries/chat/copilot.billable';
import { aiConfigured } from '@hookpost/nestjs-libraries/openai/ai.provider';
import { copilotServiceAdapter } from '@hookpost/nestjs-libraries/chat/copilot.adapter';

/**
 * One CopilotKit endpoint for the process, built on the first request. It
 * used to be built on every request, the page-load handshake included, and
 * building it (a GraphQL server and its schema) is synchronous: measured on
 * the production VM at 60-260 ms of blocked event loop per page load, which
 * every request in flight beside it - the calendar's /integrations/list
 * among them - waited out. The runtime and the adapter hold no per-request
 * state: the organisation is checked above, before the handler is reached.
 */
let chatHandler: ReturnType<typeof copilotRuntimeNodeHttpEndpoint> | undefined;
export const copilotChatHandler = () =>
  (chatHandler ??= copilotRuntimeNodeHttpEndpoint({
    endpoint: '/copilot/chat',
    runtime: new CopilotRuntime(),
    serviceAdapter: copilotServiceAdapter(),
  }));

export type ChannelsContext = {
  integrations: string;
  organization: string;
  ui: string;
};

@Controller('/copilot')
export class CopilotController {
  constructor(
    private _subscriptionService: SubscriptionService,
    private _mastraService: MastraService
  ) {}
  @Post('/chat')
  async chatAgent(
    @GetOrgFromRequest() organization: Organization,
    @Req() req: Request,
    @Res() res: Response
  ) {
    // CopilotKit talks to this one URL for everything, including the handshake
    // it fires on EVERY app page load - it is mounted around the whole layout
    // in new-layout/layout.component.tsx. Charging a credit for that had two
    // consequences, both bad:
    //
    //   1. Opening the calendar spent an AI credit even if nobody typed.
    //   2. Once the allowance hit zero - immediately, on FREE, which has
    //      ai_generation_count: 0 - the handshake 402'd, CopilotKit errored,
    //      and since it wraps the entire layout the channels sidebar and the
    //      Create Post button never rendered. The calendar just span forever
    //      while the database had 17 healthy channels.
    //
    // Only a real generation is billable. CopilotKit's GraphQL operation for
    // that is generateCopilotResponse; availableAgents and loadAgentState are
    // discovery calls that must stay free and must never 402, or the app is
    // unusable for anyone without an AI quota. Anything that is not one of
    // those two is billable (copilotRequestIsBillable).
    // Without an AI provider only a generation is refused; the handshake
    // still answers so the layout renders.
    if (copilotRequestIsBillable(req.body)) {
      if (!aiConfigured('text')) {
        Logger.warn(
          'AI provider not configured, chat functionality will not work'
        );
        res
          .status(503)
          .json({ message: 'AI is not configured on this server' });
        return;
      }
      await this.consumeTextCredit(organization);
    }

    return copilotChatHandler()(req, res);
  }

  // Records one AI-text credit, or refuses when the plan's monthly allowance
  // is spent. Throwing SubscriptionException matches how the image and video
  // quotas already report themselves to the frontend.
  private async consumeTextCredit(organization: Organization) {
    const { credits, paymentFailing } =
      await this._subscriptionService.checkCredits(organization, 'ai_text');

    if (paymentFailing) {
      throw new SubscriptionException({
        action: AuthorizationActions.Create,
        section: Sections.AI_GENERATIONS,
        paymentFailing: true,
      });
    }

    if (credits <= 0) {
      // What the 402 offers, decided where checkout decides it
      // (SubscriptionService.trialOfferFor): the trial by its length, when a
      // checkout would start one; read from the workspace's own billing
      // facts, since this path has no request country.
      const { trialDays, freePosts, trialOffered } =
        await this._subscriptionService.trialOfferFor(
          organization.id,
          organization.allowTrial
        );
      throw new SubscriptionException({
        action: AuthorizationActions.Create,
        section: Sections.AI_GENERATIONS,
        ...(trialDays ? { trialDays } : {}),
        ...(freePosts !== undefined ? { freePosts } : {}),
        ...(trialOffered !== undefined ? { trialOffered } : {}),
      });
    }

    await this._subscriptionService.useCredit(
      organization,
      'ai_text',
      async () => true
    );
  }

  @Post('/agent')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async agent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (!aiConfigured('agent')) {
      Logger.warn(
        'AI provider not configured, chat functionality will not work'
      );
      res.status(503).json({ message: 'AI is not configured on this server' });
      return;
    }

    // Sections.AI above is only a boolean feature flag, so it lets a plan use
    // the agent but does not bound how much. The credit meter does.
    await this.consumeTextCredit(organization);

    const mastra = await this._mastraService.mastra();
    const requestContext = new RequestContext<ChannelsContext>();
    requestContext.set(
      'integrations',
      req?.body?.variables?.properties?.integrations || []
    );

    requestContext.set('organization', JSON.stringify(organization));
    requestContext.set('ui', 'true');

    const agents = MastraAgent.getLocalAgents({
      resourceId: organization.id,
      mastra,
      requestContext: requestContext as any,
    });

    const runtime = new CopilotRuntime({
      agents,
    });

    const copilotRuntimeHandler = copilotRuntimeNextJSAppRouterEndpoint({
      endpoint: '/copilot/agent',
      runtime,
      // properties: req.body.variables.properties,
      serviceAdapter: copilotServiceAdapter(),
    });

    return copilotRuntimeHandler.handleRequest(req, res);
  }

  @Get('/credits')
  calculateCredits(
    @GetOrgFromRequest() organization: Organization,
    @Query('type') type: 'ai_images' | 'ai_videos' | 'ai_text'
  ) {
    return this._subscriptionService.checkCredits(
      organization,
      type || 'ai_images'
    );
  }

  @Get('/:thread/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getMessagesList(
    @GetOrgFromRequest() organization: Organization,
    @Param('thread') threadId: string
  ): Promise<any> {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('hookpost').getMemory();
    try {
      return await memory.recall({
        resourceId: organization.id,
        threadId,
      });
    } catch (err) {
      Logger.warn(`Could not recall messages for thread ${threadId}: ${err}`);
      return { messages: [] };
    }
  }

  @Get('/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getList(@GetOrgFromRequest() organization: Organization) {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('hookpost').getMemory();
    const list = await memory.listThreads({
      filter: { resourceId: organization.id },
      perPage: 100000,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });

    return {
      threads: list.threads.map((p) => ({
        id: p.id,
        title: p.title,
      })),
    };
  }
}
