import { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import { CHANNEL_SPECS } from '../channels/channel-specs';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { offer } from '../trial-offer';
import { planPrice, usdCopy, usdOffers } from '../usd-offer';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// Targets "social media scheduling api", "social media posting api", "api to
// schedule social media posts", "buffer api alternative" and "ayrshare alternative".
//
// Hookpost facts come from the code:
// - endpoints: apps/backend/src/public-api/routes/v1/public.integrations.controller.ts
// - auth + 401 messages: apps/backend/src/services/auth/public.auth.middleware.ts
// - rate limit: ThrottlerModule in apps/backend/src/app.module.ts plus
//   libraries/nestjs-libraries/src/throttler/throttler.provider.ts. Only
//   POST /public/v1/posts is throttled, per organisation, over one hour. The cap
//   is the API_LIMIT env var, so no number is printed here.
// - plan gate: public_api in pricing.ts; FREE has no subscription row, so its
//   key gets 401 "No subscription found".
// - SDK and CLI: @hookpost/node and hookpost confirmed live on npm on CHECKED.
//
// 11 Oct 2026: added Zapier/Make (there is no native app, so the page shows
// the raw HTTP request), the CLI and SDK as live on npm (11 Oct, after the
// 15:25 UTC publish: hookpost 0.1.1, @hookpost/node 1.0.2; 0.1.1 takes several
// channels per post, apps/cli/src/index.ts flags()), bulk scheduling without CSV import (none
// exists), and failure behaviour: POST /posts has no idempotency key and
// returns [{ postId, integration }]; GET /posts returns each post's state
// (QUEUE, DRAFT, PUBLISHED, ERROR) and releaseURL; over the monthly quota the
// API answers 402. The channel list now renders from channel-specs.ts.
//
// Competitor facts were read off their own pages on CHECKED. Re-check before
// bumping the date; one stale figure makes the whole comparison untrustworthy.
const CANONICAL = 'https://hookpost.hookstep.in/social-media-scheduling-api';
const CHECKED = '26 September 2026';
const BASE = 'https://hookpost.hookstep.in/api/public/v1';

const HOOKPOST = pricingINR.HOOKPOST;

const CHANNEL_NAMES: Record<string, string> = {
  instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', pinterest: 'Pinterest', youtube: 'YouTube',
  linkedin: 'LinkedIn', facebook: 'Facebook Pages', x: 'X (Twitter)', bluesky: 'Bluesky', discord: 'Discord',
  slack: 'Slack', telegram: 'Telegram', lemmy: 'Lemmy', nostr: 'Nostr', listmonk: 'Listmonk',
  wordpress: 'WordPress', hashnode: 'Hashnode', devto: 'Dev.to',
};

const PUBLISHING_TODAY = Object.entries(CHANNEL_SPECS)
  .filter(([, spec]) => !spec.pending)
  .map(([slug]) => [CHANNEL_NAMES[slug] || slug, `/channels/${slug}`] as const);

const ZAPIER_BODY = `{
  "type": "schedule",
  "date": "{{ISO date from your trigger, e.g. 2026-10-20T03:30:00.000Z}}",
  "shortLink": false,
  "tags": [],
  "posts": [
    {
      "integration": { "id": "LINKEDIN_CHANNEL_ID" },
      "value": [{ "content": "{{Post text from your trigger}}", "image": [] }]
    }
  ]
}`;

const CLI = `npm install -g hookpost
export HOOKPOST_API_KEY="your_key"

hookpost channels
hookpost post "Release 2.3 is live." --channel abc123 --at 2026-10-20T03:30:00Z
hookpost post "Rough idea for Friday" --channel abc123 --draft
hookpost post "Ship log #12" --channel abc123,def456   # several channels, one post
hookpost slot abc123          # next free slot in your posting schedule
hookpost delete <postId>`;

const SDK = `import Hookpost from '@hookpost/node';

const hookpost = new Hookpost(process.env.HOOKPOST_API_KEY!);
const channels = await hookpost.integrations();

await hookpost.post({
  type: 'draft',
  date: '2026-10-20T03:30:00.000Z',
  shortLink: false,
  tags: [],
  posts: [{ integration: { id: channels[0].id }, value: [{ content: 'Release 2.3 is live.', image: [] }] }],
});`;

const BULK = `# posts.tsv: date<TAB>text, one post per line
while IFS=$'\t' read -r when text; do
  hookpost post "$text" --channel abc123 --at "$when" || echo "failed: $when"
done < posts.tsv`;

const LIST_CHANNELS = `curl "${BASE}/integrations" \\
  -H "Authorization: YOUR_API_KEY"`;

const CREATE_POST = `curl -X POST "${BASE}/posts" \\
  -H "Authorization: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "schedule",
    "date": "2026-10-01T09:00:00.000Z",
    "shortLink": false,
    "tags": [],
    "posts": [
      {
        "integration": { "id": "LINKEDIN_CHANNEL_ID" },
        "value": [{ "content": "We shipped the new dashboard today.", "image": [] }]
      },
      {
        "integration": { "id": "X_CHANNEL_ID" },
        "value": [{ "content": "New dashboard is live.", "image": [] }]
      }
    ]
  }'`;

const ENDPOINTS: [string, string][] = [
  ['Posts', 'Create (schedule, publish now or draft), list by date range, delete, update status and per-channel settings, check which channels a post has not gone out on.'],
  ['Scheduling', 'GET /find-slot/:id returns the next free slot in your posting schedule for a channel.'],
  ['Channels', 'List connected channels, read a channel’s settings schema, start connecting a new channel, disconnect one.'],
  ['Media', 'Upload a file, or upload from a public URL. The response includes the path you attach to a post.'],
  ['Analytics', 'Channel-level analytics and per-post analytics.'],
];

const COMPETITORS: { name: string; api: string; entry: string; source: string }[] = [
  {
    name: 'Hookpost',
    api: 'REST, JSON. Key sent as a bare Authorization header.',
    entry: `Hookpost, ${planPrice('HOOKPOST', '/month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month} posts.${offer(' No API on the Free plan.', '')}`,
    source: '/pricing',
  },
  {
    name: 'Buffer',
    api: 'GraphQL at api.buffer.com. Bearer API key or OAuth 2.0.',
    entry: 'Available on Buffer’s Free plan: 1 API key, 100 requests per 15 minutes, 250 per day, 3,000 per 30 days.',
    source: 'https://developers.buffer.com/guides/api-limits.html',
  },
  {
    name: 'Ayrshare',
    api: 'API built for platforms that post on behalf of many user profiles.',
    entry: 'No free plan listed. Premium $149/month for 1 social profile; Launch $299/month for up to 10 profiles, with a 28-day trial.',
    source: 'https://www.ayrshare.com/pricing/',
  },
];

const FAQ = [
  {
    q: 'Is there an API to schedule social media posts?',
    a: `Yes. Hookpost's Public API schedules, publishes and deletes posts over plain REST at ${BASE}. One request can target several channels at once. It is included in the Hookpost plan at ${planPrice('HOOKPOST', ' a month')}.`,
  },
  {
    q: 'Which networks can the API post to?',
    a: `Any channel connected in Hookpost: ${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, Instagram (Business or Creator), Threads, Pinterest, Bluesky, Telegram, Discord, WordPress and Dev.to. TikTok posts publish to your TikTok account with the audience your account allows (Everyone, Friends, Followers or Only me), or go to your TikTok inbox as drafts if you choose that mode. Medium no longer issues new API tokens, so Hookpost does not connect it.`,
  },
  {
    q: 'What are the API rate limits?',
    a: 'Creating posts is capped per organisation over a one-hour window, and going over returns HTTP 429. Reads are not throttled. Separately, every post counts toward your plan’s monthly post limit.',
  },
  {
    q: 'Can I schedule posts from Zapier or Make?',
    a: 'Yes, with a plain HTTP request. There is no native Hookpost app in Zapier or Make, so use Webhooks by Zapier (Custom Request) or Make’s HTTP “Make a request” module to POST to /api/public/v1/posts with your key in the Authorization header.',
  },
  {
    q: 'What happens if a request fails or times out?',
    a: 'A post that breaks a network rule is rejected with a 400 that names the channel, before anything is queued. There is no idempotency key, so if a create request times out, list posts for that date range before retrying or you may schedule it twice. A post that fails later at publish time shows state ERROR in GET /posts.',
  },
  {
    q: 'Is Hookpost a Buffer API alternative?',
    a: 'For some teams. Buffer’s API is GraphQL and is available on its free plan with daily and monthly request caps. Hookpost’s is REST, needs a paid plan, and adds an MCP server, a CLI and an n8n node on the same key. If you want a free tier to experiment with, Buffer is the cheaper place to start.',
  },
  {
    q: 'Is Hookpost an Ayrshare alternative?',
    a: `If you are posting to your own or your company’s channels, yes: Hookpost is ${planPrice('HOOKPOST', ' a month')} against Ayrshare’s $149 a month entry plan. Ayrshare is built for SaaS platforms posting on behalf of many end users, which Hookpost’s plans are not priced for.`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Social Media Scheduling API (REST) | Hookpost',
  description: `REST API, CLI and Node SDK to schedule posts to X, LinkedIn, YouTube, Bluesky and ${PUBLISHABLE_CHANNEL_COUNT - 4} more networks. Real curl, Zapier and Make examples. From ${planPrice('HOOKPOST', '/month')}.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Social media scheduling API - Hookpost',
    description: 'Schedule posts to X, LinkedIn, YouTube, Bluesky and more with one REST call.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Hookpost social media scheduling API' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Social media scheduling API - Hookpost',
    description: 'Schedule posts to X, LinkedIn, YouTube, Bluesky and more with one REST call.',
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

const Code = ({ children }: { children: string }) => (
  <pre className="mt-3 overflow-x-auto rounded-xl border border-hp-border bg-white/[0.03] p-4 text-xs leading-relaxed font-mono text-hp-text/90">
    {children}
  </pre>
);

const A = ({ href, children }: { href: string; children: ReactNode }) =>
  href.startsWith('http') ? (
    <a href={href} className="text-hp-primary-text underline" rel="nofollow noopener" target="_blank">
      {children}
    </a>
  ) : (
    <Link href={href} className="text-hp-primary-text underline">
      {children}
    </Link>
  );

export default function SchedulingApiPage() {
  const hookpostOffer = {
    '@type': 'Offer',
    name: 'Hookpost plan',
    price: String(HOOKPOST_PRICE.displayUsd),
    priceCurrency: 'USD',
    url: 'https://hookpost.hookstep.in/pricing',
    description: `${HOOKPOST.channel} channels, ${HOOKPOST.posts_per_month} posts per month, Public API included.`,
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${CANONICAL}#api`,
        name: 'Hookpost Public API',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        url: CANONICAL,
        description: 'REST API to schedule, publish and delete social media posts across X, LinkedIn, YouTube, Bluesky and more.',
        // The rupee offer alone while rupees are all that is sold; once dollars
        // are (usd-offer.ts) it is scoped to India and the dollar one follows.
        offers: usdCopy(hookpostOffer, [
          { ...hookpostOffer, eligibleRegion: 'IN' },
          ...usdOffers(['HOOKPOST']).map((o) => ({
            ...o,
            name: 'Hookpost plan',
            url: hookpostOffer.url,
            description: hookpostOffer.description,
          })),
        ]),
      },
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
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Social media scheduling API', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">REST API · Hookpost plan</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          A social media scheduling API you call with one header
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Hookpost&apos;s social media scheduling API, the Public API, schedules, publishes and deletes posts on every channel you have connected. It is plain REST
          with JSON in and out, and one request can send a post to LinkedIn and X at the same time. It is included in the{' '}
          <strong className="text-hp-text">Hookpost plan at {planPrice('HOOKPOST', ' a month')}</strong>, which covers {HOOKPOST.channel}{' '}
          channels and {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            Get an API key
          </Link>
          <Link href="/docs/public-api" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Read the API reference
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Two requests to your first scheduled post</h2>
        <p className="mt-3 max-w-[70ch] text-hp-text/70">
          Copy your key from <strong className="text-hp-text">Settings → Developers</strong>. It goes in the{' '}
          <code className="font-mono text-hp-text">Authorization</code> header on its own, with{' '}
          <strong className="text-hp-text">no Bearer prefix</strong>. First, list your channels to get their ids:
        </p>
        <Code>{LIST_CHANNELS}</Code>
        <p className="mt-6 max-w-[70ch] text-hp-text/70">
          Then create the post. <code className="font-mono text-hp-text">type</code> is{' '}
          <code className="font-mono text-hp-text">schedule</code>, <code className="font-mono text-hp-text">now</code> or{' '}
          <code className="font-mono text-hp-text">draft</code>, and dates are ISO 8601 in UTC. Each entry in{' '}
          <code className="font-mono text-hp-text">posts</code> is one channel, so this schedules different copy to LinkedIn and X
          in a single call:
        </p>
        <Code>{CREATE_POST}</Code>
        <p className="mt-6 max-w-[70ch] text-hp-text/70">
          Hookpost validates each post against the network&apos;s rules before it is queued, the same checks the app runs. A post
          that is too long for X, or one missing a required channel setting, comes back as a 400 with the channel and the reason, not as
          a failure at publish time. Channels that need extra fields expose their schema at{' '}
          <code className="font-mono text-hp-text">/integration-settings/:id</code>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What the API covers</h2>
          <dl className="mt-8 grid gap-3 sm:grid-cols-2">
            {ENDPOINTS.map(([name, what]) => (
              <div key={name} className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">{name}</dt>
                <dd className="mt-2 text-hp-text/70">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            <strong className="text-hp-text">Webhooks.</strong> Add one under Settings → Webhooks and Hookpost POSTs the post as JSON
            to your URL after it publishes, optionally only for chosen channels. The Hookpost plan includes {HOOKPOST.webhooks}.
          </p>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            <strong className="text-hp-text">Limits.</strong> Creating posts is capped per organisation over a one-hour window, and
            going over returns HTTP 429. Reads are not throttled. Every post also counts toward your monthly allowance:{' '}
            {HOOKPOST.posts_per_month.toLocaleString('en-IN')} on the Hookpost plan. A key on an account with
            no paid plan returns <code className="font-mono">401 No subscription found</code>.
          </p>

          <h3 className="mt-12 text-xl font-bold font-jakarta">Channels the API can publish to today</h3>
          <ul className="mt-4 flex flex-wrap gap-2">
            {PUBLISHING_TODAY.map(([name, href]) => (
              <li key={href}>
                <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  {name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 max-w-[70ch] text-sm text-hp-text/55">
            Instagram needs a Business or Creator account. TikTok posts publish to your TikTok account with the audience it
            allows (Everyone, Friends, Followers or Only me), or go to your TikTok inbox as drafts if you choose that mode. Medium stopped issuing new API tokens, so Hookpost does not connect
            Medium.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="terminal">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">From the terminal: CLI and Node SDK</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            Both are on npm and use the same key. The <code className="font-mono">hookpost</code> CLI (version 0.1.1) posts to one or more
            channels per command (<code className="font-mono">--channel abc123,def456</code>); leave out <code className="font-mono">--at</code> and the post takes the next free slot in your
            posting schedule. In CI, set <code className="font-mono">HOOKPOST_API_KEY</code> instead of running{' '}
            <code className="font-mono">hookpost auth login</code>.
          </p>
          <Code>{CLI}</Code>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            <code className="font-mono">@hookpost/node</code> (version 1.0.2) wraps posting, listing, image upload, channels and
            delete, and works with import or require:
          </p>
          <Code>{SDK}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/60">
            Driving it from an AI assistant instead? The <A href="/mcp">MCP server</A> uses the same key; see{' '}
            <A href="/guides/claude-code-social-media">posting from Claude Code</A>. No-code workflows:{' '}
            <A href="/integrations/n8n">the n8n node</A>. Building something other people connect their own Hookpost account to? Use{' '}
            <A href="/docs/oauth">OAuth apps</A> rather than collecting API keys.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="zapier-make">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">From Zapier or Make (no native app)</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            Hookpost has no app in the Zapier or Make directories. Both can still call the API with a plain HTTP request, which is
            all the API needs.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="min-w-0 rounded-2xl border border-hp-border p-5">
              <h3 className="font-bold font-jakarta">Zapier: Webhooks by Zapier → Custom Request</h3>
              <ul className="mt-3 flex flex-col gap-1.5 text-sm text-hp-text/75">
                <li><strong className="text-hp-text">Method:</strong> POST</li>
                <li className="break-all"><strong className="text-hp-text">URL:</strong> {BASE}/posts</li>
                <li><strong className="text-hp-text">Headers:</strong> Authorization = your API key; Content-Type = application/json</li>
                <li><strong className="text-hp-text">Data:</strong> the JSON below, with fields mapped from your trigger</li>
              </ul>
            </div>
            <div className="min-w-0 rounded-2xl border border-hp-border p-5">
              <h3 className="font-bold font-jakarta">Make: HTTP → Make a request</h3>
              <ul className="mt-3 flex flex-col gap-1.5 text-sm text-hp-text/75">
                <li><strong className="text-hp-text">URL:</strong> <span className="break-all">{BASE}/posts</span>, method POST</li>
                <li><strong className="text-hp-text">Headers:</strong> Authorization = your API key</li>
                <li><strong className="text-hp-text">Body type:</strong> Raw, content type JSON (application/json)</li>
                <li><strong className="text-hp-text">Request content:</strong> the JSON below</li>
              </ul>
            </div>
          </div>
          <Code>{ZAPIER_BODY}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            The date must be ISO 8601 in UTC (10:00 IST is 04:30Z), so put a date formatter step before the request if your trigger
            gives a local time. Get channel ids once with <code className="font-mono">GET /integrations</code> and paste them in.
            Change <code className="font-mono">type</code> to <code className="font-mono">draft</code> while you test the zap or
            scenario.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="bulk">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Scheduling many posts at once</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            Hookpost has no CSV import. To schedule a batch, loop over your file and make one request per post, or one request per
            date with several channels in it. A shell loop with the CLI:
          </p>
          <Code>{BULK}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            Post creation is rate-limited per workspace per hour, and over the limit the API answers 429, so pace long batches.
            An AI assistant connected over <A href="/mcp">MCP</A> can do the same from a pasted list: ask it to save each line as a
            draft on its date.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="failures">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">When something fails</h2>
          <dl className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <div className="rounded-2xl border border-hp-border p-5">
              <dt className="font-bold text-hp-text">Rejected before it is queued: 400</dt>
              <dd className="mt-2 text-sm">Too long for a network, missing media or a required setting. The response names the
                channel and the reason. Drafts skip these checks until you schedule them.</dd>
            </div>
            <div className="rounded-2xl border border-hp-border p-5">
              <dt className="font-bold text-hp-text">Retries can duplicate: no idempotency key</dt>
              <dd className="mt-2 text-sm">A successful create returns the new post ids. If a request times out, call{' '}
                <code className="font-mono">GET /posts</code> for that date range before sending it again.</dd>
            </div>
            <div className="rounded-2xl border border-hp-border p-5">
              <dt className="font-bold text-hp-text">Failed at publish time: state ERROR</dt>
              <dd className="mt-2 text-sm"><code className="font-mono">GET /posts</code> returns each post&apos;s state (QUEUE,
                DRAFT, PUBLISHED or ERROR) and, once live, its URL. The team also gets an in-app notification and, unless turned
                off, an email.</dd>
            </div>
            <div className="rounded-2xl border border-hp-border p-5">
              <dt className="font-bold text-hp-text">Account limits: 401, 402, 429</dt>
              <dd className="mt-2 text-sm">401 for a missing or wrong key or a workspace with no paid plan, 402 once the
                month&apos;s post allowance is used, 429 when post creation goes over the hourly limit.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Compared with Buffer&apos;s API and Ayrshare</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/60">
            Read off each company&apos;s own pages on {CHECKED}. Follow the source link to confirm.
          </p>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <caption className="sr-only">Social media scheduling APIs compared</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">API</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Style</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Cheapest way in</th>
                  <th scope="col" className="py-3 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {COMPETITORS.map((row) => (
                  <tr key={row.name} className={`border-b border-hp-border ${row.name === 'Hookpost' ? 'bg-hp-primary/[0.06]' : ''}`}>
                    <th scope="row" className="py-4 pe-4 font-bold">{row.name}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{row.api}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.entry}</td>
                    <td className="py-4">
                      <A href={row.source}>{row.source.startsWith('http') ? 'their docs' : 'our pricing'}</A>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            The honest summary: Buffer lets you try its API on a free plan, which Hookpost does not. Ayrshare is priced for
            platforms posting on behalf of many users. If you are automating your own or your company&apos;s channels, Hookpost
            gives you a REST API, webhooks, an MCP server and an n8n node for {planPrice('HOOKPOST', ' a month')}. More detail in
            the <A href="/alternatives/buffer">Buffer comparison</A>.
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
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-10 text-hp-text/60">
            Full endpoint list and error messages: <A href="/docs/public-api">Public API reference</A>. Plan limits:{' '}
            <A href="/pricing">pricing</A>.
          </p>
        </div>
      </section>
    </div>
  );
}
