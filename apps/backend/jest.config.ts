/* Backend unit tests. Run from the repo root:
 *   pnpm exec jest -c apps/backend/jest.config.ts
 * Specs mock the database layer; nothing here needs Postgres or Redis.
 * scripts/ is included for the specs of the operational scripts there, and
 * apps/orchestrator/src for the Temporal activities (the orchestrator has no
 * jest config of its own, and CI runs only this one and the frontend's). */
export default {
  displayName: 'backend',
  rootDir: '../..',
  testEnvironment: 'node',
  roots: [
    '<rootDir>/apps/backend/src',
    '<rootDir>/libraries/nestjs-libraries/src',
    '<rootDir>/scripts',
    '<rootDir>/apps/orchestrator/src',
  ],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // JEST_TRANSPILE_ONLY=1 (the nightly sets it): transpile each file
        // instead of type-checking the whole backend graph. Type-checking
        // takes ~2.7 GB per worker on a cold cache, past the ~2 GB heap a
        // GitHub runner's Node gives each worker, so every file died there.
        // Without it, specs are still type-checked as before.
        isolatedModules: process.env.JEST_TRANSPILE_ONLY === '1',
        tsconfig: '<rootDir>/apps/backend/tsconfig.build.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@hookpost/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@hookpost/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@hookpost/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
  },
};
