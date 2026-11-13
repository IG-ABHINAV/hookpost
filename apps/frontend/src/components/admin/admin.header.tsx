'use client';

import { FC, ReactNode, useEffect, useRef } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { usePathname } from 'next/navigation';

/** The admin sections, in tab order. */
export const ADMIN_NAV = [
  { href: '/admin/users', label: '👥 Users & Billing' },
  { href: '/admin/stats', label: '📊 Social Stats' },
  { href: '/admin/errors', label: '⚠️ Error Logs' },
  { href: '/admin/contact', label: '✉️ Contact' },
  { href: '/admin/refunds', label: '💸 Refunds' },
  { href: '/admin/marketplaces', label: '🛒 Marketplaces' },
  { href: '/admin/affiliates', label: '🤝 Affiliates' },
];

/**
 * Title, one line about the page, and the tabs between admin sections. Each
 * admin page used to carry its own copy of this block.
 *
 * Phones: a smaller title, and the tabs are one row that scrolls sideways
 * (they wrapped into a two-line block of half-words like "Users / &
 * Billing").
 */
export const AdminHeader: FC<{
  icon: string;
  title: ReactNode;
  subtitle: ReactNode;
}> = ({ icon, title, subtitle }) => {
  const pathname = usePathname() || '';
  const navRef = useRef<HTMLElement>(null);
  // On a phone the row is wider than the screen: bring the current tab into
  // view (sideways only, the page itself does not move).
  // Again when the tabs change size (web fonts arriving widen them), until
  // someone touches the row.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    let touched = false;
    const center = () => {
      if (touched || nav.scrollWidth <= nav.clientWidth) return;
      nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
    };
    const onTouch = () => {
      touched = true;
    };
    center();
    // The row's final width is known only after hydration settles and the
    // web fonts are in; centre again then.
    const timers = [100, 400, 1200].map((ms) => window.setTimeout(center, ms));
    document.fonts?.ready.then(center).catch(() => undefined);
    const events = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
    events.forEach((e) => nav.addEventListener(e, onTouch, { passive: true }));
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(center);
    observer?.observe(nav);
    observer?.observe(current);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      events.forEach((e) => nav.removeEventListener(e, onTouch));
      observer?.disconnect();
    };
  }, [pathname]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-[12px] md:gap-[16px] min-w-0">
      <div className="min-w-0">
        <h1 className="text-[20px] md:text-[24px] font-[700] text-textColor flex items-center gap-[8px]">
          <span>{icon}</span> {title}
        </h1>
        <p className="text-[13px] opacity-70 mt-[2px]">{subtitle}</p>
      </div>
      <nav
        ref={navRef}
        aria-label="Admin sections"
        className="relative flex items-center gap-[8px] bg-newBgColorInner border border-newTableBorder p-[4px] rounded-[10px] max-w-full overflow-x-auto scrollbar-none"
      >
        {ADMIN_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname.indexOf(item.href) === 0 ? 'page' : undefined}
            className={clsx(
              'shrink-0 whitespace-nowrap px-[14px] py-[6px] rounded-[6px] text-[13px]',
              pathname.indexOf(item.href) === 0
                ? 'font-[600] bg-primary text-textColor'
                : 'font-[500] text-textColor hover:bg-black/5 dark:hover:bg-white/5 transition-all'
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
};
