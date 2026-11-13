/**
 * EmailService.sendEmailSync says whether the email went out, so a caller
 * that claimed "send once" (the media retention notice and reminder,
 * MediaRetentionService) can give the claim back when it did not.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts email.service
 */
jest.mock('@hookpost/helpers/utils/timer', () => ({ timer: async () => undefined }));

import { EmailService } from './email.service';

describe('EmailService.sendEmailSync', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.EMAIL_FROM_ADDRESS = 'support@hookstep.in';
    process.env.EMAIL_FROM_NAME = 'Hookpost';
    process.env.EMAIL_PROVIDER = '';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  const service = (send: jest.Mock) => {
    const s = new EmailService({} as never);
    s.emailService = { name: 'fake', validateEnvKeys: [], sendEmail: send } as any;
    return s;
  };

  it('true once the provider accepted it', async () => {
    const send = jest.fn(async () => ({ id: 'e1' }));
    await expect(service(send).sendEmailSync('a@b.co', 'S', '<p>x</p>')).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('false after three refusals ({ sent: false }) or three throws', async () => {
    const refused = jest.fn(async () => ({ sent: false }));
    await expect(service(refused).sendEmailSync('a@b.co', 'S', '<p>x</p>')).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(3);
    const throwing = jest.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    await expect(service(throwing).sendEmailSync('a@b.co', 'S', '<p>x</p>')).resolves.toBe(false);
  });

  it('a refusal then a send is true', async () => {
    const send = jest.fn().mockResolvedValueOnce({ sent: false }).mockResolvedValueOnce({ id: 'e2' });
    await expect(service(send).sendEmailSync('a@b.co', 'S', '<p>x</p>')).resolves.toBe(true);
  });

  it('false without an address or a sender, and nothing is sent', async () => {
    const send = jest.fn();
    await expect(service(send).sendEmailSync('nobody', 'S', '<p>x</p>')).resolves.toBe(false);
    delete process.env.EMAIL_FROM_NAME;
    await expect(service(send).sendEmailSync('a@b.co', 'S', '<p>x</p>')).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
