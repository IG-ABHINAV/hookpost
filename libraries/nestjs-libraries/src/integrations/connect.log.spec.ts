import { HttpException } from '@nestjs/common';
import {
  connectFailureReason,
  connectLogLine,
  logConnect,
  redactSecrets,
} from '@hookpost/nestjs-libraries/integrations/connect.log';

// The channel-connect log lines: greppable, one JSON object, never a token.
//   pnpm exec jest -c apps/backend/jest.config.ts connect.log

describe('connect log', () => {
  afterEach(() => jest.restoreAllMocks());

  it('connect_start names the provider and the workspace', () => {
    expect(
      connectLogLine('connect_start', {
        provider: 'linkedin',
        orgId: 'org-1',
        onboarding: true,
      })
    ).toBe(
      '[connect] connect_start {"provider":"linkedin","orgId":"org-1","onboarding":true}'
    );
  });

  it('connect_failed carries the reason, with the status of an HttpException', () => {
    const line = connectLogLine('connect_failed', {
      provider: 'facebook',
      orgId: 'org-1',
      reason: new HttpException('This link has expired', 400),
    });
    expect(line).toMatch(/^\[connect\] connect_failed \{/);
    expect(
      JSON.parse(line.replace(/^\[connect\] connect_failed /, ''))
    ).toEqual({
      provider: 'facebook',
      orgId: 'org-1',
      reason: '400 This link has expired',
    });
  });

  it('a failure with no reason still says so', () => {
    expect(connectLogLine('connect_failed', { provider: 'x' })).toContain(
      '"reason":"unknown"'
    );
    expect(connectFailureReason(new Error(''))).toBe('Error');
  });

  it('never logs a token or a secret from a provider error', () => {
    const line = connectLogLine('connect_failed', {
      provider: 'linkedin',
      reason: new Error(
        'token exchange failed: {"access_token":"AQX-live-token","client_secret":"shh"} Authorization: Bearer AQX-live-token ' +
          'a'.repeat(40)
      ),
    });
    expect(line).not.toContain('AQX-live-token');
    expect(line).not.toContain('shh');
    expect(line).not.toContain('a'.repeat(40));
    expect(redactSecrets('refresh_token=abc&x=1')).toBe(
      'refresh_token=<redacted>&x=1'
    );
  });

  it('caps a long reason', () => {
    const line = connectLogLine('connect_failed', {
      reason: 'x'.repeat(1000),
    });
    expect(
      JSON.parse(line.replace(/^\[connect\] connect_failed /, '')).reason
    ).toHaveLength(300);
  });

  it('failures go to stderr, the rest to stdout', () => {
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    logConnect('connect_failed', { provider: 'x', reason: 'boom' });
    logConnect('connect_ok', { provider: 'x', channelId: 'c-1' });
    expect(error).toHaveBeenCalledWith(
      '[connect] connect_failed {"provider":"x","reason":"boom"}'
    );
    expect(log).toHaveBeenCalledWith(
      '[connect] connect_ok {"provider":"x","channelId":"c-1"}'
    );
  });
});
