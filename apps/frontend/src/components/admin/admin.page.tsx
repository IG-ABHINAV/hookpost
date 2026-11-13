'use client';

import { FC, ReactNode, useEffect, useRef } from 'react';

/**
 * Copies each table's column names onto its cells as data-label, so that on
 * a phone (mobile.scss, `.admin-page`) every row can be shown as a card of
 * "Label  value" lines instead of a table that scrolls sideways. A cell under
 * an empty header gets no label (actions, avatars).
 */
export function labelTableCells(root: ParentNode) {
  root.querySelectorAll('table').forEach((table) => {
    const headers = [...table.querySelectorAll('thead th')].map((th) =>
      (th.textContent || '').trim()
    );
    if (!headers.length) return;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      let col = 0;
      [...tr.children].forEach((cell) => {
        const label = headers[col] ?? '';
        if (cell.getAttribute('data-label') !== label) {
          cell.setAttribute('data-label', label);
        }
        col += Number(cell.getAttribute('colspan')) || 1;
      });
    });
  });
}

/**
 * The frame of every admin page: phone-sized padding, nothing wider than the
 * screen, and tables that turn into cards on a phone.
 */
export const AdminPage: FC<{ children: ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    labelTableCells(el);
    // Rows arrive and change after the first render (SWR, filters, paging).
    const observer = new MutationObserver(() => labelTableCells(el));
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="admin-page admin-touch bg-newBgColorInner flex-1 min-w-0 max-w-full flex-col flex p-[12px] md:p-[20px] gap-[12px]"
    >
      {children}
    </div>
  );
};
