import { createHash, timingSafeEqual } from 'crypto';

/**
 * A short fingerprint of a team invite token, which the Join question
 * (GET /user/invite) hands the page and the Join button sends back
 * (POST /user/invite/accept). Not a secret (whoever made the token can work
 * it out): it ties the click to the invite the page showed, so a second
 * invite link opened in another tab or a popup in between cannot be joined
 * by a click on the first page.
 */
export const inviteRef = (token: string) =>
  createHash('sha256').update(token).digest('base64url').slice(0, 22);

/** Whether `ref` is the fingerprint of `token`. */
export const inviteRefMatches = (token: string, ref: unknown) => {
  if (typeof ref !== 'string') return false;
  const want = Buffer.from(inviteRef(token));
  const got = Buffer.from(ref);
  return got.length === want.length && timingSafeEqual(got, want);
};
