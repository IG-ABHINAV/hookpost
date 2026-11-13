export const dynamic = 'force-dynamic';
import { AdminContactComponent } from '@hookpost/frontend/components/admin/admin-contact.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Contact`,
  description: '',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminContactComponent />
    </AdminPage>
  );
}
