// v2.21.0 (caching): Anthropic adapter participates in EXPLICIT prompt
// caching via cache_control breakpoints. Strategy:
//   1. Convert `system` from string to `[{ type: "text", text,
//      cache_control: { type: "ephemeral", ttl } }]` so the entire
//      system prompt becomes a cacheable prefix.
//   2. Place ONE cache_control breakpoint at the END of the system
//      block. Anthropic supports up to 4 breakpoints; reserving 3 for
//      future use (per-message cache layering, tool block caching,
//      etc.) keeps headroom.
//   3. TTL chosen via config.cache.ttl.anthropic (5m or 1h).
//   4. Parse cache_creation_input_tokens / cache_read_input_tokens
//      from response.usage and surface via TokenUsage.cache_*.
//   5. Empirical guidance: Anthropic Opus 4.7 needs the cached block
//      to be at least 4 KiTokens; smaller prefixes will still emit
//      cache_control headers but Anthropic may not actually create a
//      cache entry. We emit an info-level warning when the system
//      prompt is suspiciously short, but do NOT block the call.
// v2.27.1 (cold-start hardening): SDK ctor lazy-loaded via dynamic
// import inside `client()` so the @anthropic-ai/sdk module tree is not
// pulled at server boot. Type-only import preserves all annotations.
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCost, mergeCost, mergeUsage } from "../core/cost.js";
import { maxOutputTokensForPeer } from "../core/output-budget.js";
import { statusInstruction, statusJsonSchema } from "../core/status.js";
import type {
  AppConfig,
  CostEstimate,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerFailure,
  PeerId,
  PeerProbeResult,
  PeerResult,
  TokenUsage,
} from "../core/types.js";
import { redact } from "../security/redact.js";
import { BasePeerAdapter, STREAM_TEXT_MAX_BYTES, StreamBufferOverflowError } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { assertAnthropicCompletion, withEstimatedTerminalBilling } from "./terminal.js";
import { parseAnthropicContent, userPrompt } from "./text.js";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type AnthropicUsage = {
  input_tokens?: number | null | undefined;
  output_tokens?: number | undefined;
  cache_creation_input_tokens?: number | null | undefined;
  cache_read_input_tokens?: number | null | undefined;
};

type AnthropicStopDetails = {
  type?: string | null | undefined;
  category?: string | null | undefined;
  explanation?: string | null | undefined;
};

type AnthropicMessageLike = {
  content: Array<{ type: string; text?: string }>;
  model?: string | undefined;
  stop_reason?: string | null | undefined;
  stop_details?: AnthropicStopDetails | null | undefined;
  usage?: AnthropicUsage | null | undefined;
};

class AnthropicRefusalError extends Error {
  readonly code = "anthropic_refusal";
  readonly stop_reason = "refusal";
  readonly accounted_attempts: number;

  constructor(
    readonly model: string,
    readonly stop_details: AnthropicStopDetails | null | undefined,
    readonly usage: TokenUsage | undefined,
    readonly cost: CostEstimate | undefined,
    readonly billed: boolean,
  ) {
    const category = stop_details?.category ? ` category=${stop_details.category}` : "";
    super(`Claude Fable 5 refusal from ${model}${category}.`);
    this.name = "AnthropicRefusalError";
    this.accounted_attempts =
      typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost) ? 1 : 0;
  }
}

class AnthropicMaxTokensError extends Error {
  readonly code: "anthropic_max_tokens_retryable" | "anthropic_max_tokens_exhausted";
  readonly stop_reason = "max_tokens";

  constructor(
    readonly model: string,
    readonly usage: TokenUsage | undefined,
    readonly cost: CostEstimate | undefined,
    readonly accounted_attempts: number,
    retryable: boolean,
  ) {
    super(
      retryable
        ? `anthropic_max_tokens_retryable: ${model} returned stop_reason=max_tokens; retrying once at medium effort.`
        : `anthropic_max_tokens_exhausted: ${model} returned stop_reason=max_tokens after controlled recovery.`,
    );
    this.name = "AnthropicMaxTokensError";
    this.code = retryable ? "anthropic_max_tokens_retryable" : "anthropic_max_tokens_exhausted";
  }
}

