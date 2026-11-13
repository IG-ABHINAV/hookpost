import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { offer, TRIAL_CTA } from '../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Hookpost OAuth Apps — Let Other People Connect Their Account',
  description:
    'Build an integration that connects to other people’s Hookpost accounts. Authorization Code flow with PKCE, scoped access tokens, and no shared API keys.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/docs/oauth',
  },
});

const BASE = 'https://hookpost.hookstep.in/api';

// One list for the HowTo markup, the visible summary and the step headings, so
// the structured data never says something the page does not.
const OAUTH_STEPS = [
  { name: 'Register your application', text: 'Create an OAuth app in Settings → Developers → Apps, store the client id and client secret, and register every redirect URI you will use.' },
  { name: 'Send the user to authorize', text: 'Redirect the user to /api/oauth/authorize with your client id, redirect URI and a PKCE code challenge.' },
  { name: 'Exchange the code for a token', text: 'POST the returned code to /api/oauth/token together with your code verifier to receive an access token.' },
  { name: 'Call the API as that user', text: 'Send the access token in the Authorization header of any Public API request.' },
];

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-xl border border-hp-border bg-white/[0.03] p-4 text-xs leading-relaxed font-mono text-hp-text/90">
    {children}
  </pre>
);

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div className="space-y-3">
    <div className="flex items-center gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-hp-primary text-hp-on-primary text-sm font-black">
        {n}
      </span>
      <h3 className="text-lg font-bold text-hp-text">{title}</h3>
    </div>
    <div className="space-y-3 pl-10">{children}</div>
  </div>
);

