import {
  TOO_MANY_FALLBACK,
  tooManyAttemptsMessage,
} from './too.many.attempts';

const answer = (status: number, body: string) => ({
  status,
  text: async () => body,
});

describe('tooManyAttemptsMessage', () => {
  it('is null for anything but 429', async () => {
    expect(await tooManyAttemptsMessage(answer(400, 'Invalid user name or password'))).toBeNull();
    expect(await tooManyAttemptsMessage(answer(200, '{}'))).toBeNull();
  });

  it('reads the plain-text sentence sign-in and sign-up send', async () => {
    expect(
      await tooManyAttemptsMessage(
        answer(429, 'Too many sign-in attempts. For your security, please wait 15 minutes and try again, or reset your password.')
      )
    ).toMatch(/wait 15 minutes/);
  });

  it("reads Nest's JSON message (forgot password, resend)", async () => {
    expect(
      await tooManyAttemptsMessage(
        answer(429, JSON.stringify({ statusCode: 429, message: 'Too many attempts. Please wait 1 hour and try again.' }))
      )
    ).toBe('Too many attempts. Please wait 1 hour and try again.');
  });

  it('falls back to a friendly sentence for an empty or odd body', async () => {
    expect(await tooManyAttemptsMessage(answer(429, ''))).toBe(TOO_MANY_FALLBACK);
    expect(await tooManyAttemptsMessage(answer(429, '{"statusCode":429}'))).toBe(TOO_MANY_FALLBACK);
  });
});
