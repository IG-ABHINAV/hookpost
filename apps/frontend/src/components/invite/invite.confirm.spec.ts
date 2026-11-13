/**
 * The Join question a signed-in visitor answers after opening a team invite
 * link (/invite), against a fake backend. Until 25 Oct 2026 the link joined
 * them on the GET; now nothing is joined until Join is pressed.
 *   pnpm exec jest -c apps/frontend/jest.config.ts invite.confirm
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));

import {
  InviteConfirm,
  readInviteQuestion,
} from '@hookpost/frontend/components/invite/invite.confirm';
import { displayName } from '@hookpost/helpers/auth/team.invite';

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const QUESTION = {
  valid: true,
  team: 'Acme Studio',
  inviter: 'Priya Shah',
  member: false,
  confirmEmail: false,
  ref: 'ref-1',
};

let navigate: jest.Mock;
const calls = () => mockFetch.mock.calls.map(([url, init]) => `${init?.method || 'GET'} ${url}`);
const posts = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

function serve(routes: Record<string, (init?: any) => ReturnType<typeof reply>>) {
  mockFetch.mockImplementation(async (url: string, init?: any) => {
    const key = `${init?.method || 'GET'} ${url}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key](init);
  });
}

async function open(props: { armDelayMs?: number } = { armDelayMs: 0 }) {
  render(React.createElement(InviteConfirm, { navigate, ...props }));
  await waitFor(() => expect(screen.queryByText('Checking your invite...')).toBeNull());
}

/** The Join button once it may be pressed (useArmed). */
async function armedJoin(name = 'Join team') {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

let focused: jest.SpyInstance;
beforeEach(() => {
  mockFetch.mockReset();
  navigate = jest.fn();
  // jsdom's document has focus only once an element took it; a real page
  // the visitor is looking at has it.
  focused = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => focused.mockRestore());

describe('displayName: a name somebody else typed, fit to show on one line', () => {
  it('keeps ordinary names, Devanagari and emoji as they are', () => {
    expect(displayName('Acme Studio', 60)).toBe('Acme Studio');
    expect(displayName('हिन्दी टीम', 60)).toBe('हिन्दी टीम');
    expect(displayName('Team 👨‍👩‍👧', 60)).toBe('Team 👨‍👩‍👧');
  });

  it('removes control, direction and zero-width characters, and joins lines', () => {
    expect(displayName('evil\u202Emoc.elpmaxe', 60)).toBe('evilmoc.elpmaxe');
    expect(displayName('a\u0000b\u0007c\u200Bd\uFEFFe\u2066f\u2069', 60)).toBe('abcdef');
    expect(displayName('  line one\nline two\r\n\tthree\u2028four  ', 60)).toBe('line one line two three four');
  });

  it('removes characters that draw nothing (fillers, tags) and caps stacked marks', () => {
    // Hangul fillers, the combining grapheme joiner, a Mongolian selector:
    // a name of them looks blank.
    expect(displayName('\u3164\u115F\u1160\uFFA0\u034F\u180E', 60)).toBe('');
    // Tag characters carry text nobody sees.
    expect(displayName('Acme\u{E0041}\u{E0042}\u{E007F}', 60)).toBe('Acme');
    // Zalgo: at most four combining marks in a row stay.
    const zalgo = 'Z' + '\u0336'.repeat(40) + 'a';
    expect(displayName(zalgo, 60)).toBe('Z' + '\u0336'.repeat(4) + 'a');
    // Real text keeps its marks: Devanagari, an emoji with its selector.
    expect(displayName('\u0915\u094D\u0937\u093F\u0902', 60)).toBe('\u0915\u094D\u0937\u093F\u0902');
    expect(displayName('Team \u2764\uFE0F', 60)).toBe('Team \u2764\uFE0F');
  });

  it('cuts at the limit on whole characters, with an ellipsis', () => {
    expect(displayName('x'.repeat(60), 60)).toBe('x'.repeat(60));
    const cut = displayName('y'.repeat(500), 60);
    expect([...cut]).toHaveLength(60);
    expect(cut.endsWith('…')).toBe(true);
    // An emoji is two UTF-16 units; it is never split.
    const emoji = displayName('😀'.repeat(100), 10);
    expect([...emoji]).toHaveLength(10);
    expect(emoji).toBe(`${'😀'.repeat(9)}…`);
  });

  it('anything that is not a string is ""', () => {
    for (const v of [undefined, null, 42, {}, ['a']]) expect(displayName(v, 60)).toBe('');
    expect(displayName('\u202E\u200B  ', 60)).toBe('');
  });
});

describe('readInviteQuestion', () => {
  it('a valid answer, names cleaned again and defaults filled in', () => {
    expect(readInviteQuestion(QUESTION)).toEqual({ ...QUESTION });
    expect(readInviteQuestion({ ...QUESTION, team: '', inviter: null })).toMatchObject({
      team: 'this team',
      inviter: 'a team member',
    });
    expect(readInviteQuestion({ ...QUESTION, team: 'z'.repeat(300) }).valid && (readInviteQuestion({ ...QUESTION, team: 'z'.repeat(300) }) as any).team).toHaveLength(60);
  });

  it('anything else is "not valid", never a guess', () => {
    for (const body of [null, 'x', {}, { valid: 'true', ref: 'r' }, { valid: true }, { valid: true, ref: '' }, { valid: false, ref: 'r' }]) {
      expect(readInviteQuestion(body)).toEqual({ valid: false });
    }
  });
});

describe('the page', () => {
  it('asks: "Join <team>? You were invited by <name>." and joins nothing while it asks', async () => {
    serve({ 'GET /user/invite': () => reply(200, QUESTION) });
    await open();
    expect(screen.getByTestId('invite-confirm-title').textContent).toBe('Join Acme Studio?');
    expect(screen.getByText(/You were invited by/).textContent).toBe('You were invited by Priya Shah.');
    expect(screen.getByRole('button', { name: 'Join team' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(calls()).toEqual(['GET /user/invite']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('no inviter name: "a team member"', async () => {
    serve({ 'GET /user/invite': () => reply(200, { ...QUESTION, inviter: null }) });
    await open();
    expect(screen.getByText(/You were invited by/).textContent).toBe('You were invited by a team member.');
  });

  it('Join POSTs the ref it was shown (JSON), once, then opens the app', async () => {
    let resolve!: (v: unknown) => void;
    serve({
      'GET /user/invite': () => reply(200, QUESTION),
      'POST /user/invite/accept': () => new Promise((r) => (resolve = r)) as any,
    });
    await open();
    const join = await armedJoin();
    fireEvent.click(join);
    // A double click while the first is on its way sends nothing more.
    fireEvent.click(join);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toEqual(['/user/invite/accept', { method: 'POST', body: JSON.stringify({ ref: 'ref-1' }) }]);
    await act(async () => resolve(reply(200, { id: 'org-1', invite: 'joined' })));
    expect(navigate).toHaveBeenCalledWith('/launches');
  });

  it('a page that loads without focus (behind another window) keeps Join off until it gets focus', async () => {
    focused.mockReturnValue(false);
    serve({ 'GET /user/invite': () => reply(200, QUESTION) });
    await open();
    const join = screen.getByRole('button', { name: 'Join team' }) as HTMLButtonElement;
    await new Promise((r) => setTimeout(r, 50));
    expect(join.disabled).toBe(true);
    focused.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(join.disabled).toBe(false));
  });

  it('Join is off for a moment after the question shows, after the page was hidden, and while another window has focus', async () => {
    jest.useFakeTimers();
    try {
      serve({
        'GET /user/invite': () => reply(200, QUESTION),
        'POST /user/invite/accept': () => reply(200, { id: 'o', invite: 'joined' }),
      });
      render(React.createElement(InviteConfirm, { navigate }));
      const join = (await screen.findByRole('button', { name: 'Join team' })) as HTMLButtonElement;
      // A click that arrives with the page (the second half of a double
      // click, a window swapped under the pointer) does nothing.
      expect(join.disabled).toBe(true);
      fireEvent.click(join);
      act(() => jest.advanceTimersByTime(400));
      expect(join.disabled).toBe(true);
      expect(posts()).toHaveLength(0);
      act(() => jest.advanceTimersByTime(150));
      expect(join.disabled).toBe(false);
      // Hidden and shown again: off again for the same moment.
      const visibility = jest.spyOn(document, 'visibilityState', 'get');
      visibility.mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(join.disabled).toBe(true);
      visibility.mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(join.disabled).toBe(true);
      act(() => jest.advanceTimersByTime(500));
      expect(join.disabled).toBe(false);
      visibility.mockRestore();
      // Another window in front (a popup over this one): off at once, and
      // armed again only some time after focus comes back.
      focused.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(join.disabled).toBe(true);
      act(() => jest.advanceTimersByTime(2000));
      expect(join.disabled).toBe(true);
      focused.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(join.disabled).toBe(true);
      act(() => jest.advanceTimersByTime(499));
      expect(join.disabled).toBe(true);
      act(() => jest.advanceTimersByTime(1));
      expect(join.disabled).toBe(false);
      // "Not now" is never held back.
      expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Not now: the question goes, the invite is not touched, the app opens', async () => {
    serve({
      'GET /user/invite': () => reply(200, QUESTION),
      'POST /user/invite/dismiss': () => reply(201, { dismissed: true }),
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/launches'));
    expect(calls()).toEqual(['GET /user/invite', 'POST /user/invite/dismiss']);
  });

  it('Not now still leaves when the backend does not answer', async () => {
    serve({
      'GET /user/invite': () => reply(200, QUESTION),
      'POST /user/invite/dismiss': () => {
        throw new Error('offline');
      },
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/launches'));
  });

  it('a different invite opened meanwhile (409): asks again about that one, joins nothing', async () => {
    let asked = 0;
    serve({
      'GET /user/invite': () => reply(200, asked++ ? { ...QUESTION, team: 'Other Team', ref: 'ref-2' } : QUESTION),
      'POST /user/invite/accept': () => reply(409, { invite: 'changed' }),
    });
    await open();
    fireEvent.click(await armedJoin());
    await waitFor(() => expect(screen.getByTestId('invite-confirm-title').textContent).toBe('Join Other Team?'));
    expect(screen.getByText(/A different invite was opened/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    // The next click sends the new ref.
    serve({ 'POST /user/invite/accept': () => reply(200, { id: 'o', invite: 'joined' }) });
    fireEvent.click(await armedJoin());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/launches'));
    expect(posts().at(-1)![1].body).toBe(JSON.stringify({ ref: 'ref-2' }));
  });

  it('a refused or failed Join says so and lets them try again', async () => {
    serve({
      'GET /user/invite': () => reply(200, QUESTION),
      'POST /user/invite/accept': () => reply(403, { message: 'no' }),
    });
    await open();
    fireEvent.click(await armedJoin());
    await screen.findByText("We couldn't join just now. Please try again.");
    expect(navigate).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Join team' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an unconfirmed account is told Join waits for the confirmation', async () => {
    serve({ 'GET /user/invite': () => reply(200, { ...QUESTION, confirmEmail: true }) });
    await open();
    expect(screen.getByText("You'll join once you confirm your email address.")).toBeTruthy();
  });

  it('someone already in the team: told so, and the button opens it', async () => {
    serve({ 'GET /user/invite': () => reply(200, { ...QUESTION, member: true }) });
    await open();
    expect(screen.getByTestId('invite-confirm-title').textContent).toBe("You're already a member of Acme Studio.");
    expect(screen.getByRole('button', { name: 'Open team' })).toBeTruthy();
  });

  it('an invite that cannot be used: said plainly, no Join button', async () => {
    serve({
      'GET /user/invite': () => reply(200, { valid: false }),
      'POST /user/invite/dismiss': () => reply(201, {}),
    });
    await open();
    expect(screen.getByRole('alert').textContent).toMatch(/expired or was already used/);
    expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Hookpost' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/launches'));
  });

  it('the backend down: said, no Join button', async () => {
    serve({
      'GET /user/invite': () => {
        throw new Error('offline');
      },
    });
    await open();
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't open that invite/);
    expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull();
  });

  it('markup in a team or inviter name is text: no element, no handler, cut to 60', async () => {
    const team = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>${'A'.repeat(80)}`;
    const inviter = '<a href="https://evil.example">Hookpost Support</a>\u202Egnp.exe';
    serve({ 'GET /user/invite': () => reply(200, { ...QUESTION, team, inviter }) });
    await open();
    const shown = screen.getByTestId('invite-team');
    expect(shown.children).toHaveLength(0);
    expect(shown.textContent).toBe(displayName(team, 60));
    expect([...shown.textContent!]).toHaveLength(60);
    const by = screen.getByTestId('invite-inviter');
    expect(by.children).toHaveLength(0);
    expect(by.textContent).toBe('<a href="https://evil.example">Hookpost Support</a>gnp.exe');
    expect(document.querySelector('img, script:not([src]), a[href]')).toBeNull();
    expect((window as any).__xss).toBeUndefined();
  });
});
