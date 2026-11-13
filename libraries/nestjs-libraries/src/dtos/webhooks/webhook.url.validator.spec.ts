import { isBlockedIp, isSafePublicHttpsUrl } from './webhook.url.validator';

// IPv6 has many spellings for one address. The URL parser and dns.lookup
// hand back the canonical one (::ffff:127.0.0.1 becomes ::ffff:7f00:1), so
// the block list has to recognise every form, not just the dotted one.

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::FFFF:7F00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:a00:5',
    '::ffff:c0a8:101',
    'fe80::1',
    'fe80::1%en0',
    'FD00::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '::ffff:808:808', '::ffff:8.8.8.8', '2606:4700:4700::1111'])(
    'allows %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    }
  );
});

describe('isSafePublicHttpsUrl', () => {
  it.each([
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:a9fe:a9fe]/',
  ])('rejects %s', async (url) => {
    await expect(isSafePublicHttpsUrl(url)).resolves.toBe(false);
  });
});
