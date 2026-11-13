'use client';

import { FC, ReactNode } from 'react';
import clsx from 'clsx';
import { useMinWidth } from '@hookpost/frontend/components/layout/use.min.width';

/**
 * The list panel at the left of Analytics, Plugs, Integrations and the Agent.
 *
 * md and up: a 260px column that folds to 100px (`collapsed`, the
 * collapseMenu cookie). Phones: full width above the page, with the list
 * as a row that scrolls sideways. The 260px column used to stack on top of
 * the page there, so a phone showed a column of channels with a dead strip
 * beside it and the page itself only after scrolling past every channel.
 *
 * Children are the list items; each keeps its own look. Items inside carry
 * `group-[.sidebar]:hidden` on whatever should disappear when folded.
 */
export const SidePanel: FC<{
  title: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Under the list (the Agent's "new chat" button, ...). */
  footer?: ReactNode;
}> = ({ title, collapsed, onToggle, children, footer }) => {
  const isMd = useMinWidth(768);
  // Folding is a desktop preference; a phone always shows names.
  const folded = isMd && collapsed;
  return (
    <div
      className={clsx(
        'bg-newBgColorInner p-[12px] md:p-[20px] flex flex-col gap-[10px] md:gap-[15px] transition-all min-w-0 shrink-0',
        folded ? 'group sidebar w-full md:w-[100px]' : 'w-full md:w-[260px]'
      )}
    >
      <div className="flex items-center">
        <h2 className="group-[.sidebar]:hidden flex-1 text-[18px] md:text-[20px] font-[500]">
          {title}
        </h2>
        <button
          type="button"
          aria-label={folded ? 'Expand' : 'Collapse'}
          onClick={onToggle}
          className="hidden md:flex group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] items-center justify-center cursor-pointer select-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="7"
            height="13"
            viewBox="0 0 7 13"
            fill="none"
          >
            <path
              d="M6 11.5L1 6.5L6 1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="flex flex-row md:flex-col gap-[8px] md:gap-[12px] overflow-x-auto md:overflow-visible scrollbar-none -mx-[12px] px-[12px] md:mx-0 md:px-0 [&>*]:shrink-0 [&>*]:max-w-[200px] [&>*]:pe-[8px] md:[&>*]:max-w-none md:[&>*]:pe-0">
        {children}
      </div>
      {footer}
    </div>
  );
};
