import { Metadata } from 'next';
import { ReminderPage } from '@hookpost/frontend/components/reminder/reminder.page';

export const metadata: Metadata = {
  title: 'Hookpost - Time to post',
  description: '',
  robots: { index: false, follow: false },
};

export default async function Page() {
  return <ReminderPage />;
}
