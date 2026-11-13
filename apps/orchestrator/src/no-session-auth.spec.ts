// Login sessions expire since 22 Oct 2026 (30 days, renewed in use, ended by
// a password reset). The orchestrator and its Temporal workflows run with no
// browser behind them, so nothing here may depend on a session: they read
// posts and channels straight from the database and post with each channel's
// own stored token. This pins that, so expiry can never stop a queued post.
//   pnpm exec jest -c apps/backend/jest.config.ts no-session-auth

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { AuthService } from '@hookpost/helpers/auth/auth.service';

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = [
  join(ROOT, 'apps/orchestrator/src'),
  join(ROOT, 'libraries/nestjs-libraries/src/temporal'),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

const SESSION_USE =
  /verifySessionJWT|signSessionJWT|verifyLegacySessionJWT|sessionMatchesPassword|cookies\??\.auth\b|headers\??\.auth\b|['"]auth['"]\s*:/;

describe('orchestrator and Temporal workers: no login session anywhere', () => {
  it('no source reads, signs or sends a session token', () => {
    const files = DIRS.flatMap(sources);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .filter((f) => SESSION_USE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the stored channel credentials they decrypt do not depend on sessions', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'orchestrator-spec-secret';
    try {
      const stored = AuthService.fixedEncryption('channel-token');
      expect(AuthService.fixedDecryption(stored)).toBe('channel-token');
    } finally {
      if (saved === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = saved;
    }
  });
});
