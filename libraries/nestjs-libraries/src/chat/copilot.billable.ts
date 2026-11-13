/**
 * The discovery queries CopilotKit's client (runtime-client-gql 1.10) sends on
 * every page load. They never reach OpenAI and must never 402: CopilotKit
 * wraps the whole app layout, and a refused handshake stopped the calendar
 * from rendering (copilot.controller.ts chatAgent). Its third operation,
 * generateCopilotResponse, is the generation.
 */
const FREE_COPILOT_OPERATIONS = new Set(['availableAgents', 'loadAgentState']);

/**
 * Whether a POST /copilot/chat body is a generation, which spends one AI text
 * credit and is refused without one (the Free plan, and a workspace that has
 * not started its trial, have none). Only a JSON body naming one of the
 * discovery operations, whose document does not mention the generation, is
 * free.
 *
 * It used to be "operationName is generateCopilotResponse". The GraphQL
 * server runs a document's only operation whatever operationName says, so a
 * generation sent without that name (or as a batched or multipart body)
 * reached OpenAI with no credit and no plan check, for any workspace.
 */
export const copilotRequestIsBillable = (body: unknown): boolean => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return true;
  }
  const { operationName, query } = body as {
    operationName?: unknown;
    query?: unknown;
  };
  if (
    typeof operationName !== 'string' ||
    !FREE_COPILOT_OPERATIONS.has(operationName) ||
    typeof query !== 'string'
  ) {
    return true;
  }
  return /generateCopilotResponse/.test(query);
};
