import type { Metadata } from 'next';

const SITE_NAME = 'Hookpost';
const OG_IMAGE = {
  url: 'https://hookpost.hookstep.in/og-image.png',
  width: 1200,
  height: 630,
  alt: 'Hookpost social media scheduler',
};

const text = (v: Metadata['title'] | Metadata['description']) =>
  typeof v === 'string'
    ? v
    : v && typeof v === 'object' && 'absolute' in v
    ? v.absolute
    : v && typeof v === 'object' && 'default' in v
    ? v.default
    : undefined;

/**
 * Fills a page's Open Graph and Twitter tags from its own title, description
 * and canonical URL.
 *
 * Next.js does not derive og:* from <title>. A page without its own
 * `openGraph` inherits the landing layout's, which describes the HOMEPAGE - so
 * 62 pages (every /channels and /for page, most /alternatives, the docs, the
 * legal pages) shared as the homepage card with og:url pointing at "/", and
 * scrapers that treat og:url as canonical credited the share to the homepage.
 * Next also replaces, not merges, a page's `openGraph`, so a page that set one
 * without `images` had no og:image at all. Only missing fields are filled;
 * anything a page sets itself wins.
 */
export function withSocial(meta: Metadata): Metadata {
  const title = text(meta.title);
  const description = text(meta.description);
  const canonical = meta.alternates?.canonical;
  const url =
    typeof canonical === 'string'
      ? canonical
      : canonical instanceof URL
      ? canonical.toString()
      : canonical && typeof canonical === 'object' && 'url' in canonical
      ? String(canonical.url)
      : undefined;

  const og = meta.openGraph || {};
  const tw = meta.twitter || {};
  return {
    ...meta,
    openGraph: {
      siteName: SITE_NAME,
      type: 'website',
      locale: 'en_US',
      ...og,
      title: og.title ?? title,
      description: og.description ?? description,
      url: og.url ?? url,
      images: og.images ?? [OG_IMAGE],
    } as Metadata['openGraph'],
    twitter: {
      card: 'summary_large_image',
      ...tw,
      title: tw.title ?? (og.title as string | undefined) ?? title,
      description: tw.description ?? (og.description as string | undefined) ?? description,
      images: tw.images ?? [OG_IMAGE.url],
    } as Metadata['twitter'],
  };
}
