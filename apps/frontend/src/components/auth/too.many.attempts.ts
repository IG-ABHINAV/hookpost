/**
 * The sentence to show when the backend refused a sign-in, sign-up, password
 * reset or confirmation resend for too many attempts (429,
 * apps/backend/src/services/auth/auth.rate.limit.ts), or null for any other
 * answer. Sign-in and sign-up answer with plain text, the other routes with
 * Nest's JSON ({ message }); both are read.
 */
export const TOO_MANY_FALLBACK =
  'Too many attempts. Please wait a few minutes and try again.';

export async function tooManyAttemptsMessage(
  response: Pick<Response, 'status' | 'text'>
): Promise<string | null> {
  if (response.status !== 429) return null;
  const body = await response.text().catch(() => '');
  let message: unknown = body;
  try {
    const json = JSON.parse(body);
    message = Array.isArray(json?.message) ? json.message[0] : json?.message;
  } catch {
    /* plain text */
  }
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : TOO_MANY_FALLBACK;
}
