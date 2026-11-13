'use client';

import { FC, useEffect, useState } from 'react';
import { useCustomProviderFunction } from '@hookpost/frontend/components/launches/helpers/use.custom.provider.function';
import { Select } from '@hookpost/react/form/select';
import { useSettings } from '@hookpost/frontend/components/launches/helpers/use.values';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
export const PinterestBoard: FC<{
  name: string;
  onChange: (event: {
    target: {
      value: string;
      name: string;
    };
  }) => void;
}> = (props) => {
  const { onChange, name } = props;
  const t = useT();

  const customFunc = useCustomProviderFunction();
  const [orgs, setOrgs] = useState<undefined | any[]>();
  const { getValues } = useSettings();
  const [currentMedia, setCurrentMedia] = useState<string | undefined>();
  const onChangeInner = (event: {
    target: {
      value: string;
      name: string;
    };
  }) => {
    setCurrentMedia(event.target.value);
    onChange(event);
  };
  useEffect(() => {
    customFunc.get('boards').then((data) => setOrgs(data));
    const settings = getValues()[props.name];
    if (settings) {
      setCurrentMedia(settings);
    }
  }, []);
  if (!orgs) {
    return null;
  }
  if (!orgs.length) {
    return (
      <div className="p-[10px] bg-amber-500/10 border border-amber-500/30 rounded-[8px] text-[12px] flex flex-col gap-[6px]">
        <div className="text-amber-300 font-[600]">
          {t('no_pinterest_boards', 'No Pinterest boards found')}
        </div>
        <p className="opacity-80">
          {t('create_board_desc', 'Pinterest requires a board to publish pins. Please create a board on Pinterest first.')}
        </p>
        <div className="flex items-center gap-[10px] mt-[4px]">
          <a
            href="https://www.pinterest.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:underline font-[600]"
          >
            {t('open_pinterest', 'Open Pinterest ↗')}
          </a>
          <button
            type="button"
            onClick={() => {
              setOrgs(undefined);
              customFunc.get('boards').then((data) => setOrgs(data));
            }}
            className="text-[11px] px-[8px] py-[3px] bg-white/10 hover:bg-white/20 rounded-[4px] text-white"
          >
            {t('refresh_boards', 'Refresh')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <Select
      name={name}
      label="Select board"
      onChange={onChangeInner}
      value={currentMedia}
    >
      <option value="">{t('select_1', '--Select--')}</option>
      {orgs.map((org: any) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </Select>
  );
};
