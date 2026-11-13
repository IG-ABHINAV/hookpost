import { cookies } from 'next/headers';
import { internalFetch } from '@hookpost/helpers/utils/internal.fetch';
import {
  INVITE_COOKIE,
  looksLikeInviteToken,
} from '@hookpost/helpers/auth/team.invite';

/**
 * The line above the sign-up and sign-in forms when the visitor came from a
 * team invite (/invite/<token> left the token in the httpOnly invite cookie
 * and sent them here with ?invite=1). It names the team while the invite
 * can be redeemed, and says plainly when it cannot. Server-rendered: the
 * cookie is not readable by scripts, and the backend checks the token.
 *
 * The team name is plain text (React escapes it), never a link: it is
 * whatever the inviter typed.
 */
export async function InviteNotice({
  invite,
  mode,
}: {
  invite?: string;
  mode: 'signup' | 'login';
}) {
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  if (!looksLikeInviteToken(token)) {
    return invite === 'invalid' ? <Invalid /> : null;
  }

  let preview: { valid?: boolean; team?: unknown } | null = null;
  try {
    const res = await internalFetch('/auth/invite/preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    preview = res.ok ? await res.json() : null;
  } catch {
    preview = null;
  }

  if (preview && preview.valid === false) {
    return <Invalid />;
  }
  const team =
    preview?.valid && typeof preview.team === 'string' ? preview.team.trim() : '';
  const next =
    mode === 'login'
      ? 'Sign in to join.'
      : 'Create your account to join, or sign in if you already have one.';
  return (
    <div
      data-testid="invite-notice"
      role="status"
      className="rounded-[10px] border border-hp-primary/40 bg-hp-primary/10 px-[14px] py-[12px] text-[14px] leading-[1.5] text-white"
    >
      {team ? (
        <>
          {"You've been invited to join "}
          <span className="font-[600] break-all">{team}</span>
          {`. ${next}`}
        </>
      ) : (
        `You've been invited to join a team on Hookpost. ${next}`
      )}
    </div>
  );
}

function Invalid() {
  return (
    <div
      data-testid="invite-notice"
      data-invalid="true"
      role="status"
      className="rounded-[10px] border border-amber-500/50 bg-amber-500/10 px-[14px] py-[12px] text-[14px] leading-[1.5] text-white"
    >
      This invite link has expired or was already used. Ask whoever invited
      you for a new one. You can still create your own account.
    </div>
  );
}
