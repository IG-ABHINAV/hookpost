import { HttpException } from '@nestjs/common';

// e.g. "400 Your request was rejected by the safety system, safety_violations=[sexual]"
const SAFETY_VIOLATIONS_REGEX = /safety_violations=\[([^\]]*)\]/i;

// Match genuine content-safety rejections by message, NOT by a bare 400 status:
// a 400 can just as easily be an invalid-parameter error, which must not be
// reported to the user as a safety violation.
const SAFETY_MESSAGE_REGEX =
  /safety system|safety_violations|content[ _]policy|rejected as a result of our safety|moderation/i;

/**
 * Normalizes errors thrown by AI generation providers (Gemini on Vertex,
 * OpenAI image/chat, Fal, Veo3, HeyGen, ElevenLabs, ...) into a clean
 * HttpException so a provider rejection (most notably an OpenAI safety
 * violation) returns a proper response instead of crashing the backend.
 *
 * When the provider reports a content-safety rejection, the flagged
 * category/categories are surfaced back to the user.
 */
export function generationError(err: any): HttpException {
  // Preserve errors we already raised intentionally (e.g. SubscriptionException).
  if (err instanceof HttpException) {
    return err;
  }

  const message: string =
    err?.error?.message || err?.message || String(err || '');

  if (SAFETY_MESSAGE_REGEX.test(message)) {
    const categories = message.match(SAFETY_VIOLATIONS_REGEX)?.[1]?.trim();
    const detail = categories ? ` Flagged categories: ${categories}.` : '';
    return new HttpException(
      `Your request was rejected by the AI safety system.${detail} Please adjust your prompt and try again.`,
      422
    );
  }

  // Out of quota or rate limited at the provider (OpenAI 429, Vertex 429
  // RESOURCE_EXHAUSTED): the request was fine, a retry later will work.
  // OpenAI's insufficient_quota (our own account out of money) is also a
  // 429, but retrying will not help: it falls through to the generic error.
  const ownQuota =
    err?.code === 'insufficient_quota' ||
    err?.error?.code === 'insufficient_quota' ||
    /insufficient_quota|exceeded your current quota/i.test(message);
  if (
    !ownQuota &&
    (err?.status === 429 || /RESOURCE_EXHAUSTED|rate limit/i.test(message))
  ) {
    console.error('AI generation rate limited:', message);
    return new HttpException(
      'The AI service is busy right now, please try again in a minute.',
      429
    );
  }

  // The provider did not answer within AI_TIMEOUT_MS (ai.provider.ts).
  if (
    err?.name === 'TimeoutError' ||
    err?.name === 'APIConnectionTimeoutError' ||
    /^Request timed out\.?$|DEADLINE_EXCEEDED/i.test(message)
  ) {
    console.error('AI generation timed out:', message);
    return new HttpException(
      'The AI took too long to answer, please try again.',
      504
    );
  }

  // Not a recognized safety rejection (e.g. an invalid-parameter 400) — return
  // a generic message rather than mislabeling it as a content-safety issue.
  // The real reason (a quota, a bad key, ...) is only useful to the operator, so log it
  console.error('AI generation failed:', message);
  return new HttpException(
    'AI generation failed, please try again later.',
    500
  );
}
