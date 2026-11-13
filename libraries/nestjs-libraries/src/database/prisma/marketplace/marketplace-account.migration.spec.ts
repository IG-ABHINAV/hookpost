/**
 * marketplace-account.migration.sql only adds: a new table and its indexes,
 * each guarded so a second run changes nothing. (Applying it twice to a copy
 * of the schema is tests/integration/marketplace-migration.int.spec.ts.)
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace-account.migration
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(
  join(__dirname, '..', 'marketplace-account.migration.sql'),
  'utf8'
);
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('marketplace-account.migration.sql', () => {
  it('drops, alters, deletes or updates nothing', () => {
    for (const s of statements) {
      expect(s).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
    }
  });

  it('creates only with IF NOT EXISTS, inside one transaction', () => {
    expect(statements[0]).toMatch(/^BEGIN$/i);
    expect(statements[statements.length - 1]).toMatch(/^COMMIT$/i);
    for (const s of statements.slice(1, -1)) {
      expect(s).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS "MarketplaceAccount/);
    }
  });

  it('creates the unique indexes the provisioning race relies on', () => {
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS "MarketplaceAccount_marketplace_externalUserId_product_key"/);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS "MarketplaceAccount_organizationId_key"/);
  });
});
