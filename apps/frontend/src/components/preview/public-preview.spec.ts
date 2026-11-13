/**
 * The public post page (/p/:id) a share link opens: the channel line, the
 * date label, what a pasted link unfurls as, and no internal API/WEB badge.
 *   pnpm exec jest -c apps/frontend/jest.config.ts public-preview
 */
import { render, screen } from '@testing-library/react';

const mockPosts: { current: any[] } = { current: [] };
jest.mock('@hookpost/helpers/utils/internal.fetch', () => ({
  internalFetch: async () => ({ json: async () => mockPosts.current }),
}));
jest.mock('@hookpost/react/translation/get.translation.service.backend', () => ({
  getT: async () => (_key: string, fallback: string) => fallback,
}));
// isomorphic-dompurify's jsdom is ESM
jest.mock('@hookpost/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (html: string) => html,
}));
jest.mock('@hookpost/frontend/components/preview/comments.components', () => ({
  CommentsComponents: () => null,
}));
jest.mock('@hookpost/frontend/components/preview/copy.client', () => ({
  CopyClient: () => null,
}));
jest.mock('@hookpost/frontend/components/preview/render.preview.date.client', () => ({
  RenderPreviewDateClient: ({ date }: { date: string }) => date,
}));
jest.mock('@hookpost/react/helpers/video.or.image', () => ({
  VideoOrImage: () => null,
}));
jest.mock('@hookpost/react/helpers/safe.image', () => ({
  __esModule: true,
  default: () => null,
}));

import Page, { metadata } from '@hookpost/frontend/app/(app)/(preview)/p/[id]/page';
import {
  previewDateLabel,
  previewHandle,
} from '@hookpost/frontend/components/preview/preview.header';

const post = (state: string, profile: string, creationMethod = 'API') => ({
  id: 'post-1',
  content: 'hello',
  image: '[]',
  publishDate: '2026-10-11T18:14:00.000Z',
  state,
  creationMethod,
  integration: {
    id: 'int-1',
    name: 'Example Page',
    picture: 'https://media.hookstep.in/p.png',
    providerIdentifier: 'facebook',
    profile,
  },
});

const renderPage = async () =>
  render(
    await Page({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({}),
    })
  );

describe('previewHandle', () => {
  it('shows no handle when the channel has none, and one @ for YouTube', () => {
    expect(previewHandle('')).toBe('');
    expect(previewHandle(null)).toBe('');
    expect(previewHandle(undefined)).toBe('');
    expect(previewHandle('@vikasgoel-m8i')).toBe('vikasgoel-m8i');
    expect(previewHandle('mypage')).toBe('mypage');
  });
});

describe('previewDateLabel', () => {
  const t = (_key: string, fallback: string) => fallback;
  it('only calls a published post published', () => {
    expect(previewDateLabel('PUBLISHED', t)).toBe('Published:');
    expect(previewDateLabel('QUEUE', t)).toBe('Scheduled for:');
    expect(previewDateLabel('ERROR', t)).toBe(
      'Publishing failed. It was scheduled for:'
    );
    expect(previewDateLabel('DRAFT', t)).toBe('Draft, planned for:');
    expect(previewDateLabel(undefined, t)).toBe('Publication Date:');
  });

  it('says a "Remind me to post" post is posted by hand, never "Published:"', () => {
    expect(previewDateLabel('REMINDER_SENT', t)).toBe(
      'Reminder sent, to post by hand:'
    );
    expect(previewDateLabel('POSTED_MANUALLY', t)).toBe('Posted from the app:');
  });
});

describe('public post page', () => {
  it('brands the title once and unfurls as a post preview, not the homepage', () => {
    expect(metadata.title).toEqual({ absolute: 'Post preview | Hookpost' });
    expect(metadata.openGraph).toMatchObject({
      title: 'Post preview | Hookpost',
      siteName: 'Hookpost',
    });
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('shows no lone @ for a Facebook page and no API badge', async () => {
    mockPosts.current = [post('ERROR', '')];
    const { container } = await renderPage();
    expect(screen.getByText('Example Page')).toBeTruthy();
    expect(container.textContent).not.toContain('@');
    expect(container.textContent).not.toContain('API');
    expect(container.textContent).not.toContain('Publication Date');
    expect(container.textContent).toContain(
      'Publishing failed. It was scheduled for:'
    );
  });

  it('shows a YouTube handle with one @', async () => {
    mockPosts.current = [post('PUBLISHED', '@vikasgoel-m8i', 'WEB')];
    const { container } = await renderPage();
    expect(screen.getByText('@vikasgoel-m8i')).toBeTruthy();
    expect(container.textContent).not.toContain('@@');
    expect(container.textContent).not.toContain('WEB');
    expect(container.textContent).toContain('Published:');
  });
});
