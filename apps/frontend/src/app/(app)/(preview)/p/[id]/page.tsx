import { internalFetch } from '@hookpost/helpers/utils/internal.fetch';
import { sanitizePostContent } from '@hookpost/helpers/utils/sanitize.post.content';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import SafeImage from '@hookpost/react/helpers/safe.image';
import Link from 'next/link';
import { CommentsComponents } from '@hookpost/frontend/components/preview/comments.components';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { VideoOrImage } from '@hookpost/react/helpers/video.or.image';
import { CopyClient } from '@hookpost/frontend/components/preview/copy.client';
import { getT } from '@hookpost/react/translation/get.translation.service.backend';
import { RenderPreviewDateClient } from '@hookpost/frontend/components/preview/render.preview.date.client';
import {
  previewDateLabel,
  previewHandle,
} from '@hookpost/frontend/components/preview/preview.header';

dayjs.extend(utc);
// Preview links are what agencies send clients (see /for/agencies), so the tab
// title must say Hookpost whatever IS_GENERAL is set to. They show posts that
// may not be published yet, so they are kept out of search results.
// The title is absolute because the (app) layout's '%s | Hookpost' template
// would brand it twice. openGraph and twitter are set here because a child
// replaces them whole: otherwise a pasted link unfurls as the homepage card
// and LinkedIn/Facebook follow its og:url to the homepage.
const previewTitle = 'Post preview | Hookpost';
const previewDescription = 'A post shared with you for review on Hookpost.';
export const metadata: Metadata = {
  title: { absolute: previewTitle },
  description: previewDescription,
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'Hookpost',
    title: previewTitle,
    description: previewDescription,
  },
  twitter: {
    card: 'summary',
    title: previewTitle,
    description: previewDescription,
  },
};
export default async function Auth(
  props: {
    params: Promise<{
      id: string;
    }>;
    searchParams?: Promise<{
      share?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;

  const {
    id
  } = params;

  const post = await (await internalFetch(`/public/posts/${id}`)).json();
  const t = await getT();
  if (!post.length) {
    return (
      <div className="text-white fixed start-0 top-0 w-full h-full flex justify-center items-center text-[20px]">
        {t('post_not_found', 'Post not found')}
      </div>
    );
  }
  const dateLabel = previewDateLabel(post[0].state, t);
  const handle = previewHandle(post[0].integration.profile);
  return (
    <div>
      <div className="mx-auto w-full max-w-[1346px] px-4 py-3 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className="min-w-[55px] shrink-0">
                <Link
                  href="/"
                  className="text-2xl flex items-center justify-center gap-[10px] text-textColor order-1"
                >
                  {/* This page is public - a client opens it from a share link -
                      so it must carry Hookpost branding. It previously pointed at
                      /hookpost.svg, which does not exist (the broken image showed
                      its "Logo" alt text), beside a hardcoded upstream Postiz
                      wordmark. logo-text.svg is the real brand asset: icon plus
                      the Hookpost name. */}
                  <SafeImage
                    src={'/logo-text.svg'}
                    width={150}
                    height={34}
                    alt="Hookpost"
                  />
                </Link>
              </div>
            </div>
          </div>
          <div className="text-sm text-gray-400 flex flex-wrap items-center gap-x-[20px] gap-y-3">
            {!!searchParams?.share && (
              <div>
                <CopyClient />
              </div>
            )}
            <div>
              {dateLabel}{' '}
              <span className="whitespace-nowrap">
                <RenderPreviewDateClient date={post[0].publishDate} />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row text-white w-full max-w-[1346px] mx-auto px-4">
        <div className="flex-1">
          <div className="gap-[20px] flex flex-col">
            {post.map((p: any) => (
              <div
                key={String(p.id)}
                className="relative px-4 py-4 bg-third border border-tableBorder"
              >
                <div className="flex space-x-3">
                  <div>
                    <div className="flex shrink-0 rounded-full h-30 w-30 relative">
                      <div className="w-[50px] h-[50px] z-[20]">
                        <img
                          className="w-full h-full relative z-[20] bg-black aspect-square rounded-full border-tableBorder"
                          alt={post[0].integration.name}
                          src={post[0].integration.picture}
                        />
                      </div>
                      <div className="absolute -end-[5px] -bottom-[5px] w-[30px] h-[30px] z-[20]">
                        <img
                          className="w-full h-full bg-black aspect-square rounded-full border-tableBorder"
                          alt={post[0].integration.providerIdentifier}
                          src={`/icons/platforms/${post[0].integration.providerIdentifier}.png`}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">
                        {post[0].integration.name}
                      </h2>
                      {!!handle && (
                        <span className="text-sm text-gray-500 [overflow-wrap:anywhere]">
                          @{handle}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-[20px]">
                      <div
                        className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
                        dangerouslySetInnerHTML={{
                          __html: sanitizePostContent(p.content),
                        }}
                      />
                      <div className="flex w-full gap-[10px]">
                        {JSON.parse(p?.image || '[]').map((p: any) => (
                          <div
                            key={p.name}
                            className="flex-1 rounded-[10px] max-h-[500px] overflow-hidden"
                          >
                            <VideoOrImage
                              isContain={true}
                              src={p.path}
                              autoplay={true}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="w-full lg:w-96 lg:flex-shrink-0">
          <div className="pt-4 lg:pt-0 lg:ps-4">
            <CommentsComponents postId={id} />
          </div>
        </div>
      </div>
    </div>
  );
}
