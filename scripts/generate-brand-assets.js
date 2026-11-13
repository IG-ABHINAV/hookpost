// Renders every brand asset that is a file rather than CSS, in the ACTIVE brand
// theme (libraries/helpers/src/brand/brand-themes.ts):
//
//   pnpm brand:assets            # the theme the site uses
//   NEXT_PUBLIC_BRAND_THEME=marigold pnpm brand:assets
//
// Writes into apps/frontend/public (and the two Next file-convention icons in
// src/app):
//   - logo.svg, logo-text.svg            the mark as real vector art
//   - brand-logo.png (512), brand-logo-96.png/.webp, icon.png (192),
//     apple-touch-icon.png (180), favicon.png (48), favicon-32x32.png,
//     favicon-16x16.png, favicon.ico (16/32/48), src/app/icon.png,
//     src/app/favicon.ico
//   - og-image.png (1200x630)            from scripts/og-image.html
//   - site.webmanifest                   theme_color / background_color
//   - the illustrations in scripts/brand/templates (success.svg, ...)
//   - apps/extension/public: icon-32/128.png and the popup's colour block
//   - brand/theme.json                   which theme these files were drawn in;
//     brand-themes.spec.ts fails when it does not match the active theme.
//
// Needs Node 22.18+ (it requires the .ts registry directly) and Playwright's
// Chromium for the OG image (pnpm exec playwright install chromium).
// Not run by cron or the deploy; scripts/check-free-claims.spec.ts checks its copy.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'apps/frontend/public');
const APP = path.join(ROOT, 'apps/frontend/src/app');
const brand = require('../libraries/helpers/src/brand/brand-themes.ts');

const name = brand.brandThemeName();
const theme = brand.brandTheme(name);
const D = theme.dark;
const L = theme.light;

