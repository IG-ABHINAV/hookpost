/**
 * Credit counting for marketplace posts, and the X rules a thread is checked
 * against before anything is saved. Pure (twitter-text only).
 *
 * X bills Hookpost $0.20 for a post with a link and $0.015 without, so link
 * detection is deliberately generous: twitter-text's own extractor (what X
 * uses to linkify a post, bare domains included) plus a plain pattern for
 * anything that looks like a URL or a domain it may have missed, such as one
 * glued to an emoji. A false positive costs the buyer 18 credits or a 400 they
 * can read; a miss costs us 13x the post.
 */
// @ts-ignore - twitter-text ships no types
import twitter from 'twitter-text';
import {
  CREDIT_COST,
  MarketplacePlan,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

export type LinkPolicy = 'reject' | 'allow';

/** X's limits: 280 weighted characters, 4,000 on a Premium (verified) account. */
export const X_LIMIT = 280;
export const X_PREMIUM_LIMIT = 4000;
/** X takes up to 4 pictures, or one video on its own, per post. */
export const X_MAX_IMAGES = 4;

const SCHEME_URL = /(?:https?:\/\/|www\.)[^\s]+/i;
// A bare domain on a common TLD ("hookpost.in", "t.co/abc"), not "Node.js".
const BARE_DOMAIN =
  /(?:^|[^a-z0-9@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|in|ai|dev|app|ly|me|xyz|info|biz|us|uk|gg|tv|to|so|sh|link|site|online|store|tech|news|blog|page|cc|fm|im|be|de|fr|es|it|nl|ca|au|jp|ru|br)(?:\/[^\s]*)?(?=$|[^a-z0-9-])/i;

/** True when X would see a link in this text (or might). */
export function hasLink(text: string): boolean {
  const value = String(text || '');
  if (!value) return false;
  try {
    if ((twitter.extractUrls(value) as string[]).length > 0) return true;
  } catch {
    /* fall through to the patterns */
  }
  return SCHEME_URL.test(value) || BARE_DOMAIN.test(value);
}

/** X's weighted length (twitter-text v3: most CJK and emoji count 2). */
export function xWeightedLength(text: string): number {
  return twitter.parseTweet(String(text || '')).weightedLength;
}

export interface TweetInput {
  text: string;
  /** Media on this tweet: images and videos, as the caller declared or resolved them. */
  media?: { type: 'image' | 'video' }[];
}

export interface TweetCheck {
  index: number;
  chars: number;
  limit: number;
  has_link: boolean;
  /** Links are removed before publishing (STRIP_LINKS_FROM_X_POSTS). */
  link_stripped: boolean;
  credits: number;
  errors: string[];
}

export interface ThreadCheck {
  valid: boolean;
  credits: number;
  tweets: TweetCheck[];
  errors: string[];
}

export interface ThreadOptions {
  /** The account is X Premium: 4,000 characters. */
  premium?: boolean;
  linkPolicy?: LinkPolicy;
  /** Tweets per thread at most (the plan's threadCap). */
  threadCap: number;
  /** The plan allows tweets with links at all. */
  allowLinks: boolean;
  /** STRIP_LINKS_FROM_X_POSTS is set: links never reach X. */
  stripLinks?: boolean;
}

/**
 * Every X rule a thread breaks, and what it costs. Each reply is a post of
 * its own on X (and billed by X as one), so each tweet is counted.
 */
export function checkThread(tweets: TweetInput[], options: ThreadOptions): ThreadCheck {
  const policy: LinkPolicy = options.linkPolicy === 'allow' ? 'allow' : 'reject';
  const limit = options.premium ? X_PREMIUM_LIMIT : X_LIMIT;
  const errors: string[] = [];
  if (!tweets.length) errors.push('A thread needs at least one tweet.');
  if (tweets.length > options.threadCap) {
    errors.push(
      `This plan takes up to ${options.threadCap} tweets in one thread; this one has ${tweets.length}.`
    );
  }
  const checks = tweets.map((tweet, index) => {
    const text = String(tweet?.text ?? '');
    const media = tweet?.media || [];
    const chars = xWeightedLength(text);
    const link = hasLink(text);
    const own: string[] = [];
    if (!text.trim() && !media.length) {
      own.push('A tweet needs text or media.');
    }
    if (chars > limit) {
      own.push(`${chars} characters; X allows ${limit}.`);
    }
    const videos = media.filter((m) => m.type === 'video').length;
    if (videos > 1 || (videos === 1 && media.length > 1)) {
      own.push('X allows one video per post, without pictures.');
    } else if (media.length > X_MAX_IMAGES) {
      own.push(`X allows up to ${X_MAX_IMAGES} pictures per post.`);
    }
    let credits: number = CREDIT_COST.xTweet;
    if (link) {
      if (policy === 'reject') {
        own.push(
          `This tweet has a link. Links cost ${CREDIT_COST.xTweetWithLink} credits a tweet on X: send link_policy "allow" to post it, or remove the link.`
        );
      } else if (!options.allowLinks) {
        own.push('Your plan does not include tweets with links. Remove the link.');
      } else if (!options.stripLinks) {
        credits = CREDIT_COST.xTweetWithLink;
      }
    }
    return {
      index,
      chars,
      limit,
      has_link: link,
      link_stripped: link && !!options.stripLinks && policy === 'allow' && options.allowLinks,
      credits,
      errors: own,
    } satisfies TweetCheck;
  });
  const valid = !errors.length && checks.every((c) => !c.errors.length);
  return {
    valid,
    credits: checks.reduce((sum, c) => sum + c.credits, 0),
    tweets: checks,
    errors,
  };
}

/** Credits for one post on one channel that is not X (thread replies included). */
export function nonXPostCredits(): number {
  return CREDIT_COST.channelPost;
}

/** X's cost to Hookpost of a checked thread, in micro-dollars (for the trial budget). */
export function threadCostMicroUsd(check: ThreadCheck): number {
  return check.tweets.reduce(
    (sum, t) => sum + (t.credits === CREDIT_COST.xTweetWithLink ? 200_000 : 15_000),
    0
  );
}

/** The plan's thread options for checkThread. */
export function threadOptionsFor(
  p: MarketplacePlan,
  extra: { premium?: boolean; linkPolicy?: LinkPolicy; stripLinks?: boolean } = {}
): ThreadOptions {
  return {
    premium: !!extra.premium,
    linkPolicy: extra.linkPolicy,
    threadCap: p.threadCap,
    allowLinks: p.allowXLinks,
    stripLinks: !!extra.stripLinks,
  };
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * A buyer's plain text as the post editor writes it: one <p> per line,
 * escaped, so "<b>" or "a < b" is posted as typed and never read as markup.
 */
export function plainTextToPostHtml(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}
