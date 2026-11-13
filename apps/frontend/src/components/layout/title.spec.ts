/**
 * The top bar's title (title.tsx). A substring match put "Earn 30%"
 * (/affiliate) on /admin/affiliates.
 *   pnpm exec jest -c apps/frontend/jest.config.ts layout/title
 */
jest.mock('@hookpost/frontend/components/layout/top.menu', () => ({ useMenuItem: () => ({ all: [] }) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { titleForPath } = require('./title');

const items = [
  { name: 'Agent Media', path: '#' },
  { name: 'Calendar', path: '/launches' },
  { name: 'Billing', path: '/billing' },
  { name: 'Earn 30%', path: '/affiliate' },
  { name: 'Settings', path: '/settings' },
  { name: 'Super Admin', path: '/admin/users' },
];

describe('titleForPath', () => {
  it('names the page from its menu item', () => {
    expect(titleForPath('/affiliate', items)).toBe('Earn 30%');
    expect(titleForPath('/settings/team', items)).toBe('Settings');
    expect(titleForPath('/launches', items)).toBe('Calendar');
  });

  it('calls every admin page Super Admin, never Earn 30%', () => {
    for (const p of ['/admin/users', '/admin/affiliates', '/admin/marketplaces', '/admin/refunds', '/admin']) {
      expect(titleForPath(p, items)).toBe('Super Admin');
    }
  });

  it('matches whole path segments only', () => {
    expect(titleForPath('/affiliates', items)).toBe('');
    expect(titleForPath('/billing-history', items)).toBe('');
    expect(titleForPath('/administrator', items)).toBe('');
  });

  it('ignores items with no real path, and empty paths', () => {
    expect(titleForPath('/#', items)).toBe('');
    expect(titleForPath(null, items)).toBe('');
    expect(titleForPath('', items)).toBe('');
  });
});
