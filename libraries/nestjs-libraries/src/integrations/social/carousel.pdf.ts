import sharp from 'sharp';
import imageToPDF from 'image-to-pdf';
import { Readable } from 'stream';

/** Page sizes the marketplace's LinkedIn carousel render offers (LinkedIn's own). */
export const CAROUSEL_PAGE_SIZES = {
  square: [1080, 1080],
  portrait: [1080, 1350],
} as const satisfies Record<string, readonly [number, number]>;

export type CarouselPageSize = keyof typeof CAROUSEL_PAGE_SIZES;

export interface RenderedCarousel {
  pdf: Buffer;
  pages: number;
  width: number;
  height: number;
}

const streamToBuffer = (stream: Readable): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

/**
 * Images as a LinkedIn document carousel: one PDF page per image, in order.
 *
 * Without `page` (what LinkedIn publishing has always done) each page is the
 * size of the largest image, and smaller images are fitted and centred on
 * it. With `page` every image is fitted onto that exact size on white, the
 * way the marketplace's POST /carousels/render returns it.
 */
export async function renderCarouselPdf(
  images: Buffer[],
  page?: readonly [number, number]
): Promise<RenderedCarousel> {
  const converted = await Promise.all(
    images.map(async (raw) => {
      if (page) {
        const buffer = await sharp(raw, { animated: false })
          .rotate()
          .resize(page[0], page[1], {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg()
          .toBuffer();
        return { buffer, width: page[0], height: page[1] };
      }
      const image = sharp(raw, { animated: false }).toFormat('jpeg');
      const { width, height } = await image.metadata();
      const buffer = await image.toBuffer();
      return { buffer, width: width || 0, height: height || 0 };
    })
  );

  const largest = converted.reduce((max, img) =>
    img.width * img.height > max.width * max.height ? img : max
  );
  const size: [number, number] = page
    ? [page[0], page[1]]
    : [largest.width, largest.height];

  const stream = imageToPDF(
    converted.map((c) => c.buffer),
    size
  ) as unknown as Readable;
  const pdf = await streamToBuffer(stream);
  return { pdf, pages: converted.length, width: size[0], height: size[1] };
}

/** Pages in a PDF this module wrote (one /Type /Page object per page). */
export function countPdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}
