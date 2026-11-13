/**
 * Two-step providers the sweep never touches, because a finished channel can
 * have a placeholder's shape (internalId = rootInternalId, in between steps):
 *
 * - tumblr: the login id is the user's name (tumblr.provider.ts authenticate)
 *   and the primary blog's id is that same name, so a finished channel for
 *   that blog has internalId = rootInternalId. If its owner logs in again and
 *   leaves the page picker, createOrUpdateIntegration puts the row back in
 *   between steps.
 * - linkedin-page: its login id is the LinkedIn member id, which is also the
 *   internalId of the one-step linkedin (personal profile) channel. The
 *   upsert in createOrUpdateIntegration matches on (organizationId,
 *   internalId) and overwrites providerIdentifier, so starting a LinkedIn
 *   Page connect in a workspace that has that member's profile channel turns
 *   the profile's row into a linkedin-page row in between steps, with
 *   internalId = root.
 *
 * Left on the page picker, either would be swept after 24 h, with no posts
 * yet, and its tokens hashed. Their unfinished connects stay until the user
 * removes them. Hiding a provider (HIDDEN_PROVIDERS) only takes it off the
 * Add Channel list; the sweep does not look at it.
 *
 * The others are safe: Facebook and Instagram pages, YouTube channels and
 * Google Business locations all have ids of their own, never the id of the
 * login (a user id or Google account id). A provider added later whose login
 * id can also be a channel's id belongs here.
 */
export const NEVER_SWEPT: readonly string[] = ['tumblr', 'linkedin-page'];

/**
 * The row a two-step login created and nobody finished: it still carries the
 * login account's own id as both internalId and rootInternalId (createOrUpdate
 * sets root = internal on create). Picking a page turns the row into that
 * page (internalId = the page id, root = the login), so a channel that once
 * worked never matches, except for a provider in NEVER_SWEPT, which is
 * never one. A null root is not a placeholder: every placeholder
 * has had one since the first commit.
 */
export const isUnfinishedConnect = (row: {
  providerIdentifier: string;
  internalId: string;
  rootInternalId: string | null;
}) =>
  !NEVER_SWEPT.includes(row.providerIdentifier) &&
  !!row.rootInternalId &&
  row.rootInternalId === row.internalId;
