// Re-colours the homepage demo video (both cuts, both encodes, both posters)
// in the ACTIVE brand theme (libraries/helpers/src/brand/brand-themes.ts):
//
//   pnpm brand:video                              # the theme the site uses
//   NEXT_PUBLIC_BRAND_THEME=marigold pnpm brand:video
//
// Run `pnpm brand:assets` for the same theme first: the mark is taken from
// public/brand-logo.png, and the script refuses when public/brand/theme.json
// says those files were drawn in another theme.
//
// The video is the owner's face-cam "Script 1" cut (hero-demo.ts). Its
// masters and HyperFrames comps are gone, so the source is the original
// magenta web cut, read from git history (LEGACY below), never the files in
// public/: every run starts from the same pixels, whatever theme is live.
//
// What changes, and nothing else (same frames, same audio, same copy):
// - Every pixel in the old palette's hues (magenta #ff4ce2, violet #a35cf0,
//   blue-violet #5a73f6, the pinks, and saturated brand cyan #22bcef) moves to
//   the theme's primary, at the same relative saturation and brightness: the
//   highlighted caption words, the URL as spoken, the stage glow, the draft
//   pill, the calendar tiles, the price-card ring, "post" in the wordmark.
//   The hues sit clear of skin and the pink wall behind him (340-40), so the
//   face is untouched. The blues between cyan and violet (204-226) are also
//   LinkedIn's and Facebook's, so those are moved only inside WIDE windows,
//   the scenes that have no network icons.
// - The old mark (the "This is Hookpost" card and the end card) is replaced
//   by the theme's mark, following the old one's fade, scale and rise.
// - The end card's CTA pill keeps its glyphs (copy and "→" are the original
//   pixels), unmixed from white to the theme's onPrimary.
// Then: H.264 MP4 and AV1 WebM with the old audio streams copied untouched,
// AVIF and WebP posters (2.6 s), content-hashed names, and the references in
// hero-demo.ts and hero-demo.spec.ts rewritten. Old files are deleted.
//
// Needs ffmpeg with libx264 and libsvtav1 on PATH, Node 22.18+, and a full
// (not shallow) clone for LEGACY.
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'apps/frontend/public');
const VIDEO = path.join(PUBLIC, 'video');
const REFS = ['apps/frontend/src/app/(landing)/hero-demo.ts', 'apps/frontend/src/app/(landing)/hero-demo.spec.ts'];
const brand = require('../../libraries/helpers/src/brand/brand-themes.ts');

/** The magenta originals (the 2 Nov re-cut), as committed. 1304 frames at 30 fps each. */
const LEGACY = {
  commit: '6d61f12233880553b85a0a3c9f0c27c63d42f5c7',
  cuts: {
    '16x9': { w: 1280, h: 720, mp4: 'hookpost-home-s1-16x9.05145650cf.mp4', webm: 'hookpost-home-s1-16x9.eaf4eb833a.webm' },
    '9x16': { w: 720, h: 1280, mp4: 'hookpost-home-s1-9x16.7d0cc61408.mp4', webm: 'hookpost-home-s1-9x16.f242d9c946.webm' },
  },
};

// Timings, measured on LEGACY (the same frames in both cuts).
// "This is Hookpost": the mark pops in from frame 151.8 (GSAP back.out(2),
// 0.3 s, scale 0.85 -> 1 about the frame centre) and fades out by 197.
const TITLE = { from: 152, to: 196, start: 151.8, alpha: { 152: 0.07, 153: 0.56, 154: 0.89, 192: 0.91, 193: 0.8, 194: 0.62, 195: 0.38, 196: 0.07 } };
// The end card fades in over 1173-1177 (opacity, rise in px), settled from 1178.
const CARD = { from: 1173, fade: { 1173: [0.225, 12.0], 1174: [0.51, 7.5], 1175: [0.738, 4.0], 1176: [0.861, 2.0], 1177: [0.934, 0.5] } };
const POSTER_FRAME = 78; // 2.6 s: the face and the hook caption

