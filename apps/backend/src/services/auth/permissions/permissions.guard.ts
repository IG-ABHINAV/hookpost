import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppAbility,
  PermissionsService,
} from '@hookpost/backend/services/auth/permissions/permissions.service';
import {
  AbilityPolicy,
  CHECK_POLICIES_KEY,
} from '@hookpost/backend/services/auth/permissions/permissions.ability';
import { Organization } from '@prisma/client';
import { Request } from 'express';
import { Sections, SubscriptionException } from './permission.exception.class';
import { trustedCountry } from '@hookpost/nestjs-libraries/services/billing.currency';
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private _reflector: Reflector,
    private _authorizationService: PermissionsService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    if (
      request.path.indexOf('/auth') > -1 ||
      request.path.indexOf('/auth') > -1 ||
      request.path.indexOf('/integrations/social-connect') > -1 ||
      request.path.indexOf('/integrations/provider') > -1
    ) {
      return true;
    }

    const policyHandlers =
      this._reflector.get<AbilityPolicy[]>(
        CHECK_POLICIES_KEY,
        context.getHandler()
      ) || [];

    if (!policyHandlers || !policyHandlers.length) {
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    const { org }: { org: Organization } = request;

    const refreshChannelId = typeof request.query?.refresh === 'string' ? request.query.refresh : undefined;

    // The request's own country only matters for a workspace whose owner has
    // no signup country on file (trial.policy.ts).
    const { ability, gate, paymentFailing } =
      await this._authorizationService.evaluate(
        org.id,
        org.createdAt,
        // @ts-ignore
        org.users[0].role,
        policyHandlers,
        refreshChannelId,
        { requestCountry: trustedCountry(request.headers) }
      );

    const item = policyHandlers.find(
      (handler) => !this.execPolicyHandler(handler, ability)
    );

    if (item) {
      // What the 402 offers, decided where checkout decides it
      // (SubscriptionService.trialOfferFor): the trial's length (7 for a
      // workspace the Free plan sunset notice promised 7 to), and no trial on
      // the free posts unless the trial switch is on and nobody behind the
      // workspace has had one. Read from its own billing facts, not the
      // request's country (trial.policy.ts).
      const { trialDays, freePosts, trialOffered } =
        process.env.RAZORPAY_KEY_ID
          ? await this._authorizationService.trialOfferFor(org.id, org.allowTrial, {
              requestCountry: trustedCountry(request.headers),
            })
          : ({} as { trialDays?: number; freePosts?: boolean; trialOffered?: boolean });
      throw new SubscriptionException({
        section: item[1],
        action: item[0],
        ...(gate ? { code: gate } : {}),
        ...(trialDays ? { trialDays } : {}),
        ...(freePosts !== undefined ? { freePosts } : {}),
        ...(trialOffered !== undefined ? { trialOffered } : {}),
        ...(paymentFailing && item[1] === Sections.AI
          ? { paymentFailing: true }
          : {}),
      });
    }

    return true;
  }

  private execPolicyHandler(handler: AbilityPolicy, ability: AppAbility) {
    return ability.can(handler[0], handler[1]);
  }
}
