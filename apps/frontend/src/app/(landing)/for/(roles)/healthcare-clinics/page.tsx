import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for Healthcare Clinics | Hookpost',
  description:
    'Share patient education across Instagram, LinkedIn, YouTube, X and your Facebook Page. Social media scheduling for clinics, dentists and therapists.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/healthcare-clinics',
  },
});

export default function HealthcareClinicsLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Healthcare & Wellness Clinics", item: "https://hookpost.hookstep.in/for/healthcare-clinics" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can clinics coordinate appointments and educational health tips?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Hookpost provides visual calendars to organize preventive wellness tips, doctor spotlights, and clinic schedule announcements.",
        },
      },
      {
        "@type": "Question",
        name: FREE_PLAN_QUESTION,
        acceptedAnswer: {
          "@type": "Answer",
          text: FREE_PLAN_ANSWER,
        },
      },
    ],
  };

  const features = [
    { title: '🩺 Patient Education & Wellness Tips', desc: 'Pre-schedule weekly preventative care guides, dental hygiene tips, and clinic announcements across all channels.' },
    { title: '🔒 Drafts & Review Links', desc: 'Save posts as drafts and share a preview link so a lead physician or practice manager can review and comment before anything is scheduled.' },
    { title: '📍 Clinic Hours & Practitioner Updates', desc: 'Share seasonal clinic hours, flu shot availability, and new practitioner introductions on LinkedIn, X, Instagram and your Facebook Page.' },
    { title: '🤖 AI Medical & Wellness Explainer Prompts', desc: 'Turn clinic FAQs and study summaries into clear, patient-friendly social posts with the AI assistant (Hookpost plan).' },
    { title: '🏥 Multi-Specialty & Branch Management', desc: 'Group each department or branch (e.g. Pediatrics, Dermatology, Orthopedics) as a customer and filter the calendar to one at a time.' },
    { title: '📚 Blog and Social Together', desc: 'Publish a long-form article to WordPress and schedule the social posts that point to it from the same calendar.' },
  ];

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-bold text-sm py-1.5 px-4">
        🩺 Hookpost for Healthcare — Build Patient Trust & Practice Authority with Educational Social Media
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/auth/login" className="text-sm font-medium text-hp-text hover:text-hp-primary-text px-4 py-2 border border-hp-border-strong rounded-full">
            Log In
          </Link>
          <Link href="/auth" className="text-sm font-semibold text-black bg-white hover:bg-hp-primary hover:text-hp-on-primary px-5 py-2 rounded-full">
            {offer('Start Free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-16 text-center">

        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50 mb-8">
          <ol className="flex items-center justify-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li><Link href="/for" className="hover:text-hp-text transition-colors">Solutions</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Healthcare & Wellness Clinics</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Dental Clinics • Medical Practices • Physical Therapy • Mental Health
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Educate Patients & Build Trust <br />
          <span className="text-hp-primary-text">Across Your Social Channels.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Provide valuable health guidance to your local community with zero marketing stress. Hookpost schedules your clinic's patient outreach on LinkedIn, YouTube, X, Instagram and your Facebook Page.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Compare Hookpost vs Buffer
          </Link>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div key={i} className="p-6 rounded-2xl bg-hp-surface/60 border border-hp-border hover:border-hp-primary/50 transition-all">
              <h3 className="text-xl font-bold text-hp-text mb-2">{f.title}</h3>
              <p className="text-hp-text-2 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <SectionFaq items={faqSchema.mainEntity} />



    </div>
  );
}
