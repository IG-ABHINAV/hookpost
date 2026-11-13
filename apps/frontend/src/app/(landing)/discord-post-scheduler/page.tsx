import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';
import { planPrice } from '../usd-offer';

/**
 * The Discord integration page: "discord post scheduler", "schedule discord
 * integration", "discord schedule integration", "discord to schedule".
 *
 * Those four queries brought 211 Search Console impressions and almost no
 * clicks in the 28 days to 25 Oct 2026. They are product intent - someone
 * looking for a Discord scheduling integration, not a tutorial - and the only
 * pages answering them were /guides/schedule-discord-announcements (a how-to)
 * and /channels/discord (a spec sheet). This page is the integration page
 * between them: what the integration is, what the bot can and cannot do, and
 * what it is for. It links to both rather than repeating them.
 *
 * Every behaviour here is read from the code, so it changes when the provider
 * does:
 *   - discord.provider.ts: OAuth scopes (bot, identify, guilds) and the
 *     invite's permissions bitfield 377957124096, which is exactly
 *     SEND_MESSAGES, CREATE_PUBLIC_THREADS, CREATE_PRIVATE_THREADS and
 *     SEND_MESSAGES_IN_THREADS. Neither MENTION_EVERYONE nor ATTACH_FILES is in
 *     it, and the provider sends no allowed_mentions, so this page must not
 *     promise that @everyone pings or that attachments always land - it says
 *     what each depends on instead, exactly as
 *     /guides/schedule-discord-announcements already does. The 1,980-char
 *     maxLength(), Markdown editor, attachments as file uploads, the 20 MiB
 *     default per-file limit (DISCORD_MAX_FILE_BYTES, Discord raised it from
 *     10 MiB on 14 Aug 2026), oversize files posted as a link instead,
 *     thread replies for follow-ups, missing-access errors.
 *   - discord.dto.ts: the channel id is the only per-post setting, and it is
 *     required.
 *   - channels/channel-deep.ts: the same facts as the channel page renders.
 * Nothing here claims an analytics or engagement feature: the Discord provider
 * publishes, it does not read a server back.
 */
const CANONICAL = 'https://hookpost.hookstep.in/discord-post-scheduler';

const MAX_CHARS = '1,980';
const MAX_FILE = '20 MB';
const FREE = pricingINR.FREE;
const HOOKPOST = pricingINR.HOOKPOST;

// The answer-first paragraph, used in three places on purpose - the hero, the
// first FAQ answer, and the WebPage description in the JSON-LD - so the page,
// its structured data and any AI summary of it all say the same thing.
const WHAT_IT_IS =
  `A Discord post scheduler writes a message now and sends it to a channel in your Discord server later, at a time you choose. Discord cannot schedule a channel message by itself, so the message has to be sent by a bot. Hookpost's Discord integration is that bot: you connect your server once through Discord's own authorisation screen, then write the message, pick the channel and drop it on the Hookpost calendar. It goes out from Hookpost's servers at the time you set, alongside whatever you scheduled for X, LinkedIn or Instagram the same week.`;

// What the integration does, each line traceable to the provider.
const CAPABILITIES: readonly { title: string; body: string }[] = [
  {
    title: `Messages up to ${MAX_CHARS} characters`,
    body: 'Written in Markdown, sent to the text or announcement channel you pick on each post. The channel is required: a Discord post cannot be scheduled without one.',
  },
  {
    title: 'Mentions of members and roles',
    body: 'Members and roles can be mentioned in a scheduled message. @here and @everyone can be written too, but whether they ping depends on your server: the Hookpost bot is invited with permission to send messages and to open and post in threads, not to mention everyone, so for those two to notify anyone its role needs Mention @everyone on the channel.',
  },
  {
    title: 'Images, video and files as real attachments',
    body: `Media is uploaded to Discord as an attachment on the message, not posted as a link. Discord's default per-file limit is ${MAX_FILE} (it was 10 MB until Discord raised it on 14 August 2026); boosted servers allow more, and anything over the limit is posted as a link instead. The invite does not ask for Attach Files, so if your server has not granted that to the bot's role, grant it or attachments fail.`,
  },
  {
    title: 'Follow-ups in a thread',
    body: 'Extra entries on the same post open a thread on the first message and are posted inside it, so a long announcement does not fill the channel with separate messages.',
  },
  {
    title: 'Repeating announcements',
    body: 'A scheduled Discord post can repeat: every day, every 2 to 6 days, every week, every two weeks or every 30 days. Useful for a weekly standup ping or a recurring event reminder.',
  },
  {
    title: 'The same post on other networks',
    body: `Discord sits on the same calendar as the other ${PUBLISHABLE_CHANNEL_COUNT - 1} networks Hookpost publishes to, so a launch note can go to your server, X, LinkedIn and Bluesky from one draft, each within its own limits.`,
  },
];

