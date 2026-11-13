/**
 * The number on each /analytics card.
 *   pnpm exec jest -c apps/frontend/jest.config.ts analytics.total
 */
import {
  formatAnalyticsTotal,
  formatDuration,
} from '@hookpost/frontend/components/platform-analytics/analytics.total';

const days = (...totals: number[]) =>
  totals.map((total, i) => ({ total, date: `2026-10-0${i + 1}` }));

describe('formatAnalyticsTotal', () => {
  it("shows YouTube's Average View Duration as m:ss, not a percentage", () => {
    expect(
      formatAnalyticsTotal({
        average: true,
        format: 'duration',
        data: days(25, 33.8),
      })
    ).toBe('0:29');
  });

  it('keeps the % on Average View Percentage', () => {
    expect(
      formatAnalyticsTotal({
        average: true,
        format: 'percent',
        data: days(70, 71.92),
      })
    ).toBe('70.96%');
  });

  it('treats an average without a format as a percentage, as before', () => {
    expect(formatAnalyticsTotal({ average: true, data: days(10, 20) })).toBe(
      '15.00%'
    );
  });

  it('sums a count series', () => {
    expect(formatAnalyticsTotal({ data: days(1200, 34, 0) })).toBe(
      new Intl.NumberFormat().format(1234)
    );
  });

  it('adds totals that arrive as strings instead of joining them', () => {
    expect(
      formatAnalyticsTotal({
        data: [
          { total: '5', date: '2026-10-01' },
          { total: '3', date: '2026-10-02' },
        ],
      })
    ).toBe('8');
  });

  it('does not print NaN for an average with no days', () => {
    expect(formatAnalyticsTotal({ average: true, data: [] })).toBe('0.00%');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [29.4, '0:29'],
    [125, '2:05'],
    [3700, '1:01:40'],
  ])('%p seconds -> %p', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
