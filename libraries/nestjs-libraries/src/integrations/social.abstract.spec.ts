import {
  extractProviderMessage,
  missingScopesMessage,
  NotEnoughScopes,
  SocialAbstract,
  stripQuery,
  truncateForTemporal,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

// 8 Oct: someone unticked a box on Google's granular consent screen and was
// told "Not enough scopes, when choosing a provider, please add all the
// scopes". The message now says what to do, in the provider's words.
describe('a consent that did not grant every scope', () => {
  class Probe extends (SocialAbstract as any) {
    constructor(public identifier: string) {
      super();
    }
  }
  const missing = (identifier: string, got: string | string[]) => {
    try {
      (new Probe(identifier) as any).checkScopes(['a', 'b'], got);
    } catch (e) {
      return e;
    }
    return null;
  };

  it('YouTube: tick every permission on Google\'s screen', () => {
    const e = missing('youtube', 'a') as NotEnoughScopes;
    expect(e).toBeInstanceOf(NotEnoughScopes);
    expect(e.message).toBe(
      'Google asked you to tick each permission, and some were left unticked. Please connect again and tick all of them so Hookpost can post for you.'
    );
    expect(e.message).not.toMatch(/scopes/i);
  });

  it('Meta: keep every permission on under Edit access', () => {
    expect((missing('instagram', ['a']) as NotEnoughScopes).message).toContain(
      'Instagram did not grant every permission'
    );
    expect(missingScopesMessage('facebook')).toContain('Edit access');
  });

  it('others name the platform', () => {
    expect(missingScopesMessage('linkedin')).toBe(
      'LinkedIn did not grant every permission Hookpost needs. Please connect again and allow all of them.'
    );
    expect(missingScopesMessage('lemmy')).toMatch(/^Lemmy did not grant/);
  });

  it('every scope granted is still fine, comma or space separated', () => {
    expect(missing('youtube', 'a b')).toBeNull();
    expect(missing('youtube', 'a,b')).toBeNull();
    expect(missing('youtube', ['b', 'a'])).toBeNull();
  });
});

describe('stripQuery', () => {
  it('removes query parameters from valid URLs', () => {
    expect(stripQuery('https://a.com/b.png?x=1')).toBe('https://a.com/b.png');
  });

  it('falls back to splitting on ? for non-URL strings', () => {
    expect(stripQuery('not a url?x=1')).toBe('not a url');
  });
});

describe('truncateForTemporal', () => {
  it('returns an empty string for null', () => {
    expect(truncateForTemporal(null, 100)).toBe('');
  });

  it('returns an empty string for undefined', () => {
    expect(truncateForTemporal(undefined, 100)).toBe('');
  });

  it('returns strings unchanged when within the limit', () => {
    expect(truncateForTemporal('abc', 3)).toBe('abc');
    expect(truncateForTemporal('ab', 3)).toBe('ab');
  });

  it('truncates strings with the expected suffix', () => {
    expect(truncateForTemporal('abcdef', 3)).toBe('abc… [truncated 3 chars]');
  });

  it('JSON-stringifies objects', () => {
    expect(truncateForTemporal({ foo: 'bar' }, 1000)).toBe(
      JSON.stringify({ foo: 'bar' })
    );
  });

  it('does not throw for circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => truncateForTemporal(circular, 1000)).not.toThrow();
  });
});

describe('extractProviderMessage', () => {
  it('extracts Graph API error messages', () => {
    const raw = JSON.stringify({
      error: { message: 'Bad token', code: 190, error_subcode: 460 },
    });
    expect(extractProviderMessage(raw)).toBe('Bad token (code 190/460)');
  });

  it('extracts detail messages', () => {
    const raw = JSON.stringify({ detail: 'Too many' });
    expect(extractProviderMessage(raw)).toBe('Too many');
  });

  it('returns undefined for null', () => {
    expect(extractProviderMessage(null)).toBeUndefined();
  });

  it('returns undefined for plain non-JSON strings', () => {
    expect(extractProviderMessage('plain')).toBeUndefined();
  });

  it('limits messages to 300 characters', () => {
    const longMessage = 'a'.repeat(301);
    const raw = JSON.stringify({ detail: longMessage });
    const result = extractProviderMessage(raw);
    expect(result).toBeDefined();
    expect(result!.length).toBe(300);
  });
});
