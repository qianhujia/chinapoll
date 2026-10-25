// AI assistance endpoints.
//
// Every endpoint requires a signed-in account, passes the same account-age gate
// as proposals, enforces the Origin check, verifies Turnstile when it is enabled,
// and rate limits with scope `ai` and key `user:<id>`. When the `ai_provider`
// setting is off they answer 404, exactly as if they did not exist.
//
// Privacy: the draft is sent to the model and the validated suggestions go
// straight back to the caller. Nothing is logged and nothing is written to D1.

import type { HandlerEnv } from '../index';
import {
  DEFAULT_AI_MODEL,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  categorisePoll,
  enhanceDescription,
  suggestPollOptions,
  suggestTitles,
  type AiLocale
} from '../services/ai';
import { loadEnabledTopics } from './categories';
import { topicNames } from '../../shared/categories';
import { checkRateLimit } from '../services/rateLimit';
import { enforceSameOrigin } from '../services/csrf';
import { isTurnstileEnabled, turnstileSecretKey, verifyTurnstile } from '../services/turnstile';
import { requireUser } from '../services/session';
import { checkAccountAge } from '../services/users';
import { apiError } from '../../shared/http';
import type { ApiErrorCode } from '../../shared/errors';

const DEFAULT_AI_RATE_LIMIT = '10/h';
const DEFAULT_POLL_DELAY_MINUTES = 10;
const MIN_TITLE_CHARACTERS = 10;

const FAILURE_MESSAGES: Record<string, { code: ApiErrorCode; status: number }> = {
  bad_model_output: { code: 'AI_BAD_OUTPUT', status: 502 },
  timeout: { code: 'AI_TIMEOUT', status: 504 },
  model_error: { code: 'AI_UNREACHABLE', status: 502 }
};

function isLocale(value: unknown): value is AiLocale {
  return value === 'en' || value === 'zh-CN' || value === 'zh-TW';
}

export async function handleAiRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  // With the provider off the endpoints behave as if they did not exist.
  if (env.ai_provider === 'off') {
    return apiError('RESOURCE_NOT_FOUND', 404);
  }

  if (url.pathname === '/api/ai/enhance-title') {
    return handleEnhanceTitle(request, env);
  }
  if (url.pathname === '/api/ai/suggest-options') {
    return handleSuggestOptions(request, env);
  }
  if (url.pathname === '/api/ai/enhance-description') {
    return handleEnhanceDescription(request, env);
  }
  if (url.pathname === '/api/ai/categorise') {
    return handleCategorise(request, env);
  }
  return apiError('RESOURCE_NOT_FOUND', 404);
}

interface AiContext {
  body: Record<string, unknown>;
  model: string;
}

