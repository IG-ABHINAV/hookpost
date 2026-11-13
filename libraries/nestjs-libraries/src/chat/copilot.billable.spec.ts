// POST /copilot/chat spends an AI text credit for a generation and nothing
// for CopilotKit's page-load handshake (copilot.billable.ts). A generation
// used to be recognised only by its operationName, which the GraphQL server
// does not need, so one sent without it reached OpenAI for free.
//   pnpm exec jest -c apps/backend/jest.config.ts copilot.billable

import { copilotRequestIsBillable } from '@hookpost/nestjs-libraries/chat/copilot.billable';

const GENERATE =
  'mutation generateCopilotResponse($data: GenerateCopilotResponseInput!) { generateCopilotResponse(data: $data) { threadId } }';

describe('copilotRequestIsBillable', () => {
  it('the two handshake queries CopilotKit sends on every page load are free', () => {
    expect(
      copilotRequestIsBillable({
        operationName: 'availableAgents',
        query: 'query availableAgents { availableAgents { agents { name id description } } }',
        variables: {},
      })
    ).toBe(false);
    expect(
      copilotRequestIsBillable({
        operationName: 'loadAgentState',
        query: 'query loadAgentState($data: LoadAgentStateInput!) { loadAgentState(data: $data) { threadId } }',
      })
    ).toBe(false);
  });

  it('the generation CopilotKit sends is billable', () => {
    expect(
      copilotRequestIsBillable({ operationName: 'generateCopilotResponse', query: GENERATE })
    ).toBe(true);
  });

  it.each([
    ['no operationName', { query: GENERATE }],
    ['another operationName', { operationName: 'whatever', query: GENERATE }],
    ['a handshake name on a generation', { operationName: 'availableAgents', query: GENERATE }],
    ['an aliased generation under a handshake name', {
      operationName: 'availableAgents',
      query: 'query availableAgents { a: availableAgents { agents { id } } } mutation m { x: generateCopilotResponse(data: {}) { threadId } }',
    }],
    ['a batched body', [{ operationName: 'availableAgents', query: 'query availableAgents { availableAgents { agents { id } } }' }]],
    ['a body the JSON parser did not read (multipart)', {}],
    ['no body', undefined],
    ['a handshake name without a query (a persisted operation)', { operationName: 'availableAgents' }],
  ])('%s: billable', (_label, body) => {
    expect(copilotRequestIsBillable(body)).toBe(true);
  });
});
