import Link from 'next/link';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, FACTS_CHECKED, CompetitorFacts } from '../compare/competitor-facts';
import { networkDiff, listJoin, NETWORK_NAMES } from '../compare/network-diff';
import { CHANNEL_SPECS } from '../channels/channel-specs';
import { offer, TRIAL_SENTENCE } from '../trial-offer';
import { BILLED, planPrice } from '../usd-offer';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';

// "Moving from <vendor>" block for the /alternatives pages. The twelve pages
// shared one skeleton (flagged as a doorway pattern on 8 Sep), so this block
// is built only from facts that differ per vendor: its pricing basis and entry
// plan (competitor-facts.ts, FACTS_CHECKED), the rupee price an Indian visitor
// sees where we read one (inrPlan), the networks it lists against
// channel-specs.ts, and its free plan, API and MCP. Hookpost's side comes from
// pricing.ts. Nothing here is typed per vendor, so it cannot drift from the
// facts file, and two vendors only read alike where their facts are alike.
//
// What it must never claim: a CSV import (Hookpost has none), an export
// feature of the other tool (not checked), or that Hookpost is cheaper when
// the arithmetic says otherwise.

const { FREE, HOOKPOST } = pricingINR;
const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const COMPARE_CHANNELS = HOOKPOST.channel;
const TEAM = 3;

const costLines = (c: CompetitorFacts): string[] => {
  const p = c.cheapestPaid;
  const lines: string[] = [];
  if (!p) return [`${c.name} does not publish a price.`];
  const billed = p.billing === 'annual' ? ' billed yearly' : '';
  const sym = p.currency === 'USD' ? dollars : (n: number) => `${p.currency} ${n}`;
  if (p.billing === 'one-time') {
    lines.push(
      `${c.name} ${p.name ?? ''} is a ${sym(p.price)} one-time ${p.per.replace(/^licence/, 'licence')}, and you run and update the server yourself. Hookpost is hosted: ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels, nothing to install.`
    );
    return lines;
  }
  // Where the vendor shows an Indian visitor rupees, that is the price this
  // page's reader pays, so the dollar list price is left out.
  if (c.inrPlan) {
    // the rupee lines below cover it
  } else if (p.per.startsWith('channel')) {
    lines.push(
      `${c.name} charges per channel: ${sym(p.price)} a channel a month${billed} on ${p.name}, so ${COMPARE_CHANNELS} channels come to ${sym(Math.round(p.price * COMPARE_CHANNELS * 100) / 100)} a month.`
    );
  } else if (p.per.startsWith('user')) {
    lines.push(
      `${c.name} charges per user: ${sym(p.price)} a user a month${billed} on ${p.name}${p.channelsIncluded ? `, with ${p.channelsIncluded} channels` : ''}. A team of ${TEAM} pays ${sym(p.price * TEAM)} a month.`
    );
  } else {
    lines.push(
      `${c.name}'s cheapest plan, ${p.name}, is ${sym(p.price)} a month${billed}${p.channelsIncluded ? ` for ${p.channelsIncluded} channels` : ''}.`
    );
  }

  const r = c.inrPlan;
  if (r) {
    const rate = r.monthly ?? r.yearlyPerMonth!;
    const rateNote = r.monthly != null ? '' : ' billed yearly';
    const yearly = r.monthly != null && r.yearlyPerMonth != null ? r.yearlyPerMonth : null;
    if (r.per === 'account/month') {
      lines.push(
        `From India its page shows rupees: ${rupees(rate)} an account a month${rateNote} on ${r.name}, so ${COMPARE_CHANNELS} accounts cost ${rupees(Math.round(rate * COMPARE_CHANNELS * 100) / 100)}${yearly != null ? ` (${rupees(Math.round(yearly * COMPARE_CHANNELS * 100) / 100)} billed yearly)` : ''}.`
      );
    } else if (r.per === 'user/month') {
      lines.push(
        `From India its page shows ${rupees(rate)} a user a month${rateNote} on ${r.name}${r.channels ? ` for up to ${r.channels} accounts` : ''}; a team of ${TEAM} pays ${rupees(rate * TEAM)}.`
      );
    } else {
      lines.push(
        `From India its page shows ${rupees(rate)} a month${rateNote} on ${r.name}${r.channels ? ` for ${r.channels} channels` : ''}${r.seats ? ` and ${r.seats} user${r.seats === 1 ? '' : 's'}` : ''}${yearly != null ? `, or ${rupees(yearly)} a month billed yearly` : ''}.`
      );
    }
  } else if (c.inr) {
    lines.push(`Its pricing page switches to rupees for Indian visitors; open it from India for the current figure.`);
  } else {
    lines.push(`It bills in US dollars, so you need a card that allows international payments.`);
  }

  lines.push(
    `Hookpost: ${planPrice('HOOKPOST', ' a month')} flat for up to ${HOOKPOST.channel} channels and ${HOOKPOST.team_member_limit} team members, ${BILLED}.`
  );

  // The rupee arithmetic, said plainly in whichever direction it falls.
  const hookpostPerChannel = Math.round((HOOKPOST.month_price / HOOKPOST.channel) * 100) / 100;
  if (r && r.per === 'month' && r.channels) {
    const cheapest = Math.min(r.monthly ?? Infinity, r.yearlyPerMonth ?? Infinity);
    const per = Math.round((cheapest / r.channels) * 100) / 100;
    const how = r.yearlyPerMonth != null && cheapest === r.yearlyPerMonth ? ' billed yearly' : '';
    lines.push(
      per < hookpostPerChannel
        ? `Per channel, ${c.name} is cheaper: ${rupees(per)}${how} against ${HOOKPOST_DISPLAY_PER_CHANNEL} on Hookpost with all ${HOOKPOST.channel} channels in use. Move for the reasons below, not the bill.`
        : `Per channel, Hookpost is cheaper: ${HOOKPOST_DISPLAY_PER_CHANNEL} with all ${HOOKPOST.channel} channels in use, against ${rupees(per)}${how} on ${c.name} ${r.name}.`
    );
  } else if (r && r.per === 'account/month') {
    const rate = r.monthly ?? r.yearlyPerMonth!;
    const breakEven = Math.floor(HOOKPOST.month_price / rate) + 1;
    if (breakEven <= HOOKPOST.channel) {
      lines.push(
        breakEven <= 1
          ? `Hookpost costs less than ${c.name} from the first account.`
          : `${c.name} costs less for ${breakEven === 2 ? 'one account' : `up to ${breakEven - 1} accounts`}; from ${breakEven} to ${HOOKPOST.channel} accounts Hookpost costs less at ${c.name}'s monthly rate.`
      );
    }
  }
  return lines;
};

