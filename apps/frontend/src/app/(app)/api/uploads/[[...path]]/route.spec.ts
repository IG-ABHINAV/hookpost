/**
 * @jest-environment node
 */
/**
 * GET /uploads/... when STORAGE_PROVIDER=local and Next.js serves the files
 * itself (no nginx in front, e.g. self-hosted or development). Production
 * nginx sends the same headers (upload.serve.spec.ts).
 *   pnpm exec jest -c apps/frontend/jest.config.ts api/uploads
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GET } from './route';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082',
  'hex'
);

describe('/api/uploads route', () => {
  let dir: string;
  let saved: string | undefined;
  const outside = `hp-outside-secret-${process.pid}`;
  beforeAll(() => {
    saved = process.env.UPLOAD_DIRECTORY;
    dir = mkdtempSync(join(tmpdir(), 'hp-uploads-route-'));
    mkdirSync(join(dir, '2026', '10', '25'), { recursive: true });
    writeFileSync(join(dir, '2026/10/25/pic.png'), PNG);
    writeFileSync(join(dir, '2026/10/25/page.html'), '<script>alert(document.cookie)</script>');
    writeFileSync(join(dir, '2026/10/25/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    writeFileSync(join(dir, '2026/10/25/clip.mp4'), Buffer.from('....ftypisom'));
    // A real file next to the upload directory, so a path out of it would
    // find something.
    writeFileSync(join(dir, '..', `${outside}.txt`), 'secret');
    process.env.UPLOAD_DIRECTORY = dir;
  });
  afterAll(() => {
    rmSync(join(dir, '..', `${outside}.txt`), { force: true });
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.UPLOAD_DIRECTORY;
    else process.env.UPLOAD_DIRECTORY = saved;
  });

  const get = (...path: string[]) =>
    GET({} as any, { params: Promise.resolve({ path }) });

  it('an image is shown inline, with nosniff and the sandbox CSP', async () => {
    const res = await get('2026', '10', '25', 'pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'.*sandbox/);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('a video is shown inline too', async () => {
    const res = await get('2026', '10', '25', 'clip.mp4');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it.each([['page.html'], ['logo.svg']])(
    '%s that is already on disk is a download as application/octet-stream, never a page',
    async (name) => {
      const res = await get('2026', '10', '25', name);
      expect(res.status).toBe(200);
      // It used to be text/html and image/svg+xml (mime.getType), so the
      // script ran on the app's origin.
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    }
  );

  // Next.js hands the route decoded segments, so `%2e%2e` arrives as `..`.
  it.each([[['..']], [['2026', '..', '..']], [['2026', '10', '..', '..', '..']]])(
    'a path out of the directory is a 404: %j',
    async (up) => {
      const res = await get(...up, `${outside}.txt`);
      expect(res.status).toBe(404);
    }
  );

  it('a missing file or a directory is a 404, not a 500', async () => {
    expect((await get('2026', '10', '25', 'missing.png')).status).toBe(404);
    expect((await get('2026', '10')).status).toBe(404);
    expect((await get()).status).toBe(404);
  });
});
