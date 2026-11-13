/**
 * @jest-environment node
 *
 * The brand theme registry (libraries/helpers/src/brand/brand-themes.ts):
 * every theme is complete, readable (WCAG AA), selectable with one setting,
 * and the raster assets on disk were drawn in the active theme.
 *   pnpm exec jest -c apps/frontend/jest.config.ts brand-themes
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BRAND_CSS_VARS,
  BRAND_THEME_NAMES,
  BRAND_THEMES,
  BrandModeTokens,
  brandPaletteHash,
  brandThemeCss,
  brandThemeName,
  DEFAULT_BRAND_THEME,
} from '@hookpost/helpers/brand/brand-themes';

const ROOT = join(__dirname, '../../../../..');

/** WCAG 2 contrast ratio of two #rrggbb colours. */
const contrast = (a: string, b: string) => {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const MODES = BRAND_THEME_NAMES.flatMap((name) =>
  (['dark', 'light'] as const).map((mode) => [name, mode, BRAND_THEMES[name][mode] as BrandModeTokens] as const)
);

describe('brand themes', () => {
  it('offers Tidewire, Marigold and Live Coral, with Tidewire the default', () => {
    expect(BRAND_THEME_NAMES).toEqual(['tidewire', 'marigold', 'coral']);
    expect(DEFAULT_BRAND_THEME).toBe('tidewire');
  });

  it.each(MODES)('%s %s defines every token as #rrggbb', (_name, _mode, t) => {
    for (const key of Object.keys(BRAND_CSS_VARS)) {
      expect(t[key as keyof typeof BRAND_CSS_VARS]).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(t.chart).toHaveLength(5);
    t.chart.forEach((c) => expect(c).toMatch(/^#[0-9A-F]{6}$/));
  });

  // Text 4.5:1, non-text (focus ring, chart marks) 3:1.
  it.each(MODES)('%s %s passes WCAG AA', (_name, _mode, t) => {
    expect(contrast(t.text, t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.text2, t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.text3, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.onPrimary, t.primaryHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.primaryText, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.primaryText, t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.danger, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.focus, t.bg)).toBeGreaterThanOrEqual(3);
    for (const c of t.chart) expect(contrast(c, t.surface)).toBeGreaterThanOrEqual(3);
  });

  it('is switched by NEXT_PUBLIC_BRAND_THEME alone, ignoring unknown names', () => {
    const before = process.env.NEXT_PUBLIC_BRAND_THEME;
    try {
      process.env.NEXT_PUBLIC_BRAND_THEME = 'marigold';
      expect(brandThemeName()).toBe('marigold');
      process.env.NEXT_PUBLIC_BRAND_THEME = ' Coral ';
      expect(brandThemeName()).toBe('coral');
      process.env.NEXT_PUBLIC_BRAND_THEME = 'purple';
      expect(brandThemeName()).toBe(DEFAULT_BRAND_THEME);
      delete process.env.NEXT_PUBLIC_BRAND_THEME;
      expect(brandThemeName()).toBe(DEFAULT_BRAND_THEME);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_BRAND_THEME;
      else process.env.NEXT_PUBLIC_BRAND_THEME = before;
    }
  });

  it('renders every theme as CSS keyed by html[data-brand-theme], dark by default', () => {
    const css = brandThemeCss();
    for (const name of BRAND_THEME_NAMES) {
      const t = BRAND_THEMES[name];
      expect(css).toContain(
        `html[data-brand-theme="${name}"],html[data-brand-theme="${name}"] .dark{--hp-bg:${t.dark.bg};`
      );
      expect(css).toContain(`html[data-brand-theme="${name}"] .light,html[data-brand-theme="${name}"].light{--hp-bg:${t.light.bg};`);
    }
    // Tailwind's hp-* colours need the channel form for /opacity.
    expect(css).toContain('--hp-primary-rgb:46 230 207');
    expect(css).toContain('--hp-chart-5:#9BE26A');
  });

  it('every root layout sets data-brand-theme and renders the tokens', () => {
    for (const group of ['(app)', '(landing)', '(provider)', '(extension)']) {
      const src = readFileSync(join(ROOT, `apps/frontend/src/app/${group}/layout.tsx`), 'utf8');
      expect(src).toContain('{...brandHtmlAttributes()}');
      expect(src).toContain('<BrandThemeStyle />');
    }
  });

  it('the favicons, OG image and manifest were drawn in the active theme (else run `pnpm brand:assets`)', () => {
    const stamp = JSON.parse(readFileSync(join(ROOT, 'apps/frontend/public/brand/theme.json'), 'utf8'));
    expect(stamp).toEqual({ theme: brandThemeName(), palette: brandPaletteHash() });

    const manifest = JSON.parse(readFileSync(join(ROOT, 'apps/frontend/public/site.webmanifest'), 'utf8'));
    const dark = BRAND_THEMES[brandThemeName()].dark;
    expect(manifest.theme_color).toBe(dark.bg);
    expect(manifest.background_color).toBe(dark.bg);

    const logo = readFileSync(join(ROOT, 'apps/frontend/public/logo.svg'), 'utf8');
    expect(logo).not.toContain('<image');
    expect(logo).toContain(dark.primary);
  });
});
