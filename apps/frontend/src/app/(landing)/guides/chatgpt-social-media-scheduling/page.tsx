import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import {
  ANSWER,
  CANONICAL,
  DESCRIPTION,
  FAQ,
  FIRST_PROMPT,
  H1,
  MCP_URL_CHATGPT,
  OTHERS,
  OTHERS_HEAD,
  PROMPT,
  RELATED,
  PLAN_NOTE,
  ROUTES,
  ROUTES_HEAD,
  STEPS,
  TESTED,
  UPDATED,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Can ChatGPT Schedule Social Media Posts? | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function ChatGptSocialMediaGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'ChatGPT',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to add Hookpost to ChatGPT as a custom MCP server',
    about: ['ChatGPT', 'Social media scheduling'],
  });

  return (
    <AnswerLayout crumb="ChatGPT" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="Add Hookpost to ChatGPT" id="connect">
        <P>The server URL, with OAuth as the authentication:</P>
        <Code label="custom MCP server URL">{MCP_URL_CHATGPT}</Code>
        <Steps steps={STEPS} />
        <P>{PLAN_NOTE}</P>
        <P>A first prompt that saves drafts, so you can check them in the Hookpost calendar before anything goes out:</P>
        <Code label="prompt for ChatGPT">{FIRST_PROMPT}</Code>
        <P>{TESTED}</P>
      </Section>

      <Section title="Every route from ChatGPT to Hookpost" id="routes">
        <CompareTable caption="Ways to get posts from an OpenAI model into Hookpost" head={ROUTES_HEAD} rows={ROUTES} />
        <P>
          Codex CLI setup, step by step: <A href="/guides/codex-cli-social-media">schedule posts from Codex CLI</A>. The REST API and
          CLI: <A href="/social-media-scheduling-api">social media scheduling API</A>.
        </P>
      </Section>

      <Section title="Writing in ChatGPT, scheduling in Hookpost" id="paste">
        <P>Ask for one version per network, labelled, so each one pastes straight into its channel:</P>
        <Code label="prompt for ChatGPT">{PROMPT}</Code>
        <P>
          In Hookpost, create a post, select your LinkedIn and X channels, paste the LinkedIn version into the shared editor, then open
          the X channel and choose Edit content to paste the shorter one. Pick a time and add it to the calendar.
        </P>
      </Section>

      <Section title="Other schedulers that work inside ChatGPT" id="others">
        <P>
          These schedulers say they work from inside ChatGPT. We have not tested them; this is what their own pages said on 26
          October 2026:
        </P>
        <CompareTable caption="Schedulers that say they work inside ChatGPT" head={OTHERS_HEAD} rows={OTHERS} />
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
