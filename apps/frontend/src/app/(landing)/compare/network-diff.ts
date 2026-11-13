import { CHANNEL_SPECS } from '../channels/channel-specs';

// Compares a competitor's network list (as the vendor states it, in
// competitor-facts.ts) with the networks Hookpost can publish to
// (channel-specs.ts minus pending ones). Matching is by name, so a network
// Hookpost cannot publish to (Google Business Profile, WhatsApp, Mastodon,
// Reddit, Medium for new accounts...) always lands in `onlyCompetitor` and is
// never claimed for Hookpost.

/** Display names for Hookpost's channel slugs. */
export const NETWORK_NAMES: Record<string, string> = {
  instagram: 'Instagram',
  threads: 'Threads',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  facebook: 'Facebook Pages',
  x: 'X',
  bluesky: 'Bluesky',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  lemmy: 'Lemmy',
  nostr: 'Nostr',
  listmonk: 'Listmonk',
  wordpress: 'WordPress',
  medium: 'Medium',
  hashnode: 'Hashnode',
  devto: 'Dev.to',
};

const ALIASES: Record<string, string> = {
  instagram: 'instagram',
  threads: 'threads',
  'meta threads': 'threads',
  tiktok: 'tiktok',
  pinterest: 'pinterest',
  youtube: 'youtube',
  linkedin: 'linkedin',
  facebook: 'facebook',
  'facebook pages': 'facebook',
  x: 'x',
  twitter: 'x',
  'twitter/x': 'x',
  bluesky: 'bluesky',
  discord: 'discord',
  slack: 'slack',
  telegram: 'telegram',
  lemmy: 'lemmy',
  nostr: 'nostr',
  listmonk: 'listmonk',
  wordpress: 'wordpress',
  medium: 'medium',
  hashnode: 'hashnode',
  'dev.to': 'devto',
};

export const PUBLISHABLE_SLUGS = Object.keys(CHANNEL_SPECS).filter((k) => !CHANNEL_SPECS[k].pending);

/** The Hookpost slug a vendor's network name refers to, or null if Hookpost has no such channel. */
export const hookpostSlugFor = (name: string): string | null => {
  const key = name.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
  return ALIASES[key] ?? null;
};

export interface NetworkDiff {
  /** Networks both publish to, as Hookpost names them. */
  shared: string[];
  sharedSlugs: string[];
  /** Networks the competitor lists that Hookpost cannot publish to, as the vendor names them. */
  onlyCompetitor: string[];
  /** Networks Hookpost publishes to that the competitor does not list. */
  onlyHookpost: string[];
}

export const networkDiff = (networks: string[]): NetworkDiff => {
  const sharedSlugs: string[] = [];
  const onlyCompetitor: string[] = [];
  for (const n of networks) {
    const slug = hookpostSlugFor(n);
    if (slug && PUBLISHABLE_SLUGS.includes(slug)) {
      if (!sharedSlugs.includes(slug)) sharedSlugs.push(slug);
    } else {
      onlyCompetitor.push(n.replace(/\s*\(.*\)\s*$/, ''));
    }
  }
  return {
    shared: sharedSlugs.map((k) => NETWORK_NAMES[k] ?? k),
    sharedSlugs,
    onlyCompetitor,
    onlyHookpost: PUBLISHABLE_SLUGS.filter((k) => !sharedSlugs.includes(k)).map((k) => NETWORK_NAMES[k] ?? k),
  };
};

/** "a, b and c" */
export const listJoin = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
