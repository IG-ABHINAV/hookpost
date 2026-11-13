import { Integration } from '@prisma/client';

/**
 * Whether a channel row uses up a slot of the plan's channel allowance.
 *
 * Two kinds of row do not:
 *
 *   - refreshNeeded: the token died. The user reconnects it in place
 *     (?refresh=<id>), which never adds a channel.
 *
 *   - inBetweenSteps: a placeholder. The OAuth callback of a two-step provider
 *     (Facebook Page, Instagram via Facebook Business, YouTube, LinkedIn Page,
 *     Google Business Profile, Tumblr) stores the row before the user has
 *     picked the page or account, and it only becomes a channel in
 *     saveProviderPage. Counting it meant a Free org with one channel could
 *     never add one of those as its second: the placeholder took the last
 *     slot, so the page-pick step reported "2 are in use, you can add 0 more".
 *     A paid org's last slot failed the same way. A channel a publish flagged
 *     back to between-steps is not counted either, since nothing can post to
 *     it until the user picks the page again.
 *
 * Leaving placeholders out cannot take an org past its allowance, because
 * saveProviderPage counts with this same rule at the moment a placeholder
 * turns into a real channel and rejects the save when no slot is left.
 */
export const countsTowardChannelLimit = (
  integration: Pick<Integration, 'refreshNeeded' | 'inBetweenSteps'>
): boolean => !integration.refreshNeeded && !integration.inBetweenSteps;
