import type { IncomingHttpHeaders } from 'http';

/**
 * Second place the API-key endpoint (/mcp) reads the key from. MCP gateways
 * such as Smithery reserve Authorization for their own use and never forward
 * it, so they send the user's Hookpost API key in this header instead.
 */
export const MCP_API_KEY_HEADER = 'x-hookpost-api-key';

/**
 * The key or OAuth token a /mcp request carries, or undefined when it has none.
 *
 * - Authorization: Bearer <key> is read exactly as before and always wins.
 * - Only when Authorization is absent (or blank) is x-hookpost-api-key read:
 *   the raw key, with an optional "Bearer " prefix tolerated.
 */
export const mcpTokenFromHeaders = (headers: IncomingHttpHeaders): string | undefined => {
  const authorization = headers.authorization;
  if (authorization?.trim()) {
    return authorization.replace('Bearer ', '') || undefined;
  }

  const header = headers[MCP_API_KEY_HEADER];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!value) return undefined;
  return value.replace(/^Bearer(\s+|$)/i, '').trim() || undefined;
};
