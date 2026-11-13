# Disposable email domains

`domains.generated.ts` is the open-source list from
[disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
(`disposable_email_blocklist.conf`), released under CC0 1.0 (public domain,
`LICENSE.txt`). Thanks to its maintainers.

- Read once when the backend starts (`../disposable.email.ts`). Nothing is fetched at run time.
- Refreshed by `scripts/disposable-domains/update.mjs`. The weekly workflow `.github/workflows/disposable-domains.yml` runs it and opens a pull request.
- False positives go in `allowlist.ts`, which always wins.

A sign-up from a listed domain (or any subdomain of one) gets no free posts
(trial.policy.ts "free posts are given once", guard 3).
