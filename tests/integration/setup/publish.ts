/**
 * Publishes a saved post the way postWorkflowV114 does, without Temporal:
 * the orchestrator's real PostActivity (getPostsList, postSocial,
 * postComment, updatePost) on the backend's own services, so the plan checks
 * it runs before every publish (SubscriptionService.publishWithinPlan, the
 * marketplace re-check among them) are the real ones. Only the network's
 * own post and comment calls are replaced, by the caller, on the provider.
 *
 * Shared by the integration suite and the E2E backend's control port.
 */
import { TemporalService } from 'nestjs-temporal-core';
import { PostActivity } from '@hookpost/orchestrator/activities/post.activity';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { WebhooksService } from '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { XPostCapService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';

export interface Resolver {
  get<T>(token: any): T;
}

export async function publishLikeTheWorkflow(
  t: Resolver,
  organizationId: string,
  postId: string
): Promise<{ published: boolean; error?: string }> {
  const posts = t.get<PostsService>(PostsService);
  const activity = new PostActivity(
    posts,
    t.get(NotificationService),
    t.get(IntegrationManager),
    t.get(IntegrationService),
    t.get(RefreshIntegrationService),
    t.get(WebhooksService),
    t.get(TemporalService),
    t.get(SubscriptionService),
    t.get(XPostCapService)
  );
  const [root, ...comments] = (await activity.getPostsList(organizationId, postId)) as any[];
  if (!root) return { published: false, error: 'no post' };
  const integration = root.integration;
  const results: any[] = [];
  try {
    results.push(...(await activity.postSocial(integration, [root])));
    await activity.updatePost(root.id, results[0].postId, results[0].releaseURL);
    for (let i = 0; i < comments.length; i++) {
      results.push(
        ...(await activity.postComment(
          results[0].postId,
          results.length === 1 ? undefined : results[results.length - 1].postId,
          integration,
          [comments[i]]
        ))
      );
      await activity.updatePost(comments[i].id, results[i + 1].postId, results[i + 1].releaseURL);
    }
    return { published: true };
  } catch (err: any) {
    // What the workflow does with a BadBody: the post goes to ERROR with it.
    await posts.changeState(root.id, 'ERROR', err?.message || String(err));
    return { published: false, error: err?.message || String(err) };
  }
}
