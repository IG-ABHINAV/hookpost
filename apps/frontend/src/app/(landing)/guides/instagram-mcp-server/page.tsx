import { Metadata } from 'next';
import { withSocial } from '../../social-meta';
import { ANSWER_PAGES_UPDATED_LABEL } from '../_answer/answer-pages';
import { answerJsonLd } from '../_answer/answer-schema';
import { A, AnswerLayout, C, Code, CompareTable, FaqSection, P, Related, Section, Steps } from '../_answer/AnswerPage';
import {
  ANSWER,
  CANONICAL,
  DESCRIPTION,
  FAQ,
  FIRST_PROMPT,
  FORMATS,
  FORMATS_HEAD,
  H1,
  RELATED,
  STEPS,
  UPDATED,
  VS_HEAD,
  VS_ROWS,
} from './content';

export const metadata: Metadata = withSocial({
  title: 'Instagram MCP Server: Post Reels and Carousels from Claude | Hookpost',
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: { title: H1, description: DESCRIPTION, url: CANONICAL, type: 'article' },
});

export default function InstagramMcpServerGuide() {
  const jsonLd = answerJsonLd({
    canonical: CANONICAL,
    headline: H1,
    description: DESCRIPTION,
    datePublished: UPDATED,
    crumb: 'Instagram MCP server',
    faq: FAQ,
    steps: STEPS,
    howToName: 'How to post to Instagram from an AI agent with Hookpost',
    about: ['Instagram', 'Model Context Protocol'],
  });

  return (
    <AnswerLayout crumb="Instagram MCP server" h1={H1} answer={ANSWER} updated={UPDATED} updatedLabel={ANSWER_PAGES_UPDATED_LABEL} jsonLd={jsonLd}>
      <Section title="Set it up in four steps" id="steps">
        <Steps steps={STEPS} />
        <P>
          Client-by-client configs for step 2 are on <A href="/mcp#setup">the MCP page</A>.
        </P>
      </Section>

      <Section title="What you can post to Instagram" id="formats">
        <CompareTable caption="Instagram formats Hookpost publishes" head={FORMATS_HEAD} rows={FORMATS} />
        <P>
          Ask the agent to call <C>integrationSchema</C> for Instagram before it posts: it returns these rules and the per-post
          settings (post type, collaborators, trial Reel, and Meta&apos;s AI-generated label), so the agent sets them instead of
          guessing.
        </P>
      </Section>

      <Section title="A prompt that saves a carousel draft" id="prompt">
        <Code label="prompt">{FIRST_PROMPT}</Code>
        <P>
          Swap the example URLs for images you host. If you would rather generate the picture, <C>generateImageTool</C> makes one
          from a prompt and uses your plan&apos;s AI image allowance.
        </P>
      </Section>

      <Section title="Hosted server or a self-hosted Instagram MCP?" id="compare">
        <P>
          The Instagram MCP servers that rank on GitHub call the Instagram Graph API directly from your machine. That is a good fit
          if you only need Instagram and are happy to run a Meta app. The difference in practice:
        </P>
        <CompareTable caption="Hookpost's hosted MCP server compared with a self-hosted Instagram MCP server" head={VS_HEAD} rows={VS_ROWS} />
      </Section>

      <FaqSection faq={FAQ} />
      <Related links={RELATED} />
    </AnswerLayout>
  );
}
