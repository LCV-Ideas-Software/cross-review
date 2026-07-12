// v2.21.0 (caching): OpenAI participates in AUTOMATIC prompt caching
// through the Responses API. We add `prompt_cache_key` (pair-scoped:
// peer:caller:vN) so different review pairs do not interfere with each
// other's cache buckets, and parse `prompt_tokens_details.cached_tokens`
// from the response usage. No structural payload change beyond the new
// header — OpenAI auto-detects cacheable prefix tokens.
// v2.27.1 (cold-start hardening): SDK ctor lazy-loaded via dynamic
// import inside `client()` so the openai module tree is not pulled at
// server boot. Type-only import preserves all annotations.
import type OpenAI from "openai";
import { estimateCost, mergeCost, mergeUsage } from "../core/cost.js";
import { maxOutputTokensForPeer } from "../core/output-budget.js";
import { pairScopedCacheKey } from "../core/prompt-parts.js";
import { statusInstruction, statusJsonSchema } from "../core/status.js";
import type {
  AppConfig,
  CostEstimate,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerProbeResult,
  PeerResult,
  TokenUsage,
} from "../core/types.js";
import { BasePeerAdapter, StreamBuffer } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import {
  assertResponsesCompletion,
  assertResponsesStreamCompleted,
  assertResponsesStreamNotRefused,
  observeResponsesStreamRefusal,
  observeResponsesStreamTerminal,
  withEstimatedTerminalBilling,
} from "./terminal.js";
import { textFromOpenAIResponse, userPrompt } from "./text.js";

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type OpenAIUsage = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  total_tokens?: number | undefined;
  cache_write_tokens?: number | undefined;
  output_tokens_details?: {
    reasoning_tokens?: number | undefined;
  };
  prompt_tokens_details?: {
    cached_tokens?: number | undefined;
    cache_write_tokens?: number | undefined;
  };
  // OpenAI may return additional cache fields under input_tokens_details
  // depending on the API surface; tolerate both.
  input_tokens_details?: {
    cached_tokens?: number | undefined;
    cache_write_tokens?: number | undefined;
  };
};

type OpenAIStreamEvent = {
  type: string;
  delta?: unknown | undefined;
  // Official ResponseErrorEvent (`type: "error"`) carries these fields at
  // top level rather than under `event.error`.
  message?: string | undefined;
  code?: string | null | undefined;
  param?: string | null | undefined;
  status?: number | undefined;
  statusCode?: number | undefined;
  response?: {
    status?: string | undefined;
    incomplete_details?: {
      reason?: "max_output_tokens" | "content_filter" | string | undefined;
    } | null;
    usage?: OpenAIUsage | null | undefined;
    model?: string | undefined;
    error?: OpenAIStreamError | null | undefined;
  };
  error?: OpenAIStreamError | null | undefined;
};

type OpenAIStreamError = {
  message?: string | undefined;
  code?: string | null | undefined;
  type?: string | undefined;
  param?: string | null | undefined;
  status?: number | undefined;
  statusCode?: number | undefined;
};

type OpenAIResponseTerminal = {
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null | undefined;
  usage?: OpenAIUsage | null | undefined;
  model?: string | undefined;
  error?: OpenAIStreamError | null | undefined;
};

class OpenAIMaxOutputTokensError extends Error {
  readonly code: "openai_max_output_tokens_retryable" | "openai_max_output_tokens_exhausted";
  readonly incomplete_details = { reason: "max_output_tokens" as const };

  constructor(
    readonly model: string,
    readonly usage: TokenUsage | undefined,
    readonly cost: CostEstimate | undefined,
    readonly accounted_attempts: number,
    readonly retryable: boolean,
  ) {
    super(
      retryable
        ? `openai_max_output_tokens_retryable: ${model} returned response.incomplete/max_output_tokens; retrying once at medium effort.`
        : `openai_max_output_tokens_exhausted: ${model} returned response.incomplete/max_output_tokens after controlled recovery or without a safe recovery path.`,
    );
    this.name = "OpenAIMaxOutputTokensError";
    this.code = retryable
      ? "openai_max_output_tokens_retryable"
      : "openai_max_output_tokens_exhausted";
  }
}

