/**
 * Why a post failed, in words a user can act on.
 *
 * Post.error holds whatever serializeError made of the failure: usually the
 * Temporal failure as JSON ({"cause":{"failure":{"message", "stackTrace",
 * ...}}}), often cut off at 4000 characters so it no longer parses, and now
 * and then a bare internal marker such as "No Post". Only the message is meant
 * for people; the stack trace names server paths and is never returned.
 */

const MAX_LENGTH = 300;

// Internal markers that tell a user nothing; the generic copy reads better.
const MEANINGLESS = new Set([
  'no post',
  'already posted',
  'unknown error',
  '[empty error object]',
  '(no message)',
]);

const messageFromJson = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw);
    const message =
      parsed?.cause?.failure?.message ??
      parsed?.failure?.message ??
      parsed?.message ??
      parsed?.error?.message ??
      parsed?.error;
    return typeof message === 'string' ? message : '';
  } catch {
    // Cut off part-way. The first "message" key is the failure's own; one
    // inside a nested JSON string is escaped (\"message\") and is skipped.
    const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!match) {
      return '';
    }
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
};

export const readablePostError = (raw?: string | null): string | null => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  const message = /^[{[]/.test(trimmed) ? messageFromJson(trimmed) : trimmed;
  // First line only: serializeError appends stack frames after a newline.
  const line = (message.split('\n')[0] || '')
    .replace(/^(\w*Error|ApplicationFailure):\s+/, '')
    .trim();
  if (!line || MEANINGLESS.has(line.toLowerCase())) {
    return null;
  }
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
};
