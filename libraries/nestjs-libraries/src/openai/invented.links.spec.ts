// The link guard for generated posts (invented.links.ts).
//   pnpm exec jest -c apps/backend/jest.config.ts invented.links
//
// Posts can go out without anyone reading them, so no case may leave a
// placeholder ([link], [email]) or a dangling "Visit"/"Link:" behind.

import {
  findLinks,
  linksIn,
  NO_INVENTED_FACTS_RULE,
  sourceText,
  stripInventedLinks,
} from '@hookpost/nestjs-libraries/openai/invented.links';

const PLACEHOLDER = /\[(?:link|email|url)\]|<link>|\{\{?link\}?\}/i;

describe('stripInventedLinks: real links are kept', () => {
  it('keeps a URL that was in the input', () => {
    const input = 'Launching our app today, sign up at https://hookpost.hookstep.in/pricing';
    const post = 'We are live!\nSign up at https://hookpost.hookstep.in/pricing.';
    expect(stripInventedLinks(post, [input])).toEqual({
      text: post,
      removed: [],
      replaced: [],
    });
  });

  it('keeps a given link written differently (no scheme, www, trailing slash, case)', () => {
    const input = 'Read more at https://www.Example.org/blog/launch/';
    for (const post of [
      'More: example.org/blog/launch',
      'More: www.example.org/blog/launch',
      'More: https://example.org/blog/launch/',
      'More: EXAMPLE.ORG', // the bare domain of a given link
    ]) {
      expect(stripInventedLinks(post, [input]).removed).toEqual([]);
    }
  });

  it('keeps links from research results (JSON tool output)', () => {
    const research = sourceText([
      { content: '{"results":[{"url":"https://blog.example.com/ai-trends-2026","title":"AI"}]}' },
    ]);
    const post = 'Source: https://blog.example.com/ai-trends-2026';
    expect(stripInventedLinks(post, ['ai trends', research]).removed).toEqual([]);
  });

  it('keeps a link or email that is only in the preferred texts (workspace settings)', () => {
    const post = 'Book a demo at acme.in or write to team@acme.in';
    expect(
      stripInventedLinks(post, ['write a post'], { preferred: ['<p>acme.in | team@acme.in</p>'] })
    ).toEqual({ text: post, removed: [], replaced: [] });
  });

  it('a given email is kept', () => {
    expect(
      stripInventedLinks('Questions? support@hookstep.in', ['Mail support@hookstep.in']).text
    ).toBe('Questions? support@hookstep.in');
  });
});

describe('stripInventedLinks: an invented link becomes a real one when there is one', () => {
  it('the workspace website replaces an invented domain (the 26 Oct hookpost.com post)', () => {
    const post = 'Plan a month of posts in one sitting.\nTry it free at hookpost.com today!';
    expect(
      stripInventedLinks(post, ['Write about our scheduler'], {
        preferred: ['https://hookpost.hookstep.in'],
      })
    ).toEqual({
      text: 'Plan a month of posts in one sitting.\nTry it free at https://hookpost.hookstep.in today!',
      removed: ['hookpost.com'],
      replaced: [{ from: 'hookpost.com', to: 'https://hookpost.hookstep.in' }],
    });
  });

  it('a link from the user request comes before the workspace website', () => {
    const request = 'Announce the webinar, register at https://acme.in/webinar';
    const { text } = stripInventedLinks('Save your seat: acme-events.com/register', [request], {
      preferred: [request, 'acme.in'],
    });
    expect(text).toBe('Save your seat: https://acme.in/webinar');
  });

  it('an invented email becomes the workspace email', () => {
    const { text, replaced } = stripInventedLinks('Questions? Email hello@hookpost.com', ['x'], {
      preferred: ['<p>Reach us: team@acme.in</p>'],
    });
    expect(text).toBe('Questions? Email team@acme.in');
    expect(replaced).toEqual([{ from: 'hello@hookpost.com', to: 'team@acme.in' }]);
  });

  it('a new path on a given domain becomes the given link on that domain', () => {
    const { text } = stripInventedLinks('See hookpost.hookstep.in/free-forever', [
      'Our site is hookpost.hookstep.in',
    ]);
    expect(text).toBe('See hookpost.hookstep.in');
  });

  it('a placeholder the model wrote itself is filled in too', () => {
    for (const ph of ['[link]', '[Link]', '[Insert link here]', '[your website URL]', '<link>', '{{link}}']) {
      expect(
        stripInventedLinks(`Sign up at ${ph} today! 🚀`, ['x'], { preferred: ['acme.in'] }).text
      ).toBe('Sign up at acme.in today! 🚀');
    }
  });

  it('the real link is used once: a second invented link is removed, not repeated', () => {
    const { text } = stripInventedLinks('Sign up at hookpost.com. More at hookpost.io!', ['x'], {
      preferred: ['acme.in'],
    });
    expect(text).toBe('Sign up at acme.in.');
  });

  it('is not used when the post links to that site already', () => {
    const { text } = stripInventedLinks('Visit acme.in or hookpost.com for more.', ['acme.in'], {
      preferred: ['acme.in'],
    });
    expect(text).toBe('Visit acme.in for more.');
  });

  it('a made-up social profile is not swapped for the website', () => {
    const { text } = stripInventedLinks(
      'Launch week is here 🎉\nFollow us on instagram.com/hookpost_official',
      ['x'],
      { preferred: ['acme.in'] }
    );
    expect(text).toBe('Launch week is here 🎉');
  });
});

