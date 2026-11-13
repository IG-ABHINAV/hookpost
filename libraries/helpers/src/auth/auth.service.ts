import { sign, SignOptions, verify } from 'jsonwebtoken';
import { hashSync, compareSync } from 'bcrypt';
import crypto from 'crypto';
import {
  SESSION_REFRESH_AFTER_SECONDS,
  SESSION_TTL_SECONDS,
} from '@hookpost/helpers/auth/session.lifetime';
// @ts-ignore
import EVP_BytesToKey from 'evp_bytestokey';
const algorithm = 'aes-256-cbc';
const { keyLength, ivLength } = crypto.getCipherInfo(algorithm);

function deriveLegacyKeyIv(secret: string) {
  const { keyLength, ivLength } = crypto.getCipherInfo(algorithm); // 32, 16
  const pass = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? '', 'utf8');

  // evp_bytestokey: key length in **bits**, IV length in **bytes**
  const { key, iv } = EVP_BytesToKey(pass, null, keyLength * 8, ivLength, 'md5');

  if (key.length !== keyLength || iv.length !== ivLength) {
    throw new Error(`Derived wrong sizes (key=${key.length}, iv=${iv.length})`);
  }
  return { key, iv };
}

export function decrypt_legacy_using_IV(hexCiphertext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  const out = Buffer.concat([decipher.update(hexCiphertext, 'hex'), decipher.final()]);
  return out.toString('utf8');
}

export function encrypt_legacy_using_IV(utf8Plaintext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const out = Buffer.concat([cipher.update(utf8Plaintext, 'utf8'), cipher.final()]);
  return out.toString('hex');
}
function purposeKey(purpose: string) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`hookpost-token-purpose:${purpose}`)
    .digest('hex');
}

/**
 * Every kind of token Hookpost signs, other than a login session. Each one is
 * signed with its own key (signPurposeJWT), so a token made for one job never
 * verifies for another, and never as a session. Until 22 Oct 2026 they were
 * all plain JWT_SECRET tokens that no verifier told apart.
 */
export const TOKEN_PURPOSE = {
  /** The link in a password-reset email (20 minutes). */
  PASSWORD_RESET: 'password-reset',
  /** The link in the "activate your account" email. */
  ACCOUNT_ACTIVATION: 'account-activation',
  /** A team invite link, /?org=... (2 days). */
  TEAM_INVITE: 'team-invite',
  /** POST /public/modify-subscription. Nothing in Hookpost signs one. */
  PLAN_CHANGE: 'plan-change',
  /** The coupon flag GET /billing/check-discount hands the billing page. */
  DISCOUNT_OFFER: 'discount-offer',
  /** What the Chrome extension sends to /integrations/extension-refresh. */
  EXTENSION_REFRESH: 'extension-refresh',
} as const;
export type TokenPurpose = (typeof TOKEN_PURPOSE)[keyof typeof TOKEN_PURPOSE];

/**
 * Claims only tokens of another kind carry: `purpose` (every one since 22 Oct
 * 2026), `expires` (reset links before then), `timeLimit` and `orgId` (invite
 * links before then). A session is the user row, which has none of them.
 */
const NOT_A_SESSION = ['purpose', 'expires', 'timeLimit', 'orgId'];

/** True for the payload of a login session: an id, and no other kind's claims. */
export function isSessionPayload(
  payload: unknown
): payload is { id: string } & Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const id = (payload as { id?: unknown }).id;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    !NOT_A_SESSION.some((claim) => claim in payload)
  );
}

/**
 * The session claim that ties a session to the password it was issued under:
 * a keyed hash of the stored password hash (never the hash itself). Setting a
 * password stores a new bcrypt hash (a new salt even for the same password),
 * so every session issued before a reset or change stops matching and is
 * refused (AuthMiddleware). An account with no password (Google, GitHub)
 * always has the same stamp. Needs no column: it is computed from the row.
 */
export const PASSWORD_STAMP_CLAIM = 'passwordStamp';

export function passwordStamp(storedHash: string | null | undefined) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }
  const key = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update('hookpost-session-password-stamp')
    .digest();
  return crypto
    .createHmac('sha256', key)
    .update(storedHash || '')
    .digest('base64url')
    .slice(0, 22);
}

/** What a session is signed from: the user row as stored, password hash included. */
export type SessionSource = {
  id: string;
  password?: string | null;
  [claim: string]: unknown;
};

/** A verified session: the user row it was signed from, plus iat, exp and the stamp. */
export type SessionPayload = { id: string; iat: number; exp: number } & Record<
  string,
  unknown
>;

export class AuthService {
  static hashPassword(password: string) {
    return hashSync(password, 10);
  }
  static comparePassword(password: string, hash: string) {
    return compareSync(password, hash);
  }

