/**
 * @jest-environment node
 */
/**
 * Files crawlers and the Play app fetch from the site root, where a mistake
 * fails silently:
 *  - /.well-known/assetlinks.json: without Play's app-signing key the
 *    installed TWA fails Digital Asset Links and shows a URL bar (fixed
 *    22 Oct 2026, 2fb9fe10c);
 *  - IndexNow key files: the key the deploy submits must be served at the
 *    root with exactly the key as its body, or Bing refuses the submission;
 *  - security.txt: RFC 9116 requires Expires, and an expired file is ignored.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { TWA_PACKAGE } from '../components/layout/twa';

const root = join(__dirname, '..', '..', '..', '..');
const publicDir = join(root, 'apps/frontend/public');

describe('/.well-known/assetlinks.json', () => {
  const links = JSON.parse(readFileSync(join(publicDir, '.well-known/assetlinks.json'), 'utf8'));

  it('delegates handle_all_urls to the Play app package', () => {
    expect(links).toHaveLength(1);
    expect(links[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(links[0].target.namespace).toBe('android_app');
    expect(links[0].target.package_name).toBe(TWA_PACKAGE);
  });

  it('lists the Play app-signing key and the upload key, as SHA-256 fingerprints', () => {
    const prints: string[] = links[0].target.sha256_cert_fingerprints;
    for (const p of prints) expect(p).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Play re-signs the app with its app-signing key: the installed app only
    // verifies against this one.
    expect(prints).toContain(
      '17:7D:E2:C7:D6:1B:4D:F0:E0:ED:3D:52:0D:15:C3:AF:A7:1E:9C:49:0F:91:5D:69:58:8C:06:0A:BA:9A:DF:63'
    );
    // The upload key, for builds installed outside Play (internal testing).
    expect(prints).toContain(
      'BD:F8:8F:AF:95:89:A9:BB:E9:95:CD:F1:F7:6B:F6:8D:D9:C7:0C:D8:78:05:AD:24:5C:A5:2A:93:FF:5B:4E:01'
    );
  });
});

describe('IndexNow key files', () => {
  const keyFiles = readdirSync(publicDir).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));

  it.each(keyFiles.map((f) => [f]))('%s holds exactly its own key', (file) => {
    expect(readFileSync(join(publicDir, file), 'utf8').trim()).toBe(file.replace(/\.txt$/, ''));
  });

  it('the key the deploy submits (scripts/indexnow-submit.js) is served at the root', () => {
    const script = readFileSync(join(root, 'scripts/indexnow-submit.js'), 'utf8');
    const key = script.match(/const KEY = '([0-9a-f]{32})'/)![1];
    expect(keyFiles).toContain(`${key}.txt`);
    expect(script).toContain('const KEY_LOCATION = `https://${HOST}/${KEY}.txt`');
  });

  it('the app route for a key file answers the key as plain text', async () => {
    const { GET } = await import('./249826f42a6c4da1bb062a4f6645391d.txt/route');
    const res = GET();
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('249826f42a6c4da1bb062a4f6645391d');
  });
});

describe('/.well-known/security.txt', () => {
  const text = readFileSync(join(publicDir, '.well-known/security.txt'), 'utf8');

  it('has a contact and the canonical URL', () => {
    expect(text).toMatch(/^Contact: mailto:\S+@\S+$/m);
    expect(text).toMatch(/^Canonical: https:\/\/hookpost\.hookstep\.in\/\.well-known\/security\.txt$/m);
  });

  it('has not expired, and will not within 30 days (renew it before then)', () => {
    const expires = new Date(text.match(/^Expires: (.+)$/m)![1]);
    expect(expires.getTime()).toBeGreaterThan(Date.now() + 30 * 86400_000);
  });
});
