import 'reflect-metadata';

// PostActivity.sendPostReminder, what postWorkflowV114 runs for a "Remind me
// to post" post: one reminder per post, by email to the whole workspace and
// in-app, and nothing ever sent to the platform.
//   pnpm exec jest -c apps/backend/jest.config.ts post.reminder.activity

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service', () => ({
  WebhooksService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

let attempt = 1;
jest.mock('@temporalio/activity', () => ({
  ...jest.requireActual('@temporalio/activity'),
  Context: { current: () => ({ info: { attempt }, heartbeat: () => undefined }) },
}));

import { PostActivity } from './post.activity';

const ORG = 'org-1';
const reminder = {
  id: 'post-1',
  state: 'REMINDER_SENT',
  remind: true,
  caption: 'Sunset reel #travel',
  comments: ['link in bio'],
  media: [{ url: 'https://media.example/reel.mp4', video: true }],
  integration: { name: 'Sacred Smiles', providerIdentifier: 'instagram' },
  platform: 'Instagram',
  appLink: { name: 'Instagram', app: 'instagram://app', web: 'https://www.instagram.com/' },
};

const setup = (
  opts: { claim?: boolean; emailFails?: boolean; inAppFails?: boolean; current?: any } = {}
) => {
  const postsService = {
    claimReminder: jest.fn(async () => opts.claim ?? true),
    releaseReminder: jest.fn(async () => ({ count: 1 })),
    getReminder: jest.fn(async () => opts.current ?? reminder),
  };
  const notificationService = {
    sendEmailsToOrg: jest.fn(async () => {
      if (opts.emailFails) throw new Error('Temporal unavailable');
    }),
    inAppNotification: jest.fn(async () => {
      if (opts.inAppFails) throw new Error('db down');
    }),
  };
  const provider = { post: jest.fn(), postPending: jest.fn() };
  const activity = new PostActivity(
    postsService as any,
    notificationService as any,
    { getSocialIntegration: jest.fn(() => provider) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { activity, postsService, notificationService, provider };
};

beforeEach(() => {
  attempt = 1;
  process.env.FRONTEND_URL = 'https://app.example.test';
});

describe('sendPostReminder', () => {
  it('emails the whole workspace the caption, the files and the reminder page', async () => {
    const { activity, notificationService, provider } = setup();

    await expect(activity.sendPostReminder(ORG, 'post-1')).resolves.toBe(true);

    expect(notificationService.sendEmailsToOrg).toHaveBeenCalledTimes(1);
    const [org, subject, html, type] = (notificationService.sendEmailsToOrg.mock
      .calls[0] as unknown) as [string, string, string, string];
    expect(org).toBe(ORG);
    expect(subject).toBe('Time to post on Instagram: Sacred Smiles');
    // 'info' ignores the success/failure preferences: the reminder is the post
    expect(type).toBe('info');
    expect(html).toContain('Sunset reel #travel');
    expect(html).toContain('link in bio');
    expect(html).toContain('href="https://media.example/reel.mp4"');
    expect(html).toContain('https://app.example.test/reminder/post-1');
    expect(provider.post).not.toHaveBeenCalled();
    expect(provider.postPending).not.toHaveBeenCalled();
  });

  it('adds an in-app notification linking to the reminder page, without a second email', async () => {
    const { activity, notificationService } = setup();
    await activity.sendPostReminder(ORG, 'post-1');
    expect(notificationService.inAppNotification).toHaveBeenCalledWith(
      ORG,
      'Time to post on Instagram: Sacred Smiles',
      expect.stringContaining('https://app.example.test/reminder/post-1'),
      false,
      false,
      'info'
    );
  });

  it('sends nothing when the reminder was already sent or the post was marked as posted', async () => {
    const { activity, notificationService, postsService } = setup({ claim: false });
    await expect(activity.sendPostReminder(ORG, 'post-1')).resolves.toBe(false);
    expect(postsService.getReminder).not.toHaveBeenCalled();
    expect(notificationService.sendEmailsToOrg).not.toHaveBeenCalled();
    expect(notificationService.inAppNotification).not.toHaveBeenCalled();
  });

  it('puts the post back in the queue when the email cannot be sent, so the retry sends it', async () => {
    const { activity, postsService } = setup({ emailFails: true });
    await expect(activity.sendPostReminder(ORG, 'post-1')).rejects.toThrow(
      'Temporal unavailable'
    );
    expect(postsService.releaseReminder).toHaveBeenCalledWith(ORG, 'post-1');
  });

  // The worker died after the claim and before the email: Temporal retries,
  // the claim finds REMINDER_SENT, and the reminder still goes out once
  it('a retry after a crash between the claim and the email still sends it', async () => {
    attempt = 2;
    const { activity, notificationService } = setup({ claim: false });
    await expect(activity.sendPostReminder(ORG, 'post-1')).resolves.toBe(true);
    expect(notificationService.sendEmailsToOrg).toHaveBeenCalledTimes(1);
  });

  it('a retry sends nothing once the user marked it as posted, or for an auto-publish post', async () => {
    attempt = 2;
    for (const current of [
      { ...reminder, state: 'POSTED_MANUALLY' },
      { ...reminder, state: 'QUEUE' },
      { ...reminder, state: 'REMINDER_SENT', remind: false },
    ]) {
      const { activity, notificationService } = setup({ claim: false, current });
      await expect(activity.sendPostReminder(ORG, 'post-1')).resolves.toBe(false);
      expect(notificationService.sendEmailsToOrg).not.toHaveBeenCalled();
    }
  });

  it('a failed in-app notification after the email does not resend it', async () => {
    const { activity, postsService } = setup({ inAppFails: true });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(activity.sendPostReminder(ORG, 'post-1')).resolves.toBe(true);
    expect(postsService.releaseReminder).not.toHaveBeenCalled();
  });
});
