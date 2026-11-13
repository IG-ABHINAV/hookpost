'use client';

import { FC, ReactNode, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import { Button } from '@hookpost/react/form/button';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useCustomProviderFunction } from '@hookpost/frontend/components/launches/helpers/use.custom.provider.function';

const SWR_OPTIONS = {
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  revalidateOnFocus: false,
  revalidateIfStale: false,
  revalidateOnMount: true,
  revalidateOnReconnect: false,
  refreshInterval: 0,
};

export interface ContinueProviderProps {
  onSave: (data: any) => Promise<void>;
  existingId: string[];
  initialData?: any[];
  isSaving?: boolean;
  /**
   * Drops the half-connected channel (the placeholder the login created) and
   * leaves. Without it the empty state was a dead end: its text said to close
   * the dialog and delete the integration, and the page had neither button.
   */
  onCancel?: () => Promise<void> | void;
  /**
   * Lets the empty state start a different connect from here (Instagram
   * login). Left out where that connect would land somewhere else: no
   * session, an api.market connect, or one that returns to an app.
   */
  otherConnect?: OtherConnect;
}

export interface OtherConnect {
  /** Carry ?onboarding=true, so the next onboarding step follows. */
  onboarding?: boolean;
  /** Runs before leaving, e.g. to drop the half-connected placeholder. */
  beforeLeave?: () => Promise<void>;
}

/** Help shown on the picker itself: open when the list is empty. */
export interface PickerHelpProps {
  otherConnect?: OtherConnect;
  empty: boolean;
}

export interface EmptyStateMessage {
  key: string;
  text: string;
}

/** A link out to create what the account is missing, e.g. a Facebook Page. */
export interface EmptyStateAction {
  key: string;
  text: string;
  url: string;
}

/**
 * The page list as the picker can use it. /integrations/function answers 200
 * with `false` when the platform refused the token, and the error body of a
 * failed call is an object; neither is "no pages", so both are errors.
 */
export const pickerItems = <TItem,>(result: unknown, endpoint: string): TItem[] => {
  if (Array.isArray(result)) {
    return result as TItem[];
  }
  const message =
    (result as { message?: unknown } | null)?.message ||
    `Could not load the list (${endpoint})`;
  throw new Error(String(message));
};

export interface ContinueProviderConfig<TItem, TSelection> {
  endpoint: string;
  swrKey: string;
  titleKey: string;
  titleDefault: string;
  emptyStateMessages: EmptyStateMessage[];
  emptyStateAction?: EmptyStateAction;
  /**
   * Leads the empty state, above its text: what was found and the quickest
   * way out, e.g. connecting Instagram without a Facebook Page.
   */
  EmptyStateLead?: FC<{ otherConnect?: OtherConnect }>;
  /**
   * What the account needs to show up here, with or without a list: open
   * when it is empty, collapsed under the list when it is not.
   */
  PickerHelp?: FC<PickerHelpProps>;
  getSelectionValue: (item: TItem) => TSelection;
  transformSaveData: (selection: TSelection) => any;
  renderItem: (item: TItem, isSelected: boolean) => ReactNode;
  isSelected: (item: TItem, selection: TSelection | null) => boolean;
  getItemId: (item: TItem) => string;
}

