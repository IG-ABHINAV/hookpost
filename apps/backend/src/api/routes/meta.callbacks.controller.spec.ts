import 'reflect-metadata';
import { createHmac } from 'crypto';

// Meta's deauthorize and data-deletion callbacks. The services are fakes; the
// signed_request is built exactly the way Meta signs it.

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));

import { MetaCallbacksController } from './meta.callbacks.controller';

const SECRET = 'meta-app-secret-for-tests';
const FB_USER = '10221234567890123';

const signedRequest = (payload: object, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${signature}.${body}`;
};

const setup = () => {
  const channels = [
    { id: 'page-1', organizationId: 'org-a' },
    { id: 'page-2', organizationId: 'org-a' },
    { id: 'page-3', organizationId: 'org-b' },
  ];
  const integrations = {
    getChannelsConnectedByAccount: jest.fn(async () => channels),
    getPostsForChannel: jest.fn(async (_org: string, id: string) =>
      id === 'page-2' ? [{ group: 'g-1' }] : []
    ),
    deleteChannel: jest.fn(async () => ({})),
    eraseRemovedChannelProfile: jest.fn(async () => ({})),
    refreshNeeded: jest.fn(async () => ({})),
  };
  const posts = { deletePost: jest.fn(async () => ({ success: true })) };
  const controller = new MetaCallbacksController(integrations as any, posts as any);
  return { controller, integrations, posts };
};

const META = ['facebook', 'instagram', 'instagram-standalone', 'threads'];

beforeAll(() => {
  process.env.FACEBOOK_APP_SECRET = SECRET;
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
});

describe('MetaCallbacksController.dataDeletion', () => {
  it('removes every channel the Meta login connected, not just the first page', async () => {
    const { controller, integrations, posts } = setup();
    const answer = await controller.dataDeletion(signedRequest({ user_id: FB_USER }));

    expect(integrations.getChannelsConnectedByAccount).toHaveBeenCalledWith(META, FB_USER);
    expect(integrations.deleteChannel.mock.calls).toEqual([
      ['org-a', 'page-1'],
      ['org-a', 'page-2'],
      ['org-b', 'page-3'],
    ]);
    expect(integrations.eraseRemovedChannelProfile.mock.calls).toEqual([
      ['org-a', 'page-1'],
      ['org-a', 'page-2'],
      ['org-b', 'page-3'],
    ]);
    expect(posts.deletePost).toHaveBeenCalledWith('org-a', 'g-1');

    // The shape Meta requires: a status URL and a confirmation code.
    expect(answer.confirmation_code).toMatch(/^.{20}$/);
    expect(answer.url).toBe(
      `https://hookpost.hookstep.in/data-deletion?code=${answer.confirmation_code}`
    );
  });

  it('touches nothing when the signature does not verify, but still answers', async () => {
    const { controller, integrations } = setup();
    const answer = await controller.dataDeletion(
      signedRequest({ user_id: FB_USER }, 'some-other-secret')
    );
    expect(integrations.getChannelsConnectedByAccount).not.toHaveBeenCalled();
    expect(integrations.deleteChannel).not.toHaveBeenCalled();
    expect(answer.confirmation_code).toBeTruthy();
  });
});

describe('MetaCallbacksController.deauthorize', () => {
  it('flags every channel of the login for reconnection', async () => {
    const { controller, integrations } = setup();
    await expect(
      controller.deauthorize(signedRequest({ user_id: FB_USER }))
    ).resolves.toEqual({ ok: true });
    expect(integrations.refreshNeeded.mock.calls).toEqual([
      ['org-a', 'page-1'],
      ['org-a', 'page-2'],
      ['org-b', 'page-3'],
    ]);
    expect(integrations.deleteChannel).not.toHaveBeenCalled();
  });
});
