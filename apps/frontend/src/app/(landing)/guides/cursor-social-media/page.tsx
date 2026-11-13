import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { MCP_TOOLS } from '../../mcp/mcp-setup';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, C, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import {
  ANSWER,
  CANONICAL,
  CLIENT_TABLE,
  CLIENT_TABLE_HEAD,
  CURSOR_ENV_JSON,
  CURSOR_JSON,
  DESCRIPTION,
  FAQ,
  FIRST_PROMPT,
  H1,
  MCP_CANNOT,
  RELATED,
  STEPS,
  UPDATED,
  VSCODE_JSON,
  WINDSURF_JSON,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Schedule Social Media Posts from Cursor (MCP) | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function CursorSocialMediaGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'Cursor, VS Code, Windsurf',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to schedule social media posts from Cursor with Hookpost',
    about: ['Cursor', 'Visual Studio Code', 'Model Context Protocol'],
  });

  return (
    <AnswerLayout crumb="Cursor, VS Code, Windsurf" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="Set it up in four steps" id="steps">
        <Steps steps={STEPS} />
      </Section>

      <Section title="Cursor" id="cursor">
        <P>
          Paste this into <C>~/.cursor/mcp.json</C> (every project) or <C>.cursor/mcp.json</C> (this project), with your own key in
          place of <C>YOUR_API_KEY</C>:
        </P>
        <Code label="~/.cursor/mcp.json">{CURSOR_JSON}</Code>
        <P>
          To commit the file without the key, let Cursor read it from your environment. Cursor resolves <C>{'${env:NAME}'}</C> in{' '}
          <C>url</C> and <C>headers</C>:
        </P>
        <Code label=".cursor/mcp.json (safe to commit)">{CURSOR_ENV_JSON}</Code>
      </Section>

      <Section title="VS Code and Windsurf" id="vscode">
        <P>
          VS Code reads <C>.vscode/mcp.json</C> in your workspace. Open Copilot Chat in Agent mode to use the tools. VS Code tries
          Streamable HTTP first and falls back to SSE.
        </P>
        <Code label=".vscode/mcp.json">{VSCODE_JSON}</Code>
        <P>
          Windsurf uses the same shape as Cursor, except the URL field is <C>serverUrl</C>. Add it from Windsurf&apos;s MCP settings,
          which open its <C>mcp_config.json</C>:
        </P>
        <Code label="mcp_config.json">{WINDSURF_JSON}</Code>
        <CompareTable
          caption="MCP config format for Cursor, VS Code and Windsurf"
          head={CLIENT_TABLE_HEAD}
          rows={CLIENT_TABLE}
          note="All three talk to the same hosted endpoint with the same key. Nothing is installed on your machine."
        />
      </Section>

      <Section title="A first prompt that publishes nothing" id="prompt">
        <P>Asking for drafts means nothing goes out until you have read it in the Hookpost calendar:</P>
        <Code label="prompt">{FIRST_PROMPT}</Code>
        <P>
          The agent calls <C>integrationList</C> for your channel ids, <C>integrationSchema</C> for each network&apos;s rules (280
          characters on X, 3,000 on LinkedIn), then <C>integrationSchedulePostTool</C> with <C>type: &quot;draft&quot;</C>. If a
          post breaks a rule, the tool returns the error and the agent can fix it and retry. Drafts carry an MCP badge in the editor,
          so you can tell which posts an agent wrote.
        </P>
      </Section>

      <Section title="What the agent can and cannot do" id="tools">
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {MCP_TOOLS.slice(0, 8).map((t) => (
            <li key={t.name} className="min-w-0 rounded-2xl border border-hp-border p-4 text-sm text-hp-text/75">
              <code className="font-mono text-hp-text break-words">{t.name}</code>
              <span className="mt-1 block">{t.does}</span>
            </li>
          ))}
        </ul>
        <P>
          {MCP_CANNOT} The full list, including the AI image and video tools, is in the{' '}
          <A href="/mcp#tools">tool reference</A>.
        </P>
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
