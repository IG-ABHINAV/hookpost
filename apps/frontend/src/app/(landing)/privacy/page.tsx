import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../social-meta';
import { MEDIA_RETENTION_POLICY } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

export const metadata: Metadata = withSocial({
  title: 'Privacy Policy | Hookpost & JR Consulting Co.',
  description: 'Hookpost Privacy Policy. Understand how JR Consulting Co. collects, protects, and handles personal data and connected social media tokens.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/privacy',
  },
});

export default function PrivacyPolicyPage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Privacy Policy", item: "https://hookpost.hookstep.in/privacy" },
    ],
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      
      {/* Top Banner */}
      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        Hookpost — Unified Social Media Scheduling, Publishing &amp; Analytics Platform
      </div>

      {/* Navigation Header */}
      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/auth/login"
            className="text-sm font-medium text-hp-text hover:text-hp-primary-text transition-colors px-3 sm:px-4 py-2 whitespace-nowrap border border-hp-border-strong rounded-full hover:border-hp-primary"
          >
            Log In
          </Link>
          <Link
            href="/auth"
            className="text-sm font-medium bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary transition-all px-4 sm:px-5 py-2 rounded-full font-semibold whitespace-nowrap"
          >
            Get Started
          </Link>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="pt-12 sm:pt-16 pb-24 sm:pb-32">
        <div className="max-w-[840px] mx-auto px-5 sm:px-8 text-hp-text-2 text-[17px] sm:text-[18px] leading-[1.8] space-y-8">
          
          {/* Header Title */}
          <div className="text-center space-y-4 mb-12">
            <h1 className="text-[38px] sm:text-[64px] font-black text-hp-text tracking-tight leading-[1.15]">
              Privacy Policy
            </h1>
            <p className="text-hp-text-3 text-base italic">Last updated: November 1, 2026</p>
          </div>

          <p>
            This Privacy Policy explains how <strong>Hookpost</strong> (&quot;Hookpost&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;), operated by <strong>JR Consulting Co.</strong>, collects, uses, shares, and protects personal data in connection with the Hookpost social-media scheduling, publishing, analytics, and team-collaboration platform (the &quot;Service&quot;), the website at <a href="https://hookpost.hookstep.in" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">hookpost.hookstep.in</a> and related sub-domains (the &quot;Site&quot;). It applies to visitors to the Site, account holders, members of customer workspaces, and anyone else who interacts with us. By using the Site or the Service, you acknowledge this Policy. For our contractual terms, see our <Link href="/terms" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Terms of Service</Link>.
          </p>

          {/* 1. Who We Are */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              1. Who We Are (Data Controllers)
            </h2>
            <p>
              Hookpost is owned and operated by <strong>JR Consulting Co.</strong> JR Consulting Co. is the contracting party for paid subscriptions, the recipient of subscription revenue, and the primary data controller for account, billing, customer-support, marketing, and Service-usage data.
            </p>
            <p>
              JR Consulting Co. also holds the developer accounts, OAuth integrations, and platform-side approvals with third-party social media platforms whose APIs the Service uses (including X / Twitter, Meta / Facebook / Instagram / Threads, LinkedIn, YouTube, TikTok, Pinterest, Bluesky, Discord, Slack, Telegram, and GitHub).
            </p>
            <p>
              For all privacy questions, requests, and data inquiries, you can reach us at <a href="mailto:support@hookstep.in" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text font-medium">support@hookstep.in</a>.
            </p>
          </section>

          {/* 2. The Service in Brief */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              2. The Service in Brief
            </h2>
            <p>
              Hookpost lets you connect multiple social-media and chat channels to centrally schedule, publish, analyze, and collaborate on content. The platform includes a visual content calendar, media storage engine, publishing queue, analytics dashboards, AI-assisted content optimization, team permissions, and third-party integrations.
            </p>
          </section>

          {/* 3. The Data We Collect */}
          <section className="space-y-5">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              3. The Data We Collect
            </h2>

            <div className="space-y-3">
              <h3 className="text-[20px] font-semibold text-hp-text">3.1 Account &amp; Identity Data</h3>
              <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
                <li>Name, email address, password (stored solely as a cryptographically salted one-way hash), profile picture, workspace name, role, language, and timezone preferences.</li>
                <li>If you sign in via a social-login provider (e.g., Google or GitHub), the basic profile fields and email address returned by that provider.</li>
                <li>Workspace membership, invitations sent/accepted, and permissions granted within an organization.</li>
              </ul>
            </div>

            <div className="space-y-3">
              <h3 className="text-[20px] font-semibold text-hp-text">3.2 Connected Platform Data</h3>
              <p>When you connect a third-party social or messaging account to Hookpost, we receive and store via authorized APIs:</p>
              <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
                <li>OAuth access &amp; refresh tokens (kept in our access-controlled main database, which our database provider encrypts at rest with AES-256), the scopes granted, platform username, user IDs, page IDs, channel IDs, and profile avatars.</li>
                <li>Content and engagement data needed to provide the Service: scheduled posts, published posts, comments, post-level analytics (impressions, reach, clicks, engagement metrics), and aggregate audience data exposed by platform APIs.</li>
                <li>
                  <strong>For YouTube specifically:</strong> The Service uses YouTube API Services. Your use of those features is subject to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">YouTube Terms of Service</a> and the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Google Privacy Policy</a>. You can revoke Hookpost&apos;s access to your Google data at any time via <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noopener noreferrer" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Google Security Settings</a>.
                </li>
                <li>
                  <strong>For Pinterest specifically:</strong> We access your Pinterest user boards and profile solely to create Pins on your behalf in compliance with Pinterest Developer Policies.
                </li>
                <li>
                  <strong>For Skool, through the Hookpost Chrome extension:</strong> Skool has no posting API, so a Skool channel connects through our Chrome extension. When you connect Skool, the extension reads two Skool sign-in cookies (<code>client_id</code> and <code>auth_token</code>) from your browser and hands them to the Hookpost app, which sends them to our servers. We store them encrypted (AES-256) and use them only to read your Skool profile and groups and to publish the posts you schedule there. Once a day the extension sends the current values of those two cookies to Hookpost so the channel stays connected. The extension reads no other cookies, no browsing history and no page content, answers only hookpost.hookstep.in, and sends data only to Hookpost. Removing the Skool channel in Hookpost, or uninstalling the extension, stops the daily update. We never sell this data or use it for anything else.
                </li>
                <li>
                  <strong>For TikTok specifically:</strong> You connect TikTok by signing in with TikTok (TikTok Login Kit) and approving the permissions Hookpost requests. With your permission:
                  <ul className="list-[circle] pl-6 mt-2 space-y-1.5">
                    <li>We read your basic profile (avatar, display name, and open ID), your username, your profile stats (followers, following, likes, and video count), and your recent public videos (ID, cover image, and title) with their view, like, comment, and share counts. We use this to show your account and analytics inside Hookpost. If you use Hookpost&apos;s AI assistant, your request and the names and usernames of your connected channels (including TikTok) are sent to our AI provider (OpenAI) so it can carry out the request.</li>
                    <li>We post to TikTok, or upload to your TikTok inbox as a draft, only content you create in Hookpost and choose to publish. Before you post, we read your TikTok posting settings (who can see your videos, which interactions are allowed, and your maximum video length) so the post screen matches what TikTok allows.</li>
                    <li>Your TikTok access and refresh tokens are stored in our database and used only for the features above. We never sell them or your TikTok data.</li>
                    <li>You can remove the TikTok channel in Hookpost at any time. We then stop using it (no more posts, data reads, or token refreshes) and delete its tokens from our database by overwriting them with a one-way hash. Copies held by our job scheduler and in our database backups expire on a rolling schedule, normally within 30 days, except where we must keep them longer to investigate a security incident or meet a legal obligation. Your TikTok username, display name, avatar, and open ID may stay with the removed connection until your Hookpost workspace is deleted; you can ask us to erase them sooner at <a href="mailto:support@hookstep.in" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">support@hookstep.in</a>. You can also revoke Hookpost&apos;s access at any time in your TikTok app settings.</li>
                  </ul>
                </li>
              </ul>
            </div>

            <div className="space-y-3">
              <h3 className="text-[20px] font-semibold text-hp-text">3.3 Content You Upload</h3>
              <p>Text, images, video, audio, captions, links, hashtags, schedules, prompts, notes, and calendar metadata you upload to or generate within the Service.</p>
            </div>

            <div className="space-y-3">
              <h3 className="text-[20px] font-semibold text-hp-text">3.4 Billing Data</h3>
              <p>Plan tier, subscription status, invoice history, billing email, and transaction IDs. Card numbers and banking details are processed directly by our PCI-compliant payment gateways (including Razorpay); Hookpost never stores your raw card credentials.</p>
            </div>

            <div className="space-y-3">
              <h3 className="text-[20px] font-semibold text-hp-text">3.5 Logs, Usage &amp; Device Data</h3>
              <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
                <li>IP address, browser user-agent, operating system, referrer URL, and approximate geographic location derived from IP. We keep the country, region and city of your first sign-in, as our network provider (Cloudflare) reports them, to understand which regions our customers come from.</li>
                <li>Application telemetry: pages visited, features used, post dispatch logs, error reports, and performance metrics.</li>
              </ul>
            </div>
          </section>

          {/* 4. How We Use Data */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              4. How We Use the Data &amp; Legal Bases
            </h2>
            <ul className="list-disc pl-6 space-y-2 text-hp-text-2">
              <li><strong>Provide the Service:</strong> Authenticate users, manage workspaces, store media, publish content across connected social channels, and generate analytics dashboards. (<em>Performance of contract</em>)</li>
              <li><strong>Billing &amp; Subscriptions:</strong> Process subscriptions, issue invoices, prevent payment fraud, and fulfill tax requirements. (<em>Performance of contract; legal obligation</em>)</li>
              <li><strong>Security &amp; Abuse Prevention:</strong> Detect and mitigate unauthorized account access, DDoS attacks, spamming, and platform policy violations. (<em>Legitimate interests</em>)</li>
              <li><strong>Improve the Service:</strong> Debug issues, monitor uptime, and optimize application performance. (<em>Legitimate interests</em>)</li>
              <li><strong>Transactional Communications:</strong> Send critical notifications regarding failed posts, security alerts, and account changes. (<em>Performance of contract</em>)</li>
            </ul>
            <p className="text-hp-text-2 text-sm">We do not use your private posts or messages to serve third-party advertising, and we do not sell your personal data.</p>
          </section>

          {/* 5. AI Features */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              5. AI-Assisted Features
            </h2>
            <p>
              The Service offers optional AI tools to generate or refine captions, hashtags, and copywriting. Prompts and drafted text are transmitted securely to sub-processor model providers (such as OpenAI). We enforce contractual terms requiring that your data is <strong>not used to train</strong> public foundation models. AI outputs are probabilistic; you remain responsible for reviewing content before publishing.
            </p>
          </section>

          {/* 6. Controller vs Processor */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              6. Controller vs. Processor
            </h2>
            <p>
              For account, billing, site telemetry, and security data, Hookpost acts as a <strong>data controller</strong>. For the content you schedule and the audience metrics fetched on your behalf, Hookpost acts as a <strong>data processor</strong> operating under your instructions.
            </p>
          </section>

          {/* 7. Who We Share Data With */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              7. Who We Share Data With
            </h2>
            <p>We do not sell personal data. We share data only with:</p>
            <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
              <li><strong>Connected Third-Party Platforms:</strong> Transmitting scheduled posts and media to the platforms you choose (Pinterest, YouTube, TikTok, Meta, X, LinkedIn, etc.).</li>
              <li><strong>Infrastructure &amp; Hosting Sub-processors:</strong> Contabo and Google Cloud (servers), Neon (PostgreSQL database), Upstash (Redis), Cloudflare (media storage and content delivery), and Resend (transactional email).</li>
              <li>
                <strong>Service Providers:</strong>
                <ul className="list-[circle] pl-6 mt-2 space-y-1.5">
                  <li><strong>OpenAI:</strong> AI writing and the AI assistant.</li>
                  <li><strong>Razorpay:</strong> payments.</li>
                  <li><strong>Google:</strong> Sign-In, Tag Manager and Google Ads conversion measurement. The Google tag on our pages has Google&apos;s automatic user-provided data detection switched on: when it measures an ad conversion it looks for an email address, phone number or postal address on the page, hashes what it finds and sends the hash to Google. In practice that is the email address you type into our sign-in or sign-up form, because our pages have no phone or address fields.</li>
                  <li><strong>Meta:</strong> Pixel and Conversions API for ad measurement (IP address, browser data, click IDs, and hashed email).</li>
                  <li><strong>Dub:</strong> partner referral tracking. Dub&apos;s script runs on our app and sign-in pages. When you arrive through a partner link (one with ?via= in the address), it sends that link, the page address and the page you came from to Dub, which returns a click ID that is kept in a cookie in your browser.</li>
                  <li><strong>Plausible:</strong> website analytics.</li>
                  <li><strong>Cloudflare Web Analytics:</strong> page views and page-load performance on hookpost.hookstep.in, measured by Cloudflare&apos;s script on our pages.</li>
                </ul>
              </li>
              <li><strong>Workspace Collaborators:</strong> Team members assigned to your Hookpost organization based on their designated roles.</li>
              <li><strong>Legal Authorities:</strong> When required by valid legal process, court order, or regulatory mandate.</li>
            </ul>
          </section>

          {/* 8. Data Retention */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              8. Data Retention
            </h2>
            <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
              <li><strong>Account &amp; Workspace Data:</strong> Retained while your account is active. When you delete your account, at once: you are signed out, your sign-in details are overwritten with one-way hashes, every API key, app connection and channel token of the workspaces you own stops working and is erased, and scheduled posts are cancelled. The rest of the account&apos;s data is hidden from every screen at once and purged or anonymised 30 days after deletion, except billing records (below) and a one-way fingerprint of each connected channel, kept so the same channel cannot start a second free trial. What is erased and what is kept is listed on our <Link href="/data-deletion" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Data Deletion</Link> page.</li>
              <li><strong>OAuth Tokens:</strong> Retained while connected. Removing a channel immediately deletes its access tokens and other connection credentials from our database by overwriting them with a one-way hash. Copies held by our job scheduler and in our database backups expire on a rolling schedule, normally within 30 days, except where we must keep them longer to investigate a security incident or meet a legal obligation.</li>
              <li><strong>Scheduled Content:</strong> Retained until published or manually deleted by the user.</li>
              <li><strong>Media Files:</strong> Videos you attach to a post are deleted from our storage 7 days after the post is published, because the social network already hosts the published copy. The post&apos;s text, publish date, thumbnail and link to the live post stay in your Hookpost history. Images are kept while your account is active (see Workspaces Without a Plan below) and deleted from our storage 30 days after you delete your account. Download any video you want to keep before then.</li>
              {/* MEDIA_RETENTION_POLICY (trial.policy.ts): the rule MediaRetentionService carries out. */}
              <li><strong>Workspaces Without a Plan:</strong> {MEDIA_RETENTION_POLICY}</li>
              <li><strong>Billing Invoices:</strong> Retained as required under statutory financial and taxation regulations.</li>
            </ul>
          </section>

          {/* 9. Security */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              9. Security
            </h2>
            <p>
              We implement comprehensive technical and organizational measures: TLS 1.3 encryption in transit, AES-256 encryption at rest for our main database (applied by our database provider), cryptographic password hashing, isolated database networks, and automated intrusion monitoring.
            </p>
          </section>

          {/* 10. Your Rights (GDPR / CCPA / DPDP Act India) */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              10. Your Rights (GDPR / CCPA / India DPDP Act 2023)
            </h2>
            <p>Depending on your jurisdiction, you have statutory rights concerning your personal data:</p>
            <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
              <li><strong>GDPR (Europe) &amp; CCPA (California):</strong> Right to access, rectify, or erase personal data, object to or restrict processing, data portability, and non-discrimination.</li>
              <li><strong>Digital Personal Data Protection Act, 2023 (India):</strong> As an Indian enterprise operated by JR Consulting Co., we recognize your rights as a Data Principal under the DPDP Act 2023, including the right to access summaries of personal data processed, the right to correction and erasure, the right of grievance redressal, and the right to nominate an individual in the event of death or incapacity.</li>
            </ul>
            <p>To exercise any of these rights, email our Data Privacy team at <a href="mailto:support@hookstep.in" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text font-medium">support@hookstep.in</a>. Requests are addressed within statutory timelines (and no later than 30 days).</p>
          </section>

          {/* 11. Contact Us */}
          <section className="space-y-4">
            <h2 className="text-[24px] sm:text-[28px] font-bold text-hp-text tracking-tight pt-4">
              11. Contact Us
            </h2>
            <p>For questions or privacy requests, contact:</p>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 text-sm space-y-1 text-hp-text-2">
              <p className="font-bold text-hp-text text-base">JR Consulting Co. (Hookpost)</p>
              <p>Email: <a href="mailto:support@hookstep.in" className="text-hp-primary-text">support@hookstep.in</a></p>
              <p>Website: <a href="https://hookpost.hookstep.in" className="text-hp-primary-text">https://hookpost.hookstep.in</a></p>
            </div>
          </section>

        </div>
      </div>

      {/* Footer CTA */}
      <div className="w-full bg-hp-elevated border-t border-hp-border py-12 px-6 text-center space-y-4">
        <h3 className="text-2xl sm:text-3xl font-bold text-hp-text">Ready to grow your social media presence?</h3>
        <p className="text-hp-text-3 max-w-md mx-auto">Schedule, analyze, and manage all your accounts from one dashboard.</p>
        <Link
          href="/auth"
          className="inline-block bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary font-bold text-sm px-8 py-3 rounded-full transition-all"
        >
          Start with Hookpost
        </Link>
        <div className="pt-8 text-xs text-hp-text-3">
          &copy; 2026 JR Consulting Co. / Hookpost. All rights reserved. &bull; <Link href="/terms" className="hover:underline text-hp-text-3">Terms of Service</Link>
        </div>
      </div>

    </div>
  );
}
