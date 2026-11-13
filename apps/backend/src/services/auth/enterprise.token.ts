import { sign, verify } from 'jsonwebtoken';

/**
 * Tokens between Hookpost and a partner SaaS (/enterprise/*). They use their
 * own ENTERPRISE_JWT_SECRET (32+ characters, not JWT_SECRET): until 22 Oct
 * 2026 they used JWT_SECRET, which also signs every login session, so any
 * signed-in user could POST their own session to /enterprise/create-user and
 * get the API key of a new lifetime ULTIMATE workspace. Hookpost has no
 * partner, so the secret is unset and every enterprise token is refused.
 */
function enterpriseSecret(): string | null {
  const secret = process.env.ENTERPRISE_JWT_SECRET || '';
  if (secret.length < 32 || secret === process.env.JWT_SECRET) {
    return null;
  }
  return secret;
}

/**
 * The payload of a token the partner signed, or null. A token Hookpost signed
 * for the partner (signEnterpriseWebhook) carries a purpose and is refused, so
 * it cannot be sent back in as a request.
 */
export function enterprisePayload<T>(token: unknown): T | null {
  const secret = enterpriseSecret();
  if (!secret || typeof token !== 'string' || !token) {
    return null;
  }
  try {
    const payload = verify(token, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object' || 'purpose' in payload) {
      return null;
    }
    return payload as T;
  } catch {
    return null;
  }
}

/**
 * What Hookpost posts to the partner's webhook after a channel connects, or
 * null without a partner secret (then /enterprise/url never set a webhook).
 */
export function signEnterpriseWebhook(value: { apiKey: string }): string | null {
  const secret = enterpriseSecret();
  if (!secret) {
    return null;
  }
  return sign({ ...value, purpose: 'enterprise-webhook' }, secret);
}
