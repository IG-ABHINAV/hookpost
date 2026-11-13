# Changelog

All notable changes to Hookpost are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed
- Sign-in sessions last 30 days from their last use (a session in use is renewed once a day, so an active user stays signed in). After upgrading, everyone signs in once more. Resetting or changing a password signs out every other browser and device. API keys, OAuth app tokens, the CLI and MCP are not sessions and are unaffected. No new setting: sessions are still signed with `JWT_SECRET`.
- Public API: `GET /find-slot/:id` now returns the slot as ISO 8601 UTC with a `Z` (`2026-10-22T11:40:00.000Z`); before, it was a UTC wall time with no zone (`2026-10-22T11:40:00`). A client that appended `Z` itself should stop doing so. The MCP server's `create_post` refuses a date with no zone.
- Public API and MCP: `POST /posts` with several channels now saves all of them or none. When one channel has nothing to save (empty content) the answer is still `[]`, but no channel is kept; before, the channels ahead of it stayed saved and went on to publish.
- Public API and MCP: scheduling or publishing a post whose uploaded video or image was already removed from storage (a failed post retried after the 7-day media purge) is refused with 400 and asks for the file to be uploaded again. Drafts, `update` saves and links to other sites are not checked. A published post saved as `schedule` without `republish` still gets the republish message first.

## [1.0.0] - 2026-09-26

First tagged release of Hookpost, a modern multi-channel social media scheduler.

### Publishing
- Schedule and publish to X (posts and threads), LinkedIn (personal profiles), YouTube (videos and Shorts), Bluesky, Discord, Slack, Telegram, WordPress, Hashnode, Dev.to, Lemmy, Nostr and Listmonk.
- Instagram, Facebook and Threads providers are included; on the hosted version Facebook Pages connect and publish for any account, while Instagram and Threads still wait on Meta app approval. Pinterest connects but cannot publish until Pinterest grants Standard API access. Medium works only for accounts that already hold an integration token (Medium no longer issues new ones).
- Per-network validation (character limits, media rules) before a post is queued; repeat posting on supported channels.

### AI and automation
- MCP server exposing channel listing, per-channel settings, media upload from URL, and post scheduling and listing, for Claude Desktop, Claude Code, Cursor and other MCP clients.
- REST public API with API-key and OAuth authorisation, webhooks, a CLI (`npx hookpost`) and an n8n community node (`n8n-nodes-hookpost`).
- AI writing and image generation in the composer.

### Hosting and billing
- A hosted service only, built on a Next.js frontend, NestJS backend, Temporal, PostgreSQL and Redis.
- Live at https://hookpost.hookstep.in with a free plan and flat monthly plans billed in rupees through Razorpay (UPI Autopay, cards, NetBanking).

[1.0.0]: https://github.com/hookstep/hookpost/releases/tag/hookpost-v1.0.0
