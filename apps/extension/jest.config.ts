/* Chrome extension tests, in Node. Run from the repo root:
 *   pnpm exec jest -c apps/extension/jest.config.ts
 * src/*.spec.ts are unit tests (Chrome APIs passed in as fakes);
 * test/manifest.int.spec.ts runs the real build twice (store and dev).
 * The browser test is e2e/extension.e2e.ts (Playwright). */
export default {
  displayName: 'extension',
  rootDir: '../..',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/extension/src', '<rootDir>/apps/extension/test'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          isolatedModules: true,
          module: 'commonjs',
          target: 'es2020',
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
