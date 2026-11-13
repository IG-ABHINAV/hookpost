/**
 * What the app says after an invite (InviteResultToast).
 *   pnpm exec jest -c apps/frontend/jest.config.ts invite.result
 */
import {
  inviteResultMessage,
  readInviteResult,
} from '@hookpost/frontend/components/layout/invite.result';
import { INVITE_OUTCOMES } from '@hookpost/helpers/auth/team.invite';

describe('inviteResultMessage', () => {
  it('a fixed sentence for every outcome but held (the banner names the team then)', () => {
    for (const outcome of INVITE_OUTCOMES) {
      const message = inviteResultMessage(outcome);
      if (outcome === 'held') {
        expect(message).toBeNull();
      } else {
        expect(message?.text).toMatch(/\.$/);
      }
    }
    expect(inviteResultMessage('joined')).toEqual({ text: "You've joined the team.", ok: true });
    expect(inviteResultMessage('full')?.ok).toBe(false);
    expect(inviteResultMessage('invalid')?.text).toMatch(/expired or was already used/);
  });

  it('joined or already a member names the workspace now shown (read from the server), cut to 60', () => {
    expect(inviteResultMessage('joined', 'Acme Team')).toEqual({ text: "You've joined Acme Team.", ok: true });
    expect(inviteResultMessage('member', ' Acme Team ')).toEqual({ text: "You're already a member of Acme Team.", ok: true });
    const long = 'x'.repeat(80);
    expect(inviteResultMessage('joined', long)!.text).toBe(`You've joined ${'x'.repeat(59)}….`);
    // No name to hand: the plain sentence.
    expect(inviteResultMessage('joined', '  ')!.text).toBe("You've joined the team.");
    expect(inviteResultMessage('joined', null)!.text).toBe("You've joined the team.");
    // A name is only ever used for these two.
    expect(inviteResultMessage('full', 'Acme Team')!.text).not.toContain('Acme');
    expect(inviteResultMessage('held', 'Acme Team')).toBeNull();
  });

  it('anything else in the cookie says nothing (it is never shown as text)', () => {
    for (const v of ['', 'JOINED', '<img src=x onerror=alert(1)>', 'Acme https://evil.example', null, 1]) {
      expect(inviteResultMessage(v)).toBeNull();
    }
  });
});

describe('readInviteResult', () => {
  it('finds the cookie among others', () => {
    expect(readInviteResult('a=1; hp_invite=joined; b=2')).toBe('joined');
    expect(readInviteResult('hp_invite=full')).toBe('full');
    expect(readInviteResult('xhp_invite=joined; a=1')).toBeNull();
    expect(readInviteResult('')).toBeNull();
  });
});
