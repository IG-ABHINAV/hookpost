import {
  appUrl,
  buildEmail,
  button,
  callout,
  EMAIL_BRAND,
  escapeAttr,
  escapeHtml,
  link,
  paragraph,
  RenderedEmail,
  steps,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';

/**
 * The one template every email to the owner or the support inbox uses: sale
 * alerts (owner.sales.alert.email.ts), billing notes that need a person
 * (RazorpayService.sendSupportAlert), the support-form copy and the Billing
 * cancel note.
 *
 * Same layout as the customer emails (logo, card, footer), with a headline,
 * a one-line summary, optional notes, a key-facts table, one button to the
 * admin record and a plain-text part written out line by line.
 *
 * Every value passed in is plain text and is escaped here. Only `href`s are
 * links, and only http(s) or mailto ones are kept.
 */

/**
 * - live: real money from a real customer; no badge.
 * - test: fake money (a Razorpay test key, a provider's test purchase).
 * - internal: real money on a live key, from a workspace that is ours.
 */
export type AlertMode = 'live' | 'test' | 'internal';

export interface AlertFact {
  label: string;
  value: string;
  /** Makes the value a link (http, https or mailto only). */
  href?: string | null;
}

export interface AdminAlertInput {
  subject: string;
  /** "Renewal paused: Standard monthly, ₹599". */
  headline: string;
  /** One or two sentences: what happened, in words. */
  summary: string;
  mode?: AlertMode;
  /** Why it is a test ("Razorpay test key"), shown next to the badge. */
  modeDetail?: string | null;
  /** Shown as an amber "Needs a look" badge. */
  needsAction?: boolean;
  /** Short lines written by our code, shown as a list under the summary. */
  notes?: string[];
  /** A quoted block, for text someone typed (a support message). */
  quote?: { label: string; text: string } | null;
  facts?: AlertFact[];
  primary?: { label: string; url: string } | null;
  secondary?: Array<{ label: string; url: string }>;
  /** Why this email arrived, in the footer and at the end of the text part. */
  reason: string;
}

const FONT = EMAIL_BRAND.font;

function safeHref(url?: string | null): string | null {
  const u = String(url || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

function badge(label: string, tone: 'grey' | 'amber' | 'brand'): string {
  const t = {
    grey: { bg: '#F3F4F6', border: '#E5E7EB', fg: '#4B5563' },
    amber: { bg: '#FFFBEB', border: '#FDE68A', fg: '#92400E' },
    // the brand tint: the active theme's colour (brand-themes.ts) on its panel
    brand: { bg: EMAIL_BRAND.colors.panel, border: EMAIL_BRAND.colors.border, fg: EMAIL_BRAND.colors.primary },
  }[tone];
  return `<span data-hp-badge style="display:inline-block;margin:0 6px 0 0;padding:2px 9px;border:1px solid ${t.border};border-radius:999px;background-color:${t.bg};font-family:${FONT};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;color:${t.fg};">${escapeHtml(
    label
  )}</span>`;
}

/** The badge words, also used by the text part and the tests. */
export function modeBadgeLabel(mode: AlertMode | undefined): string | null {
  if (mode === 'test') return 'Test mode';
  if (mode === 'internal') return 'Internal workspace';
  return null;
}

function factsTable(facts: AlertFact[]): string {
  const C = EMAIL_BRAND.colors;
  const rows = facts
    .map((f, i) => {
      const border = i < facts.length - 1 ? `border-bottom:1px solid ${C.border};` : '';
      const href = safeHref(f.href);
      const value = href
        ? `<a href="${escapeAttr(href)}" style="color:${C.primary};text-decoration:underline;">${escapeHtml(
            f.value
          )}</a>`
        : escapeHtml(f.value);
      return `<tr>
<td data-hp-label style="width:38%;padding:9px 14px;${border}font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};" valign="top">${escapeHtml(
        f.label
      )}</td>
<td style="padding:9px 14px;${border}font-family:${FONT};font-size:13px;line-height:20px;color:${C.text};font-weight:600;word-break:break-word;overflow-wrap:anywhere;" valign="top">${value}</td>
</tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin:4px 0 24px 0;border:1px solid ${C.border};border-radius:8px;border-collapse:separate;background-color:${C.panel};">${rows}</table>`;
}

export function adminAlertEmail(input: AdminAlertInput): RenderedEmail {
  const C = EMAIL_BRAND.colors;
  const facts = (input.facts || []).filter((f) => f && String(f.value || '').trim());
  const notes = (input.notes || []).map((n) => String(n || '').trim()).filter(Boolean);
  const modeLabel = modeBadgeLabel(input.mode);
  const primaryHref = input.primary ? safeHref(input.primary.url) : null;
  const secondary = (input.secondary || [])
    .map((s) => ({ label: s.label, url: safeHref(s.url) }))
    .filter((s): s is { label: string; url: string } => !!s.url);

  const badges: string[] = [];
  if (input.needsAction) badges.push(badge('Needs a look', 'amber'));
  if (modeLabel) badges.push(badge(modeLabel, input.mode === 'test' ? 'grey' : 'brand'));
  const badgeRow = badges.length
    ? `<p style="margin:0 0 12px 0;line-height:16px;">${badges.join('')}${
        input.mode === 'test' && input.modeDetail
          ? `<span style="font-family:${FONT};font-size:12px;line-height:16px;color:${C.faint};">${escapeHtml(
              input.modeDetail
            )}</span>`
          : ''
      }</p>`
    : '';

  const parts: string[] = [
    badgeRow,
    `<h1 style="margin:0 0 10px 0;font-family:${FONT};font-size:20px;line-height:28px;font-weight:700;color:${C.heading};">${escapeHtml(
      input.headline
    )}</h1>`,
    paragraph(escapeHtml(input.summary)),
  ];
  if (notes.length) parts.push(steps(notes.map((n) => escapeHtml(n))));
  if (input.quote && input.quote.text.trim()) {
    parts.push(
      callout(
        `<span style="font-size:12px;color:${C.muted};">${escapeHtml(input.quote.label)}</span><br />${escapeHtml(
          input.quote.text
        ).replace(/\r?\n/g, '<br />')}`
      )
    );
  }
  if (facts.length) parts.push(factsTable(facts));
  if (primaryHref) parts.push(button(escapeHtml(input.primary!.label), primaryHref));
  if (secondary.length) {
    parts.push(
      paragraph(
        secondary.map((s) => link(escapeHtml(s.label), s.url)).join(' &nbsp;&middot;&nbsp; '),
        { small: true }
      )
    );
  }

  const preheader = input.summary.slice(0, 140);
  const built = buildEmail(input.subject, {
    preheader,
    body: parts.filter(Boolean).join('\n'),
    kind: 'transactional',
    reason: input.reason,
  });

  // The text part is written out rather than derived from the HTML, so it
  // reads as a short note: headline, summary, facts, links.
  const text: string[] = [input.headline];
  if (input.needsAction) text.push('Needs a look');
  if (modeLabel) {
    text.push(
      input.mode === 'test' && input.modeDetail ? `${modeLabel}: ${input.modeDetail}` : modeLabel
    );
  }
  text.push('', input.summary);
  if (notes.length) text.push('', ...notes.map((n) => `- ${n}`));
  if (input.quote && input.quote.text.trim()) {
    text.push('', `${input.quote.label}:`, input.quote.text.trim());
  }
  if (facts.length) {
    text.push('', ...facts.map((f) => `${f.label}: ${f.value}`));
  }
  const links = [
    ...(primaryHref ? [{ label: input.primary!.label, url: primaryHref }] : []),
    ...secondary,
  ];
  if (links.length) text.push('', ...links.map((l) => `${l.label}: ${l.url}`));
  text.push('', input.reason);

  return { subject: input.subject, html: built.html, text: text.join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// Smaller notes to the support inbox, in the same template.
// ---------------------------------------------------------------------------

/** One line of text someone typed: no control characters, capped. */
function oneLine(value: unknown, max: number): string {
  const s = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function adminUserUrl(orgId: string): string {
  return `${appUrl()}/admin/users?q=${encodeURIComponent(orgId)}`;
}

/** Billing → Cancel: the support inbox's copy, with the customer's reason. */
export function cancelNoteEmail(p: {
  orgName?: string | null;
  orgId: string;
  customerEmail?: string | null;
  feedback?: string | null;
}): RenderedEmail {
  const org = oneLine(p.orgName, 80) || 'A workspace';
  const feedback = String(p.feedback || '').trim().slice(0, 2000);
  return adminAlertEmail({
    subject: `Cancellation requested · ${org}`,
    headline: 'Cancellation requested',
    summary: `${org} pressed Cancel in Billing.`,
    quote: { label: 'Their reason', text: feedback || '(no reason given)' },
    facts: [
      { label: 'Workspace', value: org },
      { label: 'Email', value: oneLine(p.customerEmail, 120) },
      { label: 'Workspace id', value: oneLine(p.orgId, 64) },
    ],
    primary: { label: 'Open in admin', url: adminUserUrl(p.orgId) },
    reason: 'Sent to the support inbox when a customer cancels. Reply to reach the customer.',
  });
}
