/**
 * Importing the Resend provider must never need a key.
 *
 * email.service.ts imports every provider so selectProvider() can choose one,
 * EmptyProvider ("do not send") included. While the Resend client was built
 * in this module's body, a blank RESEND_API_KEY threw "Missing API key"
 * during that import, before Nest started - so EMAIL_PROVIDER="" could not be
 * reached and the backend crash-looped instead of running with email off.
 * Found on 2026-10-29 bringing up the billing sandbox, which has no key on
 * purpose.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts resend.provider
 */
describe('ResendProvider without a key', () => {
  const original = process.env.RESEND_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.RESEND_API_KEY;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = original;
  });

  it('imports and constructs', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResendProvider } = require('./resend.provider');
      new ResendProvider();
    }).not.toThrow();
  });

  it('turns a send into a failure, not a crash', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResendProvider } = require('./resend.provider');
    await expect(
      new ResendProvider().sendEmail(
        'someone@example.com',
        'subject',
        '<p>body</p>',
        'Hookpost',
        'noreply@example.com'
      )
    ).resolves.toEqual({ sent: false });
  });

  it('is what lets EmailService fall back to EmptyProvider', () => {
    process.env.EMAIL_PROVIDER = '';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EmailService } = require('../services/email.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EmptyProvider } = require('./empty.provider');
    const service = new EmailService({} as never);
    expect(service.emailService).toBeInstanceOf(EmptyProvider);
    expect(service.hasProvider()).toBe(false);
  });
});

describe('ResendProvider when Resend refuses', () => {
  it('a { error } answer is a failure ({ sent: false }), so the caller can tell', async () => {
    jest.resetModules();
    jest.doMock('resend', () => ({
      Resend: class {
        emails = {
          send: async () => ({ data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } }),
        };
      },
    }));
    process.env.RESEND_API_KEY = 're_test';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResendProvider } = require('./resend.provider');
    await expect(
      new ResendProvider().sendEmail('someone@example.com', 'subject', '<p>body</p>', 'Hookpost', 'noreply@example.com')
    ).resolves.toEqual({ sent: false });
    jest.dontMock('resend');
  });
});
