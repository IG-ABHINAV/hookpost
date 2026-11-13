// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

/**
 * What may be stored as an upload, decided from the bytes alone. The file
 * name, its extension and the type the client declared are never trusted: the
 * stored name gets the extension of the type the bytes really are.
 *
 * Every storage write of a file from outside goes through sniffUpload
 * (LocalStorage, the R2 storage and uploader, and the upload pipe), so the
 * list lives here once. The one other write is a PDF the backend renders
 * itself (api.market's carousels, uploadGeneratedPdf), checked by
 * isGeneratedPdf. The serving side (nginx.hookpost.conf,
 * var/docker/nginx.conf*, the Next.js /api/uploads route) hands out anything
 * that is not an image or a video as a download; see upload.serve.ts.
 *
 * Text formats are never accepted from a user: no HTML, SVG, XML, JS or
 * PDF, because anything a browser can run, served from hookpost.hookstep.in,
 * is stored XSS against every signed-in user (and could ask the Chrome
 * extension for a user's Skool cookies). file-type cannot even name HTML or
 * SVG, so they fall out as "unknown" before the list is consulted.
 */

/** What the media library, the public API and the composer accept. */
export const MEDIA_UPLOAD_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
]);

/**
 * What the storage providers accept from the backend itself: the media types
 * plus the audio that video generation and the AI tools fetch.
 */
export const STORAGE_UPLOAD_MIME: ReadonlySet<string> = new Set([
  ...MEDIA_UPLOAD_MIME,
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

/**
 * How much of a file a browser reads to guess its type (the WHATWG MIME
 * Sniffing "resource header"). Markup here is what a type-guessing client
 * would find.
 */
export const SNIFF_WINDOW_BYTES = 1445;

// Bytes a sniffer skips before looking for "<" (WHATWG whitespace bytes).
const LEADING_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * True when the file opens like a markup document: its first byte after any
 * whitespace is "<". Every HTML and XML signature a browser sniffs for starts
 * that way, and no image, video or audio format does (they open with their
 * magic number, or an MP4 box size in the low bytes). A file can still pass
 * file-type with "<" first, because MP4's magic sits at offset 4: four bytes
 * "<p >" followed by "ftypisom" is an MP4 to file-type and an HTML page to a
 * browser that is told nothing about its type.
 */
export const opensLikeMarkup = (buffer: Buffer): boolean => {
  let i = 0;
  while (i < buffer.length && LEADING_WHITESPACE.has(buffer[i])) i++;
  return buffer[i] === 0x3c;
};

/**
 * Tags and script URLs inside the sniff window: an image with an HTML page in
 * a comment or metadata segment (the JPEG/HTML polyglot). Only long tokens,
 * each followed by a tag-ending byte, so the binary data of a real image does
 * not match by chance (well under one in a million files). XMP metadata
 * (`<x:xmpmeta`, `<rdf:RDF`) does not match.
 */
const MARKUP_IN_HEADER =
  /<(?:!doctype|html|head|body|script|iframe|object|embed|svg|style|title|form|base)[\s/>]|javascript:|<\?xml-stylesheet/i;

export const markupInHeader = (buffer: Buffer): boolean =>
  MARKUP_IN_HEADER.test(
    buffer.subarray(0, SNIFF_WINDOW_BYTES).toString('latin1')
  );

/**
 * One extension per type. file-type names some files by their variant
 * (an MP4 can come back as "f4v" or "m4p", MP3 as "mp2", Ogg as "oga"), and
 * the stored name is served by its extension, so every file of a type gets
 * the same one, the one the servers know (upload.serve.ts).
 */
export const UPLOAD_EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};

export interface SniffedUpload {
  mime: string;
  /** The extension the stored file gets, from the detected type. */
  ext: string;
}

/**
 * The real type of an upload, or null when it may not be stored: unknown to
 * file-type, not on `allowed`, or carrying markup where a browser would look
 * for it.
 */
export async function sniffUpload(
  buffer: Buffer | undefined | null,
  allowed: ReadonlySet<string> = MEDIA_UPLOAD_MIME
): Promise<SniffedUpload | null> {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }
  const detected = await fileTypeFromBuffer(buffer);
  const ext = detected && UPLOAD_EXTENSION[detected.mime];
  if (!detected || !ext || !allowed.has(detected.mime)) {
    return null;
  }
  if (opensLikeMarkup(buffer) || markupInHeader(buffer)) {
    return null;
  }
  return { mime: detected.mime, ext };
}

/**
 * For uploadGeneratedPdf only: true when the bytes the backend rendered
 * really are a PDF. Never for a user's file, which sniffUpload refuses as a
 * PDF; on the app origin a stored PDF is served as a download (upload.serve.ts).
 */
export async function isGeneratedPdf(buffer: Buffer): Promise<boolean> {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }
  const detected = await fileTypeFromBuffer(buffer);
  return detected?.mime === 'application/pdf';
}
