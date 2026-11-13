'use client';

import { FC, useState } from 'react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import { useClickOutside } from '@mantine/hooks';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import { DropdownArrowIcon } from '@hookpost/frontend/components/ui/icons';

export const BellIcon: FC<{ className?: string }> = ({ className }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

/**
 * "Remind me to post (add music in the app)", per channel. Instagram, TikTok
 * and YouTube let licensed or trending music be added only inside their own
 * apps, so no API can attach it. A channel set here is not published by
 * Hookpost: at the scheduled time the workspace gets the media and caption
 * (email, notification, /reminder/<id>) and posts it from the app.
 */
export const RemindComponent: FC = () => {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const { selectedIntegrations, reminders, setReminder } = useLaunchStore(
    useShallow((state) => ({
      selectedIntegrations: state.selectedIntegrations,
      reminders: state.reminders,
      setReminder: state.setReminder,
    }))
  );

  const ref = useClickOutside(() => {
    if (!isOpen) {
      return;
    }
    setIsOpen(false);
  });

  const reminded = selectedIntegrations.filter(
    (p) => reminders[p.integration.id]
  );
  const all =
    !!selectedIntegrations.length &&
    reminded.length === selectedIntegrations.length;

  if (!selectedIntegrations.length) {
    return null;
  }

  return (
    <div
      ref={ref}
      data-testid="remind-me-to-post"
      className={clsx(
        'border rounded-[8px] justify-center flex items-center relative h-[40px] md:h-[44px] text-[13px] md:text-[15px] font-[600] select-none',
        isOpen || reminded.length
          ? 'border-hp-primary'
          : 'border-newTextColor/10'
      )}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="px-[8px] md:px-[16px] justify-center flex gap-[5px] md:gap-[8px] items-center h-full select-none flex-1 cursor-pointer whitespace-nowrap md:whitespace-normal"
      >
        <BellIcon />
        <span>
          {!reminded.length
            ? (
              <>
                <span className="hidden md:inline">
                  {t('remind_me_to_post', 'Remind me to post')}
                </span>
                <span className="md:hidden">{t('remind_me', 'Remind me')}</span>
              </>
            )
            : all
            ? t('remind_me_to_post_all', 'Remind me to post: all channels')
            : `${t('remind_me_to_post_some', 'Remind me to post:')} ${
                reminded.length
              }/${selectedIntegrations.length}`}
        </span>
        <span className="hidden md:flex">
          <DropdownArrowIcon rotated={isOpen} />
        </span>
      </button>
      {isOpen && (
        <div
          role="dialog"
          className="z-[300] absolute start-0 bottom-[100%] w-[320px] max-w-[calc(100vw-32px)] bg-newBgColorInner p-[16px] menu-shadow -translate-y-[10px] flex flex-col gap-[12px] text-[14px] font-[500]"
        >
          <div className="font-[600] text-[15px]">
            {t(
              'remind_me_to_post_title',
              'Remind me to post (add music in the app)'
            )}
          </div>
          <div className="text-textColor/70 text-[13px] leading-[18px]">
            {t(
              'remind_me_to_post_explain',
              "Instagram, TikTok and YouTube let you add licensed music only in their own apps. For the channels you tick, Hookpost won't publish: at the scheduled time we email you the file and caption, you add the sound in the app and post it."
            )}
          </div>
          <label className="flex items-center gap-[10px] cursor-pointer">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                for (const p of selectedIntegrations) {
                  setReminder(p.integration.id, e.target.checked);
                }
              }}
              className="w-[16px] h-[16px] accent-hp-primary"
            />
            <span>{t('all_channels', 'All channels')}</span>
          </label>
          <div className="flex flex-col gap-[8px] border-t border-newBorder pt-[12px] max-h-[220px] overflow-y-auto">
            {selectedIntegrations.map((p) => (
              <label
                key={p.integration.id}
                className="flex items-center gap-[10px] cursor-pointer"
              >
                <input
                  type="checkbox"
                  data-testid={`remind-${p.integration.id}`}
                  checked={!!reminders[p.integration.id]}
                  onChange={(e) =>
                    setReminder(p.integration.id, e.target.checked)
                  }
                  className="w-[16px] h-[16px] accent-hp-primary"
                />
                <img
                  src={`/icons/platforms/${p.integration.identifier}.png`}
                  className="w-[20px] h-[20px] rounded-[4px]"
                  alt=""
                />
                <span className="truncate">{p.integration.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
