import '../app-styles';
import { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Join a team',
  robots: { index: false, follow: false },
};

/**
 * The Join question (components/invite/invite.confirm.tsx), outside the
 * app's own shell: a workspace that has to start its trial would otherwise
 * get the paywall or the connect step instead of the question.
 */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[#0B0A0A] flex flex-1 min-h-screen w-full">{children}</div>
  );
}