const FAQ: readonly { q: string; a: string }[] = [
  { q: 'What is a Discord post scheduler?', a: WHAT_IT_IS },
  {
    q: 'How does the Discord integration connect?',
    a: "In Hookpost, choose Add Channel and then Discord. Discord opens its own authorisation screen, where you choose the server and approve the Hookpost bot. Hookpost asks for the bot, identify and guilds scopes - bot is the one that installs the application - and for permission to send messages and to open and post in threads. You need the right to add an application to that server, which usually means being its owner or having Manage Server.",
  },
  {
    q: 'Which Discord channels can it post to?',
    a: 'Text channels and announcement channels. You pick the channel on each post, from the list Hookpost reads back from your server, so different posts can go to different channels on the same server.',
  },
  {
    q: 'What happens if the bot loses access to the channel?',
    a: 'The post fails with the error Discord itself returns - a missing-access or missing-permission error - and the failure is shown against that post. The bot has to stay in the server and be allowed to see and post in the chosen channel, so a permissions change on a private channel is the usual cause. Other networks on the same post are unaffected.',
  },
  {
    q: 'Can I schedule a Discord message longer than 2,000 characters?',
    a: `No. Discord refuses message content over 2,000 characters, and Hookpost caps a Discord post at ${MAX_CHARS} to stay inside that. Hookpost checks the length while you write rather than failing at send time. For a longer announcement, use follow-up entries, which are posted as a thread on the first message.`,
  },
  {
    q: 'Does it read the server, or only post to it?',
    a: 'Only post. The Discord integration publishes messages; it does not pull messages, members or analytics back out of your server.',
  },
  {
    q: 'What does scheduling Discord messages cost?',
    a: offer(
      `Discord can be one of the ${FREE.channel} channels on the free plan, which allows ${FREE.posts_per_month} scheduled posts a month with no card. Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month} posts, and adds AI drafting, the REST API, the CLI and the MCP server.`,
      `${TRIAL_SENTENCE} Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month} posts a month, with AI drafting, the REST API, the CLI and the MCP server. Discord counts as one channel.`
    ),
  },
  {
    q: 'Can an AI agent schedule the Discord message?',
    a: "Yes. Hookpost's MCP server exposes the connected channels, including Discord, to an AI assistant, so Claude, Claude Code or Cursor can draft a release note and queue it to your server's announcements channel. The MCP server needs the Hookpost plan.",
  },
];

