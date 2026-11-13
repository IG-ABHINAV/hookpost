export const dynamic = 'force-dynamic';
import { AdminAffiliatesComponent } from '@hookpost/frontend/components/admin/admin-affiliates.component';
import { AdminPage } from '@hookpost/frontend/components/admin/admin.page';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Hookpost Admin Affiliates',
  description: '',
};

export default async function Page() {
  return (
    <AdminPage>
      <AdminAffiliatesComponent />
    </AdminPage>
  );
}
