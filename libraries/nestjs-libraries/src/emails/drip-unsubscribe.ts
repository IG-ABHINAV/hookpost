/**
 * One-click unsubscribe for the marketing drip (scripts/lead-campaign).
 *
 * Shared by the backend endpoint (GET/POST /api/public/email/unsubscribe) and
 * the drip script, which loads it through the esbuild bundle of
 * lead-campaign.template.ts. Keep it import-free apart from node's crypto.
 *
 * The token is `<userId>.<hmac>`, signed with JWT_SECRET (both the backend and
 * the drip read the same ~/hookpost/.env), with a purpose prefix so it can
 * never be confused with any other signature made from that secret.
 *
 * The opt-out is stored as a UsedCodes row whose code is `unsub:drip:<userId>`,
 * on one of the user's organisations, so no schema change was needed. The
 * prefix is deliberately NOT `drip:`, because the drip counts `drip:` rows as
 * sent emails for its cooldown and cap. Transactional mail never reads it.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const PURPOSE = 'hookpost-drip-unsubscribe:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // Prisma uuids are lowercase

export const DRIP_UNSUBSCRIBE_PREFIX = 'unsub:drip:';

export function dripUnsubscribeCode(userId: string): string {
  return `${DRIP_UNSUBSCRIBE_PREFIX}${userId}`;
}

function mac(userId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(PURPOSE + userId)
    .digest('base64url');
}

function requireSecret(secret?: string): string {
  const s = secret ?? process.env.JWT_SECRET ?? '';
  if (!s) {
    throw new Error('JWT_SECRET is not set; cannot sign unsubscribe links');
  }
  return s;
}

export function dripUnsubscribeToken(userId: string, secret?: string): string {
  if (!UUID.test(userId)) {
    throw new Error('dripUnsubscribeToken: userId is not a uuid');
  }
  return `${userId}.${mac(userId, requireSecret(secret))}`;
}

/** Returns the user id when the token is genuine, otherwise null. */
export function readDripUnsubscribeToken(
  token: unknown,
  secret?: string
): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!UUID.test(userId) || !sig) return null;
  let s: string;
  try {
    s = requireSecret(secret);
  } catch {
    return null;
  }
  const want = Buffer.from(mac(userId, s));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got)
    ? userId
    : null;
}

export function dripUnsubscribeUrl(
  userId: string,
  appUrl = 'https://hookpost.hookstep.in',
  secret?: string
): string {
  return `${appUrl.replace(/\/+$/, '')}/api/public/email/unsubscribe?t=${encodeURIComponent(
    dripUnsubscribeToken(userId, secret)
  )}`;
}
