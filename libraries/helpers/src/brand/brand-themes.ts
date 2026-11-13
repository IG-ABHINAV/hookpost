/**
 * Hookpost brand themes: the ONE place brand colour lives.
 *
 * Switching the whole colour scheme (app, marketing site, emails, favicons,
 * OG image, PWA manifest) is one setting:
 *
 *   NEXT_PUBLIC_BRAND_THEME=tidewire | marigold | coral
 *
 * Unset, the site uses DEFAULT_BRAND_THEME below. Changing that one line is
 * the permanent switch; the env var overrides it per machine or per build.
 * Raster assets (favicons, og-image.png) are pictures, so after a switch run
 * `pnpm brand:assets` once; brand-themes.spec.ts fails until you do. Then
 * `pnpm brand:video` re-colours the homepage demo video and its posters.
 *
 * Keep this file free of imports: the email layout imports it, and the
 * lead-drip cron runs an esbuild bundle of that layout with plain node.
 *
 * Every value below comes from the palette study of 10 Nov 2026
 * (contrast-checked: brand-themes.spec.ts re-checks the AA pairs).
 */

export interface BrandModeTokens {
  /** Page background. */
  bg: string;
  /** Cards, panels, the composer. */
  surface: string;
  /** Hover rows, calendar headers, raised controls. */
  elevated: string;
  border: string;
  borderStrong: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  text2: string;
  /** Muted text (still AA on surface). */
  text3: string;
  /** The brand fill: main buttons, selected states. */
  primary: string;
  primaryHover: string;
  primaryActive: string;
  /** Text and icons on a primary fill. */
  onPrimary: string;
  /** The brand colour used as text or a link on bg/surface. */
  primaryText: string;
  /** Second colour: AI actions, highlights. */
  accent: string;
  onAccent: string;
  /** Keyboard focus ring. */
  focus: string;
  success: string;
  warning: string;
  danger: string;
  /** Chart series 1-5, in order. */
  chart: readonly [string, string, string, string, string];
}

export interface BrandTheme {
  name: string;
  tagline: string;
  dark: BrandModeTokens;
  light: BrandModeTokens;
}

export const BRAND_THEMES = {
  tidewire: {
    name: 'Tidewire',
    tagline: 'Electric aqua on deep petrol',
    dark: {
      bg: '#061416', surface: '#0B1D20', elevated: '#11282C', border: '#1E3A3E', borderStrong: '#2C4F53',
      text: '#E7F5F3', text2: '#A3BDBA', text3: '#7A9693',
      primary: '#2EE6CF', primaryHover: '#66F0DD', primaryActive: '#16C7B0', onPrimary: '#032220', primaryText: '#2EE6CF',
      accent: '#FF9A5C', onAccent: '#2A1204', focus: '#8AF7E8',
      success: '#45D98F', warning: '#F7BE45', danger: '#FF6E6E',
      chart: ['#2EE6CF', '#FF9A5C', '#5EA8FF', '#F7BE45', '#9BE26A'],
    },
    light: {
      bg: '#EFF5F4', surface: '#FFFFFF', elevated: '#F7FAFA', border: '#D3E2E0', borderStrong: '#B4CBC8',
      text: '#0A1F1D', text2: '#3A5552', text3: '#566F6C',
      primary: '#00796C', primaryHover: '#00665B', primaryActive: '#00544B', onPrimary: '#FFFFFF', primaryText: '#00796C',
      accent: '#C24A0E', onAccent: '#FFFFFF', focus: '#008C7C',
      success: '#13804F', warning: '#9A5B00', danger: '#C53030',
      chart: ['#00897A', '#E0661F', '#2F74D0', '#C08A00', '#4E9A2A'],
    },
  },
  marigold: {
    name: 'Marigold',
    tagline: 'Saffron on roasted espresso',
    dark: {
      bg: '#15100A', surface: '#1E1810', elevated: '#282016', border: '#3A3023', borderStrong: '#4F4331',
      text: '#FBF3E4', text2: '#CBBDA5', text3: '#A09079',
      primary: '#FFB520', primaryHover: '#FFC855', primaryActive: '#EA9D00', onPrimary: '#1C1304', primaryText: '#FFB520',
      accent: '#4FB8E8', onAccent: '#06202D', focus: '#FFD77A',
      success: '#5FD394', warning: '#FF8A3D', danger: '#FF6159',
      chart: ['#FFB520', '#4FB8E8', '#FF7A45', '#5FD394', '#E8D9B5'],
    },
    light: {
      bg: '#F8F6F1', surface: '#FFFFFF', elevated: '#FCFBF8', border: '#E7E0D2', borderStrong: '#D3C8B4',
      text: '#1D160C', text2: '#564B39', text3: '#6B604F',
      primary: '#FFB520', primaryHover: '#F5A600', primaryActive: '#E09500', onPrimary: '#1D160C', primaryText: '#8C5800',
      accent: '#1D6FA3', onAccent: '#FFFFFF', focus: '#B87400',
      success: '#1D7A4B', warning: '#B04A0A', danger: '#C22D26',
      chart: ['#BF7E00', '#1D6FA3', '#D2541C', '#2E9460', '#7A6A4E'],
    },
  },
  coral: {
    name: 'Live Coral',
    tagline: 'Record-light coral on midnight slate',
    dark: {
      bg: '#0A121F', surface: '#101B2C', elevated: '#172539', border: '#22324A', borderStrong: '#33476A',
      text: '#EEF2F8', text2: '#A9B5C7', text3: '#8190A6',
      primary: '#FF6242', primaryHover: '#FF8166', primaryActive: '#EC4A2A', onPrimary: '#1F0904', primaryText: '#FF7A5E',
      accent: '#FFD23F', onAccent: '#231B00', focus: '#FFA48F',
      success: '#3DD9A0', warning: '#FFD23F', danger: '#FF5A5A',
      chart: ['#FF6242', '#FFD23F', '#4DB5FF', '#3DD9A0', '#B8C4D6'],
    },
    light: {
      bg: '#F4F6FA', surface: '#FFFFFF', elevated: '#F9FAFC', border: '#DCE2EB', borderStrong: '#C2CBD9',
      text: '#0A121F', text2: '#3A4860', text3: '#56657C',
      primary: '#FF6242', primaryHover: '#F24E2D', primaryActive: '#DB3E1F', onPrimary: '#1F0904', primaryText: '#C23A1C',
      accent: '#8A6A00', onAccent: '#FFFFFF', focus: '#E0482A',
      success: '#11795A', warning: '#8F6200', danger: '#B42318',
      chart: ['#F0532F', '#A67C00', '#2A7FD4', '#16946A', '#5F6E86'],
    },
  },
} as const satisfies Record<string, BrandTheme>;

