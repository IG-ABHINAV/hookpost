import React from 'react';
import { REFUND_FAQ } from './refund-terms';
import { PUBLISHABLE_CHANNEL_COUNT } from './channels/channel-count';
import { pricing, pricingINR, PURCHASABLE_TIERS } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { LANDING_TIERS, offer, TRIAL_SENTENCE } from './trial-offer';
import { planPrice, usdCopy } from './usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_AI_CREDITS_DETAIL, HOOKPOST_X_POSTS_DETAIL } from '@hookpost/frontend/app/(landing)/usd-offer';

// FAQ_DATA is module-level and also feeds the FAQPage schema in layout.tsx and
// SeoSchemas.tsx, so it cannot follow the visitor's currency. It used to quote
// rupees only - "Hookpost is priced in rupees", "Hookpost is ₹599/mo" - which a
// US visitor read under a hero that already says $15, and which every AI model
// quoting the schema repeated as if Hookpost only sold in INR. For a while it
// led with USD and gave the India price in brackets.
//
// 11 Oct 2026 (owner): rupees only again. India is the market, the rest of the
// marketing copy and the JSON-LD offers are rupee-only, and no dollar checkout
// has ever collected. Every amount is read from pricingINR. Counts (channels,
// posts, AI allowances) are identical in every currency, so `pricing` is still
// fine for those. Once dollars are sold (usd-offer.ts) the plan prices name
// both currencies, "$7/mo (₹599 in India)", through planPrice().
const inr = (n: number) => `\u20b9${n.toLocaleString('en-IN')}`;

// Plan names for a feature, read from the plans actually on sale. These answers
// used to say "Team, Pro, and Ultimate" - two of those are retired
// (PURCHASABLE_TIERS) - and "unlimited team members", while the seat cap is
// team_member_limit and organization.service.ts enforces it. LANDING_TIERS
// leaves Free out once new users have no Free plan (trial-offer.ts).
const tierName = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
const plansWith = (has: (t: (typeof PURCHASABLE_TIERS)[number]) => boolean) => {
  const names = LANDING_TIERS.filter(has).map(tierName);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names[0];
};
const AUTOPOST_PLANS = plansWith((t) => pricing[t].autoPost);
const TEAM_PLANS = plansWith((t) => pricing[t].team_members);
const SOLO_PLANS = plansWith((t) => !pricing[t].team_members);
const SOLO_PLANS_ARE =
  LANDING_TIERS.filter((t) => !pricing[t].team_members).length > 1
    ? 'are single-user plans'
    : 'is a single-user plan';
const TEAM_SEATS = Math.max(
  ...LANDING_TIERS.map((t) => pricing[t].team_member_limit)
);

