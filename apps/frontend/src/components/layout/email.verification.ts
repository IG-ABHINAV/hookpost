/**
 * The "confirm your email to publish" step, for a password sign-up that is
 * signed in before it has used the link we emailed (since 25 Oct 2026). The
 * backend refuses publishing with 403 { code: 'EMAIL_NOT_VERIFIED' }
 * (EmailNotVerifiedException) and answers the banner's buttons through
 * /verify-email (email-verification.controller.ts).
 */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/**
 * True for a signed-in user who must confirm their address before using
 * anything (the hard gate, 29 Oct 2026): /user/self says so
 * (emailVerificationRequired), from the backend's one rule
 * (email.verification.ts mustVerifyEmail). Never true for a Google sign-in.
 */
export const needsEmailVerification = (
  user: { emailVerificationRequired?: boolean | null } | undefined | null
) => !!user && user.emailVerificationRequired === true;

/** The backend's refusal of any other route while that is so. */
export const EMAIL_VERIFICATION_REQUIRED = 'EMAIL_VERIFICATION_REQUIRED';

/** True for the backend's "confirm your email first" refusal. */
export const isEmailNotVerifiedRefusal = (status: number, body: unknown) =>
  status === 403 &&
  !!body &&
  typeof body === 'object' &&
  (body as { code?: unknown }).code === EMAIL_NOT_VERIFIED;

/**
 * Reads a response as that refusal without using up its body, so the caller
 * still gets it whole (the composer shows its own line, post.save.error.ts).
 */
export const readEmailNotVerifiedRefusal = async (
  response: Response | undefined
): Promise<{ message: string } | null> => {
  if (!response || response.status !== 403) {
    return null;
  }
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isEmailNotVerifiedRefusal(response.status, body)) {
    return null;
  }
  return {
    message:
      typeof body.message === 'string' && body.message
        ? body.message
        : 'Confirm your email address to publish.',
  };
};

let lastResend: { at: number; text: string } | null = null;

/** The outcome of the dialog's resend, for the composer's line just after. */
export const recordVerificationResend = (text: string, now = Date.now()) => {
  lastResend = { at: now, text };
};

/**
 * The composer's line for a post refused this way. The refusal's dialog
 * (layout.context.tsx) runs first and may have resent the link; the
 * composer's toast replaces the dialog's, so it carries that outcome.
 */
export const verificationRefusalLine = (now = Date.now()) => {
  const base = 'Not published: confirm your email first.';
  if (lastResend && now - lastResend.at < 15_000) {
    return `${base} ${lastResend.text}`;
  }
  return `${base} Use "Resend link" at the top of the page if the email has not arrived.`;
};

let promptOpen = false;

/**
 * Shows `prompt` unless one is already open: a refusal can arrive from
 * several requests at once (a post to three channels), and one dialog is
 * enough. Answers false for the ones that were skipped.
 */
export const showVerificationPromptOnce = async (
  prompt: () => Promise<boolean>
) => {
  if (promptOpen) {
    return false;
  }
  promptOpen = true;
  try {
    return await prompt();
  } finally {
    promptOpen = false;
  }
};

/** What POST /verify-email/resend and /verify-email/change answer. */
export type VerificationSendResult =
  | { sent: true; email: string }
  | { sent: false; reason: 'already_verified' }
  | { sent: false; reason: 'throttled'; retryAfterSeconds: number };

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const waitFor = (seconds: number) =>
  seconds >= 3600
    ? count(Math.ceil(seconds / 3600), 'hour')
    : seconds >= 60
    ? count(Math.ceil(seconds / 60), 'minute')
    : count(Math.max(1, Math.ceil(seconds)), 'second');

/** The line the banner shows after Resend or Change address. */
export const sendResultMessage = (
  result: Partial<VerificationSendResult> | null | undefined
): { text: string; ok: boolean } => {
  if (result && result.sent === true && typeof result.email === 'string') {
    return {
      ok: true,
      text: `Sent to ${result.email}. Check your inbox, and the spam folder too.`,
    };
  }
  if (result && result.sent === false && result.reason === 'already_verified') {
    return { ok: true, text: 'Your email is already confirmed.' };
  }
  if (
    result &&
    result.sent === false &&
    result.reason === 'throttled' &&
    typeof (result as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
  ) {
    return {
      ok: false,
      text: `We just sent one. You can send another in ${waitFor(
        (result as { retryAfterSeconds: number }).retryAfterSeconds
      )}.`,
    };
  }
  return { ok: false, text: 'Could not send the email. Please try again.' };
};
