import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import {
  AGENT_PROMPT,
  ANSWER,
  CANONICAL,
  DESCRIPTION,
  FAQ,
  H1,
  NETWORKS,
  NETWORKS_HEAD,
  RELATED,
  STEPS,
  UPDATED,
  WAYS,
  WAYS_HEAD,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Auto-Post to X and LinkedIn with AI | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function AutoPostXLinkedInGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'Auto-post to X and LinkedIn',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to schedule AI-written posts to X and LinkedIn with Hookpost',
    about: ['X (Twitter)', 'LinkedIn', 'Social media scheduling'],
  });

  return (
    <AnswerLayout crumb="Auto-post to X and LinkedIn" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="In the Hookpost editor, in four steps" id="steps">
        <Steps steps={STEPS} />
      </Section>

      <Section title="Three ways to let AI do the writing" id="routes">
        <CompareTable caption="Ways to auto-post AI-written copy to X and LinkedIn with Hookpost" head={WAYS_HEAD} rows={WAYS} />
        <P>
          For the agent route, add Hookpost&apos;s MCP server to your client (<A href="/guides/claude-code-social-media">Claude Code</A>,{' '}
          <A href="/guides/cursor-social-media">Cursor</A>, <A href="/guides/codex-cli-social-media">Codex CLI</A>,{' '}
          <A href="/guides/gemini-cli-social-media">Gemini CLI</A>) and give it a job like this:
        </P>
        <Code label="prompt">{AGENT_PROMPT}</Code>
        <P>
          For the script route, see the <A href="/cli">Hookpost CLI</A> and the{' '}
          <A href="/social-media-scheduling-api">scheduling API</A>.
        </P>
      </Section>

      <Section title="One idea, written for each network" id="limits">
        <P>The limits Hookpost checks before a post is queued, and the networks people ask about next:</P>
        <CompareTable
          caption="Text limits for X, LinkedIn, Threads and Bluesky in Hookpost"
          head={NETWORKS_HEAD}
          rows={NETWORKS}
          note={
            <>
              Every network&apos;s limits in one table: <A href="/guides/post-to-multiple-social-media-at-once">post to multiple
              social media at once</A>. Count before you paste: <A href="/tools/character-counter">character counter</A>.
            </>
          }
        />
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
