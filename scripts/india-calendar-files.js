#!/usr/bin/env node
/**
 * Writes the two downloads offered on /social-media-calendar-india from the
 * rows in calendar-data.ts, so the page, the CSV and the calendar file can never
 * disagree:
 *   apps/frontend/public/social-media-calendar-india-2026-27.csv
 *   apps/frontend/public/social-media-calendar-india-2026-27.ics
 *
 * Run after editing calendar-data.ts:  node scripts/india-calendar-files.js
 * No dependencies. The .ics holds all-day events (RFC 5545) that Google
 * Calendar, Outlook and Apple Calendar import.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'apps/frontend/src/app/(landing)/social-media-calendar-india/calendar-data.ts');
const OUT = path.join(ROOT, 'apps/frontend/public');
const BASE = 'social-media-calendar-india-2026-27';

const src = fs.readFileSync(DATA, 'utf8');
const marker = 'export const CALENDAR: CalendarRow[] = ';
const start = src.indexOf(marker);
if (start < 0) throw new Error('CALENDAR not found in calendar-data.ts');
const rows = JSON.parse(src.slice(start + marker.length, src.lastIndexOf(';')));

// CSV: same columns as before, quoted only when a field needs it, CRLF line
// endings (RFC 4180, and what Excel expects).
const csvField = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = [
  'Date,Weekday,Occasion,Type,Post idea,Scheduled in Hookpost (Y/N)',
  ...rows.map((r) => [r.date, r.weekday, r.occasion, r.kind, r.idea, ''].map(csvField).join(',')),
].join('\r\n') + '\r\n';
fs.writeFileSync(path.join(OUT, `${BASE}.csv`), csv);

// ICS: text escaping and 75-octet line folding per RFC 5545.
const icsText = (v) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const fold = (line) => {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.join('\r\n ');
};
const nextDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// A fixed stamp keeps the file byte-identical between runs with the same data.
const STAMP = '20261011T000000Z';

const lines = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Hookstep//Hookpost India social media calendar//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Social media calendar India 2026-27 (Hookpost)',
  'X-WR-TIMEZONE:Asia/Kolkata',
];
for (const r of rows) {
  lines.push(
    'BEGIN:VEVENT',
    `UID:${r.date}-${slug(r.occasion)}@hookpost.hookstep.in`,
    `DTSTAMP:${STAMP}`,
    `DTSTART;VALUE=DATE:${r.date.replace(/-/g, '')}`,
    `DTEND;VALUE=DATE:${nextDay(r.date)}`,
    `SUMMARY:${icsText(r.occasion)}`,
    `DESCRIPTION:${icsText(`${r.kind}. Post idea: ${r.idea}`)}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT'
  );
}
lines.push('END:VCALENDAR');
fs.writeFileSync(path.join(OUT, `${BASE}.ics`), lines.map(fold).join('\r\n') + '\r\n');

console.log(`wrote ${rows.length} rows to ${BASE}.csv and ${BASE}.ics`);
