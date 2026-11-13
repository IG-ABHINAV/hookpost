/**
 * How uploads are served from the app's own origin, and that every server
 * that serves them says the same: the Next.js route (upload.serve.ts itself), and the
 * Docker image's nginx (var/docker/nginx.conf and its template). nginx is not available to the
 * test run, so its config is read and applied the way nginx applies it.
 *   pnpm exec jest -c apps/backend/jest.config.ts upload.serve
 */
import fs from 'fs';
import path from 'path';
import {
  UPLOAD_CSP,
  UPLOAD_INLINE_EXTENSIONS,
  UPLOAD_SERVE_TYPES,
  uploadServeHeaders,
} from '@hookpost/nestjs-libraries/upload/upload.serve';
import { UPLOAD_EXTENSION } from '@hookpost/nestjs-libraries/upload/upload.allowlist';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const CONFIGS = [
  'var/docker/nginx.conf',
  'var/docker/nginx.conf.template',
];

/** The body of the first block that starts with `head` (braces matched). */
function block(conf: string, head: RegExp): string {
  const m = head.exec(conf);
  if (!m) throw new Error(`no block matching ${head}`);
  let depth = 0;
  let i = conf.indexOf('{', m.index);
  const start = i;
  for (; i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) break;
  }
  return conf.slice(start + 1, i);
}

/** nginx's `types { mime ext ext; }` as extension -> mime. */
function typesOf(location: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block(location, /\btypes\s*\{/).split('\n')) {
    const words = line.trim().replace(/;$/, '').split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    const [mime, ...exts] = words;
    for (const ext of exts) out[ext] = mime;
  }
  return out;
}

/** The map's answer for a URI, as nginx evaluates `map $uri ...`. */
function disposition(conf: string, uri: string): string {
  const map = block(conf, /map \$uri \$hookpost_upload_disposition\s*\{/);
  let fallback = '';
  for (const line of map.split('\n')) {
    const m = line.trim().match(/^(\S+|"[^"]*")\s+"([^"]*)";$/);
    if (!m) continue;
    const key = m[1].replace(/^"|"$/g, '');
    if (key === 'default') {
      fallback = m[2];
    } else if (key.startsWith('~*')) {
      if (new RegExp(key.slice(2), 'i').test(uri)) return m[2];
    } else if (key.startsWith('~')) {
      if (new RegExp(key.slice(1)).test(uri)) return m[2];
    } else if (key === uri) {
      return m[2];
    }
  }
  return fallback;
}

describe('uploadServeHeaders: what a stored upload is served as', () => {
  it.each([
    ['2026/10/25/a.jpg', 'image/jpeg'],
    ['2026/10/25/a.JPEG', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.avif', 'image/avif'],
    ['a.tif', 'image/tiff'],
    ['a.mp4', 'video/mp4'],
  ])('%s is %s, shown inline, with nosniff and the sandbox', (name, type) => {
    expect(uploadServeHeaders(name)).toEqual({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': UPLOAD_CSP,
    });
  });

  it.each([['a.mp3'], ['a.m4a'], ['a.wav'], ['a.ogg']])(
    '%s keeps its audio type but is a download',
    (name) => {
      const headers = uploadServeHeaders(name);
      expect(headers['Content-Type']).toMatch(/^audio\//);
      expect(headers['Content-Disposition']).toBe('attachment');
    }
  );

  it.each([
    ['evil.html'],
    ['evil.htm'],
    ['evil.svg'],
    ['evil.js'],
    ['evil.xml'],
    ['evil.pdf'],
    ['evil.png.html'],
    ['noextension'],
    ['.htaccess'],
    ['evil.html/'],
  ])('%s is application/octet-stream and a download', (name) => {
    expect(uploadServeHeaders(name)).toEqual({
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': UPLOAD_CSP,
      'Content-Disposition': 'attachment',
    });
  });

  it('the CSP allows nothing to run and makes the file its own origin', () => {
    expect(UPLOAD_CSP).toContain("default-src 'none'");
    expect(UPLOAD_CSP).toMatch(/(^|; )sandbox($|;)/);
    expect(UPLOAD_CSP).not.toMatch(/script-src|unsafe|allow-/);
  });

  it('every extension a stored file can get is one the servers know', () => {
    for (const ext of Object.values(UPLOAD_EXTENSION)) {
      expect(UPLOAD_SERVE_TYPES[ext]).toBeTruthy();
    }
    for (const ext of UPLOAD_INLINE_EXTENSIONS) {
      expect(UPLOAD_SERVE_TYPES[ext]).toMatch(/^(image|video)\//);
    }
  });
});

describe.each(CONFIGS)('%s: the /uploads/ location', (file) => {
  const conf = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const location = block(conf, /location \^?~? ?\/uploads\/\s*\{/);

  it('sends nosniff and the sandbox CSP on every response', () => {
    expect(location).toMatch(
      /add_header X-Content-Type-Options "nosniff" always;/
    );
    expect(location).toContain(
      `add_header Content-Security-Policy "${UPLOAD_CSP}" always;`
    );
  });

  it('sets the type from exactly the served list, octet-stream otherwise', () => {
    expect(typesOf(location)).toEqual(UPLOAD_SERVE_TYPES);
    expect(location).toMatch(/default_type application\/octet-stream;/);
  });

  it('serves images and video inline and everything else as a download', () => {
    expect(location).toMatch(
      /add_header Content-Disposition \$hookpost_upload_disposition always;/
    );
    for (const ext of Object.keys(UPLOAD_SERVE_TYPES)) {
      const expected = UPLOAD_INLINE_EXTENSIONS.has(ext) ? '' : 'attachment';
      expect([ext, disposition(conf, `/uploads/2026/10/25/a.${ext}`)]).toEqual([
        ext,
        expected,
      ]);
      expect(disposition(conf, `/uploads/A.${ext.toUpperCase()}`)).toBe(
        expected
      );
    }
    for (const uri of [
      '/uploads/x.html',
      '/uploads/x.svg',
      '/uploads/x.js',
      '/uploads/x.png.html',
      '/uploads/x.jpg/',
      '/uploads/x.png;.html',
      '/uploads/x',
    ]) {
      expect([uri, disposition(conf, uri)]).toEqual([uri, 'attachment']);
    }
  });
});