  /**
   * A login session for `user`: the user row as stored, signed with
   * JWT_SECRET, without the password hash, with iat, exp (SESSION_TTL_SECONDS
   * later) and the password stamp. Nothing else is signed this way.
   *
   * The row must carry its password field (null for a provider account), or
   * the stamp would not match the stored one and the session would be refused
   * at once. `issuedAt` (seconds) is for tests that need an older session.
   */
  static signSessionJWT(
    user: SessionSource,
    options: { issuedAt?: number } = {}
  ) {
    if (!user || typeof user.id !== 'string' || !user.id) {
      throw new Error('A session needs a user id');
    }
    if (!('password' in user)) {
      throw new Error('A session is signed from the stored user row');
    }
    const {
      password,
      iat: _iat,
      exp: _exp,
      nbf: _nbf,
      [PASSWORD_STAMP_CLAIM]: _stamp,
      ...claims
    } = user;
    return sign(
      {
        ...claims,
        iat: options.issuedAt ?? Math.floor(Date.now() / 1000),
        [PASSWORD_STAMP_CLAIM]: passwordStamp(password as string | null),
      },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS }
    );
  }

  /**
   * Checks the signature only, and says nothing about what kind of token it
   * is. Only for credentials Hookpost itself stored in the database in an
   * older format (Nostr, Skool). A token that arrives with a request goes
   * through verifySessionJWT or verifyPurposeJWT instead.
   */
  static verifyJWT(token: string) {
    return verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] });
  }

  /**
   * The payload of a live login session; throws for anything else: a session
   * past its exp, one without exp, one claiming a longer life than
   * SESSION_TTL_SECONDS, one with no password stamp, and a reset link, an
   * invite or any other purpose token, old or new.
   *
   * Whether the stamp still matches the user's password needs the user row;
   * AuthMiddleware checks it with sessionMatchesPassword.
   */
  static verifySessionJWT(token: unknown): SessionPayload {
    const payload = AuthService.verifyLegacySessionJWT(token);
    const { iat, exp } = payload as { iat?: unknown; exp?: unknown };
    if (typeof iat !== 'number' || typeof exp !== 'number') {
      throw new Error('Session has no expiry');
    }
    if (exp - iat > SESSION_TTL_SECONDS) {
      throw new Error('Session outlives the session lifetime');
    }
    if (typeof payload[PASSWORD_STAMP_CLAIM] !== 'string') {
      throw new Error('Session has no password stamp');
    }
    return payload as SessionPayload;
  }

  /**
   * Signature and session shape only: a token without exp passes. Never a
   * sign-in check. Only for old activation links, which are such a token
   * (auth.service.ts in the backend, activationUserId, which also limits it
   * to links issued before its cutoff). Everything else uses
   * verifySessionJWT.
   */
  static verifyLegacySessionJWT(token: unknown) {
    if (typeof token !== 'string' || !token) {
      throw new Error('No session token');
    }
    const payload = verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
    });
    if (!isSessionPayload(payload)) {
      throw new Error('Not a session token');
    }
    return payload;
  }

  /**
   * True when the session was issued under the password the user has now
   * (see passwordStamp). False after any password reset or change.
   */
  static sessionMatchesPassword(
    payload: Record<string, unknown>,
    storedHash: string | null | undefined
  ) {
    const claimed = payload?.[PASSWORD_STAMP_CLAIM];
    if (typeof claimed !== 'string') {
      return false;
    }
    const expected = Buffer.from(passwordStamp(storedHash));
    const actual = Buffer.from(claimed);
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  }

  /** True once a session is SESSION_REFRESH_AFTER_SECONDS old: re-issue it. */
  static sessionNeedsRefresh(
    payload: { iat?: unknown },
    nowSeconds = Math.floor(Date.now() / 1000)
  ) {
    return (
      typeof payload?.iat === 'number' &&
      nowSeconds - payload.iat >= SESSION_REFRESH_AFTER_SECONDS
    );
  }

  /**
   * A token for one job only (TOKEN_PURPOSE). It is signed with a key derived
   * from JWT_SECRET for that purpose, so it never verifies as a session or as
   * a token for any other purpose, and none of those verifies as it.
   */
  static signPurposeJWT(
    purpose: TokenPurpose,
    value: object,
    options: Pick<SignOptions, 'expiresIn'> = {}
  ) {
    return sign({ ...value, purpose }, purposeKey(purpose), options);
  }

  /** The payload of a token signPurposeJWT made for `purpose`; throws otherwise. */
  static verifyPurposeJWT(purpose: TokenPurpose, token: unknown) {
    if (typeof token !== 'string' || !token) {
      throw new Error(`No ${purpose} token`);
    }
    const payload = verify(token, purposeKey(purpose), {
      algorithms: ['HS256'],
    }) as { purpose?: string } & Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || payload.purpose !== purpose) {
      throw new Error(`Not a ${purpose} token`);
    }
    return payload;
  }

  static fixedEncryption(value: string) {
    return encrypt_legacy_using_IV(value);
  }

  static fixedDecryption(hash: string) {
    return decrypt_legacy_using_IV(hash);
  }
}
