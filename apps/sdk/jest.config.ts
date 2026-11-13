/* SDK unit tests, in Node. Run from the repo root:
 *   pnpm exec jest -c apps/sdk/jest.config.ts
 * The spec mocks node-fetch (the SDK imports fetch and FormData from it), so
 * nothing here opens a socket. */
export default {
  displayName: 'sdk',
  rootDir: '../..',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/sdk/src'],
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
  moduleNameMapper: {
    '^@hookpost/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
  },
};
