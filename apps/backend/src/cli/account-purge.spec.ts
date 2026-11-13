import 'reflect-metadata';

// The real storages pull in ESM-only and network modules; only their identity
// matters here.
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ kind: 'configured' }) },
}));
jest.mock('@hookpost/nestjs-libraries/upload/local.storage', () => ({
  LocalStorage: class {
    kind = 'local';
    constructor(public dir: string) {}
  },
}));
jest.mock('@prisma/client', () => ({ PrismaClient: class {} }));

import {
  cloudflareCachePurger,
  purgeEnabled,
  purgeStores,
} from './account-purge';

describe('account purge command line', () => {
  it('purges only with ACCOUNT_PURGE_ENABLED=true exactly, and --dry-run always wins', () => {
    expect(purgeEnabled([], {})).toBe(false);
    expect(purgeEnabled([], { ACCOUNT_PURGE_ENABLED: 'TRUE' })).toBe(false);
    expect(purgeEnabled([], { ACCOUNT_PURGE_ENABLED: '1' })).toBe(false);
    expect(purgeEnabled([], { ACCOUNT_PURGE_ENABLED: 'true' })).toBe(true);
    expect(purgeEnabled(['--dry-run'], { ACCOUNT_PURGE_ENABLED: 'true' })).toBe(false);
  });

  it('also cleans the old upload directory when the main storage is R2', () => {
    expect(
      purgeStores({ STORAGE_PROVIDER: 'cloudflare', UPLOAD_DIRECTORY: '/srv/uploads' }).map((s: any) => s.kind)
    ).toEqual(['configured', 'local']);
    expect(purgeStores({ STORAGE_PROVIDER: 'cloudflare' }).map((s: any) => s.kind)).toEqual(['configured']);
    expect(
      purgeStores({ STORAGE_PROVIDER: 'local', UPLOAD_DIRECTORY: '/srv/uploads' }).map((s: any) => s.kind)
    ).toEqual(['configured']);
  });

  it('purges the CDN cache 30 URLs at a time, only when configured', async () => {
    expect(cloudflareCachePurger({})).toBeUndefined();

    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    const purge = cloudflareCachePurger(
      { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone-1' },
      fetchImpl
    )!;
    const urls = Array.from({ length: 65 }, (_, i) => `https://media.hookstep.in/f${i}.png`);
    await purge(urls);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache');
    expect(JSON.parse(init.body).files).toHaveLength(30);
    expect(init.headers.Authorization).toBe('Bearer token');

    const failing = cloudflareCachePurger(
      { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone-1' },
      jest.fn(async () => ({ ok: false, status: 403 })) as any
    )!;
    await expect(failing(['https://media.hookstep.in/a.png'])).rejects.toThrow('403');
  });
});
