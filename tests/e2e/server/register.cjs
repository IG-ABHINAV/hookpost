/**
 * Lets plain Node run the backend's TypeScript for the E2E suite, the way
 * tests/integration/jest.config.ts does under jest:
 *
 *  - the @hookpost/* path aliases resolve to their src/ folders (only these:
 *    tsconfig.base.json also maps @langchain/langgraph/prebuilt to a .d.ts,
 *    which must keep resolving to the real package at runtime);
 *  - .ts files are transpiled by ts-node without type-checking, with the
 *    backend's build tsconfig (decorator metadata on, CommonJS).
 *
 *  - `resend` resolves to the recording fake the integration suite uses
 *    (tests/integration/setup/fake.resend.ts), so no email reaches Resend;
 *  - every connection to a host other than localhost is refused and recorded
 *    (tests/integration/setup/network-guard.cjs).
 *
 * ESM-only dependencies need nothing here: Node 22.12+ can require() them.
 *
 *   node -r ./tests/e2e/server/register.cjs tests/e2e/server/backend.ts
 */
const Module = require('module');
const { join } = require('path');

const root = join(__dirname, '..', '..', '..');
const ALIASES = {
  '@hookpost/backend/': 'apps/backend/src/',
  '@hookpost/helpers/': 'libraries/helpers/src/',
  '@hookpost/nestjs-libraries/': 'libraries/nestjs-libraries/src/',
  '@hookpost/orchestrator/': 'apps/orchestrator/src/',
};

const FAKES = {
  resend: join(root, 'tests/integration/setup/fake.resend.ts'),
};

require(join(root, 'tests/integration/setup/network-guard.cjs')).install();

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(FAKES, request)) {
    return resolve.call(this, FAKES[request], ...rest);
  }
  for (const [prefix, dir] of Object.entries(ALIASES)) {
    if (request.startsWith(prefix)) {
      return resolve.call(this, join(root, dir, request.slice(prefix.length)), ...rest);
    }
  }
  return resolve.call(this, request, ...rest);
};

require('ts-node').register({
  project: join(root, 'apps/backend/tsconfig.build.json'),
  transpileOnly: true,
  // The integration helpers this server reuses are outside apps/backend.
  ignore: [/node_modules/],
  compilerOptions: { module: 'commonjs' },
});
