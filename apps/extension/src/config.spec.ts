/**
 * Which pages may message the extension. Only the Hookpost app: an extension
 * that reads a user's Skool session must not answer any other hookstep.in
 * page, plain http, or localhost in the store build.
 *   pnpm exec jest -c apps/extension/jest.config.ts config
 */
import {
  DEV_POLICY,
  isOriginAllowed,
  PRODUCTION_BACKEND_URL,
  PRODUCTION_POLICY,
  senderOrigin,
} from './config';

describe('isOriginAllowed, store build', () => {
  it.each([
    ['https://hookpost.hookstep.in'],
    // The same origin written differently: URL parsing normalises these.
    ['https://HOOKPOST.hookstep.in'],
    ['https://hookpost.hookstep.in:443'],
  ])('allows %s', (origin) => {
    expect(isOriginAllowed(origin, PRODUCTION_POLICY)).toBe(true);
  });

  it.each([
    // Other hookstep.in products and the media host.
    ['https://tablamigo.hookstep.in'],
    ['https://media.hookstep.in'],
    ['https://hookstep.in'],
    ['https://www.hookstep.in'],
    ['https://staging.hookpost.hookstep.in'],
    // Not https.
    ['http://hookpost.hookstep.in'],
    // The upstream-era domain and look-alikes.
    ['https://hookpost.com'],
    ['https://platform.hookpost.com'],
    ['https://hookpost.hookstep.in.evil.example'],
    ['https://evilhookpost.hookstep.in'],
    ['https://hookpost-hookstep.in'],
    ['https://hookpost.hookstep.in@evil.example'],
    ['https://hookpost.hookstep.in:8443'],
    // Localhost is a dev build only.
    ['http://localhost'],
    ['http://localhost:4200'],
    ['https://localhost:4200'],
    ['http://127.0.0.1:4200'],
    // Not origins at all.
    ['null'],
    ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
    ['file:///etc/passwd'],
    ['hookpost.hookstep.in'],
    [''],
  ])('rejects %s', (origin) => {
    expect(isOriginAllowed(origin, PRODUCTION_POLICY)).toBe(false);
  });

  it('rejects a missing origin', () => {
    expect(isOriginAllowed(undefined)).toBe(false);
  });

  it('defaults to the store policy', () => {
    expect(isOriginAllowed('http://localhost:4200')).toBe(false);
    expect(isOriginAllowed('https://hookpost.hookstep.in')).toBe(true);
  });
});

describe('isOriginAllowed, dev build', () => {
  it.each([
    ['http://localhost'],
    ['http://localhost:4200'],
    ['https://localhost:4200'],
    ['https://hookpost.hookstep.in'],
  ])('allows %s', (origin) => {
    expect(isOriginAllowed(origin, DEV_POLICY)).toBe(true);
  });

  it.each([
    ['https://tablamigo.hookstep.in'],
    ['http://localhost.evil.example'],
    ['http://127.0.0.1:4200'],
  ])('still rejects %s', (origin) => {
    expect(isOriginAllowed(origin, DEV_POLICY)).toBe(false);
  });
});

describe('senderOrigin', () => {
  it('prefers sender.origin', () => {
    expect(
      senderOrigin({
        origin: 'https://tablamigo.hookstep.in',
        url: 'https://hookpost.hookstep.in/launches',
      })
    ).toBe('https://tablamigo.hookstep.in');
  });

  it('falls back to the origin of sender.url', () => {
    expect(senderOrigin({ url: 'https://hookpost.hookstep.in/launches?x=1' })).toBe(
      'https://hookpost.hookstep.in'
    );
  });

  it('reads userinfo as what it is', () => {
    expect(
      senderOrigin({ url: 'https://hookpost.hookstep.in@evil.example/x' })
    ).toBe('https://evil.example');
  });

  it('is undefined with neither', () => {
    expect(senderOrigin({})).toBeUndefined();
  });
});

it('posts to the production backend', () => {
  expect(PRODUCTION_BACKEND_URL).toBe('https://hookpost.hookstep.in/api');
});
