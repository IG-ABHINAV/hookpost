import { GetCookiesResponse, StoredRefreshEntry } from './types/messages';
import { getAllProviders, getProvider } from './providers/provider.registry';
import { CookieProvider } from './providers/cookie-provider.interface';
import { DEV_POLICY, PRODUCTION_BACKEND_URL, PRODUCTION_ORIGIN, PRODUCTION_POLICY } from './config';
import {
  createExternalMessageHandler,
  createPopupMessageHandler,
  createRefresher,
  ExtensionDeps,
} from './handler';

// Replaced at build time by vite.config.ts: false and '' in the store build,
// so the dev branch below is dropped from it.
declare const __HOOKPOST_DEV__: boolean;
declare const __HOOKPOST_DEV_BACKEND_URL__: string;
declare const __HOOKPOST_DEV_APP_URL__: string;
declare const __HOOKPOST_VERSION__: string;

const REFRESH_ALARM_NAME = 'cookie-refresh';
const STORAGE_KEY = 'refreshEntries';

// Reads each named cookie on its own (chrome.cookies.get), so the extension
// never sees any other Skool cookie, not even in memory.
async function extractCookies(provider: CookieProvider): Promise<GetCookiesResponse> {
  const extracted: Record<string, string> = {};
  const missingRequired: string[] = [];

  for (const def of provider.cookies) {
    const found = await chrome.cookies.get({ url: provider.url, name: def.name });
    if (found) {
      extracted[def.name] = found.value;
    } else if (def.required) {
      missingRequired.push(def.name);
    }
  }

  if (missingRequired.length > 0) {
    return {
      success: false,
      provider: provider.identifier,
      error: `Missing required cookies: ${missingRequired.join(', ')}. User may need to log in to ${provider.name}.`,
      missingCookies: missingRequired,
    };
  }

  return {
    success: true,
    provider: provider.identifier,
    cookies: extracted,
  };
}

async function loadEntries(): Promise<Record<string, StoredRefreshEntry>> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Record<string, StoredRefreshEntry>) || {};
}

async function saveEntries(entries: Record<string, StoredRefreshEntry>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(REFRESH_ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: 1440 });
  }
}

async function clearAlarmIfEmpty(): Promise<void> {
  const entries = await loadEntries();
  if (Object.keys(entries).length === 0) {
    await chrome.alarms.clear(REFRESH_ALARM_NAME);
  }
}

const deps: ExtensionDeps = {
  ...(__HOOKPOST_DEV__
    ? {
        policy: DEV_POLICY,
        backendUrl: __HOOKPOST_DEV_BACKEND_URL__,
        appUrl: __HOOKPOST_DEV_APP_URL__,
      }
    : { policy: PRODUCTION_POLICY, backendUrl: PRODUCTION_BACKEND_URL, appUrl: PRODUCTION_ORIGIN }),
  extensionId: chrome.runtime.id,
  version: __HOOKPOST_VERSION__,
  getProvider,
  getAllProviders,
  extractCookies,
  loadEntries,
  saveEntries,
  ensureAlarm,
  clearAlarmIfEmpty,
  // Looked up on each call, not bound once.
  fetch: (input, init) => fetch(input, init),
};

const refreshAllCookies = createRefresher(deps);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM_NAME) {
    refreshAllCookies();
  }
});

(async () => {
  const entries = await loadEntries();
  if (Object.keys(entries).length > 0) {
    await ensureAlarm();
  }
})();

chrome.runtime.onMessageExternal.addListener(createExternalMessageHandler(deps));
// The toolbar popup (popup.html).
chrome.runtime.onMessage.addListener(createPopupMessageHandler(deps));
