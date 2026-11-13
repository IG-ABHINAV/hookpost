import { stat } from 'fs/promises';
import { resolve, sep } from 'path';

/**
 * Said when a post would be published with one of our files that is gone.
 * Videos are purged from storage a week after publishing
 * (scripts/cleanup-expired-media.js), and a failed post retried after that
 * went to the platform with a dead link and failed again.
 */
export const MEDIA_REMOVED_MESSAGE =
  "This post's video/image was removed from storage. Upload it again before retrying.";

// A post carries a handful of files; anything past this is not checked
const MAX_CHECKED = 50;
const HEAD_TIMEOUT_MS = 3000;

type Env = Record<string, string | undefined>;

const withoutTrailingSlash = (url?: string) => (url || '').replace(/\/+$/, '');

/**
 * Where one of our own uploads lives: a file under UPLOAD_DIRECTORY for the
 * app's /uploads URLs, or the URL itself for the storage bucket (and for
 * /uploads when there is no local directory to look in). Null for anything
 * else: a link to another site is never checked, so it is never refused.
 */
export const ownUploadLocation = (
  path: unknown,
  env: Env = process.env
): { disk: string } | { url: string } | null => {
  if (typeof path !== 'string' || !path || path.length > 2048) {
    return null;
  }

  const bucket = withoutTrailingSlash(env.CLOUDFLARE_BUCKET_URL);
  if (bucket && path.startsWith(`${bucket}/`)) {
    return { url: path };
  }

  const uploads = `${withoutTrailingSlash(env.FRONTEND_URL)}/uploads/`;
  if (env.FRONTEND_URL && path.startsWith(uploads)) {
    if (!env.UPLOAD_DIRECTORY) {
      return { url: path };
    }
    try {
      const relative = decodeURIComponent(
        path.slice(uploads.length).split(/[?#]/)[0]
      );
      const root = resolve(env.UPLOAD_DIRECTORY);
      const full = resolve(root, relative);
      return full.startsWith(root + sep) ? { disk: full } : null;
    } catch {
      return null;
    }
  }

  return null;
};

/**
 * True only when we know the file is gone: missing from the upload directory,
 * or a 404/410 from the bucket. A timeout, a network error or any other answer
 * is not proof, and a save is never refused on a guess.
 */
export const isOwnUploadMissing = async (
  path: unknown,
  env: Env = process.env,
  fetcher: typeof fetch = fetch
): Promise<boolean> => {
  const where = ownUploadLocation(path, env);
  if (!where) {
    return false;
  }

  if ('disk' in where) {
    try {
      await stat(where.disk);
      return false;
    } catch (err: any) {
      return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
    }
  }

  try {
    const response = await fetcher(where.url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
};

/** The paths among these that are our own uploads and no longer exist. */
export const findMissingMedia = async (
  paths: unknown[],
  env: Env = process.env,
  fetcher: typeof fetch = fetch
): Promise<string[]> => {
  const unique = Array.from(
    new Set(paths.filter((p): p is string => typeof p === 'string' && !!p))
  ).slice(0, MAX_CHECKED);

  const missing = await Promise.all(
    unique.map((path) => isOwnUploadMissing(path, env, fetcher))
  );

  return unique.filter((_, index) => missing[index]);
};

/** Every media path a post payload carries, comments included. */
export const mediaPathsOf = (
  posts: Array<{ value?: Array<{ image?: Array<{ path?: string }> }> }> = []
): string[] =>
  (posts || []).flatMap((post) =>
    (post?.value || []).flatMap((value) =>
      (value?.image || []).map((image) => image?.path).filter(Boolean)
    )
  ) as string[];
