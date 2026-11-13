import { ReactNode } from 'react';
import { AdSenseScript } from '@hookpost/frontend/components/layout/adsense';

// Public content pages carry AdSense auto ads (components/layout/adsense.tsx).
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <AdSenseScript />
      {children}
    </>
  );
}
