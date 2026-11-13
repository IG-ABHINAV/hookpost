# Contributing to Hookpost

Thanks for helping. Code, docs, tests and bug reports are all welcome.

## Before you start

- Look for issues labelled `good first issue` or `help wanted`. Comment on the issue to say you're taking it, and we'll assign it to you. If there's no pull request within 7 days, it goes back to the pool so someone else can pick it up.
- For anything bigger than a bug fix (a new social network, a new API endpoint, a schema change), open an issue first so we can agree on the approach before you write the code.
- Security problems go through [SECURITY.md](./SECURITY.md), not public issues.

## Setting up

You need Node.js 22 (22.12 or later), pnpm 10 and Docker.

```bash
git clone https://github.com/<your-fork>/hookpost.git
cd hookpost
cp .env.example .env
docker compose -f docker-compose.dev.yaml up -d
pnpm install
pnpm run dev
```

## Making a change

1. Create a branch from `main`: `git checkout -b fix/short-description`.
2. Keep the change focused on one thing. Unrelated clean-ups go in a separate pull request.
3. Add or update tests. Unit tests sit next to the code as `*.spec.ts`; integration tests are in `tests/integration`. Run `pnpm test` for the packages you touched.
4. Run `pnpm exec eslint` on the files you changed and fix what it reports.
5. Commit with a clear message in the imperative ("Add Tumblr provider tests", not "added tests").

## Pull requests

- Link the issue (`Closes #123`) and say how you tested the change. Screenshots help for UI changes.
- CI must pass. Pull requests from forks need a maintainer to approve the CI run the first time.
- A maintainer will review within a week. Please answer review comments in the pull request rather than opening a new one.

## Adding a social network

Providers live in `libraries/nestjs-libraries/src/integrations/social/`. Copy the structure of an existing provider with a spec file (for example `bluesky.provider.ts` and `bluesky.provider.spec.ts`), register it in the integration manager, and add its environment variables to `.env.example` with a comment explaining where to get them.

## Licence of contributions

Hookpost is licensed under the AGPL-3.0. By opening a pull request you agree that your contribution is licensed under the same terms.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