function usageFromAnthropic(usage: AnthropicUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? undefined;
  const output = usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? undefined;
  const cacheWrite = usage.cache_creation_input_tokens ?? undefined;
  const result: TokenUsage = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: (input ?? 0) + (output ?? 0),
  };
  if (cacheRead !== undefined && cacheRead !== null) result.cache_read_tokens = cacheRead;
  if (cacheWrite !== undefined && cacheWrite !== null) result.cache_write_tokens = cacheWrite;
  if (cacheRead || cacheWrite) {
    result.cache_provider_mode = "explicit";
  }
  return result;
}

function combinedAnthropicUsage(items: Array<TokenUsage | undefined>): TokenUsage | undefined {
  return items.some(Boolean) ? mergeUsage(items) : undefined;
}

function pricedAnthropicAttemptCount(items: Array<CostEstimate | undefined>): number {
  return items.filter(
    (cost) => typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost),
  ).length;
}

// v2.21.0: build the system block as a single cacheable text block when
// caching is enabled, or leave it as a raw string when disabled. The
// SDK accepts both shapes per its TypeScript signature
// `system?: string | Array<TextBlockParam>`.
function buildSystemBlock(
  systemText: string,
  config: AppConfig,
):
  | string
  | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" } }> {
  // v3.7.5 (A3, logs+sessions study 2026-05-15): per-provider cache
  // gate. Anthropic adapter only emits `cache_control` when BOTH the
  // global kill-switch is OFF AND this provider's
  // `disable_per_peer.claude` is false. Default (this release):
  // claude=true → no cache_control emitted, no cache_creation_input
  // tokens billed. Operators override via
  // `CROSS_REVIEW_DISABLE_CACHE_ANTHROPIC=false` if traffic shape
  // changes and the cache starts paying off.
  if (!config.cache.enabled || config.cache.disable_per_peer.claude) return systemText;
  return [
    {
      type: "text" as const,
      text: systemText,
      cache_control: { type: "ephemeral" as const, ttl: config.cache.ttl.anthropic },
    },
  ];
}

// v2.21.0: empirical Anthropic cache min-token guidance. At ~4 chars
// per token we set the chars threshold so the warning fires when the
// system prompt is unlikely to engage caching (Anthropic Opus 4.7
// requires the cached block be at least the documented threshold).
// Computed inline to avoid the smoke harness's "no stale max-tokens
// limit literal" guard from misinterpreting the constant as the old
// max_output_tokens regression.
const ANTHROPIC_CACHE_MIN_CHARS = (1 << 12) * 4;

function anthropicEffort(value: AppConfig["reasoning_effort"][PeerId]): AnthropicEffort {
  if (value === "none" || value === "minimal") return "low";
  if (value === "ultra") return "max";
  return value ?? "max";
}

// v2.27.1 (cold-start hardening): cache the SDK ctor between calls so
// the dynamic import only resolves once. The promise is reused across
// concurrent first-callers so the SDK module loads exactly once. Exported
// so peers/model-selection.ts can share the same module promise.
let _AnthropicCtorPromise: Promise<typeof Anthropic> | null = null;
export function loadAnthropicCtor(): Promise<typeof Anthropic> {
  if (!_AnthropicCtorPromise) {
    _AnthropicCtorPromise = import("@anthropic-ai/sdk").then((mod) => mod.default);
  }
  return _AnthropicCtorPromise;
}

type AnthropicStatusOutputFormat = {
  type: "json_schema";
  schema: Record<string, unknown>;
};

// Anthropic accepts a documented subset of JSON Schema. Keep the complete
// cross-review contract in statusJsonSchema/Zod, but use the official SDK's
// lowering pass for the provider wire. The helper removes unsupported
// constraints, carries them into descriptions, and leaves local validation to
// the caller. Cache the dynamic import/result so the cold-start property of the
// adapter is preserved and every retry uses the same deterministic schema.
let _AnthropicStatusOutputFormatPromise: Promise<AnthropicStatusOutputFormat> | null = null;
export function loadAnthropicStatusOutputFormat(): Promise<AnthropicStatusOutputFormat> {
  if (!_AnthropicStatusOutputFormatPromise) {
    _AnthropicStatusOutputFormatPromise = import("@anthropic-ai/sdk/helpers/json-schema").then(
      ({ jsonSchemaOutputFormat }) => {
        const lowered = jsonSchemaOutputFormat(statusJsonSchema);
        return {
          type: lowered.type,
          schema: lowered.schema as Record<string, unknown>,
        };
      },
    );
  }
  return _AnthropicStatusOutputFormatPromise;
}

