// Client credentials from an Authorization: Basic header at POST /oauth/token
// (client_secret_basic), as ChatGPT and other MCP clients may send them.
//   pnpm exec jest -c apps/backend/jest.config.ts oauth.controller
import { HttpException } from '@nestjs/common';
import { basicClientCredentials } from './oauth.controller';

const header = (raw: string) => 'Basic ' + Buffer.from(raw).toString('base64');

describe('basicClientCredentials', () => {
  it('reads the id and the secret', () => {
    expect(basicClientCredentials(header('pcd_abc:pcs_def'))).toEqual({ clientId: 'pcd_abc', clientSecret: 'pcs_def' });
  });

  it('form-decodes each part (RFC 6749 2.3.1), and a colon inside the secret survives', () => {
    expect(basicClientCredentials(header('my%20client:a%3Ab+c'))).toEqual({
      clientId: 'my client',
      clientSecret: 'a:b c',
    });
    expect(basicClientCredentials(header('id:se:cret'))).toEqual({ clientId: 'id', clientSecret: 'se:cret' });
  });

  it('the scheme is case-insensitive', () => {
    expect(basicClientCredentials('basic ' + Buffer.from('a:b').toString('base64'))).toEqual({
      clientId: 'a',
      clientSecret: 'b',
    });
  });

  it('null when there is no Basic header (a Bearer token, nothing)', () => {
    expect(basicClientCredentials(undefined)).toBeNull();
    expect(basicClientCredentials('')).toBeNull();
    expect(basicClientCredentials('Bearer pos_x')).toBeNull();
  });

  it.each([
    ['no colon', header('just-an-id')],
    ['an empty id', header(':secret')],
    ['a broken percent escape', header('%E0%A4%A:secret')],
  ])('invalid_client for %s', (_label, value) => {
    let error: unknown;
    try {
      basicClientCredentials(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(401);
    expect((error as HttpException).getResponse()).toMatchObject({ error: 'invalid_client' });
  });
});