/** Mix two #rrggbb colours: `amount` of `a` into `b`. */
const mix = (a, b, amount) => {
  const ch = (hex) => brand.hexToRgbChannels(hex).split(' ').map(Number);
  const [x, y] = [ch(a), ch(b)];
  return (
    '#' +
    x.map((v, i) => Math.round(v * amount + y[i] * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase()
  );
};

// ---------------------------------------------------------------------------
// The mark. Same geometry as the original Hookpost icon (stem, bridge and
// hook, the post signal on the right, the spark above it), drawn in the
// theme's colours: the letterform and spark in the brand colour, the post
// signal in the accent (where the old icon had pink), on the theme's own dark
// tile.
// ---------------------------------------------------------------------------
const MARK_PATHS = {
  stem: 'M160 140 C160 128 170 120 182 120 L204 120 C216 120 226 128 226 140 L226 372 C226 384 216 392 204 392 L182 392 C170 392 160 384 160 372 Z',
  hook: 'M226 230 L290 230 C320 230 346 254 346 284 L346 304 C346 334 322 358 292 358 L256 358 C242 358 232 348 232 334 L232 326 C232 312 242 302 256 302 L284 302 C293 302 300 295 300 286 L300 282 C300 273 293 266 284 266 L226 266 Z',
  post: 'M306 140 C306 128 316 120 328 120 L350 120 C362 120 372 128 372 140 L372 230 C372 242 362 250 350 250 L328 250 C316 250 306 242 306 230 Z',
};

/** The mark's inner art (512 units), ids prefixed so two marks can share a page. */
function markArt(t, id, { glow = true, rings = true } = {}) {
  return `
  <defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.elevated}"/>
      <stop offset="1" stop-color="${t.bg}"/>
    </linearGradient>
    <linearGradient id="${id}-edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.primary}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="${t.primary}" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="${id}-ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.primaryHover}"/>
      <stop offset="1" stop-color="${t.primaryActive}"/>
    </linearGradient>
    ${glow ? `<filter id="${id}-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>` : ''}
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#${id}-tile)" stroke="url(#${id}-edge)" stroke-width="5"/>
  ${rings ? `<circle cx="256" cy="256" r="180" fill="none" stroke="${t.primary}" stroke-width="1.5" stroke-opacity="0.14" stroke-dasharray="8 8"/>
  <circle cx="256" cy="256" r="120" fill="none" stroke="${t.primary}" stroke-width="1.5" stroke-opacity="0.10"/>` : ''}
  <g${glow ? ` filter="url(#${id}-glow)"` : ''}>
    <path d="${MARK_PATHS.stem}" fill="url(#${id}-ink)"/>
    <path d="${MARK_PATHS.hook}" fill="url(#${id}-ink)"/>
    <path d="${MARK_PATHS.post}" fill="${t.accent}"/>
    <circle cx="340" cy="90" r="16" fill="${t.primaryHover}"/>
  </g>`;
}

const markSvg = (t, size, opts) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="Hookpost">${markArt(t, 'hp', opts)}
</svg>
`;

const logoTextSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="34" viewBox="0 0 150 34" role="img" aria-label="Hookpost">
  <svg x="0" y="2" width="30" height="30" viewBox="0 0 512 512">${markArt(t, 'hpt', { rings: false })}
  </svg>
  <text x="38" y="23" fill="${t.text}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="19" font-weight="700" letter-spacing="-0.4">Hook<tspan fill="${t.primaryText}">post</tspan></text>
</svg>
`;

/** A real .ico (PNG-compressed entries), not a renamed PNG. */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const write = (rel, data) => {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, data);
  console.log('  ' + path.relative(ROOT, rel));
};

async function png(svg, size) {
  return sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 512) * 4) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function ogImage() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.warn('  ! playwright not installed: og-image.png skipped');
    return;
  }
  const decl = brand.brandModeDeclarations(D).replace(/;/g, ';\n    ');
  const html = fs
    .readFileSync(path.join(ROOT, 'scripts/og-image.html'), 'utf8')
    .replace('</style>', `  :root {\n    ${decl};\n  }\n</style>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    write(path.join(PUBLIC, 'og-image.png'), await page.screenshot({ type: 'png' }));
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`Brand assets in "${theme.name}" (${name})`);

  // Vector
  const mark = markSvg(D, 60);
  write(path.join(PUBLIC, 'logo.svg'), mark);
  write(path.join(PUBLIC, 'logo-text.svg'), logoTextSvg(D));

  // Raster icons. Small sizes drop the rings and the glow, which turn to mud
  // below 64px.
  const big = markSvg(D, 512);
  const small = markSvg(D, 512, { glow: false, rings: false });
  const at = (size) => png(size < 64 ? small : big, size);
  write(path.join(PUBLIC, 'brand-logo.png'), await at(512));
  write(path.join(PUBLIC, 'brand-logo-96.png'), await at(96));
  write(path.join(PUBLIC, 'brand-logo-96.webp'), await sharp(await at(96)).webp({ quality: 90 }).toBuffer());
  write(path.join(PUBLIC, 'icon.png'), await at(192));
  write(path.join(APP, 'icon.png'), await at(192));
  write(path.join(PUBLIC, 'apple-touch-icon.png'), await at(180));
  write(path.join(PUBLIC, 'favicon.png'), await at(48));
  write(path.join(PUBLIC, 'favicon-32x32.png'), await at(32));
  write(path.join(PUBLIC, 'favicon-16x16.png'), await at(16));
  const icoFile = ico([
    { size: 16, data: await at(16) },
    { size: 32, data: await at(32) },
    { size: 48, data: await at(48) },
  ]);
  write(path.join(PUBLIC, 'favicon.ico'), icoFile);
  write(path.join(APP, 'favicon.ico'), icoFile);

  // Illustrations: scripts/brand/templates/<path> -> public/<path>
  const vars = {
    primary: D.primary,
    accent: D.accent,
    primarySoft: mix(D.primary, '#181A1E', 0.16),
    primaryTint1: mix(D.primary, '#FFFFFF', 0.14),
    primaryTint2: mix(D.primary, '#FFFFFF', 0.28),
  };
  const templates = path.join(__dirname, 'brand/templates');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  for (const file of walk(templates)) {
    const out = fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, key) => {
      if (!(key in vars)) throw new Error(`${file}: unknown placeholder ${m}`);
      return vars[key];
    });
    write(path.join(PUBLIC, path.relative(templates, file)), out);
  }

  // The browser extension: its icons and the popup's colour block. It ships to
  // the Chrome Web Store separately, so a switch reaches it on its next release.
  const EXT = path.join(ROOT, 'apps/extension/public');
  write(path.join(EXT, 'icon-32.png'), await at(32));
  write(path.join(EXT, 'icon-128.png'), await at(128));
  const popupPath = path.join(EXT, 'popup.html');
  const popup = fs.readFileSync(popupPath, 'utf8');
  const block =
    `  /* brand:start - written by \`pnpm brand:assets\` from the active brand theme; do not edit */\n` +
    `  :root { color-scheme: light dark; --bg: ${L.surface}; --fg: ${L.text}; --muted: ${L.text3}; --line: ${L.border}; --ok: ${L.success}; --bad: ${L.danger}; --btn: ${L.primary}; --btn-fg: ${L.onPrimary}; }\n` +
    `  @media (prefers-color-scheme: dark) { :root { --bg: ${D.surface}; --fg: ${D.text}; --muted: ${D.text2}; --line: ${D.border}; --ok: ${D.success}; --bad: ${D.danger}; --btn: ${D.primary}; --btn-fg: ${D.onPrimary}; } }\n` +
    `  /* brand:end */`;
  if (!/\/\* brand:start[\s\S]*?brand:end \*\//.test(popup)) throw new Error('popup.html: brand block not found');
  write(popupPath, popup.replace(/  \/\* brand:start[\s\S]*?brand:end \*\//, block));

  // site.webmanifest: only the two colours change; name, icons and the rest
  // are edited by hand there.
  const manifestPath = path.join(PUBLIC, 'site.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.background_color = D.bg;
  manifest.theme_color = D.bg;
  write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  await ogImage();

  write(
    path.join(PUBLIC, 'brand/theme.json'),
    JSON.stringify({ theme: name, palette: brand.brandPaletteHash(name) }, null, 2) + '\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
