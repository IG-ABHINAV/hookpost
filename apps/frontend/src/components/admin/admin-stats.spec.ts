/**
 * The Social Stats range label. The backend counts whole UTC days; the label
 * names the days asked for. Before (2 Nov 2026): the response's end
 * (23:59:59.999Z) shown as a local date read "1/11/2026 — 2/11/2026" for
 * "Today" in India.
 *
 * @jest-environment <rootDir>/apps/frontend/jest.timezone-environment.ts
 */
import { statsPresetDays, statsRangeLabel } from './admin-stats.component';

declare const setTimezone: (tz?: string) => void;

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' });

describe.each(['Asia/Kolkata', 'America/Los_Angeles', 'UTC'])('statsRangeLabel in %s', (tz) => {
  beforeAll(() => setTimezone(tz));
  afterAll(() => setTimezone());

  it('one day is one date, marked UTC', () => {
    expect(statsRangeLabel('2026-11-01', '2026-11-01')).toBe(`${day('2026-11-01')} (UTC)`);
  });

  it('a range names both ends and never the day before or after', () => {
    const label = statsRangeLabel('2026-10-26', '2026-11-01');
    expect(label).toBe(`${day('2026-10-26')} — ${day('2026-11-01')} (UTC)`);
    expect(label).not.toContain(day('2026-11-02'));
    expect(label).not.toContain(day('2026-10-25'));
  });
});

describe.each(['Asia/Kolkata', 'America/Los_Angeles', 'UTC'])('statsPresetDays in %s', (tz) => {
  beforeAll(() => setTimezone(tz));
  afterAll(() => setTimezone());

  it('02:00 on Monday 2 Nov in India is Sunday 1 Nov UTC: the week began Monday 26 Oct, not "today"', () => {
    const days = statsPresetDays(new Date('2026-11-01T20:30:00Z'));
    expect(days.today).toBe('2026-11-01');
    expect(days.startOfWeek).toBe('2026-10-26');
    expect(days.startOfMonth).toBe('2026-11-01');
    expect(days.daysAgo7).toBe('2026-10-25');
    expect(days.daysAgo30).toBe('2026-10-02');
  });

  it('on 1 Dec in India (30 Nov UTC) the month is November, not 30 Nov onwards', () => {
    const days = statsPresetDays(new Date('2026-11-30T20:00:00Z'));
    expect(days.today).toBe('2026-11-30');
    expect(days.startOfMonth).toBe('2026-11-01');
  });

  it('a Monday (UTC) starts its own week', () => {
    expect(statsPresetDays(new Date('2026-11-02T10:00:00Z')).startOfWeek).toBe('2026-11-02');
  });
});
