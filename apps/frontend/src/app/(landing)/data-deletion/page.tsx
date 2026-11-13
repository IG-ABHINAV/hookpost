import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../social-meta';

export const metadata: Metadata = withSocial({
  title: 'Data Deletion Instructions | Hookpost',
  description: 'Delete your Hookpost account and data from the app or by email. What is deleted, what is kept and for how long, and how to remove Hookpost from Facebook.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/data-deletion',
  },
});

// Written from the deletion code, not from the policy: UsersController.deleteAccount
// (Razorpay, best effort), UsersService.deleteAccount (workspaces, Temporal
// workflows, affiliate code), OrganizationRepository.deleteOrganization (API key,
// approved apps, developer app, stored keys, auto-posts),
// IntegrationRepository.deleteIntegrationsForAccount (channels, posts),
// UsersRepository.deleteAccount (the user row), MetaCallbacksController (the
// Facebook callback) and AccountPurgeService (what is erased after 30 days, once
// ACCOUNT_PURGE_ENABLED is on). If that code changes, change the lists below.
// The in-app path is Settings -> Global Settings -> Delete Account
// (settings/global.settings.tsx, settings/delete-account.component.tsx).
//
// Nothing here may point at the repository or name the legal entity: the
// operator's name belongs on the privacy policy and terms only.
const SUPPORT_EMAIL = 'support@hookstep.in';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=in.hookstep.hookpost.twa';

