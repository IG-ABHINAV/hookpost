'use client';

import React, { FC, useCallback, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';
import { Button } from '@hookpost/react/form/button';
import { setCookie } from '@hookpost/frontend/components/layout/layout.context';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { TrashIcon } from '@hookpost/frontend/components/ui/icons';

const DeleteAccountComponent: FC<{ isLink?: boolean }> = ({ isLink }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [loading, setLoading] = useState(false);

  const deleteAccount = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'delete_account_confirm',
          'This deletes your account and the workspaces you own, with their channels and posts. At once, you are signed out, your channel and app connections are revoked and nothing more is published; everything else is erased 30 days later. This cannot be undone. Are you sure?'
        ),
        t('yes_delete_my_account', 'Yes, delete my account')
      ))
    ) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/user/delete-account', {
        method: 'POST',
      });

      if (response.status !== 200 && response.status !== 201) {
        const { message } = await response.json().catch(() => ({
          message: '',
        }));
        toaster.show(
          message ||
            t('could_not_delete_account', 'Could not delete your account'),
          'warning'
        );
        return;
      }

      // Readable copies too (the backend expires its httpOnly cookies).
      setCookie('auth', '', -10);
      setCookie('showorg', '', -10);
      setCookie('impersonate', '', -10);
      window.location.href = '/';
    } finally {
      setLoading(false);
    }
  }, []);

  const loadingOverlay = loading && (
    <div className="text-textColor fixed start-0 top-0 bg-primary/80 z-[500] w-full h-full animate-fade flex flex-col items-center justify-center gap-[24px]">
      <div className="w-[48px] h-[48px] border-[3px] border-forth border-t-transparent rounded-full animate-spin" />
      <div className="text-[20px] font-semibold">
        {t('deleting_your_account', 'Deleting your account...')}
      </div>
      <div className="text-[14px] text-textItemBlur">
        {t(
          'deleting_your_account_description',
          'We are removing your channels and posts, this can take a while. Please don’t close this window.'
        )}
      </div>
    </div>
  );

  if (isLink) {
    return (
      <>
        {loadingOverlay}
        <div
          className="cursor-pointer flex items-center gap-[8px] text-red-400 hover:text-red-500 text-[14px]"
          onClick={deleteAccount}
        >
          <TrashIcon size={16} />
          <div>{t('delete_account', 'Delete Account')}</div>
        </div>
      </>
    );
  }

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[24px]">
      {loadingOverlay}
      <div className="mt-[4px]">{t('delete_account', 'Delete Account')}</div>
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <div className="text-[14px]">
            {t('delete_your_account', 'Delete your account')}
          </div>
          <div className="text-[12px] text-textItemBlur">
            {t(
              'delete_account_description',
              'Signs you out, revokes your channel and app connections and cancels scheduled posts at once; everything else is erased 30 days later.'
            )}{' '}
            <a
              href="/data-deletion#what-we-keep"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {t('delete_account_details', 'What is erased, and when')}
            </a>
          </div>
        </div>
        <Button
          className="!bg-red-800"
          loading={loading}
          onClick={deleteAccount}
        >
          {t('delete_account', 'Delete Account')}
        </Button>
      </div>
    </div>
  );
};

export default DeleteAccountComponent;