export const FAQ_DATA = [
  {
    q: 'What is Hookpost?',
    a: `Hookpost is a social media management and scheduling platform from Hookstep, founded by Mohan Bhanushali. It publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks from one visual calendar, ships a native Model Context Protocol (MCP) server so Claude Code, Cursor and Windsurf can draft and queue posts directly. ${usdCopy(
      'Billing runs through Razorpay, so UPI, NetBanking and cards all work.',
      'Billing runs through Razorpay: in India UPI, NetBanking and cards all work, and elsewhere plans are billed in US dollars by card.'
    )}`,
  },
  {
    q: 'Does Hookpost support AI agents, Claude, and Model Context Protocol (MCP)?',
    // `npx hookpost` is the CLI (apps/cli), not an MCP server, so it is no
    // longer named as one. The hosted server is reached with the API key, which
    // Settings only shows on plans with public_api.
    a: `Yes. Hookpost runs a hosted MCP server that Claude Code, Claude Desktop, Cursor and Windsurf can connect to with your API key (Settings → Developers, on ${plansWith((t) => pricing[t].public_api)}). Through its tools an agent can list your connected channels, read each channel's post settings, upload media from a URL, generate images, and create, schedule or list posts. There is also a terminal CLI on npm (\`npm install -g hookpost\`).`,
  },
  {
    q: 'Does Hookpost support Indian payment methods like UPI and Razorpay?',
    a: `Yes. In India, Hookpost is billed in rupees, at ${HOOKPOST_DISPLAY_PRICE}/month, with native UPI (Google Pay, PhonePe, Paytm), NetBanking, and Indian cards processed securely via Razorpay.`,
  },
  {
    q: 'Can Hookpost auto-repeat or recycle evergreen posts?',
    a: 'Yes. Any post can be set to repeat on a schedule, so your best-performing content keeps going out without you copy-pasting it every month. Pick the post, set the cadence (for example, every 30 days), choose which channels it should hit each time, and Hookpost handles the rest. Each repost shows up in your calendar so you can still see, edit, or pause upcoming runs. ' + `On ${AUTOPOST_PLANS} you can also auto-post from an RSS feed, which is handy for turning a blog or newsletter into a steady social cadence.`,
  },
  {
    q: 'Does Hookpost have a public API and webhooks?',
    a: `Yes. The Hookpost plan includes a REST API for creating posts, uploading media, and managing integrations — useful if you want to plug Hookpost into your own tools, n8n, Zapier, or a custom dashboard. It also includes ${pricing.HOOKPOST.webhooks} webhooks. Combined with the public API, they let you trigger posts automatically from CI, a CMS, or any event source.`,
  },
  {
    q: 'What analytics does Hookpost provide?',
    a: "Hookpost shows per-channel and per-post analytics pulled from each network's official insights API. Depending on the channel, you'll see impressions, likes, comments, shares, reach, and engagement rate. Everything is in one dashboard — you can compare how the same post performed on LinkedIn vs. X vs. Instagram without opening five different apps. Analytics coverage depends on what each platform exposes publicly.",
  },
  {
    q: 'Can I cross-post the same content to multiple platforms at once?',
    a: "Yes — that's the core of Hookpost. Write a post once, pick the channels, and Hookpost publishes to all of them at the time you choose. Before scheduling, each channel gets its own preview so you can tweak copy, media, or hashtags per platform — for example, a longer LinkedIn version and a shorter X version of the same post. You can also queue the same post to re-run on an evergreen schedule.",
  },
  {
    q: 'What AI features does Hookpost include?',
    a: `Hookpost ships with a built-in AI agent that can draft posts and generate images — all from one chat window. AI text generates hooks, captions, threads and hashtags tuned per platform, and AI images generate visuals directly from a prompt. The Hookpost plan includes ${HOOKPOST_AI_CREDITS_DETAIL}. You can also chat with the agent to schedule posts end-to-end.`,
  },
  {
    q: 'Can I manage multiple brands or clients from a single Hookpost account?',
    a: "Yes. You can organize your connected accounts into customer groups, so each brand or client has its own clean workspace inside one Hookpost login. Each customer group keeps its own channels, calendar, and analytics — useful for agencies, freelancers, or anyone running several brands. Your plan's channel limit covers all groups together.",
  },
  {
    q: 'How many team members can I invite, and what can they do?',
    a: `${TEAM_PLANS} lets you invite team members by email, up to ${TEAM_SEATS} people including the account owner. ${SOLO_PLANS ? `${SOLO_PLANS} ${SOLO_PLANS_ARE}. ` : ''}Hookpost has two roles: Admin (manage channels, billing, and team settings) and Member (draft, schedule, and review posts). Everyone works from the same visual calendar, so drafts, scheduled posts, and analytics stay in one place.`,
  },
  // This answer is the FAQPage schema every AI model quotes. One plan is sold
  // (HOOKPOST, owner, 8 Nov 2026), billed monthly only: every figure is read
  // from pricing.ts and no yearly price is stated.
  {
    q: "How much does Hookpost cost, and what's included in each plan?",
    a: `${offer(
      `Hookpost has one paid plan plus a free tier, billed monthly. Free costs nothing for ${pricing.FREE.channel} channels and ${pricing.FREE.posts_per_month} posts a month.`,
      `Hookpost has one paid plan, billed monthly. ${TRIAL_SENTENCE}`
    )} Hookpost is ${planPrice('HOOKPOST', '/mo')} for ${pricing.HOOKPOST.channel} channels, ${pricing.HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts/month, up to ${pricing.HOOKPOST.team_member_limit} team members, ${HOOKPOST_AI_CREDITS_DETAIL}, ${pricing.HOOKPOST.generate_videos ? pricing.HOOKPOST.generate_videos + ' AI videos, ' : ''}the API, MCP server and CLI, and ${pricing.HOOKPOST.webhooks} webhooks. X (Twitter): ${HOOKPOST_X_POSTS_DETAIL}. There is no yearly price.`,
  },
  // The plan-change policy, worded the same way as the billing page, the
  // preview under each plan, /terms and /refund-policy
  // (razorpay.mapping.ts). This answer is FAQPage structured data, so the
  // rules an AI model quotes have to be the rules the code applies.
  {
    q: 'What happens when I upgrade or downgrade my plan?',
    a: 'An upgrade takes effect immediately, and the unused days of the month or year you have already paid for are credited against the new plan — nothing is lost, and no free days are added. A downgrade takes effect at the start of your next billing cycle: you keep the plan you paid for until its last day, then the lower price starts. Nothing is refunded for part of a period either way, and a scheduled downgrade can be called off in Billing before it takes effect.',
  },
  // refund-terms.ts, the same words as /terms and /refund-policy.
  REFUND_FAQ,
  {
    q: 'Can I swap or change my connected channels after choosing a plan?',
    a: `Yes. You are never locked into any specific set of channels. Connect, disconnect, and swap any of the ${PUBLISHABLE_CHANNEL_COUNT} supported networks at any time, as long as your total active channels stay within your plan's limit. If you downgrade and exceed the new limit, Hookpost automatically disables the most recent connections without deleting data.`,
  },
  {
    q: 'If I connect 3 Facebook pages, does that count as 1 channel or 3?',
    a: `Each connected social account, profile, or page counts as one channel slot. So three Facebook pages count as three channels. Channel allowances are: ${offer(`Free (${pricing.FREE.channel} channels) and `, '')}Hookpost (${pricing.HOOKPOST.channel} channels).`,
  },
];

