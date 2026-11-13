import dayjs from 'dayjs';

/**
 * Start of the current plan month: the latest monthly anniversary of `anchor`
 * that is not after `now`. A paid org's month runs from its
 * Subscription.createdAt, a Free org's (no Subscription row) from its own
 * createdAt.
 *
 * The posts_per_month check at post creation (permissions.service.ts) and the
 * Free publish meter (SubscriptionService.publishWithinPlan) both use this, so
 * the two always count the same month.
 */
export function planMonthStart(anchor: Date | string, now = dayjs()) {
  const start = dayjs(anchor);
  return start.add(Math.abs(start.diff(now, 'month')), 'month');
}
