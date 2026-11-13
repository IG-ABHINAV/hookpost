import 'reflect-metadata';

// The controller's own type check, with a PostsService that would accept any
// type at all: PostsService.createPost checks it again, so an integration
// test cannot tell whether this one works (re-review of f77349f66).
//
// The controller is only constructed here, so its service modules (the
// integration manager loads every social provider, some ESM-only) are
// stand-ins; post.types.ts, the list the check uses, is the real one.
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@hookpost/nestjs-libraries/upload/custom.upload.validation', () => ({
  CustomFileValidationPipe: class {
    transform(value: unknown) {
      return value;
    }
  },
  getMaxSize: () => 0,
}));
jest.mock('@hookpost/nestjs-libraries/upload/upload.allowlist', () => ({
  MEDIA_UPLOAD_MIME: [],
  sniffUpload: jest.fn(),
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/media/media.service', () => ({
  MediaService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/notifications/notification.service', () => ({
  NotificationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({
  socialIntegrationList: [],
  IntegrationManager: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/social.abstract', () => ({
  RefreshToken: class extends Error {},
}));
jest.mock('@hookpost/nestjs-libraries/chat/validation.schemas.helper', () => ({
  getValidationSchemas: jest.fn(),
}));
jest.mock('@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  ssrfSafeDispatcher: {},
}));
jest.mock('@hookpost/backend/services/auth/super.admin.guard', () => ({
  SuperAdminGuard: class {},
}));
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));

import { HttpException } from '@nestjs/common';
import { PublicIntegrationsController } from '@hookpost/backend/public-api/routes/v1/public.integrations.controller';

const setup = () => {
  const postsService = {
    mapTypeToPost: jest.fn(async (body: any) => ({ ...body, type: 'schedule' })),
    validatePosts: jest.fn(async () => []),
    createPost: jest.fn(async () => [{ postId: 'p-1' }]),
  };
  const controller = new PublicIntegrationsController(
    {} as any,
    postsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { controller, postsService };
};
const body = (type?: unknown) => ({
  ...(type === undefined ? {} : { type }),
  date: '2026-10-30T10:00:00Z',
  shortLink: false,
  tags: [],
  posts: [{ integration: { id: 'int-1' }, value: [{ content: 'hi', image: [] }], settings: {} }],
});
const org = { id: 'org-a' } as any;

describe('PublicIntegrationsController.createPost: type', () => {
  it.each([undefined, 'whatever', '', null, 'DRAFT', ['schedule'], { type: 'now' }])(
    'refuses %p with a 400 before anything is mapped or saved',
    async (type) => {
      const { controller, postsService } = setup();
      const attempt = controller.createPost(org, body(type));
      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({ status: 400 });
      expect(postsService.mapTypeToPost).not.toHaveBeenCalled();
      expect(postsService.createPost).not.toHaveBeenCalled();
    }
  );

  it.each(['draft', 'schedule', 'now', 'update'])('passes %s on, as sent', async (type) => {
    const { controller, postsService } = setup();
    await controller.createPost(org, body(type));
    expect(postsService.createPost).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({ type }),
      'API'
    );
  });
});

// Final review of 733294f78: removing the plan check from the public status
// change left every test green. No request reaches it today (the public API
// refuses a workspace without a live plan row, and a live row is never a
// blocked plan state), so the decorator itself is what is pinned.
describe('PublicIntegrationsController plan checks', () => {
  const { CHECK_POLICIES_KEY } = jest.requireActual(
    '@hookpost/backend/services/auth/permissions/permissions.ability'
  );
  const { AuthorizationActions, Sections } = jest.requireActual(
    '@hookpost/backend/services/auth/permissions/permission.exception.class'
  );
  const policies = (method: keyof PublicIntegrationsController) =>
    Reflect.getMetadata(CHECK_POLICIES_KEY, PublicIntegrationsController.prototype[method]);

  it("changing a post's status (it can requeue a draft) checks plan access", () => {
    expect(policies('changePostStatus')).toEqual([[AuthorizationActions.Update, Sections.PLAN_ACCESS]]);
  });

  it('creating a post checks posts_per_month', () => {
    expect(policies('createPost')).toEqual([[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]]);
  });
});
