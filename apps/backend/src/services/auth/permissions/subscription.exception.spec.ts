import 'reflect-metadata';

// What a Free workspace reads in the 402 dialog when it opens the AI Agent.
// The Free plan has no AI, so "You have reached a limit of your plan" (the
// frontend's fallback for a 402 with no message) was wrong: 8 of the 12 real
// sign-ups from 6 to 18 Oct got it, minutes after signing up.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.exception

import { SubscriptionExceptionFilter } from '@hookpost/backend/services/auth/permissions/subscription.exception';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';

const respond = (section: Sections, org: any) => {
  const json = jest.fn();
  const response = { status: jest.fn(() => ({ json })) };
  new SubscriptionExceptionFilter().catch(
    new SubscriptionException({ section, action: AuthorizationActions.Create }),
    {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ org }),
      }),
    } as any
  );
  return {
    status: (response.status.mock.calls[0] as any)[0],
    body: (json.mock.calls[0] as any)[0],
  };
};

// Covers the AI Agent and AI writing in the composer (copilot.controller.ts
// throws AI_GENERATIONS there), so it names both.
const AI_LEAD =
  /^AI writing and the AI Agent are on the paid plans\. You can still write and schedule posts yourself\. /;

describe('SubscriptionExceptionFilter, AI on the Free plan', () => {
  it('says the AI Agent is a paid feature and offers the trial', () => {
    const { status, body } = respond(Sections.AI, {
      subscription: null,
      allowTrial: true,
    });
    expect(status).toBe(402);
    expect(body.message).toMatch(AI_LEAD);
    expect(body.message).toMatch(/Start a 3-day free trial of Standard/);
    expect(body.message).not.toMatch(/reached|limit/i);
    expect(body.trial).toBe(true);
  });

  it('without a trial left, points at the upgrade instead', () => {
    const { body } = respond(Sections.AI, {
      subscription: null,
      allowTrial: false,
    });
    expect(body.message).toMatch(AI_LEAD);
    expect(body.message).toMatch(/Upgrade to Standard/);
    expect(body.trial).toBe(false);
  });

  it('the AI chat credit check on Free (0 generations) reads the same', () => {
    const { body } = respond(Sections.AI_GENERATIONS, {
      subscription: null,
      allowTrial: true,
    });
    expect(body.message).toMatch(AI_LEAD);
  });

  it('the channel and post limits keep their own Free messages', () => {
    expect(
      respond(Sections.CHANNEL, { subscription: null, allowTrial: true }).body
        .message
    ).toMatch(/^The Free plan includes 2 channels/);
    expect(
      respond(Sections.POSTS_PER_MONTH, {
        subscription: null,
        allowTrial: false,
      }).body.message
    ).toMatch(/posts on the Free plan this month/);
  });

  it('a paid plan out of posts keeps the generic paid message', () => {
    const { body } = respond(Sections.POSTS_PER_MONTH, {
      subscription: { subscriptionTier: 'STANDARD' },
      allowTrial: false,
    });
    expect(body.message).toMatch(
      /maximum number of posts for your subscription/
    );
  });
});

