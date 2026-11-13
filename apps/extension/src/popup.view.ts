/**
 * What the toolbar popup shows, from the background's POPUP_STATUS reply.
 * Pure, so popup.view.spec.ts covers every state; popup.ts only renders it.
 * Imports nothing, so the popup's bundle shares no code with background.js.
 */
export interface PopupStatusView {
  version: string;
  hookpostReachable: boolean;
  skoolSignedIn: boolean;
  connectedChannels: number;
  addChannelUrl: string;
}

export interface PopupRow {
  label: string;
  value: string;
  ok: boolean;
}

export interface PopupView {
  rows: PopupRow[];
  button: { text: string; href: string };
  howItWorks: string;
  footer: string;
  error?: string;
}

const FALLBACK_ADD_CHANNEL_URL = 'https://hookpost.hookstep.in/launches?add_channel=1';
const BUTTON_TEXT = 'Open Hookpost → Add Channel → Skool';
const HOW_IT_WORKS =
  'In Hookpost, open Add Channel and choose Skool. This extension passes your Skool sign-in to Hookpost so it can post for you, and keeps it fresh once a day.';

export function describePopup(status: PopupStatusView | undefined): PopupView {
  if (!status) {
    return {
      rows: [],
      button: { text: BUTTON_TEXT, href: FALLBACK_ADD_CHANNEL_URL },
      howItWorks: HOW_IT_WORKS,
      footer: '',
      error: 'Could not read the extension status. Close and reopen this popup.',
    };
  }
  const n = status.connectedChannels;
  return {
    rows: [
      {
        label: 'Hookpost',
        value: status.hookpostReachable ? 'Reachable' : 'Not reachable. Check your connection.',
        ok: status.hookpostReachable,
      },
      {
        label: 'Skool',
        value: status.skoolSignedIn
          ? 'Signed in on skool.com'
          : 'Not signed in. Log in at skool.com in this browser first.',
        ok: status.skoolSignedIn,
      },
      {
        label: 'Channels kept connected',
        value: n === 0 ? 'None yet' : `${n} Skool channel${n === 1 ? '' : 's'}`,
        ok: true,
      },
    ],
    button: { text: BUTTON_TEXT, href: status.addChannelUrl },
    howItWorks: HOW_IT_WORKS,
    footer: `Version ${status.version}`,
  };
}
