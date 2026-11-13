/**
 * Parses a `data:` URL into a Buffer and its mime type.
 *
 * gpt-image models only return base64 image data (never a URL), so the image
 * generation flow hands `uploadSimple` a data URL instead of a remote URL.
 *
 * Returns null when the value is not a valid data URL.
 */
export function parseDataUrl(
  value: string
): { buffer: Buffer; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(value);
  if (!match) {
    return null;
  }

  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const data = match[3];

  const buffer = isBase64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf-8');

  return { buffer, mime };
}

/**
 * A data URL for a generated picture given as base64. Gemini image models
 * return JPEG and OpenAI's gpt-image models PNG, so the mime type comes from
 * the bytes' signature rather than being assumed.
 */
export function base64ImageDataUrl(
  value: string | null | undefined
): string {
  const base64 = value || '';
  const mime = base64.startsWith('/9j/')
    ? 'image/jpeg'
    : base64.startsWith('UklGR')
    ? 'image/webp'
    : 'image/png';
  return `data:${mime};base64,${base64}`;
}
