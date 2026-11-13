import {
  GetCookiesResponse,
  ProviderInfo,
  StoredRefreshEntry,
} from './types/messages';
import { CookieProvider } from './providers/cookie-provider.interface';
import { isOriginAllowed, OriginPolicy, senderOrigin } from './config';

/**
 * The extension's logic, with every Chrome API passed in, so it can be tested
 * without a browser (handler.spec.ts). background.ts wires it to chrome.*.
 */
export interface ExtensionDeps {
  policy: OriginPolicy;
  /** Where the daily refresh posts. Fixed at build time, never from a message. */
  backendUrl: string;
  /** The Hookpost app the popup's button opens. Fixed at build time. */
  appUrl: string;
  /** chrome.runtime.id: the popup's messages come from this extension only. */
  extensionId: string;
  version: string;
  getProvider(identifier: string): CookieProvider | undefined;
  getAllProviders(): CookieProvider[];
  extractCookies(provider: CookieProvider): Promise<GetCookiesResponse>;
  loadEntries(): Promise<Record<string, StoredRefreshEntry>>;
  saveEntries(entries: Record<string, StoredRefreshEntry>): Promise<void>;
  ensureAlarm(): Promise<void>;
  clearAlarmIfEmpty(): Promise<void>;
  fetch: typeof fetch;
}

// An integration id is a cuid. No underscore, so "__proto__" cannot be a key.
const INTEGRATION_ID = /^[A-Za-z0-9-]{1,128}$/;
// The refresh token the backend issues (signPurposeJWT): a compact JWS.
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_JWT_LENGTH = 8192;

const isString = (value: unknown): value is string => typeof value === 'string';

type Sender = { origin?: string; url?: string; id?: string };
type Reply = (response: unknown) => void;

/**
 * chrome.runtime.onMessageExternal listener. Returns true when it will reply
 * asynchronously (Chrome keeps the channel open), false otherwise.
 */
export function createExternalMessageHandler(deps: ExtensionDeps) {
  return (message: unknown, sender: Sender, sendResponse: Reply): boolean => {
    // No reply to a page that is not the Hookpost app: it learns nothing.
    // sender.id is set only when another extension is the sender; Chrome
    // already refuses those (no "ids" in externally_connectable), and so do we.
    if (sender.id || !isOriginAllowed(senderOrigin(sender), deps.policy)) {
      return false;
    }
    if (!message || typeof message !== 'object') {
      sendResponse({ error: 'Invalid message' });
      return false;
    }
    const msg = message as Record<string, unknown>;

    switch (msg.type) {
      case 'PING': {
        sendResponse({ status: 'ok', version: deps.version });
        return false;
      }

      case 'GET_PROVIDERS': {
        const providers: ProviderInfo[] = deps.getAllProviders().map((p) => ({
          identifier: p.identifier,
          name: p.name,
          url: p.url,
          cookieNames: p.cookies.map((c) => c.name),
        }));
        sendResponse({ providers });
        return false;
      }

      case 'GET_COOKIES': {
        const provider = isString(msg.provider)
          ? deps.getProvider(msg.provider)
          : undefined;
        if (!provider) {
          sendResponse({
            success: false,
            provider: isString(msg.provider) ? msg.provider : '',
            error: 'Unknown provider',
          });
          return false;
        }
        deps
          .extractCookies(provider)
          .then((result) => sendResponse(result))
          .catch((err) =>
            sendResponse({
              success: false,
              provider: provider.identifier,
              error: `Failed to extract cookies: ${err?.message ?? err}`,
            })
          );
        return true;
      }

      case 'STORE_REFRESH_TOKEN': {
        const { provider, integrationId, jwt } = msg;
        if (
          !isString(provider) ||
          !deps.getProvider(provider) ||
          !isString(integrationId) ||
          !INTEGRATION_ID.test(integrationId) ||
          !isString(jwt) ||
          jwt.length > MAX_JWT_LENGTH ||
          !JWT.test(jwt)
        ) {
          sendResponse({ success: false, error: 'Invalid refresh token' });
          return false;
        }
        // msg.backendUrl is ignored on purpose (see config.ts).
        (async () => {
          const entries = await deps.loadEntries();
          entries[integrationId] = { jwt, provider };
          await deps.saveEntries(entries);
          await deps.ensureAlarm();
          sendResponse({ success: true });
        })().catch(() => sendResponse({ success: false }));
        return true;
      }

      case 'REMOVE_REFRESH_TOKEN': {
        const { integrationId } = msg;
        if (!isString(integrationId) || !INTEGRATION_ID.test(integrationId)) {
          sendResponse({ success: false, error: 'Invalid integration id' });
          return false;
        }
        (async () => {
          const entries = await deps.loadEntries();
          delete entries[integrationId];
          await deps.saveEntries(entries);
          await deps.clearAlarmIfEmpty();
          sendResponse({ success: true });
        })().catch(() => sendResponse({ success: false }));
        return true;
      }

      default: {
        sendResponse({ error: 'Unknown message type' });
        return false;
      }
    }
  };
}

