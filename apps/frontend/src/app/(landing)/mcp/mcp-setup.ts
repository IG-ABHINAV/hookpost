// MCP client setup, shared by /mcp, /guides/claude-code-social-media,
// /guides/claude-mcp-social-media and /social-media-mcp-servers so the four
// pages can never show different commands.
//
// Every value here was checked on SETUP_CHECKED:
// - Endpoints and auth: libraries/nestjs-libraries/src/chat/start.mcp.ts.
//   /api/mcp takes "Authorization: Bearer <key>" (the code strips "Bearer ", so
//   a bare key works too), or "x-hookpost-api-key: <key>" when Authorization is
//   absent (Smithery's gateway reserves Authorization; Authorization wins if
//   both are sent); /api/mcp/<key> takes the key in the path. Both are
//   stateless Streamable HTTP with JSON responses. Live without a key:
//   /api/mcp -> 401 "Missing Authorization header", /api/mcp/<bad key> -> 400
//   "Invalid API Key".
// - Tool names: chat/tools/tool.list.ts. Mastra exposes each tool under its
//   class `name`, so the schedule tool is integrationSchedulePostTool, not the
//   internal id schedulePostTool.
// - Client config formats, from each client's own docs: Claude Code
//   (code.claude.com/docs/en/mcp), Cursor (cursor.com/docs/context/mcp), VS
//   Code (code.visualstudio.com/docs/copilot/reference/mcp-configuration),
//   Gemini CLI (`httpUrl` is Streamable HTTP; `url` would be SSE), Codex
//   (learn.chatgpt.com/docs/extend/mcp: url + bearer_token_env_var), Claude
//   Desktop / claude.ai (support.claude.com 11175166: remote servers are added
//   as custom connectors, not in claude_desktop_config.json).
// - Windsurf: its docs now redirect to docs.devin.ai and name a different
//   config path from the one the app shows, so no path is printed.
//
// - ChatGPT (26 Oct 2026): a custom MCP server at /mcp-oauth with OAuth
//   sign-in (dynamic client registration, PKCE). The whole flow was run against
//   production with the official MCP TypeScript SDK client acting as ChatGPT
//   (its redirect URI, resource, form-encoded token request), then initialize,
//   tools/list and a tool call; not yet inside a ChatGPT account. Steps from
//   OpenAI's docs (developers.openai.com/apps-sdk/deploy/connect-chatgpt:
//   Plugins, +, "Add custom MCP server"; the older Settings > Apps & Connectors
//   > Advanced > Developer mode path). Which ChatGPT plans may add one is
//   OpenAI's call and still rolling out; Free cannot.
//
// - Claude (7 Nov 2026): /mcp-oauth-claude, the endpoint Claude's connectors
//   use (same OAuth server as /mcp-oauth; it leaves out the AI media tools,
//   which Claude's directory does not accept). On 27 Oct 15 claude.ai visitors
//   registered and started sign-in through it; chatgpt-connector.int.spec
//   covers a token on it. /mcp now leads with these two URLs, since they need
//   no API key and any workspace may use them (mcp.plan.gate.ts refuses only
//   needs_trial and locked, and since 4 Nov a workspace without a plan is on
//   its free posts).
//
// Not advertised on purpose:
// - The ChatGPT apps directory: not submitted (needs OpenAI's domain check,
//   OPENAI_APP_CHALLANGE, and the owner's verified OpenAI organization).
// - hookpost-mcp (the stdio package in mcp-server/) is not on npm.
import { FREE_POSTS, offer } from '../trial-offer';

export const SETUP_CHECKED = '7 November 2026';

export const MCP_URL = 'https://hookpost.hookstep.in/api/mcp';
/** The OAuth endpoint ChatGPT connects to (no API key: the user signs in). */
export const CHATGPT_MCP_URL = 'https://hookpost.hookstep.in/mcp-oauth';
/** The OAuth endpoint for a Claude custom connector (no API key either). */
export const CLAUDE_MCP_URL = 'https://hookpost.hookstep.in/mcp-oauth-claude';

/**
 * Who may use the OAuth connectors (Claude, ChatGPT) on the Hookpost side.
 * They need no API key, so no plan to connect; posting is held to the free
 * posts (posts.service assertFreePostAllowed, drafts included) until a plan.
 * Without the cutoff (no free-posts build) the Free plan exists and is not
 * refused either.
 */
export const OAUTH_PLAN_NOTE = offer(
  'The connector works on every Hookpost plan, the Free plan included.',
  `Any Hookpost workspace can connect. Without a plan it gets ${FREE_POSTS} (drafts count too), then the Hookpost plan.`
);

/** Who gets an API key: plans with public_api (pricing.ts), the Hookpost plan. */
export const API_KEY_PLAN_NOTE =
  'Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI and the hookpost CLI use an API key, which comes with the Hookpost plan.';

