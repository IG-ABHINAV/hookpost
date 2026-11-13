'use client';

import { useCallback } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { fetchConnectLink } from '@hookpost/frontend/components/launches/add.channel.helpers';

/**
 * The connect link for a provider (GET /integrations/social/...), or null when
 * there is none to follow. A plan refusal (402) has already shown the plan
 * dialog, so it adds nothing; any other failure says the platform could not
 * be reached. Every Add Channel and reconnect path goes through this, so a
 * dismissed plan dialog leaves the user where they were.
 */
export const useConnectLink = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  return useCallback(
    async (path: string): Promise<string | null> => {
      const link = await fetchConnectLink(fetch, path);
      if (link.url) {
        return link.url;
      }
      if (!link.planRefused) {
        toaster.show(
          t('could_not_connect_to_platform', 'Could not connect to the platform'),
          'warning'
        );
      }
      return null;
    },
    [fetch, toaster, t]
  );
};
