/**
 * Fires a Meta pixel event in the browser with the event id the backend used
 * for the same event in the Conversions API, so Meta counts the pair once.
 * Browser only, never through /public/t: that would send a second server
 * event under another id. Does nothing without the pixel (ad blockers, the
 * E2E build), and never throws.
 */
export function firePixelEvent(
  name: string,
  eventId?: string | null,
  data: Record<string, unknown> = {}
) {
  if (!eventId || typeof window === 'undefined') return;
  try {
    const fbq = (window as unknown as { fbq?: (...args: unknown[]) => void }).fbq;
    if (typeof fbq === 'function') {
      fbq('track', name, data, { eventID: eventId });
    }
  } catch {
    // An analytics call must never break sign-up.
  }
}
