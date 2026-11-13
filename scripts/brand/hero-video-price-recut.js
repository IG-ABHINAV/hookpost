// One-off (10 Nov 2026): re-cuts the homepage demo video so it no longer says
// or shows $19. Works on the CURRENT cuts named in hero-demo.ts (both cuts,
// MP4 + WebM, posters), not on the magenta originals:
//
//   node scripts/brand/hero-video-price-recut.js
//
// - Picture and sound: frames 1083..1177 (36.100-39.267 s) are removed, which
//   is the spoken "Plans start at $19 a month." and the Standard $19 / Pro $29
//   price card. The cut lands in the quiet gaps before "Plans" and before the
//   URL; the picture dissolves from the CLI scene into the settled end card over
//   3 frames and the sound is crossfaded 30 ms, so length and sync hold.
// - The end card's small print, "No card needed · then plans from $19/month",
//   is repainted as "No card needed · then $7/month" on every kept end-card
//   frame (the 9:16 cut sets it on two lines).
// Never run `pnpm brand:video` without changing its source: it rebuilds from
// the magenta originals, which still say $19 (it refuses unless told).
// Needs ffmpeg with libx264, libsvtav1, libopus; Node 22+; sharp; the Tahoma font.
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '../..');
const VIDEO = path.join(ROOT, 'apps/frontend/public/video');
const REFS = ['apps/frontend/src/app/(landing)/hero-demo.ts', 'apps/frontend/src/app/(landing)/hero-demo.spec.ts'];
const CUT0 = 1083, CUT1 = 1178, K = 3, FPS = 30, POSTER_FRAME = 78;
const CUTS = { '16x9': [1280, 720], '9x16': [720, 1280] };
const INK = [213, 218, 221];
const FONT = 'font-family="Tahoma" font-weight="700" font-size="19"';
const NEW = { '16x9': ['No card needed · then $7/month'], '9x16': ['No card needed', 'then $7/month'] };
const SEARCH = { '16x9': [560, 490, 1120, 524], '9x16': [100, 606, 620, 660] };

const sha10 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const current = (fmt, ext) => {
  const src = fs.readFileSync(path.join(ROOT, REFS[0]), 'utf8');
  const m = src.match(new RegExp(`/video/(hookpost-home-s1-${fmt}\\.[0-9a-f]{10}\\.${ext})`));
  if (!m) throw new Error(`no ${fmt} ${ext} in hero-demo.ts`);
  return path.join(VIDEO, m[1]);
};
const rawFrames = (file, W, H) => {
  const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return p.stdout;
};

/** Bright-text lines of the settled end card's small print: [x0, x1, baseline]. */
async function findLines(frame, W, [bx0, by0, bx1, by1]) {
  const rows = [];
  for (let y = by0; y < by1; y++) {
    let n = 0, x0 = W, x1 = 0;
    for (let x = bx0; x < bx1; x++) {
      const i = (y * W + x) * 3;
      if ((frame[i] + frame[i + 1] + frame[i + 2]) / 3 > 110) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
    rows.push({ y, n, x0, x1 });
  }
  const lines = [];
  let cur = null;
  for (const r of rows) {
    if (r.n > 0) { cur = cur || { y0: r.y, x0: W, x1: 0, dense: r.y }; cur.x0 = Math.min(cur.x0, r.x0); cur.x1 = Math.max(cur.x1, r.x1); if (r.n > 30) cur.dense = r.y; cur.y1 = r.y; }
    else if (cur) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1, base: l.dense + 1 }));
}

/** White-on-black alpha of `text` centred on cx, baseline at `base`, in a w x h box. */
async function mask(text, w, h, cx, base) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#000"/><text x="${cx}" y="${base}" text-anchor="middle" ${FONT} fill="#fff">${text.replace(/&/g, '&amp;')}</text></svg>`;
  return sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
}