/** Adding Hookpost in ChatGPT, as OpenAI's docs give the steps (see top). */
export const CHATGPT_STEPS: readonly string[] = [
  'In ChatGPT, open Plugins, press +, then Add custom MCP server. (If your account still has the older menu: Settings → Apps & Connectors → Advanced → turn on Developer mode, then Create.)',
  `Name it Hookpost, set the server URL to ${CHATGPT_MCP_URL} and the authentication to OAuth. Leave the client ID and secret empty: ChatGPT registers itself.`,
  'Accept ChatGPT’s warning about custom servers and create it. ChatGPT opens Hookpost: sign in and press Authorize.',
  'Ask ChatGPT to list your Hookpost channels, then to save a draft. It asks before anything that writes.',
];

/** Who can use it, on each side, stated wherever the ChatGPT steps are. */
/** What ChatGPT itself allows, the OpenAI side of the plan note. */
export const CHATGPT_SIDE_NOTE =
  'On the ChatGPT side, OpenAI decides which plans can add a custom MCP server and whether they may use write actions such as scheduling: not ChatGPT Free, and on Business, Enterprise and Edu an admin may have to allow it.';

/** Both sides, as the ChatGPT guide states it. */
export const CHATGPT_PLAN_NOTE = `On the Hookpost side: ${OAUTH_PLAN_NOTE} ${CHATGPT_SIDE_NOTE}`;

/** What was and was not tested, said once next to the steps. */
export const CHATGPT_TESTED =
  'Checked on 26 October 2026 with a scripted client that follows OpenAI’s connector flow end to end (sign-in, Authorize, tools). Not yet run inside a ChatGPT account.';
export const MCP_URL_WITH_KEY = 'https://hookpost.hookstep.in/api/mcp/YOUR_API_KEY';

export const CLAUDE_CODE_CMD = `claude mcp add --transport http hookpost ${MCP_URL} \\
  --header "Authorization: Bearer YOUR_API_KEY"`;

// Same server, written to .mcp.json in the project so everyone who clones the
// repo gets it. Claude Code expands ${VAR} in the url and headers of
// .mcp.json, so the key itself stays out of git. Single quotes, so the shell
// writes the variable name into the file instead of the key.
export const CLAUDE_CODE_PROJECT_CMD = `claude mcp add --transport http hookpost ${MCP_URL} \\
  --scope project \\
  --header 'Authorization: Bearer \${HOOKPOST_API_KEY}'`;

export const CLAUDE_CODE_PROJECT_JSON = `{
  "mcpServers": {
    "hookpost": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer \${HOOKPOST_API_KEY}" }
    }
  }
}`;

export const CLAUDE_DESKTOP_REMOTE_JSON = `{
  "mcpServers": {
    "hookpost": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL_WITH_KEY}"]
    }
  }
}`;

export const CURSOR_JSON = `{
  "mcpServers": {
    "hookpost": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`;

export const VSCODE_JSON = `{
  "servers": {
    "hookpost": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`;

export const WINDSURF_JSON = `{
  "mcpServers": {
    "hookpost": {
      "serverUrl": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`;

export const CODEX_TOML = `# ~/.codex/config.toml
[mcp_servers.hookpost]
url = "${MCP_URL}"
bearer_token_env_var = "HOOKPOST_API_KEY"`;

export const GEMINI_JSON = `{
  "mcpServers": {
    "hookpost": {
      "httpUrl": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`;

/** The tools an MCP client sees, in the order tool.list.ts registers them. */
export const MCP_TOOLS: { name: string; does: string; input: string }[] = [
  { name: 'integrationList', does: 'Lists your connected channels, optionally for one customer group.', input: 'group?' },
  { name: 'groupList', does: 'Lists your customer groups.', input: 'none' },
  { name: 'integrationSchema', does: "Returns a network's rules, character limit and the settings a post needs.", input: 'platform, isPremium' },
  { name: 'triggerTool', does: 'Calls a channel helper, for example to fetch your Pinterest boards.', input: 'integrationId, methodName, dataSchema' },
  { name: 'integrationSchedulePostTool', does: 'Creates posts on one or more channels: as a draft, scheduled for a time, or published now.', input: 'socialPost[]' },
  { name: 'postsListTool', does: 'Lists posts between two dates with their state (queued, draft, published or error).', input: 'startDate, endDate, customer?, includeAttachments?' },
  { name: 'postSettingsTool', does: 'Changes the network settings of a post that has not gone out yet. Text and date stay as they are.', input: 'id, settings[]' },
  { name: 'uploadFromUrlTool', does: 'Imports an image or video from a public URL into your media library (images up to 10 MB, video up to 1 GB).', input: 'url' },
  { name: 'generateImageTool', does: "Generates an AI image for a post. Uses the plan's AI image allowance.", input: 'prompt' },
  { name: 'generateVideoOptions', does: 'Lists the AI video types.', input: 'none' },
  { name: 'videoFunctionTool', does: 'Helper lookups for AI video generation.', input: 'varies' },
  { name: 'generateVideoTool', does: 'Generates an AI video. No plan on sale includes video credits today.', input: 'varies' },
];

/** What the MCP tools cannot do, stated wherever the tools are listed. */
export const MCP_CANNOT =
  'There is no delete tool, and no tool edits the text or date of an existing post, reads analytics or connects a new channel. Do those in the app.';
