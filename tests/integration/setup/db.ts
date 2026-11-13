/**
 * Direct database access for arranging state the HTTP API cannot create on
 * its own in a test (a paid subscription, a connected channel) and for
 * asserting what the API wrote. Uses its own PrismaClient on the test
 * database (env.ts already pointed DATABASE_URL there).
 */
import { PrismaClient, SubscriptionTier } from '@prisma/client';

let client: PrismaClient | undefined;
export const db = () => (client ??= new PrismaClient());

export async function disconnectDb() {
  await client?.$disconnect();
  client = undefined;
}

/** Puts the organization on a paid plan, as a Razorpay webhook would. */
export async function givePlan(
  organizationId: string,
  tier: SubscriptionTier = 'STANDARD',
  extra: { totalChannels?: number; period?: 'MONTHLY' | 'YEARLY' } = {}
) {
  const channels: Record<string, number> = {
    STANDARD: 5,
    TEAM: 10,
    PRO: 20,
    ULTIMATE: 100,
  };
  return db().subscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      subscriptionTier: tier,
      period: extra.period || 'MONTHLY',
      totalChannels: extra.totalChannels ?? channels[tier],
      identifier: `sub_test_${organizationId.slice(0, 8)}`,
    },
    update: {
      subscriptionTier: tier,
      totalChannels: extra.totalChannels ?? channels[tier],
      deletedAt: null,
      cancelAt: null,
    },
  });
}

let channelCounter = 0;
/**
 * A connected channel row, as the OAuth callback would leave it. The token is
 * a fixed fake: no test ever publishes to the network.
 */
export async function addChannel(
  organizationId: string,
  providerIdentifier = 'x',
  extra: Partial<{
    name: string;
    disabled: boolean;
    inBetweenSteps: boolean;
    refreshNeeded: boolean;
    /** The network's own id of the account (a Discord channel's server id). */
    internalId: string;
  }> = {}
) {
  const n = channelCounter++;
  return db().integration.create({
    data: {
      organizationId,
      internalId: extra.internalId || `int-${providerIdentifier}-${Date.now()}-${n}`,
      name: extra.name || `Test ${providerIdentifier} ${n}`,
      picture: null,
      providerIdentifier,
      type: 'social',
      token: `fake-token-${n}`,
      refreshToken: `fake-refresh-${n}`,
      tokenExpiration: new Date(Date.now() + 30 * 86400_000),
      profile: `test_profile_${n}`,
      disabled: extra.disabled ?? false,
      inBetweenSteps: extra.inBetweenSteps ?? false,
      refreshNeeded: extra.refreshNeeded ?? false,
    },
  });
}

export async function apiKeyOf(organizationId: string) {
  const org = await db().organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { apiKey: true },
  });
  return org.apiKey!;
}

export async function makeSuperAdmin(userId: string) {
  return db().user.update({ where: { id: userId }, data: { isSuperAdmin: true } });
}
