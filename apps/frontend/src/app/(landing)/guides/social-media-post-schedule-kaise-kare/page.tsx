import { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer } from '../../trial-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// Hinglish guide for "social media post schedule kaise kare" and the
// per-platform variants (instagram / facebook / youtube / linkedin post
// schedule kaise kare). One page with a section per platform, not one page per
// platform: the intent is the same and separate pages would be doorways.
//
// The Hindi pages ranking for this on 11 Oct 2026 were out of date (one still
// describes Facebook Creator Studio, one says Instagram has no scheduler).
//
// Native steps and limits, and where each was checked on 11 Oct 2026:
// - LinkedIn: linkedin.com/help/linkedin/answer/a1347212 (clock icon, 10 min to
//   3 months ahead, "View all scheduled posts") and answer/a548192 for Pages
//   (1 hour to 3 months; no polls, multiple photos, reshares on a Page).
// - YouTube: support.google.com/youtube/answer/1270709 (Create > Upload >
//   Schedule card > date, time, time zone; private until then; a Community
//   Guidelines strike holds scheduled videos).
// - Threads: native scheduling from the composer's ... menu, rolled out to all
//   users in January 2025 (Social Media Today / Business Today reports);
//   replies cannot be scheduled.
// - Facebook: Meta announced in January 2023 that Creator Studio was being
//   replaced by Meta Business Suite.
// - Instagram and X: no official help page could be fetched, and reports
//   disagree (Instagram: which account types, how far ahead; X: whether
//   scheduling now needs Premium). The page gives the steps and says plainly
//   where the option may not appear, with no day counts. The X note no longer
//   repeats the "Premium only" reports: on 11 Oct the third-party guides still
//   disagreed and help.x.com had no page saying so, so there was nothing to cite.
// No screenshots yet: they need to be taken on real accounts.
//
// Hookpost facts: pricing.ts (Free 2 channels / 30 posts, Hookpost ₹599),
// razorpay checkout (UPI Autopay), count.length.ts (Threads counts bytes, so
// Devanagari stops near 166 characters). There is no Hindi interface and no
// Hindi-specific AI, so the page only says captions are posted as written.
const CANONICAL = 'https://hookpost.hookstep.in/guides/social-media-post-schedule-kaise-kare';
const PUBLISHED = '2026-10-11';
const { FREE, HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

interface PlatformSection {
  id: string;
  short: string;
  title: string;
  intro: string;
  steps: string[];
  notes: string[];
}

const PLATFORMS: PlatformSection[] = [
  {
    id: 'instagram',
    short: 'Instagram',
    title: 'Instagram post ya Reel schedule kaise kare',
    intro: 'Instagram app mein post aur Reel dono schedule ho sakte hain. Yeh option professional account (Business ya Creator) par milta hai.',
    steps: [
      'Naya post ya Reel banaiye aur caption likhne wali screen tak aaiye.',
      'Neeche "Advanced settings" (kuch versions mein "More options") kholiye.',
      '"Schedule this post" on kijiye, date aur time chuniye.',
      'Wapas aakar "Schedule" dabaiye. Scheduled post aapke profile ke scheduled content mein dikhega.',
    ],
    notes: [
      'Option nahi dikh raha? Settings mein "Account type and tools" se professional account par switch kijiye. Professional account free hai.',
      'Stories Instagram app ke andar schedule nahi hoti.',
      'Desktop par Meta Business Suite se bhi Instagram aur Facebook Page ke post ek saath schedule hote hain.',
    ],
  },
  {
    id: 'facebook',
    short: 'Facebook Page',
    title: 'Facebook Page par post schedule kaise kare',
    intro: 'Facebook Page ke posts Meta Business Suite se schedule hote hain, desktop par business.facebook.com ya phone par Meta Business Suite app se. Creator Studio ab nahi chalta: Meta ne January 2023 mein use Business Suite se badalne ka elaan kiya tha, isliye purane guides ke Creator Studio wale steps kaam nahi aayenge.',
    steps: [
      'Meta Business Suite kholiye aur sahi Page chuniye.',
      '"Create post" par click kijiye. Chahein toh yahin Instagram bhi select kar sakte hain.',
      'Text, photo ya video daaliye.',
      'Publish ki jagah schedule wala option chuniye, date aur time daaliye, phir "Schedule" dabaiye.',
    ],
    notes: [
      'Yeh tarika Page ke liye hai, personal profile ke liye nahi.',
      'Scheduled posts Business Suite ke Planner aur Content section mein dikhte hain, wahan se edit ya delete kar sakte hain.',
    ],
  },
  {
    id: 'youtube',
    short: 'YouTube',
    title: 'YouTube video ya Short schedule kaise kare',
    intro: 'YouTube Studio mein upload karte waqt hi video schedule ho jata hai. Tab tak video private rehta hai aur set time par public hota hai.',
    steps: [
      'studio.youtube.com par sign in kijiye, "Create" aur phir "Upload videos" chuniye.',
      'File chuniye aur title, description jaise details bhariye.',
      'Visibility wale step par "Schedule" chuniye.',
      'Date, time aur time zone set kijiye (India ke liye IST) aur "Schedule" dabaiye.',
    ],
    notes: [
      'YouTube ke help page ke mutabik YouTube app se bhi schedule kar sakte hain.',
      'Time badalna ho toh Content mein video kholiye, Visibility mein jaakar naya time chuniye.',
      'Channel par Community Guidelines strike chal rahi ho toh scheduled video us dauran publish nahi hota; strike ke baad dobara schedule karna padta hai.',
    ],
  },
  {
    id: 'linkedin',
    short: 'LinkedIn',
    title: 'LinkedIn post schedule kaise kare',
    intro: 'LinkedIn mein schedule ka option post likhne wali window ke clock icon mein hai. Profile post 10 minute se lekar 3 mahine aage tak schedule ho sakti hai.',
    steps: [
      'Homepage par "Start a post" kholiye aur post likhiye.',
      'Clock icon dabaiye: desktop par yeh window ke neeche right mein hai, phone par upar right mein.',
      'Date aur time chuniye, "Next" dabaiye, phir "Schedule".',
      'Saare scheduled posts "View all scheduled posts" mein dikhte hain.',
    ],
    notes: [
      'Company Page par post 1 ghante se 3 mahine aage tak schedule hoti hai. Page par polls, kai photos wali post aur reshare schedule nahi hote.',
    ],
  },
  {
    id: 'x',
    short: 'X (Twitter)',
    title: 'X (Twitter) par post schedule kaise kare',
    intro: 'X par scheduling web (x.com) ke composer se hoti hai.',
    steps: [
      'x.com par post likhne ka box kholiye.',
      'Neeche calendar wala Schedule icon dabaiye, date aur time chuniye, "Confirm" kijiye.',
      'Button "Schedule" ho jayega. Scheduled posts "Unsent posts" mein milte hain.',
    ],
    notes: [
      'Schedule icon na dikhe toh aapke account mein X ka apna scheduling option abhi nahi hai.',
      'Thread (kai posts ki series) ke liye dekhiye: how to schedule a thread on X.',
    ],
  },
  {
    id: 'threads',
    short: 'Threads',
    title: 'Threads post schedule kaise kare',
    intro: 'January 2025 se Threads app mein bhi scheduling hai.',
    steps: [
      'Post likhiye, composer ke "..." menu mein "Schedule" chuniye.',
      'Date aur time chuniye aur "Schedule" dabaiye. Scheduled post drafts mein dikhega, wahan se edit ya delete ho sakta hai.',
    ],
    notes: ['Replies schedule nahi hote, sirf naye post.'],
  },
];

const FAQ = [
  {
    q: 'Kya ek saath sabhi social media par post schedule kar sakte hain?',
    a: `Har app ka scheduler sirf apne platform par post karta hai. Instagram, Facebook, LinkedIn aur YouTube ek saath chahiye toh Hookpost jaisa tool use kijiye: ek post likhiye, har network ke liye zaroorat ho toh alag edit kijiye, aur ek calendar se schedule kijiye.${offer(` Free plan mein ${FREE.channel} channels aur ${FREE.posts_per_month} posts mahina milte hain.`, ` Naye workspace ko ${FREE_POSTS} milte hain, card ke bina; uske baad ${HOOKPOST_DISPLAY_PRICE} mahina.`)}`,
  },
  {
    q: 'Personal account par post schedule hoti hai kya?',
    a: 'LinkedIn profile, YouTube channel aur X par haan. Instagram mein scheduling professional (Business ya Creator) account par milti hai, aur Facebook mein Page par, personal profile par nahi.',
  },
  {
    q: 'Scheduled post edit kaise kare?',
    a: 'Jahan schedule kiya wahi se: LinkedIn mein "View all scheduled posts", YouTube Studio mein Content > Visibility, Meta Business Suite mein Planner, Threads mein drafts. Hookpost mein calendar par post kholiye aur badal dijiye, ya use doosre din par drag kar dijiye.',
  },
  {
    q: 'Phone band ho toh bhi post jayegi kya?',
    a: 'Haan. Scheduled post platform ya Hookpost ke server par save hoti hai aur set time par wahin se jaati hai. Phone ya laptop on rehna zaroori nahi.',
  },
  {
    q: 'Hindi ya Hinglish caption likh sakte hain?',
    a: 'Haan. Hookpost aapka caption jaisa likha hai waisa hi post karta hai, chahe Hindi, Hinglish ya English ho. Bas dhyan rahe ki Hookpost Threads ki 500 ki limit bytes mein ginta hai, aur Devanagari ka har character 3 bytes leta hai, isliye Hindi mein likhi Threads post lagbhag 166 characters tak hi jaati hai.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Social Media Post Schedule Kaise Kare | Hookpost',
  description: `Instagram, Facebook, YouTube aur LinkedIn par post schedule karne ke 2026 ke steps. Sab ek calendar se chahiye? ${offer('Free plan', FREE_POSTS)}, phir ${HOOKPOST_DISPLAY_PRICE}/month UPI se.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Social media post schedule kaise kare (2026)',
    description: 'Instagram, Facebook Page, YouTube, LinkedIn, X aur Threads par post schedule karne ke current steps.',
    url: CANONICAL,
    type: 'article',
    locale: 'hi_IN',
  },
});

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

export default function ScheduleKaiseKareGuide() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${CANONICAL}#article`,
        headline: 'Social media post schedule kaise kare: Instagram, Facebook, YouTube aur LinkedIn',
        url: CANONICAL,
        inLanguage: 'hi-Latn',
        datePublished: PUBLISHED,
        dateModified: PUBLISHED,
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
      },
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        inLanguage: 'hi-Latn',
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://hookpost.hookstep.in/guides' },
          { '@type': 'ListItem', position: 3, name: 'Social media post schedule kaise kare', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      {/* The landing layout sets <html lang="en"> for every page; the guide's
          own text is Hinglish, so its container says so. */}
      <div lang="hi-Latn">
        <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
          <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
            <Link href="/guides" className="hover:text-hp-primary-text">Guides</Link> / Hinglish
          </nav>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
            Social media post schedule kaise kare: Instagram, Facebook, YouTube aur LinkedIn
          </h1>
          <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
            Har platform ka apna scheduler hai: Instagram app, Facebook ke liye Meta Business Suite, YouTube Studio aur LinkedIn ka
            clock icon. Ek hi platform par post karte hain toh wahi kaafi hai. Do ya zyada platforms par ek saath post karni ho, ya
            team mil kar kaam karti ho, toh ek tool se sab ek calendar mein schedule hota hai. Neeche har platform ke current steps
            hain, 11 October 2026 ko check kiye hue.
          </p>
          <nav aria-label="Is guide mein" className="mt-8">
            <ul className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <li key={p.id}>
                  <a href={`#${p.id}`} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                    {p.short}
                  </a>
                </li>
              ))}
              <li>
                <a href="#ek-saath" className="inline-block rounded-full border border-hp-primary/50 px-4 py-2 text-sm hover:border-hp-primary">
                  Sab ek saath
                </a>
              </li>
            </ul>
          </nav>
        </section>

        {PLATFORMS.map((p) => (
          <section key={p.id} id={p.id} className="mt-12 border-t border-hp-border scroll-mt-24">
            <div className="mx-auto w-full max-w-[1100px] px-5 py-12 sm:px-10">
              <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">{p.title}</h2>
              <p className="mt-4 max-w-[70ch] text-hp-text/75">{p.intro}</p>
              <ol className="mt-5 flex max-w-[70ch] list-decimal flex-col gap-2 ps-6 text-hp-text/85">
                {p.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <ul className="mt-5 flex max-w-[70ch] flex-col gap-2 text-sm text-hp-text/60">
                {p.notes.map((n) => (
                  <li key={n} className="flex gap-2">
                    <span className="text-hp-primary-text">·</span>
                    <span>
                      {p.id === 'x' && n.startsWith('Thread') ? (
                        <>
                          Thread (kai posts ki series) ke liye dekhiye:{' '}
                          <A href="/guides/schedule-x-threads">how to schedule a thread on X</A>.
                        </>
                      ) : (
                        n
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}

        <section id="ek-saath" className="border-t border-hp-border scroll-mt-24">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
              Ek saath sabhi social media par post kaise kare
            </h2>
            <p className="mt-4 max-w-[70ch] text-hp-text/75">
              Upar wale saare tarike sirf ek platform ke liye hain. Hookpost mein aap ek post likhte hain, jin channels par bhejni hai
              unhe chunte hain, aur zaroorat ho toh kisi ek network ke liye text chhota ya alag kar dete hain. Har network ki limit
              (X par 280 characters, LinkedIn par 3,000, Instagram par photo ya video zaroori) schedule se pehle check hoti hai.
            </p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-3 text-hp-text/80">
              <li className="rounded-2xl border border-hp-border p-5">
                {offer(
                  <>
                    <strong className="text-hp-text">Free plan:</strong> {FREE.channel} channels aur {FREE.posts_per_month} posts mahina,{' '}
                    {inr(0)} mein, card ke bina.
                  </>,
                  <>
                    <strong className="text-hp-text">{FREE_POSTS}:</strong> card ke bina, phir {HOOKPOST_DISPLAY_PRICE} mahina, UPI
                    AutoPay ya card se.
                  </>
                )}
              </li>
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">Hookpost:</strong> {HOOKPOST_DISPLAY_PRICE} mahina, {HOOKPOST.channel} channels aur{' '}
                {HOOKPOST.posts_per_month} posts. Payment Razorpay se UPI Autopay, card ya NetBanking mein.
              </li>
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">Networks:</strong> Instagram (Business/Creator), Facebook Page, YouTube, LinkedIn
                profile, X, Threads, Telegram aur{' '}
                <A href="/channels">baaki channels</A>.
              </li>
            </ul>
            <p className="mt-6 max-w-[70ch] text-hp-text/70">
              Hookpost ka interface English mein hai; caption aap Hindi, Hinglish ya kisi bhi bhasha mein likh sakte hain. Kai
              platforms par ek post kaise adjust karein, iske liye{' '}
              <A href="/guides/post-to-multiple-social-media-at-once">har network ki limits ki table</A> dekhiye. Tyohaar ki posts plan
              kar rahe hain? <A href="/social-media-calendar-india">Social media calendar India</A> mein dates aur ideas hain.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
                Free mein shuru kijiye
              </Link>
              <Link href="/social-media-scheduler-india" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
                Rupee plans aur UPI
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Kaunsa tarika kab</h2>
            <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <caption className="sr-only">Native scheduler ya tool: kab kya use karein</caption>
                <thead>
                  <tr className="border-b border-hp-border-strong text-hp-text/60">
                    <th scope="col" className="py-3 pe-4 font-semibold">Aapki zaroorat</th>
                    <th scope="col" className="py-3 font-semibold">Sahi tarika</th>
                  </tr>
                </thead>
                <tbody className="text-hp-text/80">
                  <tr className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-semibold text-hp-text">Ek hi platform, kabhi kabhi post</th>
                    <td className="py-3">Us app ka apna scheduler. Free hai aur kaafi hai.</td>
                  </tr>
                  <tr className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-semibold text-hp-text">Instagram aur Facebook Page saath mein</th>
                    <td className="py-3">Meta Business Suite, ya agar LinkedIn/YouTube bhi hai toh ek tool.</td>
                  </tr>
                  <tr className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-semibold text-hp-text">3-4 platforms, ek hi khabar</th>
                    <td className="py-3">Scheduling tool: ek post, har network ke liye edit, ek calendar.</td>
                  </tr>
                  <tr className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-semibold text-hp-text">Team ya clients ke accounts</th>
                    <td className="py-3">
                      Tool jismein team members aur client-wise channels hon. <A href="/for/agencies">Agencies ke liye</A>.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="border-t border-hp-border bg-white/[0.015]">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Aksar pooche jaane wale sawal</h2>
            <dl className="mt-8 flex flex-col gap-8">
              {FAQ.map((f) => (
                <div key={f.q} className="min-w-0">
                  <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                  <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-10 text-sm text-hp-text/50">
              Sources (11 October 2026):{' '}
              <A href="https://www.linkedin.com/help/linkedin/answer/a1347212">LinkedIn: Schedule posts</A>,{' '}
              <A href="https://www.linkedin.com/help/linkedin/answer/a548192">LinkedIn: scheduled posts for Pages</A>,{' '}
              <A href="https://support.google.com/youtube/answer/1270709">YouTube: schedule a video</A>.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