// Geometry in each cut's own px: the old mark's box [left, top, size] on the
// title card and the end card, a box round the CTA pill, and the WIDE windows
// [first frame, last frame, x0, y0, x1, y1].
const GEO = {
  '16x9': {
    titleMark: [793.33, 193.33, 93.33],
    cardMark: [786.67, 100, 106.67],
    pill: [560, 395, 1120, 495],
    wide: [
      [148, 200, 690, 150, 1100, 430], // mark + wordmark
      [820, 890, 556, 215, 1175, 415], // the 21-draft grid, right of its icons
      [1055, 1172, 460, 110, 780, 370], // the Standard card's ring
      [1173, 1304, 560, 60, 1180, 560], // end card
    ],
  },
  '9x16': {
    titleMark: [313.33, 324, 93.33],
    cardMark: [306.67, 200, 106.67],
    pill: [110, 500, 610, 600],
    wide: [
      [148, 200, 280, 290, 440, 440],
      [820, 890, 92, 485, 600, 655],
      [1055, 1172, 30, 360, 420, 590],
      [1173, 1304, 120, 170, 600, 460],
    ],
  },
};

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------
const rgb = (hex) => brand.hexToRgbChannels(hex).split(' ').map((v) => Number(v) / 255);
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, mx ? d / mx : 0, mx];
}
function fromHsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// The old palette by hue. Cyan is moved only when strongly saturated (the
// face has a few dim bluish pixels at that hue); magenta down to near-grey.
// `ref` is the old colour's [saturation, value] that lands exactly on the
// theme's primary.
const CYAN = { lo: 188, hi: 204, sat: [0.45, 0.62], ref: [0.86, 0.94] };
const MAGENTA = { lo: 226, hi: 330, sat: [0.08, 0.22], ref: [0.7, 1.0] };
const RAMP = 6;

/** How far a hue belongs to the old palette; `wide` bridges cyan to magenta. */
function hueWeight(h, wide) {
  const edge = (lo, hi) => Math.min(smooth(lo - RAMP, lo, h), 1 - smooth(hi, hi + RAMP, h));
  return wide ? edge(CYAN.lo, MAGENTA.hi) : Math.max(edge(CYAN.lo, CYAN.hi), edge(MAGENTA.lo, MAGENTA.hi));
}

/** One colour (0..1 channels) in the old palette -> the theme. */
function remap(r, g, b, T, wide) {
  const [h, s, v] = hsv(r, g, b);
  const wh = hueWeight(h, wide);
  if (wh <= 0) return [r, g, b];
  const k = smooth(CYAN.hi, MAGENTA.lo, h); // 0 cyan .. 1 magenta
  // Bright, barely tinted magenta is a caption word mid-way through its fade
  // back to white: catch it too (skin highlights are orange, not this hue).
  const light = k * smooth(0.7, 0.85, v);
  const lo = lerp(lerp(CYAN.sat[0], MAGENTA.sat[0], k), 0.025, light);
  const hi = lerp(lerp(CYAN.sat[1], MAGENTA.sat[1], k), 0.09, light);
  const w = wh * smooth(lo, hi, s);
  if (w <= 0) return [r, g, b];
  const t = fromHsv(T.h, Math.min(1, (s * T.s) / lerp(CYAN.ref[0], MAGENTA.ref[0], k)), Math.min(1, (v * T.v) / lerp(CYAN.ref[1], MAGENTA.ref[1], k)));
  return [r + (t[0] - r) * w, g + (t[1] - g) * w, b + (t[2] - b) * w];
}

function cube(T, N = 65) {
  const lines = [`TITLE "hookpost hero video -> ${T.name}"`, `LUT_3D_SIZE ${N}`];
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) lines.push(remap(r / (N - 1), g / (N - 1), b / (N - 1), T, false).map((x) => x.toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Frame edits
// ---------------------------------------------------------------------------
/** The theme mark, sized so its tile (inset 16/512) covers the old mark's box. */
async function loadMark() {
  const { data, info } = await sharp(path.join(PUBLIC, 'brand-logo.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, size: info.width };
}

/** Composite the mark over the old one's box [x, y, size], at opacity `alpha`, bilinear. */
function drawMark(fr, W, H, mark, [bx, by, bs], alpha) {
  const full = (bs * 512) / 480; // the whole png, tile filling the box
  const x0 = bx - (full - bs) / 2, y0 = by - (full - bs) / 2, k = mark.size / full;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y0 + full)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + full)); x++) {
      const u = (x + 0.5 - x0) * k - 0.5, v = (y + 0.5 - y0) * k - 0.5;
      const u0 = Math.max(0, Math.min(mark.size - 2, Math.floor(u))), v0 = Math.max(0, Math.min(mark.size - 2, Math.floor(v)));
      const fu = Math.min(1, Math.max(0, u - u0)), fv = Math.min(1, Math.max(0, v - v0));
      const px = [0, 0, 0, 0];
      for (const [du, dv, wgt] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
        const m = ((v0 + dv) * mark.size + u0 + du) * 4, a = mark.data[m + 3] / 255;
        for (let c = 0; c < 3; c++) px[c] += mark.data[m + c] * a * wgt;
        px[3] += a * wgt;
      }
      const a = px[3] * alpha, i = (y * W + x) * 3;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) fr[i + c] = Math.round(fr[i + c] * (1 - a) + (px[c] / (px[3] || 1)) * a);
    }
}

/** A box scaled by `s` about the frame centre. */
const scaled = ([x, y, size], s, W, H) => [W / 2 + (x - W / 2) * s, H / 2 + (y - H / 2) * s, size * s];

