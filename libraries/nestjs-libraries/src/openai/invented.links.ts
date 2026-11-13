// Generated posts must not invent links, domains or facts. On 26 Oct 2026 a
// live generator run wrote "hookpost.com" into a post; nobody had given it
// that domain (Hookpost lives at hookpost.hookstep.in). The rule below goes
// into every system prompt that writes post text, and stripInventedLinks is
// the check after it.
//
// Posts often go out without anyone reading them (auto-post makes them with
// no human at all), so the guard never leaves a placeholder: an invented link
// is swapped for a real one when there is one (the user's request, the
// workspace's own links, the feed item), and is otherwise taken out together
// with its "Visit"/"Link:" lead-in, so the sentence still reads.

export const NO_INVENTED_FACTS_RULE =
  'Never invent links, domains, email addresses, prices, statistics or brand names. ' +
  "Only use URLs the user gave or that appear in the provided sources/settings; if none, don't include a link. " +
  'Never write a placeholder such as [link] or [email]. ' +
  'Only state prices, numbers and names that appear in what you were given.';

// Bare domains (no scheme, no www.) only count on these endings, so "Node.js",
// "e.g." or "v3.5" are never taken for links. Links with a scheme or "www."
// are always caught, whatever their ending.
const BARE_TLDS = [
  'com', 'net', 'org', 'io', 'ai', 'co', 'in', 'app', 'dev', 'xyz', 'info',
  'biz', 'us', 'uk', 'ly', 'gg', 'tv', 'me', 'so', 'to', 'site', 'online',
  'store', 'shop', 'tech', 'page', 'link', 'blog', 'news', 'cloud', 'live',
  'tools', 'social', 'media', 'agency', 'studio', 'design', 'club', 'pro',
  'edu', 'gov', 'au', 'ca', 'de', 'fr', 'es', 'it', 'nl', 'sg', 'ae', 'id',
  'be', 'gl', 'ch', 'se', 'eu',
];

// Product names that look like bare domains.
const NOT_LINKS = new Set(['asp.net', 'vb.net', 'ado.net', 'socket.io']);

// Profile hosts: a made-up profile there is not swapped for the workspace's
// website ("Follow us on instagram.com/x" must not become "Follow us on
// acme.in"); it is swapped only for a given link on the same host.
const PROFILE_HOSTS = [
  'x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'fb.com',
  'linkedin.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'threads.net',
  'pinterest.com', 'reddit.com', 't.me', 'wa.me', 'discord.gg', 'discord.com',
  'github.com', 'medium.com', 'bsky.app', 'mastodon.social',
];

// URL characters: printable ASCII except quotes, angle brackets and backslash
// (JSON escapes), so an emoji or Hindi word right after a link is not eaten.
const URL_CHARS = String.raw`[^\s<>"'\x60\\\u0080-\uffff]`;
const PATH = String.raw`(?:/${URL_CHARS}*)?`;
const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
// ASCII only: Hindi, emoji and other scripts never match.
const LINK_SRC = [
  // an email address, before its domain can be taken as a link
  String.raw`(?<![\w.+-])[a-z0-9._%+-]+@(?:${LABEL}\.)+[a-z]{2,24}(?![a-z0-9-])`,
  // scheme or www.
  String.raw`(?<![\w@/-])(?:https?://|www\.)${URL_CHARS}+`,
  // bare domain on a known ending, optional path
  String.raw`(?<![\w.@/-])(?:${LABEL}\.)+(?:${BARE_TLDS.join('|')})(?![a-z0-9-])${PATH}`,
].join('|');
const LINK_RE = new RegExp(LINK_SRC, 'gi');

// Placeholders a model writes instead of a link: [link], [Insert URL here],
// [your website], [Link to sign-up page], <link>, {{email}}. Never left in a post.
const PLACEHOLDER_WORDS = String.raw`(?:link|url|website|web site|email|e-mail)`;
const PLACEHOLDER_SRC = [
  String.raw`\[[^\]\n]{0,25}\b${PLACEHOLDER_WORDS}\b[^\]\n]{0,30}\]`,
  String.raw`<${PLACEHOLDER_WORDS}>`,
  String.raw`\{\{?${PLACEHOLDER_WORDS}\}?\}`,
].join('|');
const PLACEHOLDER_ONLY = new RegExp(`^(?:${PLACEHOLDER_SRC})$`, 'i');
const GUARDED_RE = new RegExp(`${PLACEHOLDER_SRC}|${LINK_SRC}`, 'gi');

