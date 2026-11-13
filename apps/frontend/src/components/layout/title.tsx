'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useMenuItem } from '@hookpost/frontend/components/layout/top.menu';

/**
 * The top bar's title for a path: the menu item whose path is the path itself
 * or a whole-segment prefix of it. Admin pages are always "Super Admin": a
 * substring match put "Earn 30%" (/affiliate) on /admin/affiliates.
 */
export function titleForPath(
  path: string | null | undefined,
  items: { name?: string; path?: string }[]
): string {
  if (!path) return '';
  if (path === '/admin' || path.startsWith('/admin/')) return 'Super Admin';
  const match = items.find(
    (item) =>
      item.path &&
      item.path !== '#' &&
      (path === item.path || path.startsWith(item.path.replace(/\/$/, '') + '/'))
  );
  return match?.name || '';
}

export const Title = () => {
  const path = usePathname();
  const { all: menuItems } = useMenuItem();
  const currentTitle = useMemo(
    () => titleForPath(path, menuItems),
    [path, menuItems]
  );

  return <h1>{currentTitle}</h1>;
};
