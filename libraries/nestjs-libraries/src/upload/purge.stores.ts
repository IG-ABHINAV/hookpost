import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { LocalStorage } from '@hookpost/nestjs-libraries/upload/local.storage';
import { PurgeFileStore } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.service';

// Where the purges (the account purge, scripts/purge-deleted-accounts.sh, and
// the media retention run, MediaRetentionService) delete files from, and how
// they drop them from the CDN cache.

/**
 * The configured storage, plus the server's upload directory when the main
 * storage is R2: files uploaded before R2 was switched on are still on disk,
 * served under FRONTEND_URL/uploads.
 */
export const purgeStores = (env = process.env): PurgeFileStore[] => {
  const stores: PurgeFileStore[] = [UploadFactory.createStorage()];
  if ((env.STORAGE_PROVIDER || 'local') !== 'local' && env.UPLOAD_DIRECTORY) {
    stores.push(new LocalStorage(env.UPLOAD_DIRECTORY));
  }
  return stores;
};

/**
 * Removes deleted files from Cloudflare's cache (the same scoped token as
 * scripts/cf-purge.sh), 30 URLs per request. Undefined when not configured:
 * cached copies then expire on their own.
 */
export const cloudflareCachePurger = (
  env = process.env,
  fetchImpl: typeof fetch = fetch
) => {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zone = env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone) {
    return undefined;
  }
  return async (urls: string[]) => {
    for (let i = 0; i < urls.length; i += 30) {
      const res = await fetchImpl(
        `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: urls.slice(i, i + 30) }),
        }
      );
      if (!res.ok) {
        throw new Error(`Cloudflare cache purge answered ${res.status}`);
      }
    }
  };
};
