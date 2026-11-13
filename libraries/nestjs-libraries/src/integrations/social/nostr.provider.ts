import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  BadBody,
  Disconnect,
  SocialAbstract,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import {
  getPublicKey,
  Relay,
  finalizeEvent,
  SimplePool,
  nip19,
  type VerifiedEvent,
} from 'nostr-tools';

import WebSocket from 'ws';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { Integration } from '@prisma/client';

// nostr-tools reads globalThis.WebSocket once, when it is first imported,
// so assigning the global here came too late and Node's own WebSocket (or
// none, before Node 22) was used. Hand `ws` to every Relay and pool instead.
// Relay and SimplePool pass this option on to AbstractRelay/AbstractPool,
// but their declared types leave it out; nostr.provider.spec.ts loads
// nostr-tools with no global WebSocket, so it fails if that ever changes.
const wsOption = { websocketImplementation: WebSocket } as {};

const list = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://vault.iris.to',
];

const KEY_HELP =
  'Paste your Nostr private key: the nsec1… key, or its 64-character hex form.';

// Reads the private key the user pasted (or the one stored on the channel).
// Until 20 Oct 2026 this split the raw string into hex pairs, so an nsec1…
// key, or a hex key with a stray space, decoded into a different but valid
// 32-byte key and silently connected someone else's identity. Anything that
// is not exactly an nsec or 64 hex characters is now refused instead.
export function parseNostrSecretKey(input: unknown): Uint8Array {
  const value = String(input ?? '').trim();

  if (/^npub1/i.test(value)) {
    throw new Error(
      'That is your public key (npub). Paste your private key instead, the one that starts with nsec1.'
    );
  }

  if (/^nsec1/i.test(value)) {
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(value.toLowerCase());
    } catch {
      throw new Error(
        'That nsec key is incomplete or mistyped. Copy it again from your Nostr app.'
      );
    }
    if (decoded.type !== 'nsec') {
      throw new Error(KEY_HELP);
    }
    return decoded.data;
  }

  if (/^[0-9a-f]{64}$/i.test(value)) {
    return new Uint8Array(Buffer.from(value, 'hex'));
  }

  throw new Error(KEY_HELP);
}

