/**
 * The environment every integration test runs with. Shared by env.ts (each
 * test file) and global-setup.ts (schema push), so both point at the same
 * database.
 *
 * Only local or CI-service databases are allowed: assertLocalDatabase() stops
 * the run before anything connects if DATABASE_URL names any other host, so a
 * stray production URL in the shell can never be written to.
 */
import { tmpdir } from 'os';
import { join } from 'path';

export const TEST_DATABASE_URL =
  process.env.HOOKPOST_TEST_DATABASE_URL ||
  'postgresql://hookpost:hookpost-test-password@127.0.0.1:55432/hookpost_test';
export const TEST_REDIS_URL =
  process.env.HOOKPOST_TEST_REDIS_URL || 'redis://127.0.0.1:56379';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'postgres', 'redis']);

export function assertLocalDatabase(url: string, what: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run integration tests: ${what} host "${host}" is not local. ` +
        'Set HOOKPOST_TEST_DATABASE_URL / HOOKPOST_TEST_REDIS_URL to the test stack (tests/stack).'
    );
  }
}

export const UPLOAD_DIR = join(tmpdir(), 'hookpost-int-uploads');

export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    TZ: 'UTC',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    // Never reached: the Temporal client is replaced (fake.temporal.ts).
    TEMPORAL_ADDRESS: '127.0.0.1:1',
    JWT_SECRET: 'integration-test-jwt-secret-not-used-anywhere-else',
    FRONTEND_URL: 'http://localhost:4200',
    MAIN_URL: 'http://localhost:4200',
    NEXT_PUBLIC_BACKEND_URL: 'http://localhost:3000',
    BACKEND_INTERNAL_URL: 'http://localhost:3000',
    // Auth comes back in an `auth` header instead of a Secure cookie, as in
    // local development, so a plain HTTP client can carry it.
    NOT_SECURED: 'true',
    IS_GENERAL: 'true',
    STORAGE_PROVIDER: 'local',
    UPLOAD_DIRECTORY: UPLOAD_DIR,
    NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/uploads',
    // Billing on, so plan limits and the paywall gate are enforced the way
    // production enforces them. Razorpay itself is never called: the tests
    // that reach it replace RazorpayService's client.
    RAZORPAY_KEY_ID: 'rzp_test_integration',
    RAZORPAY_KEY_SECRET: 'integration-razorpay-secret',
    RAZORPAY_WEBHOOK_SECRET: 'integration-webhook-secret',
    // The first-month offers (first.month.offer.ts), in Razorpay's id format;
    // FakeRazorpay knows exactly these two.
    RAZORPAY_OFFER_FIRST_MONTH_UPI: 'offer_IntUpi00000001',
    RAZORPAY_OFFER_FIRST_MONTH_CARD: 'offer_IntCard0000001',
    // High enough that only the rate-limit test reaches it.
    API_LIMIT: '1000',
    // No email provider: registration logs straight in (no activation step).
    // The activation test turns EMAIL_PROVIDER on for its own app.
    EMAIL_PROVIDER: '',
    // Billing and support emails are sent only when a key is set. The
    // `resend` package itself is replaced (fake.resend.ts), so this key never
    // leaves the process; the other emails stop at FakeTemporal.
    RESEND_API_KEY: 're_integration_not_a_real_key',
    EMAIL_FROM_ADDRESS: 'test@hookpost.invalid',
    EMAIL_FROM_NAME: 'Hookpost Test',
    // The owner's sale alerts (owner.sales.alert.service.ts), recorded by
    // fake.resend.ts like the billing emails.
    OWNER_SALES_ALERT_EMAIL: 'owner-alerts@hookpost.invalid',
    OPENAI_API_KEY: 'sk-integration-not-a-real-key',
    // review-ask: a placeholder "our own" address (review-ask.int.spec.ts).
    REVIEW_ASK_INTERNAL_EMAILS: 'owner.one@example.com',
    // The default AI provider (ai.provider.ts) is Gemini on Vertex; a project
    // id is all it needs to count as configured. No test reaches Google (the
    // network guard would fail it): the credit checks refuse first.
    VERTEX_PROJECT: 'hookpost-integration',
    // No trial cutoff: the trial gate is off unless a test turns it on.
    TRIAL_REQUIRED_SINCE_IN: '',
    TRIAL_REQUIRED_SINCE_GLOBAL: '',
    FREE_PLAN_SUNSET_AT: '',
    RUN_CRON: '',
    SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_DSN: '',
    // CopilotKit's runtime reports usage to scarf.sh and segment.io when the
    // AI chat is used (the network guard caught it in the E2E run).
    COPILOTKIT_TELEMETRY_DISABLED: 'true',
    DO_NOT_TRACK: '1',
  };
}
