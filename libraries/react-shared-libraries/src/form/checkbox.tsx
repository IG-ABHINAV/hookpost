'use client';

import { FC, forwardRef, KeyboardEvent, useCallback, useState } from 'react';
import clsx from 'clsx';
import { useFormContext, useWatch } from 'react-hook-form';
export const Checkbox = forwardRef<
  null,
  {
    checked?: boolean;
    disableForm?: boolean;
    name?: string;
    className?: string;
    label?: string;
    onChange?: (event: {
      target: {
        name?: string;
        value: boolean;
      };
    }) => void;
    variant?: 'default' | 'hollow';
    // Greys the box out and ignores clicks (it used to be passed and silently
    // dropped, so a "disabled" checkbox could still be toggled).
    disabled?: boolean;
    title?: string;
  }
>((props, ref: any) => {
  const { checked, className, label, disableForm, variant, disabled, title } =
    props;
  const form = useFormContext();
  const register = disableForm ? {} : form.register(props.name!);
  const watch = disableForm ? false : form.watch(props.name!);
  const val = watch || checked;

  const changeStatus = useCallback(() => {
    if (disabled) {
      return;
    }
    props?.onChange?.({
      target: {
        name: props.name!,
        value: !val,
      },
    });
    if (!disableForm) {
      // @ts-ignore
      register?.onChange?.({
        target: {
          name: props.name!,
          value: !val,
        },
      });
    }
  }, [val, disabled]);

  // A div, so it needs the checkbox role and keys to be reachable without a
  // mouse (Space toggles a checkbox; Enter too, as the old click did).
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        changeStatus();
      }
    },
    [changeStatus]
  );
  return (
    <div
      className={clsx('flex gap-[10px]', disabled && 'opacity-50')}
      title={title}
      aria-disabled={disabled || undefined}
    >
      <div
        ref={ref}
        {...disableForm ? {} : form.register(props.name!)}
        role="checkbox"
        aria-checked={!!val}
        aria-disabled={disabled || undefined}
        aria-label={label || undefined}
        tabIndex={disabled ? -1 : 0}
        onClick={changeStatus}
        onKeyDown={onKeyDown}
        className={clsx(
          'rounded-[4px] select-none w-[24px] h-[24px] justify-center items-center flex text-hp-on-primary',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          variant === 'default' || !variant
            ? // filled only when ticked, so an unticked box reads as off
              val
              ? 'bg-forth'
              : 'border-forth border-2'
            : 'border-customColor1 border-2 bg-customColor2',
          className
        )}
      >
        {val && (
          <div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        )}
      </div>
      {!!label && <div>{label}</div>}
    </div>
  );
});
