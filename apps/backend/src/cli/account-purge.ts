/**
 * Command-line entry for the account purge (AccountPurgeService). It is
 * compiled with the backend, so every deploy ships it; the server cron runs it
 * through scripts/purge-deleted-accounts.sh, which loads .env first:
 *
 *   node --experimental-require-module apps/backend/dist/apps/backend/src/cli/account-purge.js [--dry-run]
 *
 * Dry run unless ACCOUNT_PURGE_ENABLED=true; --dry-run forces one even then.
 * ACCOUNT_PURGE_BATCH (default 10, at most 100) and ACCOUNT_PURGE_MIN_DAYS
 * (default and minimum 30) tune it. Exit code 1 when a workspace or account
 * failed. Prints ids and counts, never a secret or a file URL.
 */
import { PrismaClient } from '@prisma/client';
import { AccountPurgeRepository } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.repository';
import { AccountPurgeService } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.service';

// Shared with the media retention run (MediaRetentionService).
import {
  cloudflareCachePurger,
  purgeStores,
} from '@hookpost/nestjs-libraries/upload/purge.stores';

export { cloudflareCachePurger, purgeStores };

export const purgeEnabled = (argv: string[], env = process.env) =>
  !argv.includes('--dry-run') && env.ACCOUNT_PURGE_ENABLED === 'true';

async function main() {
  const prisma = new PrismaClient();
  try {
    const service = new AccountPurgeService(
      new AccountPurgeRepository({ model: prisma } as any, {
        model: prisma,
      } as any)
    );
    const purgeCache = cloudflareCachePurger();
    const report = await service.run({
      enabled: purgeEnabled(process.argv.slice(2)),
      batch: Number(process.env.ACCOUNT_PURGE_BATCH) || undefined,
      minDays: Number(process.env.ACCOUNT_PURGE_MIN_DAYS) || undefined,
      stores: purgeStores(),
      purgeCache: purgeCache
        ? (urls) =>
            purgeCache(urls).catch((err) => {
              console.log(`  cache purge failed (files are deleted): ${err.message}`);
            })
        : undefined,
      log: (line) => console.log(line),
    });
    if (
      !purgeCache &&
      report.organizations.some((o) => (o.files?.deleted || 0) > 0)
    ) {
      console.log('  CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID not set: deleted files may stay in the CDN cache until it expires.');
    }
    process.exitCode = report.failed ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const line = String(err?.message || err).split('\n').find((l) => l.trim());
    console.error(`Account purge stopped: ${(line || 'error').slice(0, 300)}`);
    process.exitCode = 1;
  });
}
