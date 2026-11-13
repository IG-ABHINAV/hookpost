export const dynamic = 'force-dynamic';
import { AdminStatsComponent } from '@hookpost/frontend/components/admin/admin-stats.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Stats`,
  description: '',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminStatsComponent />
    </AdminPage>
  );
}
