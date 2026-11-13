/**
 * The AI Agent on the Free plan, and the 402 dialog that kept coming back:
 * the Agent is locked on a plan without AI, at most one plan dialog shows at
 * a time, and the caller of a refused request still gets a readable 402.
 *   pnpm exec jest -c apps/frontend/jest.config.ts plan.dialog
 */
import {
  freePostsSwitchTarget,
  aiLocked,
  planLimitPrompt,
  readPlanRefusal,
  showPlanDialogOnce,
} from '@hookpost/frontend/components/layout/plan.limit.prompt';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

describe('aiLocked', () => {
  it('locks the Agent on the Free plan only', () => {
    expect(aiLocked(pricing.FREE)).toBe(true);
    for (const tier of ['STANDARD', 'PRO', 'TEAM', 'ULTIMATE']) {
      if (pricing[tier]) {
        expect(aiLocked(pricing[tier])).toBe(false);
      }
    }
  });

  it('does not lock while the plan is unknown', () => {
    expect(aiLocked(undefined)).toBe(false);
    expect(aiLocked(null)).toBe(false);
    expect(aiLocked({})).toBe(false);
  });
});

describe('showPlanDialogOnce', () => {
  it('drops a second dialog while the first is open, then allows the next one', async () => {
    let close!: (value: boolean) => void;
    const first = jest.fn(
      () => new Promise<boolean>((resolve) => (close = resolve))
    );
    const second = jest.fn(async () => true);

    const firstResult = showPlanDialogOnce(first);
    // A retried request refused while the dialog is still open: nothing chosen.
    await expect(showPlanDialogOnce(second)).resolves.toBeUndefined();
    expect(second).not.toHaveBeenCalled();

    close(true);
    await expect(firstResult).resolves.toBe(true);

    // Closed: the next refusal may show its dialog.
    await expect(showPlanDialogOnce(second)).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('releases the guard when the dialog throws', async () => {
    await expect(
      showPlanDialogOnce(async () => {
        throw new Error('modal failed');
      })
    ).rejects.toThrow('modal failed');
    await expect(showPlanDialogOnce(async () => true)).resolves.toBe(true);
  });
});

describe('readPlanRefusal', () => {
  // jsdom has no fetch Response; this fake consumes its body like one does.
  const refusal = (body: unknown) => {
    let used = false;
    const read = async () => {
      if (used) {
        throw new TypeError('Body has already been consumed.');
      }
      used = true;
      return body;
    };
    const response: any = { status: 402, json: read };
    response.clone = () => ({ json: async () => body });
    return response;
  };

  it('reads the message for the dialog and leaves the body for the caller', async () => {
    const body = {
      statusCode: 402,
      message: 'AI Agent is part of the paid plans',
    };
    const response = refusal(body);
    await expect(readPlanRefusal(response)).resolves.toEqual(body);
    // What the SWR fetcher does next. It threw before, and SWR retried.
    await expect(response.json()).resolves.toEqual(body);
  });

  it('an unreadable body gives the dialog an empty object', async () => {
    const response: any = {
      clone: () => ({
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }),
    };
    await expect(readPlanRefusal(response)).resolves.toEqual({});
  });
});

describe('planLimitPrompt: a failing payment', () => {
  it('PAYMENT_FAILING: the backend message, a pay button, and the pay-from-another-account page', () => {
    const p = planLimitPrompt({
      code: 'PAYMENT_FAILING',
      message: "Your last payment didn't go through, so AI and X are paused until it does.",
    });
    expect(p.title).toBe('Payment failed');
    expect(p.button).toBe('Pay from a different account');
    expect(p.href).toBe('/billing?pay=another-account');
    expect(p.message).toMatch(/AI and X are paused/);
  });

  it('every other refusal still goes to the plans (no href)', () => {
    expect(planLimitPrompt({ code: 'PLAN_REQUIRED' }).href).toBeUndefined();
    expect(planLimitPrompt({}).href).toBeUndefined();
  });
});

describe('planLimitPrompt: free posts left in your other workspace (item 11)', () => {
  const body = {
    code: 'FREE_POSTS_USED',
    message: 'Your workspace "Chai" still has 2 free posts with this LinkedIn account. Switch to it from the workspace menu to use them, or pick a plan to post from here.',
    switchTo: { id: 'org-2', name: 'Chai', left: 2 },
  };
  it('offers [Switch to Chai] and [See plans]', () => {
    expect(planLimitPrompt(body)).toMatchObject({
      message: body.message,
      button: 'Switch to Chai',
      secondButton: 'See plans',
      switchTo: { id: 'org-2', name: 'Chai', left: 2 },
    });
  });
  it('the general copy has only [See plans]', () => {
    const p = planLimitPrompt({ code: 'FREE_POSTS_USED', message: 'This X account has already used its free posts on Hookpost.' });
    expect(p).toMatchObject({ button: 'See plans' });
    expect(p.switchTo).toBeUndefined();
  });
  it.each([
    [{ id: '', name: 'x', left: 1 }],
    [{ id: 'o', name: 'x', left: 0 }],
    [{ id: 'o', left: 2 }],
    ['nonsense'],
  ])('ignores a malformed switch target %p', (switchTo) => {
    expect(freePostsSwitchTarget({ switchTo })).toBeNull();
  });
  it('cuts a very long workspace name for the button', () => {
    expect(freePostsSwitchTarget({ switchTo: { id: 'o', name: 'N'.repeat(200), left: 1 } })!.name).toHaveLength(60);
  });
});
