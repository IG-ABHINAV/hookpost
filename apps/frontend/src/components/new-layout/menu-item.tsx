'use client';
import { FC, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import Link from 'next/link';

/**
 * Whether a menu destination is the current page, shared by this rail and
 * the phone tab bar (mobile.nav.tsx). A destination is current when the path
 * starts with its link. An item can also name a whole section with
 * `activePath`: Super Admin links to /admin/users but stands for every /admin
 * page, so it (and "More" on a phone, where it sits) stays highlighted on
 * /admin/stats, /admin/refunds and the rest. A section matches itself and
 * anything below it, not a sibling sharing its letters (/administrator).
 */
export const isMenuPathActive = (
  pathname: string,
  path: string,
  activePath?: string
): boolean => {
  if (activePath) {
    return pathname === activePath || pathname.indexOf(activePath + '/') === 0;
  }
  return path !== '#' && pathname.indexOf(path) === 0;
};

export const MenuItem: FC<{
  label: string;
  icon: ReactNode;
  path: string;
  /** The section this item stands for, when wider than its link (see isMenuPathActive). */
  activePath?: string;
  onClick?: () => void;
  /** Not on this plan: a lock on the icon. The page explains and offers the upgrade. */
  locked?: boolean;
  lockedLabel?: string;
}> = ({ label, icon, path, activePath, onClick, locked, lockedLabel }) => {
  const currentPath = usePathname();
  const isActive = isMenuPathActive(currentPath || '', path, activePath);

  const className = clsx(
    'group w-full minCustom:h-[54px] custom:h-[44px] py-[8px] px-[2px] minCustom:gap-[4px] custom:gap-[2px] flex flex-col font-[600] items-center justify-center rounded-[12px] hover:text-textItemFocused hover:bg-boxFocused transition-colors',
    isActive ? 'text-textItemFocused bg-boxFocused' : 'text-textItemBlur'
  );

  const title = locked && lockedLabel ? `${label} - ${lockedLabel}` : label;

  const inner = (
    <>
      <div className="relative custom:scale-90 transition-transform">
        {icon}
        {locked && (
          <span
            aria-hidden="true"
            className="absolute -top-[5px] -end-[9px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-btnPrimary text-hp-on-primary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </span>
        )}
      </div>
      {/* "Integrations" is 52.7px wide at 9px and 58.5px at 10px. The rail gives a
          label 46px on phones (58px rail) and 52px from md up (64px rail) when the
          link has 6px side padding, so the word broke mid-way ("Integratio / ns").
          Side padding is now 2px (54px / 60px of room) and phones use 8.5px
          (49.7px). The 9px / 10px height-based sizes still apply from md up. */}
      <div className="text-[8.5px] md:custom:text-[9px] md:minCustom:text-[10px] tracking-[-0.1px] leading-[1.1] text-center w-full [overflow-wrap:anywhere]">
        {label}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button onClick={onClick} title={title} className={className}>
        {inner}
      </button>
    );
  }

  return (
    <Link
      prefetch={true}
      href={path}
      title={title}
      {...(path.indexOf('http') === 0 && { target: '_blank' })}
      className={className}
    >
      {inner}
    </Link>
  );
};
