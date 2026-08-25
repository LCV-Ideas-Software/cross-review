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

// v4.7.0 (CROSREV-6): a storage-only entry is a ledger item recorded at
// cache creation, not a generateContent attempt — it must sum into merged
// usage/cost but never into the accounted-attempt arithmetic.
function isStorageOnlyLedgerItem(cost: CostEstimate | undefined): boolean {
  return cost?.cache_storage_cost != null && cost.input_cost == null && cost.output_cost == null;
}

function pricedGeminiAttemptCount(items: Array<CostEstimate | undefined>): number {
  return items.filter(
    (cost) =>
      typeof cost?.total_cost === "number" &&
      Number.isFinite(cost.total_cost) &&
      !isStorageOnlyLedgerItem(cost),
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
// and the payload reaches the documented 4,096-token cachedContents
// minimum for the 3.x/2.5 Pro models (the FREE countTokens call is the
// sole eligibility authority — no character gate: one UTF-16 character can
// encode into multiple tokens — with a negative sentinel bounding
// re-counting), the adapter creates ONE cachedContents entry per distinct
// (schema, model, ttl, stable system, head) — concurrent creations of the
// same tuple share one in-flight promise — and calls generateContent with
// `cachedContent` plus only the dynamic remainder.
// Both modes keep ONE logical prompt order — session-stable system parts
// (role + Session + task) → head → tail → Round line → status — because the
// stable system parts live INSIDE the cached prefix and only the per-round
// Round line travels after the body. The request itself never sets
// systemInstruction: the provider contract rejects cachedContent combined
// with systemInstruction/tools (400 INVALID_ARGUMENT, "CachedContent can
// not be used with GenerateContent request setting system_instruction,
// tools or tool_config").
// Storage is billed deterministically at creation (cached tokens x TTL
// hours) using the provider-reported token count (countTokens, which is
// free, runs BEFORE creation so an unpriceable cache is never created);
// the charge is pushed into the attempt billing ledger IMMEDIATELY so
// failed and recovered attempts keep it. Reads keep the provider-reported
// cachedContentTokenCount discount with cache_provider_mode="explicit".
// Creation failures fall back to the uncached request with a
// provider.cache.notice — transport-ambiguous ones (the server may have
// created and billed the entry) surface as an unpriced attempt; a
// lost/expired cache drops the index entry and retries, re-creating it.
export const GEMINI_EXPLICIT_CACHE_MIN_TOKENS = 4_096;

// Codex review of PR #240 round 2: eligibility is decided by the
// AUTHORITATIVE token count (countTokens runs before creation anyway), not
// by a chars/4 approximation — token-dense heads (non-Latin, minified
// code) can reach the minimum well below 4 chars/token. The only character
// gate left is a floor with no false negatives: BPE tokens consume at
// least one character each, so a head shorter than MIN_TOKENS characters
// can never reach MIN_TOKENS tokens.
//
// `name: ""` is the negative sentinel: the authoritative count showed this
// (stable system + head) below the provider minimum, so calls stay
// uncached without re-counting until the entry expires.
type GeminiExplicitCacheEntry = { name: string; token_count: number; expires_at_ms: number };
const geminiExplicitCacheIndex = new Map<string, GeminiExplicitCacheEntry>();
// Codex review of PR #240: two concurrent calls with the same eligible head
// must not both create separately billed cachedContents resources. The
// creator registers its promise here; racers await it (the creator alone
// records the storage ledger item).
const geminiExplicitCacheInFlight = new Map<
  string,
  Promise<GeminiExplicitCacheEntry | undefined>
>();

export function __resetGeminiExplicitCacheIndexForTests(): void {
  geminiExplicitCacheIndex.clear();
  geminiExplicitCacheInFlight.clear();
}

export function __geminiExplicitCacheIndexForTests(): ReadonlyMap<
  string,
  GeminiExplicitCacheEntry
> {
  return geminiExplicitCacheIndex;
}

export function __seedGeminiExplicitCacheIndexForTests(
  key: string,
  entry: GeminiExplicitCacheEntry,
): void {
  geminiExplicitCacheIndex.set(key, entry);
}

function geminiTtlSeconds(ttl: "5m" | "1h"): number {
  return ttl === "5m" ? 300 : 3_600;
}

// Codex review of PR #240 round 5: the preliminary cache calls
// (countTokens, caches.create) must be interruptible — withRetry cannot
// observe cancellation until an awaited call settles. The race rejects
// with an AbortError-shaped error the moment the signal fires;
// classifyProviderError maps it to the timeout class, whose spend is
// already indeterminate (a raced-away caches.create may still have
// created and billed the resource server-side).
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  const abortError = (): Error =>
    Object.assign(new Error("aborted while a cache-preparation request was in flight"), {
      name: "AbortError",
    });
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw abortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Exported: estimatedPeerRoundCost (orchestrator preflight) shares this gate
// so the budget envelope and the adapter can never disagree on armed state.
export function geminiExplicitCacheArmed(config: AppConfig): boolean {
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
    // v4.7.0 (CROSREV-6): minimum indeterminate share — ambiguous cache
    // creations counted into `attempt` may have billed server-side spend,
    // so they must stay indeterminate even when the terminal error's own
    // class settles as zero-spend.
    indeterminateFloor = 0,
  ) {
    const failure = classifyProviderError(
      this.id,
      this.provider,
      this.model,
      error,
      attempt,
      started,
    );
    const applyIndeterminateFloor = <F extends { unpriced_attempts?: number | undefined }>(
      base: F,
    ): F => {
      if (indeterminateFloor <= 0) return base;
      const unpriced = base.unpriced_attempts ?? 0;
      if (unpriced <= 0) return base;
      const existing =
        (base as { indeterminate_spend_attempts?: number | undefined })
          .indeterminate_spend_attempts ?? 0;
      return {
        ...base,
        indeterminate_spend_attempts: Math.max(existing, Math.min(indeterminateFloor, unpriced)),
      };
    };
    if (accumulatedUsage.length === 0 || error instanceof GeminiMaxTokensError) {
      return applyIndeterminateFloor(failure);
    }
    const providerResultSettled =
      error !== null &&
      typeof error === "object" &&
      (error as Record<string, unknown>).provider_result_settled === true;
    if (providerResultSettled) return applyIndeterminateFloor(failure);
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
            indeterminate_spend_attempts: Math.max(
              indeterminateSpendMarkerFor(failure.failure_class, failure.message, unpricedAttempts),
              Math.min(indeterminateFloor, unpricedAttempts),
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

  // v4.7.0 (CROSREV-6): create one cachedContents entry for an eligible
  // stable head. Fail-open toward the uncached request (always correct),
  // fail-CLOSED toward billing: the authoritative token count is fetched
  // BEFORE creation (countTokens is free) so a resource whose storage price
  // cannot be stated is never created, and the deterministic storage charge
  // is recorded in the attempt billing ledger the moment the resource
  // exists — failures and recovery paths inherit it from there.
  // `cacheContents` is the EXACT text the cache will hold (session-stable
  // system parts + stable head), so counting and the provider minimum are
  // decided on the real payload; a below-minimum count records a negative
  // sentinel entry so later calls stay uncached without re-counting.
  private async createExplicitCacheEntry(params: {
    reviewClient: { ai: GoogleGenAI };
    cacheContents: string;
    ttl: "5m" | "1h";
    cacheKeyHash: string;
    context: PeerCallContext;
    ledgerUsage: TokenUsage[];
    ledgerCosts: CostEstimate[];
    onIndeterminateCreate: () => void;
  }): Promise<GeminiExplicitCacheEntry | undefined> {
    const { reviewClient, cacheContents, ttl, cacheKeyHash, context } = params;
    const ttlSeconds = geminiTtlSeconds(ttl);
    const notice = (message: string, data: Record<string, unknown>) => {
      context.emit({
        type: "provider.cache.notice",
        session_id: context.session_id,
        round: context.round,
        peer: this.id,
        message,
        data,
      });
    };
    let countedTokens: number | undefined;
    try {
      // Round 5: raced against the abort signal — countTokens is free, so
      // a raced-away call has no spend and the cancellation recheck below
      // reports it.
      const counted = (await raceWithAbort(
        reviewClient.ai.models.countTokens({
          model: this.model,
          contents: [{ role: "user", parts: [{ text: cacheContents }] }],
        }) as Promise<{ totalTokens?: number }>,
        context.signal,
      )) as { totalTokens?: number };
      countedTokens = counted?.totalTokens;
    } catch {
      countedTokens = undefined;
    }
    if (
      typeof countedTokens !== "number" ||
      !Number.isFinite(countedTokens) ||
      countedTokens <= 0
    ) {
      // No authoritative count => the storage charge would be a guess.
      // countTokens itself is free, so skipping creation costs nothing.
      notice(
        "Gemini explicit cache skipped: countTokens returned no authoritative token count, so the storage charge could not be stated; continuing uncached.",
        { model: this.model, key_hash: cacheKeyHash },
      );
      return undefined;
    }
    // Codex review of PR #240 round 3: a cancellation that lands while the
    // FREE countTokens call is pending must not be followed by the BILLED
    // caches.create call — recheck the signal between the two.
    if (context.signal?.aborted) {
      notice(
        "Gemini explicit cache creation skipped: the session was cancelled before the billable caches.create call.",
        { model: this.model, key_hash: cacheKeyHash },
      );
      return undefined;
    }
    if (countedTokens < GEMINI_EXPLICIT_CACHE_MIN_TOKENS) {
      // Codex review of PR #240 round 2: the authoritative count decides
      // eligibility — a token-sparse head below the provider minimum would
      // only produce a rejected creation call. The negative sentinel keeps
      // later calls uncached without re-counting until it expires.
      const now = Date.now();
      for (const [key, indexed] of geminiExplicitCacheIndex) {
        if (indexed.expires_at_ms <= now) geminiExplicitCacheIndex.delete(key);
      }
      geminiExplicitCacheIndex.set(cacheKeyHash, {
        name: "",
        token_count: countedTokens,
        expires_at_ms: now + ttlSeconds * 1_000,
      });
      notice(
        `Gemini explicit cache skipped: the stable prefix counts ${countedTokens} tokens, below the ${GEMINI_EXPLICIT_CACHE_MIN_TOKENS}-token cachedContents minimum; continuing uncached.`,
        { model: this.model, key_hash: cacheKeyHash, token_count: countedTokens },
      );
      return undefined;
    }
    try {
      // Round 5: raced against the abort signal — a raced-away creation
      // may still have been created and billed server-side, so the abort
      // error routes through the ambiguous-transport path below.
      const created = (await raceWithAbort(
        reviewClient.ai.caches.create({
          model: this.model,
          config: {
            contents: [{ role: "user", parts: [{ text: cacheContents }] }],
            ttl: `${ttlSeconds}s`,
            displayName: `cross-review:${cacheKeyHash.slice(0, 16)}`,
          },
        }) as Promise<{ name?: string; usageMetadata?: { totalTokenCount?: number } }>,
        context.signal,
      )) as { name?: string; usageMetadata?: { totalTokenCount?: number } };
      if (!created?.name) {
        notice("Gemini explicit cache creation returned no resource name; continuing uncached.", {
          model: this.model,
          key_hash: cacheKeyHash,
        });
        return undefined;
      }
      const tokenCount = created.usageMetadata?.totalTokenCount ?? countedTokens;
      const entry: GeminiExplicitCacheEntry = {
        name: created.name,
        token_count: tokenCount,
        expires_at_ms: Date.now() + ttlSeconds * 1_000,
      };
      // Evict expired entries at insertion so the process-wide index stays
      // bounded by the set of LIVE heads, not the lifetime set.
      const now = Date.now();
      for (const [key, indexed] of geminiExplicitCacheIndex) {
        if (indexed.expires_at_ms <= now) geminiExplicitCacheIndex.delete(key);
      }
      geminiExplicitCacheIndex.set(cacheKeyHash, entry);
      // Record the deterministic storage charge in the attempt billing
      // ledger IMMEDIATELY (a storage-only item, not an attempt).
      const tokenHours = (tokenCount * ttlSeconds) / 3_600;
      const ledgerUsage: TokenUsage = { cache_storage_token_hours: tokenHours };
      const ledgerCost = estimateCost(this.config, this.id, ledgerUsage, this.model);
      delete ledgerCost.input_cost;
      delete ledgerCost.output_cost;
      params.ledgerUsage.push(ledgerUsage);
      if ((ledgerCost.cache_storage_cost ?? 0) > 0) {
        params.ledgerCosts.push(ledgerCost);
      } else {
        // The financial-control gate requires the storage rate whenever the
        // cache is armed, so this branch is defense in depth only.
        notice(
          "Gemini explicit cache storage could not be priced (storage rate missing); token-hours recorded without a cost line.",
          { model: this.model, key_hash: cacheKeyHash, token_hours: tokenHours },
        );
      }
      notice(`Gemini explicit cache created (${tokenCount} tokens, ttl ${ttl}).`, {
        model: this.model,
        cache_name: created.name,
        token_count: tokenCount,
        ttl,
        key_hash: cacheKeyHash,
      });
      return entry;
    } catch (error) {
      // An uncached call is always correct — but a transport-ambiguous
      // failure (timeout/reset/unknown) may have created and billed the
      // entry server-side, so its spend must stay indeterminate.
      const createFailure = classifyProviderError(
        this.id,
        this.provider,
        this.model,
        error,
        1,
        Date.now(),
      );
      const ambiguous =
        indeterminateSpendMarkerFor(createFailure.failure_class, createFailure.message, 1) > 0;
      if (ambiguous) params.onIndeterminateCreate();
      notice(
        ambiguous
          ? `Gemini explicit cache creation did not settle (the server may have created and billed it); spend recorded as indeterminate, continuing uncached: ${
              error instanceof Error ? error.message : String(error)
            }`
          : `Gemini explicit cache creation failed; continuing uncached: ${
              error instanceof Error ? error.message : String(error)
            }`,
        { model: this.model, key_hash: cacheKeyHash },
      );
      return undefined;
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    // These arrays are the attempt billing ledger: MAX_TOKENS recovery
    // usage/costs AND (v4.7.0, CROSREV-6) storage-only items recorded the
    // moment a cachedContents entry is created, so failures, recoveries and
    // successes all inherit the deterministic storage charge.
    const outputLimitUsage: TokenUsage[] = [];
    const outputLimitCosts: CostEstimate[] = [];
    let outputLimitRecoveryTriggered = false;
    // Ambiguous cache creations (transport failures where the server may
    // have created and billed the entry) count as unpriced attempts.
    let indeterminateCacheCreateAttempts = 0;
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
        // Session-stable system parts (role + Session + task) lead BOTH
        // compositions; only the Round line varies per round, so it travels
        // after the body in both. This keeps one logical prompt order —
        // stable system → head → tail → Round → status — whether or not the
        // head is served from the explicit cache (Codex review of PR #240
        // round 2: enabling caching must change transport, never review
        // behavior).
        const stableSystem = `${this.systemPromptRoleAndSession(context)}\n\n${this.systemPromptTaskBlock(context)}`;
        const roundLine = this.systemPromptRoundLine(context);
        // Codex review of PR #240 round 3: hashStablePrefix normalizes
        // CRLF to LF defensively, so the STORED payload must be the same
        // LF-normalized bytes — otherwise two resubmissions differing
        // only in line endings share a key while the cached bytes match
        // just one of them (stale-evidence reuse). Normalize the payload
        // once and use those exact bytes for the key, countTokens and
        // caches.create.
        const lfNormalize = (value: string): string => value.replace(/\r\n?/g, "\n");
        const normalizedStableSystem = lfNormalize(stableSystem);
        const stableHead = lfNormalize(prompt.slice(0, stablePrefixChars));
        const cachePayload = `${normalizedStableSystem}\n\n${stableHead}`;
        // Round 5: NO character gate — one UTF-16 character can encode
        // into multiple Gemini tokens (CJK, emoji), so a payload shorter
        // than 4,096 characters can still clear the 4,096-token minimum.
        // The free countTokens inside createExplicitCacheEntry is the sole
        // eligibility authority, and its below-minimum negative sentinel
        // bounds the re-counting cost to one call per payload per TTL.
        const explicitCacheEligible =
          geminiExplicitCacheArmed(this.config) &&
          stablePrefixChars > 0 &&
          stablePrefixChars < prompt.length;
        let cacheEntry: GeminiExplicitCacheEntry | undefined;
        let cacheKeyHash: string | undefined;
        if (explicitCacheEligible) {
          const ttl = this.config.cache.ttl.gemini;
          // The cache holds stableSystem + head, so the key must cover both
          // (length-prefixed to keep the boundary unambiguous). Session id
          // and task live in stableSystem: reuse spans the rounds of one
          // session — exactly where the repeated-prefix savings are.
          cacheKeyHash = hashStablePrefix(
            `${this.config.cache.schema_version}\n${this.model}\n${ttl}\n${normalizedStableSystem.length}\n${cachePayload}`,
          );
          const existing = geminiExplicitCacheIndex.get(cacheKeyHash);
          // A 15s guard band avoids referencing an entry that expires while
          // the request is in flight.
          if (existing && existing.expires_at_ms > Date.now() + 15_000) {
            // name === "" is the negative sentinel: counted below the
            // provider minimum — stay uncached without re-counting.
            cacheEntry = existing.name === "" ? undefined : existing;
          } else {
            const inFlight = geminiExplicitCacheInFlight.get(cacheKeyHash);
            if (inFlight) {
              // A concurrent call is creating this exact tuple; share its
              // resource. The creator alone records the storage ledger item.
              // Round 7: the waiter races its OWN signal — cancelling one
              // waiter releases it promptly without cancelling the creator.
              cacheEntry = await raceWithAbort(inFlight, context.signal);
            } else {
              const creation = this.createExplicitCacheEntry({
                reviewClient,
                cacheContents: cachePayload,
                ttl,
                cacheKeyHash,
                context,
                ledgerUsage: outputLimitUsage,
                ledgerCosts: outputLimitCosts,
                onIndeterminateCreate: () => {
                  indeterminateCacheCreateAttempts += 1;
                },
              });
              geminiExplicitCacheInFlight.set(cacheKeyHash, creation);
              try {
                cacheEntry = await creation;
              } finally {
                geminiExplicitCacheInFlight.delete(cacheKeyHash);
              }
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
        // One logical order in both modes: stableSystem → head → tail →
        // Round → status. Cached: [stableSystem + head] is served from the
        // cachedContents resource (which the provider always places before
        // the live contents), and the request carries only cachedContent —
        // never systemInstruction (400 INVALID_ARGUMENT contract).
        // Round 6: BOTH compositions are LF-normalized — the cached branch
        // stores normalized bytes, so the uncached branch must send the
        // same bytes or arming the cache would change the exact prompt.
        const params = cacheEntry
          ? {
              model: this.model,
              contents: `${lfNormalize(userPrompt(prompt.slice(stablePrefixChars)))}\n\n${roundLine}\n\n${statusInstruction()}`,
              config: {
                ...requestConfig,
                cachedContent: cacheEntry.name,
              },
            }
          : {
              model: this.model,
              contents: `${normalizedStableSystem}\n\n${lfNormalize(userPrompt(prompt))}\n\n${roundLine}\n\n${statusInstruction()}`,
              config: requestConfig,
            };
        const decorateUsage = (usage: TokenUsage | undefined): TokenUsage | undefined => {
          if (!usage) return usage;
          // The aggregate merge deliberately drops per-call QUALITATIVE cache
          // attributes (mode/key hash — storage token-hours are additive and
          // arrive through the ledger merge); re-derive the mode with
          // usageFromGemini's per-attempt semantics: explicit when this call
          // reads through the explicit cache entry, implicit for
          // provider-side prefix caching, not_supported when nothing was
          // cached. Costs are unaffected (they are computed from the
          // per-attempt usage before the merge).
          if ((usage.cache_read_tokens ?? 0) > 0) {
            usage.cache_provider_mode = cacheEntry ? "explicit" : "implicit";
          } else {
            usage.cache_provider_mode = "not_supported";
          }
          // This client created (or reused) the entry and knows the stable
          // key — publish it so cache telemetry can correlate rounds.
          if (cacheEntry && cacheKeyHash) {
            usage.cache_key_hash = cacheKeyHash;
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
          // Decorate the AGGREGATE: combinedGeminiUsage (mergeUsage) sums
          // additive fields (storage token-hours included) but drops
          // qualitative per-call cache attributes, so mode/key hash are
          // stamped after the merge.
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
            // Ambiguous cache creations are provider calls whose spend never
            // became durable; they surface as unpriced attempts AND as an
            // indeterminate floor so settlement keeps the spend unknown.
            attempts: attempt + indeterminateCacheCreateAttempts,
            indeterminateSpendFloor: indeterminateCacheCreateAttempts,
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
          attempts: attempt + indeterminateCacheCreateAttempts,
          indeterminateSpendFloor: indeterminateCacheCreateAttempts,
          modelReported: response.modelVersion,
          extraParserWarnings: normalized.parser_warnings,
        });
      },
      (error, attempt) => {
        // A generateContent failure that names the cached content means the
        // entry was lost or expired server-side: drop it so the retry (or
        // the next round) re-creates instead of failing repeatedly.
        let staleCacheDropped = false;
        if (error instanceof Error && /cached\s*content|cachedContents\//i.test(error.message)) {
          for (const [key, entry] of geminiExplicitCacheIndex) {
            // Round 4: negative sentinels carry name === "" and
            // String.includes("") is always true — only a REAL resource
            // name appearing in the message is evidence of staleness.
            if (entry.name !== "" && error.message.includes(entry.name)) {
              geminiExplicitCacheIndex.delete(key);
              staleCacheDropped = true;
            }
          }
        }
        this.discardTokenEventBuffer(context, "review", attempt);
        const classified = this.classifyWithAccumulatedBilling(
          error,
          attempt + indeterminateCacheCreateAttempts,
          started,
          outputLimitUsage,
          outputLimitCosts,
          indeterminateCacheCreateAttempts,
        );
        // Codex review of PR #240: the provider's stale-cache 400/404 is
        // classified as a terminal provider_error, but losing the entry is
        // recoverable — the index entry was just dropped, so the retry
        // re-creates the cache instead of failing the review.
        if (staleCacheDropped && !classified.retryable) {
          return {
            ...classified,
            retryable: true,
            message: `${classified.message} (stale cached content dropped; the retry re-creates it)`,
          };
        }
        return classified;
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
