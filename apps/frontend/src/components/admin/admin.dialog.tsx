'use client';

import React, { FC, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * The modal the super admin pages use for anything that changes money or a
 * plan: a backdrop you can click away, the title in a bar, and the form
 * underneath. Shared by the Refunds page and the plan actions on Users &
 * Billing so the two confirmations look and behave the same.
 */
export const Dialog: FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, onClose, children }) => {
  const pressedBackdrop = useRef(false);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-[16px] animate-fade"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="admin-touch w-full max-w-[520px] bg-newBgColorInner text-textColor border border-newTableBorder rounded-[12px] shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-[16px] border-b border-newTableBorder bg-newBgColorInner flex items-center justify-between">
          <h2 className="text-[16px] font-[700] text-textColor">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
        <div className="p-[16px] flex flex-col gap-[12px] overflow-y-auto text-[13px]">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const Field: FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <label className="flex flex-col gap-[6px]">
    <span className="text-[12px] opacity-70">{label}</span>
    {children}
  </label>
);

export const inputCls =
  'h-[38px] rounded-[8px] bg-newBgColor border border-newTableBorder px-[10px] text-[14px] text-textColor';