export type BrandThemeName = keyof typeof BRAND_THEMES;
export type BrandMode = 'dark' | 'light';

// ===========================================================================
// THE SWITCH. One line. (Or set NEXT_PUBLIC_BRAND_THEME, which wins.)
// ===========================================================================
export const DEFAULT_BRAND_THEME: BrandThemeName = 'tidewire';

export const BRAND_THEME_NAMES = Object.keys(BRAND_THEMES) as BrandThemeName[];

export function isBrandThemeName(value: unknown): value is BrandThemeName {
  return typeof value === 'string' && value in BRAND_THEMES;
}

/** The active theme's name: NEXT_PUBLIC_BRAND_THEME when valid, else the default. */
export function brandThemeName(): BrandThemeName {
  let fromEnv: string | undefined;
  try {
    // Written out in full so Next inlines it into client bundles.
    fromEnv = process.env.NEXT_PUBLIC_BRAND_THEME;
  } catch {
    fromEnv = undefined;
  }
  const wanted = (fromEnv || '').trim().toLowerCase();
  return isBrandThemeName(wanted) ? wanted : DEFAULT_BRAND_THEME;
}

/** The active theme (or a named one). */
export function brandTheme(name: BrandThemeName = brandThemeName()): BrandTheme {
  return BRAND_THEMES[name];
}

/** One mode's tokens of the active theme. */
export function brandTokens(mode: BrandMode, name: BrandThemeName = brandThemeName()): BrandModeTokens {
  return BRAND_THEMES[name][mode];
}

// ---------------------------------------------------------------------------
// CSS custom properties. Every root layout renders brandThemeCss() and sets
// data-brand-theme on <html>; Tailwind's `hp-*` colours and the legacy
// --new-* / --color-* variables in colors.scss all read these.
// ---------------------------------------------------------------------------

/** Token key -> CSS variable name (without the `--hp-` prefix). */
export const BRAND_CSS_VARS: Record<Exclude<keyof BrandModeTokens, 'chart'>, string> = {
  bg: 'bg',
  surface: 'surface',
  elevated: 'elevated',
  border: 'border',
  borderStrong: 'border-strong',
  text: 'text',
  text2: 'text-2',
  text3: 'text-3',
  primary: 'primary',
  primaryHover: 'primary-hover',
  primaryActive: 'primary-active',
  onPrimary: 'on-primary',
  primaryText: 'primary-text',
  accent: 'accent',
  onAccent: 'on-accent',
  focus: 'focus',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

/** '#2EE6CF' -> '46 230 207' (for rgb(var(--x-rgb) / <alpha>)). */
export function hexToRgbChannels(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** The declarations for one mode, e.g. `--hp-bg:#061416;--hp-bg-rgb:6 20 22;...` */
export function brandModeDeclarations(tokens: BrandModeTokens): string {
  const out: string[] = [];
  for (const [key, cssName] of Object.entries(BRAND_CSS_VARS)) {
    const value = tokens[key as keyof typeof BRAND_CSS_VARS];
    out.push(`--hp-${cssName}:${value}`, `--hp-${cssName}-rgb:${hexToRgbChannels(value)}`);
  }
  tokens.chart.forEach((value, i) => {
    out.push(`--hp-chart-${i + 1}:${value}`, `--hp-chart-${i + 1}-rgb:${hexToRgbChannels(value)}`);
  });
  return out.join(';');
}

/**
 * The stylesheet for every theme, keyed by html[data-brand-theme]. Without a
 * mode class the dark set applies (the marketing site is dark only); the app
 * puts .dark or .light on <body>.
 */
export function brandThemeCss(): string {
  return BRAND_THEME_NAMES.map((name) => {
    const t = BRAND_THEMES[name];
    const root = `html[data-brand-theme="${name}"]`;
    return (
      `${root},${root} .dark{${brandModeDeclarations(t.dark)}}` +
      `${root} .light,${root}.light{${brandModeDeclarations(t.light)}}`
    );
  }).join('\n');
}

/** Attributes for <html>: `<html {...brandHtmlAttributes()}>`. */
export function brandHtmlAttributes(): { 'data-brand-theme': BrandThemeName } {
  return { 'data-brand-theme': brandThemeName() };
}

/**
 * A short fingerprint of one theme's values. The raster brand assets record
 * the theme and fingerprint they were drawn with (public/brand/theme.json), so
 * a test can tell when they are stale.
 */
export function brandPaletteHash(name: BrandThemeName = brandThemeName()): string {
  const text = JSON.stringify(BRAND_THEMES[name]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
