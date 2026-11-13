export const dynamic = 'force-dynamic';
import {
  AffiliateComponent,
  AffiliateTwaNotice,
} from '@hookpost/frontend/components/affiliates/affiliate.component';
import { isTwaServerSide } from '@hookpost/frontend/components/layout/twa.server';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Hookpost Affiliate Programme',
  description: '',
};

export default async function Page() {
  // Google Play app: no dashboard and no payout-details form, server-rendered
  // or not. Android opens any hookpost.hookstep.in link in the installed app,
  // so hiding the menu item is not enough. The client check in
  // AffiliateComponent covers a first launch, before the cookie exists.
  const isTwa = await isTwaServerSide();
  return (
    <div className="bg-newBgColorInner flex-1 flex-col flex p-[20px] gap-[12px]">
      {isTwa ? <AffiliateTwaNotice /> : <AffiliateComponent />}
    </div>
  );
}
