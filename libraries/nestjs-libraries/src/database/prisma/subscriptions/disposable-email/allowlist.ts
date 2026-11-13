/**
 * Domains the vendored disposable-email list (domains.generated.ts) names
 * but that real customers use: they are never treated as disposable. Add a
 * domain here, with the date and why, when a real sign-up is caught by the
 * list (a false positive). A subdomain of an allowed domain is allowed too.
 */
export const DISPOSABLE_ALLOWLIST: ReadonlyArray<string> = [
  // (none yet - 1 Nov 2026)
];
