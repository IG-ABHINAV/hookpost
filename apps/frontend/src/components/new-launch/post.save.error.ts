import type { Dayjs } from 'dayjs';
import {
  isEmailNotVerifiedRefusal,
  verificationRefusalLine,
} from '@hookpost/frontend/components/layout/email.verification';

/**
 * What the composer says when POST /posts refuses a save, instead of
 * "Added successfully". The backend answers with a PostValidationException
 * ({ name, message }), a ValidationPipe 400 ({ message: string[] }) or a plain
 * HttpException ({ message }). A 402's message is already in the plan dialog,
 * so it gets the short plan-limit line; a 5xx message is not meant for people,
 * so it gets the fallback.
 */
export const postSaveError = async (
  response: Response | undefined,
  fallback: string,
  limitReached: string = fallback
): Promise<string> => {
  if (!response || response.status >= 500) {
    return fallback;
  }

  if (response.status === 402) {
    return limitReached;
  }

  const body = await response.json().catch(() => ({} as any));

  // The email is not confirmed yet: the dialog (layout.context.tsx) has
  // already explained and offered the link again; one short line here.
  if (isEmailNotVerifiedRefusal(response.status, body)) {
    return verificationRefusalLine();
  }

  const message = Array.isArray(body?.message)
    ? body.message[0]
    : body?.message;

  if (!message || typeof message !== 'string') {
    return fallback;
  }

  return body?.name ? `${body.name}: ${message}` : message;
};

/**
 * Sends the composer's POST /posts. On a refusal it shows why through
 * `onError` and returns false, so the caller keeps the composer open and
 * shows no success toast.
 */
export const submitPost = async (
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  data: unknown,
  messages: { fallback: string; limitReached: string },
  onError: (message: string) => void
): Promise<Response | false> => {
  const response = await fetch('/posts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response?.ok) {
    onError(
      await postSaveError(response, messages.fallback, messages.limitReached)
    );
    return false;
  }
  return response;
};

/**
 * "Add to calendar" with a time that has already gone (today at an earlier
 * hour, or a failed or draft post reopened after its date) would publish the
 * moment it is saved. Only a plain schedule asks: "Post now" means now, and an
 * update or a draft does not publish.
 */
export const isPastScheduleTime = (type: string, date: Dayjs, now: Dayjs) =>
  type === 'schedule' && date.isBefore(now);
