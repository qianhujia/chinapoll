// Cloudflare Workers AI assistance for drafting polls.
//
// Privacy: the prompt and the model response are never logged and never written
// to D1. The draft the user typed is sent to the model and the validated result
// goes straight back to the caller.
//
// The model is asked for structured JSON through `response_format`, and the
// result is passed through a strict parser: array type, item count, string
// type, trimmed length, no markdown, and no duplicates. Anything that does not
// match is rejected so a caller never sees a malformed suggestion.

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

// Calls the model binding. Kept as a single seam so tests can stub `env.AI`.
export async function runModel(
  env: AiEnv,
  model: string,
  messages: Array<{ role: string; content: string }>,
  jsonSchema: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
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
  /** The enabled categories the model may choose from. */
  categories: ReadonlyArray<{ slug: string; names: { en: string } }>;
}

// Asks the model for exactly one enabled slug, or `none`. The answer is validated
// against the enabled list and anything else (including `none`) becomes null, so a
// caller can never store a slug that is not enabled. The input is never logged.
export async function categorisePoll(
  env: AiEnv,
  model: string,
  input: CategoriseInput
): Promise<AiResult<string | null>> {
  const enabled = new Set(input.categories.map((category) => category.slug));
  const listing = input.categories.map((category) => `- ${category.slug}: ${category.names.en}`).join('\n');
  const messages = [
    { role: 'system', content: CATEGORISE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Poll title: ${input.title}`,
        input.description ? `Poll description: ${input.description}` : '',
        'Choose exactly one category for this poll from this list:',
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
