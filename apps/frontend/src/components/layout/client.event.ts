/**
 * Tells the backend about a failure the person saw on this page, as one
 * "[client]" log line (POST /public/client-event, see
 * libraries/nestjs-libraries/src/track/client.event.ts). Production has no
 * Sentry or PostHog, so without this an endless spinner, an error page or a
 * connect that never came back left no trace anywhere.
 *
 * Never personal data: the event name, the path without its query string, a
 * provider id, a short reason. Never throws and never waits: a beacon must not
 * be able to break the page it reports on. Loaded on every page through
 * global-error.tsx, so it imports nothing.
 */
export type ClientEvent =
  | 'connect_abandoned'
  | 'connect_page_error'
  | 'signup_error'
  | 'spinner_stuck'
  | 'page_error';

export interface ClientEventFields {
  provider?: string;
  reason?: string;
  ms?: number;
}

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || '/api';

// One report per event, path and provider per page load: several spinners
// stuck on the same page are one problem.
const sent = new Set<string>();

export const reportClientEvent = (
  event: ClientEvent,
  fields: ClientEventFields = {}
): void => {
  try {
    if (typeof window === 'undefined') {
      return;
    }
    const path = window.location.pathname;
    const key = `${event}|${path}|${fields.provider || ''}`;
    if (sent.has(key)) {
      return;
    }
    sent.add(key);
    const body = JSON.stringify({
      event,
      path,
      ...(fields.provider ? { provider: fields.provider } : {}),
      ...(fields.reason ? { reason: String(fields.reason).slice(0, 200) } : {}),
      ...(typeof fields.ms === 'number' ? { ms: fields.ms } : {}),
    });
    window
      .fetch(`${BACKEND}/public/client-event`, {
        method: 'POST',
        // Survives the page being left right after (an OAuth redirect).
        keepalive: true,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      .catch(() => undefined);
  } catch {
    // never let reporting fail the page
  }
};

/** For tests: forget what this page load already reported. */
export const resetClientEventsForTest = () => sent.clear();

/** How long a spinner may stay before it is reported. */
export const SPINNER_STUCK_MS = 15_000;
