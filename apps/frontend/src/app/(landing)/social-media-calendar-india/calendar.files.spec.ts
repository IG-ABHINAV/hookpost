/**
 * @jest-environment node
 */
/**
 * The CSV and .ics downloads on /social-media-calendar-india are generated from
 * calendar-data.ts by scripts/india-calendar-files.js and committed. They must
 * agree with the page (a row edited without re-running the script ships a
 * calendar that disagrees with it) and stay importable: RFC 4180 CSV and an
 * RFC 5545 calendar of all-day events with folded lines.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR } from './calendar-data';

const publicDir = join(__dirname, '..', '..', '..', '..', 'public');
const csv = readFileSync(join(publicDir, 'social-media-calendar-india-2026-27.csv'), 'utf8');
const ics = readFileSync(join(publicDir, 'social-media-calendar-india-2026-27.ics'), 'utf8');
const regenerate = 'run: node scripts/india-calendar-files.js';

describe('India calendar downloads', () => {
  it('the CSV has one row per calendar entry, in order, with CRLF line endings', () => {
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Weekday,Occasion,Type,Post idea,Scheduled in Hookpost (Y/N)');
    expect({ rows: lines.length - 1, regenerate }).toEqual({ rows: CALENDAR.length, regenerate });
    CALENDAR.forEach((row, i) => {
      expect(lines[i + 1].startsWith(`${row.date},${row.weekday},`)).toBe(true);
      expect(lines[i + 1]).toContain(row.occasion.includes('"') ? row.occasion.replace(/"/g, '""') : row.occasion);
    });
  });

  it('the .ics has one all-day event per entry, each ending the next day', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    const unfolded = ics.replace(/\r\n /g, '');
    const starts = [...unfolded.matchAll(/^DTSTART;VALUE=DATE:(\d{8})$/gm)].map((m) => m[1]);
    const ends = [...unfolded.matchAll(/^DTEND;VALUE=DATE:(\d{8})$/gm)].map((m) => m[1]);
    expect({ events: starts.length, regenerate }).toEqual({ events: CALENDAR.length, regenerate });
    CALENDAR.forEach((row, i) => {
      expect(starts[i]).toBe(row.date.replace(/-/g, ''));
      const next = new Date(`${row.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(ends[i]).toBe(next.toISOString().slice(0, 10).replace(/-/g, ''));
    });
    const uids = [...unfolded.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('every .ics line is CRLF-terminated and at most 75 octets', () => {
    const lines = ics.split('\r\n');
    expect(lines.some((l) => l.includes('\n'))).toBe(false);
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('dates are real, in order, and the weekday matches', () => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let last = '';
    for (const row of CALENDAR) {
      const d = new Date(`${row.date}T00:00:00Z`);
      expect(Number.isNaN(d.getTime())).toBe(false);
      expect({ date: row.date, weekday: row.weekday }).toEqual({ date: row.date, weekday: days[d.getUTCDay()] });
      expect(row.date >= last).toBe(true);
      last = row.date;
    }
  });
});
