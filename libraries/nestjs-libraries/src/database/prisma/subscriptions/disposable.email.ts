import { DISPOSABLE_DOMAINS_TEXT } from './disposable-email/domains.generated';
import { DISPOSABLE_ALLOWLIST } from './disposable-email/allowlist';

/**
 * Disposable email domains (owner, 29 Oct 2026, item 12): the vendored
 * open-source list (disposable-email/README.md), read once when this module
 * loads, i.e. at backend boot. Server-only: the list is ~150 KB, so nothing
 * the frontend imports may import this file (trial.policy.ts does not).
 */
const BLOCKED: ReadonlySet<string> = new Set(
  DISPOSABLE_DOMAINS_TEXT.split('\n').filter(Boolean)
);
const ALLOWED: ReadonlySet<string> = new Set(
  DISPOSABLE_ALLOWLIST.map((d) => d.trim().toLowerCase()).filter(Boolean)
);

/** The domain and each parent of it with at least two labels, nearest first. */
function domainAndParents(domain: string): string[] {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * The address is at a disposable email domain, or a subdomain of one, and
 * the domain is not on the allow-list (which wins, subdomains included).
 */
export function disposableEmail(email: string | null | undefined): boolean {
  const lower = (email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return false;
  const candidates = domainAndParents(lower.slice(at + 1).replace(/\.+$/, ''));
  if (candidates.some((d) => ALLOWED.has(d))) return false;
  return candidates.some((d) => BLOCKED.has(d));
}

/** How many domains the vendored list holds (for the health of the list). */
export const disposableDomainCount = (): number => BLOCKED.size;
