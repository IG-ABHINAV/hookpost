/**
 * The "confirm your email to publish" step (25 Oct 2026): a password sign-up
 * is signed in before it confirms its address, and the backend refuses its
 * posts with 403 { code: 'EMAIL_NOT_VERIFIED' }.
 */
import {
  isEmailNotVerifiedRefusal,
  needsEmailVerification,
  readEmailNotVerifiedRefusal,
  recordVerificationResend,
  sendResultMessage,
  showVerificationPromptOnce,
  verificationRefusalLine,
} from '@hookpost/frontend/components/layout/email.verification';
import { postSaveError } from '@hookpost/frontend/components/new-launch/post.save.error';

/**
 * jsdom has no Response. Like the real one, each body (the original and every
 * clone) can be read once, so reading a clone leaves the original whole.
 */
const response = (status: number, body: unknown, raw?: string): Response => {
  let read = false;
  return {
    status,
    ok: status < 400,
    clone: () => response(status, body, raw),
    json: async () => {
      if (read) throw new TypeError('Body has already been consumed.');
      read = true;
      if (raw !== undefined) return JSON.parse(raw);
      return body;
    },
  } as unknown as Response;
};
const REFUSAL = {
  code: 'EMAIL_NOT_VERIFIED',
  statusCode: 403,
  message: 'Confirm your email address to publish. Open the link we emailed you.',
};

describe('needsEmailVerification (the hard gate)', () => {
  it('only when /user/self says the account must confirm first', () => {
    expect(needsEmailVerification({ emailVerificationRequired: true })).toBe(true);
    expect(needsEmailVerification({ emailVerificationRequired: false })).toBe(false);
    // An older backend's /user/self, or none yet: no gate.
    expect(needsEmailVerification({})).toBe(false);
    expect(needsEmailVerification(undefined)).toBe(false);
    expect(needsEmailVerification(null)).toBe(false);
  });

  it('never from activated alone: a Google sign-in is never gated by the page', () => {
    expect(needsEmailVerification({ activated: false } as any)).toBe(false);
  });
});

describe('the backend refusal', () => {
  it('is a 403 with its code, nothing else', () => {
    expect(isEmailNotVerifiedRefusal(403, REFUSAL)).toBe(true);
    expect(isEmailNotVerifiedRefusal(403, { message: 'Forbidden' })).toBe(false);
    expect(isEmailNotVerifiedRefusal(402, REFUSAL)).toBe(false);
    expect(isEmailNotVerifiedRefusal(403, null)).toBe(false);
    expect(isEmailNotVerifiedRefusal(403, 'EMAIL_NOT_VERIFIED')).toBe(false);
  });

  it('is read from a copy, so the caller still gets the body', async () => {
    const res = response(403, REFUSAL);
    expect(await readEmailNotVerifiedRefusal(res)).toEqual({ message: REFUSAL.message });
    expect(await res.json()).toEqual(REFUSAL);
  });

  it('anything else reads as no refusal', async () => {
    expect(await readEmailNotVerifiedRefusal(response(403, { message: 'Forbidden' }))).toBeNull();
    expect(await readEmailNotVerifiedRefusal(response(200, REFUSAL))).toBeNull();
    expect(await readEmailNotVerifiedRefusal(response(403, null, 'not json'))).toBeNull();
    expect(await readEmailNotVerifiedRefusal(undefined)).toBeNull();
  });
});

describe('sendResultMessage (the banner, after Resend or Wrong address?)', () => {
  it('names the address it went to', () => {
    expect(sendResultMessage({ sent: true, email: 'jo@gmail.com' })).toEqual({
      ok: true,
      text: 'Sent to jo@gmail.com. Check your inbox, and the spam folder too.',
    });
  });

  it('already confirmed', () => {
    expect(sendResultMessage({ sent: false, reason: 'already_verified' }).text).toBe(
      'Your email is already confirmed.'
    );
  });

  it.each([
    [45, '45 seconds'],
    [1, '1 second'],
    [90, '2 minutes'],
    [60, '1 minute'],
    [7200, '2 hours'],
  ])('throttled for %s s: "%s"', (seconds, wait) => {
    expect(sendResultMessage({ sent: false, reason: 'throttled', retryAfterSeconds: seconds })).toEqual({
      ok: false,
      text: `We just sent one. You can send another in ${wait}.`,
    });
  });

  it('anything unexpected is a plain failure', () => {
    expect(sendResultMessage(null).ok).toBe(false);
    expect(sendResultMessage({} as any).text).toBe('Could not send the email. Please try again.');
  });
});

describe('the composer line for a refused post', () => {
  it('says what to do', async () => {
    await expect(postSaveError(response(403, REFUSAL), 'fallback')).resolves.toBe(
      'Not published: confirm your email first. Use "Resend link" at the top of the page if the email has not arrived.'
    );
  });

  it('carries what the dialog just did, which its toast would otherwise hide', () => {
    recordVerificationResend('Sent to jo@gmail.com. Check your inbox, and the spam folder too.', 1_000);
    expect(verificationRefusalLine(5_000)).toBe(
      'Not published: confirm your email first. Sent to jo@gmail.com. Check your inbox, and the spam folder too.'
    );
    // Not for a later refusal.
    expect(verificationRefusalLine(60_000)).toMatch(/Use "Resend link"/);
  });

  it('a plain 403 is still shown as the backend said it', async () => {
    await expect(postSaveError(response(403, { message: 'Forbidden' }), 'fallback')).resolves.toBe('Forbidden');
  });
});

describe('showVerificationPromptOnce', () => {
  it('one dialog for refusals that arrive together', async () => {
    let close!: (v: boolean) => void;
    const prompt = jest.fn(() => new Promise<boolean>((r) => (close = r)));
    const first = showVerificationPromptOnce(prompt);
    await expect(showVerificationPromptOnce(prompt)).resolves.toBe(false);
    close(true);
    await expect(first).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    // And again once it is closed.
    const again = showVerificationPromptOnce(async () => false);
    await expect(again).resolves.toBe(false);
  });
});
