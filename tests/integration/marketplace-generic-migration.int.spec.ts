/**
 * marketplace-generic.migration.sql on a copy of the schema as production
 * has it today (schema.prisma without Organization.source and
 * MarketplaceUsageDay), in its own Postgres schema of the test database,
 * applied the way production applies it (psql -f): twice, the second run
 * changing nothing; afterwards the database is exactly schema.prisma, every
 * existing workspace reads DIRECT except the ones a MarketplaceAccount owns,
 * which read that account's marketplace, and no row is lost.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts marketplace-generic-migration
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
const MIGRATION = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/marketplace-generic.migration.sql');
const PG_SCHEMA = 'mkt_generic_migration_check';

const withSchema = (url: string, schema: string) => {
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  return u.toString();
};

describe('marketplace-generic.migration.sql', () => {
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  beforeAll(async () => {
    const before = withoutGenericMarketplace(readFileSync(SCHEMA, 'utf8'));
    expect(before).toContain('model MarketplaceAccount');
    const beforeFile = join(mkdtempSync(join(tmpdir(), 'mkt-generic-migration-')), 'before.prisma');
    writeFileSync(beforeFile, before);
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    const q = (sql: string) => client.$executeRawUnsafe(sql);
    await q(`INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES
      ('org-direct', 'Signed up', now()),
      ('org-apimkt', 'api.market subscriber 1a2b3c4d', now()),
      ('org-rapid', 'RapidAPI subscriber 5e6f7a8b', now())`);
    await q(`INSERT INTO "${PG_SCHEMA}"."MarketplaceAccount"
      ("id", "marketplace", "externalUserId", "product", "plan", "organizationId", "updatedAt") VALUES
      ('acc-1', 'API_MARKET', 'cll8kolno0000l808v6p3xvax', 'social', 'trial', 'org-apimkt', now()),
      ('acc-2', 'RAPIDAPI', 'someone', 'validate', 'starter', 'org-rapid', now())`);
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

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

  const diff = () => {
    try {
      execFileSync(PRISMA, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--exit-code'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      return 0;
    } catch (e: any) {
      return e.status;
    }
  };

  it('applies twice cleanly, leaves the database exactly as schema.prisma says, and backfills each source', async () => {
    expect(diff()).toBe(2);
    apply();
    apply();
    expect(diff()).toBe(0);
    const rows = await client.$queryRawUnsafe<{ id: string; source: string }[]>(
      `SELECT id, source FROM "${PG_SCHEMA}"."Organization" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 'org-apimkt', source: 'API_MARKET' },
      { id: 'org-direct', source: 'DIRECT' },
      { id: 'org-rapid', source: 'RAPIDAPI' },
    ]);
    const accounts = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${PG_SCHEMA}"."MarketplaceAccount"`
    );
    expect(Number(accounts[0].n)).toBe(2);
  }, 120_000);

  it('only adds: no DROP, DELETE, TRUNCATE or RENAME, and a 5 s lock timeout before the ALTER', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    expect(sql.indexOf("SET lock_timeout = '5s'")).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(sql.indexOf("SET lock_timeout = '5s'")).toBeLessThan(sql.indexOf('ALTER TABLE'));
  });
});
