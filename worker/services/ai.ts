// AI assistance for drafting polls through either Cloudflare Workers AI or an
// OpenAI-compatible HTTP endpoint.
//
// Privacy: the prompt and the model response are never logged and never written
// to D1. The draft the user typed is sent to the provider and the validated
// result goes straight back to the caller.
//
// The model is asked for structured JSON, and the result is passed through a
// strict parser: array type, item count, string type, trimmed length, no
// markdown, and no duplicates. Anything that does not match is rejected so a
// caller never sees a malformed suggestion.

import type { AiProvider } from '../../shared/settings';

const TIMEOUT_MS = 15_000;

// Wraps one model call in a 15 second deadline. `AbortSignal.timeout` is passed
// through the binding options so a slow model cannot hold the request open.
async function runWithTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ai timeout')), TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Fallback model when the `ai_model` setting is empty.
export const DEFAULT_AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_SUGGESTION_LENGTH = 200;
export const MAX_OPTION_LENGTH = 80;
export const MAX_TITLE_SUGGESTIONS = 3;
export const MIN_OPTION_COUNT = 2;
export const MAX_OPTION_COUNT = 7;

export type AiLocale = 'en' | 'zh-CN' | 'zh-TW';

export interface AiEnv {
  AI: Ai;
  ai_provider: AiProvider;
  ai_api_url: string;
  ai_api_key: string;
}

// The language the model must answer in, spelled out for the prompt.
const LOCALE_NAMES: Record<AiLocale, string> = {
  en: 'English',
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)'
};

const SYSTEM_PROMPT = [
  'You are helping a user draft a neutral public opinion poll.',
  'You must not add facts that are not present in the input.',
  'You must not include the names of private individuals.',
  'Every suggestion must be neutral in tone, phrased as a question or a clear proposition,',
  'and must not begin with emotionally loaded wording or with a leading phrase.',
  'Answer only in the requested language and only with the requested JSON.'
].join(' ');

export type AiFailure = 'bad_model_output' | 'timeout' | 'model_error';
export type AiResult<T> = { ok: true; value: T } | { ok: false; reason: AiFailure };

// Builds the chat-completions URL from either a base URL or a full endpoint.
// A base URL such as https://api.openai.com/v1 becomes
// https://api.openai.com/v1/chat/completions; an already complete endpoint is
// left unchanged.
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('OpenAI-compatible API URL is not configured');
  const url = new URL(trimmed);
  if (!/\/chat\/completions\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  }
  return url.toString();
}

// Calls an OpenAI-compatible chat-completions endpoint. The response format is
// JSON object mode, which compatible servers commonly support; the prompts
// themselves already spell out the exact JSON shape and the caller validates it
// strictly. The API key is optional and is sent as a bearer token when present.
async function runOpenAiCompatibleModel(
  env: AiEnv,
  model: string,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = env.ai_api_key?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetch(openAiChatCompletionsUrl(env.ai_api_url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' }
    }),
    signal
  });
  if (!response.ok) {
    // The body is never logged or returned: it can contain provider details.
    throw new Error(`OpenAI-compatible API answered ${response.status}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string' || (typeof content === 'object' && content !== null)) {
    return content;
  }
  throw new Error('OpenAI-compatible API returned no message content');
}

// Calls the configured provider. Kept as a single seam so tests can stub
// `env.AI` for Workers AI or the global `fetch` for an OpenAI-compatible API.
export async function runModel(
  env: AiEnv,
  model: string,
  messages: Array<{ role: string; content: string }>,
  jsonSchema: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  if (env.ai_provider === 'openai_compatible') {
    return runOpenAiCompatibleModel(env, model, messages, signal);
  }
  if (env.ai_provider !== 'cloudflare') {
    throw new Error('AI provider is not configured');
  }
  return env.AI.run(model, {
    messages,
    response_format: { type: 'json_schema', json_schema: jsonSchema },
    signal
  } as never);
}

// Runs the model behind a 15 second timeout. The abort signal ends the request
// so a slow model cannot hold the Worker request open.
async function callModel(
  env: AiEnv,
  model: string,
  messages: Array<{ role: string; content: string }>,
  jsonSchema: Record<string, unknown>
): Promise<AiResult<unknown>> {
  try {
    // `AbortSignal.timeout` also carries the deadline into the binding call.
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    const result = await runWithTimeout((innerSignal) =>
      runModel(env, model, messages, jsonSchema, signal ?? innerSignal));
    return { ok: true, value: result };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'TimeoutError' || name === 'AbortError' || /timeout|abort/i.test(message)) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'model_error' };
  }
}

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['suggestions']
};

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['options']
};

const CATEGORY_SCHEMA = {
  type: 'object',
  properties: {
    slug: { type: 'string' }
  },
  required: ['slug']
};

// A dedicated system prompt: categorisation is a classification task, not a
// drafting task.
const CATEGORISE_SYSTEM_PROMPT = [
  'You classify a public opinion poll into exactly one of the categories the user lists.',
  'You must not add facts that are not present in the input.',
  'Answer only with the requested JSON.'
].join(' ');

// Unwraps the JSON the model returned. The binding normally answers with the
// parsed object, but a text or `response` wrapper is tolerated as well.
function readJsonField(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') {
    try {
      return readJsonField(JSON.parse(payload));
    } catch {
      return null;
    }
  }
  if (typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.response === 'string' || typeof record.response === 'object') {
    return readJsonField(record.response);
  }
  return payload;
}

// Strict validation of a list of strings: array type, item count, string type,
// trimmed length, no markdown, and no duplicates. More items than `max` are
// truncated to `max` rather than rejected, which matches the documented "up to
// N suggestions".
export function parseStringList(
  payload: unknown,
  field: string,
  min: number,
  max: number,
  maxLength: number
): string[] | null {
  const root = readJsonField(payload);
  if (typeof root !== 'object' || root === null) return null;
  const list = (root as Record<string, unknown>)[field];
  if (!Array.isArray(list)) return null;
  if (list.length < min) return null;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') return null;
    const value = entry.trim().replace(/\s+/g, ' ');
    if (value.length < 1 || value.length > maxLength) return null;
    // Markdown markers and line breaks are rejected rather than cleaned.
    if (/[*_`#>\[\]{}|]/.test(value) || /[\r\n]/.test(value)) return null;
    const key = value.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(value);
    if (out.length === max) break;
  }
  return out;
}