export type StreamingFailureError = Error & {
  code?: string | null | undefined;
  type?: string | undefined;
  param?: string | null | undefined;
  status?: number | undefined;
  statusCode?: number | undefined;
  response?: { error?: OpenAIStreamError | null | undefined } | undefined;
};

export function streamingFailureErrorFromEvent(
  event: Pick<
    OpenAIStreamEvent,
    "type" | "response" | "error" | "message" | "code" | "param" | "status" | "statusCode"
  >,
  fallbackMessage: string,
): StreamingFailureError {
  const payload =
    event.type === "response.failed"
      ? event.response?.error
      : event.type === "error"
        ? event
        : event.error;
  const error = new Error(payload?.message ?? fallbackMessage) as StreamingFailureError;
  if (payload?.code !== undefined) error.code = payload.code;
  if (payload?.type !== undefined) error.type = payload.type;
  if (payload?.param !== undefined) error.param = payload.param;
  if (payload?.status !== undefined) error.status = payload.status;
  if (payload?.statusCode !== undefined) error.statusCode = payload.statusCode;
  error.response = { error: payload };
  return error;
}

function usageFromOpenAI(usage: OpenAIUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite =
    usage.cache_write_tokens ??
    usage.prompt_tokens_details?.cache_write_tokens ??
    usage.input_tokens_details?.cache_write_tokens ??
    0;
  const providerInput = usage.input_tokens ?? 0;
  // Provider input totals include cached reads and GPT-5.6 cache writes.
  // The canonical TokenUsage contract stores mutually exclusive buckets so
  // cost.ts can price each token exactly once.
  const freshInput = Math.max(0, providerInput - cached - cacheWrite);
  const result: TokenUsage = {
    input_tokens: usage.input_tokens === undefined ? undefined : freshInput,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
  };
  if (cached > 0) {
    result.cache_read_tokens = cached;
  }
  if (cacheWrite > 0) result.cache_write_tokens = cacheWrite;
  result.cache_provider_mode = "auto";
  return result;
}

function combinedOpenAIUsage(items: Array<TokenUsage | undefined>): TokenUsage | undefined {
  return items.some(Boolean) ? mergeUsage(items) : undefined;
}

function pricedAttemptCount(items: Array<CostEstimate | undefined>): number {
  return items.filter(
    (cost) => typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost),
  ).length;
}

// v2.21.0: caller identity is plumbed through PeerCallContext via
// `caller`. Default to "operator" when unset so legacy callers (no
// caller set) still get a stable cache key bucket.
function cacheKeyFor(adapter: { id: PeerId }, config: AppConfig, caller?: string): string {
  return pairScopedCacheKey(
    adapter.id,
    (caller as PeerId | "operator") ?? "operator",
    config.cache.schema_version,
  );
}

function isGpt56Family(model: string): boolean {
  return /^gpt-5\.6(?:-|$)/i.test(model);
}

function openAIReasoningFamily(
  model: string,
): "gpt-5.6" | "gpt-5.5-5.2" | "gpt-5.1" | "gpt-5" | "other" {
  if (isGpt56Family(model)) return "gpt-5.6";
  if (/^gpt-5\.(?:5|4|2)(?:-|$)/i.test(model)) return "gpt-5.5-5.2";
  if (/^gpt-5\.1(?:-|$)/i.test(model)) return "gpt-5.1";
  if (/^gpt-5(?:-|$)/i.test(model)) return "gpt-5";
  return "other";
}

