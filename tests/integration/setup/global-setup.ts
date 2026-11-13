/**
 * Once per integration run: bring the test database to the current Prisma
 * schema and empty it, and empty Redis (rate-limit counters, locks).
 *
 * `prisma db push` is fine HERE because the database is a throwaway test one
 * (assertLocalDatabase). It is never run against production, where schema
 * changes go through migrations.
 */
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import {
  assertLocalDatabase,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  UPLOAD_DIR,
} from './test-env';

export default async function globalSetup() {
  assertLocalDatabase(TEST_DATABASE_URL, 'DATABASE_URL');
  assertLocalDatabase(TEST_REDIS_URL, 'REDIS_URL');
  const root = join(__dirname, '..', '..', '..');
  execFileSync(
    join(root, 'node_modules', '.bin', 'prisma'),
    [
      'db',
      'push',
      '--schema',
      join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma'),
      '--skip-generate',
      '--force-reset',
      '--accept-data-loss',
    ],
    {
      stdio: process.env.CI ? 'inherit' : 'ignore',
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    }
  );
  const { Redis } = await import('ioredis');
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.flushall();
  redis.disconnect();
  mkdirSync(UPLOAD_DIR, { recursive: true });
}
