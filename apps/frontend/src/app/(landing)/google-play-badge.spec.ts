/**
 * The marketing pages must not send visitors to the Play app while a new
 * account made there has no way forward (see PLAY_BADGE_ON_SITE).
 *   pnpm exec jest -c apps/frontend/jest.config.ts google-play-badge
 */
import React from 'react';
// The Node build: the default (browser) one needs MessageChannel, which jsdom lacks.
import { renderToString } from 'react-dom/server.node';
import {
  GooglePlayBadge,
  PLAY_BADGE_ON_SITE,
} from '@hookpost/frontend/app/(landing)/google-play-badge';
import { SiteFooter } from '@hookpost/frontend/app/(landing)/site-footer';

describe('Google Play badge on the marketing pages', () => {
  it('is switched off', () => {
    expect(PLAY_BADGE_ON_SITE).toBe(false);
  });

  it.each<['hero' | 'footer']>([['hero'], ['footer']])(
    'renders nothing in the %s',
    (medium) => {
      const html = renderToString(
        React.createElement(GooglePlayBadge, { medium, className: 'x' })
      );
      expect(html).toBe('');
    }
  );

  it('leaves the footer with no Play link, badge image or empty list item', () => {
    const html = renderToString(React.createElement(SiteFooter));
    expect(html).not.toContain('play.google.com');
    expect(html).not.toContain('Get it on Google Play');
    expect(html).not.toMatch(/<li><\/li>/);
    // The Product column itself is still there.
    expect(html).toContain('href="/mcp"');
  });
});
