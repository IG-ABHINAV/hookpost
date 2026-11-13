# Hookpost: Google Summer of Code project ideas

Hookstep plans to apply as a mentoring organisation for Google Summer of Code 2027. These are the project ideas for Hookpost. Sizes follow GSoC's scale: 175 hours (medium) and 350 hours (large).

If one of them interests you, open an issue or comment on an existing one to start the conversation, and pick up a [`good first issue`](https://github.com/hookstep/hookpost/issues?q=is%3Aopen+label%3A%22good+first+issue%22) first so we can work together on something small. You can also write to support@hookstep.in.

## Ideas

1. **Provider test harness with recorded fixtures (175 h, medium).** 20 of 35 social providers have no tests. Build a shared harness that replays recorded HTTP fixtures for each provider's connect, refresh-token and post flows, then cover at least eight providers with it. Skills: TypeScript, NestJS, Jest. Outcome: every provider change gets a CI signal without real API keys.
2. **One-command self-hosting (175 h, medium).** Today self-hosting needs Postgres, Redis, Temporal and four Node apps started by hand. Build a single `docker compose up` profile with health checks, a first-run setup page that checks which provider keys are set, and an upgrade path that runs migrations. Skills: Docker, Node, Prisma.
3. **Post analytics across networks (350 h, hard).** Pull post-level metrics (views, likes, replies) from the providers that expose them, store them in a normalised table through the Temporal orchestrator, and show a per-post and per-channel dashboard in the frontend. Skills: TypeScript, Temporal, React, data modelling.
4. **MCP server: full API coverage and a test suite (175 h, medium).** `mcp-server/` wraps part of the public API (channels, media, create/list/delete posts). Extend it to comments, analytics and scheduling rules, add contract tests against the public API's OpenAPI description, and publish usage docs. Skills: TypeScript, MCP, OpenAPI.

## Proposing your own idea

Ideas not on this list are welcome. Open an issue describing the problem, who it helps, and a rough plan, and we'll help you shape it into a proposal.
