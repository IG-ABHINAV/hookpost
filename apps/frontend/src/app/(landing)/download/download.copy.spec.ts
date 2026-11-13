/**
 * /download offers no file: there is no .dmg, .exe or APK in any release, so
 * the buttons say they lead to sign-up and the page says Hookpost runs in the
 * browser (2 Nov 2026 UI sweep, part 2).
 *   pnpm exec jest -c apps/frontend/jest.config.ts download.copy
 */
import React from 'react';
// The Node build: the default (browser) one needs MessageChannel, which jsdom lacks.
import { renderToString } from 'react-dom/server.node';
import DownloadPage, { metadata } from './page';
import { DownloadHero } from './DownloadHero';

const page = renderToString(React.createElement(DownloadPage));
const hero = renderToString(React.createElement(DownloadHero, { offerNote: 'x' }));
const meta = JSON.stringify(metadata);

describe('/download copy', () => {
  it('promises no installer file anywhere', () => {
    for (const text of [page, hero, meta]) {
      expect(text).not.toMatch(/\.dmg|\.exe|\bAPK\b|installer \(|Download for (Mac|Windows)/i);
    }
  });

  it('no button label starts with "Download"', () => {
    const labels = [...page.matchAll(/<a [^>]*href="\/auth"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).not.toMatch(/^download/i);
      expect(label).toMatch(/sign up|launch/i);
    }
  });

  it('says plainly that it runs in the browser', () => {
    expect(page).toContain('There is no Mac download yet');
    expect(page).toContain('There is no Windows download yet');
    expect(page).toContain('Is there a Mac or Windows app to download?');
    expect(hero).toContain('Runs in your browser');
  });
});
