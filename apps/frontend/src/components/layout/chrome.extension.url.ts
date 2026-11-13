/**
 * The Hookpost extension's Chrome Web Store listing, or undefined while it is
 * not published. Every "Add to Chrome" / "Install Extension" control renders
 * only when this is set, and links here: the header icon
 * (chrome.extension.component.tsx), the "Extension Not Found" dialog, /download
 * and the site footer.
 *
 * Set NEXT_PUBLIC_CHROME_EXTENSION_URL in the VM's .env to the listing's URL
 * (https://chromewebstore.google.com/detail/...). Next inlines it at build
 * time, so it takes effect on the next deploy.
 */

// Read at module scope on purpose: Next folds process.env.NEXT_PUBLIC_* into a
// literal only here. Read inside a function or event handler it is undefined
// in the browser, which is why "Install Extension" used to do nothing (the
// same bug silenced view-content.tracker.tsx in Sep 2026).
const RAW = process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;

// The extension ID of the project this one was forked from: never link to it.
const UPSTREAM_EXTENSION_ID = 'cidhffagahknaeodkplfbcpfeielnkjl';

/** A Chrome Web Store listing URL, or undefined for anything else. */
export function parseChromeExtensionUrl(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const isStore =
    url.protocol === 'https:' &&
    ((url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/')) ||
      (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore/detail/')));
  if (!isStore || url.href.includes(UPSTREAM_EXTENSION_ID)) return undefined;
  return url.href;
}

export const CHROME_EXTENSION_URL = parseChromeExtensionUrl(RAW);
