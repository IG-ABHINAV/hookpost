import 'reflect-metadata';
import { VerifiedEmailGuard } from '@hookpost/backend/services/auth/verified.email.guard';
import { EMAIL_NOT_VERIFIED } from '@hookpost/nestjs-libraries/services/email.verification';

const context = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any);

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return { status: e.getStatus(), body: e.getResponse() };
  }
  return null;
};

describe('VerifiedEmailGuard', () => {
  const guard = new VerifiedEmailGuard('invite people to your workspace');

  it('lets a confirmed user through', () => {
    expect(guard.canActivate(context({ id: 'u', activated: true }))).toBe(true);
  });

  it.each([
    ['an unconfirmed user', { id: 'u', activated: false }],
    ['a user row without the flag', { id: 'u' }],
    ['no user at all', undefined],
    ['a truthy non-boolean', { id: 'u', activated: 'yes' }],
  ])('refuses %s with 403 EMAIL_NOT_VERIFIED naming the action', (_label, user) => {
    expect(refusal(() => guard.canActivate(context(user)))).toEqual({
      status: 403,
      body: {
        code: EMAIL_NOT_VERIFIED,
        statusCode: 403,
        message: expect.stringMatching(/^Confirm your email address to invite people to your workspace\./),
      },
    });
  });
});
