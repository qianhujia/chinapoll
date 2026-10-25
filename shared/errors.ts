// Stable error codes for application-controlled API errors.
//
// The public Worker answers a failing request with both:
//   { "error": { "code": "USERNAME_TAKEN", "params": {} }, "message": "username is already taken" }
//
// `message` is the canonical English text and is kept for backward compatibility
// (existing clients and non-JS consumers read it, and it is the same text the API
// returned before codes existed). `error.code` (plus structured `error.params`)
// is what the frontend translates, so one backend response renders in the
// visitor's language without the backend knowing anything about locales.
//
// The English text for a code is defined once here. Templates use `{name}`
// placeholders that are filled from the structured params, so the legacy
// `message` and the frontend translation are built from the same values.

export type ApiErrorParams = Record<string, string | number>;

export const ERROR_MESSAGES = {
  // Request shape
  BAD_REQUEST: 'bad request',
  INVALID_JSON: 'invalid JSON',
  METHOD_NOT_ALLOWED: 'method not allowed',
  POST_ONLY: 'POST only',
  UNKNOWN_OPERATION: 'unknown operation',
  UNSUPPORTED_LOCALE: 'unsupported locale',

  // Identity, sessions, and permissions
  CREDENTIALS_REQUIRED: 'username and password are required',
  INVALID_CREDENTIALS: 'invalid username or password',
  INVALID_RECOVERY_CODE: 'invalid username or recovery code',
  ACCOUNT_KEY_UNAVAILABLE: 'account key unavailable',
  LOGIN_REQUIRED: 'login required',
  USERNAME_TAKEN: 'username is already taken',
  CROSS_ORIGIN_REJECTED: 'cross-origin request rejected',
  PERMISSION_DENIED: 'you do not have permission to do that',
  PASSWORD_REQUIRED: 'password is required',
  CURRENT_PASSWORD_REQUIRED: 'current password is required',
  CURRENT_PASSWORD_INCORRECT: 'current password is incorrect',
  TURNSTILE_FAILED: 'turnstile verification failed',

  // Username and password rules (field level)
  USERNAME_INVALID: 'username must be {min}-{max} lowercase characters (letters, digits, dot, underscore, hyphen)',
  PASSWORD_TOO_SHORT: 'password must be at least {min} characters',
  PASSWORD_TOO_LONG: 'password must not exceed {max} characters',
  PASSWORD_SAME_AS_USERNAME: 'password must not be the same as the username',

  // Resources
  RESOURCE_NOT_FOUND: 'not found',
  POLL_NOT_FOUND: 'poll not found',
  COMMENT_NOT_FOUND: 'comment not found',
  INVALID_POLL_ID: 'invalid poll ID',
  INVALID_COMMENT_ID: 'invalid comment id',
  INVALID_PAGINATION: 'invalid pagination parameters',
  INVALID_PAGE: 'invalid page parameter',
  INVALID_CURSOR: 'invalid after cursor',
  INVALID_DAYS: 'invalid days parameter',
  INVALID_IDS: 'invalid ids parameter',
  INVALID_RATE_LIMIT_REQUEST: 'invalid rate limit request',
  INVALID_VIEW_REQUEST: 'invalid view request',

  // Topics and polls
  INVALID_TOPIC: 'invalid topic',
  UNKNOWN_TOPIC: 'unknown topic',
  INVALID_POLL_TYPE: 'pollType must be single_choice or multi_choice',
  POLL_NOT_OPEN: 'poll is not open',
  DUPLICATE_POLL_TITLE: 'a poll with this title is already pending or open',
  POLL_NOT_WITHDRAWABLE: 'only polls still under review can be withdrawn',
  DUPLICATE_VOTE: 'duplicate vote',
  VOTE_NOT_STORED: 'vote could not be stored',
  DUPLICATE_OPTION: 'duplicate option',
  UNKNOWN_OPTION: 'unknown option',
  OPTION_COUNT_INVALID: 'count must be an integer from 2 to 7',

  // Proposal and option rules (field level)
  TITLE_TOO_LONG: 'a poll needs a title of at most {max} characters',
  DESCRIPTION_LENGTH: 'a description must be between {min} and {max} characters',
  INVALID_DESCRIPTION: 'invalid description',
  PROPOSAL_DESCRIPTION_INVALID: 'invalid proposal description',
  PROPOSAL_TYPE_INVALID: 'a poll needs a valid type',
  DURATION_INVALID: 'duration must be one of {options}',
  POLL_OPTIONS_COUNT: 'a choice poll needs {min} to {max} options',
  OPTION_POSITION_RANGE: 'option positions must be between 1 and {max}',
  OPTION_POSITION_DUPLICATE: 'option positions must be unique',
  OPTION_LABEL_DUPLICATE: 'option labels must be unique',
  OPTION_LABEL_LENGTH: 'option {position} must be 1 to {max} characters',

  // Comments and reports
  COMMENT_REQUIRED: 'pollId and comment are required',
  COMMENT_LENGTH: 'comment must be between 5 and 140 characters',
  INVALID_REPORT_REASON: 'invalid report reason',
  INVALID_NOTE: 'invalid note',
  NOTE_NOT_ALLOWED: 'a note is only allowed with reason "other"',
  NOTE_TOO_LONG: 'a note must be at most {max} characters',

  // Account age gates
  ACCOUNT_TOO_NEW_POLL: 'new accounts can submit a poll once the account is {minutes} minutes old',
  ACCOUNT_TOO_NEW_COMMENT: 'new accounts can comment once the account is {minutes} minutes old',
  ACCOUNT_TOO_NEW_AI: 'new accounts can use AI assistance once the account is {minutes} minutes old',

  // Rate limits
  RATE_LIMIT_EXCEEDED: 'rate limit reached',
  AI_RATE_LIMIT: 'ai rate limit reached',
  COMMENT_RATE_LIMIT: 'comment rate limit reached',
  PROPOSAL_RATE_LIMIT: 'proposal rate limit reached',
  REGISTER_RATE_LIMIT: 'registration rate limit reached',
  REPORT_RATE_LIMIT: 'report rate limit reached',
  LOGIN_RATE_LIMIT: 'too many login attempts; try again later',
  RECOVERY_RATE_LIMIT: 'too many recovery attempts; try again later',
  NETWORK_ACCOUNT_LIMIT: 'too many accounts have been registered from this network',

  // AI assistance
  AI_BAD_OUTPUT: 'the model returned an unusable answer',
  AI_TIMEOUT: 'the model did not answer in time',
  AI_UNREACHABLE: 'the model could not be reached',
  TITLE_LENGTH_REQUIRED: 'a title of {min} to {max} characters is required',
  DESCRIPTION_TOO_LONG: 'a description of at most {max} characters is required',

  // Service state
  READ_ONLY: 'readonly mode enabled',
  SERVER_NOT_CONFIGURED: 'server key is not configured',
  INTERNAL_ERROR: 'internal error'
} as const;

export type ApiErrorCode = keyof typeof ERROR_MESSAGES;

// Fills `{name}` placeholders from the structured params. A placeholder with no
// matching param is left as-is so a missing value is visible rather than blank.
export function interpolateParams(template: string, params: ApiErrorParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
}

// The canonical English text for a code. Validation helpers use this so their
// legacy `error`/`message` strings and the code cannot drift apart.
export function errorMessage(code: ApiErrorCode, params: ApiErrorParams = {}): string {
  return interpolateParams(ERROR_MESSAGES[code], params);
}

export interface ApiErrorPayload {
  error: { code: ApiErrorCode; params: ApiErrorParams };
  message: string;
}

// The JSON body for an application error. `extra` carries any fields the
// endpoint already returned (for example `ok: false`) so existing clients keep
// seeing the same shape.
export function errorPayload(
  code: ApiErrorCode,
  params: ApiErrorParams = {},
  extra: Record<string, unknown> = {}
): ApiErrorPayload & Record<string, unknown> {
  return {
    ...extra,
    error: { code, params },
    message: interpolateParams(ERROR_MESSAGES[code], params)
  };
}