/**
 * Whether Hookpost's reply means this channel's entry is finished with: the
 * token is refused (401 "Invalid token"), the channel is gone (404
 * "Integration not found"), or the browser is now signed in to a different
 * Skool account than the channel's (account_mismatch; Hookpost asks the user
 * to reconnect). The endpoint's own messages are required, so a 401 or 404
 * from anything else (a misrouted /api, a renamed route) drops nothing.
 * Anything else, including a 400 from a Skool hiccup or a 5xx, is kept.
 */
async function isFinished(response: Response): Promise<boolean> {
  const body = await response.json().catch(() => null);
  if (response.status === 401) return body?.message === 'Invalid token';
  if (response.status === 404) return body?.message === 'Integration not found';
  if (!response.ok) return false;
  return body?.success === false && body?.reason === 'account_mismatch';
}

/**
 * The daily refresh: re-reads each connected provider's cookies and posts them
 * to the Hookpost backend with that channel's refresh token. Always to
 * deps.backendUrl, including for an entry stored by an older build that still
 * carries a backendUrl of its own. Entries Hookpost no longer accepts are
 * dropped, so the extension stops sending them.
 */
export function createRefresher(deps: ExtensionDeps) {
  return async (): Promise<void> => {
    const entries = await deps.loadEntries();
    const finished: string[] = [];
    for (const [integrationId, entry] of Object.entries(entries)) {
      try {
        const provider = deps.getProvider(entry.provider);
        if (!provider) continue;

        const cookieResult = await deps.extractCookies(provider);
        if (!cookieResult.success) continue;

        const base64Cookies = btoa(JSON.stringify(cookieResult.cookies));

        const response = await deps.fetch(
          `${deps.backendUrl}/integrations/extension-refresh`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jwt: entry.jwt, cookies: base64Cookies }),
          }
        );
        if (await isFinished(response)) finished.push(integrationId);
      } catch {
        // Skipped; the next daily run tries again.
      }
    }
    if (finished.length > 0) {
      // Re-read: a STORE_REFRESH_TOKEN may have landed during the run.
      const current = await deps.loadEntries();
      for (const id of finished) {
        if (current[id]?.jwt === entries[id].jwt) delete current[id];
      }
      await deps.saveEntries(current);
      await deps.clearAlarmIfEmpty();
    }
  };
}

export interface PopupStatus {
  version: string;
  hookpostReachable: boolean;
  /** Both required Skool cookies are in this browser. Never their values. */
  skoolSignedIn: boolean;
  /** Channels whose refresh token this browser holds (connected here). */
  connectedChannels: number;
  addChannelUrl: string;
}

async function isReachable(deps: ExtensionDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${deps.backendUrl}/health`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * chrome.runtime.onMessage listener for the toolbar popup (popup.html). It
 * answers only this extension's own popup page, and only POPUP_STATUS, with
 * yes/no facts: the popup never sees a cookie value.
 */
export function createPopupMessageHandler(deps: ExtensionDeps) {
  return (message: unknown, sender: Sender, sendResponse: Reply): boolean => {
    const popupUrl = `chrome-extension://${deps.extensionId}/popup.html`;
    if (sender.id !== deps.extensionId || !sender.url?.startsWith(popupUrl)) {
      return false;
    }
    if ((message as { type?: unknown } | null)?.type !== 'POPUP_STATUS') {
      return false;
    }
    (async (): Promise<PopupStatus> => {
      const skool = deps.getProvider('skool');
      const [hookpostReachable, cookies, entries] = await Promise.all([
        isReachable(deps),
        skool ? deps.extractCookies(skool).catch(() => undefined) : undefined,
        deps.loadEntries().catch(() => ({})),
      ]);
      return {
        version: deps.version,
        hookpostReachable,
        skoolSignedIn: !!cookies?.success,
        connectedChannels: Object.keys(entries).length,
        addChannelUrl: `${deps.appUrl}/launches?add_channel=1`,
      };
    })()
      .then(sendResponse)
      .catch(() => sendResponse(undefined));
    return true;
  };
}
