/**
 * The shared frame of an answer page (answer-pages.ts): breadcrumb, H1, the
 * direct answer in the first paragraph, a dated "Last updated" line, then the
 * page's own sections, an FAQ and related links. Server components only: the
 * page renders complete HTML before any JavaScript runs, which is what AI
 * crawlers read.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../../site-nav';
import { offer, TRIAL_CTA } from '../../trial-offer';
import { ldJson, type Faq } from './answer-schema';

const PINK = 'text-hp-primary-text';

export const A = ({ href, children }: { href: string; children: ReactNode }) =>
  href.startsWith('http') ? (
    <a href={href} className={`${PINK} underline`} rel="nofollow noopener" target="_blank">
      {children}
    </a>
  ) : (
    <Link href={href} className={`${PINK} underline`}>
      {children}
    </Link>
  );

export const Code = ({ children, label }: { children: string; label?: string }) => (
  <div className="mt-3 min-w-0">
    {label ? <p className="mb-1 font-mono text-xs text-hp-text/50">{label}</p> : null}
    <pre className="overflow-x-auto rounded-xl border border-hp-border bg-white/[0.03] p-4 text-xs leading-relaxed font-mono text-hp-text/90">
      {children}
    </pre>
  </div>
);

export const C = ({ children }: { children: ReactNode }) => (
  <code className="font-mono text-hp-text break-words">{children}</code>
);

export function AnswerLayout({
  crumb,
  h1,
  answer,
  updated,
  updatedLabel,
  jsonLd,
  children,
}: {
  crumb: string;
  h1: string;
  /** The two-to-three sentence direct answer. Rendered as the first paragraph. */
  answer: ReactNode;
  /** ISO date, YYYY-MM-DD. */
  updated: string;
  updatedLabel: string;
  jsonLd: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(jsonLd) }} />
      <SiteNav />
      <article>
        <header className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
          <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
            <Link href="/guides" className="hover:text-hp-primary-text">
              Guides
            </Link>{' '}
            / {crumb}
          </nav>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance break-words">
            {h1}
          </h1>
          <p data-answer className="article-summary mt-5 max-w-[70ch] text-lg text-hp-text/80">
            {answer}
          </p>
          <p className="mt-4 text-sm text-hp-text/50">
            {'By the Hookpost team · '}
            <time dateTime={updated}>{`Last updated ${updatedLabel}`}</time>
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
              {offer('Create an account', TRIAL_CTA)}
            </Link>
            <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
              See pricing
            </Link>
          </div>
        </header>
        {children}
      </article>
    </div>
  );
}

export function Section({
  title,
  id,
  children,
  tinted = false,
}: {
  title: string;
  id?: string;
  children: ReactNode;
  tinted?: boolean;
}) {
  return (
    <section id={id} className={`mt-14 border-t border-hp-border scroll-mt-24${tinted ? ' bg-white/[0.015]' : ''}`}>
      <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">{title}</h2>
        {children}
      </div>
    </section>
  );
}

export const P = ({ children }: { children: ReactNode }) => (
  <p className="mt-4 max-w-[70ch] text-hp-text/75">{children}</p>
);

export function Steps({ steps }: { steps: readonly { name: string; text: string }[] }) {
  return (
    <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-4 ps-6 text-hp-text/80">
      {steps.map((s) => (
        <li key={s.name} className="min-w-0 break-words">
          <strong className="text-hp-text">{s.name}.</strong> {s.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * A comparison table that scrolls inside its own box on a phone, so the page
 * itself never scrolls sideways.
 */
export function CompareTable({
  caption,
  head,
  rows,
  note,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
  note?: ReactNode;
}) {
  return (
    <div className="mt-6">
      <div className="max-w-full overflow-x-auto rounded-2xl border border-hp-border">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-white/[0.04] text-hp-text">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="px-4 py-3 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-hp-text/75">
            {rows.map((r) => (
              <tr key={r[0]} className="border-t border-hp-border align-top">
                <th scope="row" className="px-4 py-3 font-semibold text-hp-text">
                  {r[0]}
                </th>
                {r.slice(1).map((cell, i) => (
                  <td key={i} className="px-4 py-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className="mt-3 max-w-[75ch] text-sm text-hp-text/55">{note}</p> : null}
    </div>
  );
}

export function FaqSection({ faq }: { faq: readonly Faq[] }) {
  return (
    <Section title="Questions" id="faq" tinted>
      <dl className="mt-8 flex flex-col gap-8">
        {faq.map((f) => (
          <div key={f.q} className="min-w-0">
            <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
            <dd className="mt-2 max-w-[70ch] text-hp-text/70 break-words">{f.a}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function Related({ links }: { links: readonly { href: string; label: string; note: string }[] }) {
  return (
    <Section title="Related">
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <li key={l.href} className="min-w-0 rounded-2xl border border-hp-border p-5">
            <Link href={l.href} className="font-bold text-hp-text hover:text-hp-primary-text">
              {l.label}
            </Link>
            <p className="mt-2 text-sm text-hp-text/60">{l.note}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