export class NostrProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 5;
  identifier = 'nostr';
  name = 'Nostr';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  toolTip =
    'Paste your Nostr private key (nsec1… or 64-character hex). Hookpost uses it only to sign your notes and stores it encrypted.';

  // Overridable so tests can point the provider at a local relay.
  protected relays = list;
  protected connectTimeoutMs = 7000;
  protected publishTimeoutMs = 10000;

  maxLength() {
    return 100000;
  }

  async customFields() {
    return [
      {
        key: 'password',
        label: 'Nostr private key',
        validation: `/^\\s*(nsec1[02-9ac-hj-np-z]{58}|[0-9a-fA-F]{64})\\s*$/`,
        type: 'password' as const,
        hint: 'Starts with nsec1, or is 64 hex characters. Not your npub.',
      },
    ];
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeId(17);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  // The stored token is the hex key encrypted with fixedEncryption. Channels
  // connected before 20 Oct 2026 hold a JWT of the raw input instead.
  private secretKeyFromToken(id: string, accessToken: string) {
    let raw: unknown;
    try {
      raw = accessToken.includes('.')
        ? (AuthService.verifyJWT(accessToken) as any)?.password
        : AuthService.fixedDecryption(accessToken);
    } catch {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        "The Nostr key saved on this channel can't be read. Reconnect Nostr."
      );
    }

    let secretKey: Uint8Array;
    try {
      secretKey = parseNostrSecretKey(raw);
    } catch (err: any) {
      throw new Disconnect(
        this.identifier,
        '{}',
        '{}',
        `The Nostr key saved on this channel is not a valid key. Reconnect Nostr. ${err?.message || ''}`.trim()
      );
    }

    // A key that signs as another pubkey would publish as someone else.
    if (id && getPublicKey(secretKey) !== id) {
      throw new Disconnect(
        this.identifier,
        '{}',
        '{}',
        'The Nostr key saved on this channel belongs to a different account than the one connected. Reconnect Nostr.'
      );
    }

    return secretKey;
  }

  private async findRelayInformation(pubkey: string) {
    // This queries ALL relays in parallel and resolves with
    // the first matching event from ANY relay. A pool per lookup, so no
    // relay sockets stay open after the connect.
    const pool = new SimplePool(wsOption);
    let evt;
    try {
      evt = await pool.get(
        this.relays,
        {
          kinds: [0],
          authors: [pubkey],
          limit: 1,
        },
        { maxWait: 5000 }
      );
    } finally {
      pool.destroy();
    }

    if (!evt) return {};

    let content: any = {};
    try {
      content = JSON.parse(evt.content || '{}');
    } catch {
      return {};
    }

    if (content.name || content.displayName || content.display_name) {
      return content;
    }

    return {};
  }

  private async publishToRelay(url: string, event: VerifiedEvent) {
    const relay = new Relay(url, wsOption);
    relay.publishTimeout = this.publishTimeoutMs;
    try {
      await relay.connect({ timeout: this.connectTimeoutMs });
      return await relay.publish(event);
    } finally {
      // close() only shuts an open socket; a connect that timed out would
      // otherwise linger and stay open if the relay answers later
      if (!relay.connected) {
        try {
          (relay as any).ws?.close();
        } catch {
          /**empty**/
        }
      }
      relay.close();
    }
  }

  // Sends the signed note to every relay at once. The post is live as soon as
  // one relay answers OK true. Until 20 Oct 2026 every relay error was
  // swallowed and the post id came from a subscription that returns the
  // author's newest STORED note, so a note every relay refused was still
  // marked published, linked to an older note.
  private async publish(event: VerifiedEvent) {
    const results = await Promise.allSettled(
      this.relays.map((url) => this.publishToRelay(url, event))
    );

    if (results.some((r) => r.status === 'fulfilled')) {
      return;
    }

    const reasons = results
      .map((r, i) => {
        const reason = (r as PromiseRejectedResult).reason;
        const host = this.relays[i].replace(/^wss?:\/\//, '').replace(/\/$/, '');
        return `${host}: ${reason instanceof Error ? reason.message : String(reason)}`;
      })
      .join('; ');

    throw new BadBody(
      this.identifier,
      JSON.stringify({ relays: reasons }),
      '{}',
      `No Nostr relay accepted the note. ${reasons}`
    );
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let password: unknown;
    try {
      password = JSON.parse(Buffer.from(params.code, 'base64').toString())
        ?.password;
    } catch {
      return 'Invalid credentials';
    }

    let secretKey: Uint8Array;
    let pubkey: string;
    try {
      secretKey = parseNostrSecretKey(password);
    } catch (e: any) {
      return e?.message || KEY_HELP;
    }
    try {
      pubkey = getPublicKey(secretKey);
    } catch {
      // the right length, but outside the range of valid secp256k1 keys
      return 'That is not a valid Nostr private key. Copy it again from your Nostr app.';
    }

    // The profile is cosmetic: an account with no kind 0 on these relays
    // still connects.
    let user: any = {};
    try {
      user = await this.findRelayInformation(pubkey);
    } catch {
      user = {};
    }

    return {
      id: pubkey,
      name: user.display_name || user.displayName || user.name || 'No Name',
      accessToken: AuthService.fixedEncryption(
        Buffer.from(secretKey).toString('hex')
      ),
      refreshToken: '',
      expiresIn: dayjs().add(200, 'year').unix() - dayjs().unix(),
      picture: user?.picture || '',
      // the npub lets the user check which identity was connected
      username: user.name || nip19.npubEncode(pubkey),
    };
  }

  private buildContent(post: PostDetails): string {
    // With cloud storage `path` is the public URL; with local storage it is
    // a file path on the server and `url` holds the public one.
    const mediaContent =
      post.media
        ?.map((m: any) => (/^https?:\/\//i.test(m.path) ? m.path : m.url))
        .filter((u: any) => typeof u === 'string' && /^https?:\/\//i.test(u))
        .join('\n\n') || '';
    return mediaContent
      ? `${post.message}\n\n${mediaContent}`
      : post.message;
  }

  private releaseURL(eventId: string) {
    return `https://primal.net/e/${nip19.noteEncode(eventId)}`;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const secretKey = this.secretKeyFromToken(id, accessToken);
    const [firstPost] = postDetails;

    const textEvent = finalizeEvent(
      {
        kind: 1, // Text note
        content: this.buildContent(firstPost),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    await this.publish(textEvent);

    return [
      {
        id: firstPost.id,
        postId: textEvent.id,
        releaseURL: this.releaseURL(textEvent.id),
        status: 'completed',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const secretKey = this.secretKeyFromToken(id, accessToken);
    const [commentPost] = postDetails;

    // NIP-10 marked tags: a direct reply to the root carries only the root
    // tag; a reply further down the chain carries root and reply.
    const tags: string[][] = [['e', postId, '', 'root', id]];
    if (lastCommentId && lastCommentId !== postId) {
      tags.push(['e', lastCommentId, '', 'reply', id]);
    }
    tags.push(['p', id]);

    const textEvent = finalizeEvent(
      {
        kind: 1, // Text note
        content: this.buildContent(commentPost),
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    await this.publish(textEvent);

    return [
      {
        id: commentPost.id,
        postId: textEvent.id,
        releaseURL: this.releaseURL(textEvent.id),
        status: 'completed',
      },
    ];
  }
}
