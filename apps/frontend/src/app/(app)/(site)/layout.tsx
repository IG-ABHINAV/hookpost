import '../app-styles';
import { LayoutComponent } from '@hookpost/frontend/components/new-layout/layout.component';
import { earlyFetchScript } from '@hookpost/helpers/utils/early.fetch';

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const backendUrl =
    process.env.PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL;
  return (
    <>
      {/* Starts /user/self (and /launches' channels) while the app's
          JavaScript is still loading. Secure cookies only: under NOT_SECURED
          the session travels as a header this script does not send. See
          early.fetch.ts. */}
      {!process.env.NOT_SECURED && !!backendUrl && (
        <script
          dangerouslySetInnerHTML={{ __html: earlyFetchScript(backendUrl) }}
        />
      )}
      <LayoutComponent>{children}</LayoutComponent>
    </>
  );
}
