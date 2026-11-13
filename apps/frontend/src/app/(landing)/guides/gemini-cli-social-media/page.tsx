import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, C, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import { CLI_AGENTS, CLI_AGENTS_HEAD } from '../_answer/facts';
import {
  ADD_CMD,
  ANSWER,
  CANONICAL,
  CHECK,
  DESCRIPTION,
  FAQ,
  FIRST_PROMPT,
  GEMINI_JSON,
  H1,
  MCP_CANNOT,
  RELATED,
  STEPS,
  UPDATED,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Schedule Social Media Posts from Gemini CLI (MCP) | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function GeminiCliSocialMediaGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'Gemini CLI',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to schedule social media posts from Gemini CLI with Hookpost',
    about: ['Gemini CLI', 'Model Context Protocol'],
  });

  return (
    <AnswerLayout crumb="Gemini CLI" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="Set it up in four steps" id="steps">
        <Steps steps={STEPS} />
      </Section>

      <Section title="With one command" id="command">
        <P>
          Replace <C>YOUR_API_KEY</C> with your key. <C>--scope user</C> makes the server available in every project:
        </P>
        <Code>{ADD_CMD}</Code>
        <Code>{CHECK}</Code>
      </Section>

      <Section title="Or edit settings.json" id="settings">
        <P>
          Add the <C>hookpost</C> entry to <C>~/.gemini/settings.json</C>, next to any servers you already have:
        </P>
        <Code label="~/.gemini/settings.json">{GEMINI_JSON}</Code>
        <P>
          <C>httpUrl</C> is Streamable HTTP, which is what Hookpost speaks. With <C>url</C> instead, Gemini CLI treats the address as an
          SSE endpoint, which is not what Hookpost serves.
        </P>
      </Section>

      <Section title="A first prompt" id="prompt">
        <Code label="prompt">{FIRST_PROMPT}</Code>
        <P>
          Gemini lists your channels with <C>integrationList</C>, checks each network&apos;s limits with <C>integrationSchema</C>, and
          saves the drafts with <C>integrationSchedulePostTool</C>. If a post breaks a network&apos;s rule, the tool returns the error
          so Gemini can fix it. {MCP_CANNOT}
        </P>
      </Section>

      <Section title="Gemini CLI, Codex and Claude Code compared" id="compare">
        <CompareTable
          caption="Adding Hookpost's MCP server to Claude Code, Codex CLI and Gemini CLI"
          head={CLI_AGENTS_HEAD}
          rows={CLI_AGENTS}
          note={
            <>
              From each agent&apos;s own documentation, read 26 October 2026. Every client config in one place:{' '}
              <A href="/mcp#setup">the MCP page</A>.
            </>
          }
        />
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
