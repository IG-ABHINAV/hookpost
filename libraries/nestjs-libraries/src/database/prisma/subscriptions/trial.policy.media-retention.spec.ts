/**
 * The media retention rule's numbers and dates (trial.policy.ts): who is on
 * the clock in each plan state, the day the emails name, and when the
 * removal and the reminder may happen in any time zone.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts trial.policy.media-retention
 */
import {
  MEDIA_RETENTION_AFTER_END_DAYS,
  MEDIA_RETENTION_REMINDER_DAYS,
  mediaKeptUntilLabel,
  mediaReminderFrom,
  mediaRemoveAt,
  onMediaRetentionClock,
  PlanState,
} from './trial.policy';

describe('onMediaRetentionClock', () => {
  const states: PlanState[] = [
    'free',
    'free_posts',
    'needs_trial',
    'locked',
    'trialing',
    'active',
    'dunning',
    'cancelling',
  ];
  it.each(states)('%s', (state) => {
    const expected = state === 'locked' || state === 'needs_trial';
    expect(onMediaRetentionClock(state, { internal: false })).toBe(expected);
  });

  it('free posts: only once spent (and nothing still scheduled, which the caller folds in)', () => {
    expect(onMediaRetentionClock('free_posts', { internal: false, freePostsSpent: false })).toBe(false);
    expect(onMediaRetentionClock('free_posts', { internal: false, freePostsSpent: true })).toBe(true);
    // Spent means nothing for a workspace that is not on free posts.
    expect(onMediaRetentionClock('active', { internal: false, freePostsSpent: true })).toBe(false);
  });

  it('never one of our own, whatever its state', () => {
    for (const state of states) {
      expect(onMediaRetentionClock(state, { internal: true, freePostsSpent: true })).toBe(false);
    }
  });
});

describe('the dates', () => {
  it('30 days, reminder 7 days before', () => {
    expect(MEDIA_RETENTION_AFTER_END_DAYS).toBe(30);
    expect(MEDIA_RETENTION_REMINDER_DAYS).toBe(7);
  });

  it.each([
    // told at                     named day          removal from (UTC-12 end of it)   reminder from
    ['2026-11-01T00:00:00Z', '1 December 2026', '2026-12-02T12:00:00Z', '2026-11-24T00:00:00Z'],
    ['2026-11-01T23:59:59Z', '1 December 2026', '2026-12-02T12:00:00Z', '2026-11-24T00:00:00Z'],
    // 1 Nov 23:30 UTC is already 2 Nov in India: the UTC day is named, never later than any reader's.
    ['2026-11-01T23:30:00Z', '1 December 2026', '2026-12-02T12:00:00Z', '2026-11-24T00:00:00Z'],
    ['2027-01-31T10:00:00Z', '2 March 2027', '2027-03-03T12:00:00Z', '2027-02-23T00:00:00Z'],
    ['2028-02-10T10:00:00Z', '11 March 2028', '2028-03-12T12:00:00Z', '2028-03-04T00:00:00Z'],
  ])('told at %s: named %s, removal from %s, reminder from %s', (told, label, removal, reminder) => {
    const removeAt = mediaRemoveAt(new Date(told));
    expect(mediaKeptUntilLabel(removeAt)).toBe(label);
    expect(removeAt.toISOString()).toBe(new Date(removal).toISOString());
    expect(mediaReminderFrom(removeAt).toISOString()).toBe(new Date(reminder).toISOString());
  });

  it('the named day is over in every time zone (UTC-12 to UTC+14) before the removal', () => {
    for (let h = 0; h < 48; h++) {
      const told = new Date(Date.UTC(2026, 10, 1, h, 17));
      const removeAt = mediaRemoveAt(told);
      const label = mediaKeptUntilLabel(removeAt);
      for (const offset of [-12, -8, -5, 0, 5.5, 9, 14]) {
        // The reader's local date at the removal moment is after the named day.
        const local = new Date(removeAt.getTime() + offset * 3600_000);
        const localDay = local.toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        });
        expect(localDay).not.toBe(label);
        expect(local.getTime()).toBeGreaterThan(Date.parse(`${label} UTC`));
      }
      // And never fewer than 30 full days after the notice.
      expect(removeAt.getTime() - told.getTime()).toBeGreaterThanOrEqual(30 * 86400_000);
    }
  });

  it('a reminder sent any time on its day names the same date as the notice', () => {
    const removeAt = mediaRemoveAt(new Date('2026-11-01T08:00:00Z'));
    const from = mediaReminderFrom(removeAt);
    for (const h of [0, 6, 23.99]) {
      const at = new Date(from.getTime() + h * 3600_000);
      expect(mediaRemoveAt(at, MEDIA_RETENTION_REMINDER_DAYS)).toEqual(removeAt);
    }
    // A day late, the reminder moves the removal by that day.
    const late = new Date(from.getTime() + 30 * 3600_000);
    expect(mediaRemoveAt(late, MEDIA_RETENTION_REMINDER_DAYS).getTime()).toBe(removeAt.getTime() + 86400_000);
  });
});
