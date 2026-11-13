/**
 * Live smoke test of the Mastra agent's model on the configured AI provider
 * (ai.provider.ts agentLanguageModel). Jest cannot load @mastra/core, so this
 * runs the real Agent once with one tool, twice: the second run sends the
 * first run's tool call back as history, which is what CopilotKit does and
 * what Gemini 3 refuses without a thought signature.
 *
 *   VERTEX_PROJECT=jr-consulting-co VERTEX_CREDENTIALS_FILE=/path/key.json \
 *   pnpm exec ts-node --transpile-only -r tsconfig-paths/register \
 *     -P apps/backend/tsconfig.build.json scripts/ai-agent-smoke.ts
 *
 * Exits 1 when the tool was not called or the answer is missing.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  agentLanguageModel,
  chatModelId,
} from '@hookpost/nestjs-libraries/openai/ai.provider';

async function main() {
  let calls = 0;
  const agent = new Agent({
    id: 'smoke',
    name: 'smoke',
    instructions: 'You answer weather questions with the getWeather tool.',
    model: agentLanguageModel(),
    tools: {
      getWeather: createTool({
        id: 'getWeather',
        description: 'Weather for a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async () => {
          calls++;
          return { celsius: 18, sky: 'sunny' };
        },
      }),
    },
  });

  const first = await agent.generate('What is the weather in Paris?', {
    maxSteps: 3,
  } as any);
  console.log(`[${chatModelId('agent')}] first:`, first.text);

  const second = await agent.generate(
    [
      ...(first.response?.messages || []),
      { role: 'user', content: 'And is that warm enough for a T-shirt?' },
    ] as any,
    { maxSteps: 3 } as any
  );
  console.log(`[${chatModelId('agent')}] second:`, second.text);

  if (!calls || !/18/.test(first.text) || !second.text) {
    console.error('FAIL: tool calls', calls);
    process.exit(1);
  }
  console.log('OK: tool calls', calls);
}

main().catch((err) => {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
});
