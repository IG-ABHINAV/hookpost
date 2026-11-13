import 'reflect-metadata';
import { MediumProvider } from '@hookpost/nestjs-libraries/integrations/social/medium.provider';

type Reply = { status?: number; body: any; raw?: boolean } | Error;

// Replaces global fetch with a scripted Medium. Every reply is a real Response.
// The error body is what Medium really sends - checked live on 26 Oct 2026
// with a made-up token:
//   GET /v1/me -> 401 {"errors":[{"message":"Token was invalid.","code":6003}]}
const setup = (replies: Reply[]) => {
  const calls: { url: string; headers: any }[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const next = replies.shift();
    if (!next) {
      throw new Error(`unexpected call to ${url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    const { status = 200, body, raw } = next;
    return new Response(raw ? body : JSON.stringify(body), { status });
  });
  return {
    provider: new MediumProvider(),
    calls,
    restore: () => ((global as any).fetch = original),
  };
};

const b64 = (s: string) => Buffer.from(s).toString('base64');
const code = (apiKey: unknown) => b64(JSON.stringify({ apiKey }));
const auth = (provider: MediumProvider, c: any) =>
  provider.authenticate({ code: c, codeVerifier: 'v' });

const ME = {
  data: {
    id: '5303d74c64f66366f00cb9b2a94f3251bf5',
    username: 'janedoe',
    name: 'Jane Doe',
    url: 'https://medium.com/@janedoe',
    imageUrl: 'https://cdn-images-1.medium.com/fit/c/400/400/0*abc.jpeg',
  },
};

describe('MediumProvider.authenticate', () => {
  let restore = () => undefined as any;
  afterEach(() => restore());

  // Each of these used to throw from JSON.parse, outside the try, and the
  // connect answered a bare "Authentication failed".
  it.each([
    ['not base64 of JSON', 'this is not base64 %%%'],
    ['base64 of plain text', b64('apiKey=abc')],
    ['base64 of truncated JSON', b64('{"apiKey": "abc')],
    ['an empty code', ''],
    ['no code at all', undefined],
    ['null', null],
    ['a JSON null', b64('null')],
    ['a JSON array', b64('[1,2]')],
  ])('a malformed submission (%s) returns a readable error and calls nobody', async (_, c) => {
    const s = setup([]);
    restore = s.restore;
    const result = await auth(s.provider, c);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/Medium integration token/);
    expect(s.calls).toHaveLength(0);
  });

  it.each([
    ['missing', b64('{}')],
    ['empty', code('')],
    ['only spaces', code('   ')],
    ['a number', code(12345)],
    ['an object', code({ nested: 'x' })],
  ])('an API key that is %s returns a readable error and calls nobody', async (_, c) => {
    const s = setup([]);
    restore = s.restore;
    const result = await auth(s.provider, c);
    expect(result).toBe('Paste your Medium integration token to connect Medium.');
    expect(s.calls).toHaveLength(0);
  });

  it.each([
    ['an inner space', 'abc def'],
    ['an accent', 'tökén'],
    ['a newline inside', 'abc\ndef'],
    ['an emoji', 'abc🙂'],
  ])('a key with %s is a rejected token, not "Could not reach Medium"', async (_, key) => {
    const s = setup([]);
    restore = s.restore;
    expect(await auth(s.provider, code(key))).toMatch(/did not accept/);
    expect(s.calls).toHaveLength(0);
  });

  it('a token Medium rejects (401) says so', async () => {
    const s = setup([
      { status: 401, body: { errors: [{ message: 'Token was invalid.', code: 6003 }] } },
    ]);
    restore = s.restore;
    const result = await auth(s.provider, code('revoked-token'));
    expect(result).toMatch(/Medium did not accept this integration token/);
    expect(s.calls[0].url).toBe('https://api.medium.com/v1/me');
    expect(s.calls[0].headers.Authorization).toBe('Bearer revoked-token');
  });

  it('a 403 reads the same as a rejected token', async () => {
    const s = setup([{ status: 403, body: { errors: [] } }]);
    restore = s.restore;
    expect(await auth(s.provider, code('k'))).toMatch(/did not accept/);
  });

  it('Medium down (HTTP 503) asks to try again, with the status', async () => {
    const s = setup([{ status: 503, body: 'Service Unavailable', raw: true }]);
    restore = s.restore;
    expect(await auth(s.provider, code('k'))).toBe(
      'Medium did not answer (HTTP 503), please try again in a minute.'
    );
  });

  it('a network failure asks to try again', async () => {
    const s = setup([new TypeError('fetch failed')]);
    restore = s.restore;
    expect(await auth(s.provider, code('k'))).toBe(
      'Could not reach Medium, please try again in a minute.'
    );
  });

  it('a 200 that is not JSON is reported, not thrown', async () => {
    const s = setup([{ status: 200, body: '<html>maintenance</html>', raw: true }]);
    restore = s.restore;
    expect(await auth(s.provider, code('k'))).toMatch(/unexpected answer/);
  });

  it.each([
    ['no data', {}],
    ['data without an id', { data: { username: 'x' } }],
    ['a JSON null', null],
  ])('a 200 with %s is a rejected token, not a channel with no id', async (_, body) => {
    const s = setup([{ status: 200, body }]);
    restore = s.restore;
    expect(await auth(s.provider, code('k'))).toMatch(/did not accept/);
  });

  it('a valid token connects, trimmed, with the profile Medium returns', async () => {
    const s = setup([{ status: 200, body: ME }]);
    restore = s.restore;
    const result: any = await auth(s.provider, code('  good-token \n'));
    expect(s.calls[0].headers.Authorization).toBe('Bearer good-token');
    expect(result).toMatchObject({
      accessToken: 'good-token',
      refreshToken: '',
      id: ME.data.id,
      name: 'Jane Doe',
      username: 'janedoe',
      picture: ME.data.imageUrl,
    });
    expect(result.expiresIn).toBeGreaterThan(60 * 60 * 24 * 365 * 50);
  });

  it('a profile with no name or picture falls back cleanly', async () => {
    const s = setup([{ status: 200, body: { data: { id: 42, username: 'u' } } }]);
    restore = s.restore;
    const result: any = await auth(s.provider, code('k'));
    expect(result).toMatchObject({ id: '42', name: 'u', username: 'u', picture: '' });
  });
});