function openAIEffort(
  value: AppConfig["reasoning_effort"][PeerId],
  model: string,
): OpenAIReasoningEffort {
  const effort = value ?? "xhigh";
  switch (openAIReasoningFamily(model)) {
    case "gpt-5.6":
      // GPT-5.6: none|low|medium|high|xhigh|max.
      if (effort === "minimal") return "low";
      if (effort === "ultra") return "max";
      return effort;
    case "gpt-5.5-5.2":
      // GPT-5.5, GPT-5.4 and GPT-5.2: none|low|medium|high|xhigh.
      if (effort === "minimal") return "low";
      if (effort === "max" || effort === "ultra") return "xhigh";
      return effort;
    case "gpt-5.1":
      // GPT-5.1: none|low|medium|high.
      if (effort === "minimal") return "low";
      if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
      return effort;
    case "gpt-5":
      // Original GPT-5: minimal|low|medium|high.
      if (effort === "none") return "minimal";
      if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
      return effort;
    case "other":
      // Preserve the legacy fallback for explicit non-GPT-5 overrides while
      // ensuring the operator-facing alias never reaches any OpenAI payload.
      if (effort === "max" || effort === "ultra") return "xhigh";
      return effort;
  }
}

function promptCacheFields(config: AppConfig, model: string, cacheKey: string) {
  if (!config.cache.enabled) return {};
  if (isGpt56Family(model)) {
    return {
      prompt_cache_key: cacheKey,
      prompt_cache_options: {
        mode: "implicit" as const,
        ttl: "30m" as const,
      },
    };
  }
  const retention: "in_memory" | "24h" = config.cache.ttl.openai === "1h" ? "24h" : "in_memory";
  return {
    prompt_cache_key: cacheKey,
    prompt_cache_retention: retention,
  };
}

// v2.27.1 (cold-start hardening): cache the SDK ctor between calls so
// the dynamic import only resolves once. Shared across OpenAI + DeepSeek
// + Grok adapters because all three drive the same `openai` package.
let _OpenAICtorPromise: Promise<typeof OpenAI> | null = null;
export function loadOpenAICtor(): Promise<typeof OpenAI> {
  if (!_OpenAICtorPromise) {
    _OpenAICtorPromise = import("openai").then((mod) => mod.default);
  }
  return _OpenAICtorPromise;
}

