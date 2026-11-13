## What does this change?

<!-- One or two sentences. Explain why, not only what. -->

## Issue

Closes #

<!-- One issue per PR, please. For anything bigger than a bug fix, agree the approach in the issue first. -->

## How I tested it

<!-- Commands you ran and what you saw. For UI changes, add a screenshot. -->

- [ ] `pnpm exec jest -c apps/backend/jest.config.ts <the specs I touched>` passes (backend and libraries)
- [ ] `pnpm exec jest -c apps/frontend/jest.config.ts <the specs I touched>` passes (if I touched the frontend)
- [ ] `pnpm exec eslint <the files I changed>` is clean
- [ ] I added or updated a test for the behaviour I changed

## Checklist

- [ ] The PR is small and does one thing
- [ ] No secrets, API keys, real emails or personal data anywhere in the diff
- [ ] If I used an AI tool, I have read and understood every line and can explain it in review
- [ ] I read [CONTRIBUTING.md](https://github.com/hookstep/hookpost/blob/main/CONTRIBUTING.md) and the [Code of Conduct](https://github.com/hookstep/hookpost/blob/main/CODE_OF_CONDUCT.md)
