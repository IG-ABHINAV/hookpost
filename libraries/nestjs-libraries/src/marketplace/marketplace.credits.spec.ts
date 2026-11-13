/**
 * Credit counting and X's thread rules (marketplace.credits.ts).
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.credits
 */
import {
  checkThread,
  hasLink,
  plainTextToPostHtml,
  threadCostMicroUsd,
  threadOptionsFor,
  xWeightedLength,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.credits';
import { marketplacePlan } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { stripHtmlValidation } from '@hookpost/helpers/utils/strip.html.validation';

const basic = marketplacePlan('x', 'basic')!;
const trial = marketplacePlan('x', 'trial')!;
const tweet = (text: string, media: ('image' | 'video')[] = []) => ({
  text,
  media: media.map((type) => ({ type })),
});

describe('hasLink', () => {
  it.each([
    ['a scheme URL', 'read https://hookpost.hookstep.in/docs now'],
    ['a bare domain', 'see example.com for more'],
    ['t.co', 'via t.co/abc123'],
    ['a URL glued to emoji', '🔥hookpost.in🔥'],
    ['www.', 'www.example.org'],
    ['a domain with a path', 'docs at hookstep.in/api'],
  ])('finds %s', (_name, text) => {
    expect(hasLink(text)).toBe(true);
  });

  it.each([
    ['plain text', 'We shipped today. Thanks, everyone!'],
    ['a file name', 'Node.js and Next.js both run here'],
    ['an email-like handle', 'ping @hookpost'],
    ['empty', ''],
  ])('finds none in %s', (_name, text) => {
    expect(hasLink(text)).toBe(false);
  });
});

describe('checkThread', () => {
  it('charges 2 credits per tweet, replies included', () => {
    const check = checkThread([tweet('one'), tweet('two'), tweet('three')], threadOptionsFor(basic));
    expect(check.valid).toBe(true);
    expect(check.credits).toBe(6);
    expect(check.tweets.map((t) => t.credits)).toEqual([2, 2, 2]);
  });

  it('refuses a link by default (link_policy reject) so nobody is charged by surprise', () => {
    const check = checkThread([tweet('ok'), tweet('see example.com')], threadOptionsFor(basic));
    expect(check.valid).toBe(false);
    expect(check.tweets[1].has_link).toBe(true);
    expect(check.tweets[1].errors[0]).toMatch(/link_policy "allow"/);
  });

  it('charges 20 credits for a tweet with a link under link_policy allow', () => {
    const check = checkThread(
      [tweet('ok'), tweet('see example.com')],
      threadOptionsFor(basic, { linkPolicy: 'allow' })
    );
    expect(check.valid).toBe(true);
    expect(check.credits).toBe(22);
    expect(threadCostMicroUsd(check)).toBe(15_000 + 200_000);
  });

  it('refuses links on a plan without them (the trial), even with allow', () => {
    const check = checkThread([tweet('see example.com')], threadOptionsFor(trial, { linkPolicy: 'allow' }));
    expect(check.valid).toBe(false);
    expect(check.tweets[0].errors[0]).toMatch(/does not include tweets with links/);
  });

  it('bills a stripped link as a plain tweet (STRIP_LINKS_FROM_X_POSTS)', () => {
    const check = checkThread(
      [tweet('see example.com')],
      threadOptionsFor(basic, { linkPolicy: 'allow', stripLinks: true })
    );
    expect(check.valid).toBe(true);
    expect(check.credits).toBe(2);
    expect(check.tweets[0].link_stripped).toBe(true);
  });

  it('caps a thread at 25 tweets, and at 5 on the trial', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => tweet(`tweet ${i}`));
    expect(checkThread(many(25), threadOptionsFor(basic)).valid).toBe(true);
    expect(checkThread(many(26), threadOptionsFor(basic)).errors[0]).toMatch(/up to 25 tweets/);
    expect(checkThread(many(5), threadOptionsFor(trial)).valid).toBe(true);
    expect(checkThread(many(6), threadOptionsFor(trial)).errors[0]).toMatch(/up to 5 tweets/);
  });

  it('holds tweets to 280 weighted characters, 4,000 on Premium', () => {
    const long = 'a'.repeat(281);
    expect(checkThread([tweet(long)], threadOptionsFor(basic)).tweets[0]).toMatchObject({
      chars: 281,
      limit: 280,
    });
    expect(checkThread([tweet(long)], threadOptionsFor(basic)).valid).toBe(false);
    expect(checkThread([tweet(long)], threadOptionsFor(basic, { premium: true })).valid).toBe(true);
    expect(checkThread([tweet('b'.repeat(4001))], threadOptionsFor(basic, { premium: true })).valid).toBe(false);
  });

  it('counts the way X does (an emoji or CJK character weighs 2)', () => {
    expect(xWeightedLength('🔥')).toBe(2);
    expect(xWeightedLength('漢字')).toBe(4);
    expect(checkThread([tweet('漢'.repeat(141))], threadOptionsFor(basic)).valid).toBe(false);
  });

  it('applies X media rules: 4 pictures, or one video alone', () => {
    const opts = threadOptionsFor(basic);
    expect(checkThread([tweet('p', ['image', 'image', 'image', 'image'])], opts).valid).toBe(true);
    expect(checkThread([tweet('p', ['image', 'image', 'image', 'image', 'image'])], opts).valid).toBe(false);
    expect(checkThread([tweet('v', ['video'])], opts).valid).toBe(true);
    expect(checkThread([tweet('v', ['video', 'image'])], opts).valid).toBe(false);
  });

  it('refuses an empty tweet and an empty thread', () => {
    expect(checkThread([tweet('  ')], threadOptionsFor(basic)).valid).toBe(false);
    expect(checkThread([], threadOptionsFor(basic)).valid).toBe(false);
  });
});

describe('plainTextToPostHtml', () => {
  // What the X provider sends: the editor HTML flattened back to text.
  const asTweet = (html: string) => stripHtmlValidation('normal', html, true, false, false);

  it.each([
    'We shipped today.',
    'a < b & c > d',
    '<b>not bold</b> and "quotes" and \'apostrophes\'',
    'line one\nline two',
  ])('round-trips %j as typed', (text) => {
    expect(asTweet(plainTextToPostHtml(text)).trim()).toBe(text);
  });

  it('never emits markup from the text itself', () => {
    expect(plainTextToPostHtml('<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });
});
