/**
 * One log line per step of a channel connect, so "started, never came back"
 * can be counted per provider:
 *
 *   connect_start   the OAuth link was created (GET /integrations/social/:p)
 *   connect_ok      the provider sent the user back and the channel was saved,
 *                   or a page was picked after a two-step login
 *   connect_failed  either step failed, with the reason
 *   connect_repeat  a connect that had already succeeded was sent again (Back
 *                   or a reload of the callback page) and answered with its
 *                   channel instead of an error
 *   channel_connected_pre_trial
 *                   a workspace that has to start its trial (needs_trial)
 *                   saved a channel, which it may do once before the trial
 *                   (PRE_TRIAL_CHANNEL_LIMIT): the step between sign-up and
 *                   StartTrial in the onboarding funnel. Logged next to
 *                   connect_ok, never instead of it.
 *
 * On 6-20 Oct, 7 of 19 real-user connects never came back from the provider
 * and nothing recorded why; a failure on our side was swallowed too.
 *
 *   [connect] connect_failed {"provider":"facebook","orgId":"...","reason":"..."}
 *
 * Grep for "[connect]". Never a token: only ids, names of steps, and a reason
 * that has been through redactSecrets.
 */
export type ConnectEvent =
  | 'connect_start'
  | 'connect_ok'
  | 'connect_failed'
  | 'connect_repeat'
  | 'channel_connected_pre_trial';

export interface ConnectLogDetails {
  provider?: string;
  orgId?: string | null;
  /** An Error, an HttpException, or a message. */
  reason?: unknown;
  [key: string]: unknown;
}

const MAX_REASON = 300;

// Provider error bodies echo back whatever was sent, which for an OAuth token
// exchange includes the app secret and, on later calls, the access token. Strip
// anything secret-shaped before it reaches the logs.
export function redactSecrets(text: string): string {
  return text
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted>')
    .replace(
      /((?:client_secret|access_token|refresh_token|app_secret|code|token)["']?\s*[:=]\s*["']?)[^"'&,}\s]+/gi,
      '$1<redacted>'
    )
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer <redacted>');
}

/** "409 Authentication failed", "Invalid state", or the string given. */
export const connectFailureReason = (reason: unknown): string => {
  if (reason === undefined || reason === null || reason === '') {
    return 'unknown';
  }
  if (typeof reason === 'string') {
    return reason;
  }
  const err = reason as { message?: unknown; getStatus?: () => number };
  const status =
    typeof err.getStatus === 'function' ? err.getStatus() : undefined;
  const message =
    typeof err.message === 'string' && err.message
      ? err.message
      : String(reason);
  return status ? `${status} ${message}` : message;
};

export const connectLogLine = (
  event: ConnectEvent,
  details: ConnectLogDetails
): string => {
  const { reason, ...rest } = details;
  const fields: Record<string, unknown> = { ...rest };
  if (event === 'connect_failed' || reason !== undefined) {
    fields.reason = redactSecrets(connectFailureReason(reason)).slice(
      0,
      MAX_REASON
    );
  }
  return `[connect] ${event} ${JSON.stringify(fields)}`;
};

export const logConnect = (
  event: ConnectEvent,
  details: ConnectLogDetails
): void => {
  const line = connectLogLine(event, details);
  if (event === 'connect_failed') {
    console.error(line);
  } else {
    console.log(line);
  }
};
