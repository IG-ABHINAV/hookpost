import { preload } from 'swr';
import { expandPosts } from '@hookpost/helpers/utils/posts.list.minify';
import {
  calendarPostsRequest,
  initialCalendarFilters,
} from '@hookpost/frontend/components/launches/calendar.helpers';

type Fetch = (url: string, options?: RequestInit) => Promise<Response>;

/** The calendar's posts for one range (calendar.context.tsx). */
export const loadCalendarPosts = async (fetch: Fetch, path: string) =>
  expandPosts(await (await fetch(path)).json());

/** The SWR keys and loaders the calendar reads besides its posts. */
export const CALENDAR_SETS_KEY = 'sets';
export const CALENDAR_SIGNATURE_KEY = 'default-sign';
export const loadSets = async (fetch: Fetch) => (await fetch('/sets')).json();
export const loadDefaultSignature = async (fetch: Fetch) =>
  (await fetch('/signatures/default')).json();

/**
 * Starts the calendar's own requests while /launches is still waiting for
 * its channels, instead of after them. The calendar used to mount only once
 * /integrations/list had answered, so its posts, sets and signature were a
 * second round trip after the channels, which were themselves one after
 * /user/self: about 0.5 s each from India. Each request lands in the SWR
 * cache entry the calendar reads (same key, same loader), so the calendar
 * finds them answered or in flight and asks nothing twice.
 *
 * Returns the keys it preloaded (for the test).
 */
export const preloadCalendar = (
  fetch: Fetch,
  get: (name: string) => string | null,
  displaySaved: string
) => {
  const keys: string[] = [];
  const posts = calendarPostsRequest(initialCalendarFilters(get, displaySaved));
  if (posts) {
    preload(posts.key, () => loadCalendarPosts(fetch, posts.path));
    keys.push(posts.key);
  }
  preload(CALENDAR_SETS_KEY, () => loadSets(fetch));
  preload(CALENDAR_SIGNATURE_KEY, () => loadDefaultSignature(fetch));
  keys.push(CALENDAR_SETS_KEY, CALENDAR_SIGNATURE_KEY);
  return keys;
};
