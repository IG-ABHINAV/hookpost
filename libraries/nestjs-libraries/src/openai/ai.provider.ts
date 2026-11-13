import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';
import { ChatOpenAI } from '@langchain/openai';
import { createOpenAI, openai } from '@ai-sdk/openai';
import {
  fallbackImageModels,
  IMAGE_SIZE,
  ImageModelResolver,
  PublisherModel,
} from './image.model';

/**
 * Which AI provider serves Hookpost's AI calls, and how to reach it.
 *
 * Every text call (the post generator, RSS auto-post, the copilot, the agent,
 * the slide and voice helpers) talks the OpenAI Chat Completions protocol.
 * Gemini on Vertex AI serves that same protocol at its `endpoints/openapi`
 * URL, so the call sites keep their prompts, JSON schemas and tool calls and
 * only the client changes: base URL, a Google access token instead of an
 * OpenAI key, and `google/<model>` as the model name. Images are the one
 * exception (Vertex has no OpenAI images endpoint); vertexGenerateImage calls
 * Gemini's own generateContent.
 *
 * AI_PROVIDER picks the provider for everything (default `vertex`, billed to
 * the Google Cloud project's credits). AI_TEXT_PROVIDER, AI_AGENT_PROVIDER
 * and AI_IMAGE_PROVIDER override it for one kind of call, which is how a
 * single feature falls back to OpenAI without moving the rest.
 */
export type AiFeature = 'text' | 'agent' | 'image';
export type AiProviderName = 'vertex' | 'openai';

const DEFAULT_VERTEX_TEXT_MODEL = 'gemini-3.8-flash';
const DEFAULT_VERTEX_FALLBACK_MODELS = 'gemini-3.5-flash-lite';
const DEFAULT_OPENAI_TEXT_MODEL = 'gpt-4.1-mini';
const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1-mini';

/**
 * Gemini 3 signs each function call it makes and refuses (400 "Function call
 * is missing a thought_signature") a conversation that sends one of its calls
 * back without that signature. The OpenAI SDK, LangChain, CopilotKit and the
 * AI SDK all drop the signature (it travels in `extra_content`, which none of
 * them know), and CopilotKit rebuilds the history from the browser anyway.
 * Google documents this value for histories that cannot carry the original
 * signature: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function aiProvider(feature: AiFeature): AiProviderName {
  const raw = (
    process.env[`AI_${feature.toUpperCase()}_PROVIDER`] ||
    process.env.AI_PROVIDER ||
    ''
  )
    .trim()
    .toLowerCase();
  if (raw) {
    return raw === 'openai' ? 'openai' : 'vertex';
  }
  // Nothing chosen: Vertex, unless only OpenAI is set up (an install that
  // predates the switch keeps working on its OpenAI key).
  return !process.env.VERTEX_PROJECT?.trim() &&
    !!process.env.OPENAI_API_KEY?.trim()
    ? 'openai'
    : 'vertex';
}

/** Whether the provider for `feature` has what it needs to make a call. */
export function aiConfigured(feature: AiFeature): boolean {
  return aiProvider(feature) === 'vertex'
    ? !!process.env.VERTEX_PROJECT?.trim()
    : !!process.env.OPENAI_API_KEY?.trim();
}

/** The model name as the provider knows it (no `google/` prefix). */
export function aiModel(feature: AiFeature): string {
  const env = process.env;
  if (aiProvider(feature) === 'vertex') {
    if (feature === 'image') {
      // Resolved from Vertex's model list (image.model.ts), never hardcoded.
      return vertexImageModels.current();
    }
    if (feature === 'agent') {
      return (
        env.VERTEX_AGENT_MODEL ||
        env.VERTEX_TEXT_MODEL ||
        DEFAULT_VERTEX_TEXT_MODEL
      );
    }
    return env.VERTEX_TEXT_MODEL || DEFAULT_VERTEX_TEXT_MODEL;
  }
  if (feature === 'image') {
    return env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL;
  }
  if (feature === 'agent') {
    return env.OPENAI_AGENT_MODEL || DEFAULT_OPENAI_TEXT_MODEL;
  }
  return env.OPENAI_TEXT_MODEL || DEFAULT_OPENAI_TEXT_MODEL;
}

/** The model name to send in a Chat Completions request. */
export function chatModelId(feature: AiFeature): string {
  const model = aiModel(feature);
  return aiProvider(feature) === 'vertex' ? `google/${model}` : model;
}

