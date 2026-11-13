import dayjs, { ConfigType, Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import isoWeek from 'dayjs/plugin/isoWeek';
import { newDayjs } from '@hookpost/frontend/components/layout/set.timezone';

dayjs.extend(utc);
dayjs.extend(isoWeek);

// Week view hour gutter. Midnight is 12:00 AM, not 0:00 AM.
export const formatHourLabel = (hour: number, twelveHour: boolean) => {
  if (!twelveHour) {
    return `${hour}:00`;
  }
  return `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
};

// A cell whose hour is over. Checked against the clock at the moment of use:
// a tab left open keeps rendering cells that have since turned past.
export const isPastCell = (cell: Dayjs, now: Dayjs = newDayjs()) =>
  cell.startOf('hour').isBefore(now.startOf('hour'));

// Day view: a posting time is stored as minutes past UTC midnight. Place it on
// the local day being viewed, using that day's own UTC offset (today's is an
// hour out on the far side of a DST change).
export const dayViewSlot = (day: string, utcMinute: number) => {
  const dayStart = newDayjs(day).startOf('day');
  let slot = dayStart.utc().startOf('day').add(utcMinute, 'minute');
  if (slot.isBefore(dayStart)) {
    slot = slot.add(1, 'day');
  }
  return atTimeOnDay(day, slot.local());
};

// The same time of day on the day being viewed. Day view also receives the
// earlier occurrences of a repeating post, which fall on other days.
export const atTimeOnDay = (day: string, time: Dayjs) =>
  newDayjs(day).startOf('day').hour(time.hour()).minute(time.minute());

// Whether a post belongs in a calendar cell. Week rows compare the grid's own
// date and hour rather than an instant range: on the DST fall-back day the
// second 01:xx is outside every 01:00-01:59 range, and on spring-forward the
// skipped 02:00 row resolves to 03:00 and showed 03:xx posts twice.
export const isPostInCell = (
  display: string,
  publishDate: string | Date,
  cell: Dayjs,
  hour?: number
) => {
  const date = dayjs.utc(publishDate).local();
  if (display === 'day') {
    return date.format('YYYY-MM-DD HH:mm') === cell.format('YYYY-MM-DD HH:mm');
  }
  if (display === 'week') {
    return (
      date.format('YYYY-MM-DD') === cell.format('YYYY-MM-DD') &&
      date.hour() === (hour ?? cell.hour())
    );
  }
  return date.format('DD/MM/YYYY') === cell.format('DD/MM/YYYY');
};

// Where a post dropped on a cell is moved to, or null when the cell is past.
export const dropTargetDate = (
  display: string,
  cell: Dayjs,
  publishDate?: string | Date,
  now: Dayjs = newDayjs()
): Dayjs | null => {
  if (isPastCell(cell, now)) {
    return null;
  }
  // A month cell is a whole day (its date is 23:59:59), so the post keeps its
  // own time of day on the new date. Week and day cells carry their own time.
  let target = cell;
  if (display === 'month' && publishDate) {
    const original = dayjs.utc(publishDate).local();
    target = cell
      .hour(original.hour())
      .minute(original.minute())
      .second(0)
      .millisecond(0);
  }
  // A time that has already gone (today's month cell, the current hour's week
  // cell, an earlier slot in the current hour on day view): the post would
  // publish the moment it landed. Same rule as the + button.
  return target.isBefore(now) ? now.add(10, 'minute') : target;
};

// The date a new post opens with when a cell's + is clicked.
export const newPostDefaultDate = (
  cell: Dayjs,
  randomHour: boolean,
  now: Dayjs = newDayjs(),
  random: () => number = Math.random
) => {
  // A month cell has no hour of its own (its date is 23:59:59): pick one, on
  // the hour.
  const picked = randomHour
    ? cell
        .hour(Math.floor(random() * 24))
        .minute(0)
        .second(0)
        .millisecond(0)
    : cell;
  // Never a time that has gone (the current hour, or a cell that turned past
  // while the tab was open): the post would publish as soon as it is added.
  return picked.isBefore(now) ? now.add(10, 'minute') : picked;
};

// The range the calendar asks /posts for. The month grid draws six whole
// weeks from the Monday on or before the 1st, so it needs the days of the
// months either side too, not just the month itself.
export const postsFetchRange = (
  display: string,
  startDate: string,
  endDate: string
) => {
  const from =
    display === 'month'
      ? newDayjs(startDate).startOf('month').startOf('isoWeek')
      : newDayjs(startDate).startOf('day');
  const to =
    display === 'month'
      ? from.add(41, 'day').endOf('day')
      : newDayjs(endDate).endOf('day');
  return {
    startDate: from.utc().format(),
    endDate: to.utc().format(),
  };
};

// The range the calendar shows for a display around a date (today by
// default): that day, its Monday-to-Sunday week, or its month.
export const calendarRange = (display: string, date?: ConfigType) => {
  const day = newDayjs(date);
  switch (display) {
    case 'day':
      return {
        startDate: day.format('YYYY-MM-DD'),
        endDate: day.format('YYYY-MM-DD'),
      };
    case 'month':
      return {
        startDate: day.startOf('month').format('YYYY-MM-DD'),
        endDate: day.endOf('month').format('YYYY-MM-DD'),
      };
    default:
      return {
        startDate: day.startOf('isoWeek').format('YYYY-MM-DD'),
        endDate: day.endOf('isoWeek').format('YYYY-MM-DD'),
      };
  }
};

export type CalendarFilters = {
  startDate: string;
  endDate: string;
  customer: string | null;
  display: string;
};

// What the calendar shows when it opens: the range in the address bar, or
// the current week (day, month) of the saved display.
export const initialCalendarFilters = (
  get: (name: string) => string | null,
  displaySaved: string
): CalendarFilters => {
  const display = get('display') || displaySaved;
  const startDate = get('startDate');
  const endDate = get('endDate');
  const range =
    startDate && endDate ? { startDate, endDate } : calendarRange(display);
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    customer: get('customer') || null,
    display,
  };
};

// The calendar's posts request for some filters: the SWR key it is cached
// under and the backend path it fetches. One function for both the calendar
// and the /launches preload (launches.component.tsx), so the preload lands
// in the very cache entry the calendar reads. Null for the list view, which
// fetches its own pages.
export const calendarPostsRequest = (filters: CalendarFilters) => {
  if (filters.display === 'list') {
    return null;
  }
  const customer = filters.customer?.toString() || '';
  const key = `/posts-${new URLSearchParams({
    display: filters.display,
    startDate: filters.startDate,
    endDate: filters.endDate,
    customer,
  }).toString()}`;
  // Month view asks for the whole grid, including the days of the months
  // either side, which otherwise stayed empty
  const path = `/posts?${new URLSearchParams({
    display: filters.display,
    customer,
    ...postsFetchRange(filters.display, filters.startDate, filters.endDate),
  }).toString()}`;
  return { key, path };
};

// After a new post is added: the range to move the calendar to so the post
// is on screen, or null when it already is. The next free slot is often the
// next morning, which on a Sunday evening is next week's Monday, and the
// calendar used to stay on the week it showed, so the new post looked lost.
// The list view shows every post and never moves.
export const rangeShowingPost = (
  display: string,
  startDate: string,
  endDate: string,
  publishDate: Dayjs
) => {
  if (display === 'list') {
    return null;
  }
  const shown = postsFetchRange(display, startDate, endDate);
  if (
    !publishDate.isBefore(shown.startDate) &&
    !publishDate.isAfter(shown.endDate)
  ) {
    return null;
  }
  return calendarRange(display, publishDate.toDate());
};

// List view day groups, in the order the API sends the posts: soonest first
// for Scheduled, newest first for every other tab.
export const sortListGroups = <T>(groups: [string, T][], listState: string) =>
  groups.sort(([a], [b]) =>
    listState === 'scheduled' ? a.localeCompare(b) : b.localeCompare(a)
  );

// Posting-time preferences: remove a slot by its value. The list on screen is
// sorted, the stored one is not, so a row's position is not its index.
export const removeTimeSlot = <T extends { time: number }>(
  times: T[],
  value: number
) => times.filter(({ time }) => time !== value);

// Why moving or saving a post asks before it publishes: it already went out
// ('published'), or its time passed while it was still queued and it never
// did ('missed'). The two used to share the "already published" warning.
export const republishReason = (
  state: string | undefined,
  publishDate: Dayjs,
  now: Dayjs
): 'published' | 'missed' | 'reminded' | null => {
  // a "Remind me to post" post the user published from the app is live too
  if (state === 'PUBLISHED' || state === 'POSTED_MANUALLY') {
    return 'published';
  }
  if (state === 'QUEUE' && now.isAfter(publishDate)) {
    return 'missed';
  }
  // "Remind me to post": the reminder went out, saving it again sends
  // another one
  if (state === 'REMINDER_SENT') {
    return 'reminded';
  }
  return null;
};
