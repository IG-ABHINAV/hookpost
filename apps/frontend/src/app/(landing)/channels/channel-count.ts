import { CHANNEL_SPECS } from './channel-specs';

/**
 * The number of channels Hookpost can actually PUBLISH to - the ONE channel
 * count the site states, in page copy, metadata, JSON-LD and the app shell.
 *
 * Do NOT hardcode this anywhere. A typed number drifted four ways in a single
 * day - the live site said 30, one pending commit said 20, channel-specs held
 * 18, and the og-image said 30 hours after it stopped being true. Nobody
 * reading the repo could check it, because the real figure is the registered
 * providers minus HIDDEN_PROVIDERS, and that is a server environment variable.
 *
 * channel-specs.ts states its own invariant - "only channels a signed-up user
 * can actually connect appear here" - and a spec with `pending` set can be
 * connected but cannot publish for a new account (Medium today). Counting only
 * the publishable ones keeps the claim from outrunning the product. There used
 * to be a second export, CHANNEL_COUNT (every spec, pending included), for
 * "connect" copy; with both in use the same page said 18 and 19, and the
 * site carried five different counts at once. One number, derived here.
 *
 * Known gap, stated rather than hidden: moltbook is connectable but has no
 * spec entry, so this undercounts by one. Undercounting is the safe direction
 * for a marketing claim; add its spec entry to fix it properly.
 *
 * When a pending channel is approved, delete its `pending` string and the
 * count follows on its own. Static files that cannot import this
 * (src/llms/llms.txt, src/llms/llms-full.txt) state the number in words and must
 * be updated by hand when it changes.
 */
export const PUBLISHABLE_CHANNEL_COUNT = Object.values(CHANNEL_SPECS).filter(
  (spec) => !spec.pending
).length;