export default function OAuthDocsPage() {
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in' },
      { '@type': 'ListItem', position: 2, name: 'Docs', item: 'https://hookpost.hookstep.in/docs/public-api' },
      { '@type': 'ListItem', position: 3, name: 'OAuth Apps', item: 'https://hookpost.hookstep.in/docs/oauth' },
    ],
  };

  const howToSchema = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: 'How to Build a Hookpost OAuth Integration',
    description:
      'Register an OAuth application, send users through the authorization screen, exchange the code for an access token, and call the Hookpost Public API on their behalf.',
    step: OAUTH_STEPS.map((s) => ({ '@type': 'HowToStep', name: s.name, text: s.text })),
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        ⚡ Developer Docs — Let other people connect their Hookpost account to your product
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" aria-label="Hookpost home" className="flex items-center gap-2 shrink-0">
          <img alt="" src="/brand-logo-96.webp" width="96" height="96" className="h-8 md:h-10 w-auto max-h-[38px] object-contain" />
          {/* Icon only on phones: the wordmark and both buttons need ~365px. */}<span className="hidden sm:inline text-2xl font-black tracking-tight text-hp-text">
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
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[860px] mx-auto px-6 pt-10 pb-24 space-y-12">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li><Link href="/docs/public-api" className="hover:text-hp-text transition-colors">Docs</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">OAuth Apps</li>
          </ol>
        </nav>

        <div className="space-y-4">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            OAuth 2.0 · Authorization Code + PKCE
          </div>
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-hp-text leading-tight">
            Hookpost <span className="text-hp-primary-text">OAuth Apps</span>
          </h1>
          <p className="text-hp-text-2 text-lg leading-relaxed article-summary">
            An API key works for your own account. An OAuth app is what you build when other people need to connect
            <em> their </em> Hookpost account to your product — they approve access on a Hookpost screen and you never
            handle their credentials.
          </p>
        </div>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Which one do I need?</h2>
          <div className="overflow-x-auto rounded-xl border border-hp-border">
            <table className="w-full text-sm min-w-[520px]">
              <tbody>
                <tr className="border-b border-hp-border">
                  <td className="py-3 px-4 align-top font-semibold text-hp-text w-[190px]">Your own account only</td>
                  <td className="py-3 px-4 text-hp-text-2">
                    Use an API key —{' '}
                    <Link href="/docs/public-api" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Public API docs</Link>.
                    Simpler, no flow to implement.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 px-4 align-top font-semibold text-hp-text">Other people&apos;s accounts</td>
                  <td className="py-3 px-4 text-hp-text-2">Use OAuth — this page. Never ask a user for their API key.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-8">
          <h2 className="text-2xl font-bold text-hp-text">The flow</h2>
          <ol className="list-decimal space-y-2 ps-5 text-hp-text-2 leading-relaxed">
            {OAUTH_STEPS.map((s) => (
              <li key={s.name}>
                <strong className="text-hp-text">{s.name}.</strong> {s.text}
              </li>
            ))}
          </ol>

          <Step n={1} title={OAUTH_STEPS[0].name}>
            <p className="text-hp-text-2 leading-relaxed">
              In Hookpost, open <strong className="text-hp-text">Settings → Developers → Apps</strong> and create an OAuth
              application. You will get a client id beginning{' '}
              <code className="text-hp-text font-mono text-sm">pca_</code> and a client secret. Store the secret
              server-side — it is shown once.
            </p>
            <p className="text-hp-text-2 leading-relaxed">
              Register every redirect URI you will use. The authorize step rejects any redirect that is not an exact
              match.
            </p>
          </Step>

          <Step n={2} title={OAUTH_STEPS[1].name}>
            <p className="text-hp-text-2 leading-relaxed">
              Redirect the user to the authorize screen. Generate a PKCE{' '}
              <code className="text-hp-text font-mono text-sm">code_verifier</code>, hash it with SHA-256 and send the
              base64url result as the <code className="text-hp-text font-mono text-sm">code_challenge</code>. Only{' '}
              <code className="text-hp-text font-mono text-sm">S256</code> is supported.
            </p>
            <Code>{`GET ${BASE}/oauth/authorize
  ?client_id=pca_YOUR_CLIENT_ID
  &redirect_uri=https://yourapp.com/callback
  &response_type=code
  &scope=mcp:read%20mcp:write
  &state=RANDOM_STRING
  &code_challenge=BASE64URL_SHA256_OF_VERIFIER
  &code_challenge_method=S256`}</Code>
            <p className="text-hp-text-2 leading-relaxed">
              The user approves, and Hookpost redirects back to your{' '}
              <code className="text-hp-text font-mono text-sm">redirect_uri</code> with{' '}
              <code className="text-hp-text font-mono text-sm">?code=…&amp;state=…</code>. Check that{' '}
              <code className="text-hp-text font-mono text-sm">state</code> matches what you sent.
            </p>
          </Step>

          <Step n={3} title={OAUTH_STEPS[2].name}>
            <Code>{`curl -X POST "${BASE}/oauth/token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "grant_type": "authorization_code",
    "code": "CODE_FROM_REDIRECT",
    "client_id": "pca_YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "redirect_uri": "https://yourapp.com/callback",
    "code_verifier": "YOUR_ORIGINAL_VERIFIER"
  }'`}</Code>
            <p className="text-hp-text-2 leading-relaxed">You get back a bearer token:</p>
            <Code>{`{
  "access_token": "pos_...",
  "token_type": "bearer"
}`}</Code>
          </Step>

          <Step n={4} title={OAUTH_STEPS[3].name}>
            <p className="text-hp-text-2 leading-relaxed">
              Send the token in the <code className="text-hp-text font-mono text-sm">Authorization</code> header of any{' '}
              <Link href="/docs/public-api" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Public API</Link> request — same
              header as an API key, no <code className="text-hp-text font-mono text-sm">Bearer</code> prefix.
            </p>
            <Code>{`curl "${BASE}/public/v1/integrations" \\
  -H "Authorization: pos_YOUR_ACCESS_TOKEN"`}</Code>
            <p className="text-hp-text-2 leading-relaxed">
              Requests run against the account that granted access — their channels, their posts.
            </p>
          </Step>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Scopes</h2>
          <div className="overflow-x-auto rounded-xl border border-hp-border">
            <table className="w-full text-sm min-w-[460px]">
              <tbody>
                <tr className="border-b border-hp-border">
                  <td className="py-3 px-4 font-mono text-xs text-hp-primary-text w-[130px]">mcp:read</td>
                  <td className="py-3 px-4 text-hp-text-2">Read channels, posts and analytics</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-mono text-xs text-hp-primary-text">mcp:write</td>
                  <td className="py-3 px-4 text-hp-text-2">Create, update and delete posts</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-hp-text-2 leading-relaxed">
            Request only what you use. An integration that just reads analytics should not ask for{' '}
            <code className="text-hp-text font-mono text-sm">mcp:write</code>.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Userinfo</h2>
          <p className="text-hp-text-2 leading-relaxed">
            To identify the account behind a token:
          </p>
          <Code>{`curl "${BASE}/oauth/userinfo" \\
  -H "Authorization: pos_YOUR_ACCESS_TOKEN"`}</Code>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Dynamic client registration</h2>
          <p className="text-hp-text-2 leading-relaxed">
            Hookpost supports OAuth Dynamic Client Registration at{' '}
            <code className="text-hp-text font-mono text-sm">/api/oauth/register</code>, used mainly by AI clients that
            register themselves. Those clients get a{' '}
            <code className="text-hp-text font-mono text-sm">pcd_</code> client id and{' '}
            <strong className="text-hp-text">must</strong> use PKCE.
          </p>
          <p className="text-hp-text-2 leading-relaxed">
            Registration is restricted to an allowlist of domains, so it is not open to the public internet. If you are
            building a normal integration, register in the dashboard instead — step 1 above.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Notes worth reading twice</h2>
          <ul className="space-y-2 text-hp-text-2 leading-relaxed list-disc pl-5">
            <li>The <code className="text-hp-text font-mono text-sm">Authorization</code> header takes the raw token — there is no <code className="text-hp-text font-mono text-sm">Bearer</code> prefix.</li>
            <li>Redirect URIs must match exactly, including scheme, host, port and path.</li>
            <li>If a token returns <code className="text-hp-text font-mono text-sm">401 No subscription found</code>, that account needs an active plan — a new token will not help.</li>
            <li>Client secrets belong on your server. A public client (mobile, browser) should rely on PKCE alone.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-hp-text">Related</h2>
          <p className="text-hp-text-2 leading-relaxed">
            <Link href="/docs/public-api" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Public API reference</Link> ·{' '}
            <Link href="/mcp" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">MCP connector</Link> ·{' '}
            <Link href="/guides/claude-mcp-social-media" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">Claude setup guide</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
