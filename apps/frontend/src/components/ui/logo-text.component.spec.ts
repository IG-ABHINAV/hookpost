/**
 * @jest-environment node
 *
 * The wordmark's "post" accent is the brand colour as text, from the active
 * brand theme. Its contrast in every theme and mode is checked in
 * libraries/helpers/src/brand/brand-themes.spec.ts.
 *   pnpm exec jest -c apps/frontend/jest.config.ts logo-text
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogoTextComponent } from './logo-text.component';

describe('LogoTextComponent', () => {
  it('colours "post" from the brand token, with no hardcoded colour', () => {
    // Server HTML (node environment): jsdom's style parser drops var() values.
    const html = renderToStaticMarkup(React.createElement(LogoTextComponent));
    expect(html).toContain('<span style="color:var(--hp-primary-text)">post</span>');
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
