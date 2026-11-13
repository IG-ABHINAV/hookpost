import React from 'react';
import { PUBLISHABLE_CHANNEL_COUNT } from './channels/channel-count';
import { FREE_POSTS, offer } from './trial-offer';
import { planPrice, usdCopy } from './usd-offer';

// No currency prop: this HTML is edge-cached for every visitor, so the price
// line names both currencies instead of following one visitor's country.
export default function AeoAnswerCapsule() {
  return (
    <section
      id="aeo-overview"
      className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-12 text-left"
      aria-label="Hookpost Overview and Specifications"
    >
      <div className="relative overflow-hidden rounded-[28px] bg-gradient-to-b from-hp-elevated via-hp-surface to-hp-bg border border-hp-border p-6 sm:p-10 shadow-2xl">
        {/* Subtle accent glow */}
        <div className="absolute top-0 right-0 -mr-24 -mt-24 w-80 h-80 bg-hp-primary/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 -ml-24 -mb-24 w-80 h-80 bg-hp-primary/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 space-y-8">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-bold uppercase tracking-wider font-jakarta">
            <span>⚡</span>
            <span>Hookpost at a glance</span>
          </div>

          {/* High-Citability Answer Block */}
          <div className="space-y-3">
            <h2 className="text-2xl sm:text-4xl font-extrabold text-hp-text font-jakarta tracking-tight">
              What is Hookpost?
            </h2>
            <p className="text-base sm:text-lg leading-relaxed text-hp-text max-w-4xl font-normal">
              <strong className="text-hp-text font-semibold">
                Hookpost is an AI social media scheduler made by Hookstep (Ghatkopar, Mumbai) and founded by Mohan Bhanushali.
              </strong>{' '}
              It enables creators, marketing agencies, and software developers to plan, automate, and cross-publish content across {PUBLISHABLE_CHANNEL_COUNT} networks today, including Instagram Reels, Meta Threads, TikTok, Facebook Pages, X, LinkedIn, YouTube Shorts, Bluesky, Telegram and Discord, via a visual calendar, REST API, CLI, and native Model Context Protocol (MCP) server.
            </p>
          </div>

          {/* 4-Box Key Specifications Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
            <div className="p-4 rounded-[18px] bg-white/[0.03] border border-hp-border hover:border-hp-primary/40 transition-all">
              <div className="text-hp-primary-text font-semibold text-xs tracking-wider uppercase mb-1">
                Architecture
              </div>
              <div className="text-hp-text font-bold text-sm mb-1 font-jakarta">
                Temporal-backed scheduling
              </div>
              <p className="text-xs text-hp-text-2 leading-normal">
                NestJS, Next.js 16, Temporal.io workflow engine. Every post runs as a durable workflow.
              </p>
            </div>

            <div className="p-4 rounded-[18px] bg-white/[0.03] border border-hp-border hover:border-hp-primary/40 transition-all">
              <div className="text-hp-primary-text font-semibold text-xs tracking-wider uppercase mb-1">
                AI & Agentic Protocols
              </div>
              <div className="text-hp-text font-bold text-sm mb-1 font-jakarta">
                Native MCP Server & CLI
              </div>
              <p className="text-xs text-hp-text-2 leading-normal">
                Direct integration with Claude Desktop, Claude Code, Cursor, Windsurf, OpenClaw, and n8n nodes.
              </p>
            </div>

            <div className="p-4 rounded-[18px] bg-white/[0.03] border border-hp-border hover:border-hp-primary/40 transition-all">
              <div className="text-hp-primary-text font-semibold text-xs tracking-wider uppercase mb-1">
                Network Coverage
              </div>
              <div className="text-hp-text font-bold text-sm mb-1 font-jakarta">
                {PUBLISHABLE_CHANNEL_COUNT} Supported Channels
              </div>
              <p className="text-xs text-hp-text-2 leading-normal">
                Instagram Reels/Carousels, YouTube Shorts, LinkedIn, X, Facebook, Threads, TikTok, Bluesky, Pinterest.
              </p>
            </div>

            <div className="p-4 rounded-[18px] bg-white/[0.03] border border-hp-border hover:border-hp-primary/40 transition-all">
              <div className="text-hp-primary-text font-semibold text-xs tracking-wider uppercase mb-1">
                Pricing & Payments
              </div>
              <div className="text-hp-text font-bold text-sm mb-1 font-jakarta">
                {/* Rupees only while that is all that is sold (owner, 11 Oct 2026), both once dollars are
                    (usd-offer.ts). This HTML is edge-cached for every visitor, so it is not geo-picked. */}
                {offer('Free Tier & ', `${FREE_POSTS}, then `)}from {planPrice('HOOKPOST', ' a month')}
              </div>
              <p className="text-xs text-hp-text-2 leading-normal">
                {usdCopy(
                  'Transparent flat pricing in rupees. Razorpay (UPI Autopay, NetBanking, debit and credit cards).',
                  'Transparent flat pricing: US dollars by card, or in India rupees through Razorpay (UPI Autopay, NetBanking, debit and credit cards).'
                )}
              </p>
            </div>
          </div>


        </div>
      </div>
    </section>
  );
}
