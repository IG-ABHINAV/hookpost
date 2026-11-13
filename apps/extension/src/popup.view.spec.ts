/**
 * What the toolbar popup says for each state (popup.view.ts).
 *   pnpm exec jest -c apps/extension/jest.config.ts popup
 */
import { describePopup } from './popup.view';

const base = {
  version: '1.0.2',
  hookpostReachable: true,
  skoolSignedIn: true,
  connectedChannels: 0,
  addChannelUrl: 'https://hookpost.hookstep.in/launches?add_channel=1',
};

describe('describePopup', () => {
  it('ready to connect: both checks pass, and the button opens Add Channel', () => {
    const view = describePopup(base);
    expect(view.rows).toEqual([
      { label: 'Hookpost', value: 'Reachable', ok: true },
      { label: 'Skool', value: 'Signed in on skool.com', ok: true },
      { label: 'Channels kept connected', value: 'None yet', ok: true },
    ]);
    expect(view.button).toEqual({ text: 'Open Hookpost → Add Channel → Skool', href: base.addChannelUrl });
    expect(view.howItWorks).toMatch(/Add Channel.*Skool/);
    expect(view.footer).toBe('Version 1.0.2');
  });

  it('not signed in to Skool: says so and how to fix it', () => {
    const view = describePopup({ ...base, skoolSignedIn: false });
    expect(view.rows[1]).toEqual({ label: 'Skool', value: 'Not signed in. Log in at skool.com in this browser first.', ok: false });
  });

  it('Hookpost unreachable', () => {
    expect(describePopup({ ...base, hookpostReachable: false }).rows[0]).toEqual({
      label: 'Hookpost',
      value: 'Not reachable. Check your connection.',
      ok: false,
    });
  });

  it('counts channels kept connected', () => {
    expect(describePopup({ ...base, connectedChannels: 1 }).rows[2].value).toBe('1 Skool channel');
    expect(describePopup({ ...base, connectedChannels: 3 }).rows[2].value).toBe('3 Skool channels');
  });

  it('no answer from the background: a plain error, the button still works', () => {
    const view = describePopup(undefined);
    expect(view.error).toBe('Could not read the extension status. Close and reopen this popup.');
    expect(view.button.href).toBe('https://hookpost.hookstep.in/launches?add_channel=1');
  });
});
