'use client';

import {
  createContext,
  FC,
  ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import {
  clearHostOnlySessionCookies,
  customFetch,
  Params,
} from './custom.fetch.func';
import { useVariables } from '@hookpost/react/helpers/variable.context';

const FetchProvider = createContext(
  customFetch(
    // @ts-ignore
    {
      baseUrl: '',
      beforeRequest: () => {},
      afterRequest: () => {
        return true;
      },
    } as Params
  )
);

export const FetchWrapperComponent: FC<Params & { children: ReactNode }> = (
  props
) => {
  const { children, ...params } = props;
  const { isSecured } = useVariables();
  // Before any child's effect can make a request (idempotent; a no-op on the
  // server). See clearHostOnlySessionCookies.
  if (isSecured) {
    clearHostOnlySessionCookies();
  }
  // @ts-ignore
  const fetchData = useRef(
    customFetch(params, undefined, undefined, isSecured)
  );
  return (
    // @ts-ignore
    <FetchProvider.Provider value={fetchData.current}>
      {children}
    </FetchProvider.Provider>
  );
};

export const useFetch = () => {
  return useContext(FetchProvider);
};
