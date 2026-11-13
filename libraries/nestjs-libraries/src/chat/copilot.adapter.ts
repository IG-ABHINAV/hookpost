import { OpenAIAdapter } from '@copilotkit/runtime';
import {
  aiClient,
  aiProvider,
  chatModelId,
} from '@hookpost/nestjs-libraries/openai/ai.provider';
import { NO_INVENTED_FACTS_RULE } from '@hookpost/nestjs-libraries/openai/invented.links';

/**
 * Adds the no-invented-links rule to the system prompt. The copilot's own
 * instructions come from the browser (manage.modal.tsx), so the rule is added
 * here, where the page cannot leave it out.
 */
export const withNoInventedFactsRule = (messages: any[] = []): any[] => {
  const rule = `Rule for any post text you write: ${NO_INVENTED_FACTS_RULE}`;
  const i = messages.findIndex(
    (m) => m?.role === 'system' || m?.role === 'developer'
  );
  if (i >= 0 && typeof messages[i].content === 'string') {
    return messages.map((m, j) =>
      j === i ? { ...m, content: `${m.content}\n\n${rule}` } : m
    );
  }
  return [{ role: 'system', content: rule }, ...messages];
};

/**
 * CopilotKit's OpenAIAdapter for the configured provider, given our OpenAI
 * client (ai.provider.ts) behind the one method it calls: CopilotKit 1.10
 * bundles openai v4 and calls `beta.chat.completions.stream`, which openai v6
 * serves as `chat.completions.stream` (same chunks).
 *
 * The model is pinned here: CopilotKit lets the browser forward a `model`
 * that would otherwise override ours, which would let anyone pick any (paid)
 * model for one ai_text credit. keepSystemRole on Vertex, which has no
 * `developer` role. Every request carries NO_INVENTED_FACTS_RULE.
 */
export const copilotServiceAdapter = () => {
  const client = aiClient('text');
  const model = chatModelId('text');
  return new OpenAIAdapter({
    openai: {
      beta: {
        chat: {
          completions: {
            stream: (params: any) =>
              client.chat.completions.stream({
                ...params,
                messages: withNoInventedFactsRule(params?.messages),
                model,
              }),
          },
        },
      },
    } as any,
    model,
    keepSystemRole: aiProvider('text') === 'vertex',
  });
};