/** Milliseconds one AI request may take before it is abandoned. */
export function aiTimeoutMs(): number {
  const value = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

// Both end up in the URL the Google token is sent to, so only plain ids pass.
// Checked when a request is made (assertVertexConfig), not when a client is
// built: the Mastra agent is built at boot (start.mcp.ts), and an install
// without AI must still start.
const VERTEX_ID = /^[a-z0-9-]+$/;

function vertexLocation() {
  return process.env.VERTEX_LOCATION?.trim() || 'global';
}

function vertexProject() {
  return process.env.VERTEX_PROJECT?.trim() || '';
}

/** Throws unless VERTEX_PROJECT and VERTEX_LOCATION are plain ids. */
export function assertVertexConfig(): void {
  if (!VERTEX_ID.test(vertexLocation())) {
    throw new Error(`Vertex AI: invalid VERTEX_LOCATION "${vertexLocation()}"`);
  }
  if (!VERTEX_ID.test(vertexProject())) {
    throw new Error('Vertex AI: VERTEX_PROJECT is missing or invalid');
  }
}

/** Whether `url` is a Vertex AI endpoint, the only place the token may go. */
export function isVertexUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'aiplatform.googleapis.com' ||
        /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(hostname))
    );
  } catch {
    return false;
  }
}

/** https://…/v1/projects/<project>/locations/<location> */
export function vertexBaseUrl(): string {
  const location = vertexLocation();
  const host =
    location === 'global'
      ? 'aiplatform.googleapis.com'
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(
    vertexProject()
  )}/locations/${encodeURIComponent(location)}`;
}

export function vertexOpenAiBaseUrl(): string {
  return `${vertexBaseUrl()}/endpoints/openapi`;
}

// One GoogleAuth per key file: it caches the access token and refreshes it
// shortly before it expires, so a request never waits for a new one.
const auths = new Map<string, GoogleAuth>();
function googleAuth(): GoogleAuth {
  const keyFile = process.env.VERTEX_CREDENTIALS_FILE?.trim() || '';
  let auth = auths.get(keyFile);
  if (!auth) {
    auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(keyFile ? { keyFilename: keyFile } : {}),
    });
    auths.set(keyFile, auth);
  }
  return auth;
}

export async function vertexAccessToken(): Promise<string> {
  const token = await googleAuth().getAccessToken();
  if (!token) {
    throw new Error('Vertex AI: could not get a Google access token');
  }
  return token;
}

/**
 * Every Google publisher model the project can see (id and launch stage).
 * Vertex lists them only on v1beta1, on the global host, a page at a time.
 */
export async function vertexListPublisherModels(): Promise<PublisherModel[]> {
  assertVertexConfig();
  const models: PublisherModel[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(
      'https://aiplatform.googleapis.com/v1beta1/publishers/google/models'
    );
    url.searchParams.set('pageSize', '100');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${await vertexAccessToken()}`,
        'x-goog-user-project': vertexProject(),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `listing publisher models: ${response.status} ${(
          await response.text()
        ).slice(0, 200)}`
      );
    }
    const data: any = await response.json();
    for (const model of data?.publisherModels || []) {
      if (typeof model?.name === 'string') {
        models.push({ id: model.name, launchStage: model.launchStage });
      }
    }
    pageToken = data?.nextPageToken || '';
    if (!pageToken) {
      break;
    }
  }
  return models;
}

/** The image model in use; see image.model.ts. */
export const vertexImageModels = new ImageModelResolver(
  vertexListPublisherModels
);

/**
 * Resolves the image model now and every 24 hours (the backend calls this at
 * startup). Does nothing unless images go to Vertex and Vertex is set up.
 */
export function startImageModelRefresh(): void {
  if (aiProvider('image') === 'vertex' && aiConfigured('image')) {
    vertexImageModels.start();
  }
}

/**
 * Adapts an OpenAI-style Chat Completions body for Gemini on Vertex:
 * - assistant tool calls without a thought signature get Google's documented
 *   placeholder (SKIP_THOUGHT_SIGNATURE above);
 * - `developer` messages become `system` (Vertex has no developer role);
 * - `reasoning_effort` defaults to VERTEX_REASONING_EFFORT (`low`), because
 *   Gemini 3 otherwise thinks at length before every answer, which is slower
 *   and billed as output. An empty VERTEX_REASONING_EFFORT sends none.
 */
