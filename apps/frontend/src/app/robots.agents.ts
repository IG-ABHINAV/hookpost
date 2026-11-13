// Search engines and AI assistants named explicitly. The '*' group already lets
// every one of them in with the same rules; naming them is so nobody reading
// robots.txt (or an audit tool) has to work out that an AI agent is allowed.
//
// The tokens are the ones each vendor documents, checked 26 Oct 2026. An
// invented token matches nothing: this list used to carry 'ClaudeBot-User',
// which no Anthropic agent sends. Anthropic's are ClaudeBot (training),
// Claude-SearchBot (search index) and Claude-User (a person's request).
// OpenAI: GPTBot (training), OAI-SearchBot (ChatGPT search), ChatGPT-User (a
// person's request). Perplexity: PerplexityBot (search), Perplexity-User.
// Google: Google-Extended (Gemini training and grounding; not a Search ranking
// signal), GoogleOther, Google-CloudVertexBot. Apple: Applebot (Siri, Spotlight,
// Safari suggestions), Applebot-Extended (Apple Intelligence training).
// Brave's help page says its crawler follows the Googlebot rules, so
// 'Googlebot' is what admits Brave Search (and through it Claude's web search).
// Our nginx logs also show it fetching robots.txt as 'Bravebot/1.0
// (+https://search.brave.com/help/brave-search-crawler)', so that token is
// named too. robots.spec.ts checks every one of these can read the pages AI
// assistants cite.
export const NAMED_AGENTS = [
  'Googlebot',
  'Google-Extended',
  'GoogleOther',
  'Google-CloudVertexBot',
  'Bingbot',
  'Applebot',
  'Applebot-Extended',
  'DuckDuckBot',
  'DuckAssistBot',
  'Bravebot',
  'Baiduspider',
  'YandexBot',
  'facebookexternalhit',
  'meta-externalagent',
  'Twitterbot',
  'LinkedInBot',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'Claude-Web',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'MistralAI-User',
  'CCBot',
  'Amazonbot',
  'Bytespider',
] as const;
