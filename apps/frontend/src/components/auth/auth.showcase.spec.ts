/**
 * The right half of the sign-in and sign-up pages (auth.showcase.tsx): what
 * it claims, and that it claims only what the homepage does.
 *   pnpm exec jest -c apps/frontend/jest.config.ts auth.showcase
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  AuthShowcase,
  SHOWCASE_NETWORKS,
  showcaseFacts,
} from '@hookpost/frontend/components/auth/auth.showcase';
import { PUBLISHABLE_CHANNEL_COUNT } from '@hookpost/frontend/app/(landing)/channels/channel-count';
import { CHANNEL_SPECS } from '@hookpost/frontend/app/(landing)/channels/channel-specs';
import { TRIAL_PRICE_AFTER } from '@hookpost/frontend/app/(landing)/trial-offer';

const PUBLIC = path.join(__dirname, '../../../public');
const SOURCE = fs.readFileSync(path.join(__dirname, 'auth.showcase.tsx'), 'utf8');

describe('AuthShowcase', () => {
  it('states the channel count and price from the same sources as the homepage', () => {
    const titles = showcaseFacts().map((f) => f.title);
    expect(titles).toContain(`${PUBLISHABLE_CHANNEL_COUNT} networks, one calendar`);
    expect(titles).toContain(`${TRIAL_PRICE_AFTER} a month, one flat price`);
    expect(TRIAL_PRICE_AFTER).toBe('$7');
  });

  it('shows each network logo with its name, and the rest as a count', () => {
    render(React.createElement(AuthShowcase));
    for (const n of SHOWCASE_NETWORKS) {
      expect(screen.getByAltText(n.name)).toBeTruthy();
    }
    const more = PUBLISHABLE_CHANNEL_COUNT - SHOWCASE_NETWORKS.length;
    expect(screen.getByText(`and ${more} more`)).toBeTruthy();
  });

  it('only shows networks a new account can publish to', () => {
    const publishable = Object.entries(CHANNEL_SPECS)
      .filter(([, spec]) => !spec.pending)
      .map(([slug]) => slug);
    const slug = (name: string) =>
      ({ X: 'x', LinkedIn: 'linkedin', Instagram: 'instagram', Threads: 'threads', TikTok: 'tiktok', YouTube: 'youtube', Facebook: 'facebook', Pinterest: 'pinterest', Bluesky: 'bluesky' }[name]);
    for (const n of SHOWCASE_NETWORKS) {
      expect(publishable).toContain(slug(n.name));
    }
  });

  it('points every logo at a file that exists', () => {
    const { container } = render(React.createElement(AuthShowcase));
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src')!);
    // the logo row, the calendar's posts and the composer's networks
    expect(srcs.length).toBeGreaterThan(SHOWCASE_NETWORKS.length + 6);
    for (const src of new Set(srcs)) {
      expect(fs.existsSync(path.join(PUBLIC, src))).toBe(true);
    }
  });

  it('makes no claim the homepage does not (no user counts, ratings, quotes or banned words)', () => {
    const { container } = render(React.createElement(AuthShowcase));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/trial|lifetime|free forever/i);
    expect(text).not.toMatch(/\d[\d,]*\+?\s*(users|creators|teams|customers)/i);
    expect(text).not.toMatch(/★|rating|rated|testimonial/i);
  });

  it('takes every colour from the hp-* tokens', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(SOURCE).not.toMatch(/\b(?:bg|text|border|ring|from|to|via)-(?:white|black|gray|slate|neutral|zinc)\b/);
    expect(SOURCE).not.toMatch(/rgba?\(/);
  });

  it('keeps the drawing out of the accessibility tree and off phones', () => {
    const { container } = render(React.createElement(AuthShowcase));
    const drawing = container.querySelector('[aria-hidden="true"].xl\\:block');
    expect(drawing).toBeTruthy();
    expect(drawing!.className).toContain('hidden');
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('width')).toBeTruthy();
      expect(img.getAttribute('height')).toBeTruthy();
    }
  });

  it('stops the float for visitors who ask for reduced motion', () => {
    const scss = fs.readFileSync(
      path.join(__dirname, '../../app/(app)/auth/auth.scss'),
      'utf8'
    );
    expect(scss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.auth-float\s*\{\s*animation:\s*none/
    );
  });
});
