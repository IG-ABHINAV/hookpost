/**
 * The networks Hookpost actually published to, as pages may name them: those
 * with a post PUBLISHED from production in the 30 days to PUBLISHED_CHECKED
 * (prod DB, read-only: Post.state = PUBLISHED, grouped by
 * Integration.providerIdentifier). PUBLISHABLE_CHANNEL_COUNT (channel-count.ts)
 * is what can be connected; it is not this.
 *
 * Re-checked on 22 Oct 2026 for the ad landing pages (/claude, /cli, /start):
 * the ten below each published in that window (TikTok's posts were private
 * then; Hookpost passed TikTok's Direct Post audit on 10 Nov 2026 and now
 * publishes publicly). Re-run the query before adding a network or bumping the
 * date. /mcp, llms.txt and the launch posts name the same ten.
 */
export const PUBLISHED_CHECKED = '22 October 2026';

export const PUBLISHED_NETWORKS = [
  'Instagram',
  'Facebook Pages',
  'Threads',
  'X',
  'LinkedIn',
  'YouTube',
  'Pinterest',
  'Discord',
  'Slack',
  'TikTok',
] as const;

/** "Instagram, Facebook Pages, ... and Slack". */
export const publishedList = `${PUBLISHED_NETWORKS.slice(0, -1).join(', ')} and ${
  PUBLISHED_NETWORKS[PUBLISHED_NETWORKS.length - 1]
}`;
