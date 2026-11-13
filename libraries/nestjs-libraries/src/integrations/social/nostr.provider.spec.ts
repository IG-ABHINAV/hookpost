import 'reflect-metadata';

// nostr-tools 2.x pulls in ESM-only @noble packages that jest's CommonJS
// runtime can't parse. Node 22 can require() them, so load the real library
// through Node's own loader instead of mocking it away: every test below
// signs, verifies and speaks the relay protocol for real.
// Loaded that way it lives in Node's main realm, where an object built in
// jest's sandbox fails nostr-tools' `instanceof Object` check, so events
// handed to it are first rebuilt in the main realm. Production runs in one
// realm and never needs this.
// The main realm's global WebSocket is hidden while this file runs, as on
// Node 20, so a test only passes if the provider hands nostr-tools `ws`
// itself; Node 22's built-in one would otherwise hide that (and it follows
// HTTP(S)_PROXY). afterAll puts it back.
jest.mock('nostr-tools', () => {
  const builtin = (process as any).getBuiltinModule;
  const mainGlobal = builtin('vm').runInThisContext('globalThis');
  const nativeWebSocket = Object.getOwnPropertyDescriptor(mainGlobal, 'WebSocket');
  delete mainGlobal.WebSocket;
  const real = builtin('module').createRequire(__filename)('nostr-tools');
  const mainJSON = builtin('vm').runInThisContext('JSON');
  const toMain = (o: any) => mainJSON.parse(JSON.stringify(o));
  return {
    ...real,
    finalizeEvent: (t: any, sk: Uint8Array) => real.finalizeEvent(toMain(t), sk),
    verifyEvent: (e: any) => real.verifyEvent(toMain(e)),
    restoreNativeWebSocket: () => {
      if (nativeWebSocket) Object.defineProperty(mainGlobal, 'WebSocket', nativeWebSocket);
    },
  };
});
afterAll(() => jest.requireMock<any>('nostr-tools').restoreNativeWebSocket());

