import { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { CHANNEL_SPECS } from '../../channels/channel-specs';
import { FREE_POSTS, offer, TRIAL_CTA } from '../../trial-offer';
import { planPrice } from '../../usd-offer';

// Targets "n8n social media automation", "n8n social media scheduler", "n8n
// schedule linkedin posts", "n8n twitter post" and "n8n postiz node alternative".
//
// Every operation named here exists in apps/n8n-node/nodes/Hookpost/Hookpost.node.ts
// and every credential field in apps/n8n-node/credentials/HookpostApi.credentials.ts.
// If the node gains or loses an operation, change OPERATIONS below in the same PR.
//
// Facts checked on CHECKED against live sources, re-check before bumping it:
// - npm: n8n-nodes-hookpost latest is NODE_VERSION.
// - n8n docs: "Unverified community nodes aren't available on n8n cloud".
// - api.n8n.io/api/community-nodes (the verified list): n8n-nodes-postiz is on
//   it, n8n-nodes-hookpost is not. Remove the Cloud caveat the day it is.
const CANONICAL = 'https://hookpost.hookstep.in/integrations/n8n';
//
// 11 Oct 2026: npm view n8n-nodes-hookpost version = 0.1.1 (published 15:25
// UTC from 0174afae; same six operations as 0.1.0). Added the
// Google Sheets content-calendar workflow (the dominant pattern on page 1), an
// n8n Cloud route through the built-in HTTP Request node, and an AI Agent
// example that feeds the node as a normal step (the node does not set
// usableAsTool, so it is not offered as an agent tool).
const CHECKED = '11 October 2026';
const NODE_VERSION = '0.1.1';
const BASE = 'https://hookpost.hookstep.in/api/public/v1';

const HOOKPOST = pricingINR.HOOKPOST;
const FREE = pricingINR.FREE;

const OPERATIONS: [string, string][] = [
  ['Create Post', 'Schedule a post, publish it now, or save it as a draft. The channel dropdown lists the channels you have connected in Hookpost. Leave Date empty on a scheduled post and the node asks Hookpost for the next free slot in your posting schedule.'],
  ['List Posts', 'Return every post between a start date and an end date.'],
  ['Delete Post', 'Delete a post by its id.'],
  ['List Channels', 'Return your connected channels with their ids.'],
  ['Find Free Slot', 'Return the next free slot in your posting schedule for one channel.'],
  ['Upload From URL', 'Pull an image or video from a public URL into your Hookpost media library. The result has a path you can pass to Create Post.'],
];

const CHANNEL_NAMES: Record<string, string> = {
  instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', pinterest: 'Pinterest', youtube: 'YouTube',
  linkedin: 'LinkedIn', facebook: 'Facebook Pages', x: 'X (Twitter)', bluesky: 'Bluesky', discord: 'Discord',
  slack: 'Slack', telegram: 'Telegram', lemmy: 'Lemmy', nostr: 'Nostr', listmonk: 'Listmonk',
  wordpress: 'WordPress', hashnode: 'Hashnode', devto: 'Dev.to',
};

const PUBLISHING_TODAY = Object.entries(CHANNEL_SPECS)
  .filter(([, spec]) => !spec.pending)
  .map(([slug]) => [CHANNEL_NAMES[slug] || slug, `/channels/${slug}`] as const);

const SHEET_COLUMNS = `date        | channel  | text                                   | status
2026-10-20  | linkedin | We moved our support hours to 9-9 IST. | ready
2026-10-21  | x        | Support is now open 9am to 9pm IST.    | ready`;

const SHEET_DATE = `{{ DateTime.fromISO($json.date + 'T09:30', { zone: 'Asia/Kolkata' }).toUTC().toISO() }}`;

const HTTP_BODY = `{
  "type": "schedule",
  "date": "{{ $json.dateUtc }}",
  "shortLink": false,
  "tags": [],
  "posts": [
    {
      "integration": { "id": "YOUR_CHANNEL_ID" },
      "value": [{ "content": {{ JSON.stringify($json.text) }}, "image": [] }]
    }
  ]
}`;

const LINKEDIN_CONTENT = `New on the blog: {{ $json.title }}

{{ $json.link }}`;

const X_CONTENT = `{{ $json.title }} {{ $json.link }}`;

const YOUTUBE_SETTINGS = `{
  "__type": "youtube",
  "title": "My video",
  "type": "private",
  "selfDeclaredMadeForKids": "no"
}`;

const FAQ = [
  {
    q: 'Is there an n8n node for Hookpost?',
    a: `Yes. n8n-nodes-hookpost is published on npm (version ${NODE_VERSION} as of ${CHECKED}). Install it from Settings, Community Nodes in a self-hosted n8n instance and add a Hookpost API credential with your API key.`,
  },
  {
    q: 'How do I schedule LinkedIn posts from n8n?',
    a: 'Add a Hookpost node, choose Create Post, pick your LinkedIn channel from the dropdown and set When to Schedule. Either set a Date or leave it empty and the node uses the next free slot in your Hookpost posting schedule.',
  },
  {
    q: 'Can n8n post to X (Twitter) through Hookpost?',
    a: 'Yes. Connect your X account in Hookpost, then choose it in the Create Post channel dropdown. X allows 280 characters (Hookpost accepts up to 4,000 for a Premium account), and Hookpost rejects a post that is too long with an error before queueing it.',
  },
  {
    q: 'Does the Hookpost node work on n8n Cloud?',
    a: 'Not yet. n8n Cloud only offers verified community nodes, and n8n-nodes-hookpost is not verified. On n8n Cloud, call the Hookpost REST API with the built-in HTTP Request node instead, sending your key in the Authorization header. The exact settings are on this page.',
  },
  {
    q: 'Can I schedule posts from a Google Sheets content calendar?',
    a: 'Yes. A Schedule Trigger reads rows marked ready from Google Sheets, a Hookpost Create Post node (or an HTTP Request on n8n Cloud) queues each one with its date, and a Google Sheets update marks the row scheduled so it is not posted twice.',
  },
  {
    q: 'Which Hookpost plan do I need?',
    a: `The node uses the Hookpost Public API, which comes with the Hookpost plan at ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month.${offer(` The Free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts) does not include API access.`, ` The ${FREE_POSTS} include it.`)}`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'n8n Social Media Automation Node | Hookpost',
  description:
    'Schedule LinkedIn, X and YouTube posts from n8n: the Hookpost community node, a Google Sheets content calendar, an AI Agent example and an n8n Cloud route.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'n8n social media automation with Hookpost',
    description: 'Install n8n-nodes-hookpost and schedule posts to LinkedIn, X, YouTube and more from any n8n workflow.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'article',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Hookpost n8n node' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'n8n social media automation with Hookpost',
    description: 'Install n8n-nodes-hookpost and schedule posts to LinkedIn, X, YouTube and more from n8n.',
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

export default function N8nIntegrationPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${CANONICAL}#article`,
        headline: 'Social media automation in n8n with the Hookpost node',
        description:
          'How to install the n8n-nodes-hookpost community node, what each operation does, and an example workflow that schedules blog posts to LinkedIn and X.',
        mainEntityOfPage: CANONICAL,
        datePublished: '2026-09-26T00:00:00+05:30',
        dateModified: '2026-10-10T00:00:00+05:30',
        image: 'https://hookpost.hookstep.in/og-image.png',
        proficiencyLevel: 'Beginner',
        publisher: {
          '@type': 'Organization',
          name: 'Hookpost',
          url: 'https://hookpost.hookstep.in/',
          logo: 'https://hookpost.hookstep.in/brand-logo.png',
        },
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
          { '@type': 'ListItem', position: 2, name: 'n8n integration', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">n8n community node · v{NODE_VERSION}</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Social media automation in n8n with the Hookpost node
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          <code className="font-mono text-hp-text">n8n-nodes-hookpost</code> lets an n8n workflow schedule, publish and delete
          posts on the channels you have connected in Hookpost. One credential covers every channel, so a single workflow can
          send the same update to LinkedIn, X, YouTube and Bluesky without a separate OAuth app for each.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <a
            href="https://www.npmjs.com/package/n8n-nodes-hookpost"
            rel="noopener"
            target="_blank"
            className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary"
          >
            n8n-nodes-hookpost on npm
          </a>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Install the node</h2>
        <ol className="mt-6 flex flex-col gap-4 text-hp-text/80 list-decimal ps-6">
          <li>
            In your self-hosted n8n, go to <strong className="text-hp-text">Settings → Community Nodes → Install</strong> and enter{' '}
            <code className="font-mono text-hp-text">n8n-nodes-hookpost</code>. Only an Owner or Admin can install community nodes.
          </li>
          <li>
            In Hookpost, open <strong className="text-hp-text">Settings → Developers</strong> and copy your API key.
          </li>
          <li>
            Back in n8n, create a <strong className="text-hp-text">Hookpost API</strong> credential. Paste the key into API Key and
            leave Base URL as <code className="font-mono text-hp-text">https://hookpost.hookstep.in/api</code>.
          </li>
          <li>
            Press <strong className="text-hp-text">Test</strong>. n8n calls <code className="font-mono text-hp-text">/public/v1/is-connected</code>{' '}
            to confirm the key before you build anything with it.
          </li>
        </ol>
        <div className="mt-6 max-w-[70ch] rounded-2xl border border-hp-border p-5 text-hp-text/70">
          <strong className="text-hp-text">On n8n Cloud?</strong> n8n Cloud only runs{' '}
          <A href="https://docs.n8n.io/integrations/community-nodes/installation-and-management/">verified community nodes</A>, and
          this node is not verified yet (checked {CHECKED}). Use the HTTP Request node with the{' '}
          <A href="/social-media-scheduling-api">Hookpost REST API</A> instead: same endpoints, same key.
        </div>
        <p className="mt-6 max-w-[70ch] text-hp-text/60">
          The node talks to the Hookpost Public API, which comes with the Hookpost plan at {planPrice('HOOKPOST', ' a month')} for{' '}
          {HOOKPOST.channel} channels and {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month. <A href="/pricing">See pricing</A>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What the node can do</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/60">Six operations. This is the complete list.</p>
          <dl className="mt-8 grid gap-3 sm:grid-cols-2">
            {OPERATIONS.map(([name, what]) => (
              <div key={name} className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">{name}</dt>
                <dd className="mt-2 text-hp-text/70">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Create Post also takes two optional fields. <strong className="text-hp-text">Image URLs</strong> is a comma-separated
            list of media already in Hookpost, usually the <code className="font-mono">path</code> returned by Upload From URL.{' '}
            <strong className="text-hp-text">Channel Settings (JSON)</strong> carries the extra fields some networks need. YouTube, for
            example, needs a title and a visibility:
          </p>
          <Code>{YOUTUBE_SETTINGS}</Code>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            There is no trigger node. To start a workflow when a post goes live, add a webhook in Hookpost under{' '}
            <strong className="text-hp-text">Settings → Webhooks</strong> pointing at an n8n Webhook node. Hookpost sends the post
            as JSON after it publishes, and you can limit a webhook to specific channels.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Example: blog RSS to LinkedIn and X</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            A three-node workflow that queues every new blog post for LinkedIn and X in your next free slots.
          </p>
          <ol className="mt-6 flex flex-col gap-6 text-hp-text/80 list-decimal ps-6">
            <li>
              <strong className="text-hp-text">RSS Feed Trigger</strong> (built into n8n), pointed at your blog&apos;s feed.
            </li>
            <li>
              <strong className="text-hp-text">Hookpost → Create Post.</strong> Channel: your LinkedIn profile. When: Schedule. Date:
              empty, so it takes the next free slot. Content:
              <Code>{LINKEDIN_CONTENT}</Code>
            </li>
            <li>
              <strong className="text-hp-text">Hookpost → Create Post</strong>, connected to the same trigger. Channel: your X
              account. When: Schedule. Content:
              <Code>{X_CONTENT}</Code>
            </li>
          </ol>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Hookpost checks each post against the network&apos;s rules before queueing it, so a title that pushes the X post
            past 280 characters fails at the node with a readable error rather than at publish time. Turn on{' '}
            <strong className="text-hp-text">Continue On Fail</strong> and the error is passed downstream as{' '}
            <code className="font-mono">{'{ "error": "..." }'}</code>, which you can route to Slack or email.
          </p>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            To attach an image, put <strong className="text-hp-text">Upload From URL</strong> before Create Post and set Image URLs
            to <code className="font-mono">{'{{ $json.path }}'}</code>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="google-sheets">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Example: a Google Sheets content calendar</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            The most common n8n setup: your team plans posts in a sheet, and n8n queues every row marked ready. Give the sheet these
            columns:
          </p>
          <Code>{SHEET_COLUMNS}</Code>
          <ol className="mt-6 flex flex-col gap-5 text-hp-text/80 list-decimal ps-6">
            <li>
              <strong className="text-hp-text">Schedule Trigger</strong>, every hour (or once a day).
            </li>
            <li>
              <strong className="text-hp-text">Google Sheets → Get Row(s)</strong>, filtered to <code className="font-mono">status</code>{' '}
              = ready.
            </li>
            <li>
              <strong className="text-hp-text">Switch</strong> on <code className="font-mono">channel</code>, one output per Hookpost
              channel, so each row reaches the Create Post node for its network.
            </li>
            <li>
              <strong className="text-hp-text">Hookpost → Create Post.</strong> When: Schedule. Content:{' '}
              <code className="font-mono">{'{{ $json.text }}'}</code>. Date: the sheet date at 9:30 India time, converted to UTC:
              <Code>{SHEET_DATE}</Code>
            </li>
            <li>
              <strong className="text-hp-text">Google Sheets → Update Row</strong>, matching on the row number, setting{' '}
              <code className="font-mono">status</code> to scheduled. Without this step the next run queues the same rows again.
            </li>
          </ol>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Want a human check first? Set When to Draft. The posts then wait in your Hookpost calendar as drafts until someone
            schedules them. Planning around Indian festivals? Start from the{' '}
            <A href="/social-media-calendar-india">India social media calendar</A>, which has a CSV you can paste into the sheet.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="ai-agent">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Example: let an AI Agent write the post</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            Put n8n&apos;s AI Agent node (or Basic LLM Chain) between the trigger and Hookpost. Prompt it with the source, for example
            the RSS item&apos;s title and summary, and ask for a LinkedIn post under 1,300 characters with no hashtags. Then map the
            agent&apos;s answer into Create Post: Content <code className="font-mono">{'{{ $json.output }}'}</code>, When: Draft.
          </p>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            Keep model-written posts as drafts until you trust them. If the text breaks a network&apos;s limit, Hookpost rejects it
            when it is scheduled, with the reason, so a bad generation never reaches the network. Hookpost&apos;s own{' '}
            <A href="/mcp">MCP server</A> is the other route, if you would rather have Claude or Cursor do the writing outside n8n.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="n8n-cloud">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">On n8n Cloud? Use the HTTP Request node</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            n8n Cloud only installs verified community nodes, and n8n-nodes-hookpost is not verified yet. The built-in HTTP Request
            node does the same job against the Public API:
          </p>
          <ul className="mt-4 flex max-w-[75ch] flex-col gap-1.5 text-hp-text/80">
            <li><strong className="text-hp-text">Method:</strong> POST</li>
            <li className="break-all"><strong className="text-hp-text">URL:</strong> {BASE}/posts</li>
            <li>
              <strong className="text-hp-text">Authentication:</strong> Generic Credential Type → Header Auth, name{' '}
              <code className="font-mono">Authorization</code>, value your API key on its own (no Bearer prefix)
            </li>
            <li><strong className="text-hp-text">Send Body:</strong> on, Body Content Type JSON, Specify Body: Using JSON</li>
          </ul>
          <Code>{HTTP_BODY}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            <code className="font-mono">dateUtc</code> is the UTC date from the step before (see the Sheets example), and{' '}
            <code className="font-mono">JSON.stringify</code> keeps quotes and line breaks in the text from breaking the JSON. Get
            your channel ids once with a GET to <code className="font-mono break-all">{BASE}/integrations</code>. More request examples:{' '}
            <A href="/social-media-scheduling-api">the scheduling API</A>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Channels the node can publish to today</h2>
          <ul className="mt-6 flex flex-wrap gap-2">
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

          <h3 className="mt-12 text-xl font-bold font-jakarta">Coming from the Postiz node?</h3>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            <code className="font-mono">n8n-nodes-postiz</code> is built for Postiz accounts, and it is on n8n&apos;s verified
            list, so it runs on n8n Cloud. <code className="font-mono">n8n-nodes-hookpost</code> is for Hookpost accounts and,
            for now, needs self-hosted n8n. Which one you want depends on where your account lives. Hookpost charges one flat
            price per plan rather than per channel, with rupee billing and UPI Autopay in India. See the <A href="/alternatives/postiz">Postiz comparison</A>.
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
            More ways in: the <A href="/docs/public-api">Public API reference</A>, the{' '}
            <A href="/social-media-scheduling-api">scheduling API overview</A>, the <A href="/mcp">MCP server</A> for Claude and
            Cursor, and <A href="/docs/oauth">OAuth apps</A> if your workflow acts on other people&apos;s Hookpost accounts.
          </p>
        </div>
      </section>
    </div>
  );
}