export function prepareVertexChatBody(body: any): any {
  if (!body || typeof body !== 'object') {
    return body;
  }
  const messages = Array.isArray(body.messages)
    ? body.messages.map((message: any) => {
        let next = message;
        if (next?.role === 'developer') {
          next = { ...next, role: 'system' };
        }
        if (next?.role === 'assistant' && Array.isArray(next.tool_calls)) {
          next = {
            ...next,
            tool_calls: next.tool_calls.map((call: any) =>
              call?.extra_content?.google?.thought_signature
                ? call
                : {
                    ...call,
                    extra_content: {
                      ...call?.extra_content,
                      google: {
                        ...call?.extra_content?.google,
                        thought_signature: SKIP_THOUGHT_SIGNATURE,
                      },
                    },
                  }
            ),
          };
        }
        return next;
      })
    : body.messages;

  const effort = process.env.VERTEX_REASONING_EFFORT ?? 'low';
  return {
    ...body,
    ...(messages ? { messages } : {}),
    ...(body.reasoning_effort === undefined && effort.trim()
      ? { reasoning_effort: effort.trim() }
      : {}),
  };
}

/** VERTEX_FALLBACK_MODELS: models to try, in order, when the first is busy. */
export function vertexFallbackModels(): string[] {
  return (process.env.VERTEX_FALLBACK_MODELS ?? DEFAULT_VERTEX_FALLBACK_MODELS)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * fetch for an OpenAI-protocol client pointed at Vertex: authorizes each
 * request with the service account's access token (the client's own
 * `Authorization: Bearer <apiKey>` is replaced) and adapts Chat Completions
 * bodies (prepareVertexChatBody).
 *
 * Gemini on Vertex runs on shared capacity, and a model can answer 429
 * RESOURCE_EXHAUSTED for a while even though the project is far from any
 * quota (seen live on the newest Flash models). A chat request that gets one
 * is sent again with each of VERTEX_FALLBACK_MODELS in turn, before the
 * client's own retries; the prompt and schema are unchanged.
 */
