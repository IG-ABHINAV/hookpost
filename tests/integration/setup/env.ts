/* Runs before each integration test file is loaded (jest setupFiles), so the
 * backend modules read these values when they are first imported. */
import { assertLocalDatabase, testEnv } from './test-env';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { install: installNetworkGuard } = require('./network-guard.cjs');

const env = testEnv();
for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}
assertLocalDatabase(env.DATABASE_URL, 'DATABASE_URL');
assertLocalDatabase(env.REDIS_URL, 'REDIS_URL');

// No request leaves this machine: a connection to any other host is refused,
// and after-env.ts fails the test that made it.
installNetworkGuard();
