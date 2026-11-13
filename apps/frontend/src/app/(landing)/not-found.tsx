import Link from 'next/link';
import { SiteNav } from './site-nav';

// What /channels/<nothing>, /alternatives/<nothing> and the other landing
// families answer with. It used to be Next's stock "This page could not be
// found" with no way out. Next still sends status 404 and `noindex` for this
// file, so only the dead end is fixed. (A completely unknown top-level URL has
// no layout to render in and still gets Next's built-in page.)
const WHERE_TO = [
  ['/pricing', 'Pricing'],
  ['/channels', 'Channels'],
  ['/guides', 'Guides'],
  ['/alternatives', 'Alternatives'],
  ['/mcp', 'AI agents and MCP'],
  ['/contact', 'Contact'],
] as const;

export default function NotFound() {
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm">
      <SiteNav />
      <section className="mx-auto w-full max-w-[720px] px-5 py-24 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">404</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta">This page does not exist</h1>
        <p className="mt-4 text-lg text-hp-text/70">
          The link may be old or mistyped. Try one of these, or go back to the{' '}
          <Link href="/" className="text-hp-primary-text underline">homepage</Link>.
        </p>
        <ul className="mt-8 flex flex-wrap gap-3">
          {WHERE_TO.map(([href, label]) => (
            <li key={href}>
              <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-5 py-2.5 font-semibold hover:border-hp-primary">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
