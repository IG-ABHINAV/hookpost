'use client';

import { createContext, useContext, type ReactNode } from 'react';
import {
  chargeCurrencyOf,
  RUPEE_NOTE,
  showRupeeNote,
  usePublicPricingContextState,
  type PricingContext,
} from '@hookpost/frontend/components/billing/use.pricing.context';

// /mcp states the trial's terms in two places, and each visitor should read
// only the version for the currency checkout charges them. The page is cached
// for everyone, so that is asked after hydration of the same uncached
// /api/public/pricing-context the pricing cards use, once for the page.
// The strings come as props from the server (trial-terms.ts): a client module
// must not read the build-time switches (trial-offer.spec.ts).

type Answer = { ctx: PricingContext | null; settled: boolean };

const VisitorCurrency = createContext<Answer | null>(null);

const Asking = ({ children }: { children: ReactNode }) => {
  const answer = usePublicPricingContextState();
  return <VisitorCurrency.Provider value={answer}>{children}</VisitorCurrency.Provider>;
};

/**
 * Asks for the visitor's currency once for everything inside it, but only
 * when `ask` is set: a build that sells rupees alone has nothing to ask.
 */
export const VisitorCurrencyProvider = ({ ask, children }: { ask: boolean; children: ReactNode }) =>
  ask ? <Asking>{children}</Asking> : <>{children}</>;

export interface TrialTermsCopy {
  /** For a visitor billed in rupees. */
  inr: string;
  /** For a visitor billed in dollars; set only by a build that sells them. */
  usd?: string;
  /**
   * Both, each scoped, true for every visitor: for readers that run no
   * JavaScript (in <noscript>) and for when the pricing context never answers.
   */
  either?: string;
}

/** Hides the skeleton from readers that run no JavaScript (see TrialTerms). */
const HIDE_SKELETON = '[data-trial-terms-skeleton]{display:none}';

/** Lines to reserve: below the sm breakpoint, from sm, from md. */
export type SkeletonLines = [phone: number, sm: number, md: number];

/**
 * Pulsing bars, one per line the terms will take once they arrive (text-sm,
 * 20px a line), so nothing below moves when they do. Each bar shows or hides
 * per breakpoint; the classes are written out whole for Tailwind's scan.
 */
const Skeleton = ({ lines: [phone, sm, md] }: { lines: SkeletonLines }) => (
  <span
    aria-hidden="true"
    data-testid="trial-terms-skeleton"
    data-trial-terms-skeleton=""
    className="block w-full max-w-[64ch] animate-pulse"
  >
    {Array.from({ length: Math.max(phone, sm, md) }, (_, i) => (
      <span
        key={i}
        className={[
          'h-5 py-1',
          i < phone ? 'block' : 'hidden',
          i < sm ? 'sm:block' : 'sm:hidden',
          i < md ? 'md:block' : 'md:hidden',
        ].join(' ')}
      >
        <span
          className={[
            'block h-full rounded bg-white/[0.08]',
            i === phone - 1 ? 'w-2/3' : 'w-full',
            i === sm - 1 ? 'sm:w-2/3' : 'sm:w-full',
            i === md - 1 ? 'md:w-2/3' : 'md:w-full',
          ].join(' ')}
        />
      </span>
    ))}
  </span>
);

/**
 * The trial's terms for this visitor's currency. With dollars on sale, the
 * terms wait for the answer, so nobody sees one currency turn into another:
 * meanwhile `pending` if given (text true for every visitor), else a
 * skeleton `lines` tall. The cached HTML also carries `either` in
 * <noscript>, with `children`, so a reader that runs no JavaScript still gets
 * the card, the automatic charge and how to cancel. `children` (a "How to
 * cancel" link) follows the terms once they show. A visitor billed in rupees
 * whom neither the IP nor the timezone places in India also gets RUPEE_NOTE,
 * as on /pricing.
 */
export const TrialTerms = ({
  inr,
  usd,
  either,
  pending,
  lines = [1, 1, 1],
  children,
}: TrialTermsCopy & { pending?: ReactNode; lines?: SkeletonLines; children?: ReactNode }) => {
  const answer = useContext(VisitorCurrency);
  let text = inr;
  if (usd) {
    if (answer && !answer.settled) {
      return (
        <>
          {pending ?? <Skeleton lines={lines} />}
          {either ? (
            // Rendered into the HTML by the server only: React never renders
            // or hydrates a <noscript>'s children in the browser.
            <noscript>
              <style>{HIDE_SKELETON}</style>
              {pending ? ' ' : null}
              {either}
              {children}
            </noscript>
          ) : null}
        </>
      );
    }
    const ctx = answer?.ctx ?? null;
    const currency = ctx ? chargeCurrencyOf(ctx) : null;
    text =
      currency === 'INR'
        ? showRupeeNote(ctx)
          ? `${inr} ${RUPEE_NOTE}`
          : inr
        : currency === 'USD'
        ? usd
        : either || usd;
  }
  return (
    <>
      {text}
      {children}
    </>
  );
};
