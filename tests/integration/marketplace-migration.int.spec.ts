/**
 * marketplace-account.migration.sql on a copy of the schema as production
 * had it before (schema.prisma without MarketplaceAccount, and without what
 * marketplace-generic.migration.sql adds after it), in its own
 * Postgres schema of the test database, applied the way production applies
 * it (psql -f): twice, the second run changing nothing, and afterwards the
 * database is exactly that schema with MarketplaceAccount (prisma migrate
 * diff finds nothing left to do). The existing tables keep their rows.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts marketplace-migration
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './setup/test-env';
import { withoutGenericMarketplace } from './setup/marketplace-schema';

const ROOT = join(__dirname, '..', '..');
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const MIGRATION = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/marketplace-account.migration.sql');
const PG_SCHEMA = 'mkt_migration_check';

const withSchema = (url: string, schema: string) => {
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  return u.toString();
};

describe('marketplace-account.migration.sql', () => {
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  let afterFile: string;

  beforeAll(async () => {
    // The schema this migration was written against: schema.prisma before
    // marketplace-generic.migration.sql, and without MarketplaceAccount.
    const after = withoutGenericMarketplace(readFileSync(SCHEMA, 'utf8'));
    const before = after.replace(
      /\n\/\/ A subscriber of a Hookpost product on an API marketplace[\s\S]*?\nmodel MarketplaceAccount \{[\s\S]*?\n\}\n/,
      '\n'
    );
    expect(before).not.toContain('MarketplaceAccount');
    const dir = mkdtempSync(join(tmpdir(), 'mkt-migration-'));
    const beforeFile = join(dir, 'before.prisma');
    afterFile = join(dir, 'after.prisma');
    writeFileSync(beforeFile, before);
    writeFileSync(afterFile, after);
    // A throwaway schema of the local test database (asserted local by env.ts).
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe(
      `INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES ('org-before-migration', 'Existing', now())`
    );
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

  // As production applies it: psql -f, one session; PGOPTIONS points that
  // session at the copy. Where there is no psql (a bare CI runner), prisma
  // db execute runs the same file in one session on the same schema.
  const apply = () => {
    try {
      execFileSync('psql', ['--version'], { stdio: 'pipe' });
    } catch {
      execFileSync(PRISMA, ['db', 'execute', '--url', url, '--file', MIGRATION], { stdio: 'pipe' });
      return;
    }
    execFileSync('psql', [TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
      env: { ...process.env, PGOPTIONS: `-c search_path=${PG_SCHEMA}` },
      stdio: 'pipe',
    });
  };

  // 0 when the database is exactly schema.prisma, 2 when it differs.
  const diff = () => {
    try {
      execFileSync(PRISMA, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', afterFile, '--exit-code'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      return 0;
    } catch (e: any) {
      return e.status;
    }
  };

  it('applies twice cleanly, and leaves the database exactly as the schema with MarketplaceAccount says', async () => {
    expect(diff()).toBe(2);
    apply();
    apply();
    expect(diff()).toBe(0);
    const rows = await client.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${PG_SCHEMA}"."Organization"`);
    expect(rows.map((r) => r.id)).toEqual(['org-before-migration']);
  }, 120_000);
});
