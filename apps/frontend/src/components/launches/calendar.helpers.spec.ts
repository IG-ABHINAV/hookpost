/**
 * Calendar date logic: where a post shows, where a dropped post lands, what a
 * new post opens with, what the calendar fetches, where it moves to show a
 * post just added, and the failure reason a failed post shows.
 *   pnpm exec jest -c apps/frontend/jest.config.ts calendar.helpers
 *
 * @jest-environment <rootDir>/apps/frontend/jest.timezone-environment.ts
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  atTimeOnDay,
  calendarRange,
  dayViewSlot,
  dropTargetDate,
  formatHourLabel,
  isPastCell,
  isPostInCell,
  newPostDefaultDate,
  postsFetchRange,
  rangeShowingPost,
  removeTimeSlot,
  republishReason,
  sortListGroups,
} from '@hookpost/frontend/components/launches/calendar.helpers';
import { readablePostError } from '@hookpost/helpers/utils/post.error';

dayjs.extend(utc);

// From jest.timezone-environment.ts
declare const setTimezone: (tz?: string) => void;
const inTimezone = (tz: string) => {
  beforeAll(() => setTimezone(tz));
  afterAll(() => setTimezone());
};

// What the PUT /posts/:id/date body carries
const sent = (date: dayjs.Dayjs) => date.utc().format('YYYY-MM-DDTHH:mm:ss');
const hours = Array.from({ length: 24 }, (_, i) => i);

describe('week view hour labels', () => {
  it('labels midnight 12:00 AM, not 0:00 AM', () => {
    expect([0, 1, 11, 12, 13, 23].map((h) => formatHourLabel(h, true))).toEqual(
      ['12:00 AM', '1:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '11:00 PM']
    );
    expect(formatHourLabel(0, false)).toBe('0:00');
  });
});

describe('day view rows', () => {
  // The rows DayView draws for a post: its own time on the day being viewed
  const rowFor = (day: string, publishDate: string) =>
    atTimeOnDay(day, dayjs.utc(publishDate).local());

  describe('in IST', () => {
    inTimezone('Asia/Kolkata');

    it('shows a 02:00 post on its own day (its UTC date is the day before)', () => {
      const publishDate = '2026-10-14T20:30:00Z'; // 15 Oct 02:00 IST
      const row = rowFor('2026-10-15', publishDate);
      expect(row.format('YYYY-MM-DD HH:mm')).toBe('2026-10-15 02:00');
      expect(isPostInCell('day', publishDate, row)).toBe(true);
    });

    it('places a posting time stored in UTC minutes on the viewed day', () => {
      // 20:30 UTC is 02:00 the next morning in IST
      expect(
        dayViewSlot('2026-10-15', 20 * 60 + 30).format('YYYY-MM-DD HH:mm')
      ).toBe('2026-10-15 02:00');
      expect(
        dayViewSlot('2026-10-15', 4 * 60 + 30).format('YYYY-MM-DD HH:mm')
      ).toBe('2026-10-15 10:00');
    });

    it('lists the 00:00-05:29 rows before the evening ones', () => {
      const keys = [
        rowFor('2026-10-15', '2026-10-15T17:30:00Z'),
        rowFor('2026-10-15', '2026-10-14T19:00:00Z'),
      ]
        .map((d) => d.format('HH:mm'))
        .sort();
      expect(keys).toEqual(['00:30', '23:00']);
    });
  });

  describe('in Los Angeles', () => {
    inTimezone('America/Los_Angeles');

    it('shows a 21:00 post on its own day, in a row that is not in the past', () => {
      const publishDate = '2026-10-15T04:00:00Z'; // 14 Oct 21:00 PDT
      const row = rowFor('2026-10-14', publishDate);
      expect(row.format('YYYY-MM-DD HH:mm')).toBe('2026-10-14 21:00');
      expect(isPostInCell('day', publishDate, row)).toBe(true);
      expect(isPastCell(row, dayjs('2026-10-14T12:00:00'))).toBe(false);
    });

    it('keeps posts in their rows on a day past the DST change', () => {
      const publishDate = '2026-11-05T18:00:00Z'; // 5 Nov 10:00 PST
      const row = rowFor('2026-11-05', publishDate);
      expect(row.format('YYYY-MM-DD HH:mm')).toBe('2026-11-05 10:00');
      expect(isPostInCell('day', publishDate, row)).toBe(true);
      // and a UTC posting time uses that day's offset, not today's
      expect(
        dayViewSlot('2026-11-05', 18 * 60).format('YYYY-MM-DD HH:mm')
      ).toBe('2026-11-05 10:00');
    });
  });
});

describe('week view rows across DST changes (Los Angeles)', () => {
  inTimezone('America/Los_Angeles');

  const rowsShowing = (day: string, publishDate: string) =>
    hours.filter((hour) =>
      isPostInCell(
        'week',
        publishDate,
        dayjs(day).hour(hour).startOf('hour'),
        hour
      )
    );

  it('shows each 01:xx post on the fall-back day exactly once', () => {
    expect(rowsShowing('2026-11-01', '2026-11-01T08:30:00Z')).toEqual([1]); // PDT
    expect(rowsShowing('2026-11-01', '2026-11-01T09:30:00Z')).toEqual([1]); // PST
  });

  it('shows a 03:30 post on the spring-forward day once', () => {
    expect(rowsShowing('2027-03-14', '2027-03-14T10:30:00Z')).toEqual([3]);
  });
});

describe('dropping a post', () => {
  inTimezone('Asia/Kolkata');
  // parsed once the timezone is set
  let now: dayjs.Dayjs;
  beforeAll(() => {
    now = dayjs('2026-10-14T16:20:00');
  });

  it('keeps the time of day when moved to another day in month view', () => {
    const cell = dayjs('2026-10-21').endOf('day');
    const target = dropTargetDate('month', cell, '2026-10-20T03:30:00Z', now);
    expect(target!.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-21 09:00:00');
    expect(sent(target!)).toBe('2026-10-21T03:30:00');
  });

  it('moves a drop on today at a time already gone to shortly from now', () => {
    const cell = dayjs('2026-10-14').endOf('day');
    const target = dropTargetDate('month', cell, '2026-10-20T03:30:00Z', now);
    expect(target!.format('YYYY-MM-DD HH:mm')).toBe('2026-10-14 16:30');
  });

  it('uses the hour of a week cell as it is', () => {
    const cell = dayjs('2026-10-15T10:00:00');
    expect(dropTargetDate('week', cell, '2026-10-20T03:30:00Z', now)).toBe(
      cell
    );
  });

  it('moves a drop on the current hour in week view to shortly from now', () => {
    // 16:00 cell, dropped at 16:20: the cell itself is not past yet
    const cell = dayjs('2026-10-14T16:00:00');
    expect(isPastCell(cell, now)).toBe(false);
    const target = dropTargetDate('week', cell, '2026-10-20T03:30:00Z', now);
    expect(target!.format('YYYY-MM-DD HH:mm')).toBe('2026-10-14 16:30');
  });

  it('moves a drop on an earlier slot of the current hour in day view', () => {
    const slot = dayjs('2026-10-14T16:10:00');
    const target = dropTargetDate('day', slot, '2026-10-20T03:30:00Z', now);
    expect(target!.format('YYYY-MM-DD HH:mm')).toBe('2026-10-14 16:30');
  });

  it('keeps a later slot of the current hour in day view as it is', () => {
    const slot = dayjs('2026-10-14T16:45:00');
    expect(dropTargetDate('day', slot, '2026-10-20T03:30:00Z', now)).toBe(slot);
  });

  it('refuses a cell that turned past while the tab was open', () => {
    // rendered at 09:50, dropped at 16:20
    const cell = dayjs('2026-10-14T10:00:00');
    expect(isPastCell(cell, now)).toBe(true);
    expect(
      dropTargetDate('week', cell, '2026-10-20T03:30:00Z', now)
    ).toBeNull();
  });
});

describe('a new post from a cell', () => {
  inTimezone('Asia/Kolkata');
  // parsed once the timezone is set
  let now: dayjs.Dayjs;
  beforeAll(() => {
    now = dayjs('2026-10-14T16:20:00');
  });

  it('never opens today in month view at an hour already gone', () => {
    const today = dayjs('2026-10-14').endOf('day');
    const date = newPostDefaultDate(today, true, now, () => 3 / 24);
    expect(date.format('YYYY-MM-DD HH:mm')).toBe('2026-10-14 16:30');
  });

  it('opens a later day on the hour, not HH:59:59', () => {
    const later = dayjs('2026-10-21').endOf('day');
    const date = newPostDefaultDate(later, true, now, () => 3 / 24);
    expect(date.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-21 03:00:00');
  });

  it('opens the current hour at ten minutes from now, a future hour as is', () => {
    expect(
      newPostDefaultDate(dayjs('2026-10-14T16:00:00'), false, now).format(
        'HH:mm'
      )
    ).toBe('16:30');
    const future = dayjs('2026-10-14T18:00:00');
    expect(newPostDefaultDate(future, false, now)).toBe(future);
  });
});

describe('what the calendar fetches', () => {
  inTimezone('Asia/Kolkata');

  it('asks for the whole month grid, including the days either side', () => {
    expect(postsFetchRange('month', '2026-10-01', '2026-10-31')).toEqual({
      startDate: '2026-09-27T18:30:00Z', // Mon 28 Sep 00:00 IST
      endDate: '2026-11-08T18:29:59Z', // Sun 8 Nov 23:59:59 IST
    });
  });

  it('keeps the week range as it was', () => {
    expect(postsFetchRange('week', '2026-10-12', '2026-10-18')).toEqual({
      startDate: '2026-10-11T18:30:00Z',
      endDate: '2026-10-18T18:29:59Z',
    });
  });
});

describe('after a post is added, the calendar shows it', () => {
  inTimezone('Asia/Kolkata');
  // 25 Oct 2026 (a Sunday), from 17:10 IST: every posting time of the day
  // (02:00, 06:40 and 11:40 UTC) has gone, so find-slot answers Monday 26 Oct
  // 02:00 UTC, 07:30 IST, and the week on screen is Mon 19 - Sun 25 Oct.
  const at = (utcTime: string) => dayjs.utc(utcTime).local();
  const thisWeek = ['week', '2026-10-19', '2026-10-25'] as const;

  afterEach(() => jest.useRealTimers());

  it('opens on the Monday-to-Sunday week that ends on a Sunday', () => {
    jest.useFakeTimers({ now: new Date('2026-10-25T17:00:00Z') }); // Sun 22:30 IST
    expect(calendarRange('week')).toEqual({
      startDate: '2026-10-19',
      endDate: '2026-10-25',
    });
  });

  it("moves to next week for Monday morning's slot", () => {
    expect(rangeShowingPost(...thisWeek, at('2026-10-26T02:00:00'))).toEqual({
      startDate: '2026-10-26',
      endDate: '2026-11-01',
    });
  });

  it('stays for a post in the week on screen, up to its last minute', () => {
    expect(rangeShowingPost(...thisWeek, at('2026-10-25T11:40:00'))).toBeNull();
    expect(rangeShowingPost(...thisWeek, at('2026-10-25T18:29:00'))).toBeNull(); // Sun 23:59 IST
    expect(rangeShowingPost(...thisWeek, at('2026-10-18T18:30:00'))).toBeNull(); // Mon 00:00 IST
  });

  it('goes back too, for a post dated before the week on screen', () => {
    expect(rangeShowingPost(...thisWeek, at('2026-10-18T18:29:00'))).toEqual({
      startDate: '2026-10-12',
      endDate: '2026-10-18',
    });
  });

  it('day view moves to the next day', () => {
    expect(
      rangeShowingPost('day', '2026-10-25', '2026-10-25', at('2026-10-26T02:00:00'))
    ).toEqual({ startDate: '2026-10-26', endDate: '2026-10-26' });
  });

  it('month view stays while the grid shows the day, and moves after it', () => {
    const october = ['month', '2026-10-01', '2026-10-31'] as const;
    // The October grid runs to Sun 8 Nov
    expect(rangeShowingPost(...october, at('2026-11-08T12:00:00'))).toBeNull();
    expect(rangeShowingPost(...october, at('2026-11-09T02:00:00'))).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    });
  });

  it('the list view never moves', () => {
    expect(
      rangeShowingPost('list', '2026-10-19', '2026-10-25', at('2026-12-01T02:00:00'))
    ).toBeNull();
  });
});

describe('list view day order', () => {
  const groups = (): [string, number[]][] => [
    ['2026-10-14', [2100, 900]],
    ['2026-10-12', [1000]],
  ];

  it('puts the newest day first on every tab but Scheduled, like the API', () => {
    expect(sortListGroups(groups(), 'all').map(([d]) => d)).toEqual([
      '2026-10-14',
      '2026-10-12',
    ]);
    expect(sortListGroups(groups(), 'scheduled').map(([d]) => d)).toEqual([
      '2026-10-12',
      '2026-10-14',
    ]);
  });
});

describe('posting-time preferences', () => {
  it('deletes the slot that was clicked, not the one at its sorted position', () => {
    // 09:20, 14:10, 19:00 IST, then 07:00 added (shown first)
    const stored = [{ time: 230 }, { time: 520 }, { time: 810 }, { time: 90 }];
    expect(removeTimeSlot(stored, 90)).toEqual([
      { time: 230 },
      { time: 520 },
      { time: 810 },
    ]);
  });
});

describe('why a post failed', () => {
  const failure = (message: string) =>
    JSON.stringify({
      cause: {
        failure: {
          message,
          source: 'TypeScriptSDK',
          stackTrace: 'Error: x\n    at /home/app/libraries/provider.ts:10:5',
        },
      },
      activityType: 'postSocial',
    });

  it('returns the platform message and never the stack trace', () => {
    const reason = readablePostError(failure('Your account is not verified'));
    expect(reason).toBe('Your account is not verified');
  });

  it('reads the message from a failure cut off at the storage limit', () => {
    const cut =
      failure('Trial access cannot publish pins').slice(0, 120) +
      '… [truncated]';
    expect(() => JSON.parse(cut)).toThrow();
    expect(readablePostError(cut)).toBe('Trial access cannot publish pins');
  });

  it('keeps a plain message that starts with a quote', () => {
    expect(
      readablePostError('"a.mp4" is 14.7 MB, but Discord only accepts 10 MB')
    ).toBe('"a.mp4" is 14.7 MB, but Discord only accepts 10 MB');
  });

  it('drops stack frames and internal markers', () => {
    expect(
      readablePostError('Error: Token expired\n    at /srv/x.ts:1:1')
    ).toBe('Token expired');
    expect(readablePostError('No Post')).toBeNull();
    expect(readablePostError(failure('Unknown Error'))).toBeNull();
    expect(readablePostError(null)).toBeNull();
  });

  it('caps a long message', () => {
    expect(readablePostError('x'.repeat(1000))!.length).toBe(300);
  });
});

describe('republishReason (what the republish dialog says)', () => {
  const now = dayjs.utc('2026-10-15T10:00:00Z');
  const earlier = dayjs.utc('2026-10-14T10:00:00Z');
  const later = dayjs.utc('2026-10-16T10:00:00Z');

  it('a published post was already published', () => {
    expect(republishReason('PUBLISHED', earlier, now)).toBe('published');
    expect(republishReason('PUBLISHED', later, now)).toBe('published');
  });

  it('a queued post whose time passed was never published', () => {
    expect(republishReason('QUEUE', earlier, now)).toBe('missed');
  });

  it('asks nothing for a queued post still ahead, a draft or a failed post', () => {
    expect(republishReason('QUEUE', later, now)).toBeNull();
    expect(republishReason('DRAFT', earlier, now)).toBeNull();
    expect(republishReason('ERROR', earlier, now)).toBeNull();
    expect(republishReason(undefined, earlier, now)).toBeNull();
  });

  it('a post the user posted by hand from a reminder is published too', () => {
    expect(republishReason('POSTED_MANUALLY', earlier, now)).toBe('published');
  });

  it('warns that saving a reminder that went out sends another one', () => {
    expect(republishReason('REMINDER_SENT', earlier, now)).toBe('reminded');
    expect(republishReason('REMINDER_SENT', later, now)).toBe('reminded');
  });
});
