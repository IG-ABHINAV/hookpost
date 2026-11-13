import http from 'node:http';
import dns from 'node:dns';
import { AddressInfo } from 'node:net';
import axios from 'axios';

// The SSRF guard has two halves: the pinned DNS lookup (hostnames) and an
// IP-literal check before the socket opens, because net.connect never calls
// `lookup` when the host is already an IP. These specs send real requests to
// a server on 127.0.0.1 and count what actually reaches it.

jest.mock('./webhook.url.validator', () => {
  const actual = jest.requireActual('./webhook.url.validator');
  return { ...actual, isBlockedIp: jest.fn(actual.isBlockedIp) };
});

import { isBlockedIp } from './webhook.url.validator';
import {
  getSsrfSafeAxios,
  getSsrfSafeDispatcher,
  ssrfSafeDispatcher,
} from './ssrf.safe.dispatcher';

const realIsBlockedIp: (ip: string) => boolean = jest.requireActual(
  './webhook.url.validator'
).isBlockedIp;
const PUBLIC_HOST = 'public.hookpost.test';

let server: http.Server;
let port: number;
let hits: string[];

const fetchVia = (url: string) =>
  fetch(url, { dispatcher: getSsrfSafeDispatcher() } as RequestInit);

// Stands in for a public hostname: it resolves to the test server and the
// guard is told that address is public. Every other address is checked for
// real, so a redirect to a private literal is still refused.
function resolvePublicHostToTestServer() {
  const realLookup = dns.lookup;
  jest.spyOn(dns, 'lookup').mockImplementation(((
    hostname: string,
    options: any,
    callback: any
  ) => {
    if (hostname !== PUBLIC_HOST) {
      return (realLookup as any)(hostname, options, callback);
    }
    return options?.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4);
  }) as any);
  (isBlockedIp as jest.Mock).mockImplementation((ip: string) =>
    ip === '127.0.0.1' ? false : realIsBlockedIp(ip)
  );
}

const privateLiterals = () => [
  `http://127.0.0.1:${port}/`,
  `http://0.0.0.0:${port}/`,
  // The URL parser rewrites this to [::ffff:7f00:1]
  `http://[::ffff:127.0.0.1]:${port}/`,
  `http://[::1]:${port}/`,
  'http://10.0.0.5/',
  'http://169.254.169.254/latest/meta-data/',
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/redirect-to-metadata') {
      res.writeHead(302, {
        location: 'http://169.254.169.254/latest/meta-data/',
      });
      res.end();
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await ssrfSafeDispatcher.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  hits = [];
});

afterEach(() => {
  jest.restoreAllMocks();
  (isBlockedIp as jest.Mock).mockImplementation(realIsBlockedIp);
  delete process.env.DISABLE_SSRF_PROTECTION;
});

describe('getSsrfSafeDispatcher (fetch)', () => {
  it('refuses http://127.0.0.1 without calling the lookup', async () => {
    const lookup = jest.spyOn(dns, 'lookup');

    await expect(fetchVia(`http://127.0.0.1:${port}/`)).rejects.toMatchObject(
      { cause: { message: 'Blocked IP' } }
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });

  it('refuses every private IP literal before connecting', async () => {
    for (const url of privateLiterals()) {
      await expect(fetchVia(url)).rejects.toMatchObject({
        cause: { message: 'Blocked IP' },
      });
    }
    expect(hits).toEqual([]);
  });

  it('still blocks a hostname that resolves to a private address', async () => {
    await expect(fetchVia(`http://localhost:${port}/`)).rejects.toMatchObject({
      cause: { message: 'Blocked IP' },
    });
    expect(hits).toEqual([]);
  });

  it('connects a public hostname to the address the lookup pinned', async () => {
    resolvePublicHostToTestServer();

    const response = await fetchVia(`http://${PUBLIC_HOST}:${port}/hello`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(hits).toEqual(['/hello']);
  });

  it('refuses a redirect from a public hostname to the metadata address', async () => {
    resolvePublicHostToTestServer();

    await expect(
      fetchVia(`http://${PUBLIC_HOST}:${port}/redirect-to-metadata`)
    ).rejects.toMatchObject({ cause: { message: 'Blocked IP' } });
    expect(hits).toEqual(['/redirect-to-metadata']);
  });
});

describe('getSsrfSafeAxios', () => {
  it('refuses http://127.0.0.1 without calling the lookup', async () => {
    const lookup = jest.spyOn(dns, 'lookup');

    await expect(
      getSsrfSafeAxios().get(`http://127.0.0.1:${port}/`)
    ).rejects.toThrow('Blocked IP');
    expect(lookup).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });

  it('refuses every private IP literal before connecting', async () => {
    for (const url of privateLiterals()) {
      await expect(getSsrfSafeAxios().get(url)).rejects.toThrow('Blocked IP');
    }
    expect(hits).toEqual([]);
  });

  it('refuses an https IP literal too', async () => {
    await expect(
      getSsrfSafeAxios().get(`https://127.0.0.1:${port}/`)
    ).rejects.toThrow('Blocked IP');
    expect(hits).toEqual([]);
  });

  it('still blocks a hostname that resolves to a private address', async () => {
    await expect(
      getSsrfSafeAxios().get(`http://localhost:${port}/`)
    ).rejects.toThrow('Blocked IP');
    expect(hits).toEqual([]);
  });

  it('connects a public hostname to the address the lookup pinned', async () => {
    resolvePublicHostToTestServer();

    const response = await getSsrfSafeAxios().get(
      `http://${PUBLIC_HOST}:${port}/hello`
    );

    expect(response.status).toBe(200);
    expect(response.data).toBe('ok');
    expect(hits).toEqual(['/hello']);
  });

  it('refuses a redirect from a public hostname to the metadata address', async () => {
    resolvePublicHostToTestServer();

    await expect(
      getSsrfSafeAxios().get(`http://${PUBLIC_HOST}:${port}/redirect-to-metadata`)
    ).rejects.toThrow('Blocked IP');
    expect(hits).toEqual(['/redirect-to-metadata']);
  });
});

describe('DISABLE_SSRF_PROTECTION=true (self-hosted opt-out)', () => {
  it('lets both transports reach a private address', async () => {
    process.env.DISABLE_SSRF_PROTECTION = 'true';

    expect(getSsrfSafeDispatcher()).toBeUndefined();
    expect(getSsrfSafeAxios()).toBe(axios);

    const response = await fetchVia(`http://127.0.0.1:${port}/fetch`);
    expect(await response.text()).toBe('ok');
    const { data } = await getSsrfSafeAxios().get(
      `http://127.0.0.1:${port}/axios`
    );
    expect(data).toBe('ok');
    expect(hits).toEqual(['/fetch', '/axios']);
  });
});
