/**
 * Nothing on the site offers the Chrome extension until it is in the Chrome
 * Web Store: every link to it renders only when NEXT_PUBLIC_CHROME_EXTENSION_URL
 * is set, and points there.
 *   pnpm exec jest -c apps/frontend/jest.config.ts chrome.extension.url
 */
import { parseChromeExtensionUrl } from '@hookpost/frontend/components/layout/chrome.extension.url';

const LISTING = 'https://chromewebstore.google.com/detail/hookpost/abcdefghijklmnopabcdefghijklmnop';

describe('parseChromeExtensionUrl', () => {
  it.each([
    [LISTING],
    ['https://chrome.google.com/webstore/detail/hookpost/abcdefghijklmnopabcdefghijklmnop'],
  ])('accepts the listing %s', (url) => {
    expect(parseChromeExtensionUrl(url)).toBe(url);
  });

  it('trims whitespace from the .env value', () => {
    expect(parseChromeExtensionUrl(`  ${LISTING}\n`)).toBe(LISTING);
  });

  it.each([
    [undefined],
    [''],
    ['   '],
    ['not a url'],
    // The store's front page, which is where /download used to send people.
    ['https://chrome.google.com/webstore'],
    ['https://chromewebstore.google.com/'],
    ['http://chromewebstore.google.com/detail/hookpost/abc'],
    ['https://chromewebstore.google.com.evil.example/detail/x'],
    ['https://evil.example/detail/hookpost'],
    ['javascript:alert(1)'],
    // The extension of the project this one was forked from.
    ['https://chromewebstore.google.com/detail/x/cidhffagahknaeodkplfbcpfeielnkjl'],
  ])('rejects %j', (url) => {
    expect(parseChromeExtensionUrl(url as string | undefined)).toBeUndefined();
  });
});

/** Loads the modules fresh with NEXT_PUBLIC_CHROME_EXTENSION_URL set to `url`. */
function renderWith(url: string | undefined) {
  const before = process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
  if (url === undefined) delete process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
  else process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL = url;
  try {
    let out: Record<string, string> = {};
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const React = require('react');
      // The Node build: the default (browser) one needs MessageChannel, which jsdom lacks.
      const { renderToString } = require('react-dom/server.node');
      const { ChromeExtensionComponent } = require('@hookpost/frontend/components/layout/chrome.extension.component');
      const { SiteFooter } = require('@hookpost/frontend/app/(landing)/site-footer');
      const download = require('@hookpost/frontend/app/(landing)/download/page');
      const { DownloadHero } = require('@hookpost/frontend/app/(landing)/download/DownloadHero');
      /* eslint-enable @typescript-eslint/no-var-requires */
      out = {
        header: renderToString(React.createElement(ChromeExtensionComponent)),
        footer: renderToString(React.createElement(SiteFooter)),
        download: renderToString(React.createElement(download.default)),
        hero: renderToString(React.createElement(DownloadHero)),
        meta: JSON.stringify(download.metadata),
      };
    });
    return out;
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
    else process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL = before;
  }
}

describe('with NEXT_PUBLIC_CHROME_EXTENSION_URL unset', () => {
  const html = renderWith(undefined);

  it('the header shows no Chrome icon', () => {
    expect(html.header).toBe('');
  });

  it('/download has no Chrome card, store link or extension claim', () => {
    for (const text of [html.download, html.hero, html.meta]) {
      expect(text).not.toMatch(/chrome extension|browser extension|Add to Chrome|webstore|chromewebstore/i);
    }
    // The rest of the page is still there.
    expect(html.download).toContain('AI Agent &amp; Developer MCP');
    expect(html.download).toMatch(/iOS(<!-- -->)? and the Web App/);
  });

  it('the footer has no Add to Chrome link', () => {
    expect(html.footer).not.toContain('Add to Chrome');
    expect(html.footer).not.toContain('chromewebstore');
  });

  it('/download no longer says "Zero Postiz traces" or "Free"', () => {
    expect(html.download).not.toMatch(/postiz/i);
    expect(html.download).not.toContain('(Free)');
  });
});

describe('with NEXT_PUBLIC_CHROME_EXTENSION_URL set to the listing', () => {
  const html = renderWith(LISTING);

  it('the header icon links to the listing', () => {
    expect(html.header).toContain(`href="${LISTING}"`);
    expect(html.header).toContain('rel="noopener noreferrer"');
  });

  it('/download has an Add to Chrome link to the listing', () => {
    expect(html.download).toContain('Chrome Extension');
    expect(html.download).toMatch(new RegExp(`href="${LISTING}"[^>]*>Add to Chrome<`));
    expect(html.download).toContain('Skool');
    expect(html.download).not.toMatch(/postiz|\(Free\)/i);
    expect(html.hero).toContain('Chrome extension');
    expect(html.meta).toContain('Chrome extension');
  });

  it('the footer has an Add to Chrome link to the listing', () => {
    expect(html.footer).toMatch(new RegExp(`href="${LISTING}"[^>]*>Add to Chrome<`));
  });
});

describe('with a URL that is not a store listing', () => {
  const html = renderWith('https://chrome.google.com/webstore');

  it('shows nothing, as if unset', () => {
    expect(html.header).toBe('');
    expect(html.download).not.toContain('Add to Chrome');
    expect(html.footer).not.toContain('Add to Chrome');
  });
});