import WebSocket from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
} from 'nostr-tools';
import {
  NostrProvider,
  parseNostrSecretKey,
} from '@hookpost/nestjs-libraries/integrations/social/nostr.provider';
import {
  BadBody,
  Disconnect,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { sign } from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret';

// A minimal NIP-01 relay: stores and answers OK to EVENT, serves REQ from
// what it has stored (newest first) and ends it with EOSE.
class FakeRelay {
  private wss!: WebSocket.Server;
  url = '';
  mode: 'accept' | 'reject' | 'silent' = 'accept';
  rejectReason = 'blocked: you are not allowed to post here';
  received: any[] = [];
  stored: any[] = [];

  async start() {
    this.wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => this.wss.on('listening', () => resolve()));
    this.url = `ws://127.0.0.1:${(this.wss.address() as any).port}`;
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw: any) => {
        const msg = JSON.parse(raw.toString());
        if (msg[0] === 'EVENT') {
          const ev = msg[1];
          this.received.push(ev);
          if (this.mode === 'silent') return;
          if (!verifyEvent({ ...ev })) {
            ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
            return;
          }
          if (this.mode === 'reject') {
            ws.send(JSON.stringify(['OK', ev.id, false, this.rejectReason]));
            return;
          }
          this.stored.push(ev);
          ws.send(JSON.stringify(['OK', ev.id, true, '']));
        }
        if (msg[0] === 'REQ') {
          const [, sub, ...filters] = msg;
          this.stored
            .filter((e) =>
              filters.some(
                (f: any) =>
                  (!f.kinds || f.kinds.includes(e.kind)) &&
                  (!f.authors || f.authors.includes(e.pubkey))
              )
            )
            .sort((a, b) => b.created_at - a.created_at)
            .forEach((e) => ws.send(JSON.stringify(['EVENT', sub, e])));
          ws.send(JSON.stringify(['EOSE', sub]));
        }
      });
    });
  }

  async stop() {
    this.wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

// a port nothing listens on
const deadRelay = async () => {
  const r = new FakeRelay();
  await r.start();
  await r.stop();
  return r.url;
};

const hex = (sk: Uint8Array) => Buffer.from(sk).toString('hex');
const code = (password: string) =>
  Buffer.from(JSON.stringify({ password })).toString('base64');

const provider = (relays: string[]): any => {
  const p: any = new NostrProvider();
  p.relays = relays;
  p.connectTimeoutMs = 2000;
  p.publishTimeoutMs = 800;
  return p;
};

const profile = (sk: Uint8Array, content: object, created_at = 1_700_000_000) =>
  finalizeEvent({ kind: 0, content: JSON.stringify(content), tags: [], created_at }, sk);

const post = (message: string, media: any[] = []): any => ({
  id: 'p1',
  message,
  settings: {},
  media,
});

describe('NostrProvider', () => {
  let a: FakeRelay;
  let b: FakeRelay;
  let sk: Uint8Array;
  let pubkey: string;

  beforeEach(async () => {
    a = new FakeRelay();
    b = new FakeRelay();
    await a.start();
    await b.start();
    sk = generateSecretKey();
    pubkey = getPublicKey(sk);
  });

  afterEach(async () => {
    await a.stop();
    await b.stop();
  });

  const connect = async (password: string) =>
    provider([a.url, b.url]).authenticate({ code: code(password), codeVerifier: '' });

  describe('connect', () => {
    it('connects a hex key, reads the profile and stores the key encrypted', async () => {
      a.stored.push(profile(sk, { name: 'satoshi', display_name: 'Satoshi N', picture: 'https://x/p.png' }));

      const auth = await connect(hex(sk));

      expect(auth).toMatchObject({
        id: pubkey,
        name: 'Satoshi N',
        username: 'satoshi',
        picture: 'https://x/p.png',
      });
      expect(auth.accessToken).not.toContain(hex(sk));
      expect(AuthService.fixedDecryption(auth.accessToken)).toBe(hex(sk));
    });

    it('connects the SAME identity from the nsec form, with stray whitespace around it', async () => {
      // before 20 Oct 2026 an nsec (or a hex key with a space) decoded into a
      // different valid key and connected someone else's identity
      for (const input of [nip19.nsecEncode(sk), `  ${nip19.nsecEncode(sk)}\n`, ` ${hex(sk)} `, hex(sk).toUpperCase()]) {
        const auth = await connect(input);
        expect(auth.id).toBe(pubkey);
        expect(AuthService.fixedDecryption(auth.accessToken)).toBe(hex(sk));
      }
    });

    it('still connects an account with no profile, showing its npub', async () => {
      const auth = await connect(hex(sk));
      expect(auth).toMatchObject({
        id: pubkey,
        name: 'No Name',
        username: nip19.npubEncode(pubkey),
      });
    });

    it('still connects when no relay can be reached for the profile', async () => {
      const auth = await provider([await deadRelay()]).authenticate({
        code: code(nip19.nsecEncode(sk)),
        codeVerifier: '',
      });
      expect(auth.id).toBe(pubkey);
    });

    it('refuses bad credentials with a message that says what to paste', async () => {
      expect(await connect(nip19.npubEncode(pubkey))).toMatch(/public key \(npub\)/);
      expect(await connect('hunter2')).toMatch(/nsec1… key, or its 64-character hex form/);
      expect(await connect(hex(sk).slice(1))).toMatch(/64-character hex/);
      const nsec = nip19.nsecEncode(sk);
      const typo = nsec.slice(0, -1) + (nsec.endsWith('q') ? 'p' : 'q');
      expect(await connect(typo)).toMatch(/incomplete or mistyped/);
      expect(await connect('0'.repeat(64))).toMatch(/not a valid Nostr private key/);
      expect(
        await provider([a.url]).authenticate({ code: 'not base64 json', codeVerifier: '' })
      ).toBe('Invalid credentials');
    });

    it('parseNostrSecretKey decodes nsec and hex to the same bytes', () => {
      expect(hex(parseNostrSecretKey(nip19.nsecEncode(sk)))).toBe(hex(sk));
      expect(hex(parseNostrSecretKey(hex(sk)))).toBe(hex(sk));
    });
  });

  describe('post', () => {
    const token = () => AuthService.fixedEncryption(hex(sk));

    it('publishes a text note signed by the connected key to every relay', async () => {
      const [res] = await provider([a.url, b.url]).post(pubkey, token(), [post('gm nostr')]);

      for (const relay of [a, b]) {
        expect(relay.received).toHaveLength(1);
        const ev = relay.received[0];
        expect(ev).toMatchObject({ kind: 1, pubkey, content: 'gm nostr', tags: [] });
        expect(verifyEvent({ ...ev })).toBe(true);
        expect(res.postId).toBe(ev.id);
      }
      expect(res).toEqual({
        id: 'p1',
        postId: a.received[0].id,
        releaseURL: `https://primal.net/e/${nip19.noteEncode(a.received[0].id)}`,
        status: 'completed',
      });
    });

    it('returns the new note, not the newest note the relay already had', async () => {
      const old = finalizeEvent(
        { kind: 1, content: 'older note', tags: [], created_at: Math.floor(Date.now() / 1000) + 60 },
        sk
      );
      a.stored.push(old);
      b.stored.push(old);

      const [res] = await provider([a.url, b.url]).post(pubkey, token(), [post('new note')]);

      expect(res.postId).not.toBe(old.id);
      expect(res.postId).toBe(a.received[0].id);
    });

    it('appends an image URL to the note', async () => {
      const [res] = await provider([a.url]).post(pubkey, token(), [
        post('look', [{ type: 'image', path: 'https://media.hookstep.in/abc.jpg' }]),
      ]);
      expect(a.received[0].content).toBe('look\n\nhttps://media.hookstep.in/abc.jpg');
      expect(res.status).toBe('completed');
    });

    it('appends a video URL, and never a server file path', async () => {
      await provider([a.url]).post(pubkey, token(), [
        post('watch', [
          { type: 'video', path: 'https://media.hookstep.in/clip.mp4' },
          // local storage: path is on disk, url is the public one
          { type: 'image', path: '/srv/uploads/2026/10/x.png', url: 'https://hookpost.example/uploads/2026/10/x.png' },
          { type: 'image', path: '/srv/uploads/no-url.png' },
        ]),
      ]);
      expect(a.received[0].content).toBe(
        'watch\n\nhttps://media.hookstep.in/clip.mp4\n\nhttps://hookpost.example/uploads/2026/10/x.png'
      );
      expect(a.received[0].content).not.toContain('/srv/');
    });

    it('counts as published when at least one relay accepts it', async () => {
      a.mode = 'reject';
      const [res] = await provider([a.url, b.url, await deadRelay()]).post(pubkey, token(), [post('hi')]);
      expect(res.postId).toBe(b.received[0].id);
      expect(res.status).toBe('completed');
    });

    it('fails with the relays’ own reasons when no relay accepts it', async () => {
      a.mode = 'reject';
      b.mode = 'silent';
      const dead = await deadRelay();

      const err = await provider([a.url, b.url, dead])
        .post(pubkey, token(), [post('hi')])
        .catch((e: any) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toMatch(/^No Nostr relay accepted the note\./);
      expect(err.message).toContain('blocked: you are not allowed to post here');
      expect(err.message).toContain('publish timed out');
      expect(err.message).toContain(dead.replace('ws://', ''));
    });

    it('still posts with a channel connected before the fix (JWT token)', async () => {
      const legacy = sign({ password: hex(sk) }, process.env.JWT_SECRET!);
      const [res] = await provider([a.url]).post(pubkey, legacy, [post('legacy')]);
      expect(a.received[0].pubkey).toBe(pubkey);
      expect(res.status).toBe('completed');
    });

    it('refuses to sign as another account than the connected one', async () => {
      const other = getPublicKey(generateSecretKey());
      const err = await provider([a.url])
        .post(other, token(), [post('hi')])
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(Disconnect);
      expect(err.message).toMatch(/Reconnect Nostr/);
      expect(a.received).toHaveLength(0);
    });
  });

  describe('comment', () => {
    it('threads replies with NIP-10 root and reply markers', async () => {
      const token = AuthService.fixedEncryption(hex(sk));
      const p = provider([a.url]);
      const root = 'a'.repeat(64);

      const [first] = await p.comment(pubkey, root, undefined, token, [post('reply 1')]);
      expect(a.received[0].tags).toEqual([
        ['e', root, '', 'root', pubkey],
        ['p', pubkey],
      ]);

      await p.comment(pubkey, root, first.postId, token, [post('reply 2')]);
      expect(a.received[1].tags).toEqual([
        ['e', root, '', 'root', pubkey],
        ['e', first.postId, '', 'reply', pubkey],
        ['p', pubkey],
      ]);
      expect(first.releaseURL).toBe(`https://primal.net/e/${nip19.noteEncode(first.postId)}`);
    });
  });
});