export default function LandingFaq() {
  return (
    <section
      id="faq"
      className="flex flex-col lg:flex-row items-center lg:items-start gap-8 lg:gap-14 w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-12"
      aria-label="Frequently Asked Questions"
    >
      {/* Left Column: Heading */}
      <div className="flex flex-col space-y-4 items-center lg:items-start shrink-0 lg:w-[320px]">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold uppercase tracking-wider font-jakarta">
          <span>FAQ</span>
        </div>
        <h2 className="text-2xl sm:text-4xl font-extrabold text-hp-text font-jakarta text-center lg:text-left leading-tight">
          Frequently asked questions
        </h2>
        <img
          alt="Frequently asked questions underline"
          loading="lazy"
          width="228"
          height="62"
          className="scale-[0.7] sm:scale-100 origin-left"
          src="/svgs/underline-pink.svg"
        />
        <p className="text-sm text-hp-text-2 text-center lg:text-left">
          Have more questions? Read our{' '}
          <a href="/guides" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">
            engineering guides
          </a>{' '}
          or write to{' '}
          <a
            href="mailto:support@hookstep.in"
            className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text"
          >
            support@hookstep.in
          </a>
          .
        </p>
      </div>

      {/* Right Column: Accessible Details/Summary Accordion with Microdata */}
      <div className="flex-1 w-full space-y-3">
        {FAQ_DATA.map((item, idx) => (
          <details
            key={idx}
            open={idx === 0}
            itemScope
            itemProp="mainEntity"
            itemType="https://schema.org/Question"
            className="group p-5 sm:p-6 bg-hp-elevated border border-hp-border hover:border-hp-primary/40 rounded-[20px] transition-all"
          >
            <summary className="flex justify-between items-center cursor-pointer list-none select-none">
              <h3
                itemProp="name"
                className="text-base sm:text-lg font-bold font-jakarta text-hp-text pr-4 group-open:text-hp-primary-text transition-colors"
              >
                {item.q}
              </h3>
              <div className="shrink-0 w-8 h-8 rounded-full bg-white/5 group-hover:bg-hp-primary/20 flex items-center justify-center transition-colors">
                <svg
                  className="w-4 h-4 text-hp-text-2 group-open:text-hp-primary-text group-open:rotate-180 transition-transform duration-200"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </summary>
            <div
              itemScope
              itemProp="acceptedAnswer"
              itemType="https://schema.org/Answer"
              className="text-left text-sm sm:text-base leading-relaxed text-hp-text-2 pt-3 mt-3 border-t border-hp-border font-normal"
            >
              <div itemProp="text" className="whitespace-pre-line">
                {item.a}
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
