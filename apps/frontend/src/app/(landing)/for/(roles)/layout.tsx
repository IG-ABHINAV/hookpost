import Link from 'next/link';
import { ROLE_LINKS } from '../personas';

// Wraps only the fifteen role pages (the (roles) group does not change their
// URLs), not the /for hub, which already lists every role as a card.
// Server-rendered links only - no client JS on marketing pages.
export default function RolesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <nav aria-label="Hookpost for other roles" className="border-t border-hp-border bg-hp-bg">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-10 sm:px-10">
          <h2 className="text-sm font-bold uppercase tracking-wider text-hp-text/60">
            Hookpost for other roles
          </h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {ROLE_LINKS.map(({ slug, label }) => (
              <li key={slug}>
                <Link
                  href={`/for/${slug}`}
                  prefetch={false}
                  className="inline-block rounded-full border border-hp-border-strong px-3 py-1.5 text-sm text-hp-text/75 hover:border-hp-primary hover:text-hp-text"
                >
                  {label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/for"
                prefetch={false}
                className="inline-block rounded-full px-3 py-1.5 text-sm text-hp-primary-text underline"
              >
                All roles
              </Link>
            </li>
          </ul>
        </div>
      </nav>
    </>
  );
}