export default function DataDeletionPage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Data Deletion", item: "https://hookpost.hookstep.in/data-deletion" },
    ],
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
      </header>

      <div className="pt-12 sm:pt-16 pb-24 sm:pb-32">
        <div className="max-w-[840px] mx-auto px-5 sm:px-8 text-hp-text-2 text-[17px] sm:text-[18px] leading-[1.8] space-y-6">
          <h1 className="text-[36px] sm:text-[54px] font-black text-hp-text tracking-tight leading-[1.15]">
            User Data Deletion Instructions
          </h1>
          <p className="text-hp-text-3 text-base italic">Last updated: October 11, 2026</p>

          <p>
            <strong className="text-hp-text">Hookpost</strong> is an AI social media scheduler made by <strong className="text-hp-text">Hookstep</strong>. It runs on the web at <a href="https://hookpost.hookstep.in" className="text-hp-primary-text">hookpost.hookstep.in</a> and as the <a href={PLAY_URL} className="text-hp-primary-text">Hookpost Android app on Google Play</a> (<code className="text-[15px]">in.hookstep.hookpost.twa</code>). The app opens the same account as the website, so the steps below are the same in both.
          </p>
          <p>
            This page explains how to delete your account and the data in it, what we delete, what we keep and for how long, and how to remove Hookpost from your Facebook, Instagram or Threads account. For everything else we hold about you, see our <Link href="/privacy" className="text-hp-primary-text">Privacy Policy</Link>.
          </p>

          <h2 id="delete-account" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            Delete your account
          </h2>

          <div className="space-y-4">
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-2">
              <h3 className="text-lg font-bold text-hp-text">In the Hookpost app or on the website</h3>
              <p className="text-sm text-hp-text-2">
                1. Sign in to Hookpost.<br/>
                2. Open <strong>Settings</strong>, then the <strong>Global Settings</strong> tab.<br/>
                3. Press <strong>Delete Account</strong>.<br/>
                4. Confirm with <strong>Yes, delete my account</strong>.
              </p>
              <p className="text-sm text-hp-text-2">
                Deletion happens at once and cannot be undone, and you are signed out when it finishes. If you own a workspace that has other members, remove them first under <strong>Settings &rarr; Teams</strong>: Hookpost will not delete a workspace while other people are in it.
              </p>
            </div>

            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-2">
              <h3 className="text-lg font-bold text-hp-text">Without the app: by email</h3>
              <p className="text-sm text-hp-text-2">
                If you cannot sign in, or you have uninstalled the app, email <a href={`mailto:${SUPPORT_EMAIL}`} className="text-hp-primary-text">{SUPPORT_EMAIL}</a> from the address on your account with the subject <strong>&quot;Delete my account&quot;</strong>, and say whether you sign in with email and password, Google or another provider. We check that the request comes from the account owner, delete the account and its data as described below, and confirm by email, no later than 30 days after your request.
              </p>
            </div>
          </div>

          <h2 id="what-is-deleted" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            What happens at once
          </h2>
          <p>All of this happens as soon as you confirm in the app (or when we act on your email):</p>
          <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
            <li><strong>Your sign-in.</strong> You are signed out everywhere. Your password, your sessions and the API key of every workspace you own stop working.</li>
            <li><strong>Your profile.</strong> Your email address, name and sign-in ID from Google or another provider are replaced with one-way hashes. Your password and bio are erased, and your profile picture is unlinked from the account. The IP address and browser details we saved at sign-up, and your sign-up country, region and city, are erased.</li>
            <li><strong>Apps you approved.</strong> Access you gave to other apps under <strong>Settings &rarr; Approved Apps</strong>, for example an AI assistant connected over MCP, is revoked and its tokens are erased. So is access given to apps inside a workspace you own, and a developer app that workspace created stops working for everyone who connected it.</li>
            <li><strong>Your connected channels.</strong> For every workspace you own, the access and refresh tokens of each connected channel, and the channel&apos;s name, username and IDs, are overwritten with one-way hashes, and its profile picture link is removed. Hookpost can no longer read from or post to those accounts. API keys you saved for other services (for example an AI video provider) are overwritten too.</li>
            <li><strong>Your workspaces and posts.</strong> The workspaces you own are marked deleted and disappear from the app, and so does every post in them, whether scheduled, draft or already published. Nothing more is published: scheduled and recurring posts, RSS auto-posts and channel token refreshes are cancelled. For a workspace you only joined, you are removed as a member; comments you wrote there stay with that workspace.</li>
            <li><strong>Your paid plan.</strong> Before anything is deleted, we ask our payment provider, Razorpay, to cancel your subscription at once, not at the end of the billing period. The deletion goes ahead even if Razorpay does not confirm, so if you pay through UPI Autopay or a card mandate, check that the mandate is gone in your UPI or banking app, and write to <a href={`mailto:${SUPPORT_EMAIL}`} className="text-hp-primary-text">{SUPPORT_EMAIL}</a> if another charge arrives.</li>
            <li><strong>Affiliate programme.</strong> If you joined it, your referral code stops working: it no longer credits you and no longer gives anyone a discount.</li>
          </ul>

          <h2 id="what-we-keep" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            What is erased after 30 days, and what we keep
          </h2>
          <p>
            Everything else is hidden from every screen at once and erased for good 30 days after you delete your account, by a purge that runs every night. To have it erased sooner, email <a href={`mailto:${SUPPORT_EMAIL}`} className="text-hp-primary-text">{SUPPORT_EMAIL}</a>.
          </p>
          <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
            <li><strong>Erased after 30 days.</strong> Post text, titles and descriptions, links to published posts, comments, tags, signatures, saved sets, webhooks, auto-post settings, notifications, AI assistant conversations, and what is left of each channel (its name, picture and settings).</li>
            <li><strong>Uploaded images and videos.</strong> The files are deleted from our storage with the rest, 30 days after you delete your account, and their links on media.hookstep.in stop working then. Until that happens, anyone who has a file&apos;s link can still open it. Videos attached to a published post are erased 7 days after it was published, as for every account.</li>
          </ul>
          <p>What we keep after that:</p>
          <ul className="list-disc pl-6 space-y-1.5 text-hp-text-2">
            <li><strong>A placeholder account record.</strong> The account&apos;s internal ID, when it was created and last used, how you signed in (for example Google), your time zone and notification settings. After the purge it holds no name, email address, sign-in ID or location, not even as a hash.</li>
            <li><strong>Billing records.</strong> Payment and invoice records at Razorpay, kept for as long as Indian tax and accounting rules require (see section 8 of the Privacy Policy). The workspace record stays, renamed and with nothing else in it, with its plan and Razorpay customer ID, so those payments can be matched to it. We never hold your card number.</li>
            <li><strong>A fingerprint of each connected channel.</strong> A one-way hash of the channel&apos;s ID on its platform, with no name, picture, token or post, so the same channel cannot start a second free trial.</li>
            <li><strong>Affiliate programme.</strong> If you earned commissions: your name, email, referral code and commission history, kept with our payout and tax records; payout details are erased unless a commission is still owed to you. If you never earned one, only the referral code is kept; your name, email and payout details are erased.</li>
            <li><strong>Support messages.</strong> What you sent through the contact form or to {SUPPORT_EMAIL}, our replies, and the IP address and browser details sent with the form. Kept as a support record until you ask us to erase it.</li>
            <li><strong>Comments in other people&apos;s workspaces.</strong> Comments you wrote in a workspace you did not own stay with that workspace, without your name.</li>
            <li><strong>Backups.</strong> Copies in our database backups and job scheduler expire on a rolling schedule, normally within 30 days.</li>
            <li><strong>Legal and security.</strong> Anything we must keep to meet a legal obligation or to investigate a security incident, for as long as that lasts.</li>
          </ul>
          <p>
            Some copies are not ours to delete. Posts already published stay on the networks you published them to: delete them there, as Hookpost cannot edit or remove a live post. For advertising measurement, Meta and Google receive events from our sites (IP address, browser data and click IDs), as listed in section 7 of our <Link href="/privacy" className="text-hp-primary-text">Privacy Policy</Link>. Meta also receives a one-way hash of your email address with events from your signed-in account, such as signing up or paying; Google does not receive your email address. Meta and Google have their own tools to delete what they hold.
          </p>

          <h2 id="some-data" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            Delete some data without deleting your account
          </h2>

          <div className="space-y-4">
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-2">
              <h3 className="text-lg font-bold text-hp-text">A connected channel</h3>
              <p className="text-sm text-hp-text-2">
                1. Open <strong>Calendar</strong> and find the channel in the <strong>Channels</strong> list.<br/>
                2. Open the menu next to the channel (three dots) and choose <strong>Delete</strong>.<br/>
                3. Confirm with <strong>Delete Channel</strong>.
              </p>
              <p className="text-sm text-hp-text-2">
                The channel&apos;s posts are removed from your calendar and its access tokens are overwritten with a one-way hash at once, so Hookpost can no longer reach that account. The channel&apos;s name, username, profile picture link and platform ID stay on the removed channel until you delete your account (then they are overwritten as above) or ask us to erase them sooner.
              </p>
            </div>

            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-2">
              <h3 className="text-lg font-bold text-hp-text">Posts, media and emails</h3>
              <p className="text-sm text-hp-text-2">
                To delete a post, use <strong>Delete Post</strong> in the calendar or the post editor. To delete a file, use the <strong>Media</strong> library. Either one disappears from the app at once, and the text or file is erased from our servers on request, as described above. Email notifications can be switched off under <strong>Settings &rarr; Global Settings</strong>.
              </p>
            </div>
          </div>

          <h2 id="facebook" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            Remove Hookpost from Facebook, Instagram or Threads
          </h2>

          <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-2">
            <h3 className="text-lg font-bold text-hp-text">From your Facebook settings</h3>
            <p className="text-sm text-hp-text-2">
              1. Go to your Facebook profile &rarr; <strong>Settings &amp; Privacy &rarr; Settings &rarr; Apps and Websites</strong>.<br/>
              2. Find <strong>Hookpost</strong> and click <strong>Remove</strong>.<br/>
              3. Confirm, and send the data deletion request if Facebook offers it.
            </p>
            <p className="text-sm text-hp-text-2">
              Facebook then tells our server automatically which account removed Hookpost. We remove every Facebook Page, Instagram account and Threads profile that was connected through that Meta login, including every Page picked in the same sign-in: their scheduled posts are cancelled, their access tokens are overwritten with a one-way hash, and the names, usernames, picture links and IDs Meta gave us for them are overwritten too. By the time Facebook shows you a confirmation code, those channels have been removed. If you reached this page from that confirmation, there is nothing more to do. This does not delete your Hookpost account or your channels on other networks: to do that, follow the steps above.
            </p>
          </div>

          <h2 id="contact" className="text-[22px] sm:text-[26px] font-bold text-hp-text tracking-tight pt-4">
            Questions
          </h2>
          <p>
            Write to <a href={`mailto:${SUPPORT_EMAIL}`} className="text-hp-primary-text">{SUPPORT_EMAIL}</a>. Our <Link href="/privacy" className="text-hp-primary-text">Privacy Policy</Link> and <Link href="/terms" className="text-hp-primary-text">Terms of Service</Link> cover the rest.
          </p>
        </div>
      </div>

    </div>
  );
}