const TRAILING = /[.,;:!?)\]}*_'"’”]+$/;

/** host + path, lower case, without scheme, "www.", "mailto:" or a trailing slash. */
export function normalizeLink(link: string): string {
  return link
    .trim()
    .replace(TRAILING, '')
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#]+$/, '');
}

const hostOf = (normalized: string) => normalized.split(/[/?#]/)[0];
// "a@b.com" is an email; "tiktok.com/@brand" is a link.
const isEmail = (normalized: string) => hostOf(normalized).includes('@');
const isProfileHost = (host: string) =>
  PROFILE_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));

/** Every link and email address in a text, as written (trailing punctuation trimmed). */
export function findLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const link = match[0].replace(TRAILING, '');
    if (link) out.push(link);
  }
  return out;
}

/** The distinct links and email addresses in some texts, in order, as written. */
export function linksIn(texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const link of findLinks(text)) {
      const normalized = normalizeLink(link);
      if (seen.has(normalized) || NOT_LINKS.has(normalized)) continue;
      seen.add(normalized);
      out.push(link);
    }
  }
  return out;
}

export type LinkGuardOptions = {
  /**
   * Texts whose links may stand in for an invented one, best first: the
   * user's request, the workspace's links, the feed item's URL. Their links
   * also count as given.
   */
  preferred?: Array<string | null | undefined>;
};

export type LinkGuardResult = {
  text: string;
  /** Invented links and placeholders, as written. Empty when nothing changed. */
  removed: string[];
  /** Of those, the ones swapped for a real link: invented -> real. */
  replaced: Array<{ from: string; to: string }>;
};

/**
 * Checks every link, email address and link placeholder in `text` against
 * `sources` (what the model was given: the user's request, website text,
 * research results) and `options.preferred`. A link that was given is kept,
 * whether written with or without "https://", "www." or a trailing slash, and
 * so is the bare domain of a link that was given. Anything else is invented
 * (a new path on a given domain too: the page may not exist), and is
 *  - swapped for a given link on the same host, else
 *  - swapped for the first preferred link (emails: preferred email), unless
 *    that one is already in the post or the invented link is a profile on a
 *    social network, else
 *  - removed, with the words that only introduced it ("Link:", "Visit",
 *    "Learn more at", an arrow), so no placeholder or stray punctuation is
 *    left.
 */
export function stripInventedLinks(
  text: string,
  sources: Array<string | null | undefined>,
  options: LinkGuardOptions = {}
): LinkGuardResult {
  if (!text) return { text, removed: [], replaced: [] };

  const preferred = options.preferred || [];
  const allowed = new Set<string>();
  const allowedHosts = new Set<string>();
  const given = linksIn([...preferred, ...sources]);
  for (const link of given) {
    const normalized = normalizeLink(link);
    allowed.add(normalized);
    if (!isEmail(normalized)) allowedHosts.add(hostOf(normalized));
  }
  const preferredLinks = linksIn(preferred);

  const isKept = (normalized: string) =>
    allowed.has(normalized) ||
    NOT_LINKS.has(normalized) ||
    (normalized === hostOf(normalized) && allowedHosts.has(normalized));

  // What the post already links to, so a stand-in never repeats it.
  const inPost = new Set<string>();
  const remember = (normalized: string) =>
    inPost.add(isEmail(normalized) ? normalized : hostOf(normalized));
  for (const link of findLinks(text)) {
    const normalized = normalizeLink(link);
    if (isKept(normalized)) remember(normalized);
  }
  const usable = (candidate: string) => {
    const normalized = normalizeLink(candidate);
    return !inPost.has(isEmail(normalized) ? normalized : hostOf(normalized));
  };

  const standIn = (normalized: string | null, email: boolean) => {
    if (email) {
      return preferredLinks.find((l) => isEmail(normalizeLink(l)) && usable(l));
    }
    if (normalized) {
      const host = hostOf(normalized);
      const sameHost = given.find(
        (l) => !isEmail(normalizeLink(l)) && hostOf(normalizeLink(l)) === host
      );
      if (sameHost) return usable(sameHost) ? sameHost : undefined;
      if (isProfileHost(host)) return undefined;
    }
    return preferredLinks.find((l) => !isEmail(normalizeLink(l)) && usable(l));
  };

  const removed: string[] = [];
  const replaced: LinkGuardResult['replaced'] = [];
  let dropped = false;
  const marked = text.replace(GUARDED_RE, (match) => {
    const placeholder = PLACEHOLDER_ONLY.test(match);
    const trailing = placeholder ? '' : match.match(TRAILING)?.[0] || '';
    const link = trailing ? match.slice(0, -trailing.length) : match;
    if (!link) return match;
    const normalized = placeholder ? null : normalizeLink(link);
    if (normalized && isKept(normalized)) return match;

    removed.push(link);
    const email = normalized ? isEmail(normalized) : /mail/i.test(link);
    const real = standIn(normalized, email);
    if (real) {
      remember(normalizeLink(real));
      replaced.push({ from: link, to: real });
      return real + trailing;
    }
    dropped = true;
    return CUT + trailing;
  });

  return {
    text: dropped ? tidy(marked) : marked,
    removed,
    replaced,
  };
}