export function vertexFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!isVertexUrl(url)) {
      throw new Error(`Vertex AI: refusing to send the Google token to ${url}`);
    }
    assertVertexConfig();
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${await vertexAccessToken()}`);
    let parsed: any;
    if (typeof init?.body === 'string' && /\/chat\/completions$/.test(url)) {
      try {
        parsed = prepareVertexChatBody(JSON.parse(init.body));
      } catch {
        parsed = undefined; // not JSON: send it as it is
      }
    }
    if (!parsed) {
      return baseFetch(input, { ...init, headers });
    }

    const models = [
      parsed.model,
      ...vertexFallbackModels()
        .map((model) => `google/${model}`)
        .filter((model) => model !== parsed.model),
    ];
    let response: Response | undefined;
    for (const [index, model] of models.entries()) {
      if (index > 0) {
        console.warn(
          `Vertex AI: ${
            models[index - 1]
          } is busy (429), retrying with ${model}`
        );
      }
      response = await baseFetch(input, {
        ...init,
        headers,
        body: JSON.stringify({ ...parsed, model }),
      });
      if (response.status !== 429 || index === models.length - 1) {
        return response;
      }
      // free the connection before the next attempt
      await response.body?.cancel().catch(() => undefined);
    }
    return response!;
  };
}

/**
 * The OpenAI SDK client for text calls: Gemini on Vertex, or OpenAI itself
 * when AI_PROVIDER (or AI_TEXT_PROVIDER) is `openai`. Use chatModelId('text')
 * as the model.
 */
export function aiClient(feature: AiFeature = 'text'): OpenAI {
  if (aiProvider(feature) === 'vertex') {
    return new OpenAI({
      apiKey: 'vertex-ai',
      baseURL: vertexOpenAiBaseUrl(),
      fetch: vertexFetch(),
      timeout: aiTimeoutMs(),
      maxRetries: 2,
    });
  }
  // OpenAI keeps the SDK's defaults it always had (10 minute timeout, two
  // retries): a shorter timeout would re-send slow gpt-image renders.
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
  });
}

/** The client options LangChain's ChatOpenAI and the AI SDK need for Vertex. */
export function vertexClientOptions() {
  return {
    apiKey: 'vertex-ai',
    baseURL: vertexOpenAiBaseUrl(),
    fetch: vertexFetch(),
  };
}

/**
 * LangChain chat model for the post generator, RSS auto-post and the popular
 * posts classifier. `temperature` applies to OpenAI only: Google recommends
 * leaving Gemini 3 at its default (1.0), as lower values can make it loop.
 */
export function langchainChatModel(temperature: number): ChatOpenAI {
  if (aiProvider('text') === 'vertex') {
    const { apiKey, ...configuration } = vertexClientOptions();
    return new ChatOpenAI({
      apiKey,
      model: chatModelId('text'),
      configuration,
      timeout: aiTimeoutMs(),
      maxRetries: 2,
    });
  }
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
    model: chatModelId('text'),
    temperature,
  });
}

/**
 * The Mastra agent's model (AI SDK). For Vertex it is the AI SDK's OpenAI
 * provider pointed at the Chat Completions endpoint: `.chat()`, because the
 * default openai() model uses the Responses API, which Vertex does not serve.
 */
// Annotated: the inferred type names @ai-sdk/provider, which the backend's
// declaration build cannot reference (TS2742).
type AgentLanguageModel = ReturnType<ReturnType<typeof createOpenAI>['chat']>;

export function agentLanguageModel(): AgentLanguageModel {
  return aiProvider('agent') === 'vertex'
    ? createOpenAI({ name: 'vertex', ...vertexClientOptions() }).chat(
        chatModelId('agent')
      )
    : openai(chatModelId('agent'));
}

const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_RECITATION',
]);

/** Gemini image models accept these; any other ratio is sent as the nearest. */
export type VertexAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

/**
 * One picture from a Gemini image model on Vertex, as base64 (JPEG or PNG,
 * whichever the model returns: the upload sniffs the bytes).
 *
 * A prompt Google's safety filters block throws an error worded like
 * OpenAI's ("rejected by the safety system, safety_violations=[...]") so
 * generationError reports it to the user the same way (422).
 */
export async function vertexGenerateImage(
  prompt: string,
  aspectRatio: VertexAspectRatio = '1:1'
): Promise<string> {
  assertVertexConfig();
  // The newest Flash image model (resolved at startup and once a day; a
  // process that has not resolved yet, such as a worker, does it here).
  const primary = await vertexImageModels.ensure();
  // Like text (vertexFetch), a busy image model (429) is retried once with
  // each of VERTEX_IMAGE_FALLBACK_MODELS, by default AI_IMAGE_MODEL and the
  // static chain in image.model.ts.
  const fallbacks = (
    process.env.VERTEX_IMAGE_FALLBACK_MODELS ?? fallbackImageModels().join(',')
  )
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model && model !== primary);
  const models = [primary, ...fallbacks];

  let response!: Response;
  for (const [index, model] of models.entries()) {
    if (index > 0) {
      console.warn(
        `Vertex AI: ${models[index - 1]} is busy (429), retrying with ${model}`
      );
    }
    response = await fetch(
      `${vertexBaseUrl()}/publishers/google/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await vertexAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio, imageSize: IMAGE_SIZE },
          },
        }),
        signal: AbortSignal.timeout(aiTimeoutMs()),
      }
    );
    if (response.status !== 429 || index === models.length - 1) {
      break;
    }
    await response.body?.cancel().catch(() => undefined);
  }

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    const error: any = new Error(
      `${response.status} ${data?.error?.message || text.slice(0, 300)}`
    );
    error.status = response.status;
    throw error;
  }

  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(
      `Your request was rejected by the safety system, safety_violations=[${String(
        blocked
      ).toLowerCase()}]`
    );
  }

  const candidate = data?.candidates?.[0];
  // The last picture that is not one of the model's interim "thought" images.
  const image = (candidate?.content?.parts || [])
    .filter((part: any) => part?.inlineData?.data && !part?.thought)
    .pop();
  if (image) {
    return image.inlineData.data as string;
  }

  // A prompt the image model will not draw ends with NO_IMAGE and no parts
  // at all (checked against the live API: no category is given).
  if (candidate?.finishReason === 'NO_IMAGE') {
    throw new Error(
      'Your request was rejected by the safety system: the image model declined this prompt'
    );
  }

  if (SAFETY_FINISH_REASONS.has(candidate?.finishReason)) {
    throw new Error(
      `Your request was rejected by the safety system, safety_violations=[${String(
        candidate.finishReason
      ).toLowerCase()}]`
    );
  }

  throw new Error(
    `The image model returned no image (finishReason ${
      candidate?.finishReason || 'none'
    })`
  );
}
