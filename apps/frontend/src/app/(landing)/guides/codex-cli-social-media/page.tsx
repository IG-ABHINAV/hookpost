import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, C, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import { CLI_AGENTS, CLI_AGENTS_HEAD } from '../_answer/facts';
import {
  ANSWER,
  CANONICAL,
  CHECK,
  CODEX_TOML,
  DESCRIPTION,
  EXPORT_KEY,
  FAQ,
  FIRST_PROMPT,
  H1,
  MCP_CANNOT,
  RELATED,
  STEPS,
  UPDATED,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Schedule Social Media Posts from Codex CLI (MCP) | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function CodexCliSocialMediaGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'Codex CLI',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to schedule social media posts from Codex CLI with Hookpost',
    about: ['Codex CLI', 'Model Context Protocol'],
  });

  return (
    <AnswerLayout crumb="Codex CLI" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="Set it up in four steps" id="steps">
        <Steps steps={STEPS} />
      </Section>

      <Section title="The config" id="config">
        <P>Set the key once in your shell profile:</P>
        <Code>{EXPORT_KEY}</Code>
        <P>
          Then add this table to <C>~/.codex/config.toml</C>. <C>bearer_token_env_var</C> names the variable; Codex reads it and
          sends <C>Authorization: Bearer &lt;key&gt;</C> on every request:
        </P>
        <Code>{CODEX_TOML}</Code>
        <P>Check that Codex sees it:</P>
        <Code>{CHECK}</Code>
      </Section>

      <Section title="A first prompt" id="prompt">
        <Code label="prompt">{FIRST_PROMPT}</Code>
        <P>
          Codex lists your channels with <C>integrationList</C>, reads each network&apos;s limits with <C>integrationSchema</C>, and
          saves the posts with <C>integrationSchedulePostTool</C> as drafts. Hookpost checks every post against the network&apos;s
          rules the same way its own editor does and returns any error, so Codex can fix the post and try again. {MCP_CANNOT}
        </P>
      </Section>

      <Section title="Codex, Claude Code and Gemini CLI compared" id="compare">
        <P>The server is the same for all three terminal agents. What differs is where the config lives and how the key is sent:</P>
        <CompareTable
          caption="Adding Hookpost's MCP server to Claude Code, Codex CLI and Gemini CLI"
          head={CLI_AGENTS_HEAD}
          rows={CLI_AGENTS}
          note={
            <>
              From each agent&apos;s own documentation, read 26 October 2026. Exact configs for all of them, plus Cursor, VS Code and
              Windsurf: <A href="/mcp#setup">the MCP page</A>.
            </>
          }
        />
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
