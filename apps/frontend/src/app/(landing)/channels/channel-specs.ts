// Medium: its help centre ("API/Importing", re-read 11 Oct 2026) says it "will
// not be issuing any new integration tokens" and "will not allow any new
// integrations"; existing tokens keep working. On top of that, the app's
// add-channel screen does not list Medium for anyone (RETIRED_PROVIDERS in
// libraries/nestjs-libraries/src/integrations/integration.manager.ts), so no
// one can connect Medium, old token or not. Not a platform approval we are
// waiting on - it may never lift.
const MEDIUM_PENDING =
  'Medium stopped issuing new API integration tokens, so Hookpost does not connect Medium accounts. WordPress, Hashnode and Dev.to publish articles today.';

// Meta App Review for Instagram and Threads permissions (instagram_content_publish,
// threads_content_publish, etc.) was reported approved on 9 October 2026, but on
// 11 Oct every Instagram/Threads publish in prod still came from the founder
// org (a Meta app admin) and one Instagram publish failed with "missing some
// permissions". Until a normal account has published, pages describe these
// channels without headlining auto-publishing.
//
// TikTok: Hookpost passed TikTok's Direct Post audit on 10 Nov 2026, so posts
// publish with whatever audience the creator's account allows. Inbox drafts
// stay as an optional mode, which is what the TikTok rules below say.
export const META_PENDING = '';

// Only channels a signed-up user can actually connect appear here.
//
// If a provider's limits change, update them here too.
export interface ChannelSpec {
  limit: string;
  auth: string;
  rules: string[];
  /**
   * Set when the channel can be CONNECTED but cannot yet PUBLISH - a platform
   * approval is outstanding. Rendered prominently on the channel page so the
   * page never promises something the product will fail at. Remove it the day
   * approval lands, not before.
   */
  pending?: string;
}

/**
 * Channel pages search engines may NOT index. The same one-switch pattern as
 * INDEXED_COMPARE_PAIRS in compare/competitor-facts.ts: the channel page's
 * robots tag and sitemap.xml both read isIndexedChannel(). A page listed here
 * is served `noindex, follow`, stays linked from /channels, and is left out of
 * the sitemap and the llms files.
 *
 * medium: no customer can connect it (see MEDIUM_PENDING above).
 */
export const NOINDEX_CHANNELS: string[] = ['medium'];

export const isIndexedChannel = (slug: string): boolean => !NOINDEX_CHANNELS.includes(slug);

export const CHANNEL_SPECS: Record<string, ChannelSpec> = {
  'instagram': { limit: '2,200 characters', auth: 'Connect once with OAuth', rules: ["At least one image or video per post", "Carousels up to 10 items", "Reels: one video, no mixing with images", "Business or Creator account required"] },
  'threads': { limit: '500 characters', auth: 'Connect once with OAuth', rules: ["Text, image or video"] },
  // 2,000, not TikTok's own 2,200: tiktok.provider.ts maxLength() returns 2000.
  'tiktok': { limit: '2,000 characters', auth: 'Connect once with OAuth', rules: ["At least one video or photo attachment required", "Posts publish to your TikTok account with the audience it allows (Everyone, Friends, Followers or Only me), or go to your TikTok inbox as drafts if you choose that", "Photo carousels and videos"] },
  'pinterest': { limit: '500 characters', auth: 'Connect once with OAuth', rules: ["At least one image or video per Pin", "Up to 5 media items", "Video Pins need a cover image as the second item"] },
  'youtube': { limit: '5,000 characters', auth: 'Connect once with OAuth', rules: ["One video per upload", "Title and visibility set per post", "Video only — images are not accepted"] },
  'linkedin': { limit: '3,000 characters', auth: 'Connect once with OAuth', rules: ["Carousels need 2+ images and no video", "One media item when posting video", "Comments are text only"] },
  'facebook': { limit: '63,206 characters', auth: 'Connect once with OAuth', rules: ["Stories require at least one media item", "Posts to a Page, not a personal profile"] },
  'x': { limit: '280 characters (4,000 on a Premium account)', auth: 'Connect once with OAuth', rules: ["Threads supported", "Articles accept images only"] },
  'bluesky': { limit: '300 characters', auth: 'Connect with your own credentials', rules: ["Up to 4 images per post", "One video per post", "Connects with an App Password, not your account password"] },
  'discord': { limit: '1,980 characters', auth: 'Connect once with OAuth', rules: ["Posts to a channel in your server", "Bot must be invited to the server"] },
  'slack': { limit: 'No practical limit', auth: 'Connect once with OAuth', rules: ["Posts to a channel your app is added to"] },
  'telegram': { limit: '4,096 characters per message (1,024 with media)', auth: 'Connect by adding the bot to your channel or group', rules: ["Posts to a channel or group", "Captions stop at 1,024 characters once media is attached"] },
  'lemmy': { limit: '10,000 characters', auth: 'Connect with your own credentials', rules: ["Posts to a community on your instance"] },
  'nostr': { limit: 'No practical limit', auth: 'Connect with your own credentials', rules: ["Connects with your private key, nsec1… or hex"] },
  'listmonk': { limit: 'No practical limit', auth: 'Connect with your own credentials', rules: ["Sends to a mailing list, not a social feed"] },
  'wordpress': { limit: 'No practical limit', auth: 'Connect with your own credentials', rules: ["Publishes a full post, not a status update", "Connects with an application password"] },
  'medium': { pending: MEDIUM_PENDING, limit: 'No practical limit', auth: 'Connect with your own credentials', rules: ["Publishes a full article", "Connects with an integration token"] },
  'hashnode': { limit: '10,000 characters', auth: 'Connect with your own credentials', rules: ["Publishes a full article to your blog"] },
  'devto': { limit: 'No practical limit', auth: 'Connect with your own credentials', rules: ["Publishes a full article", "Connects with an API key"] },
};
