import {
  INVITE_RESULT_COOKIE,
  InviteOutcome,
  isInviteOutcome,
} from '@hookpost/helpers/auth/team.invite';

/**
 * What the app says after a team invite was redeemed (the backend or the
 * proxy leaves the outcome in INVITE_RESULT_COOKIE). Fixed sentences only:
 * the cookie holds one of INVITE_OUTCOMES, never a team name, so nothing a
 * workspace's maker typed can reach a toast this way.
 *
 * `held` says nothing here: the banner already says "You've been invited to
 * <team>. Confirm your email to join." (HeldInviteNotice), with the team
 * read from the server.
 */
const MESSAGES: Record<Exclude<InviteOutcome, 'held'>, { text: string; ok: boolean }> = {
  joined: { text: "You've joined the team.", ok: true },
  member: { text: "You're already a member of this team.", ok: true },
  invalid: {
    text: 'That invite link has expired or was already used. Ask whoever invited you for a new one.',
    ok: false,
  },
  full: {
    text: 'That team has no free seats. Ask its admin to free one or upgrade the plan, then open the invite again.',
    ok: false,
  },
  unavailable: {
    text: "That team's plan doesn't include team members right now. Ask its admin to check their plan.",
    ok: false,
  },
  error: {
    text: "We couldn't open that invite. Please open the link again.",
    ok: false,
  },
};

/** How much of a team name a toast shows (as the confirmation email does). */
const TEAM_NAME_MAX = 60;

/**
 * `team`: the workspace now shown (read from the server, never from the
 * cookie), so that joining is never silent about where the user landed:
 * someone who opened a link they were tricked into opening sees whose team
 * it is (review of 1162ff204). Plain text; React escapes it.
 */
export function inviteResultMessage(
  value: unknown,
  team?: string | null
): { text: string; ok: boolean } | null {
  if (!isInviteOutcome(value) || value === 'held') {
    return null;
  }
  const name = (team || '').trim();
  const shown =
    name.length > TEAM_NAME_MAX ? `${name.slice(0, TEAM_NAME_MAX - 1)}…` : name;
  if (shown && value === 'joined') {
    return { text: `You've joined ${shown}.`, ok: true };
  }
  if (shown && value === 'member') {
    return { text: `You're already a member of ${shown}.`, ok: true };
  }
  return MESSAGES[value];
}

/** The outcome in `cookieHeader` (document.cookie), or null. */
export function readInviteResult(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === INVITE_RESULT_COOKIE) {
      return rest.join('=') || null;
    }
  }
  return null;
}