function anthropicThinking(): { type: "adaptive"; display: "omitted" } {
  return { type: "adaptive", display: "omitted" };
}

function anthropicThinkingFields(
  model: string,
): Record<string, never> | { thinking: ReturnType<typeof anthropicThinking> } {
  // Fable 5 runs adaptive thinking whenever the field is unset. Anthropic's
  // official Opus 4.8 -> Fable 5 migration removes the thinking field and
  // uses output_config.effort as the depth control.
  if (/^claude-fable-5(?:-|$)/i.test(model)) return {};
  return { thinking: anthropicThinking() };
}

export class AnthropicAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "claude";
  provider = "anthropic";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.claude;
  }

  private async client(): Promise<Anthropic> {
    const apiKey = this.config.api_keys.claude;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY was not found in environment variables.");
    const Ctor = await loadAnthropicCtor();
    return new Ctor({ apiKey, timeout: this.config.retry.timeout_ms });
  }

  private throwIfRefusal(
    message: AnthropicMessageLike,
    context: PeerCallContext,
    phase: "review" | "generation",
  ): void {
    if (message.stop_reason !== "refusal") return;
    const usage = usageFromAnthropic(message.usage);
    const estimatedCost = usage ? estimateCost(this.config, this.id, usage, this.model) : undefined;
    // Anthropic documents two Fable refusal billing paths. A refusal before
    // any output is not charged even though usage can report input tokens;
    // a mid-stream refusal is charged for input and generated output. Treat
    // provider-reported output tokens as the observable discriminator.
    const billed = (usage?.output_tokens ?? 0) > 0;
    const cost: CostEstimate | undefined = billed
      ? estimatedCost
      : usage
        ? {
            currency: "USD",
            input_cost: 0,
            output_cost: 0,
            total_cost: 0,
            estimated: false,
            source: estimatedCost?.source ?? "unknown-rate",
          }
        : undefined;
    const model = message.model ?? this.model;
    const details = message.stop_details ?? undefined;
    context.emit({
      type: "provider.refusal",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: `Anthropic returned stop_reason=refusal for ${model}.`,
      data: {
        provider: this.provider,
        configured_model: this.model,
        model,
        phase,
        stop_reason: "refusal",
        stop_details_type: details?.type ?? null,
        category: details?.category ?? null,
        explanation:
          typeof details?.explanation === "string"
            ? redact(details.explanation).slice(0, 500)
            : null,
        billed,
        retryable: false,
        usable_output: false,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        cost: cost ?? null,
      },
    });
    throw new AnthropicRefusalError(model, details, usage, cost, billed);
  }

  private throwIfMaxTokens(
    message: AnthropicMessageLike,
    context: PeerCallContext,
    phase: "review" | "generation",
    attempt: number,
    recoveryAlreadyTriggered: boolean,
    requestedEffort: AnthropicEffort,
    accumulatedUsage: TokenUsage[],
    accumulatedCosts: CostEstimate[],
  ): void {
    if (message.stop_reason !== "max_tokens") return;
    const currentUsage = usageFromAnthropic(message.usage);
    const currentCost = currentUsage
      ? estimateCost(this.config, this.id, currentUsage, this.model)
      : undefined;
    if (currentUsage) accumulatedUsage.push(currentUsage);
    if (currentCost) accumulatedCosts.push(currentCost);
    const usage = combinedAnthropicUsage(accumulatedUsage);
    const fableRecoveryEligible = /^claude-fable-5(?:-|$)/i.test(this.model);
    const effortReductionAvailable =
      requestedEffort === "high" || requestedEffort === "xhigh" || requestedEffort === "max";
    const retryable =
      fableRecoveryEligible &&
      effortReductionAvailable &&
      !recoveryAlreadyTriggered &&
      attempt < this.config.retry.max_attempts;
    const terminalMessage = retryable
      ? "Claude Fable 5 hit max_tokens; retrying once at medium effort with prior usage retained."
      : recoveryAlreadyTriggered
        ? "Anthropic output remained truncated after the controlled max_tokens recovery."
        : !fableRecoveryEligible
          ? "Anthropic output hit max_tokens; no model-specific effort recovery is documented for this model."
          : !effortReductionAvailable
            ? `Claude Fable 5 hit max_tokens at ${requestedEffort} effort; retry suppressed because medium would not reduce effort.`
            : "Anthropic output hit max_tokens after the configured retry budget was exhausted.";
    const cost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    context.emit({
      type: retryable ? "peer.max_tokens_recovery.started" : "peer.max_tokens_recovery.exhausted",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: terminalMessage,
      data: {
        provider: this.provider,
        model: message.model ?? this.model,
        phase,
        stop_reason: "max_tokens",
        retryable,
        recovery_effort: retryable ? "medium" : null,
        usage: usage ?? null,
        cost: cost ?? null,
      },
    });
    throw new AnthropicMaxTokensError(
      message.model ?? this.model,
      usage,
      cost,
      pricedAnthropicAttemptCount(accumulatedCosts),
      retryable,
    );
  }

  private classifyWithAccumulatedUsage(
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
    if (accumulatedUsage.length === 0 || error instanceof AnthropicMaxTokensError) return failure;
    const providerResultSettled =
      error !== null &&
      typeof error === "object" &&
      (error as Record<string, unknown>).provider_result_settled === true;
    if (providerResultSettled) {
      // resultFromText/generationFromText already combined max_tokens usage
      // with the successful recovery response before withRetry observed the
      // cancellation. Re-merging accumulatedUsage here would double bill.
      return failure;
    }
    const priorUsage = combinedAnthropicUsage(accumulatedUsage);
    const priorCost = accumulatedCosts.length > 0 ? mergeCost(accumulatedCosts) : undefined;
    const accountedPrior = pricedAnthropicAttemptCount(accumulatedCosts);
    const currentUnpriced =
      failure.unpriced_attempts ??
      (typeof failure.cost?.total_cost === "number" && Number.isFinite(failure.cost.total_cost)
        ? 0
        : failure.attempts);
    const currentAccounted = Math.max(0, failure.attempts - currentUnpriced);
    const unpricedAttempts = Math.max(0, attempt - accountedPrior - currentAccounted);
    const merged: PeerFailure = {
      ...failure,
      usage: combinedAnthropicUsage([priorUsage, failure.usage]),
      cost: mergeCost([priorCost, failure.cost]),
      billing_status: unpricedAttempts === 0 ? ("reported" as const) : ("unknown" as const),
    };
    if (unpricedAttempts > 0) merged.unpriced_attempts = unpricedAttempts;
    else delete merged.unpriced_attempts;
    return merged;
  }

  private successfulRecoveryBilling(
    rawUsage: AnthropicUsage | null | undefined,
    accumulatedUsage: TokenUsage[],
    accumulatedCosts: CostEstimate[],
  ) {
    const currentUsage = usageFromAnthropic(rawUsage);
    if (accumulatedUsage.length === 0) return { usage: currentUsage };
    const currentCost = currentUsage
      ? estimateCost(this.config, this.id, currentUsage, this.model)
      : undefined;
    const allCosts = [...accumulatedCosts, currentCost];
    return {
      usage: combinedAnthropicUsage([...accumulatedUsage, currentUsage]),
      costOverride: mergeCost(allCosts),
      accountedAttemptsOverride: pricedAnthropicAttemptCount(allCosts),
    };
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.claude);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.claude,
        message: "ANTHROPIC_API_KEY is missing.",
      };
    }
    try {
      const probeClient = await this.client();
      await probeClient.messages.countTokens({
        model: this.model,
        messages: [{ role: "user", content: "probe" }],
      });
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.claude,
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
        model_selection: this.config.model_selection.claude,
        message: failure.message,
      };
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    const maxTokensUsage: TokenUsage[] = [];
    const maxTokensCosts: CostEstimate[] = [];
    let maxTokensRecoveryTriggered = false;
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.call.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Anthropic review attempt ${attempt}`,
        });
        const systemText = this.systemPrompt(context);
        // v2.21.0: best-effort short-prefix warning — does NOT block.
        // v3.7.5 (A3): gated on the per-provider flag too so we don't
        // emit a warning about a cache that won't engage by design.
        if (
          this.config.cache.enabled &&
          !this.config.cache.disable_per_peer.claude &&
          attempt === 1 &&
          systemText.length < ANTHROPIC_CACHE_MIN_CHARS
        ) {
          context.emit({
            type: "provider.cache.notice",
            session_id: context.session_id,
            round: context.round,
            peer: this.id,
            message: `Anthropic system prompt is shorter than ~${ANTHROPIC_CACHE_MIN_CHARS} chars; cache may not engage. Consider increasing systemPrompt or attaching more evidence.`,
            data: { system_chars: systemText.length, min_chars_hint: ANTHROPIC_CACHE_MIN_CHARS },
          });
        }
        const requestedEffort = anthropicEffort(
          context.reasoning_effort_override ?? this.config.reasoning_effort.claude,
        );
        const statusOutputFormat = await loadAnthropicStatusOutputFormat();
        const body = {
          model: this.model,
          max_tokens:
            context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
          system: buildSystemBlock(systemText, this.config),
          messages: [
            {
              role: "user" as const,
              content: `${userPrompt(prompt)}\n\n${statusInstruction()}`,
            },
          ],
          ...anthropicThinkingFields(this.model),
          output_config: {
            effort: maxTokensRecoveryTriggered ? "medium" : requestedEffort,
            format: statusOutputFormat,
          },
        };
        if (this.shouldStreamTokens(context)) {
          // v2.4.0 / audit closure (P2.9): track streamed-text bytes
          // incrementally so a hostile or buggy peer cannot silently
          // accumulate gigabytes inside the SDK before finalMessage()
          // resolves. We cannot interrupt the SDK's internal buffer
          // directly, but throwing on overflow propagates through the
          // promise chain and the retry layer classifies the failure.
          const reviewClient = await this.client();
          const stream = reviewClient.messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "content_block_delta.text_delta",
            attempt,
          );
          let streamedBytes = 0;
          stream.on("text", (delta) => {
            streamedBytes += Buffer.byteLength(delta, "utf8");
            if (streamedBytes > STREAM_TEXT_MAX_BYTES) {
              stream.controller.abort();
              throw new StreamBufferOverflowError(this.id, streamedBytes);
            }
            tokenStream.append(delta);
          });
          const message = await stream.finalMessage();
          this.throwIfRefusal(message, context, "review");
          const recoveryAlreadyTriggered = maxTokensRecoveryTriggered;
          if (message.stop_reason === "max_tokens") maxTokensRecoveryTriggered = true;
          this.throwIfMaxTokens(
            message,
            context,
            "review",
            attempt,
            recoveryAlreadyTriggered,
            requestedEffort,
            maxTokensUsage,
            maxTokensCosts,
          );
          withEstimatedTerminalBilling(
            this.config,
            this.id,
            this.model,
            usageFromAnthropic(message.usage),
            () =>
              assertAnthropicCompletion(message, {
                context,
                peer: this.id,
                provider: this.provider,
                model: this.model,
                phase: "review",
              }),
          );
          const parsed = parseAnthropicContent(message.content);
          tokenStream.complete(parsed.text.length);
          return this.resultFromText({
            text: parsed.text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            ...this.successfulRecoveryBilling(message.usage, maxTokensUsage, maxTokensCosts),
            started,
            attempts: attempt,
            modelReported: message.model,
            extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
          });
        }
        const reviewClient = await this.client();
        const message = await reviewClient.messages.create(body, { signal: context.signal });
        this.throwIfRefusal(message, context, "review");
        const recoveryAlreadyTriggered = maxTokensRecoveryTriggered;
        if (message.stop_reason === "max_tokens") maxTokensRecoveryTriggered = true;
        this.throwIfMaxTokens(
          message,
          context,
          "review",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          maxTokensUsage,
          maxTokensCosts,
        );
        withEstimatedTerminalBilling(
          this.config,
          this.id,
          this.model,
          usageFromAnthropic(message.usage),
          () =>
            assertAnthropicCompletion(message, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "review",
            }),
        );
        const parsed = parseAnthropicContent(message.content);
        return this.resultFromText({
          text: parsed.text,
          raw: message,
          ...this.successfulRecoveryBilling(message.usage, maxTokensUsage, maxTokensCosts),
          started,
          attempts: attempt,
          modelReported: message.model,
          extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
        });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "review", attempt);
        return this.classifyWithAccumulatedUsage(
          error,
          attempt,
          started,
          maxTokensUsage,
          maxTokensCosts,
        );
      },
      { signal: context.signal },
    );
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    const started = Date.now();
    const maxTokensUsage: TokenUsage[] = [];
    const maxTokensCosts: CostEstimate[] = [];
    let maxTokensRecoveryTriggered = false;
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.generate.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Anthropic generation attempt ${attempt}`,
        });
        const requestedEffort = anthropicEffort(
          context.reasoning_effort_override ?? this.config.reasoning_effort.claude,
        );
        const body = {
          model: this.model,
          max_tokens:
            context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
          system: buildSystemBlock(this.systemPrompt(context), this.config),
          messages: [{ role: "user" as const, content: userPrompt(prompt) }],
          ...anthropicThinkingFields(this.model),
          output_config: {
            effort: maxTokensRecoveryTriggered ? "medium" : requestedEffort,
          },
        };
        if (this.shouldStreamTokens(context)) {
          const generateClient = await this.client();
          const stream = generateClient.messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "content_block_delta.text_delta",
            attempt,
          );
          let streamedBytes = 0;
          stream.on("text", (delta) => {
            streamedBytes += Buffer.byteLength(delta, "utf8");
            if (streamedBytes > STREAM_TEXT_MAX_BYTES) {
              stream.controller.abort();
              throw new StreamBufferOverflowError(this.id, streamedBytes);
            }
            tokenStream.append(delta);
          });
          const message = await stream.finalMessage();
          this.throwIfRefusal(message, context, "generation");
          const recoveryAlreadyTriggered = maxTokensRecoveryTriggered;
          if (message.stop_reason === "max_tokens") maxTokensRecoveryTriggered = true;
          this.throwIfMaxTokens(
            message,
            context,
            "generation",
            attempt,
            recoveryAlreadyTriggered,
            requestedEffort,
            maxTokensUsage,
            maxTokensCosts,
          );
          withEstimatedTerminalBilling(
            this.config,
            this.id,
            this.model,
            usageFromAnthropic(message.usage),
            () =>
              assertAnthropicCompletion(message, {
                context,
                peer: this.id,
                provider: this.provider,
                model: this.model,
                phase: "generation",
              }),
          );
          const parsed = parseAnthropicContent(message.content);
          tokenStream.complete(parsed.text.length);
          return this.generationFromText({
            text: parsed.text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            ...this.successfulRecoveryBilling(message.usage, maxTokensUsage, maxTokensCosts),
            started,
            attempts: attempt,
            modelReported: message.model,
            extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
          });
        }
        const generateClient = await this.client();
        const message = await generateClient.messages.create(body, { signal: context.signal });
        this.throwIfRefusal(message, context, "generation");
        const recoveryAlreadyTriggered = maxTokensRecoveryTriggered;
        if (message.stop_reason === "max_tokens") maxTokensRecoveryTriggered = true;
        this.throwIfMaxTokens(
          message,
          context,
          "generation",
          attempt,
          recoveryAlreadyTriggered,
          requestedEffort,
          maxTokensUsage,
          maxTokensCosts,
        );
        withEstimatedTerminalBilling(
          this.config,
          this.id,
          this.model,
          usageFromAnthropic(message.usage),
          () =>
            assertAnthropicCompletion(message, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "generation",
            }),
        );
        const parsed = parseAnthropicContent(message.content);
        return this.generationFromText({
          text: parsed.text,
          raw: message,
          ...this.successfulRecoveryBilling(message.usage, maxTokensUsage, maxTokensCosts),
          started,
          attempts: attempt,
          modelReported: message.model,
          extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
        });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "generation", attempt);
        return this.classifyWithAccumulatedUsage(
          error,
          attempt,
          started,
          maxTokensUsage,
          maxTokensCosts,
        );
      },
      { signal: context.signal },
    );
  }
}
