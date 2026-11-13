import { ContinueIntegration } from '@hookpost/frontend/components/launches/continue.integration';
import { cookies } from 'next/headers';
import { sessionLooksLive } from '@hookpost/helpers/auth/session.lifetime';

export const dynamic = 'force-dynamic';

export default async function Page(
  props: {
    params: Promise<{
      provider: string;
    }>;
    searchParams: Promise<any>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;

  const {
    provider
  } = params;

  // Signed in only with a session that has not expired (proxy.ts judges it
  // the same way); a dead one finishes the connect like a signed-out visitor.
  const get = (await cookies()).get('auth');
  return <ContinueIntegration searchParams={searchParams} provider={provider} logged={sessionLooksLive(get?.value)} />;
}