// ---------------------------------------------------------------------------
// Taking a link out of a sentence. CUT marks where it was; each line holding
// one is rewritten, every other line is left exactly as it was.

const CUT = '\u0000';

// Before a link: spaces, a colon or dash, an arrow or pointing emoji, an
// opening bracket, a comma or ampersand, and the little words that only lead
// to it ("at", "or": "Visit acme.in or <link>" keeps "Visit acme.in").
const LEAD_IN =
  /(?:\s+|[:：=>|([,&/\-–—→⇒➜➔➡▶►⬇↓⤵👉👇🔗🌐📍✉📧📩📨📲]\uFE0F?|(?<![\p{L}\p{N}])(?:at|on|via|from|to|here|or|and)|(?<![\p{L}\p{N}])पर)$/iu;

// A verb left with nothing to act on: "Read <real link> or try <link>".
const DANGLING_VERB =
  /(?:(?<![\p{L}\p{N}])(?:or|and|then)\s+)?(?<![\p{L}\p{N}])(?:try|visit|see|check out|read|use|download|get|grab|explore|watch|follow|join|contact|email|call|dm|message)(?:\s+(?:it|us|them|out))?$/iu;

// A clause that only introduces a link, and means nothing without it.
const LABELS = [
  '(?:(?:the|our|my|full|official) )*(?:link|links|url|website|web site|site|homepage|home page|landing page|page|blog|source|sources|details|info|more info|information|article|story|full story|guide|report|docs|documentation|pricing|demo|newsletter|podcast|portfolio|case study|tickets|waitlist|playlist|episode)(?: (?:below|here))?',
  '(?:learn|read|see|find out|know|discover|get|view|watch|explore)(?: (?:the|our|full|more|story|article|post|details|info|guide|report|thread|video|here|now|all|it|about it))*',
  'more(?: (?:info|information|details|here))?',
  '(?:visit|check|check out|head|head over|go|click|tap|open|browse|hop over|swing by|stop by)(?: (?:us|it|this|them|out|over|now|here|today|our (?:site|website|page|store|shop|blog)|the (?:link|site|website|page)))*',
  '(?:find|follow|reach|contact|email|e-mail|mail|message|write|write to|dm|ping|connect with)(?: (?:us|me|them|to us|to me|with us|online|anytime|today|now|here))*',
  '(?:click|tap) here|here|this link|link below|link here',
  '(?:get in touch|say hi|say hello|drop (?:us|me) (?:a )?(?:line|note|message|mail|email))',
  'लिंक|वेबसाइट|ईमेल|यहाँ|यहां|यहाँ क्लिक करें|यहां क्लिक करें|और जानें|विज़िट करें|देखें',
].map((l) => l.replace(/ /g, String.raw`\s+`));
const EDGE = String.raw`[\s\p{P}\p{S}\p{Cf}\uFE0F]*`;
const LABEL_RE = new RegExp(
  `^${EDGE}(?:(?:please|just)\\s+)?(?:${LABELS.join('|')})${EDGE}$`,
  'iu'
);

// "Questions?" left alone at the end of a line once its "Email us at ..." went.
const LEFT_HANGING =
  /(?:^|(?<=[.!?।…]\s))[\s\p{S}]*(?:(?:any|got|have) )?(?:questions|need help|need more info(?:rmation)?|want to (?:know|learn) more|interested|curious|want in)\s*\?[\s\p{S}]*$/iu;

const SENTENCE_END = /[.!?।…]+(?=\s|$)/gu;
const CLAUSE_END = /[.!?।…]+(?=\s|$)|[,;:](?=\s|$)|\s[-–—](?=\s)|[–—(]/gu;
const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);

function endOfLast(text: string, re: RegExp) {
  let end = 0;
  for (const m of text.matchAll(re)) end = m.index! + m[0].length;
  // the spaces after the boundary belong to the next clause's start
  while (end < text.length && /\s/.test(text[end])) end++;
  return end;
}

function join(a: string, b: string) {
  a = a.replace(/[ \t]+$/, '');
  b = b.replace(/^[ \t]+/, '');
  if (!a || !b) return a + b;
  return /^[.,!?;:।…)\]}'"’”]/u.test(b) ? a + b : `${a} ${b}`;
}