export function withContinueProvider<TItem, TSelection>(
  config: ContinueProviderConfig<TItem, TSelection>
): FC<ContinueProviderProps> {
  const {
    endpoint,
    swrKey,
    titleKey,
    titleDefault,
    emptyStateMessages,
    emptyStateAction,
    EmptyStateLead,
    PickerHelp,
    getSelectionValue,
    transformSaveData,
    renderItem,
    isSelected,
    getItemId,
  } = config;

  return function ContinueProviderComponent(props: ContinueProviderProps) {
    const { onSave, existingId, initialData, isSaving, onCancel, otherConnect } =
      props;
    const call = useCustomProviderFunction();
    const t = useT();
    const [selections, setSelections] = useState<TSelection[]>([]);
    const [cancelling, setCancelling] = useState(false);

    const loadData = useCallback(async () => {
      // Skip fetch if initial data was provided
      if (initialData) {
        return initialData;
      }
      // An error used to be swallowed here and shown as "no pages".
      try {
        return pickerItems<TItem>(await call.get(endpoint), endpoint);
      } catch (e) {
        console.error(`Could not load the ${endpoint} to pick from`, e);
        throw e;
      }
    }, [initialData]);

    const { data, isLoading, error, mutate } = useSWR(
      initialData ? null : swrKey,
      loadData,
      { ...SWR_OPTIONS, shouldRetryOnError: false }
    );

    const cancel = useCallback(async () => {
      if (!onCancel) return;
      setCancelling(true);
      try {
        await onCancel();
      } finally {
        setCancelling(false);
      }
    }, [onCancel]);

    const actions = (withCreate: boolean) =>
      (withCreate && emptyStateAction) || onCancel ? (
        <div className="flex flex-wrap justify-center gap-[12px]">
          {withCreate && emptyStateAction && (
            <a
              href={emptyStateAction.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-[40px] items-center rounded-[8px] bg-btnPrimary px-[16px] text-[14px] font-[600] text-hp-on-primary"
            >
              {t(emptyStateAction.key, emptyStateAction.text)}
            </a>
          )}
          {onCancel && (
            <Button
              className="rounded-[8px]"
              secondary={true}
              loading={cancelling}
              disabled={cancelling}
              onClick={cancel}
            >
              {t('cancel', 'Cancel')}
            </Button>
          )}
        </div>
      ) : null;

    const resolvedData = initialData || data;

    const filteredData = useMemo(() => {
      return (
        (resolvedData as TItem[])?.filter(
          (item) => !existingId.includes(getItemId(item))
        ) || []
      );
    }, [resolvedData, existingId]);

    const handleToggle = useCallback(
      (item: TItem) => () => {
        setSelections((prev) => {
          const exists = prev.some((s) => isSelected(item, s));
          if (exists) {
            return prev.filter((s) => !isSelected(item, s));
          } else {
            return [...prev, getSelectionValue(item)];
          }
        });
      },
      [isSelected, getSelectionValue]
    );

    const isAllSelected = useMemo(() => {
      return (
        filteredData.length > 0 &&
        filteredData.every((item) =>
          selections.some((s) => isSelected(item, s))
        )
      );
    }, [filteredData, selections, isSelected]);

    const handleToggleAll = useCallback(() => {
      if (isAllSelected) {
        setSelections([]);
      } else {
        setSelections(filteredData.map(getSelectionValue));
      }
    }, [isAllSelected, filteredData, getSelectionValue]);

    const handleSave = useCallback(async () => {
      if (!selections.length) return;
      if (selections.length === 1) {
        await onSave(transformSaveData(selections[0]));
      } else {
        await onSave({ items: selections.map(transformSaveData) });
      }
    }, [onSave, selections, transformSaveData]);

    if (!initialData && error) {
      return (
        <div className="text-center flex flex-col justify-center items-center gap-[20px] text-[16px] leading-[24px] min-h-[240px]">
          <span>
            {t(
              'could_not_load_pages',
              "We couldn't load the list from the platform. Try again, or cancel and add the channel again."
            )}
          </span>
          <div className="flex flex-wrap justify-center gap-[12px]">
            <Button className="rounded-[8px]" onClick={() => mutate()}>
              {t('try_again', 'Try again')}
            </Button>
            {actions(false)}
          </div>
        </div>
      );
    }

    if (!isLoading && !resolvedData?.length) {
      return (
        <div className="text-center flex flex-col justify-center items-center gap-[20px] text-[16px] leading-[24px] min-h-[240px]">
          {EmptyStateLead && <EmptyStateLead otherConnect={otherConnect} />}
          <div>
            {emptyStateMessages.map((msg, index) => (
              <span key={msg.key}>
                {t(msg.key, msg.text)}
                {index < emptyStateMessages.length - 1 && (
                  <>
                    <br />
                    <br />
                  </>
                )}
              </span>
            ))}
          </div>
          {PickerHelp && <PickerHelp otherConnect={otherConnect} empty={true} />}
          {actions(true)}
        </div>
      );
    }

    // Everything this login returned is connected already: a grid with
    // nothing in it and a Save button for nothing said none of that.
    if (!isLoading && !filteredData.length) {
      return (
        <div className="text-center flex flex-col justify-center items-center gap-[20px] text-[16px] leading-[24px] min-h-[240px]">
          <span>
            {t(
              'all_accounts_already_connected',
              'Every account on this login is already connected. To add another, it has to be shared with Hookpost when you log in.'
            )}
          </span>
          {PickerHelp && <PickerHelp otherConnect={otherConnect} empty={true} />}
          {actions(false)}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-[20px]">
        <div className="flex items-center justify-between">
          <div className="font-medium text-[15px]">
            {t(titleKey, titleDefault)}
          </div>
          {filteredData.length > 1 && (
            <button
              type="button"
              className="text-xs text-primary hover:underline font-semibold cursor-pointer focus:outline-none"
              onClick={handleToggleAll}
            >
              {isAllSelected
                ? t('deselect_all', 'Deselect All')
                : t('select_all', 'Select All')}
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 justify-items-center select-none cursor-pointer gap-[10px]">
          {filteredData.map((item) => {
            const selected = selections.some((s) => isSelected(item, s));
            return (
              <div
                key={getItemId(item)}
                className={clsx(
                  'relative flex flex-col w-full text-center gap-[10px] border border-input p-[10px] hover:bg-seventh hover:text-hp-on-primary rounded-[8px] transition-all cursor-pointer select-none',
                  selected && 'bg-seventh text-hp-on-primary border-primary ring-1 ring-primary'
                )}
                onClick={handleToggle(item)}
              >
                <div
                  className={clsx(
                    'absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center transition-all',
                    selected
                      ? 'bg-primary text-white shadow-sm'
                      : 'border border-border/80 bg-background/50 opacity-60'
                  )}
                >
                  {selected && (
                    <svg
                      className="w-3 h-3 stroke-current stroke-[3] fill-none"
                      viewBox="0 0 24 24"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
                {renderItem(item, selected)}
              </div>
            );
          })}
        </div>
        <div>
          <Button
            disabled={!selections.length || isSaving}
            loading={isSaving}
            onClick={handleSave}
          >
            {selections.length > 1
              ? `${t('connect_selected', 'Connect Selected')} (${selections.length})`
              : t('save', 'Save')}
          </Button>
        </div>
        {PickerHelp && <PickerHelp otherConnect={otherConnect} empty={false} />}
      </div>
    );
  };
}