// 28 Oct 2026: a new sign-up is on its free posts and its checkout has no
// trial, so a Free limit it meets offers the upgrade, never a trial.
describe('SubscriptionExceptionFilter, a workspace on its free posts', () => {
  const ENV = { ...process.env };
  // The trial switch off, as in production; its own block below turns it on.
  beforeEach(() => {
    process.env.TRIAL_CHECKOUT = 'off';
  });
  afterAll(() => {
    process.env = ENV;
  });
  const respondFrom = (
    org: any,
    country = 'IN',
    extra: { freePosts?: boolean; trialOffered?: boolean } = {},
    section: Sections = Sections.CHANNEL
  ) => {
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new SubscriptionExceptionFilter().catch(
      new SubscriptionException({ section, action: AuthorizationActions.Create, ...extra }),
      {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => ({ org, headers: { 'cf-ipcountry': country } }),
        }),
      } as any
    );
    return (json.mock.calls[0] as any)[0];
  };

  it('offers the upgrade, not a trial', () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const body = respondFrom({
      id: 'org',
      createdAt: new Date('2026-10-25T00:00:00Z'),
      allowTrial: true,
      subscription: null,
    });
    expect(body.message).toMatch(/Upgrade to Standard/);
    expect(body.message).not.toMatch(/trial/i);
    expect(body.message).not.toMatch(/Free plan/);
    expect(body.message).toMatch(/^Your free posts include 2 channels\./);
    expect(body.trial).toBe(false);
  });

  // 1 Nov 2026: the request's country is not the workspace's. An Indian
  // owner's MCP call arrives from a US server; with the GLOBAL cutoff not
  // applied (USD rail off) that request alone read as a grandfathered Free
  // workspace and was offered a 3-day trial its checkout cannot start.
  it('a request from another country never offers it a trial', () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
    const org = {
      id: 'org',
      createdAt: new Date('2026-10-25T00:00:00Z'),
      allowTrial: true,
      subscription: null as any,
    };
    const body = respondFrom(org, 'US');
    expect(body.trial).toBe(false);
    expect(body.message).not.toMatch(/trial|Free plan/i);
  });

  describe('with the trial switch on (TRIAL_CHECKOUT=on)', () => {
    const NEW = {
      id: 'org',
      createdAt: new Date('2026-10-25T00:00:00Z'),
      allowTrial: true,
      subscription: null as any,
    };
    beforeEach(() => {
      process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
      process.env.TRIAL_CHECKOUT = 'on';
    });

    it('offers the trial checkout would start, still naming the free posts, not a Free plan', () => {
      const body = respondFrom(NEW, 'IN', { freePosts: true });
      expect(body.trial).toBe(true);
      expect(body.trialDays).toBe(3);
      expect(body.message).toMatch(/^Your free posts include 2 channels\. Start a 3-day free trial of Standard/);
      expect(body.message).not.toMatch(/Free plan/);
    });

    it('AI: the same lead, then the trial', () => {
      const body = respondFrom(NEW, 'IN', { freePosts: true }, Sections.AI);
      expect(body.message).toMatch(AI_LEAD);
      expect(body.message).toMatch(/Start a 3-day free trial of Standard to get the AI Agent/);
    });

    it("the thrower's answer wins: a person who had a trial elsewhere is offered the upgrade", () => {
      const body = respondFrom(NEW, 'IN', { freePosts: true, trialOffered: false } as any);
      expect(body.trial).toBe(false);
      expect(body.message).toMatch(/Upgrade to Standard/);
    });

    it('a used trial (allowTrial false) is offered the upgrade, never a second trial', () => {
      const body = respondFrom({ ...NEW, allowTrial: false }, 'IN', { freePosts: true });
      expect(body.trial).toBe(false);
      expect(body.message).toMatch(/Upgrade to Standard/);
      expect(body.message).not.toMatch(/trial/i);
    });
  });

  it("the thrower's reading of the workspace wins over the request", () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const org = {
      id: 'org',
      createdAt: new Date('2026-10-25T00:00:00Z'),
      allowTrial: true,
      subscription: null as any,
    };
    // Owner on file outside India, GLOBAL not applied: grandfathered Free.
    expect(respondFrom(org, 'IN', { freePosts: false }).trial).toBe(true);
    const ai = respondFrom(org, 'US', { freePosts: true }, Sections.AI);
    expect(ai.trial).toBe(false);
    expect(ai.message).toMatch(AI_LEAD);
    expect(ai.message).toMatch(/Upgrade to Standard to get the AI Agent/);
  });

  it('a grandfathered Free workspace is still offered its trial', () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const body = respondFrom({
      id: 'org',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      allowTrial: true,
      subscription: null,
    });
    expect(body.trial).toBe(true);
  });
});