export const metadata: Metadata = withSocial({
  title: 'Discord Post Scheduler: Schedule Discord Messages | Hookpost',
  description: `Schedule Discord messages and announcements to a channel in your server, up to ${MAX_CHARS} characters with attachments, mentions and thread replies - on the same calendar as X, LinkedIn and Instagram.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Discord post scheduler - Hookpost',
    description: `Connect your server once, then schedule messages and announcements to any text or announcement channel, up to ${MAX_CHARS} characters with attachments.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Hookpost Discord post scheduler',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Discord post scheduler - Hookpost',
    description: `Schedule Discord messages and announcements, up to ${MAX_CHARS} characters with attachments and mentions.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function DiscordPostSchedulerPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to schedule a Discord message with Hookpost',
        step: [
          {
            '@type': 'HowToStep',
            position: 1,
            name: 'Connect the server',
            text: "Choose Add Channel, then Discord. On Discord's authorisation screen pick the server and approve the Hookpost bot.",
          },
          {
            '@type': 'HowToStep',
            position: 2,
            name: 'Write the message',
            text: `Create a post, select your Discord server, and write up to ${MAX_CHARS} characters in Markdown. Attach images or files if you need them.`,
          },
          {
            '@type': 'HowToStep',
            position: 3,
            name: 'Pick the channel',
            text: 'In the post’s Discord settings, choose the text or announcement channel it should go to. This is required.',
          },
          {
            '@type': 'HowToStep',
            position: 4,
            name: 'Set the time, and a repeat if you want one',
            text: 'Pick the date and time, optionally set it to repeat, and add it to the calendar. Hookpost sends it then.',
          },
        ],
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${CANONICAL}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Discord post scheduler', item: CANONICAL },
        ],
      },
      {
        '@type': 'WebPage',
        '@id': CANONICAL,
        url: CANONICAL,
        name: 'Discord post scheduler',
        description: WHAT_IT_IS,
        inLanguage: 'en',
        isPartOf: { '@id': 'https://hookpost.hookstep.in/#website' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        breadcrumb: { '@id': `${CANONICAL}#breadcrumbs` },
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Discord integration</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Discord post scheduler
        </h1>
        <p className="mt-5 max-w-[72ch] text-lg text-hp-text/75">{WHAT_IT_IS}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Connect Discord free', TRIAL_CTA)}
          </Link>
          <Link href="/guides/schedule-discord-announcements" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Step-by-step guide
          </Link>
        </div>
        <p className="mt-5 max-w-[70ch] text-sm text-hp-text/60">
          {offer(
            `Discord can be one of the ${FREE.channel} free channels. Paid plans start at ${planPrice('HOOKPOST', ' a month')}.`,
            TRIAL_SENTENCE
          )}
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What the integration can do</h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
          {CAPABILITIES.map((c) => (
            <li key={c.title} className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">{c.title}.</strong> {c.body}
            </li>
          ))}
        </ul>
        <p className="mt-6 max-w-[72ch] text-hp-text/60">
          What it does not do: it publishes to your server and nothing else. There is no Discord analytics, no inbox and no
          reading of messages or members back out of the server. Every per-network limit and rule:{' '}
          <Link href="/channels/discord" className="text-hp-primary-text underline">the Discord channel page</Link>.
        </p>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What people schedule to Discord</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">Release notes and launch pings</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                The announcement goes to the server at the same minute the post goes to X and LinkedIn, from one draft, so the
                community does not read it last - in your announcements channel, with the roles you want mentioned.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">A weekly recurring ping</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                Office hours, a standup reminder, a Friday thread. Set it to repeat every week and it is sent without anyone
                remembering to.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">Scheduling across time zones</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                A message written at midnight that should land when your server is awake. The post is queued for that hour and
                sent from Hookpost&apos;s servers, so nothing has to be open.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">Queued by an AI agent</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                Hookpost&apos;s <Link href="/mcp" className="text-hp-primary-text underline">MCP server</Link> lets Claude or Cursor
                draft the release note and put it in the queue for your announcements channel, for you to review on the
                calendar.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Other chat and community channels</h2>
          <p className="mt-4 max-w-[72ch] text-hp-text/75">
            Discord is one of {PUBLISHABLE_CHANNEL_COUNT} networks on the same calendar. The ones a community team usually wants
            next to it:
          </p>
          <ul className="mt-6 flex flex-wrap gap-2">
            {(
              [
                ['Slack', '/channels/slack'],
                ['Telegram', '/channels/telegram'],
                ['Bluesky', '/channels/bluesky'],
                ['X (Twitter)', '/channels/x'],
                ['LinkedIn', '/channels/linkedin'],
                ['Dev.to', '/channels/devto'],
                ['Hashnode', '/channels/hashnode'],
                ['WordPress', '/channels/wordpress'],
              ] as const
            ).map(([name, href]) => (
              <li key={href}>
                <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  {name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-[72ch] text-hp-text/60">
            The scheduler itself:{' '}
            <Link href="/social-media-scheduler" className="text-hp-primary-text underline">social media scheduler</Link>. Posting one
            update everywhere at once:{' '}
            <Link href="/guides/post-to-multiple-social-media-at-once" className="text-hp-primary-text underline">
              post to several networks at once
            </Link>. Scheduling from a script:{' '}
            <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">the scheduling API</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Questions</h2>
          <dl className="mt-8 flex flex-col gap-8">
            {FAQ.map((f) => (
              <div key={f.q} className="min-w-0">
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[72ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-12 rounded-3xl border border-hp-border-strong bg-gradient-to-b from-hp-elevated to-hp-surface p-8 text-center sm:p-12">
            <h2 className="text-3xl font-bold font-jakarta sm:text-4xl">Queue your server&apos;s next announcement</h2>
            <p className="mx-auto mt-4 max-w-lg text-hp-text/70">
              {offer(
                `Connect one Discord server and one other network on the free plan: ${FREE.posts_per_month} posts a month, no card.`,
                TRIAL_SENTENCE
              )}
            </p>
            <Link
              href="/auth"
              prefetch={false}
              className="mt-6 inline-block rounded-full bg-white px-10 py-4 text-base font-bold text-black transition-all hover:bg-hp-primary hover:text-hp-on-primary"
            >
              {offer('Connect Discord free', TRIAL_CTA)}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
