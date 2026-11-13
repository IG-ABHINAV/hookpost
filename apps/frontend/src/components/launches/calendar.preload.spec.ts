/**
 * /launches asks for the calendar's posts, sets and signature beside the
 * channels instead of after them, under the exact SWR keys the calendar
 * reads, so nothing is fetched twice.
 *   pnpm exec jest -c apps/frontend/jest.config.ts calendar.preload
 */
import {
  calendarPostsRequest,
  initialCalendarFilters,
} from '@hookpost/frontend/components/launches/calendar.helpers';
import { preloadCalendar } from '@hookpost/frontend/components/launches/calendar.preload';

const params = (q: string) => {
  const s = new URLSearchParams(q);
  return (name: string) => s.get(name);
};

const okJson = (body: unknown) =>
  ({ ok: true, json: async () => body } as unknown as Response);

describe('initialCalendarFilters', () => {
  it('takes the range in the address bar', () => {
    expect(
      initialCalendarFilters(
        params('display=month&startDate=2026-10-01&endDate=2026-10-31&customer=c1'),
        'week'
      )
    ).toEqual({
      display: 'month',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      customer: 'c1',
    });
  });

  it('falls back to the saved display around today', () => {
    const f = initialCalendarFilters(params(''), 'day');
    expect(f.display).toBe('day');
    expect(f.startDate).toBe(f.endDate);
    expect(f.customer).toBeNull();
  });
});

describe('calendarPostsRequest', () => {
  it('keys the cache by the range shown and fetches the padded range', () => {
    const r = calendarPostsRequest({
      display: 'week',
      startDate: '2026-11-02',
      endDate: '2026-11-08',
      customer: null,
    })!;
    expect(r.key).toBe(
      '/posts-display=week&startDate=2026-11-02&endDate=2026-11-08&customer='
    );
    expect(r.path.startsWith('/posts?display=week&customer=&startDate=')).toBe(
      true
    );
  });

  it('none for the list view', () => {
    expect(
      calendarPostsRequest({
        display: 'list',
        startDate: '2026-11-02',
        endDate: '2026-11-08',
        customer: null,
      })
    ).toBeNull();
  });
});

describe('preloadCalendar', () => {
  it('asks for the posts, sets and signature at once, under the keys the calendar reads', async () => {
    const fetch = jest.fn(async (url: string) =>
      okJson(url.startsWith('/posts') ? { posts: [], comments: [] } : [])
    );
    const q = 'display=week&startDate=2030-01-07&endDate=2030-01-13';
    const keys = preloadCalendar(fetch, params(q), 'week');

    const posts = calendarPostsRequest(initialCalendarFilters(params(q), 'week'))!;
    expect(keys).toEqual([posts.key, 'sets', 'default-sign']);
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual(
      [posts.path, '/sets', '/signatures/default'].sort()
    );

    // A second preload for the same keys (the calendar mounting) is served
    // from the request already in flight.
    preloadCalendar(fetch, params(q), 'week');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('skips the posts for the list view', () => {
    const fetch = jest.fn(async () => okJson([]));
    const keys = preloadCalendar(fetch, params('display=list'), 'week');
    expect(keys).toEqual(['sets', 'default-sign']);
  });
});
