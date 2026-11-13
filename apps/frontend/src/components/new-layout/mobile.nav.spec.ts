/**
 * The phone tab bar (mobile.nav.tsx) and the menu filter it shares with the
 * desktop rail (layout/top.menu.tsx useVisibleMenu).
 *   pnpm exec jest -c apps/frontend/jest.config.ts mobile.nav
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

let mockPath = '/launches';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPath,
}));
jest.mock('next/link', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const R = require('react');
  return {
    __esModule: true,
    default: ({ href, children, prefetch, ...rest }: any) =>
      R.createElement('a', { href, ...rest }, children),
  };
});
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

type Item = { name: string; path: string; icon: null; onClick?: () => void };
const item = (name: string, path = '/' + name.toLowerCase()): Item => ({
  name,
  path,
  icon: null,
});
let mockMenu: { firstMenu: Item[]; secondMenu: Item[] } = {
  firstMenu: [],
  secondMenu: [],
};
let mockVariables: { discordUrl?: string } = {};
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => mockVariables,
}));
jest.mock('@hookpost/frontend/components/layout/top.menu', () => ({
  useVisibleMenu: () => mockMenu,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MobileNav, splitTabs } = require('./mobile.nav');

const SIX = {
  firstMenu: [item('Calendar', '/launches'), ...['Agent', 'Analytics', 'Media', 'Plugs'].map((n) => item(n))],
  secondMenu: [item('Settings')],
};

describe('splitTabs', () => {
  it('keeps five or fewer destinations as tabs, with no More', () => {
    expect(splitTabs([1, 2, 3, 4, 5])).toEqual({ tabs: [1, 2, 3, 4, 5], more: [] });
    expect(splitTabs([1])).toEqual({ tabs: [1], more: [] });
    expect(splitTabs([])).toEqual({ tabs: [], more: [] });
  });

  it('shows four tabs and puts the rest under More from six up', () => {
    expect(splitTabs([1, 2, 3, 4, 5, 6])).toEqual({ tabs: [1, 2, 3, 4], more: [5, 6] });
    expect(splitTabs([1, 2, 3, 4, 5, 6, 7, 8, 9]).more).toEqual([5, 6, 7, 8, 9]);
  });
});

describe('MobileNav', () => {
  beforeEach(() => {
    mockPath = '/launches';
    mockMenu = SIX;
    document.documentElement.className = '';
  });

  it('renders four tabs and More, with the current page marked', () => {
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    const links = nav.querySelectorAll('a');
    expect([...links].map((a) => a.textContent)).toEqual([
      'Calendar',
      'Agent',
      'Analytics',
      'Media',
    ]);
    expect(nav.querySelector('a[aria-current="page"]')?.textContent).toBe('Calendar');
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('opens More with the remaining destinations, and closes on Escape and on the backdrop', () => {
    render(React.createElement(MobileNav));
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    const sheet = screen.getByRole('dialog', { name: 'More' });
    expect([...sheet.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Plugs',
      'Settings',
    ]);
    expect(more.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();

    fireEvent.click(more);
    // The backdrop is the dialog's parent; a click inside the sheet stays open.
    const dialog = screen.getByRole('dialog', { name: 'More' });
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeNull();
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
  });

  it('highlights More while the current page is one of its destinations', () => {
    mockPath = '/settings';
    render(React.createElement(MobileNav));
    expect(screen.getByRole('button', { name: 'More' }).className).toContain('bg-boxFocused');
  });

  it('closes the sheet when the page changes', () => {
    const view = render(React.createElement(MobileNav));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    mockPath = '/settings';
    act(() => {
      view.rerender(React.createElement(MobileNav));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs a menu item that is an action (no page), and closes the sheet', () => {
    const onClick = jest.fn();
    mockMenu = {
      firstMenu: SIX.firstMenu,
      secondMenu: [{ ...item('Videos', '#'), onClick }],
    };
    render(React.createElement(MobileNav));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows five destinations as five tabs without More', () => {
    mockMenu = { firstMenu: SIX.firstMenu.slice(0, 4), secondMenu: [item('Settings')] };
    render(React.createElement(MobileNav));
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getByRole('navigation').querySelectorAll('a')).toHaveLength(5);
  });

  it('renders nothing with no destinations (no workspace yet)', () => {
    mockMenu = { firstMenu: [], secondMenu: [] };
    const { container } = render(React.createElement(MobileNav));
    expect(container.innerHTML).toBe('');
  });

  it('marks <html> while mounted, so the page and fixed elements clear the bar', () => {
    const view = render(React.createElement(MobileNav));
    expect(document.documentElement.classList.contains('has-mobile-nav')).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains('has-mobile-nav')).toBe(false);
  });
});

describe('MobileNav on admin pages', () => {
  // Super Admin links to /admin/users but stands for every /admin page.
  const ADMIN = {
    firstMenu: SIX.firstMenu,
    secondMenu: [item('Settings'), { ...item('Super Admin', '/admin/users'), activePath: '/admin' } as any],
  };

  it.each(['/admin/users', '/admin/stats', '/admin/refunds', '/admin/affiliates', '/admin'])(
    'highlights More and Super Admin on %s',
    (path) => {
      mockPath = path;
      mockMenu = ADMIN;
      render(React.createElement(MobileNav));
      const more = screen.getByRole('button', { name: 'More' });
      expect(more.className).toContain('bg-boxFocused');
      fireEvent.click(more);
      const admin = screen.getByRole('dialog').querySelector('a[href="/admin/users"]');
      expect(admin?.getAttribute('aria-current')).toBe('page');
    }
  );

  it('leaves More plain on a page outside the section', () => {
    mockPath = '/administrator';
    mockMenu = ADMIN;
    render(React.createElement(MobileNav));
    expect(screen.getByRole('button', { name: 'More' }).className).not.toContain('bg-boxFocused');
  });
});

describe('isMenuPathActive', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isMenuPathActive } = require('./menu-item');
  it('matches a link by prefix, never the # placeholder', () => {
    expect(isMenuPathActive('/launches', '/launches')).toBe(true);
    expect(isMenuPathActive('/launches/week', '/launches')).toBe(true);
    expect(isMenuPathActive('/media', '/launches')).toBe(false);
    expect(isMenuPathActive('/anything', '#')).toBe(false);
  });
  it('matches a section and its pages, not a lookalike', () => {
    expect(isMenuPathActive('/admin/stats', '/admin/users', '/admin')).toBe(true);
    expect(isMenuPathActive('/admin', '/admin/users', '/admin')).toBe(true);
    expect(isMenuPathActive('/administrator', '/admin/users', '/admin')).toBe(false);
  });
});

describe('MobileNav with nothing to show', () => {
  it('does not reserve room for a bar it does not draw', () => {
    mockMenu = { firstMenu: [], secondMenu: [] };
    document.documentElement.className = '';
    render(React.createElement(MobileNav));
    expect(document.documentElement.classList.contains('has-mobile-nav')).toBe(false);
  });
});

describe('MobileNav locked items', () => {
  it('names a locked tab with the plan it needs, as the rail does', () => {
    mockMenu = {
      firstMenu: [item('Calendar', '/launches'), { ...item('Agent'), locked: true } as any],
      secondMenu: [item('Settings')],
    };
    render(React.createElement(MobileNav));
    expect(screen.getByRole('link', { name: 'Agent - paid plans' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeTruthy();
  });

  it('ties the More button to its sheet', () => {
    mockMenu = SIX;
    render(React.createElement(MobileNav));
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(more);
    expect(screen.getByRole('dialog').id).toBe(more.getAttribute('aria-controls'));
  });
});

describe('MobileNav support link', () => {
  afterEach(() => {
    mockVariables = {};
  });

  it('puts Support (the desktop Discord pill) at the end of More, opening in a new tab', () => {
    mockVariables = { discordUrl: 'https://discord.gg/hookpost' };
    mockMenu = SIX;
    render(React.createElement(MobileNav));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const links = [...screen.getByRole('dialog').querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['Plugs', 'Settings', 'Support']);
    expect(links[2].getAttribute('href')).toBe('https://discord.gg/hookpost');
    expect(links[2].getAttribute('target')).toBe('_blank');
  });

  it('has no Support link without a Discord URL, and no bar at all without a workspace', () => {
    mockVariables = { discordUrl: 'https://discord.gg/hookpost' };
    mockMenu = { firstMenu: [], secondMenu: [] };
    const { container } = render(React.createElement(MobileNav));
    expect(container.innerHTML).toBe('');
  });
});