/** GSAP back.out(2) at progress p. */
const backOut = (p) => 1 + 3 * (p - 1) ** 3 + 2 * (p - 1) ** 2;

/** The pill: white text on the (re-coloured) fill -> onPrimary on the same fill. */
function recolourPill(fr, W, [bx0, by0, bx1, by1], T) {
  const ch = T.fill.indexOf(Math.min(...T.fill)); // the channel where the fill is darkest: text lifts it most
  const isFill = (i) => {
    const [h, s, v] = hsv(fr[i] / 255, fr[i + 1] / 255, fr[i + 2] / 255);
    return Math.abs(h - T.h) < 20 && s > 0.35 && v > 0.45;
  };
  let top = -1, bot = -1, left = W, right = -1;
  for (let y = by0; y < by1; y++) {
    let n = 0;
    for (let x = bx0; x < bx1; x++)
      if (isFill((y * W + x) * 3)) {
        n++;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    if (n > 40) {
      if (top < 0) top = y;
      bot = y;
    }
  }
  if (top < 0) return false;
  const r = Math.round((bot - top) / 2);
  const y0 = top + 3, y1 = bot - 3, x0 = left + Math.round(r * 0.6), x1 = right - Math.round(r * 0.6);
  // The fill per column: the median of the text-free rows (top and bottom
  // quarter of the pill), then smoothed along the row so codec noise does not
  // turn into stripes.
  const band = Math.max(2, Math.round((y1 - y0) * 0.18));
  const raw = [];
  for (let x = x0; x <= x1; x++) {
    const samples = [];
    for (let y = y0; y < y0 + band; y++) samples.push((y * W + x) * 3);
    for (let y = y1 - band + 1; y <= y1; y++) samples.push((y * W + x) * 3);
    raw.push([0, 1, 2].map((c) => samples.map((i) => fr[i + c]).sort((a, b) => a - b)[samples.length >> 1]));
  }
  const fill = raw.map((_, j) => {
    const lo = Math.max(0, j - 10), hi = Math.min(raw.length - 1, j + 10);
    return [0, 1, 2].map((c) => {
      let s = 0;
      for (let q = lo; q <= hi; q++) s += raw[q][c];
      return s / (hi - lo + 1);
    });
  });
  for (let x = x0; x <= x1; x++) {
    const f = fill[x - x0];
    for (let y = y0; y <= y1; y++) {
      const i = (y * W + x) * 3;
      const a = smooth(0.1, 1, (fr[i + ch] - f[ch]) / (255 - f[ch] || 1));
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) fr[i + c] = Math.round(f[c] + (T.onPrimary[c] * 255 - f[c]) * a);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const sha10 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);

async function picture(fmt, src, lutFile, out, T, mark) {
  const { w: W, h: H } = LEGACY.cuts[fmt];
  const geo = GEO[fmt];
  // Each frame arrives as [LUT-mapped | original] side by side: the WIDE
  // windows are re-mapped from the original pixels.
  const dec = spawn('ffmpeg', ['-v', 'error', '-i', src, '-filter_complex',
    `[0:v]format=rgb24,split[a][b];[a]lut3d=file=${lutFile}:interp=tetrahedral[m];[m][b]hstack=inputs=2,format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', '-',
    '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const pair = W * H * 6;
  let pending = Buffer.alloc(0), n = 0, pills = 0;
  const done = new Promise((res, rej) => {
    enc.on('close', (c) => (c ? rej(new Error(`encode ${c}`)) : res()));
    dec.on('close', (c) => c && rej(new Error(`decode ${c}`)));
  });
  const handle = (both) => {
    const fr = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) both.copy(fr, y * W * 3, y * W * 6, y * W * 6 + W * 3);
    for (const [f0, f1, x0, y0, x1, y1] of geo.wide) {
      if (n < f0 || n > f1) continue;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const o = y * W * 6 + (W + x) * 3, i = (y * W + x) * 3;
          const m = remap(both[o] / 255, both[o + 1] / 255, both[o + 2] / 255, T, true);
          for (let c = 0; c < 3; c++) fr[i + c] = Math.round(Math.min(1, Math.max(0, m[c])) * 255);
        }
    }
    if (n >= TITLE.from && n <= TITLE.to) {
      const p = Math.min(1, (n - TITLE.start) / 9);
      drawMark(fr, W, H, mark, scaled(geo.titleMark, 0.85 + 0.15 * backOut(p), W, H), TITLE.alpha[n] ?? 1);
    }
    if (n >= CARD.from) {
      const [a, dy] = CARD.fade[n] || [1, 0];
      const [x, y, s] = geo.cardMark;
      drawMark(fr, W, H, mark, [x, y + dy, s], a);
      const [px0, py0, px1, py1] = geo.pill;
      if (recolourPill(fr, W, [px0, py0 + dy, px1, Math.min(H, py1 + dy)].map(Math.round), T)) pills++;
    }
    n++;
    return fr;
  };
  for await (const chunk of dec.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= pair) {
      const fr = handle(pending.subarray(0, pair));
      pending = pending.subarray(pair);
      if (!enc.stdin.write(fr)) await new Promise((r) => enc.stdin.once('drain', r));
    }
  }
  enc.stdin.end();
  await done;
  console.log(`  ${fmt}: ${n} frames, CTA pill re-inked on ${pills} of ${n - CARD.from} end-card frames`);
  if (pills < n - CARD.from - 5) throw new Error(`${fmt}: pill not found on the end card`);
}

async function main() {
  if (!process.env.ALLOW_OLD_PRICE_SOURCE)
    throw new Error('The magenta originals this rebuilds from still say $19 (spoken and on the price card). The shipped cuts were re-cut on 10 Nov 2026 by scripts/brand/hero-video-price-recut.js; re-colour those, or set ALLOW_OLD_PRICE_SOURCE=1 to bring $19 back knowingly.');
  const name = brand.brandThemeName();
  const D = brand.brandTheme(name).dark;
  const stamp = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'brand/theme.json'), 'utf8'));
  if (stamp.theme !== name || stamp.palette !== brand.brandPaletteHash(name))
    throw new Error(`public/brand-logo.png is drawn in ${stamp.theme}; run pnpm brand:assets for ${name} first`);
  const [h, s, v] = hsv(...rgb(D.primary));
  const T = { name, h, s, v, fill: rgb(D.primary), onPrimary: rgb(D.onPrimary) };
  console.log(`Hero video in ${name} (primary ${D.primary}, text on it ${D.onPrimary})`);

  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hero-video-'));
  const lutFile = path.join(tmp, 'brand.cube');
  fs.writeFileSync(lutFile, cube(T));
  const mark = await loadMark();
  const renames = {};
  for (const [fmt, cut] of Object.entries(LEGACY.cuts)) {
    const src = {};
    for (const ext of ['mp4', 'webm']) {
      src[ext] = path.join(tmp, `legacy-${fmt}.${ext}`);
      const blob = `${LEGACY.commit}:apps/frontend/public/video/${cut[ext]}`;
      fs.writeFileSync(src[ext], execFileSync('git', ['-C', ROOT, 'show', blob], { maxBuffer: 64 << 20 }));
    }
    const pic = path.join(tmp, `pic-${fmt}.mkv`);
    await picture(fmt, src.mp4, lutFile, pic, T, mark);

    const base = `hookpost-home-s1-${fmt}`;
    const out = { mp4: path.join(tmp, `${base}.mp4`), webm: path.join(tmp, `${base}.webm`) };
    // The encodes hero-demo.ts documents; audio copied from the originals.
    ff(['-i', pic, '-i', src.mp4, '-map', '0:v', '-map', '1:a', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '27',
      '-maxrate', '900k', '-bufsize', '1800k', '-profile:v', 'high', '-level', '3.1', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out.mp4]);
    ff(['-i', pic, '-i', src.webm, '-map', '0:v', '-map', '1:a', '-map_metadata', '-1', '-c:v', 'libsvtav1', '-preset', '4', '-crf', '42',
      '-g', '300', '-pix_fmt', 'yuv420p', '-c:a', 'copy', out.webm]);
    const still = path.join(tmp, `${base}-poster.png`);
    ff(['-i', pic, '-vf', `select=eq(n\\,${POSTER_FRAME})`, '-frames:v', '1', '-pix_fmt', 'rgb24', still]);
    out.avif = path.join(tmp, `${base}.avif`);
    out.webp = path.join(tmp, `${base}.webp`);
    await sharp(still).avif({ quality: 50, effort: 9, chromaSubsampling: '4:2:0' }).toFile(out.avif);
    await sharp(still).webp({ quality: 72, effort: 6 }).toFile(out.webp);

    for (const [ext, file] of Object.entries(out)) {
      const finalName = `${base}.${sha10(file)}.${ext}`;
      for (const old of fs.readdirSync(VIDEO).filter((f) => f.startsWith(base + '.') && f.endsWith('.' + ext))) {
        renames[old] = finalName;
        fs.unlinkSync(path.join(VIDEO, old));
      }
      fs.copyFileSync(file, path.join(VIDEO, finalName));
      console.log(`  public/video/${finalName}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    }
  }
  for (const rel of REFS) {
    const file = path.join(ROOT, rel);
    let text = fs.readFileSync(file, 'utf8');
    for (const [from, to] of Object.entries(renames)) text = text.split(from).join(to);
    fs.writeFileSync(file, text);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
