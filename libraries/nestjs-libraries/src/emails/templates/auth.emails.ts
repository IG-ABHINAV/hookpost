import {
  appUrl,
  buildEmail,
  button,
  details,
  escapeHtml,
  heading,
  linkFallback,
  paragraph,
  RenderedEmail,
  strong,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';

/**
 * A name somebody else typed (a workspace's), as text that cannot become a
 * link: escaped, at most 60 characters, and a zero-width space after every
 * character a mail client's linkifier joins a URL or address on, so
 * "verify.example/login" is never turned into one.
 */
export function inertName(name: string) {
  const short = [...String(name || '')].slice(0, 60).join('');
  return escapeHtml(short).replace(/([.:/@])/g, '$1​');
}

/**
 * Sent on sign-up with email + password, and when the link is re-sent. The
 * account works before this is used; publishing waits for it. The link signs
 * in on whatever phone or browser opens it, and works for `expiresInDays`.
 */
export function activationEmail(params: {
  activationUrl: string;
  expiresInDays?: number;
  /** The workspace whose invite is held until this link is used. */
  invitedTo?: string | null;
}): RenderedEmail {
  const { activationUrl, expiresInDays = 7, invitedTo } = params;
  return buildEmail('Confirm your email for Hookpost', {
    preheader: 'One tap and your posts can go out.',
    kind: 'transactional',
    body:
      heading('Confirm your email') +
      (invitedTo
        ? paragraph(
            `You've been invited to ${strong(inertName(invitedTo))}. Confirm your email to join.`
          )
        : '') +
      paragraph(
        'Thanks for signing up for Hookpost. Confirm this is your email address so your posts can go out. You can already connect your channels and plan posts.'
      ) +
      button('Confirm email', activationUrl) +
      linkFallback(activationUrl) +
      paragraph(
        `The link works for ${strong(
          `${expiresInDays} days`
        )} and signs you in on whichever phone or browser opens it.`,
        { muted: true, small: true }
      ) +
      paragraph(
        "Didn't sign up? You can ignore this email. Nothing is published from the account until the link is used.",
        { muted: true, small: true }
      ),
  });
}

/**
 * Sent when the owner of an address takes over a password account that was
 * never confirmed (Google sign-in or a reset link on that address), and the
 * account was in someone else's workspace or held an invite to one. Anyone
 * who knew the address could have made the account and joined it there, so
 * those are dropped; a real invitee asks to be invited again.
 *
 * Only how many: a workspace name is whatever its maker typed, and in a
 * Hookpost email a name like "Verify at evil.example" is a phishing line.
 * The names are in the server log (AuthService.secureTakeover).
 */
export function workspacesRemovedEmail(params: { count: number }): RenderedEmail {
  const count = Math.max(1, Math.floor(params.count));
  const what = count === 1 ? '1 shared workspace' : `${count} shared workspaces`;
  return buildEmail('Your Hookpost account was removed from a workspace', {
    preheader: 'If your team invited you, ask them to invite you again.',
    kind: 'transactional',
    body:
      heading('You were removed from a workspace') +
      paragraph(
        `You just confirmed this address. Before that, the account was not confirmed, so anyone who knew the address could have made it and joined it to their own workspace. To keep your account yours, we removed it from ${strong(
          what
        )} it had joined or been invited to.`
      ) +
      paragraph(
        'If your team invited you, ask them to invite you again. Your own workspace is untouched.'
      ) +
      button('Open Hookpost', `${appUrl()}/launches`) +
      paragraph("Didn't expect this? Reply to this email and we'll look into it.", {
        muted: true,
        small: true,
      }),
  });
}

/** Sent from "Forgot password". The link is a 20-minute token. */
export function passwordResetEmail(params: {
  resetUrl: string;
  expiresInMinutes?: number;
}): RenderedEmail {
  const { resetUrl, expiresInMinutes = 20 } = params;
  return buildEmail('Reset your Hookpost password', {
    preheader: `This link works for ${expiresInMinutes} minutes.`,
    kind: 'transactional',
    body:
      heading('Reset your password') +
      paragraph(
        `We got a request to reset the password on your Hookpost account. The link below works for ${strong(
          `${expiresInMinutes} minutes`
        )}.`
      ) +
      button('Reset password', resetUrl) +
      linkFallback(resetUrl) +
      paragraph(
        "Didn't ask for this? Ignore this email and your password stays the same.",
        { muted: true, small: true }
      ),
  });
}

/** Sent when someone invites a person to their workspace by email. */
export function teamInviteEmail(params: {
  inviterName?: string | null;
  inviterEmail: string;
  orgName: string;
  inviteUrl: string;
  expiresInDays?: number;
}): RenderedEmail {
  const { inviterName, inviterEmail, orgName, inviteUrl, expiresInDays = 2 } = params;
  const who = inviterName || inviterEmail;
  const whoHtml = inviterName
    ? `${strong(escapeHtml(inviterName))} (${escapeHtml(inviterEmail)})`
    : strong(escapeHtml(inviterEmail));

  return buildEmail(`${who} invited you to join "${orgName}"`, {
    preheader: `Join the ${orgName} workspace on Hookpost. The invite expires in ${expiresInDays} days.`,
    kind: 'transactional',
    reason: `You received this email because ${who} invited you to a Hookpost workspace.`,
    body:
      heading(`Join ${escapeHtml(orgName)} on Hookpost`) +
      paragraph(
        `${whoHtml} has invited you to the ${strong(
          escapeHtml(orgName)
        )} workspace, where the team plans and schedules its social posts.`
      ) +
      button('Accept invitation', inviteUrl) +
      linkFallback(inviteUrl) +
      paragraph(
        `This invitation expires in ${expiresInDays} days. Not expecting it? You can ignore this email.`,
        { muted: true, small: true }
      ),
  });
}

/**
 * Security notice when an admin changes sign-in emails. Sent to every address
 * involved, old and new, so the previous owner of an address always hears
 * about it. `changes` lists each account's old -> new address; the admin tool
 * swaps two accounts, so it is usually two rows (a -> b and b -> a).
 */
export function loginChangedEmail(params: {
  changes: Array<{ from: string; to: string }>;
  recipient: string;
}): RenderedEmail {
  const { changes, recipient } = params;
  const mine = changes.find((c) => c.from.toLowerCase() === recipient.toLowerCase());
  const swap = changes.length > 1;
  const rows: Array<[string, string]> = changes.map((c) => [
    `Signed in with ${escapeHtml(c.from)}`,
    `now signs in with ${escapeHtml(c.to)}`,
  ]);

  return buildEmail('Your Hookpost sign-in email changed', {
    preheader: mine
      ? `Your account no longer signs in with ${mine.from}. It now uses ${mine.to}.`
      : `An administrator changed which account ${recipient} signs in to.`,
    kind: 'transactional',
    reason: `You received this security notice because ${recipient} was one of the addresses involved.`,
    body:
      heading('Your sign-in email changed') +
      paragraph(
        swap
          ? `An administrator swapped the sign-in emails of two Hookpost accounts. ${strong(
              escapeHtml(recipient)
            )} was one of them, so we're telling both the old and the new address.`
          : `An administrator changed the sign-in email on your Hookpost account. We're telling both the old and the new address.`
      ) +
      details(rows) +
      paragraph(
        'Each account keeps its own workspaces, plan and subscription; only the sign-in address moved. If you meant to cancel a subscription, do that separately from Billing.'
      ) +
      button('Sign in', `${appUrl()}/auth/login`) +
      paragraph("Didn't expect this? Reply to this email straight away and we'll look into it.", {
        muted: true,
        small: true,
      }),
  });
}
