/**
 * How a stored upload is served from the app's own origin
 * (FRONTEND_URL/uploads/...). Kept free of imports so the Next.js route
 * (apps/frontend/.../api/uploads) can use it, and mirrored by the /uploads/
 * location in nginx.hookpost.conf and var/docker/nginx.conf*, which
 * upload.serve.spec.ts holds to the same lists.
 *
 * Defence in depth on top of upload.allowlist.ts: even a file that should
 * never have been stored (or one written into the directory some other way)
 * cannot run as a page on this origin.
 *  - The Content-Type comes from this list by extension, never from the
 *    content; anything else is application/octet-stream.
 *  - nosniff: the browser keeps that type, so an image is never run as a
 *    script (<script src="/uploads/x.gif">) or read as HTML.
 *  - A sandbox CSP with nothing allowed: opened directly, the file is a
 *    document with a unique origin, no script and no plugins.
 *  - Anything that is not an image or a video is a download.
 */

/**
 * Extension (lower case) to the type it is served as: the extensions
 * upload.allowlist.ts gives stored files, plus "jpeg" and "tiff", which
 * older uploads may carry.
 */
export const UPLOAD_SERVE_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

/** Shown in the page (an <img> or a <video>, or opened in a tab). */
export const UPLOAD_INLINE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'mp4',
]);

export const UPLOAD_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; sandbox";

const extensionOf = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** The headers a stored upload is served with, from its file name alone. */
export const uploadServeHeaders = (fileName: string): Record<string, string> => {
  const ext = extensionOf(fileName);
  const headers: Record<string, string> = {
    'Content-Type': UPLOAD_SERVE_TYPES[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': UPLOAD_CSP,
  };
  if (!UPLOAD_INLINE_EXTENSIONS.has(ext)) {
    headers['Content-Disposition'] = 'attachment';
  }
  return headers;
};
