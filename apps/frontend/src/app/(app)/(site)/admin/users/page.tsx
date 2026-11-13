export const dynamic = 'force-dynamic';
import { AdminUsersComponent } from '@hookpost/frontend/components/admin/admin-users.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Hookpost' : 'Gitroom'} Admin Users & Billing`,
  description: 'Master Super Admin directory for users, workspaces, Razorpay billing, and subscription management.',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminUsersComponent />
    </AdminPage>
  );
}
