/**
 * The ledger's keys and day arithmetic (marketplace.ledger.ts). The Lua
 * scripts themselves run against Redis in tests/integration/marketplace.int.spec.ts
 * (50 parallel holds, refunds, windows).
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.ledger
 */
import { ledgerKeys, secondsUntilDayAfter, utcDay } from '@hookpost/backend/marketplace-api/marketplace.ledger';

describe('ledger keys', () => {
  it('scopes every counter to what it caps', () => {
    const start = new Date('2026-10-25T10:00:00Z');
    expect(ledgerKeys.quota('acc', start, 3)).toBe(`mkt:q:acc:${start.getTime()}:3`);
    expect(ledgerKeys.quotaAlert(ledgerKeys.quota('acc', start, 3))).toBe(`mkt:qalert:acc:${start.getTime()}:3`);
    expect(ledgerKeys.xDay('chan', '2026-10-25')).toBe('mkt:xday:chan:2026-10-25');
    expect(ledgerKeys.youtubeAll('2026-10-25')).toBe('mkt:ytday:all:2026-10-25');
    expect(ledgerKeys.youtubeAccount('acc', '2026-10-25')).toBe('mkt:ytday:acc:2026-10-25');
    expect(ledgerKeys.trialX('2026-10-25')).toBe('mkt:trialx:2026-10-25');
    expect(ledgerKeys.bucket('acc', 'write')).toBe('mkt:rl:acc:write');
  });

  it('gives a new plan (a new periodStart) its own quota counter, even for the same window index', () => {
    const before = new Date('2026-10-01T00:00:00Z');
    const after = new Date('2026-10-06T00:00:00Z');
    expect(ledgerKeys.quota('acc', before, 0)).not.toBe(ledgerKeys.quota('acc', after, 0));
    expect(ledgerKeys.quota('acc', after, 0)).not.toBe(ledgerKeys.quota('other', after, 0));
  });

  it('scopes repeats to the product and the subscriber, so one subscriber can never read another\'s answer', () => {
    expect(ledgerKeys.idemRequest('x', 'u1', 'r1')).not.toBe(ledgerKeys.idemRequest('x', 'u2', 'r1'));
    expect(ledgerKeys.idemKey('x', 'u1', 'k1')).not.toBe(ledgerKeys.idemKey('social', 'u1', 'k1'));
  });
});

describe('days', () => {
  it('names the UTC day', () => {
    expect(utcDay(new Date('2026-10-25T23:59:59Z'))).toBe('2026-10-25');
    expect(utcDay(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26');
  });

  it('keeps a day counter until a day after that day ends, even for a day weeks ahead', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(secondsUntilDayAfter(now, now)).toBe(36 * 3600);
    expect(secondsUntilDayAfter(new Date('2026-11-20T08:00:00Z'), now)).toBe(
      (Date.parse('2026-11-22T00:00:00Z') - now.getTime()) / 1000
    );
    expect(secondsUntilDayAfter(new Date('2026-01-01T00:00:00Z'), now)).toBe(60);
  });
});
