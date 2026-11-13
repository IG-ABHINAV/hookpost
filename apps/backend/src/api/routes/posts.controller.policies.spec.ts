import 'reflect-metadata';

// Which plan limits each post-creating route checks (PoliciesGuard reads this
// metadata). The generator runs the AI agent, so it needs the plan's AI
// feature, which the Free plan does not have.
//   pnpm exec jest -c apps/backend/jest.config.ts posts.controller.policies

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({
    PostsService: class {},
  })
);
jest.mock('@hookpost/nestjs-libraries/agent/agent.graph.service', () => ({
  AgentGraphService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/short-linking/short.link.service',
  () => ({
    ShortLinkService: class {},
  })
);

import { PostsController } from '@hookpost/backend/api/routes/posts.controller';
import { CHECK_POLICIES_KEY } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';

const policies = (method: keyof PostsController) =>
  Reflect.getMetadata(CHECK_POLICIES_KEY, PostsController.prototype[method]);

describe('PostsController plan checks', () => {
  it('creating a post checks posts_per_month', () => {
    expect(policies('createPost')).toEqual([
      [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
    ]);
  });

  it('the AI generator checks posts_per_month and the AI feature', () => {
    expect(policies('generatePosts')).toEqual([
      [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
      [AuthorizationActions.Create, Sections.AI],
    ]);
  });

  // Moving a post with action 'schedule' requeues it (re-review of
  // f77349f66): plan access, not the monthly post count, since moving
  // creates no post.
  it('moving a post (PUT /posts/:id/date) checks plan access', () => {
    expect(policies('changeDate')).toEqual([
      [AuthorizationActions.Update, Sections.PLAN_ACCESS],
    ]);
  });

  // An OpenAI call: it had no plan check at all, so a workspace that had
  // not started its trial could spend OpenAI credit through it.
  it('splitting a post with AI (separate-posts) checks the AI feature', () => {
    expect(policies('separatePosts')).toEqual([
      [AuthorizationActions.Create, Sections.AI],
    ]);
  });

  // Every route that writes a post or calls a model carries a plan check:
  // PoliciesGuard refuses each of them with 402 TRIAL_REQUIRED for a
  // workspace that has not started its trial.
  it('no post-writing or AI route is left without a plan check', () => {
    for (const method of [
      'createPost',
      'generatePostsDraft',
      'generatePosts',
      'separatePosts',
    ] as const) {
      expect([method, (policies(method) || []).length > 0]).toEqual([
        method,
        true,
      ]);
    }
  });
});
