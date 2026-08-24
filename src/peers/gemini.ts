// v2.27.1 (cold-start hardening): SDK lazy-loaded via dynamic import
// inside `client()` so the @google/genai module tree is not pulled at
// server boot. The `ThinkingLevel` enum is also runtime — exposed via
// the loader's return shape so `geminiThinkingConfig` keeps a stable
// signature without re-importing the module per call. Type-only import
// preserves all annotations.
import type { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { estimateCost, mergeCost, mergeUsage } from "../core/cost.js";
import { maxOutputTokensForPeer } from "../core/output-budget.js";
import { hashStablePrefix } from "../core/prompt-parts.js";
import { geminiStatusJsonSchema, statusInstruction } from "../core/status.js";
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
import { indeterminateSpendMarkerFor } from "../core/types.js";
import { BasePeerAdapter, StreamBuffer } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import {
  assertGeminiCompletion,
  assertGeminiStreamCompleted,
  observeGeminiStreamTerminals,
} from "./terminal.js";
import { userPrompt } from "./text.js";

type GeminiUsage = {
  promptTokenCount?: number | undefined;
  candidatesTokenCount?: number | undefined;
  totalTokenCount?: number | undefined;
  thoughtsTokenCount?: number | undefined;
  // v2.21.0 (caching): Gemini supports an IMPLICIT cache that is auto-
  // applied. We only consume telemetry — no payload changes. When the
  // service caches a prefix it reports `cachedContentTokenCount`; we
  // surface this as cache_read_tokens with mode="implicit". Explicit
  // `caches.create` is intentionally NOT enabled here (deferred to a
  // future ship) to avoid contention with `thinking` configurations.
  cachedContentTokenCount?: number | undefined;
};

type GeminiResponse = {
  text?: string | undefined;
  modelVersion?: string | undefined;
  usageMetadata?: GeminiUsage | undefined;
  promptFeedback?: { blockReason?: unknown } | null | undefined;
  candidates?: Array<{ index?: number | undefined; finishReason?: unknown }> | null | undefined;
};

class GeminiMaxTokensError extends Error {
  readonly code: "gemini_max_tokens_retryable" | "gemini_max_tokens_exhausted";
  readonly finishReason = "MAX_TOKENS";

  constructor(
    readonly model: string,
    readonly usage: TokenUsage | undefined,
    readonly cost: CostEstimate | undefined,
    readonly accounted_attempts: number,
    readonly retryable: boolean,
  ) {
    super(
      retryable
        ? `gemini_max_tokens_retryable: ${model} returned finishReason=MAX_TOKENS; retrying once at MEDIUM thinking.`
        : `gemini_max_tokens_exhausted: ${model} returned finishReason=MAX_TOKENS after controlled recovery or without a safe recovery path.`,
    );
    this.name = "GeminiMaxTokensError";
    this.code = retryable ? "gemini_max_tokens_retryable" : "gemini_max_tokens_exhausted";
  }
}

export const GEMINI_RESPONSE_MISSING_TEXT_WARNING = "gemini_response_missing_text";

export function geminiTextWithWarning(
  response: ({ text?: string | undefined } & Record<string, unknown>) | undefined,
): {
  text: string;
  parser_warnings: string[];
} {
  if (response?.text !== undefined) {
    return { text: response.text, parser_warnings: [] };
  }
  return { text: "", parser_warnings: [GEMINI_RESPONSE_MISSING_TEXT_WARNING] };
}

function usageFromGemini(usage: GeminiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cachedContentTokenCount ?? 0;
  // Gemini's promptTokenCount includes cachedContentTokenCount. Canonical
  // TokenUsage keeps fresh input and cache-read buckets mutually exclusive so
  // cost accounting cannot charge the cached prefix twice.
  const freshInput =
    usage.promptTokenCount === undefined ? undefined : Math.max(0, usage.promptTokenCount - cached);
  const billableOutput =
    usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
      ? undefined
      : (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const result: TokenUsage = {
    input_tokens: freshInput,
    // Gemini prices visible candidate tokens plus thinking tokens at the
    // output rate. reasoning_tokens remains a diagnostic sub-bucket and is
    // not added again by cost.ts.
    output_tokens: billableOutput,
    total_tokens: usage.totalTokenCount,
    reasoning_tokens: usage.thoughtsTokenCount,
  };
  if (cached > 0) {
    result.cache_read_tokens = cached;
    result.cache_provider_mode = "implicit";
  } else {
    result.cache_provider_mode = "not_supported";
  }
  return result;
}

function combinedGeminiUsage(items: Array<TokenUsage | undefined>): TokenUsage | undefined {
  return items.some(Boolean) ? mergeUsage(items) : undefined;
}

function pricedGeminiAttemptCount(items: Array<CostEstimate | undefined>): number {
  return items.filter(
    (cost) => typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost),
  ).length;
}

export function geminiThinkingConfig(
  model: string,
  ThinkingLevelEnum: typeof ThinkingLevel,
  effort: AppConfig["reasoning_effort"][PeerId],
): {
  includeThoughts: false;
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
} {
  if (/gemini-3/i.test(model)) {
    const thinkingLevel =
      effort === "medium"
        ? ThinkingLevelEnum.MEDIUM
        : effort === "none" || effort === "minimal" || effort === "low"
          ? ThinkingLevelEnum.LOW
          : ThinkingLevelEnum.HIGH;
    return { includeThoughts: false, thinkingLevel };
  }
  return { includeThoughts: false, thinkingBudget: -1 };
}

// v2.27.1 (cold-start hardening): cache the @google/genai module promise
// so the dynamic import resolves exactly once across all callers.
// Exported so peers/model-selection.ts can share the same module promise.
let _genaiModulePromise: Promise<typeof import("@google/genai")> | null = null;
export function loadGenaiModule(): Promise<typeof import("@google/genai")> {
  if (!_genaiModulePromise) _genaiModulePromise = import("@google/genai");
  return _genaiModulePromise;
}

// v4.7.0 (CROSREV-6): opt-in explicit context cache. The orchestrator marks
// the review prompt's stable head (contract + review focus + attached
// evidence) through context.prompt_stable_prefix_chars; when the gate is
// armed (cache.enabled && cache.gemini_explicit && !disable_per_peer.gemini)
// and the head reaches the documented 4,096-token cachedContents minimum for
// the 3.x/2.5 Pro models (approximated at 4 chars/token, the same
// convention anthropic.ts uses), the adapter creates ONE cachedContents
// entry per distinct (schema, model, ttl, head) and calls generateContent
// with `cachedContent` plus only the dynamic remainder; the system prompt
// travels as a live `systemInstruction` because it changes per round.
// Storage is billed deterministically at creation (cached tokens x TTL
// hours) and surfaced once as usage.cache_storage_token_hours; reads keep
// the provider-reported cachedContentTokenCount discount with
// cache_provider_mode="explicit". Creation failures fall back to the
// uncached request with a provider.cache.notice; a lost/expired cache
// surfaces as a retryable provider error after the index entry is dropped,
// so the standard retry envelope re-creates it.
export const GEMINI_EXPLICIT_CACHE_MIN_TOKENS = 4_096;
const GEMINI_EXPLICIT_CACHE_MIN_CHARS = GEMINI_EXPLICIT_CACHE_MIN_TOKENS * 4;

type GeminiExplicitCacheEntry = { name: string; token_count: number; expires_at_ms: number };
const geminiExplicitCacheIndex = new Map<string, GeminiExplicitCacheEntry>();

export function __resetGeminiExplicitCacheIndexForTests(): void {
  geminiExplicitCacheIndex.clear();
}

function geminiTtlSeconds(ttl: "5m" | "1h"): number {
  return ttl === "5m" ? 300 : 3_600;
}

function geminiExplicitCacheArmed(config: AppConfig): boolean {
  return (
    config.cache.enabled && config.cache.gemini_explicit && !config.cache.disable_per_peer.gemini
  );
}

export class GeminiAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "gemini";
  provider = "google";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.gemini;
  }

  private async client(): Promise<{ ai: GoogleGenAI; ThinkingLevel: typeof ThinkingLevel }> {
    const apiKey = this.config.api_keys.gemini;
    if (!apiKey) throw new Error("GEMINI_API_KEY was not found in environment variables.");
    const genai = await loadGenaiModule();
    return { ai: new genai.GoogleGenAI({ apiKey }), ThinkingLevel: genai.ThinkingLevel };
  }

  private throwIfMaxTokens(
    response: GeminiResponse | undefined,
    context: PeerCallContext,
    phase: "review" | "generation",
    attempt: number,
    recoveryAlreadyTriggered: boolean,
    requestedEffort: AppConfig["reasoning_effort"][PeerId],
    accumulatedUsage: TokenUsage[],
    accumulatedCosts: CostEstimate[],
    discardedPartialChars = 0,
  ): void {
    const maxTokens = response?.candidates?.some(
      (candidate) => String(candidate.finishReason ?? "").toUpperCase() === "MAX_TOKENS",
    );
    if (!maxTokens) return;
    const currentUsage = usageFromGemini(response?.usageMetadata);
    const currentCost = currentUsage
      ? estimateCost(this.config, this.id, currentUsage, this.model)
      : undefined;
    if (currentUsage) accumulatedUsage.push(currentUsage);
    if (currentCost) accumulatedCosts.push(currentCost);
    const highThinkingRequested =
      requestedEffort === "high" ||
      requestedEffort === "xhigh" ||
      requestedEffort === "max" ||
      requestedEffort === "ultra";
    const retryable =
      !recoveryAlreadyTriggered &&
      /gemini-3/i.test(this.model) &&
      highThinkingRequested &&
      attempt < this.config.retry.max_attempts;
    const usage = combinedGeminiUsage(accumulatedUsage);
    const cost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    context.emit({
      type: retryable
        ? "peer.output_limit_recovery.started"
        : "peer.output_limit_recovery.exhausted",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: retryable
        ? "Gemini hit MAX_TOKENS; retrying once at MEDIUM thinking with prior billing retained."
        : "Gemini output remained truncated or had no safe controlled recovery path.",
      data: {
        provider: this.provider,
        configured_model: this.model,
        phase,
        reason: "MAX_TOKENS",
        retryable,
        recovery_effort: retryable ? "medium" : null,
        discarded_partial_chars: discardedPartialChars,
        usage: usage ?? null,
        cost: cost ?? null,
      },
    });
    throw new GeminiMaxTokensError(
      response?.modelVersion ?? this.model,
      usage,
      cost,
      pricedGeminiAttemptCount(accumulatedCosts),
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
    if (accumulatedUsage.length === 0 || error instanceof GeminiMaxTokensError) return failure;
    const providerResultSettled =
      error !== null &&
      typeof error === "object" &&
      (error as Record<string, unknown>).provider_result_settled === true;
    if (providerResultSettled) return failure;
    const priorUsage = combinedGeminiUsage(accumulatedUsage);
    const priorCost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    const accountedPrior = pricedGeminiAttemptCount(accumulatedCosts);
    const currentUnpriced =
      failure.unpriced_attempts ??
      (typeof failure.cost?.total_cost === "number" && Number.isFinite(failure.cost.total_cost)
        ? 0
        : failure.attempts);
    const currentAccounted = Math.max(0, failure.attempts - currentUnpriced);
    const unpricedAttempts = Math.max(0, attempt - accountedPrior - currentAccounted);
    return {
      ...failure,
      usage: combinedGeminiUsage([priorUsage, failure.usage]),
      cost: mergeCost([priorCost, failure.cost]),
      billing_status: unpricedAttempts === 0 ? ("reported" as const) : ("unknown" as const),
      ...(unpricedAttempts > 0
        ? {
            unpriced_attempts: unpricedAttempts,
            indeterminate_spend_attempts: indeterminateSpendMarkerFor(
              failure.failure_class,
              failure.message,
              unpricedAttempts,
            ),
          }
        : {}),
    };
  }

  private withResponseBilling<T>(response: GeminiResponse | undefined, check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (!error || typeof error !== "object") throw error;
      const usage = usageFromGemini(response?.usageMetadata);
      const cost = usage ? estimateCost(this.config, this.id, usage, this.model) : undefined;
      const accountedAttempts =
        typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost) ? 1 : 0;
      for (const [key, value] of [
        ["usage", usage],
        ["cost", cost],
        ["accounted_attempts", accountedAttempts],
      ] as const) {
        if (value === undefined) continue;
        Object.defineProperty(error, key, {
          configurable: true,
          enumerable: false,
          value,
        });
      }
      throw error;
    }
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.gemini);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.gemini,
        message: "GEMINI_API_KEY is missing.",
      };
    }
    try {
      const probeClient = await this.client();
      const pager = await probeClient.ai.models.list({ config: { pageSize: 1 } });
      for await (const model of pager) {
        void model;
        break;
      }
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.gemini,
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
        model_selection: this.config.model_selection.gemini,
        message: failure.message,
      };
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    const outputLimitUsage: TokenUsage[] = [];
    const outputLimitCosts: CostEstimate[] = [];
    let outputLimitRecoveryTriggered = false;
    // v4.7.0 (CROSREV-6): storage token-hours of a cache created by this
    // call, attached to the first usage that materializes (surviving
    // retries so the deterministic storage bill is never dropped).
    let cacheStorageTokenHoursPending = 0;
    const requestedEffort =
      context.reasoning_effort_override ?? this.config.reasoning_effort.gemini;
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.call.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Gemini review attempt ${attempt}`,
        });
        // AbortSignal stops the local SDK wait, not the server-side Gemini
        // generation. The request can therefore still consume tokens and be
        // billed after cancellation; accounting must keep that attempt
        // unknown unless final provider usage arrives.
        const reviewClient = await this.client();
        const stablePrefixChars = context.prompt_stable_prefix_chars ?? 0;
        const explicitCacheEligible =
          geminiExplicitCacheArmed(this.config) &&
          stablePrefixChars >= GEMINI_EXPLICIT_CACHE_MIN_CHARS &&
          stablePrefixChars < prompt.length;
        let cacheEntry: GeminiExplicitCacheEntry | undefined;
        if (explicitCacheEligible) {
          const stableHead = prompt.slice(0, stablePrefixChars);
          const ttl = this.config.cache.ttl.gemini;
          const cacheKeyHash = hashStablePrefix(
            `${this.config.cache.schema_version}\n${this.model}\n${ttl}\n${stableHead}`,
          );
          const existing = geminiExplicitCacheIndex.get(cacheKeyHash);
          // A 15s guard band avoids referencing an entry that expires while
          // the request is in flight.
          if (existing && existing.expires_at_ms > Date.now() + 15_000) {
            cacheEntry = existing;
          } else {
            try {
              const created = (await reviewClient.ai.caches.create({
                model: this.model,
                config: {
                  contents: [{ role: "user", parts: [{ text: stableHead }] }],
                  ttl: `${geminiTtlSeconds(ttl)}s`,
                  displayName: `cross-review:${cacheKeyHash.slice(0, 16)}`,
                },
              })) as { name?: string; usageMetadata?: { totalTokenCount?: number } };
              if (created?.name) {
                const tokenCount =
                  created.usageMetadata?.totalTokenCount ?? Math.ceil(stablePrefixChars / 4);
                cacheEntry = {
                  name: created.name,
                  token_count: tokenCount,
                  expires_at_ms: Date.now() + geminiTtlSeconds(ttl) * 1_000,
                };
                geminiExplicitCacheIndex.set(cacheKeyHash, cacheEntry);
                cacheStorageTokenHoursPending = (tokenCount * geminiTtlSeconds(ttl)) / 3_600;
                context.emit({
                  type: "provider.cache.notice",
                  session_id: context.session_id,
                  round: context.round,
                  peer: this.id,
                  message: `Gemini explicit cache created (${tokenCount} tokens, ttl ${ttl}).`,
                  data: {
                    model: this.model,
                    cache_name: created.name,
                    token_count: tokenCount,
                    ttl,
                    key_hash: cacheKeyHash,
                  },
                });
              }
            } catch (error) {
              // Best-effort: an uncached call is always correct; the failed
              // creation is surfaced, never fatal.
              context.emit({
                type: "provider.cache.notice",
                session_id: context.session_id,
                round: context.round,
                peer: this.id,
                message: `Gemini explicit cache creation failed; continuing uncached: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                data: { model: this.model },
              });
            }
          }
        }
        const requestConfig = {
          responseMimeType: "application/json",
          responseJsonSchema: geminiStatusJsonSchema,
          maxOutputTokens:
            context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
          thinkingConfig: geminiThinkingConfig(
            this.model,
            reviewClient.ThinkingLevel,
            outputLimitRecoveryTriggered ? "medium" : requestedEffort,
          ),
          ...(context.signal ? { abortSignal: context.signal } : {}),
        };
        const params = cacheEntry
          ? {
              model: this.model,
              // The cached head precedes these live contents server-side; the
              // per-round system prompt travels as a live systemInstruction.
              contents: `${userPrompt(prompt.slice(stablePrefixChars))}\n\n${statusInstruction()}`,
              config: {
                ...requestConfig,
                cachedContent: cacheEntry.name,
                systemInstruction: this.systemPrompt(context),
              },
            }
          : {
              model: this.model,
              contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}\n\n${statusInstruction()}`,
              config: requestConfig,
            };
        const decorateUsage = (usage: TokenUsage | undefined): TokenUsage | undefined => {
          if (!usage) return usage;
          // The aggregate merge deliberately drops per-call cache attributes;
          // re-derive the mode with usageFromGemini's per-attempt semantics:
          // explicit when this call reads through the explicit cache entry,
          // implicit for provider-side prefix caching, not_supported when
          // nothing was cached. Costs are unaffected (they are computed from
          // the per-attempt usage before the merge).
          if ((usage.cache_read_tokens ?? 0) > 0) {
            usage.cache_provider_mode = cacheEntry ? "explicit" : "implicit";
          } else {
            usage.cache_provider_mode = "not_supported";
          }
          if (cacheStorageTokenHoursPending > 0) {
            usage.cache_storage_token_hours = cacheStorageTokenHoursPending;
            cacheStorageTokenHoursPending = 0;
          }
          return usage;
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await reviewClient.ai.models.generateContentStream(params);
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "generateContentStream.text",
            attempt,
          );
          let last: GeminiResponse | undefined;
          const completedCandidates = new Set<number>();
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
            if (
              chunk.candidates?.some(
                (candidate) => String(candidate.finishReason ?? "").toUpperCase() === "MAX_TOKENS",
              )
            ) {
              outputLimitRecoveryTriggered = true;
            }
            this.throwIfMaxTokens(
              chunk,
              context,
              "review",
              attempt,
              recoveryAlreadyTriggered,
              requestedEffort,
              outputLimitUsage,
              outputLimitCosts,
              stream_buffer.text().length,
            );
            this.withResponseBilling(chunk, () =>
              observeGeminiStreamTerminals(chunk, completedCandidates, {
                context,
                peer: this.id,
                provider: this.provider,
                model: this.model,
                phase: "review",
              }),
            );
            const delta = chunk.text ?? "";
            stream_buffer.append(delta);
            tokenStream.append(delta);
          }
          this.withResponseBilling(last, () =>
            assertGeminiStreamCompleted(completedCandidates, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "review",
            }),
          );
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          const normalized = text ? { text, parser_warnings: [] } : geminiTextWithWarning(last);
          const currentUsage = usageFromGemini(last?.usageMetadata);
          // Decorate the AGGREGATE: combinedGeminiUsage (mergeUsage) does not
          // propagate per-call cache attributes, so decorating per-attempt
          // usage before the merge would lose mode/storage.
          const allUsage = decorateUsage(combinedGeminiUsage([...outputLimitUsage, currentUsage]));
          const currentCost = currentUsage
            ? estimateCost(this.config, this.id, currentUsage, this.model)
            : undefined;
          const allCosts = [...outputLimitCosts, currentCost];
          return this.resultFromText({
            text: normalized.text,
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: allUsage,
            ...(outputLimitUsage.length > 0
              ? {
                  costOverride: mergeCost(allCosts),
                  accountedAttemptsOverride: pricedGeminiAttemptCount(allCosts),
                }
              : {}),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
            extraParserWarnings: normalized.parser_warnings,
          });
        }
        const response = (await reviewClient.ai.models.generateContent(params)) as GeminiResponse;
        const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
        if (
          response.candidates?.some(
            (candidate) => String(candidate.finishReason ?? "").toUpperCase() === "MAX_TOKENS",
          )
        ) {
          outputLimitRecoveryTriggered = true;
        }
        this.throwIfMaxTokens(
          response,
          context,
          "review",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          outputLimitUsage,
          outputLimitCosts,
        );
        this.withResponseBilling(response, () =>
          assertGeminiCompletion(response, {
            context,
            peer: this.id,
            provider: this.provider,
            model: this.model,
            phase: "review",
          }),
        );
        const normalized = geminiTextWithWarning(response);
        const currentUsage = usageFromGemini(response.usageMetadata);
        // Decorate the AGGREGATE (see the streaming branch note above).
        const allUsage = decorateUsage(combinedGeminiUsage([...outputLimitUsage, currentUsage]));
        const currentCost = currentUsage
          ? estimateCost(this.config, this.id, currentUsage, this.model)
          : undefined;
        const allCosts = [...outputLimitCosts, currentCost];
        return this.resultFromText({
          text: normalized.text,
          raw: response,
          usage: allUsage,
          ...(outputLimitUsage.length > 0
            ? {
                costOverride: mergeCost(allCosts),
                accountedAttemptsOverride: pricedGeminiAttemptCount(allCosts),
              }
            : {}),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
          extraParserWarnings: normalized.parser_warnings,
        });
      },
      (error, attempt) => {
        // A generateContent failure that names the cached content means the
        // entry was lost or expired server-side: drop it so the retry (or
        // the next round) re-creates instead of failing repeatedly.
        if (error instanceof Error && /cached\s*content|cachedContents\//i.test(error.message)) {
          for (const [key, entry] of geminiExplicitCacheIndex) {
            if (error.message.includes(entry.name)) geminiExplicitCacheIndex.delete(key);
          }
        }
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
    const requestedEffort =
      context.reasoning_effort_override ?? this.config.reasoning_effort.gemini;
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.generate.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Gemini generation attempt ${attempt}`,
        });
        const generateClient = await this.client();
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}`,
          config: {
            maxOutputTokens:
              context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
            thinkingConfig: geminiThinkingConfig(
              this.model,
              generateClient.ThinkingLevel,
              outputLimitRecoveryTriggered ? "medium" : requestedEffort,
            ),
            ...(context.signal ? { abortSignal: context.signal } : {}),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await generateClient.ai.models.generateContentStream(params);
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "generateContentStream.text",
            attempt,
          );
          let last: GeminiResponse | undefined;
          const completedCandidates = new Set<number>();
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
            if (
              chunk.candidates?.some(
                (candidate) => String(candidate.finishReason ?? "").toUpperCase() === "MAX_TOKENS",
              )
            ) {
              outputLimitRecoveryTriggered = true;
            }
            this.throwIfMaxTokens(
              chunk,
              context,
              "generation",
              attempt,
              recoveryAlreadyTriggered,
              requestedEffort,
              outputLimitUsage,
              outputLimitCosts,
              stream_buffer.text().length,
            );
            this.withResponseBilling(chunk, () =>
              observeGeminiStreamTerminals(chunk, completedCandidates, {
                context,
                peer: this.id,
                provider: this.provider,
                model: this.model,
                phase: "generation",
              }),
            );
            const delta = chunk.text ?? "";
            stream_buffer.append(delta);
            tokenStream.append(delta);
          }
          this.withResponseBilling(last, () =>
            assertGeminiStreamCompleted(completedCandidates, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "generation",
            }),
          );
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          const normalized = text ? { text, parser_warnings: [] } : geminiTextWithWarning(last);
          const currentUsage = usageFromGemini(last?.usageMetadata);
          const allUsage = combinedGeminiUsage([...outputLimitUsage, currentUsage]);
          const currentCost = currentUsage
            ? estimateCost(this.config, this.id, currentUsage, this.model)
            : undefined;
          const allCosts = [...outputLimitCosts, currentCost];
          return this.generationFromText({
            text: normalized.text,
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: allUsage,
            ...(outputLimitUsage.length > 0
              ? {
                  costOverride: mergeCost(allCosts),
                  accountedAttemptsOverride: pricedGeminiAttemptCount(allCosts),
                }
              : {}),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
            extraParserWarnings: normalized.parser_warnings,
          });
        }
        const response = (await generateClient.ai.models.generateContent(params)) as GeminiResponse;
        const recoveryAlreadyTriggered = outputLimitRecoveryTriggered;
        if (
          response.candidates?.some(
            (candidate) => String(candidate.finishReason ?? "").toUpperCase() === "MAX_TOKENS",
          )
        ) {
          outputLimitRecoveryTriggered = true;
        }
        this.throwIfMaxTokens(
          response,
          context,
          "generation",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          outputLimitUsage,
          outputLimitCosts,
        );
        this.withResponseBilling(response, () =>
          assertGeminiCompletion(response, {
            context,
            peer: this.id,
            provider: this.provider,
            model: this.model,
            phase: "generation",
          }),
        );
        const normalized = geminiTextWithWarning(response);
        const currentUsage = usageFromGemini(response.usageMetadata);
        const allUsage = combinedGeminiUsage([...outputLimitUsage, currentUsage]);
        const currentCost = currentUsage
          ? estimateCost(this.config, this.id, currentUsage, this.model)
          : undefined;
        const allCosts = [...outputLimitCosts, currentCost];
        return this.generationFromText({
          text: normalized.text,
          raw: response,
          usage: allUsage,
          ...(outputLimitUsage.length > 0
            ? {
                costOverride: mergeCost(allCosts),
                accountedAttemptsOverride: pricedGeminiAttemptCount(allCosts),
              }
            : {}),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
          extraParserWarnings: normalized.parser_warnings,
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
