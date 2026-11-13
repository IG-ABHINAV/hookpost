export const dynamic = 'force-dynamic';
import { AdminErrorsComponent } from '@hookpost/frontend/components/admin/admin-errors.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Errors`,
  description: '',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminErrorsComponent />
    </AdminPage>
  );
}
