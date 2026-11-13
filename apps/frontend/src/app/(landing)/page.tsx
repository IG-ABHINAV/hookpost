// Server component. The only interactive part - the mobile menu - lives in
// site-nav.tsx, so none of this page's markup ships to the browser as JS.

// Homepage, rebuilt September 2026.
//
// Two things drove the
// rewrite: it named competitors throughout — this page is about our own
// product, and /alternatives/<competitor> already serves anyone searching for a
// comparison — and it carried claims that were not true, listed below where
// each is corrected.
//
// Every number here comes from pricing.ts. Do not edit them in isolation.

import {
  FestivalPill,
  HeroGlow,
  HolidayOfferStrip,
} from '@hookpost/frontend/components/billing/holiday.offer.banner';
import { currentFestival } from '@hookpost/frontend/components/billing/holiday.offer';
import { SiteNav } from "./site-nav";
import Link from "next/link";
import SeoSchemas from "./SeoSchemas";
import AeoAnswerCapsule from "./AeoAnswerCapsule";
import LandingFaq from "./LandingFaq";
import { PricingPlans } from './PricingPlans';
import { PricingContrast } from './PricingContrast';
import { GooglePlayBadge } from './google-play-badge';
import { PUBLISHABLE_CHANNEL_COUNT } from './channels/channel-count';
import { pricingINR as pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from './trial-offer';
import { planPrice, usdCopy } from './usd-offer';
import { HERO_DEMO_LABEL } from './hero-demo';
import { HERO_DEMO_FACTS } from './hero-demo.facts';
import { HeroDemoVideo } from './hero-demo-video';

const CHANNELS = [
  "instagram", "threads", "tiktok", "youtube", "linkedin", "x", "facebook",
  "bluesky", "pinterest", "discord", "slack",
  "telegram", "wordpress", "hashnode", "devto",
];

// The people who actually work on Hookpost. The operator is Hookstep, so these
// are their Hookstep titles, said as such rather than reframed as Hookpost
// roles they do not hold. Mohan leads because he is Hookpost's founder, which
// is what our Organization schema also says.
const TEAM = [
  {
    slug: "mohan",
    name: "Mohan Bhanushali",
    role: "Founder, Hookpost",
    bio: "Operations lead at Hookstep — process, partnerships and delivery. Founded Hookpost.",
  },
  {
    slug: "sakshi",
    name: "Sakshi",
    role: "Head of Sales, Hookstep",
    bio: "Builds client relationships and helps companies hire exceptional tech talent, fast.",
  },
];

// The demo video's transcript: its burned-in captions (what is said) and the
// text on screen, read off both cuts, with the figures from
// hero-demo.facts.ts. Both cuts say the same words and show the same panels,
// except the CLI one (16:9: "sped up · help excerpt" with a `hookpost post`
// example; 9:16: "typing re-rendered", 1.5x, the help header only), so that
// line describes only what both show and every line shows at every width.
// The only "free" in it is the end card's free posts (hero-demo.spec.ts
// checks it); the 2 Nov 2026 re-cut dropped the trial the cut used to offer, and the
// 10 Nov 2026 one the spoken $19 line and the $19/$29 price card.
const { plan: PLAN, networks: NETWORKS, freePosts: FREE_POSTS_SHOWN } = HERO_DEMO_FACTS;
const DEMO_TRANSCRIPT: Array<{ said: string; shown?: string }> = [
  {
    said: "Posting the same update to six apps eats an hour of your day.",
    shown: "The LinkedIn, X, Instagram, Facebook, Threads and YouTube icons.",
  },
  { said: "Here is the fastest way. This is Hookpost.", shown: "The Hookpost logo." },
  {
    said: `Connect your accounts once. ${NETWORKS.join(", ")}.`,
    shown: "An icon for each network as it is named.",
  },
  { said: "Then just tell Claude what you want." },
  {
    said: "Write next week’s posts about my launch, one for each network, and schedule them for 9 am.",
    shown: "A Claude Code session labelled “real Claude Code session · replayed from its log · 6× faster”: the prompt “Turn my-notes.md into a week of posts for LinkedIn, Threads and Facebook and save them as drafts in Hookpost, one per day at 9 am IST, starting 9 Nov 2026”, then Claude reading the notes and checking each network’s limits.",
  },
  {
    said: "Claude writes each post in that platform style and drops it into your Hookpost calendar.",
    shown: "One of Claude’s 21 drafts, for Threads on 9 November 2026 at 9:00 AM IST, then the week’s calendar: “The 21 drafts from that run · 9–15 Nov · saved as drafts”.",
  },
  { said: "You review, tweak anything, and everything goes out on time." },
  {
    said: "Prefer the terminal? Same thing from the Hookpost CLI.",
    shown: "npm install -g hookpost, then the hookpost CLI’s help, in a terminal labelled as real CLI output, sped up.",
  },
  {
    said: "hookpost.hookstep.in",
    shown: `The Hookpost logo and “Get ${FREE_POSTS_SHOWN} free posts →”, then “No card needed · then $${PLAN.usdPerMonth}/month”.`,
  },
];

/**
 * A block that starts a full screen or more below the fold, at both phone and
 * desktop widths: rendering is skipped until it nears the viewport
 * (.hp-below-fold in landing-global.scss). sm/lg are its measured heights in
 * px at 375 and 1350 wide, used as its placeholder until it renders. Full
 * width and margin-free, so wrapping a section changes no spacing; nothing in
 * these blocks paints outside them.
 */
const BelowFold = ({ sm, lg, children }: { sm: number; lg: number; children: React.ReactNode }) => (
  <div
    className="hp-below-fold"
    style={{ '--below-fold-sm': `${sm}px`, '--below-fold-lg': `${lg}px` } as React.CSSProperties}
  >
    {children}
  </div>
);

// No request headers are read here. This page is edge-cached by Cloudflare for
// every visitor, so anything picked from the request's country was the country
// of whoever filled the cache, shown to everyone after them. Prices in the
// text name both currencies; the plan cards switch currency in the browser.
export default function HomePage() {
  // `pricing` is pricingINR: the free tier's channel and post counts are
  // identical in every currency; only the paid figure and its symbol vary.

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <SeoSchemas />

      <SiteNav />
      {/* The current festival's offer and theme (holiday.offer.ts); gone once the calendar runs out. */}
      <HolidayOfferStrip initialKey={currentFestival()?.key ?? null} />

      {/* -------------------------------------------------------------- hero */}
      {/* Full width, so the festival glow fades out at the screen edges rather
          than at the 1280px column; overflow-x-clip keeps it from widening
          the page on phones. */}
      <div className="relative isolate overflow-x-clip">
        {/* A soft glow in the festival's colours while one runs (holiday.offer.ts). */}
        <HeroGlow initialKey={currentFestival()?.key ?? null} />
        <section className="relative mx-auto w-full max-w-[1280px] px-5 pb-16 pt-16 sm:px-10 sm:pt-24">
          <div className="relative grid items-center gap-14 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-hp-primary/30 bg-hp-primary/10 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                  {usdCopy('Made in India · UPI billing', 'Made in India · billed in $ or ₹')}
                </span>
                <FestivalPill initialKey={currentFestival()?.key ?? null} />
              </div>

              <h1 className="mt-6 text-[38px] font-extrabold leading-[1.08] tracking-tight sm:text-[54px] font-jakarta text-balance">
                The social media scheduler your AI agent can use
              </h1>

              {/* The H1 and this paragraph are the first text a crawler weighs,
                  and neither said "social media scheduler" - the phrase the
                  page's title and schema are built around. */}
              <p className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-hp-text/70">
                Hookpost is a social media scheduler that publishes to {PUBLISHABLE_CHANNEL_COUNT} networks from one visual calendar. It also
                ships a Model Context Protocol server, so Claude Code, Cursor and
                Windsurf can draft and queue posts without you opening the app.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-4">
                <Link
                  href="/auth"
                  prefetch={false}
                  className="rounded-full bg-hp-primary px-7 py-3.5 font-semibold text-hp-on-primary transition-opacity hover:opacity-90"
                >
                  {offer('Start free — no card', TRIAL_CTA)}
                </Link>
                <Link
                  href="/mcp"
                  prefetch={false}
                  className="rounded-full border border-hp-border-strong px-7 py-3.5 font-semibold transition-colors hover:border-hp-primary/50 hover:text-hp-primary-text"
                >
                  Set up the MCP server
                </Link>
                <GooglePlayBadge medium="hero" className="h-[72px] w-[186px] max-w-none object-contain -my-[10px] -mx-[10px]" />
              </div>

              <p className="mt-5 text-sm text-hp-text/60">
                {/* With the free-posts offer there is no Free tier to describe. */}
                {offer(
                  <>
                    Free tier is {pricing.FREE.channel} channels and{' '}
                    {pricing.FREE.posts_per_month} posts a month, and does not expire.
                    {/*
                      This line used to be hardcoded to `pricingINR` and a literal ₹,
                      while the pricing section further down this same page already
                      took `currency` (line above, passed to PricingPlans). So a US
                      visitor read "Paid plans start at ₹599" in the hero and "$15" in
                      the pricing table - two different prices on one page, and the
                      rupee one first. /pricing was always correct; only the home page
                      hero was not, which is the page that paid and launch traffic
                      actually lands on.
                    */}
                    {/* Rupees only while rupees are all that is sold (owner, 11 Oct 2026); both prices once
                        dollars are (usd-offer.ts). Not geo-picked either way, because Cloudflare caches this
                        HTML for every visitor. */}
                    Paid plans start at {planPrice('HOOKPOST', ' a month')}.
                  </>,
                  // One line: "3 free posts, no card needed. Then $7/month."
                  <>{TRIAL_SENTENCE}</>
                )}
              </p>
            </div>

            {/* terminal */}
            <div className="min-w-0 rounded-2xl border border-hp-border bg-hp-surface shadow-2xl">
              <div className="flex items-center gap-2 border-b border-hp-border px-4 py-3">
                <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 font-mono text-xs text-hp-text/60">
                  hookpost — CLI
                </span>
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-[1.9] text-hp-text/80">
<span className="text-hp-text/35">$ </span>npm install -g hookpost{"\n"}
<span className="text-hp-text/35">$ </span>hookpost auth login{"\n"}
<span className="text-[#28c840]">✓</span> Signed in{"\n"}
{"\n"}
<span className="text-hp-text/35">$ </span>hookpost channels{"\n"}
<span className="text-hp-primary-text">abc123</span>  Acme  <span className="text-hp-text/60">linkedin</span>{"\n"}
<span className="text-hp-primary-text">def456</span>  Acme  <span className="text-hp-text/60">bluesky</span>{"\n"}
{"\n"}
<span className="text-hp-text/35">$ </span>hookpost post <span className="text-[#febc2e]">&quot;Shipped something small today.&quot;</span> \{"\n"}
{"    "}--channel abc123{"\n"}
<span className="text-hp-text/50">  No --at given, using next free slot: 09:00</span>{"\n"}
<span className="text-[#28c840]">✓</span> Created.
              </pre>
            </div>
          </div>
        </section>
      </div>

      {/* -------------------------------------------------------- demo video */}
      {/* The cuts, their claims check and how they load: hero-demo.ts and
          hero-demo-video.tsx. No name or title goes next to the face in it. */}
      <section className="mx-auto w-full max-w-[1280px] px-5 py-8 sm:px-10" data-testid="hero-demo">
        <div className="rounded-3xl border border-hp-border bg-gradient-to-b from-white/[0.04] to-transparent p-6 sm:p-10">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-hp-primary/30 bg-hp-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                Demo
              </span>
              <h2 className="mt-3 text-2xl sm:text-3xl font-extrabold font-jakarta tracking-tight text-hp-text">
                Connect once. Tell Claude what to post.
              </h2>
              <p className="mt-2 text-hp-text/70 max-w-xl text-sm sm:text-base">
                Connect your accounts once, ask Claude for next week&rsquo;s posts, and it writes one for each network in that platform&rsquo;s style and drops them into your Hookpost calendar to review. Prefer the terminal? Same thing from the Hookpost CLI.
              </p>
            </div>
            <Link
              href="/auth"
              prefetch={false}
              data-testid="hero-demo-cta"
              className="self-start md:self-auto rounded-full bg-hp-primary px-6 py-3 text-sm font-semibold text-hp-on-primary transition-opacity hover:opacity-90 whitespace-nowrap"
            >
              {offer('Start free', TRIAL_CTA)} →
            </Link>
          </div>
          <HeroDemoVideo label={HERO_DEMO_LABEL} />
          <p className="mx-auto mt-3 max-w-4xl text-center text-xs text-hp-text/60">
            Claude&rsquo;s session is replayed from its log; the CLI output is real, sped up.
          </p>
          <details
            className="group mx-auto mt-4 max-w-4xl rounded-xl border border-hp-border bg-hp-surface p-4 text-sm"
            data-testid="hero-demo-transcript"
          >
            <summary className="flex cursor-pointer list-none select-none items-center justify-between font-semibold text-hp-text/80">
              <span>Transcript</span>
              <span aria-hidden="true" className="ml-4 text-xs text-hp-text/60 transition-transform group-open:rotate-180">
                ▼
              </span>
            </summary>
            <ul className="mt-3 space-y-3 border-t border-hp-border pt-3">
              {DEMO_TRANSCRIPT.map((line) => (
                <li key={line.said}>
                  <p className="text-hp-text/85">{line.said}</p>
                  {line.shown ? <p className="mt-1 text-xs text-hp-text/55">On screen: {line.shown}</p> : null}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </section>

      {/* ------------------------------------------------- direct answer block */}
      {/* Everything from here down starts at least a screen below the fold
          (2,291px on a phone, 1,717px on a desktop): see BelowFold. */}
      <BelowFold sm={1250} lg={642}>
        <AeoAnswerCapsule />
      </BelowFold>

      {/* ------------------------------------------------------------ who for */}
      <BelowFold sm={1283} lg={600}>
        <section className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
            Built for people who automate
          </h2>
          <p className="mt-3 max-w-[60ch] text-hp-text/60">
            Most schedulers assume a human opens a dashboard. Hookpost works that
            way too — and works when nobody does.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              {
                tag: "AI agents",
                title: "Post from Claude or Cursor",
                body: "The MCP server exposes your calendar and channels as tools. Ask your assistant to draft and queue a week of posts and it does, without a browser.",
                href: "/mcp",
                link: "MCP setup",
                more: ["Claude Code guide", "/guides/claude-code-social-media"],
              },
              {
                tag: "Developers",
                title: "Build on the API",
                body: "A REST API and OAuth flow so your own product can connect a user's channels once and publish on their behalf. SDK and CLI on npm.",
                href: "/docs/public-api",
                link: "API reference",
              },
              {
                tag: "Automation",
                title: "Wire it into n8n",
                body: "A community n8n node with six operations — create, list, delete, channels, free slot, upload — so a workflow can publish without glue code.",
                href: "/integrations/n8n",
                link: "n8n node",
                more: ["OAuth for apps", "/docs/oauth"],
              },
            ].map((c: { tag: string; title: string; body: string; href: string; link: string; more?: string[] }) => (
              <div
                key={c.title}
                className="flex flex-col rounded-2xl border border-hp-border bg-white/[0.02] p-7 transition-colors hover:border-hp-primary/40"
              >
                <span className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                  {c.tag}
                </span>
                <h3 className="mt-3 text-xl font-bold font-jakarta">{c.title}</h3>
                <p className="mt-3 flex-1 text-[15px] leading-relaxed text-hp-text/60">
                  {c.body}
                </p>
                <Link
                  href={c.href}
                  prefetch={false}
                  className="mt-5 text-sm font-semibold text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text"
                >
                  {c.link} →
                </Link>
                {c.more ? (
                  <Link
                    href={c.more[1]}
                    prefetch={false}
                    className="mt-2 text-sm text-hp-text/60 underline underline-offset-2 decoration-white/20 hover:text-hp-primary-text"
                  >
                    {c.more[0]} →
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </BelowFold>

      {/* ---------------------------------------------------------- what it does */}
      <BelowFold sm={1097} lg={509}>
        <section className="border-y border-hp-border bg-white/[0.015]">
          <div className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
              Everything the posting itself needs
            </h2>

            <div className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Visual calendar", "Drag a post to move it. Set the times you publish once, and new posts drop into the next free slot."],
                ["One draft, every network", "Write once, then adjust per channel where it matters — a thread on X, a carousel on Instagram."],
                ["AI drafting", "Generate captions, hooks and hashtags per platform, inside the character limit each one enforces."],
                ["Durable scheduling", "Posts run through Temporal workflows. If a worker restarts mid-publish it resumes, rather than dropping the post or sending it twice."],
                ["Flat plans", offer("A free plan to start, then one flat price per plan instead of a fee per channel.", `${FREE_POSTS} to start, then one flat price per plan instead of a fee per channel.`)],
                usdCopy(
                  ["Indian payments", "Billing through Razorpay — UPI, NetBanking and cards, not foreign cards only."],
                  ["Dollars or rupees", "Billed in US dollars by card, or in India in rupees through Razorpay — UPI, NetBanking and cards."]
                ),
              ].map(([title, body]) => (
                <div key={title}>
                  <h3 className="text-lg font-bold font-jakarta">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-hp-text/60">{body}</p>
                  {title === "One draft, every network" ? (
                    <Link
                      href="/guides/post-to-multiple-social-media-at-once"
                      prefetch={false}
                      className="mt-2 inline-block text-sm text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40"
                    >
                      Every network&apos;s limits →
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </BelowFold>

      {/* ---------------------------------------------------------- channels */}
      <BelowFold sm={718} lg={410}>
        <section className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
            {PUBLISHABLE_CHANNEL_COUNT} networks today, including the ones others skip
          </h2>
          <p className="mt-3 max-w-[62ch] text-hp-text/60">
            Alongside the usual social networks, Hookpost publishes to developer
            and community platforms — Discord, Slack, Telegram, DEV, Hashnode,
            WordPress — that most schedulers leave out entirely.
          </p>

          <div className="mt-10 flex flex-wrap gap-2.5">
            {CHANNELS.map((c) => (
              <Link
                key={c}
                href={`/channels/${c}`}
                prefetch={false}
                className="rounded-full border border-hp-border bg-white/[0.03] px-4 py-2 text-sm capitalize text-hp-text/75 transition-colors hover:border-hp-primary/50 hover:text-hp-text"
              >
                {c === "devto" ? "DEV.to" : c === "x" ? "X" : c}
              </Link>
            ))}
            <Link
              href="/channels"
              prefetch={false}
              className="rounded-full border border-hp-primary/40 px-4 py-2 text-sm font-semibold text-hp-primary-text hover:bg-hp-primary/10"
            >
              See all channels →
            </Link>
          </div>
        </section>
      </BelowFold>

      {/* Frames the numbers below: the objection to a scheduler is rarely the
          monthly price, it is what that price does when you add channels. */}
      <BelowFold sm={1035} lg={539}>
        <PricingContrast />
      </BelowFold>

      {/* Shared with /pricing so both render one source of truth. id keeps
          the existing #pricing anchor working for in-page links. */}
      <BelowFold sm={1653} lg={1019}>
        <PricingPlans id="pricing" />
      </BelowFold>

      {/* --------------------------------------------------------------- faq */}
      {/* LandingFaq renders its own "Frequently asked questions" heading, so
          this section must not add a second one. */}
      <BelowFold sm={2312} lg={1723}>
        <section className="mx-auto w-full max-w-[1100px] px-5 py-20 sm:px-10">
          <LandingFaq />
        </section>
      </BelowFold>

      {/* ---------------------------------------------------------------- team */}
      <BelowFold sm={1011} lg={656}>
        <section className="border-t border-hp-border bg-white/[0.015]">
          <div className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
              Who builds it
            </h2>
            <p className="mt-3 max-w-[58ch] text-hp-text/60">
              Hookpost is made by Hookstep. The same team runs operations
              and engineering.
            </p>

            <div className="mt-12 grid max-w-[720px] gap-6 sm:grid-cols-2">
              {TEAM.map((person) => (
                <div
                  key={person.slug}
                  className="flex min-w-0 flex-col items-center rounded-2xl border border-hp-border bg-white/[0.02] p-7 text-center"
                >
                  <img
                    src={`/team/${person.slug}.jpg`}
                    alt={person.name}
                    width={104}
                    height={104}
                    loading="lazy"
                    className="h-26 w-26 rounded-full object-cover ring-2 ring-hp-primary/40"
                    style={{ width: 104, height: 104 }}
                  />
                  <h3 className="mt-5 font-bold font-jakarta">{person.name}</h3>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-hp-primary-text">
                    {person.role}
                  </p>
                  <p className="mt-3 text-[15px] leading-relaxed text-hp-text/60">
                    {person.bio}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-10 text-sm text-hp-text/60">
              Questions for the team?{" "}
              <Link href="/contact" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">
                support@hookstep.in
              </Link>
            </p>
          </div>
        </section>
      </BelowFold>

      {/* ------------------------------------------------------------ closing */}
      <BelowFold sm={481} lg={377}>
        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1280px] px-5 py-20 text-center sm:px-10">
            {/*
              Was "Elevate your social media planning and achieve new heights of
              efficiency and effectiveness" — which states nothing. A closing CTA
              should tell someone what happens next.
            */}
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
              Connect a channel and schedule your first post
            </h2>
            <p className="mx-auto mt-4 max-w-[52ch] text-hp-text/60">
              {offer(
                'The free tier needs no card and does not expire. Paid plans cancel in one click from the billing page.',
                `${TRIAL_SENTENCE} Plans cancel in one click from the billing page.`
              )}
            </p>
            <Link
              href="/auth"
              className="mt-8 inline-block rounded-full bg-hp-primary px-8 py-4 font-semibold text-hp-on-primary transition-opacity hover:opacity-90"
            >
              {offer('Start free', TRIAL_CTA)}
            </Link>
          </div>
        </section>
      </BelowFold>

    </div>
  );
}
