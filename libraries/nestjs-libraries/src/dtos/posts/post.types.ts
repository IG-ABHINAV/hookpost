/**
 * Every type a post can be saved with (CreatePostDto.type). The public API
 * and PostsService.createPost refuse anything else: the repository saves any
 * type but 'draft' as QUEUE, so an unknown one used to publish (review of
 * f4bee956b, 25 Oct 2026).
 */
export const POST_TYPES = ['draft', 'schedule', 'now', 'update'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const isPostType = (value: unknown): value is PostType =>
  typeof value === 'string' && (POST_TYPES as readonly string[]).includes(value);
