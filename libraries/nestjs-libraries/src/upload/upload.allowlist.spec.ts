/**
 * What may be stored as an upload (upload.allowlist.ts). file-type is
 * ESM-only and cannot load in this jest config, so it is replaced by a
 * magic-number check of the same shape; the integration suite
 * (tests/integration/upload-hardening.int.spec.ts) runs the real one.
 *   pnpm exec jest -c apps/backend/jest.config.ts upload.allowlist
 */
import { randomBytes } from 'crypto';

const mockDetect = jest.fn(async (buffer: Buffer) => {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    return { ext: 'mp4', mime: 'video/mp4' };
  }
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return undefined;
});
jest.mock('file-type', () => ({
  fileTypeFromBuffer: (buffer: Buffer) => mockDetect(buffer),
}));

import {
  isGeneratedPdf,
  markupInHeader,
  MEDIA_UPLOAD_MIME,
  opensLikeMarkup,
  SNIFF_WINDOW_BYTES,
  sniffUpload,
  STORAGE_UPLOAD_MIME,
} from '@hookpost/nestjs-libraries/upload/upload.allowlist';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const jpeg = (...parts: Array<Buffer | string>) =>
  Buffer.concat([
    JPEG_MAGIC,
    ...parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)),
    randomBytes(256),
  ]);
const mp4 = (sizeBytes: Buffer) =>
  Buffer.concat([sizeBytes, Buffer.from('ftypisom', 'latin1'), randomBytes(256)]);

describe('sniffUpload', () => {
  beforeEach(() => mockDetect.mockClear());

  it('a real image is stored under the extension of its type', async () => {
    expect(await sniffUpload(jpeg('JFIF\0'))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(await sniffUpload(mp4(Buffer.from([0, 0, 0, 0x20])))).toEqual({
      mime: 'video/mp4',
      ext: 'mp4',
    });
  });

  it('a variant name file-type gives (f4v, m4p) is stored as .mp4', async () => {
    mockDetect.mockResolvedValueOnce({ ext: 'f4v', mime: 'video/mp4' });
    expect(await sniffUpload(mp4(Buffer.from([0, 0, 0, 0x20])))).toEqual({
      mime: 'video/mp4',
      ext: 'mp4',
    });
  });

  it.each([
    ['an HTML page', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['an SVG with a script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['JavaScript', Buffer.from('alert(document.cookie)')],
    ['a PDF', Buffer.from('%PDF-1.7\n')],
    ['nothing', Buffer.alloc(0)],
  ])('%s is refused', async (_what, bytes) => {
    expect(await sniffUpload(bytes)).toBeNull();
  });

  it('audio is storage-only: not for the media library', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), randomBytes(64)]);
    expect(await sniffUpload(mp3, MEDIA_UPLOAD_MIME)).toBeNull();
    expect(await sniffUpload(mp3, STORAGE_UPLOAD_MIME)).toEqual({
      mime: 'audio/mpeg',
      ext: 'mp3',
    });
  });

  it.each([
    ['an HTML page in a JPEG comment', jpeg('\xff\xfe\x00\x40', '<html><body><script>alert(1)</script>')],
    ['a script tag in the metadata', jpeg('Exif\0\0', '<script src=//evil.example/x.js></script>')],
    ['an SVG', jpeg('<svg onload=alert(1)>')],
    ['an iframe', jpeg('<iframe src=javascript:alert(1)>')],
    ['a javascript: URL', jpeg('JAVASCRIPT:alert(1)')],
    ['an XML stylesheet', jpeg('<?xml-stylesheet href="x.xsl"?>')],
  ])('a polyglot is refused: %s', async (_what, bytes) => {
    expect(await sniffUpload(bytes)).toBeNull();
  });

  it('an MP4 whose first box size spells "<p >" opens like HTML and is refused', async () => {
    const polyglot = mp4(Buffer.from('<p >', 'latin1'));
    // file-type still calls it an MP4 (its magic is at offset 4)...
    expect(await mockDetect(polyglot)).toEqual({ ext: 'mp4', mime: 'video/mp4' });
    // ...a browser told nothing about its type would see "<p " and render HTML.
    expect(opensLikeMarkup(polyglot)).toBe(true);
    expect(await sniffUpload(polyglot)).toBeNull();
    expect(await sniffUpload(mp4(Buffer.from(' \n<a', 'latin1')))).toBeNull();
  });

  it('XMP metadata, which real photos carry, is not markup', async () => {
    const xmp =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ' +
      'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:Headline="My <b>day</b> out"/>' +
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    expect(await sniffUpload(jpeg('Exif\0\0', 'http://ns.adobe.com/xap/1.0/\0', xmp))).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('markup past the sniff window is left (nothing reads it as a page there)', async () => {
    const deep = jpeg(randomBytes(SNIFF_WINDOW_BYTES), '<html><script>alert(1)</script>');
    expect(markupInHeader(deep)).toBe(false);
    expect(await sniffUpload(deep)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('random image data does not look like markup by chance', () => {
    for (let i = 0; i < 2000; i++) {
      const bytes = Buffer.concat([JPEG_MAGIC, randomBytes(SNIFF_WINDOW_BYTES)]);
      expect(opensLikeMarkup(bytes) || markupInHeader(bytes)).toBe(false);
    }
  });
});

// uploadGeneratedPdf (api.market's carousels): the backend's own PDF, never a
// user's file.
describe('isGeneratedPdf', () => {
  it('a PDF is a PDF', async () => {
    expect(await isGeneratedPdf(Buffer.from('%PDF-1.7\n%\xe2\xe3\n1 0 obj'))).toBe(true);
  });
  it('anything else is not, and an empty or missing buffer is not', async () => {
    expect(await isGeneratedPdf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(await isGeneratedPdf(Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
    expect(await isGeneratedPdf(Buffer.alloc(0))).toBe(false);
    expect(await isGeneratedPdf(undefined as unknown as Buffer)).toBe(false);
  });
  it('a user upload of the same PDF is still refused', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj');
    expect(await sniffUpload(pdf, STORAGE_UPLOAD_MIME)).toBeNull();
  });
});
