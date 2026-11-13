export const dynamic = 'force-dynamic';
import { AdminMarketplacesComponent } from '@hookpost/frontend/components/admin/admin-marketplaces.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Marketplaces`,
  description: 'Super Admin view of the API marketplaces that resell Hookpost: subscribers, calls and refusals.',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminMarketplacesComponent />
    </AdminPage>
  );
}