export class OpenAIAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "codex";
  provider = "openai";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.codex;
  }

  private async client(): Promise<OpenAI> {
    const apiKey = this.config.api_keys.codex;
    if (!apiKey) throw new Error("OPENAI_API_KEY was not found in environment variables.");
    const Ctor = await loadOpenAICtor();
    return new Ctor({ apiKey });
  }

  private assertResponseTerminal(
    response: OpenAIResponseTerminal & { output?: unknown },
    context: PeerCallContext,
    phase: "review" | "generation",
  ): void {
    const usage = usageFromOpenAI(response.usage);
    withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
      if (response.error) {
        throw streamingFailureErrorFromEvent(
          { type: "response.failed", response: { error: response.error } },
          "OpenAI response failed.",
        );
      }
      assertResponsesCompletion(response, {
        context,
        peer: this.id,
        provider: this.provider,
        model: this.model,
        phase,
      });
    });
  }

  private throwIfMaxOutputTokens(
    response: OpenAIResponseTerminal | null | undefined,
    context: PeerCallContext,
    phase: "review" | "generation",
    attempt: number,
    recoveryAlreadyTriggered: boolean,
    requestedEffort: OpenAIReasoningEffort,
    accumulatedUsage: TokenUsage[],
    accumulatedCosts: CostEstimate[],
    discardedPartialChars = 0,
  ): void {
    if (
      response?.status !== "incomplete" ||
      response.incomplete_details?.reason !== "max_output_tokens"
    ) {
      return;
    }
    const currentUsage = usageFromOpenAI(response.usage);
    const currentCost = currentUsage
      ? estimateCost(this.config, this.id, currentUsage, this.model)
      : undefined;
    if (currentUsage) accumulatedUsage.push(currentUsage);
    if (currentCost) accumulatedCosts.push(currentCost);
    const canReduceEffort =
      isGpt56Family(this.model) &&
      (requestedEffort === "high" || requestedEffort === "xhigh" || requestedEffort === "max");
    const retryable =
      !recoveryAlreadyTriggered && canReduceEffort && attempt < this.config.retry.max_attempts;
    const usage = combinedOpenAIUsage(accumulatedUsage);
    const cost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    context.emit({
      type: retryable
        ? "peer.output_limit_recovery.started"
        : "peer.output_limit_recovery.exhausted",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: retryable
        ? "GPT-5.6 Sol hit max_output_tokens; retrying once at medium effort with prior billing retained."
        : "OpenAI output remained truncated or had no safe controlled recovery path.",
      data: {
        provider: this.provider,
        configured_model: this.model,
        phase,
        reason: "max_output_tokens",
        retryable,
        recovery_effort: retryable ? "medium" : null,
        discarded_partial_chars: discardedPartialChars,
        usage: usage ?? null,
        cost: cost ?? null,
      },
    });
    throw new OpenAIMaxOutputTokensError(
      response.model ?? this.model,
      usage,
      cost,
      pricedAttemptCount(accumulatedCosts),
      retryable,
    );
  }

  private classifyWithAccumulatedBilling(
    error: unknown,
    attempt: number,
    started: number,
    accumulatedUsage: TokenUsage[],
    accumulatedCosts: CostEstimate[],
  ) {
    const failure = classifyProviderError(
      this.id,
      this.provider,
      this.model,
      error,
      attempt,
      started,
    );
    if (accumulatedUsage.length === 0 || error instanceof OpenAIMaxOutputTokensError) {
      return failure;
    }
    const providerResultSettled =
      error !== null &&
      typeof error === "object" &&
      (error as Record<string, unknown>).provider_result_settled === true;
    if (providerResultSettled) return failure;
    const priorUsage = combinedOpenAIUsage(accumulatedUsage);
    const priorCost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    const accountedPrior = pricedAttemptCount(accumulatedCosts);
    const currentUnpriced =
      failure.unpriced_attempts ??
      (typeof failure.cost?.total_cost === "number" && Number.isFinite(failure.cost.total_cost)
        ? 0
        : failure.attempts);
    const currentAccounted = Math.max(0, failure.attempts - currentUnpriced);
    const unpricedAttempts = Math.max(0, attempt - accountedPrior - currentAccounted);
    return {
      ...failure,
      usage: combinedOpenAIUsage([priorUsage, failure.usage]),
      cost: mergeCost([priorCost, failure.cost]),
      billing_status: unpricedAttempts === 0 ? ("reported" as const) : ("unknown" as const),
      ...(unpricedAttempts > 0 ? { unpriced_attempts: unpricedAttempts } : {}),
    };
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.codex);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.codex,
        message: "OPENAI_API_KEY is missing.",
      };
    }
    try {
      const probeClient = await this.client();
      await probeClient.models.list();
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.codex,
      };
    } catch (error) {
      const failure = classifyProviderError(this.id, this.provider, this.model, error, 1, started);
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.codex,
        message: failure.message,
      };
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    const outputLimitUsage: TokenUsage[] = [];
    const outputLimitCosts: CostEstimate[] = [];
    let outputLimitRecoveryTriggered = false;
    const requestedEffort = openAIEffort(
      context.reasoning_effort_override ?? this.config.reasoning_effort.codex,
      this.model,
    );
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.call.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `OpenAI review attempt ${attempt}`,
        });
        const cacheKey = cacheKeyFor({ id: this.id }, this.config, context.caller);
        const body = {
          model: this.model,
          input: [
            { role: "system" as const, content: this.systemPrompt(context) },
            {
              role: "user" as const,
              content: `${userPrompt(prompt)}\n\n${statusInstruction()}`,
            },
          ],
          text: {
            format: {
              type: "json_schema" as const,
              name: "cross_review_status",
              strict: true,
              schema: statusJsonSchema,
            },
            verbosity: "low" as const,
          },
          reasoning: {
            effort: outputLimitRecoveryTriggered ? "medium" : requestedEffort,
          },
          store: false,
          // OpenAI Responses API uses max_output_tokens, not Chat Completions max_tokens.
          max_output_tokens: maxOutputTokensForPeer(this.config, this.id),
          // GPT-5.6 replaced prompt_cache_retention with request-wide
          // prompt_cache_options; older families keep the legacy policy.
          ...promptCacheFields(this.config, this.model, cacheKey),
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "response.output_text.delta",
            attempt,
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let responseCompleted = false;
          let responseRefused = false;
          const reviewClient = await this.client();
          const stream = await reviewClient.responses.create(
            { ...body, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<OpenAIStreamEvent>) {
            responseRefused = observeResponsesStreamRefusal(event, responseRefused);
            if (event.type === "response.incomplete") {
              const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
              if (event.response?.incomplete_details?.reason === "max_output_tokens") {
                outputLimitRecoveryTriggered = true;
              }
              this.throwIfMaxOutputTokens(
                {
                  ...event.response,
                  status: event.response?.status ?? "incomplete",
                },
                context,
                "review",
                attempt,
                recoveryAlreadyTriggered,
                requestedEffort,
                outputLimitUsage,
                outputLimitCosts,
                stream_buffer.text().length,
              );
            }
            const eventUsage = usageFromOpenAI(event.response?.usage);
            responseCompleted = withEstimatedTerminalBilling(
              this.config,
              this.id,
              this.model,
              eventUsage,
              () =>
                observeResponsesStreamTerminal(event, responseCompleted, {
                  context,
                  peer: this.id,
                  provider: this.provider,
                  model: this.model,
                  phase: "review",
                }),
            );
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = eventUsage;
              modelReported = event.response?.model;
            } else if (
              event.type === "response.failed" ||
              event.type === "error" ||
              event.type === "response.error"
            ) {
              withEstimatedTerminalBilling(this.config, this.id, this.model, eventUsage, () => {
                throw streamingFailureErrorFromEvent(event, "OpenAI streaming response failed.");
              });
            }
          }
          withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
            assertResponsesStreamCompleted(responseCompleted, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "review",
            });
            assertResponsesStreamNotRefused(responseRefused, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "review",
            });
          });
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          const currentUsage = usage;
          const allUsage = combinedOpenAIUsage([...outputLimitUsage, currentUsage]);
          const currentCost = currentUsage
            ? estimateCost(this.config, this.id, currentUsage, this.model)
            : undefined;
          const allCosts = [...outputLimitCosts, currentCost];
          return this.resultFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage: allUsage,
            ...(outputLimitUsage.length > 0
              ? {
                  costOverride: mergeCost(allCosts),
                  accountedAttemptsOverride: pricedAttemptCount(allCosts),
                }
              : {}),
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const reviewClient = await this.client();
        const response = await reviewClient.responses.create(
          body as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          {
            signal: context.signal,
            timeout: this.config.retry.timeout_ms,
          },
        );
        const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
        if (response.incomplete_details?.reason === "max_output_tokens") {
          outputLimitRecoveryTriggered = true;
        }
        this.throwIfMaxOutputTokens(
          response,
          context,
          "review",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          outputLimitUsage,
          outputLimitCosts,
        );
        this.assertResponseTerminal(response, context, "review");
        const currentUsage = usageFromOpenAI(response.usage);
        const allUsage = combinedOpenAIUsage([...outputLimitUsage, currentUsage]);
        const currentCost = currentUsage
          ? estimateCost(this.config, this.id, currentUsage, this.model)
          : undefined;
        const allCosts = [...outputLimitCosts, currentCost];
        return this.resultFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: allUsage,
          ...(outputLimitUsage.length > 0
            ? {
                costOverride: mergeCost(allCosts),
                accountedAttemptsOverride: pricedAttemptCount(allCosts),
              }
            : {}),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "review", attempt);
        return this.classifyWithAccumulatedBilling(
          error,
          attempt,
          started,
          outputLimitUsage,
          outputLimitCosts,
        );
      },
      { signal: context.signal },
    );
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    const started = Date.now();
    const outputLimitUsage: TokenUsage[] = [];
    const outputLimitCosts: CostEstimate[] = [];
    let outputLimitRecoveryTriggered = false;
    const requestedEffort = openAIEffort(
      context.reasoning_effort_override ?? this.config.reasoning_effort.codex,
      this.model,
    );
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.generate.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `OpenAI generation attempt ${attempt}`,
        });
        const cacheKey = cacheKeyFor({ id: this.id }, this.config, context.caller);
        const body = {
          model: this.model,
          input: [
            { role: "system" as const, content: this.systemPrompt(context) },
            { role: "user" as const, content: userPrompt(prompt) },
          ],
          reasoning: {
            effort: outputLimitRecoveryTriggered ? "medium" : requestedEffort,
          },
          store: false,
          max_output_tokens: maxOutputTokensForPeer(this.config, this.id),
          ...promptCacheFields(this.config, this.model, cacheKey),
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "response.output_text.delta",
            attempt,
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let responseCompleted = false;
          let responseRefused = false;
          const generateClient = await this.client();
          const stream = await generateClient.responses.create(
            { ...body, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<OpenAIStreamEvent>) {
            responseRefused = observeResponsesStreamRefusal(event, responseRefused);
            if (event.type === "response.incomplete") {
              const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
              if (event.response?.incomplete_details?.reason === "max_output_tokens") {
                outputLimitRecoveryTriggered = true;
              }
              this.throwIfMaxOutputTokens(
                {
                  ...event.response,
                  status: event.response?.status ?? "incomplete",
                },
                context,
                "generation",
                attempt,
                recoveryAlreadyTriggered,
                requestedEffort,
                outputLimitUsage,
                outputLimitCosts,
                stream_buffer.text().length,
              );
            }
            const eventUsage = usageFromOpenAI(event.response?.usage);
            responseCompleted = withEstimatedTerminalBilling(
              this.config,
              this.id,
              this.model,
              eventUsage,
              () =>
                observeResponsesStreamTerminal(event, responseCompleted, {
                  context,
                  peer: this.id,
                  provider: this.provider,
                  model: this.model,
                  phase: "generation",
                }),
            );
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = eventUsage;
              modelReported = event.response?.model;
            } else if (
              event.type === "response.failed" ||
              event.type === "error" ||
              event.type === "response.error"
            ) {
              withEstimatedTerminalBilling(this.config, this.id, this.model, eventUsage, () => {
                throw streamingFailureErrorFromEvent(event, "OpenAI streaming response failed.");
              });
            }
          }
          withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
            assertResponsesStreamCompleted(responseCompleted, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "generation",
            });
            assertResponsesStreamNotRefused(responseRefused, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "generation",
            });
          });
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          const currentUsage = usage;
          const allUsage = combinedOpenAIUsage([...outputLimitUsage, currentUsage]);
          const currentCost = currentUsage
            ? estimateCost(this.config, this.id, currentUsage, this.model)
            : undefined;
          const allCosts = [...outputLimitCosts, currentCost];
          return this.generationFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage: allUsage,
            ...(outputLimitUsage.length > 0
              ? {
                  costOverride: mergeCost(allCosts),
                  accountedAttemptsOverride: pricedAttemptCount(allCosts),
                }
              : {}),
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const generateClient = await this.client();
        const response = await generateClient.responses.create(
          body as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          {
            signal: context.signal,
            timeout: this.config.retry.timeout_ms,
          },
        );
        const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
        if (response.incomplete_details?.reason === "max_output_tokens") {
          outputLimitRecoveryTriggered = true;
        }
        this.throwIfMaxOutputTokens(
          response,
          context,
          "generation",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          outputLimitUsage,
          outputLimitCosts,
        );
        this.assertResponseTerminal(response, context, "generation");
        const currentUsage = usageFromOpenAI(response.usage);
        const allUsage = combinedOpenAIUsage([...outputLimitUsage, currentUsage]);
        const currentCost = currentUsage
          ? estimateCost(this.config, this.id, currentUsage, this.model)
          : undefined;
        const allCosts = [...outputLimitCosts, currentCost];
        return this.generationFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: allUsage,
          ...(outputLimitUsage.length > 0
            ? {
                costOverride: mergeCost(allCosts),
                accountedAttemptsOverride: pricedAttemptCount(allCosts),
              }
            : {}),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "generation", attempt);
        return this.classifyWithAccumulatedBilling(
          error,
          attempt,
          started,
          outputLimitUsage,
          outputLimitCosts,
        );
      },
      { signal: context.signal },
    );
  }
}
