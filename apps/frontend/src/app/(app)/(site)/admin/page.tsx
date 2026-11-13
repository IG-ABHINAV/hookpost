import { redirect } from 'next/navigation';

// /admin has no page of its own: open the first admin section.
export default function Page() {
  redirect('/admin/users');
}
