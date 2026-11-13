/**
 * @jest-environment node
 */
/**
 * The free tools' counting (character counters, thread splitter). They are
 * public, indexed pages whose whole promise is "counts the way X counts":
 * links weigh 23, emoji 2, CJK 2, Hindi 1 per code point, and every post the
 * splitter makes fits the network's limit, numbering included.
 */
import {
  BLUESKY_LIMIT,
  BLUESKY_MAX_BYTES,
  X_LIMIT,
  graphemeCount,
  splitAtLimit,
  utf8Bytes,
  wordCount,
  xTokens,
  xWeight,
  graphemeTokens,
} from './count';
import { postLength, splitThread } from './thread';

describe('X weighting (twitter-text v3)', () => {
  it.each([
    ['plain ASCII', 'hello', 5],
    ['a link is 23 whatever its length', 'https://example.com/a/very/long/path?with=query', 23],
    ['punctuation after a link is not part of it', 'see https://a.co/x.', 4 + 23 + 1],
    ['an emoji weighs 2', '👍', 2],
    ['a family emoji is one grapheme of weight 2', '👨‍👩‍👧', 2],
    ['CJK weighs 2 per character', '日本', 4],
    ['Hindi weighs 1 per code point', 'नमस्ते', 6],
    ['a bare scheme is not a link', 'https://', 8],
  ])('%s', (_label, text, weight) => {
    expect(xWeight(text)).toBe(weight);
  });

  it('marks link and emoji tokens', () => {
    const tokens = xTokens('Go https://hookstep.in 🚀');
    expect(tokens.filter((t) => t.url).map((t) => t.text)).toEqual(['https://hookstep.in']);
    expect(tokens.filter((t) => t.emoji).map((t) => t.text)).toEqual(['🚀']);
  });
});

describe('plain counting', () => {
  it('graphemes, bytes and words', () => {
    expect(graphemeCount('👨‍👩‍👧 hi')).toBe(4);
    expect(utf8Bytes('é')).toBe(2);
    expect(wordCount('  two   words ')).toBe(2);
    expect(wordCount('   ')).toBe(0);
  });

  it('splitAtLimit cuts on token boundaries', () => {
    expect(splitAtLimit(graphemeTokens('abcdef'), 4)).toEqual({ fit: 'abcd', over: 'ef' });
    // A link is never cut in half.
    expect(splitAtLimit(xTokens('ab https://x.co/abc'), 10)).toEqual({ fit: 'ab ', over: 'https://x.co/abc' });
  });
});

describe('thread splitter', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const essay = `${words(60)}. ${words(40)}.\n\nSecond paragraph ${words(80)}.`;

  it.each([
    ['x', X_LIMIT],
    ['bluesky', BLUESKY_LIMIT],
  ] as const)('%s: every post fits, numbering included, and nothing is lost', (network, limit) => {
    for (const numbering of [false, true]) {
      const posts = splitThread(essay, network, numbering);
      expect(posts.length).toBeGreaterThan(1);
      for (const p of posts) {
        expect(postLength(p, network)).toBeLessThanOrEqual(limit);
        if (network === 'bluesky') expect(utf8Bytes(p)).toBeLessThanOrEqual(BLUESKY_MAX_BYTES);
      }
      const stripped = posts.map((p) => (numbering ? p.replace(/ \d+\/\d+$/, '') : p)).join(' ');
      for (const w of essay.split(/\s+/)) expect(stripped).toContain(w.replace(/\.$/, ''));
      if (numbering) {
        posts.forEach((p, i) => expect(p.endsWith(` ${i + 1}/${posts.length}`)).toBe(true));
      }
    }
  });

  it('keeps a short post whole and returns nothing for blank input', () => {
    expect(splitThread('Just one post.', 'x', true)).toEqual(['Just one post.']);
    expect(splitThread('  \n ', 'x', false)).toEqual([]);
  });

  it('hard-splits a single word longer than a post, but never a link on X', () => {
    const long = 'a'.repeat(700);
    const posts = splitThread(long, 'bluesky', false);
    expect(posts.join('')).toBe(long);
    for (const p of posts) expect(graphemeCount(p)).toBeLessThanOrEqual(BLUESKY_LIMIT);

    const withLink = `${'b'.repeat(270)} https://example.com/${'c'.repeat(300)}`;
    const xPosts = splitThread(withLink, 'x', false);
    expect(xPosts.some((p) => p.includes(`https://example.com/${'c'.repeat(300)}`))).toBe(true);
  });
});
