import type { CostEstimate, PeerFailure, PeerId, TokenUsage } from "../core/types.js";
import { indeterminateSpendMarkerFor } from "../core/types.js";
import { redactJsonValue, safeErrorMessage } from "../security/redact.js";

// v2.4.0 / audit closure (P2.7): extract `Retry-After` from provider
// SDK error objects. Anthropic, OpenAI, Google GenAI and the OpenAI-
// compatible DeepSeek client all surface this header through `error.headers`
// (fetch-style) or `error.response.headers` (legacy axios-style). The
// retry loop already consumes `failure.retry_after_ms`, so honoring the
// server-authoritative hint is a one-place fix that helps every provider
// at once. Returns ms or undefined.
function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidates: unknown[] = [];
  const errorObj = error as Record<string, unknown>;
  if (errorObj.headers) candidates.push(errorObj.headers);
  const response = errorObj.response;
  if (response && typeof response === "object") {
    const respHeaders = (response as Record<string, unknown>).headers;
    if (respHeaders) candidates.push(respHeaders);
  }
  for (const headers of candidates) {
    let value: string | undefined;
    if (headers && typeof (headers as { get?: unknown }).get === "function") {
      try {
        value =
          (headers as { get: (key: string) => string | null }).get("retry-after") ?? undefined;
      } catch {
        // some Headers implementations throw on missing key — ignore.
      }
    } else if (headers && typeof headers === "object") {
      const h = headers as Record<string, unknown>;
      const raw = h["retry-after"] ?? h["Retry-After"];
      if (typeof raw === "string") value = raw;
      else if (typeof raw === "number" && Number.isFinite(raw)) value = String(raw);
    }
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // Numeric (delta-seconds).
    const seconds = Number.parseFloat(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    // HTTP-date.
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) {
      const delta = date - Date.now();
      if (delta > 0) return delta;
      return 0;
    }
  }
  return undefined;
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const errorObj = error as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"]) {
    const status = numericStatus(errorObj[key]);
    if (status !== undefined) return status;
  }
  const response = errorObj.response;
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    for (const key of ["status", "statusCode", "code"]) {
      const status = numericStatus(responseObj[key]);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

function collectStringField(values: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) values.push(value.trim().toLowerCase());
}

function extractProviderErrorSignals(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const values: string[] = [];
  const errorObj = error as Record<string, unknown>;
  collectStringField(values, errorObj.code);
  collectStringField(values, errorObj.type);
  collectStringField(values, errorObj.stop_reason);
  const nestedError = errorObj.error;
  if (nestedError && typeof nestedError === "object") {
    const nested = nestedError as Record<string, unknown>;
    collectStringField(values, nested.code);
    collectStringField(values, nested.type);
    collectStringField(values, nested.stop_reason);
  }
  const stopDetails = errorObj.stop_details;
  if (stopDetails && typeof stopDetails === "object") {
    const nested = stopDetails as Record<string, unknown>;
    collectStringField(values, nested.type);
    collectStringField(values, nested.category);
  }
  const response = errorObj.response;
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    collectStringField(values, responseObj.code);
    collectStringField(values, responseObj.type);
    collectStringField(values, responseObj.stop_reason);
    const responseError = responseObj.error;
    if (responseError && typeof responseError === "object") {
      const nested = responseError as Record<string, unknown>;
      collectStringField(values, nested.code);
      collectStringField(values, nested.type);
      collectStringField(values, nested.stop_reason);
    }
    const responseStopDetails = responseObj.stop_details;
    if (responseStopDetails && typeof responseStopDetails === "object") {
      const nested = responseStopDetails as Record<string, unknown>;
      collectStringField(values, nested.type);
      collectStringField(values, nested.category);
    }
  }
  return values.join(" ");
}