describe('stripInventedLinks: with no real link, the invented one is removed cleanly', () => {
  const clean = (post: string, sources: string[] = ['nothing given']) =>
    stripInventedLinks(post, sources);

  it.each([
    // [what the model wrote, what goes out]
    ['Plan a month of posts in one sitting.\nTry it free at hookpost.com today!', 'Plan a month of posts in one sitting.\nTry it free today!'],
    ['Big launch! 🚀\nLink: https://hookpost.com/signup', 'Big launch! 🚀'],
    ['Our new feature is live, check it out at acme.io!', 'Our new feature is live!'],
    ['Visit hookpost.com to get started.\nSee you there 🙌', 'See you there 🙌'],
    ['Try Hookpost (hookpost.com) free for 7 days.', 'Try Hookpost free for 7 days.'],
    ['Sign up at [link] today! 🚀', 'Sign up today! 🚀'],
    ['We are live 🎉\n👉 https://www.hookpost.io', 'We are live 🎉'],
    ['Learn more at hookpost.com/blog.\nThanks for reading!', 'Thanks for reading!'],
    ['Big news. Read the full story: https://news.example.net/x. Share it!', 'Big news. Share it!'],
    ['hookpost.com makes scheduling easy.\nTry it.', 'Try it.'],
    ['Built for creators. Questions? Email hello@hookpost.com', 'Built for creators.'],
    ['New post is up!\n\nhttps://hookpost.com/p/1\n\nTell me what you think.', 'New post is up!\n\nTell me what you think.'],
    ['Visit https://hookpost.com/signup?ref=x. Or www.hookpost.io!', ''],
  ])('%j', (post, expected) => {
    const { text, removed } = clean(post);
    expect(text).toBe(expected);
    expect(removed.length).toBeGreaterThan(0);
    expect(text).not.toMatch(PLACEHOLDER);
    // nothing dangling: no space before punctuation, no doubled spaces or
    // punctuation, no line ending in a lead-in
    expect(text).not.toMatch(/ [.,!?;:]|  |[.,;:]{2}|,\s*[.!?]|(?:at|Link|Visit|:)\s*$/m);
  });

  it('an invented email address is removed, not replaced by [email]', () => {
    const { text, removed, replaced } = clean('Built for teams.\nWrite to us at hello@hookpost.com!');
    expect(text).toBe('Built for teams.');
    expect(removed).toEqual(['hello@hookpost.com']);
    expect(replaced).toEqual([]);
  });

  it('a bare domain inside a given email is not a given link', () => {
    expect(clean('Proudly made in Punjab.\nVisit hookstep.in', ['Mail support@hookstep.in']).text).toBe(
      'Proudly made in Punjab.'
    );
  });

  it('a profile path with @ is a link, not an email; short-link domains are caught', () => {
    expect(clean('Our new reel is out.\nWatch youtu.be/abc and tiktok.com/@brand').text).toBe(
      'Our new reel is out.'
    );
    expect(
      stripInventedLinks('Find us on tiktok.com', ['Our page: https://tiktok.com/@brand']).removed
    ).toEqual([]);
  });

  it('lines without a removed link are left exactly as they were', () => {
    const post = 'Line  with   spaces , kept.\n\n\nAnother line\nVisit hookpost.com';
    expect(clean(post).text).toBe('Line  with   spaces , kept.\n\n\nAnother line');
  });
});

