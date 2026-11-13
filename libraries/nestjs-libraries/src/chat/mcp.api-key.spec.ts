// Where /mcp reads the API key from (mcpTokenFromHeaders, used in start.mcp.ts).
//   pnpm exec jest -c apps/backend/jest.config.ts mcp.api-key

import { MCP_API_KEY_HEADER, mcpTokenFromHeaders } from '@hookpost/nestjs-libraries/chat/mcp.api-key';

describe('mcpTokenFromHeaders', () => {
  it('the header name is lower-case, as Node stores incoming headers', () => {
    expect(MCP_API_KEY_HEADER).toBe('x-hookpost-api-key');
  });

  it('Authorization: Bearer <key> is read as before', () => {
    expect(mcpTokenFromHeaders({ authorization: 'Bearer key-1' })).toBe('key-1');
    expect(mcpTokenFromHeaders({ authorization: 'key-1' })).toBe('key-1');
    expect(mcpTokenFromHeaders({ authorization: 'Bearer pos_token' })).toBe('pos_token');
  });

  it('x-hookpost-api-key carries the raw key when Authorization is absent', () => {
    expect(mcpTokenFromHeaders({ 'x-hookpost-api-key': 'key-2' })).toBe('key-2');
  });

  it('x-hookpost-api-key tolerates a "Bearer " prefix and surrounding spaces', () => {
    expect(mcpTokenFromHeaders({ 'x-hookpost-api-key': 'Bearer key-2' })).toBe('key-2');
    expect(mcpTokenFromHeaders({ 'x-hookpost-api-key': 'bearer   key-2 ' })).toBe('key-2');
    expect(mcpTokenFromHeaders({ 'x-hookpost-api-key': '  key-2  ' })).toBe('key-2');
  });

  it('both headers: Authorization wins', () => {
    expect(
      mcpTokenFromHeaders({ authorization: 'Bearer from-auth', 'x-hookpost-api-key': 'from-header' })
    ).toBe('from-auth');
  });

  it('a blank Authorization counts as absent, so the new header is read', () => {
    expect(mcpTokenFromHeaders({ authorization: '', 'x-hookpost-api-key': 'key-3' })).toBe('key-3');
    expect(mcpTokenFromHeaders({ authorization: '   ', 'x-hookpost-api-key': 'key-3' })).toBe('key-3');
  });

  it.each([
    ['no headers', {}],
    ['an empty x-hookpost-api-key', { 'x-hookpost-api-key': '' }],
    ['a whitespace x-hookpost-api-key', { 'x-hookpost-api-key': '   ' }],
    ['a bare "Bearer" in x-hookpost-api-key', { 'x-hookpost-api-key': 'Bearer ' }],
    ['a bare "Bearer " in Authorization', { authorization: 'Bearer ' }],
  ])('%s gives no token', (_label, headers) => {
    expect(mcpTokenFromHeaders(headers as any)).toBeUndefined();
  });

  it('an array value (header sent twice) uses the first', () => {
    expect(mcpTokenFromHeaders({ 'x-hookpost-api-key': ['key-4', 'key-5'] as any })).toBe('key-4');
  });
});
