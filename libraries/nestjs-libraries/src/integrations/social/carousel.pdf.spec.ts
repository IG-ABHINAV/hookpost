/**
 * The carousel PDF (carousel.pdf.ts), shared by LinkedIn publishing and the
 * marketplace's POST /carousels/render: one page per image, in order.
 *   pnpm exec jest -c apps/backend/jest.config.ts carousel.pdf
 */
import sharp from 'sharp';
import {
  CAROUSEL_PAGE_SIZES,
  countPdfPages,
  renderCarouselPdf,
} from '@hookpost/nestjs-libraries/integrations/social/carousel.pdf';

const image = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

describe('renderCarouselPdf', () => {
  it('makes one page per image at the requested size', async () => {
    const images = await Promise.all([
      image(400, 300, '#ff0000'),
      image(300, 500, '#00ff00'),
      image(200, 200, '#0000ff'),
    ]);
    const portrait = await renderCarouselPdf(images, CAROUSEL_PAGE_SIZES.portrait);
    expect(portrait.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(portrait.pages).toBe(3);
    expect(countPdfPages(portrait.pdf)).toBe(3);
    expect([portrait.width, portrait.height]).toEqual([1080, 1350]);

    const square = await renderCarouselPdf(images.slice(0, 2), CAROUSEL_PAGE_SIZES.square);
    expect(countPdfPages(square.pdf)).toBe(2);
    expect([square.width, square.height]).toEqual([1080, 1080]);
  });

  it('without a size, sizes every page to the largest image (what LinkedIn publishing does)', async () => {
    const rendered = await renderCarouselPdf([await image(640, 480, '#123456'), await image(320, 240, '#654321')]);
    expect([rendered.width, rendered.height]).toEqual([640, 480]);
    expect(countPdfPages(rendered.pdf)).toBe(2);
  });
});