describe('stripInventedLinks: Hindi and emoji', () => {
  it('leaves Hindi and emoji text untouched when there is no link', () => {
    const hindi = 'आज से हमारा नया फीचर लाइव है 🚀\nअभी आज़माएं 👉 और दोस्तों को बताएं। धन्यवाद 🙏';
    expect(stripInventedLinks(hindi, ['नया फीचर'])).toEqual({ text: hindi, removed: [], replaced: [] });
  });

  it('removes an invented link next to Hindi and emoji, keeping both', () => {
    const mixed = 'अभी जुड़ें hookpost.com। 🚀 https://example.org/x🎉';
    expect(stripInventedLinks(mixed, ['https://example.org/x']).text).toBe(
      'अभी जुड़ें। 🚀 https://example.org/x🎉'
    );
    expect(
      stripInventedLinks('आज से हमारा नया फीचर लाइव है 🚀\n👉 hookpost.com\nधन्यवाद 🙏', ['x']).text
    ).toBe('आज से हमारा नया फीचर लाइव है 🚀\nधन्यवाद 🙏');
    expect(stripInventedLinks('नया फीचर लाइव है ✨\nलिंक: hookpost.com', ['x']).text).toBe(
      'नया फीचर लाइव है ✨'
    );
  });

  it('swaps in the real link inside Hindi text', () => {
    expect(
      stripInventedLinks('अभी जुड़ें hookpost.com 🚀', ['x'], { preferred: ['https://acme.in'] }).text
    ).toBe('अभी जुड़ें https://acme.in 🚀');
  });
});

describe('stripInventedLinks: ordinary text', () => {
  it('does not take ordinary text for links', () => {
    const text =
      'Built with Node.js and Next.js, e.g. v3.5 is 2.5x faster. U.S. teams love it... Mr.Smith agrees.';
    expect(findLinks(text)).toEqual([]);
    expect(stripInventedLinks(text, []).text).toBe(text);
  });

  it('leaves product names like ASP.NET and Socket.IO alone', () => {
    const text = 'Built on ASP.NET and Socket.IO.';
    expect(stripInventedLinks(text, []).text).toBe(text);
  });

  it('leaves square brackets that are not link placeholders alone', () => {
    const text = 'Step [1] done. [Update] More soon.';
    expect(stripInventedLinks(text, []).text).toBe(text);
  });

  it('handles empty text and missing sources', () => {
    expect(stripInventedLinks('', ['x'])).toEqual({ text: '', removed: [], replaced: [] });
    expect(stripInventedLinks('Big news!\ngo to x.com', [null, undefined]).text).toBe('Big news!');
  });
});

describe('linksIn', () => {
  it('lists distinct links and emails in order, from HTML too', () => {
    expect(
      linksIn([
        '<p>Visit <a href="https://acme.in">acme.in</a> or mail team@acme.in</p>',
        null,
        'https://acme.in/ and ASP.NET',
      ])
    ).toEqual(['https://acme.in', 'team@acme.in']);
  });
});

describe('NO_INVENTED_FACTS_RULE', () => {
  it('says to use only given links and to leave the link out otherwise', () => {
    expect(NO_INVENTED_FACTS_RULE).toMatch(/never invent links, domains/i);
    expect(NO_INVENTED_FACTS_RULE).toMatch(/prices, statistics or brand names/);
    expect(NO_INVENTED_FACTS_RULE).toContain(
      "Only use URLs the user gave or that appear in the provided sources/settings; if none, don't include a link."
    );
    expect(NO_INVENTED_FACTS_RULE).toMatch(/never write a placeholder/i);
    expect(NO_INVENTED_FACTS_RULE).not.toMatch(/as a placeholder/);
    // it is interpolated into ChatPromptTemplate templates, where { } are variables
    expect(NO_INVENTED_FACTS_RULE).not.toMatch(/[{}]/);
  });
});
