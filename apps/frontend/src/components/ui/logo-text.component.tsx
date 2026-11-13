import React from 'react';

/**
 * Hookpost wordmark, using the HookStep brand mark.
 *
 * "post" is the brand colour as text (--hp-primary-text), from the active
 * brand theme (libraries/helpers/src/brand/brand-themes.ts), so it follows
 * both the theme switch and dark/light mode.
 *
 * The mark is a raster asset served from /brand-logo.png (drawn by
 * `pnpm brand:assets`) rather than inline SVG. Upstream drew Postiz's wordmark
 * as bezier paths, which no text rebrand could touch -- the app kept rendering
 * their trademark even after every string was renamed. Referencing our own
 * file removes that class of problem entirely.
 */
export const LogoTextComponent = () => {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        lineHeight: 1,
      }}
    >
      <img
        src="/brand-logo.png"
        alt=""
        aria-hidden="true"
        width={30}
        height={30}
        style={{ display: 'block' }}
      />
      <span
        style={{
          fontSize: 19,
          fontWeight: 700,
          letterSpacing: '-0.4px',
          // currentColor keeps the wordmark legible in both themes.
          color: 'currentColor',
        }}
      >
        Hook<span style={{ color: 'var(--hp-primary-text)' }}>post</span>
      </span>
    </span>
  );
};
