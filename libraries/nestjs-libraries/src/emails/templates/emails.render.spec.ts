/**
 * Auth, team, support, agency and notification emails: each one renders in
 * the shared layout with its link, a matching plain-text part, the right
 * footer for its kind, and escapes whatever a user typed (workspace names,
 * names, messages). Billing emails have their own spec
 * (services/razorpay.billing-emails.spec.ts).
 */
import {
  activationEmail,
  loginChangedEmail,
  passwordResetEmail,
  teamInviteEmail,
  workspacesRemovedEmail,
} from './auth.emails';
import { notificationEmail } from './notification.email';
import { agencyListedEmail } from './agency.emails';
import {
  supportAutoReplyEmail,
  supportInternalEmail,
  supportReplyEmail,
  supportSubject,
  supportTicketRef,
} from './support.emails';
import {
  EMAIL_BRAND,
  isRenderedEmail,
  RenderedEmail,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';

const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
beforeEach(() => {
  process.env.FRONTEND_URL = 'https://app.example.test/';
});
afterAll(() => {
  if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
});

const HOSTILE = `<img src=x onerror="alert(1)">&'"`;

function expectWellFormed(email: RenderedEmail, opts: { userTyped?: boolean } = {}) {
  expect(email.subject.length).toBeGreaterThan(0);
  expect(isRenderedEmail(email.html)).toBe(true);
  expect(email.html).toMatch(/^<!DOCTYPE html>/);
  expect(email.html).toContain(EMAIL_BRAND.supportEmail);
  expect(email.html).toContain(EMAIL_BRAND.legalLine);
  // The plain-text part exists and ends with a newline. It has no markup of
  // ours; text a user typed stays as typed there (text/plain is not HTML).
  expect(email.text.trim().length).toBeGreaterThan(20);
  if (!opts.userTyped) expect(email.text).not.toMatch(/<[a-z][^>]*>/i);
  expect(email.text.endsWith('\n')).toBe(true);
  // Never the proprietorship's legal name or a street address on anything
  // public (founder's rule).
  expect(email.html + email.text).not.toMatch(/JR Consulting/i);
  expect(email.html).not.toMatch(/\b\d+\s*,?\s*(road|marg|street|lane)\b/i);
}

describe('auth emails', () => {
  it('activation: the confirm link as a button, as a fallback link and in the text part', () => {
    const url = 'https://app.example.test/auth/activate/abc123';
    const email = activationEmail({ activationUrl: url });
    expectWellFormed(email);
    expect(email.subject).toBe('Confirm your email for Hookpost');
    expect(email.html.split(`href="${url}"`).length - 1).toBe(2);
    expect(email.text).toContain(`Confirm email: ${url}`);
    // Transactional mail has no unsubscribe or preferences link.
    expect(email.html).not.toContain('Unsubscribe');
    expect(email.html).not.toContain('Email preferences');
  });

  it('activation: says the account already works, how long the link lasts, and that it signs in anywhere', () => {
    const email = activationEmail({ activationUrl: 'https://app.example.test/auth/activate/abc123' });
    expect(email.text).toContain('You can already connect your channels and plan posts.');
    expect(email.text).toContain('7 days');
    expect(email.text).toContain('signs you in on whichever phone or browser opens it');
    expect(activationEmail({ activationUrl: 'https://x.test/a', expiresInDays: 3 }).text).toContain('3 days');
  });

  it('password reset: says how long the link works', () => {
    const url = 'https://app.example.test/auth/forgot/tok';
    const email = passwordResetEmail({ resetUrl: url });
    expectWellFormed(email);
    expect(email.text).toContain('20 minutes');
    expect(email.text).toContain(`Reset password: ${url}`);
    expect(passwordResetEmail({ resetUrl: url, expiresInMinutes: 5 }).text).toContain('5 minutes');
  });

  it('a link with quotes cannot break out of its href', () => {
    const email = activationEmail({ activationUrl: 'https://x.test/a"><script>alert(1)</script>' });
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('team invite: escapes the workspace and inviter names everywhere in the HTML', () => {
    const email = teamInviteEmail({
      inviterName: HOSTILE,
      inviterEmail: 'owner@example.test',
      orgName: HOSTILE,
      inviteUrl: 'https://app.example.test/?org=token',
    });
    expectWellFormed(email, { userTyped: true });
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(email.text).toContain('Accept invitation: https://app.example.test/?org=token');
    expect(email.text).toContain('expires in 2 days');
  });

  it('team invite without an inviter name uses the email', () => {
    const email = teamInviteEmail({
      inviterEmail: 'owner@example.test',
      orgName: 'Acme',
      inviteUrl: 'https://app.example.test/?org=t',
    });
    expect(email.subject).toBe('owner@example.test invited you to join "Acme"');
  });

  it('sign-in email changed: each recipient sees their own old and new address', () => {
    const changes = [
      { from: 'a@example.test', to: 'b@example.test' },
      { from: 'b@example.test', to: 'a@example.test' },
    ];
    const email = loginChangedEmail({ changes, recipient: 'A@example.test' });
    expectWellFormed(email);
    expect(email.html).toContain('Your account no longer signs in with a@example.test');
    expect(email.text).toContain('Signed in with a@example.test: now signs in with b@example.test');
    expect(email.text).toContain('Sign in: https://app.example.test/auth/login');
  });
});

describe('notification email (bare fragments from posts, digests, streaks)', () => {
  it('wraps a fragment: subject as the heading, links made clickable, one button to the app', () => {
    const email = notificationEmail('Your post was published', 'See it at https://x.com/i/status/1.');
    expectWellFormed(email);
    expect(email.html).toContain('<a href="https://x.com/i/status/1"');
    expect(email.text).toContain('Open Hookpost: https://app.example.test/launches');
    // Lifecycle mail carries the preferences link.
    expect(email.html).toContain('Email preferences');
    expect(email.html).toContain('href="https://app.example.test/settings"');
  });

  it('strips a whole <html> document passed as the fragment', () => {
    const email = notificationEmail(
      'Digest',
      '<!DOCTYPE html><html><head><title>x</title></head><body><p>Three posts went out.</p></body></html>'
    );
    expect(email.html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
    expect(email.text).toContain('Three posts went out.');
  });

  it('escapes the subject in the heading', () => {
    const email = notificationEmail(`Failed: ${HOSTILE}`, '<p>x</p>');
    expect(email.html).not.toContain('<img src=x');
  });

  it('an empty fragment still renders', () => {
    expectWellFormed(notificationEmail('Weekly digest', ''));
  });
});

describe('agency email', () => {
  it('escapes the agency name and falls back when there is none', () => {
    const email = agencyListedEmail({ agencyName: HOSTILE });
    expectWellFormed(email, { userTyped: true });
    expect(email.html).not.toContain('<img src=x');
    expect(agencyListedEmail({}).text).toContain('Your agency is now listed');
  });
});

describe('support emails', () => {
  it('ticket refs are stable, short and differ by salt', () => {
    const ref = supportTicketRef('row-1');
    expect(ref).toMatch(/^HP-[A-Z0-9]{4}$/);
    expect(supportTicketRef('row-1')).toBe(ref);
    expect(supportTicketRef('row-1', 1)).not.toBe(ref);
  });

  it('the subject keeps the ref so mail clients thread replies', () => {
    expect(supportSubject('HP-ABCD', 'Billing')).toBe('Billing: your message to Hookpost [HP-ABCD]');
    expect(supportSubject('HP-ABCD')).toBe('your message to Hookpost [HP-ABCD]');
  });

  it('auto-reply: only a first name from the sender, never their message', () => {
    const email = supportAutoReplyEmail({ ref: 'HP-ABCD', name: 'Asha Rao', topic: 'Billing' });
    expectWellFormed(email);
    expect(email.text).toContain('Hi Asha, thanks');
    expect(email.text).toContain('HP-ABCD');
  });

  it('reply: escapes the reply and the quoted original, and trims a long original', () => {
    const email = supportReplyEmail({
      ref: 'HP-ABCD',
      name: HOSTILE,
      reply: `Line one\n${HOSTILE}`,
      originalMessage: 'x'.repeat(2000),
    });
    expectWellFormed(email, { userTyped: true });
    expect(email.subject).toBe('Re: your message to Hookpost [HP-ABCD]');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('Line one<br />');
    expect(email.html).toContain('x'.repeat(1500) + '…');
    expect(email.html).not.toContain('x'.repeat(1501));
  });

  it('internal copy: the admin template, the message quoted and escaped, a button to the ticket', () => {
    const copy = supportInternalEmail({
      ref: 'HP-ABCD',
      email: 'c@example.test',
      topic: 'Other',
      message: `hello ${HOSTILE}`,
      adminUrl: 'https://app.example.test/admin/contact',
    });
    expectWellFormed(copy, { userTyped: true });
    expect(copy.subject).toBe('Support HP-ABCD: Other · c@example.test');
    expect(copy.html).toContain('href="https://app.example.test/admin/contact"');
    expect(copy.html).not.toContain('<img src=x');
    expect(copy.text).toContain('Open the ticket: https://app.example.test/admin/contact');
    expect(copy.text).toContain('Name: (no name)');
    expect(copy.text).toContain('Email: c@example.test');
  });
});

// Final review of 733294f78: a workspace name is whatever its maker typed,
// so the takeover notice never carries one (a URL in it would be a phishing
// line in a Hookpost email); it only says how many.
describe('workspacesRemovedEmail', () => {
  it('says how many, and asks the team to invite again', () => {
    const one = workspacesRemovedEmail({ count: 1 });
    expectWellFormed(one);
    expect(one.text).toContain('1 shared workspace');
    expect(one.text).toContain('ask them to invite you again');
    expect(workspacesRemovedEmail({ count: 3 }).text).toContain('3 shared workspaces');
  });

  it('takes no names at all', () => {
    // @ts-expect-error: there is no field for names
    const email = workspacesRemovedEmail({ count: 1, workspaces: ['Verify at https://evil.example'] });
    expect(email.html + email.text).not.toContain('evil.example');
  });
});

// Final review of 733294f78: an invitee held out of the team until they
// confirm is told which team waits, in plain text that cannot become a link.
describe('activationEmail: the held team invite', () => {
  const url = 'https://app.example.test/auth/activate/abc123';

  it("says which team, before the rest", () => {
    const email = activationEmail({ activationUrl: url, invitedTo: 'Acme Social' });
    expectWellFormed(email);
    expect(email.text).toContain("You've been invited to Acme Social. Confirm your email to join.");
  });

  it('no invite, no line', () => {
    expect(activationEmail({ activationUrl: url }).text).not.toContain('invited to');
    expect(activationEmail({ activationUrl: url, invitedTo: null }).text).not.toContain('invited to');
  });

  it('a hostile name is escaped, cut to 60 characters, and never a link', () => {
    const email = activationEmail({
      activationUrl: url,
      invitedTo: '<img src=x> Verify at https://evil.example/login now, or mail help@evil.example and more text past sixty',
    });
    expect(email.html).not.toContain('<img src=x>');
    expect(email.html).toContain('&lt;img src=x&gt;');
    // No URL or address survives in one piece for a linkifier to find.
    expect(email.html + email.text).not.toMatch(/https:\/\/evil\.example|evil\.example\/login|help@evil/);
    expect(email.html).not.toMatch(/href="[^"]*evil/);
    // Two links, both the confirm link, as without an invite.
    expect(email.html.split(`href="${url}"`).length - 1).toBe(2);
    expect(email.text).not.toContain('sixty');
  });
});
