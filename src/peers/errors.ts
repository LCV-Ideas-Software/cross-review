import type { PeerFailure, PeerId } from "../core/types.js";
import { safeErrorMessage } from "../security/redact.js";

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
  const message = safeErrorMessage(error);
  const contextual429 =
    /\b(?:http|status|statuscode|code|error)\s*[:=]?\s*["'(]?\s*429\b/i.test(message) ||
    /\b429\s+(?:too many requests|rate[-_\s]?limit|quota|retry-after)\b/i.test(message);
  const rateLimited =
    contextual429 ||
    /\b(?:too many requests|rate[-_\s]?limit(?:ed|ing)?|quota exceeded|resource_exhausted|retry-after)\b/i.test(
      message,
    );
  const auth =
    /\b(?:401|403|unauthorized|forbidden|invalid api key|missing api key|expired api key|authentication failed|authentication required)\b/i.test(
      message,
    );
  const cancelled =
    /\b(?:aborterror|operation was aborted|call cancelled|session_cancelled)\b/i.test(message);
  const moderation =
    /\b(?:invalid_prompt|prompt[_\s-]?flagged|moderation|moderated|safety policy|safety system|usage policy|responsibleaipolicyviolation|content[_\s-]?filter|blocked by policy|policy violation|could not be processed|input was rejected)\b/i.test(
      message,
    );
  const timeout = /\b(?:timeout|aborted|aborterror)\b/i.test(message);
  const network = /\b(?:econnreset|enotfound|etimedout|network|fetch failed)\b/i.test(message);
  const gateway5xx = GATEWAY_5XX_RE.test(message);
  const providerOverloaded = /\b(?:overloaded_error|overloaded)\b/i.test(message);

  const failureClass = auth
    ? "auth"
    : cancelled
      ? "cancelled"
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
    if (paramMatch && (STATUS_4XX_RE.test(message) || /\bnot\s+supported\b/i.test(message))) {
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
      !cancelled &&
      !auth &&
      (rateLimited || timeout || network || gateway5xx || providerOverloaded),
    recovery_hint:
      rateLimited || providerOverloaded
        ? "wait_and_retry"
        : moderation
          ? "reformulate_and_retry"
          : docsHint
            ? "consult_docs_then_revise"
            : undefined,
    reformulation_advice: moderation
      ? "Rephrase the request in neutral technical language, compact prior peer discussion, avoid quoting flagged text, and keep the same engineering intent."
      : docsAdvice,
    retry_after_ms: extractRetryAfterMs(error),
    attempts,
    latency_ms: Date.now() - started,
    docs_hint: docsHint,
  };
}
