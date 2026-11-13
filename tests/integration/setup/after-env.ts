/* jest setupFilesAfterEnv, for every integration test file:
 *
 *  - an empty in-memory Razorpay account (fake.razorpay.ts). GET /user/self
 *    asks Razorpay when a paid workspace's trial ends, and seat and account
 *    changes reach it too, so without this any test with a paid workspace
 *    called api.razorpay.com. A file that needs its own account (billing)
 *    installs one on top and uninstalls it afterwards.
 *  - fails the test during which the backend tried to reach a host other
 *    than localhost (network-guard.cjs refused it). Fake that client instead,
 *    as fake.resend.ts / fake.razorpay.ts do. */
import { FakeRazorpay } from './fake.razorpay';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { takeBlocked } = require('./network-guard.cjs');

function assertNoOutboundRequests(when: string) {
  const blocked: { where: string; stack: string }[] = takeBlocked();
  if (!blocked.length) return;
  const where = [...new Set(blocked.map((b) => b.where))].join(', ');
  throw new Error(
    `${when}: the backend tried to reach ${where}. Integration tests talk only to localhost; ` +
      `fake that client (tests/integration/setup).\nFirst attempt:\n${blocked[0].stack}`
  );
}

const razorpay = new FakeRazorpay();
beforeAll(() => {
  razorpay.install();
});
afterAll(() => {
  razorpay.uninstall();
});

beforeEach(() => {
  // A late request from the previous file's work is not this test's fault.
  takeBlocked();
});
afterEach(() => assertNoOutboundRequests('during this test'));
afterAll(() => assertNoOutboundRequests('after the last test of this file'));