async function picture(fmt, src, out) {
  const [W, H] = CUTS[fmt];
  const frameSize = W * H * 3;
  const dec = rawFrames(src, W, H);
  const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => enc.on('close', (c) => (c ? rej(new Error(`encode ${c}`)) : res())));
  let pending = Buffer.alloc(0), n = 0, kept = 0, lines = null, boxes = null;
  const A = [];
  const write = async (fr) => { kept++; if (!enc.stdin.write(fr)) await new Promise((r) => enc.stdin.once('drain', r)); };
  const repaint = (fr) => {
    for (const b of boxes) {
      const { x0, y0, x1, y1, alpha } = b;
      for (let y = y0; y < y1; y++) {
        const l = [0, 1, 2].map((c) => (fr[(y * W + x0 - 3) * 3 + c] + fr[(y * W + x0 - 2) * 3 + c]) / 2);
        const r = [0, 1, 2].map((c) => (fr[(y * W + x1 + 2) * 3 + c] + fr[(y * W + x1 + 3) * 3 + c]) / 2);
        for (let x = x0; x < x1; x++) {
          const t = (x - x0) / (x1 - x0), i = (y * W + x) * 3, a = alpha[(y - y0) * (x1 - x0) + (x - x0)] / 255;
          for (let c = 0; c < 3; c++) fr[i + c] = Math.round((l[c] + (r[c] - l[c]) * t) * (1 - a) + INK[c] * a);
        }
      }
    }
  };
  const handle = async (fr) => {
    if (n < CUT0) await write(fr);
    else if (n < CUT0 + K) A.push(Buffer.from(fr));
    else if (n >= CUT1) {
      if (!boxes) throw new Error('lines are measured on frame 1250, after the cut'); 
      repaint(fr);
      const j = n - CUT1;
      if (j < K) {
        const a = (j + 1) / (K + 1), o = Buffer.alloc(frameSize);
        for (let i = 0; i < frameSize; i++) o[i] = Math.round(A[j][i] * (1 - a) + fr[i] * a);
        await write(o);
      } else await write(fr);
    }
    n++;
  };
  // Measure the lines first on a settled frame (they are static on the end card).
  const probe = await new Promise((res) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-ss', String(1250 / FPS), '-i', src, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const bufs = [];
    p.stdout.on('data', (d) => bufs.push(d));
    p.on('close', () => res(Buffer.concat(bufs)));
  });
  lines = await findLines(probe, W, SEARCH[fmt]);
  if (lines.length !== NEW[fmt].length) throw new Error(`${fmt}: found ${lines.length} small-print lines`);
  boxes = [];
  for (const [k, l] of lines.entries()) {
    const x0 = Math.max(8, l.x0 - 8), x1 = Math.min(W - 8, l.x1 + 8), y0 = l.y0 - 4, y1 = l.base + 6;
    const cx = (l.x0 + l.x1) / 2 - x0;
    boxes.push({ x0, y0, x1, y1, alpha: await mask(NEW[fmt][k], x1 - x0, y1 - y0, cx, l.base - y0) });
  }
  console.log(`  ${fmt}: small print at`, lines.map((l) => `x ${l.x0}-${l.x1}, baseline ${l.base}`).join('; '));
  for await (const chunk of dec) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      const fr = Buffer.from(pending.subarray(0, frameSize));
      pending = pending.subarray(frameSize);
      await handle(fr);
    }
  }
  enc.stdin.end();
  await done;
  console.log(`  ${fmt}: ${n} frames in, ${kept} out (${(kept / FPS).toFixed(3)} s)`);
  return kept;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hero-recut-'));
  const renames = {};
  for (const fmt of Object.keys(CUTS)) {
    const mp4src = current(fmt, 'mp4'), webmsrc = current(fmt, 'webm');
    const pic = path.join(tmp, `pic-${fmt}.mkv`);
    await picture(fmt, mp4src, pic);
    const t0 = CUT0 / FPS, t1 = CUT1 / FPS, h = 0.015;
    const wav = path.join(tmp, `mix-${fmt}.wav`);
    ff(['-i', mp4src, '-filter_complex', `[0:a]atrim=0:${t0 + h},asetpts=PTS-STARTPTS[a];[0:a]atrim=start=${t1 - h},asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=${2 * h}:c1=tri:c2=tri[o]`, '-map', '[o]', '-c:a', 'pcm_s16le', wav]);
    const base = `hookpost-home-s1-${fmt}`;
    const out = { mp4: path.join(tmp, `${base}.mp4`), webm: path.join(tmp, `${base}.webm`) };
    ff(['-i', pic, '-i', wav, '-map', '0:v', '-map', '1:a', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '27', '-maxrate', '900k', '-bufsize', '1800k', '-profile:v', 'high', '-level', '3.1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out.mp4]);
    ff(['-i', pic, '-i', wav, '-map', '0:v', '-map', '1:a', '-map_metadata', '-1', '-c:v', 'libsvtav1', '-preset', '4', '-crf', '42', '-g', '300', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '64k', out.webm]);
    const still = path.join(tmp, `${base}-poster.png`);
    ff(['-i', pic, '-vf', `select=eq(n\\,${POSTER_FRAME})`, '-frames:v', '1', '-pix_fmt', 'rgb24', still]);
    out.avif = path.join(tmp, `${base}.avif`);
    out.webp = path.join(tmp, `${base}.webp`);
    await sharp(still).avif({ quality: 50, effort: 9, chromaSubsampling: '4:2:0' }).toFile(out.avif);
    await sharp(still).webp({ quality: 72, effort: 6 }).toFile(out.webp);
    for (const [ext, file] of Object.entries(out)) {
      const name = `${base}.${sha10(file)}.${ext}`;
      const old = current(fmt, ext === 'avif' || ext === 'webp' ? ext : ext);
      fs.copyFileSync(file, path.join(VIDEO, name));
      if (path.basename(old) !== name) { renames[path.basename(old)] = name; fs.unlinkSync(old); }
      console.log(`  public/video/${name}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
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
main().catch((e) => { console.error(e); process.exit(1); });