export interface TitleSuggestionInput {
  title: string;
  description?: string;
}

export async function suggestTitles(
  env: AiEnv,
  model: string,
  input: TitleSuggestionInput,
  locale: AiLocale
): Promise<AiResult<string[]>> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Draft title: ${input.title}`,
        input.description ? `Draft description: ${input.description}` : '',
        `Write up to ${MAX_TITLE_SUGGESTIONS} alternative titles of at most ${MAX_SUGGESTION_LENGTH} characters each.`,
        `Answer in ${LOCALE_NAMES[locale]}.`,
        'Return JSON: {"suggestions": ["...", "..."]}.'
      ].filter((line) => line.length > 0).join('\n')
    }
  ];
  const result = await callModel(env, model, messages, TITLE_SCHEMA);
  if (!result.ok) return result;
  const suggestions = parseStringList(result.value, 'suggestions', 1, MAX_TITLE_SUGGESTIONS, MAX_SUGGESTION_LENGTH);
  if (!suggestions) return { ok: false, reason: 'bad_model_output' };
  return { ok: true, value: suggestions };
}

export interface OptionSuggestionInput {
  title: string;
  description?: string;
  pollType: 'single_choice' | 'multi_choice';
  count: number;
}

export interface DescriptionSuggestionInput {
  title: string;
  description?: string;
  options: string[];
}

export async function suggestPollOptions(
  env: AiEnv,
  model: string,
  input: OptionSuggestionInput,
  locale: AiLocale
): Promise<AiResult<string[]>> {
  const count = Math.min(MAX_OPTION_COUNT, Math.max(MIN_OPTION_COUNT, input.count));
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Poll title: ${input.title}`,
        input.description ? `Poll description: ${input.description}` : '',
        `The poll is ${input.pollType === 'single_choice' ? 'a single choice poll' : 'a multiple choice poll'}.`,
        `Write ${count} options of at most ${MAX_OPTION_LENGTH} characters each.`,
        input.pollType === 'single_choice'
          ? 'The options must be mutually exclusive.'
          : 'The options together must cover the whole question.',
        `Answer in ${LOCALE_NAMES[locale]}.`,
        'Return JSON: {"options": ["...", "..."]}.'
      ].filter((line) => line.length > 0).join('\n')
    }
  ];
  const result = await callModel(env, model, messages, OPTIONS_SCHEMA);
  if (!result.ok) return result;
  const options = parseStringList(result.value, 'options', MIN_OPTION_COUNT, MAX_OPTION_COUNT, MAX_OPTION_LENGTH);
  if (!options) return { ok: false, reason: 'bad_model_output' };
  return { ok: true, value: options };
}

export interface CategoriseInput {
  title: string;
  description?: string;
  /** The enabled topics the model may choose from. */
  topics: ReadonlyArray<{ slug: string; names: { en: string } }>;
}