// Shared gate: sign-in, Origin, account age, Turnstile, and the `ai` rate limit.
async function openAiContext(request: Request, env: HandlerEnv): Promise<AiContext | Response> {
  if (request.method !== 'POST') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  const delayMinutes = Number(env.user_poll_delay_minutes ?? DEFAULT_POLL_DELAY_MINUTES);
  const accountAge = checkAccountAge(auth.user.createdAt, delayMinutes);
  if (!accountAge.allowed) {
    return apiError('ACCOUNT_TOO_NEW_AI', 403, {
      params: { minutes: delayMinutes },
      extra: { remainingMinutes: accountAge.remainingMinutes }
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError('INVALID_JSON', 400);
  }

  // The same Turnstile gate as the other account actions.
  if (isTurnstileEnabled(env)) {
    const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
    if (!token || !await verifyTurnstile(turnstileSecretKey(env), token, new URL(request.url).hostname)) {
      return apiError('TURNSTILE_FAILED', 403);
    }
  }

  const limited = await checkRateLimit(env, 'ai', `user:${auth.user.id}`, env.ai_rate_limit, DEFAULT_AI_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('AI_RATE_LIMIT', 429);
  }

  return { body, model: env.ai_model?.trim() || DEFAULT_AI_MODEL };
}

interface TextInput {
  title: string;
  description: string;
  locale: AiLocale;
  model: string;
}

// Reads and bounds the shared title/description input. Anything else is a 400:
// the title must be 10 to 200 characters after trimming and the description at
// most 2000.
function readText(body: Record<string, unknown>, model: string): TextInput | Response {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < MIN_TITLE_CHARACTERS || title.length > MAX_TITLE_LENGTH) {
    return apiError('TITLE_LENGTH_REQUIRED', 400, {
      params: { min: MIN_TITLE_CHARACTERS, max: MAX_TITLE_LENGTH }
    });
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return apiError('INVALID_DESCRIPTION', 400);
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return apiError('DESCRIPTION_TOO_LONG', 400, { params: { max: MAX_DESCRIPTION_LENGTH } });
  }

  if (!isLocale(body.locale)) {
    return apiError('UNSUPPORTED_LOCALE', 400);
  }

  return { title, description, locale: body.locale, model };
}

// A generic message for every model-side failure; the specific reason stays in
// the Worker so a caller cannot probe the model through error text.
function failureResponse(reason: string): Response {
  const failure = FAILURE_MESSAGES[reason] ?? FAILURE_MESSAGES.bad_model_output;
  return apiError(failure.code, failure.status, { extra: { ok: false } });
}

async function handleEnhanceTitle(request: Request, env: HandlerEnv): Promise<Response> {
  const context = await openAiContext(request, env);
  if (context instanceof Response) return context;

  const input = readText(context.body, context.model);
  if (input instanceof Response) return input;

  const result = await suggestTitles(
    env,
    input.model,
    { title: input.title, description: input.description || undefined },
    input.locale
  );
  if (!result.ok) return failureResponse(result.reason);

  return Response.json({ ok: true, suggestions: result.value }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function handleSuggestOptions(request: Request, env: HandlerEnv): Promise<Response> {
  const context = await openAiContext(request, env);
  if (context instanceof Response) return context;

  const input = readText(context.body, context.model);
  if (input instanceof Response) return input;

  const pollType = context.body.pollType;
  if (pollType !== 'single_choice' && pollType !== 'multi_choice') {
    return apiError('INVALID_POLL_TYPE', 400);
  }

  const requested = Number(context.body.count ?? 4);
  if (context.body.count !== undefined && (!Number.isSafeInteger(requested) || requested < 2 || requested > 7)) {
    return apiError('OPTION_COUNT_INVALID', 400);
  }

  const result = await suggestPollOptions(
    env,
    input.model,
    {
      title: input.title,
      description: input.description || undefined,
      pollType,
      count: requested
    },
    input.locale
  );
  if (!result.ok) return failureResponse(result.reason);

  return Response.json({ ok: true, options: result.value }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function handleEnhanceDescription(request: Request, env: HandlerEnv): Promise<Response> {
  const context = await openAiContext(request, env);
  if (context instanceof Response) return context;

  const input = readText(context.body, context.model);
  if (input instanceof Response) return input;

  const options: string[] = Array.isArray(context.body.options)
    ? context.body.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : [];

  const result = await enhanceDescription(
    env,
    input.model,
    {
      title: input.title,
      description: input.description || undefined,
      options
    },
    input.locale
  );
  if (!result.ok) return failureResponse(result.reason);

  return Response.json({ ok: true, description: result.value }, {
    headers: { 'cache-control': 'no-store' }
  });
}

// The categoriser needs no locale: it answers with a slug. The title and
// description follow the same limits as the other endpoints.
function readCategoryText(body: Record<string, unknown>): { title: string; description: string } | Response {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < MIN_TITLE_CHARACTERS || title.length > MAX_TITLE_LENGTH) {
    return apiError('TITLE_LENGTH_REQUIRED', 400, {
      params: { min: MIN_TITLE_CHARACTERS, max: MAX_TITLE_LENGTH }
    });
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return apiError('INVALID_DESCRIPTION', 400);
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return apiError('DESCRIPTION_TOO_LONG', 400, { params: { max: MAX_DESCRIPTION_LENGTH } });
  }

  return { title, description };
}

async function handleCategorise(request: Request, env: HandlerEnv): Promise<Response> {
  const context = await openAiContext(request, env);
  if (context instanceof Response) return context;

  const input = readCategoryText(context.body);
  if (input instanceof Response) return input;

  const topics = (await loadEnabledTopics(env)).map((topic) => ({
    slug: topic.slug,
    names: topicNames(topic.slug, topic.name)
  }));

  // Nothing to choose from: answer `none` without spending a model call.
  if (topics.length === 0) {
    return Response.json({ ok: true, slug: 'none' }, {
      headers: { 'cache-control': 'no-store' }
    });
  }

  const result = await categorisePoll(env, context.model, {
    title: input.title,
    description: input.description || undefined,
    topics
  });
  if (!result.ok) return failureResponse(result.reason);

  // Validate against the enabled list: anything else becomes `none`.
  return Response.json({ ok: true, slug: result.value ?? 'none' }, {
    headers: { 'cache-control': 'no-store' }
  });
}
