/**
 * @jest-environment node
 *
 * Guard: brand colour lives only in the brand theme registry
 * (libraries/helpers/src/brand/brand-themes.ts). Anywhere else, use a token:
 *   Tailwind  bg-hp-primary  text-hp-primary-text  border-hp-border  bg-hp-primary/10
 *   CSS       var(--hp-primary)  rgb(var(--hp-primary-rgb) / 0.2)
 *   TS        brandTokens('dark').primary   (canvas, third-party widgets)
 *
 * Fails on:
 *   1. the retired Hookpost colours (magenta #FF4CE2, the #612BD3 purples...),
 *   2. any purple or magenta hex (hue 250-335 degrees, saturated) - new
 *      hardcoded brand colour tends to arrive as "another purple",
 *   3. Tailwind's purple / violet / indigo / fuchsia / pink palette classes,
 *   4. the retired colours as rgb()/rgba() triplets.
 *
 * A social network's own colour (Instagram's gradient, Twitch purple...) is
 * not ours to change: those files are listed in ALLOWED below, with the reason.
 *   pnpm exec jest -c apps/frontend/jest.config.ts brand-colours
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../..');

const SCANNED = [
  'apps/frontend/src',
  'apps/frontend/public',
  'apps/frontend/tailwind.config.cjs',
  'libraries/react-shared-libraries/src',
  'libraries/nestjs-libraries/src/emails',
  'apps/backend/src/api/routes/public.controller.ts',
  'apps/extension/public',
  'scripts/og-image.html',
];
const EXTENSIONS = /\.(tsx?|cjs|s?css|svg|html|webmanifest)$/;

/** path pattern -> why its purple is allowed */
const ALLOWED: [RegExp, string][] = [
  [/^apps\/frontend\/public\/svgs\/socials\//, "the networks' own logos"],
  [/\/providers\/facebook\/facebook\.background\.ts$/, "Facebook's own text-post backgrounds"],
  [/\/auth\/providers\/farcaster\.provider\.tsx$/, "Farcaster's sign-in button colour"],
  [/\.spec\.tsx?$/, 'tests'],
];

const RETIRED = [
  'FF4CE2', '612BD3', '612AD5', 'FC69FF', '8155DD', '6366F1', 'A855F7', 'AE8AFC', '5520CB',
  '8B5CF6', '4F46E5', '7B3FF2', 'B69DEC', '8C66FF', 'AA0FA4', 'E038C6', 'D82D7E', 'DACBFB',
  '7236F1', '7950F2', '832AD5', '5826C2', '5B5BD6', '05070A',
];

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...SCANNED], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => EXTENSIONS.test(f))
  // deleted in the working tree but still in the index
  .filter((f) => existsSync(join(ROOT, f)))
  .filter((f) => !ALLOWED.some(([re]) => re.test(f)));

/** Hue in degrees, saturation and lightness (0-1) of #rrggbb. */
const hsl = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
};

const isPurple = (hex: string) => {
  const { h, s, l } = hsl(hex);
  return h >= 250 && h <= 335 && s >= 0.35 && l >= 0.12 && l <= 0.92;
};

const HEX = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;
const TAILWIND_PURPLE = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|from|via|to|ring|shadow|fill|stroke|outline|decoration|divide|accent|caret|placeholder)-(?:purple|violet|indigo|fuchsia|pink)-\d{2,3}\b/g;
const RGB_RETIRED = /rgba?\(\s*(?:255\s*,\s*76\s*,\s*226|97\s*,\s*43\s*,\s*211|99\s*,\s*102\s*,\s*241|216\s*,\s*45\s*,\s*126)\b/g;

const scan = () => {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      for (const m of line.matchAll(HEX)) {
        const full = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
        const hex = full.toUpperCase();
        if (RETIRED.includes(hex)) hits.push(`${at}: retired brand colour #${hex}`);
        else if (isPurple(hex)) hits.push(`${at}: purple/magenta #${hex}`);
      }
      for (const m of line.matchAll(TAILWIND_PURPLE)) hits.push(`${at}: Tailwind palette class ${m[0]}`);
      for (const m of line.matchAll(RGB_RETIRED)) hits.push(`${at}: retired brand colour ${m[0]}`);
    });
  }
  return hits;
};

describe('brand colour guard', () => {
  it('scans the app, the marketing site, emails, the OG source, the manifest and the extension', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const must of [
      'apps/frontend/src/app/(landing)/page.tsx',
      'apps/frontend/src/app/colors.scss',
      'libraries/nestjs-libraries/src/emails/layout/email.layout.ts',
      'scripts/og-image.html',
      'apps/frontend/public/site.webmanifest',
      'apps/extension/public/popup.html',
    ]) {
      expect(files).toContain(must);
    }
  });

  it('finds no hardcoded brand purple or magenta (use the hp-* tokens)', () => {
    expect(scan()).toEqual([]);
  });

  it('catches what it is meant to catch', () => {
    expect(isPurple('FF4CE2')).toBe(true);
    expect(isPurple('7640E0')).toBe(true);
    expect(isPurple('2EE6CF')).toBe(false); // Tidewire
    expect(isPurple('FFB520')).toBe(false); // Marigold
    expect(isPurple('FF6242')).toBe(false); // Live Coral
    expect('bg-violet-500/20 hover:text-pink-300'.match(TAILWIND_PURPLE)).toEqual([
      'bg-violet-500',
      'hover:text-pink-300',
    ]);
  });
});