// Asks the model for exactly one enabled slug, or `none`. The answer is validated
// against the enabled list and anything else (including `none`) becomes null, so a
// caller can never store a slug that is not enabled. The input is never logged.
export async function categorisePoll(
  env: AiEnv,
  model: string,
  input: CategoriseInput
): Promise<AiResult<string | null>> {
  const enabled = new Set(input.topics.map((topic) => topic.slug));
  const listing = input.topics.map((topic) => `- ${topic.slug}: ${topic.names.en}`).join('\n');
  const messages = [
    { role: 'system', content: CATEGORISE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Poll title: ${input.title}`,
        input.description ? `Poll description: ${input.description}` : '',
        'Choose exactly one topic for this poll from this list:',
        listing,
        'If none of them fits, answer with "none".',
        'Return JSON: {"slug": "<one-slug-or-none>"}.'
      ].filter((line) => line.length > 0).join('\n')
    }
  ];
  const result = await callModel(env, model, messages, CATEGORY_SCHEMA);
  if (!result.ok) return result;

  const root = readJsonField(result.value);
  if (typeof root !== 'object' || root === null) return { ok: false, reason: 'bad_model_output' };
  const slug = (root as Record<string, unknown>).slug;
  if (typeof slug !== 'string') return { ok: false, reason: 'bad_model_output' };
  const normalized = slug.trim().toLowerCase();
  return { ok: true, value: enabled.has(normalized) ? normalized : null };
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    approve: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['approve']
};

// A dedicated system prompt for the review gate. The admin's own prompt is
// passed as user-provided instructions, so this fixed wording can keep the
// answer machine-readable and make clear what a rejection means.
const REVIEW_SYSTEM_PROMPT = [
  'You review a submitted public opinion poll against the review instructions the user provides.',
  'You must not add facts that are not present in the submission.',
  'Answer only with the requested JSON.',
  'Set "approve" to true only when the submission satisfies every instruction.',
  'Set "approve" to false otherwise, and put a short reason for the rejection in "reason".'
].join(' ');

export interface PollReviewInput {
  title: string;
  description?: string;
  pollType: string;
  options: string[];
}

// Runs the admin-defined review prompt against one submission. A missing or
// non-boolean answer is treated as a failure, so the caller can keep the poll
// pending rather than publish something the model did not clearly accept.
export async function reviewPoll(
  env: AiEnv,
  model: string,
  prompt: string,
  input: PollReviewInput
): Promise<AiResult<boolean>> {
  const messages = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Review instructions:',
        prompt,
        '',
        'Poll submission:',
        `Title: ${input.title}`,
        input.description ? `Description: ${input.description}` : 'No description.',
        `Poll type: ${input.pollType}`,
        `Options: ${input.options.join(', ')}`,
        '',
        'Return JSON: {"approve": true|false, "reason": "..."}.'
      ].join('\n')
    }
  ];
  const result = await callModel(env, model, messages, REVIEW_SCHEMA);
  if (!result.ok) return result;

  const root = readJsonField(result.value);
  if (typeof root !== 'object' || root === null) return { ok: false, reason: 'bad_model_output' };
  const approve = (root as Record<string, unknown>).approve;
  if (typeof approve !== 'boolean') return { ok: false, reason: 'bad_model_output' };
  return { ok: true, value: approve };
}

const DESCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' }
  },
  required: ['description']
};

export async function enhanceDescription(
  env: AiEnv,
  model: string,
  input: DescriptionSuggestionInput,
  locale: AiLocale
): Promise<AiResult<string>> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Poll title: ${input.title}`,
        input.description ? `Current description: ${input.description}` : 'No description yet.',
        input.options.length > 0 ? `Poll options: ${input.options.join(', ')}` : 'No options yet.',
        'Write a neutral, concise description for this poll (max 2000 characters).',
        'The description should explain what the poll is about without taking a side.',
        `Answer in ${LOCALE_NAMES[locale]}.`,
        'Return JSON: {"description": "..."}.'
      ].filter((line) => line.length > 0).join('\n')
    }
  ];
  const result = await callModel(env, model, messages, DESCRIPTION_SCHEMA);
  if (!result.ok) return result;

  const root = readJsonField(result.value);
  if (typeof root !== 'object' || root === null) return { ok: false, reason: 'bad_model_output' };
  const description = (root as Record<string, unknown>).description;
  if (typeof description !== 'string') return { ok: false, reason: 'bad_model_output' };
  const trimmed = description.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > MAX_DESCRIPTION_LENGTH) return { ok: false, reason: 'bad_model_output' };
  return { ok: true, value: trimmed };
}
