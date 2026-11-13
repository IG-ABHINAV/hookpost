/**
 * The words for what is left of a plan month's metered allowances
 * (GET /billing/usage, GET /copilot/credits): the shared AI credit pool and
 * the X posts (pricing.ts HOOKPOST tier).
 */

/** "94 of 100 AI credits left · an image uses 5" */
export function aiCreditsLeftLabel(pool: {
  left: number;
  total: number;
  cost?: number;
  imageCost?: number;
}): string {
  const image = pool.imageCost ?? (pool.cost && pool.cost > 1 ? pool.cost : undefined);
  return `${pool.left} of ${pool.total} AI credits left${
    image ? ` · an image uses ${image}` : ''
  }`;
}

/** "28 of 30 X posts left this month · no links on X" */
export function xPostsLeftLabel(x: {
  left: number;
  total: number;
  linksAllowed: boolean;
}): string {
  return `${x.left} of ${x.total} X posts left this month${
    x.linksAllowed ? '' : ' · no links on X'
  }`;
}
