export const dynamic = 'force-dynamic';
import { AdminRefundsComponent } from '@hookpost/frontend/components/admin/admin-refunds.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Refunds`,
  description: '',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminRefundsComponent />
    </AdminPage>
  );
}
