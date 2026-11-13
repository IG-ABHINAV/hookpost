/**
 * review-ask.migration.sql only adds a new table, guarded so a second run
 * changes nothing. (Applying it twice to a copy of the schema is
 * tests/integration/review-ask.int.spec.ts.)
 *   pnpm exec jest -c apps/backend/jest.config.ts review-ask.migration
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(join(__dirname, '..', 'review-ask.migration.sql'), 'utf8');
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('review-ask.migration.sql', () => {
  it('drops, alters, deletes or updates nothing', () => {
    for (const s of statements) {
      expect(s).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE|RENAME|INSERT)\b/i);
    }
  });

  it('creates only the ReviewAsk table with IF NOT EXISTS, inside one transaction', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^BEGIN$/i);
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS "ReviewAsk" \(/);
    expect(statements[2]).toMatch(/^COMMIT$/i);
  });
});