/**
 * `steps={false}` leaves out the step list, for pages with their own migration
 * section; `networks={false}` leaves out the network lists, for pages that
 * already compare networks in their own words.
 */
export const SwitchFrom = ({ slug, steps = true, networks = true }: { slug: string; steps?: boolean; networks?: boolean }) => {
  const c = COMPETITOR_FACTS[slug];
  if (!c) return null;
  const diff = networks && c.networks.length ? networkDiff(c.networks) : null;

  // Setup notes for the networks both publish to that need more than a click.
  const setupNotes = (diff ? diff.sharedSlugs : [])
    .map((k) => {
      const spec = CHANNEL_SPECS[k];
      const special = spec.rules.find((r) =>
        /App Password|Business or Creator|bot|Page, not|private|application password|API key/i.test(r)
      );
      return special ? `${NETWORK_NAMES[k]}: ${special}` : null;
    })
    .filter((x): x is string => Boolean(x));

  const free = c.freePlan
    ? `${c.name}'s free plan: ${c.freePlan}.`
    : c.freeTrialDays
    ? `${c.name} has no free plan, only a ${c.freeTrialDays}-day trial.`
    : `${c.name} lists no free plan.`;

  const apiMcp =
    c.api && c.mcp
      ? `${c.name} lists both an API and an MCP server, so neither is a reason to move on its own. Hookpost includes both on the Hookpost plan.`
      : c.mcp
      ? `${c.name} lists an MCP server, so MCP alone is not a reason to move. Hookpost includes MCP and a REST API on the Hookpost plan.`
      : c.api
      ? `${c.name} lists an API but no MCP server on its pages. Hookpost includes the API and an MCP server on the Hookpost plan.`
      : `${c.name}'s pages do not mention an API or an MCP server. Hookpost includes both on the Hookpost plan.`;

  return (
    <section className="bg-hp-surface border border-hp-border rounded-2xl p-6 sm:p-8 space-y-5" aria-labelledby={`move-${slug}`}>
      <h2 id={`move-${slug}`} className="text-2xl sm:text-3xl font-bold text-hp-text">
        {steps ? `Moving from ${c.name} to Hookpost` : `${c.name} and Hookpost, worked out`}
      </h2>
      <p className="text-hp-text-2 leading-relaxed">
        Worked out from {c.name}&apos;s own pricing page ({FACTS_CHECKED}) and Hookpost&apos;s plan and channel limits. Where{' '}
        {c.name} comes out ahead, it says so.
      </p>

      <div className="space-y-2">
        <h3 className="text-lg font-bold text-hp-text">What the same setup costs</h3>
        <ul className="space-y-2 text-hp-text-2 leading-relaxed list-disc ps-5">
          {costLines(c).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>

      {diff ? (
        <div className="space-y-2">
          <h3 className="text-lg font-bold text-hp-text">Networks</h3>
          <ul className="space-y-2 text-hp-text-2 leading-relaxed list-disc ps-5">
            <li>
              Both publish to {diff.shared.length ? listJoin(diff.shared) : 'none of the same networks'}.
            </li>
            {diff.onlyCompetitor.length ? (
              <li>
                {c.name} also lists {listJoin(diff.onlyCompetitor)}. Hookpost cannot publish there, so keep{' '}
                {diff.onlyCompetitor.length === 1 ? 'that one' : 'those'} in {c.name} or post by hand.
              </li>
            ) : (
              <li>Every network {c.name} lists is one Hookpost publishes to.</li>
            )}
            {diff.onlyHookpost.length ? (
              <li>
                Hookpost adds {diff.onlyHookpost.length} that {c.name} does not list: {listJoin(diff.onlyHookpost)}.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-lg font-bold text-hp-text">{offer('Free plan, API and MCP', 'Free posts, API and MCP')}</h3>
        <ul className="space-y-2 text-hp-text-2 leading-relaxed list-disc ps-5">
          <li>
            {free}{' '}
            {offer(
              `Hookpost Free covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month with no AI or API, which is enough to run two of your accounts side by side before you pay.`,
              `${TRIAL_SENTENCE} That is enough to connect your accounts and publish real posts before you decide.`
            )}
          </li>
          <li>{apiMcp}</li>
        </ul>
      </div>

      {steps ? (
      <div className="space-y-2">
        <h3 className="text-lg font-bold text-hp-text">Step by step</h3>
        <ol className="space-y-2 text-hp-text-2 leading-relaxed list-decimal ps-5">
          <li>
            List the accounts you run in {c.name} and check each one on the{' '}
            <Link href="/channels" className="text-hp-primary-text underline">channel list</Link>.
            {diff && diff.onlyCompetitor.length ? ` ${listJoin(diff.onlyCompetitor)} stay${diff.onlyCompetitor.length === 1 ? 's' : ''} where ${diff.onlyCompetitor.length === 1 ? 'it is' : 'they are'}.` : ''}
          </li>
          <li>
            {offer('Connect them in Hookpost, two on the free plan to start.', `Connect them in Hookpost, up to ${HOOKPOST.channel} on Hookpost.`)}
            {setupNotes.length ? ` What needs more than a sign-in: ${setupNotes.join('; ')}.` : ''}
          </li>
          <li>
            Rebuild what is queued in {c.name}. Hookpost has no CSV import, so copy upcoming posts into the editor, which shares
            one text across channels with per-network edits. On the Hookpost plan you can script it instead with the{' '}
            <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">API or CLI</Link>, or ask an AI
            assistant through <Link href="/mcp" className="text-hp-primary-text underline">MCP</Link>.
          </li>
          <li>Set posting times for each channel, so new posts take the next free slot.</li>
          <li>
            Keep {c.name} until its queue has gone out, then cancel it
            {c.cheapestPaid?.billing === 'annual' ? `. Its headline price is a yearly rate, so if you pay ${c.name} yearly, time the move for your renewal date` : ''}.
          </li>
        </ol>
      </div>
      ) : null}
    </section>
  );
};
