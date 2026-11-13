'use client';

import { FC, ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { usePathname } from 'next/navigation';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useVisibleMenu } from '@hookpost/frontend/components/layout/top.menu';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { isMenuPathActive } from '@hookpost/frontend/components/new-layout/menu-item';

/**
 * Phones (below md): the nav rail becomes a tab bar at the bottom of the
 * screen. The rail took 74px of a 375px screen on every page; the tab bar
 * gives that width back and sits where a thumb reaches.
 *
 * The first four destinations are tabs; everything else is under "More".
 * The bar pads itself by the home-indicator inset, and publishes its height
 * as --app-bottom-inset (global.scss) so the page and anything fixed to the
 * bottom (toasts, the review card) clear it.
 */
const TABS = 4;

/** Five or fewer destinations are all tabs; more: four tabs and "More". */
export const splitTabs = <T,>(items: T[]): { tabs: T[]; more: T[] } =>
  items.length <= TABS + 1
    ? { tabs: items, more: [] }
    : { tabs: items.slice(0, TABS), more: items.slice(TABS) };

type Item = {
  name: string;
  icon: ReactNode;
  path: string;
  activePath?: string;
  onClick?: () => void;
  locked?: boolean;
};

const isActive = (pathname: string, item: Item) =>
  isMenuPathActive(pathname, item.path, item.activePath);

const Tab: FC<{
  item: Item;
  active: boolean;
  onNavigate?: () => void;
  /** A tile in the More sheet: bigger label. */
  tile?: boolean;
  /** Said with a locked item ("paid plans"), as the rail's title does. */
  lockedLabel?: string;
}> = ({ item, active, onNavigate, tile, lockedLabel }) => {
  const label =
    item.locked && lockedLabel ? `${item.name} - ${lockedLabel}` : undefined;
  const className = clsx(
    'flex flex-1 min-w-0 flex-col items-center justify-center gap-[3px] rounded-[10px] py-[6px] font-[600] transition-colors',
    active ? 'text-textItemFocused bg-boxFocused' : 'text-textItemBlur'
  );
  const inner = (
    <>
      <span className="relative flex h-[24px] items-center justify-center [&_svg]:max-h-[22px] [&_svg]:max-w-[22px]">
        {item.icon}
        {item.locked && (
          <span
            aria-hidden="true"
            className="absolute -top-[3px] -end-[8px] h-[8px] w-[8px] rounded-full bg-btnPrimary"
          />
        )}
      </span>
      <span
        className={clsx(
          'w-full truncate text-center leading-[1.2]',
          tile ? 'text-[12.5px]' : 'text-[10.5px]'
        )}
      >
        {item.name}
      </span>
    </>
  );
  if (item.onClick) {
    return (
      <button
        type="button"
        aria-label={label}
        className={className}
        onClick={() => {
          onNavigate?.();
          item.onClick?.();
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <Link
      href={item.path}
      prefetch={true}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={className}
      onClick={onNavigate}
      {...(item.path.indexOf('http') === 0 && { target: '_blank', rel: 'noopener noreferrer' })}
    >
      {inner}
    </Link>
  );
};

export const MobileNav: FC = () => {
  const t = useT();
  const pathname = usePathname() || '';
  const { firstMenu, secondMenu } = useVisibleMenu();
  const { discordUrl } = useVariables();
  const [moreOpen, setMoreOpen] = useState(false);

  // The desktop's floating Discord pill (layout/support.tsx) is not shown on
  // phones; its link lives at the end of the menu instead.
  const support: Item[] = discordUrl
    ? [
        {
          name: t('support', 'Support'),
          path: discordUrl,
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            </svg>
          ),
        },
      ]
    : [];
  const all: Item[] = firstMenu.length || secondMenu.length ? [...firstMenu, ...secondMenu, ...support] : [];
  const { tabs, more } = splitTabs(all);
  const moreActive = more.some((item) => isActive(pathname, item));

  // The page and fixed-bottom elements read --app-bottom-inset only while
  // the bar is on screen (see global.scss).
  const shown = all.length > 0;
  useEffect(() => {
    if (!shown) return;
    document.documentElement.classList.add('has-mobile-nav');
    return () => document.documentElement.classList.remove('has-mobile-nav');
  }, [shown]);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  if (!shown) {
    return null;
  }

  return (
    <>
      {moreOpen && (
        // Under the tab bar (z 150), so the bar stays visible and "More"
        // closes the sheet again; the sheet sits right on top of the bar.
        <div
          className="md:hidden fixed inset-0 z-[140] bg-black/50 animate-fadeIn"
          onClick={() => setMoreOpen(false)}
        >
          <div
            id="mobile-nav-more"
            role="dialog"
            aria-label={t('more', 'More')}
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-[var(--app-bottom-inset,0px)] rounded-t-[20px] border-t border-newBgLineColor bg-newBgColorInner text-newTextColor px-[12px] pt-[10px] pb-[12px] max-h-[70dvh] overflow-y-auto"
          >
            <div className="mx-auto mb-[12px] h-[4px] w-[36px] rounded-full bg-newBgLineColor" />
            <div className="grid grid-cols-3 gap-[8px]">
              {more.map((item) => (
                <div key={item.name} className="flex h-[72px]">
                  <Tab
                    item={item}
                    tile={true}
                    lockedLabel={t('paid_plans', 'paid plans')}
                    active={isActive(pathname, item)}
                    onNavigate={() => setMoreOpen(false)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav
        aria-label={t('main_menu', 'Main menu')}
        className="md:hidden fixed inset-x-0 bottom-0 z-[150] border-t border-newBgLineColor bg-newBgColorInner pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] blurMe"
      >
        <div className="flex h-[60px] items-stretch gap-[4px] px-[6px] py-[4px]">
          {tabs.map((item) => (
            <Tab
              key={item.name}
              item={item}
              active={isActive(pathname, item)}
              lockedLabel={t('paid_plans', 'paid plans')}
            />
          ))}
          {more.length > 0 && (
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              aria-controls="mobile-nav-more"
              onClick={() => setMoreOpen((o) => !o)}
              className={clsx(
                'flex flex-1 min-w-0 flex-col items-center justify-center gap-[3px] rounded-[10px] py-[6px] font-[600] transition-colors',
                moreActive || moreOpen ? 'text-textItemFocused bg-boxFocused' : 'text-textItemBlur'
              )}
            >
              <span className="flex h-[24px] items-center justify-center">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="19" cy="12" r="2" />
                </svg>
              </span>
              <span className="w-full truncate text-center text-[10.5px] leading-[1.2]">
                {t('more', 'More')}
              </span>
            </button>
          )}
        </div>
      </nav>
    </>
  );
};