function cutOne(line: string): string {
  const at = line.indexOf(CUT);
  let left = line.slice(0, at);
  let right = line.slice(at + 1);

  let bracket = false;
  for (let m = left.match(LEAD_IN); m && m[0]; m = left.match(LEAD_IN)) {
    if (/[([]/.test(m[0])) bracket = true;
    left = left.slice(0, -m[0].length);
  }
  if (bracket) right = right.replace(/^\s*[)\]]/, '');
  left = left.replace(DANGLING_VERB, '').replace(/[\s,&]+$/, '');

  const sentenceStart = endOfLast(left, SENTENCE_END);
  const clauseStart = Math.max(endOfLast(left, CLAUSE_END), sentenceStart);
  const clause = left.slice(clauseStart);
  if (hasContent(clause) && !LABEL_RE.test(clause)) {
    // "Sign up at <link> today!" -> "Sign up today!"
    return join(left, right);
  }

  // The clause only led to the link: it goes, and so does the rest of the
  // sentence after the link ("Visit <link> to get started." has nothing
  // left to say).
  const stop = right.search(/[.!?।…]+(?=\s|$)|$/u);
  if (findLinks(right.slice(0, stop)).length) {
    // a real link follows in the same sentence: keep it ("Visit <link> or
    // acme.in" -> "Visit acme.in")
    return join(left, right.replace(/^\s*(?:or|and|,|\/|\|)\s+/i, ''));
  }
  const after = right.slice(stop);
  const before = left.slice(0, clauseStart);
  if (hasContent(before.slice(sentenceStart))) {
    // "It's live, check it out at <link>!" -> "It's live!"
    return join(before.replace(/[\s,;:\-–—(]+$/u, ''), after);
  }
  // The whole sentence was about the link.
  const rest = after.replace(/^[.!?।…]+\s*/u, '');
  const head = left.slice(0, sentenceStart);
  if (!hasContent(rest) && LEFT_HANGING.test(head)) {
    return join(head.replace(LEFT_HANGING, ''), rest);
  }
  return join(head, rest);
}

function tidy(text: string): string {
  const out: string[] = [];
  // Set once a line is taken out, until the next line with words: the blank
  // lines around a removed one must not double up (or lead or trail the post).
  let afterRemoved = false;
  for (let line of text.split('\n')) {
    if (line.includes(CUT)) {
      while (line.includes(CUT)) line = cutOne(line);
      line = line.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
      if (!hasContent(line)) {
        afterRemoved = true;
        continue;
      }
    }
    const blank = !line.trim();
    if (blank && afterRemoved && (!out.length || !out[out.length - 1].trim())) {
      continue;
    }
    if (!blank) afterRemoved = false;
    out.push(line);
  }
  if (afterRemoved) while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/** Anything the model was given, as text a link can be found in. */
export function sourceText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
