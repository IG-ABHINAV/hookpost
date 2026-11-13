# Engineering Standards & Automation Principles

## 1. Test-Driven Development (TDD) & Mandatory Automated Tests
Every feature, bugfix, integration, or AI agent workflow MUST include automated regression test coverage:
1. **Unit Tests**: Pure logic, helper functions, and DTO validators.
2. **Integration Tests**: Database queries (Prisma), service boundaries, authentication guards, and role permissions.
3. **End-to-End (E2E) Smoke Tests**: API endpoints, authentication flows, and critical user journeys.
4. **Negative & Gate Scenarios**: Explicitly verify unauthorized states, expired sessions, and plan boundaries throw exact expected exceptions (e.g. 401, 402, 403) without consuming downstream third-party quotas.

## 2. Automated Vulnerability Scanning & Security Hardening
Before releasing any code or dependency updates:
1. **Dependency Audit**: Run `pnpm audit` / `npm audit` to detect known CVEs in upstream packages.
2. **OWASP Top 10 Compliance**:
   - **SQL Injection**: Strictly parameterized ORM queries via Prisma (zero raw string interpolation).
   - **IDOR (Broken Access Control)**: Every database read and write MUST enforce workspace/user tenancy (`where: { id, organizationId }`).
   - **SSRF (Server-Side Request Forgery)**: External URL fetchers and media uploaders must reject private and loopback IP ranges (RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`, `169.254.169.254`).
   - **XSS & Injection**: Sanitize HTML outputs and user-provided inputs in all preview renderers.

## 3. Secret Zero-Trust & Sensitive Data Isolation
1. **Never Commit Secrets**: All API keys, database credentials, and webhook secrets reside exclusively in `.env` or cloud secret managers.
2. **Zero Sensitive Logging**: Never output JWTs, passwords, session tokens, or payment card details in logs.
3. **Idempotent Billing & Handlers**: All payment webhooks and destructive operations require idempotency keys to prevent duplicate processing.
