/* Integration tests: the real backend (AppModule) in-process, against a real
 * Postgres and Redis, over HTTP. External services (Temporal server, Razorpay,
 * OpenAI, social networks, email) are replaced at the provider or network
 * boundary, and setup/network-guard.cjs refuses (and fails the test for) any
 * connection to a host other than localhost. Run from the repo root:
 *
 *   docker compose -f tests/stack/docker-compose.test.yaml up -d --wait
 *   pnpm exec jest -c tests/integration/jest.config.ts
 *
 * See TESTING.md. Refuses to run against a database that is not local. */
// The backend parses zone-less dates (find-slot answers "2026-10-22T11:40:00")
// in the process time zone, and production runs in UTC. Set it here, in the
// process that starts the workers: jest gives each test file a copy of
// process.env, so setting TZ in a setup file never reaches Node itself.
process.env.TZ = 'UTC';

export default {
  displayName: 'integration',
  rootDir: '../..',
  // node, plus Node's real require for ESM-only packages (see setup/).
  testEnvironment: '<rootDir>/tests/integration/setup/node-environment.cjs',
  // module-sync: what Node 22's require() matches on packages that publish
  // only an ESM entry (music-metadata).
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons', 'module-sync'],
  },
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.int.spec.ts'],
  globalSetup: '<rootDir>/tests/integration/setup/global-setup.ts',
  setupFiles: ['<rootDir>/tests/integration/setup/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup/after-env.ts'],
  // One Nest app per file, and files share one database: run them one at a
  // time so row counts and rate limits are deterministic.
  maxWorkers: 1,
  // Each file loads the whole backend graph again; recycle the worker before
  // it grows past this instead of letting one process climb to several GB.
  workerIdleMemoryLimit: '1200MB',
  // Booting AppModule takes ~10 s, longer on a loaded machine.
  testTimeout: 120_000,
  // Every node_modules file goes through esm-native-transform, which leaves
  // CommonJS alone and hands ESM-only files to Node's require(esm).
  transformIgnorePatterns: [],
  transform: {
    '/node_modules/.+\\.m?js$': '<rootDir>/tests/integration/setup/esm-native-transform.cjs',
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Transpile only: type-checking the whole backend graph on every run
        // is what makes the unit config slow. tsc in `pnpm run build` covers
        // types.
        isolatedModules: true,
        tsconfig: '<rootDir>/apps/backend/tsconfig.build.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json'],
  moduleNameMapper: {
    // Emails the backend sends straight through Resend are recorded instead.
    '^resend$': '<rootDir>/tests/integration/setup/fake.resend.ts',
    '^@hookpost/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@hookpost/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@hookpost/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@hookpost/orchestrator/(.*)$': '<rootDir>/apps/orchestrator/src/$1',
  },
};