// v9.1.0 (CROSREV-50): the provider's error object, preserved rather than
// discarded.
//
// `extractProviderErrorSignals` above already reads `type` and `code` from
// every nesting level a provider uses — and then throws the values away,
// because it lowercases everything into one string for regex matching. That
// loss is what made a `provider_error` undiagnosable after the fact: `message`
// alone cannot separate a 400 rejecting our request body from an asynchronous
// failure of an already-created background job.
//
// Nothing new is instrumented here. The same objects are walked; the original
// values are kept.
const PROVIDER_ERROR_BODY_MAX_CHARS = 4_096;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    // A provider may report `code` numerically — Perplexity answers
    // `{"error":{"type":"invalid_request","code":400}}` — so a finite number is
    // a legitimate value here, not a type error to skip.
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * The objects a provider error can carry its structured fields in, most
 * specific first. The nested `error` wins over its container because that is
 * where every provider in this fleet puts the real diagnosis.
 */
function providerErrorCandidates(error: unknown): Record<string, unknown>[] {
  const root = asRecord(error);
  if (!root) return [];
  const response = asRecord(root.response);
  const body = asRecord(root.body) ?? asRecord(response?.data) ?? asRecord(response?.body);
  return [
    asRecord(root.error),
    asRecord(body?.error),
    asRecord(response?.error),
    body,
    response,
    root,
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
}

function extractProviderErrorDetail(
  error: unknown,
  httpStatus: number | undefined,
): PeerFailure["provider_error_detail"] {
  const candidates = providerErrorCandidates(error);
  if (candidates.length === 0 && httpStatus === undefined) return undefined;

  const type = firstString(...candidates.map((candidate) => candidate.type));
  const code = firstString(...candidates.map((candidate) => candidate.code));
  const param = firstString(...candidates.map((candidate) => candidate.param));

  // The body is serialized from the most specific object that actually carries
  // a diagnosis, so the ceiling is spent on signal rather than on SDK wrapper
  // fields. Redaction runs on the STRUCTURE before serialization, so a secret
  // nested in the body is redacted as a value rather than pattern-matched out
  // of a flat string afterwards.
  const source = candidates.find(
    (candidate) =>
      candidate.type !== undefined ||
      candidate.code !== undefined ||
      candidate.message !== undefined,
  );
  let rawBody: string | undefined;
  let truncated: boolean | undefined;
  if (source) {
    try {
      const serialized = JSON.stringify(redactJsonValue(source));
      // `{}` is what a bare `Error` serializes to, because `message` is not an
      // enumerable own property. Recording it would assert that the provider
      // returned an empty body when in fact it returned nothing to read — the
      // same false precision this field exists to remove.
      if (serialized && serialized !== "{}") {
        rawBody = serialized.slice(0, PROVIDER_ERROR_BODY_MAX_CHARS);
        if (serialized.length > PROVIDER_ERROR_BODY_MAX_CHARS) truncated = true;
      }
    } catch {
      // A body that cannot be serialized — a cycle, a BigInt, a getter that
      // throws — must never take the round down with it. Losing the body is
      // the acceptable outcome; losing the failure record is not.
      rawBody = undefined;
    }
  }

  if (
    httpStatus === undefined &&
    type === undefined &&
    code === undefined &&
    param === undefined &&
    rawBody === undefined
  ) {
    return undefined;
  }
  return {
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(param !== undefined ? { param } : {}),
    ...(rawBody !== undefined ? { raw_body: rawBody } : {}),
    ...(truncated ? { raw_body_truncated: true } : {}),
  };
}

// v2.4.0 / audit closure (P4.17): treat upstream gateway errors (502 Bad
// Gateway, 503 Service Unavailable, 504 Gateway Timeout) as retryable.
// Pre-v2.4.0 these collapsed into the generic `provider_error` class and
// the retry loop never re-tried them, even though they are textbook
// transient failures. Retain `provider_error` as the default class so
// upstream observability semantics don't change.
const GATEWAY_5XX_RE =
  /\b(?:5(?:0[234]|9\d))\b|\b(?:bad\s+gateway|service\s+unavailable|gateway\s+timeout)\b/i;

// v2.15.0 (item 5, operator directive 2026-05-04 — feedback_consult_docs_before_amputating.md):
// detect 4xx errors that cite a named provider parameter so the operator
// (and the agent reading the failure) gets a docs URL pointer FIRST,
// before considering the amputation reflex (rip the offending field out
// to silence the 400). The xAI model-specific reasoning case is the
// canonical example: `reasoning.effort` is rejected on models outside
// the adapter allowlist; the docs page lists exactly which models accept it. Surfacing the
// docs URL on the failure object makes the resolution path obvious and
// pushes the agent toward the correct fix (allowlist gate or model
// switch) rather than removing the feature.
//
// Pattern matches: "parameter X", "X is not supported", "Argument not
// supported on this model: X", "Invalid parameter: X", "Unrecognized
// request argument: X", "field X". Captures the parameter name (alphanum,
// underscore, dot for nested) for inclusion on `docs_hint.parameter`.
// Prefix form: "<keyword>: <param>" — captures the parameter name
// after a known prefix (Argument not supported on this model:, Invalid
// parameter:, Unrecognized request argument:, Unknown parameter:).
const PARAM_REJECTION_PREFIX_RE =
  /(?:argument\s+not\s+supported(?:\s+on\s+this\s+model)?\s*:|invalid\s+(?:request\s+)?(?:parameter|argument)\s*:|unrecognized\s+(?:request\s+)?(?:parameter|argument)\s*:|unknown\s+parameter\s*:)\s*["'`]?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)/i;
// Suffix form: "parameter <param> is not supported" — captures when the
// parameter precedes an explicit rejection clause.
const PARAM_REJECTION_SUFFIX_RE =
  /\b(?:parameter|field|argument)s?\s+["'`]?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)["'`]?\s+(?:is\s+(?:not\s+supported|invalid|unknown|deprecated)|not\s+supported|cannot\s+be\s+used|is\s+only\s+(?:supported|available)|requires)/i;
const STATUS_4XX_RE = /\b(?:400|404|405|409|413|415|422)\b/i;
const PROVIDER_DOCS_URLS: Record<string, string> = {
  openai: "https://platform.openai.com/docs/api-reference",
  anthropic: "https://docs.anthropic.com/en/api/messages",
  google: "https://ai.google.dev/api/generate-content",
  deepseek: "https://api-docs.deepseek.com/api/create-chat-completion",
  xai: "https://docs.x.ai/docs/api-reference",
};
// Provider-specific deep links for known sticky parameters. Looked up
// after the generic provider docs URL when a parameter rename is known.
const PROVIDER_PARAM_DOCS: Record<string, Record<string, string>> = {
  xai: {
    "reasoning.effort": "https://docs.x.ai/developers/model-capabilities/text/reasoning",
  },
  openai: {
    "reasoning.effort":
      "https://platform.openai.com/docs/api-reference/responses/create#responses-create-reasoning",
  },
  anthropic: {
    thinking: "https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking",
  },
};

export function classifyProviderError(
  peer: PeerId,
  provider: string,
  model: string,
  error: unknown,
  attempts: number,
  started: number,
): PeerFailure {
  const attachedFailure =
    error && typeof error === "object"
      ? (error as { peerFailure?: PeerFailure | undefined }).peerFailure
      : undefined;
  if (
    attachedFailure &&
    attachedFailure.peer === peer &&
    typeof attachedFailure.failure_class === "string"
  ) {
    return attachedFailure;
  }
  const message = safeErrorMessage(error);
  const httpStatus = extractHttpStatus(error);
  const providerSignals = extractProviderErrorSignals(error);
  const contextual429 =
    httpStatus === 429 ||
    /\b(?:rate_limit|rate_limit_exceeded|too_many_requests|quota_exceeded)\b/i.test(
      providerSignals,
    ) ||
    /\b(?:http|status|statuscode|code|error)\s*[:=]?\s*["'(]?\s*429\b/i.test(message) ||
    /\b429\s+(?:too many requests|rate[-_\s]?limit|quota|retry-after)\b/i.test(message);
  const rateLimited =
    contextual429 ||
    /\b(?:too many requests|rate[-_\s]?limit(?:ed|ing)?|quota exceeded|resource_exhausted|retry-after)\b/i.test(
      message,
    );
  const auth =
    httpStatus === 401 ||
    httpStatus === 403 ||
    /\b(?:401|403|unauthorized|forbidden|invalid api key|missing api key|expired api key|authentication failed|authentication required)\b/i.test(
      message,
    );
  const errorName =
    error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
      ? String((error as { name: string }).name)
      : "";
  const cancelled =
    /\baborterror\b/i.test(errorName) ||
    /\b(?:aborterror|(?:operation|request|call)\s+(?:was\s+)?(?:aborted|cancelled)|session_cancelled)\b/i.test(
      message,
    );
  const errorRecord =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const providerRefusal =
    errorRecord?.code === "provider_output_refusal" ||
    (provider.toLowerCase() === "anthropic" &&
      (/\banthropic_refusal\b|\brefusal\b/i.test(providerSignals) ||
        /\bstop_reason\b[^a-z0-9_]+refusal\b/i.test(message) ||
        /\bclaude (?:fable|opus) 5 refusal\b/i.test(message)));
  const providerTerminalRejected = errorRecord?.code === "provider_terminal_state_rejected";
  const retryableDeepSeekInsufficientResource =
    providerTerminalRejected &&
    provider.toLowerCase() === "deepseek" &&
    errorRecord?.terminal_state === "finish_reason=insufficient_system_resource";
  const providerPromptBlocked = errorRecord?.code === "provider_prompt_blocked";
  const moderation =
    providerPromptBlocked ||
    (!providerTerminalRejected &&
      (/\b(?:invalid_prompt|content_policy_violation|policy_violation)\b/i.test(providerSignals) ||
        /\b(?:invalid_prompt|prompt[_\s-]?flagged|moderation|moderated|safety policy|safety system|usage policy|responsibleaipolicyviolation|content[_\s-]?filter|blocked by policy|policy violation|could not be processed|input was rejected)\b/i.test(
          message,
        )));
  const timeout =
    /\b(?:timeout|vector_store_timeout)\b/i.test(providerSignals) ||
    /\b(?:timeout|aborted|aborterror)\b/i.test(message);
  const network = /\b(?:econnreset|enotfound|etimedout|network|fetch failed)\b/i.test(message);
  const gateway5xx =
    (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) ||
    /\b(?:server_error|internal_server_error|service_unavailable|gateway_timeout|bad_gateway|upstream_error)\b/i.test(
      providerSignals,
    ) ||
    GATEWAY_5XX_RE.test(message);
  const providerOverloaded =
    /\b(?:overloaded_error|overloaded)\b/i.test(providerSignals) ||
    /\b(?:overloaded_error|overloaded)\b/i.test(message);
  const retryableAnthropicMaxTokens =
    /\banthropic_max_tokens_retryable\b/i.test(providerSignals) ||
    /\banthropic_max_tokens_retryable\b/i.test(message);
  const retryableOpenAIMaxOutputTokens =
    /\bopenai_max_output_tokens_retryable\b/i.test(providerSignals) ||
    /\bopenai_max_output_tokens_retryable\b/i.test(message);
  const retryableGeminiMaxTokens =
    /\bgemini_max_tokens_retryable\b/i.test(providerSignals) ||
    /\bgemini_max_tokens_retryable\b/i.test(message);
  const billedUsage =
    errorRecord?.usage && typeof errorRecord.usage === "object"
      ? (errorRecord.usage as TokenUsage)
      : undefined;
  const billedCost =
    errorRecord?.cost && typeof errorRecord.cost === "object"
      ? (errorRecord.cost as CostEstimate)
      : undefined;
  const accountedAttempts =
    typeof errorRecord?.accounted_attempts === "number" &&
    Number.isInteger(errorRecord.accounted_attempts) &&
    errorRecord.accounted_attempts > 0
      ? errorRecord.accounted_attempts
      : typeof billedCost?.total_cost === "number" && Number.isFinite(billedCost.total_cost)
        ? 1
        : 0;
  const unpricedAttempts = Math.max(0, attempts - accountedAttempts);

  const failureClass = auth
    ? "auth"
    : cancelled
      ? "cancelled"
      : providerRefusal
        ? "provider_refusal"
        : moderation
          ? "prompt_flagged_by_moderation"
          : rateLimited
            ? "rate_limit"
            : timeout
              ? "timeout"
              : network
                ? "network"
                : "provider_error";

  // v2.15.0 (item 5): docs hint for 4xx parameter rejections. Only
  // applies when the failure class is `provider_error` (avoid stomping
  // on rate_limit/auth/network advice). The 4xx status check is a soft
  // gate — many SDKs surface the parameter-rejection message without an
  // explicit status code in the .message field, so we run the pattern
  // even when STATUS_4XX_RE doesn't match, but only set docs_hint when
  // both the regex matches AND the failure isn't already a known class.
  let docsHint: { parameter: string; docs_url?: string | undefined } | undefined;
  let docsAdvice: string | undefined;
  if (failureClass === "provider_error") {
    const prefixMatch = PARAM_REJECTION_PREFIX_RE.exec(message);
    const suffixMatch = prefixMatch ? null : PARAM_REJECTION_SUFFIX_RE.exec(message);
    const paramMatch = prefixMatch ?? suffixMatch;
    const structured4xx = httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 499;
    if (
      paramMatch &&
      (structured4xx || STATUS_4XX_RE.test(message) || /\bnot\s+supported\b/i.test(message))
    ) {
      const parameter = paramMatch[1];
      if (parameter) {
        const providerKey = provider.toLowerCase();
        const deepLink = PROVIDER_PARAM_DOCS[providerKey]?.[parameter];
        const fallbackLink = PROVIDER_DOCS_URLS[providerKey];
        const docsUrl = deepLink ?? fallbackLink;
        docsHint = { parameter, docs_url: docsUrl };
        docsAdvice =
          `Provider rejected parameter "${parameter}". HARD RULE (workspace memory feedback_consult_docs_before_amputating): consult official docs FIRST` +
          (docsUrl ? ` at ${docsUrl}` : "") +
          ", do NOT amputate the field to silence the 400. Likely fix: gate the field on a model-capability allowlist (see peers/grok.ts GROK_REASONING_EFFORT_MODELS for precedent), or switch to a model that accepts it.";
      }
    }
  }

  return {
    peer,
    provider,
    model,
    failure_class: failureClass,
    message,
    retryable:
      (!providerTerminalRejected || retryableDeepSeekInsufficientResource) &&
      !providerPromptBlocked &&
      !cancelled &&
      !auth &&
      !providerRefusal &&
      (rateLimited ||
        timeout ||
        network ||
        gateway5xx ||
        providerOverloaded ||
        retryableAnthropicMaxTokens ||
        retryableOpenAIMaxOutputTokens ||
        retryableGeminiMaxTokens ||
        retryableDeepSeekInsufficientResource),
    recovery_hint: providerRefusal
      ? "reformulate_and_retry"
      : rateLimited || providerOverloaded || retryableDeepSeekInsufficientResource
        ? "wait_and_retry"
        : moderation
          ? "reformulate_and_retry"
          : docsHint
            ? "consult_docs_then_revise"
            : undefined,
    reformulation_advice:
      moderation || providerRefusal
        ? "Rephrase the request in neutral technical language, compact prior peer discussion, avoid quoting flagged text, and keep the same engineering intent. If an Anthropic classifier refusal persists, any model change must remain an explicit operator choice; do not silently downgrade."
        : docsAdvice,
    retry_after_ms: extractRetryAfterMs(error),
    attempts,
    latency_ms: Date.now() - started,
    ...(billedUsage ? { usage: billedUsage } : {}),
    ...(billedCost ? { cost: billedCost } : {}),
    billing_status: billedUsage || billedCost ? "reported" : "unknown",
    ...(unpricedAttempts > 0
      ? {
          unpriced_attempts: unpricedAttempts,
          indeterminate_spend_attempts: indeterminateSpendMarkerFor(
            failureClass,
            message,
            unpricedAttempts,
          ),
        }
      : {}),
    docs_hint: docsHint,
    provider_error_detail: extractProviderErrorDetail(error, httpStatus),
  };
}
