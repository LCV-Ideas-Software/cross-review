// v2.14.0 (item 5, operator directive 2026-05-04): Grok adapter.
//
// xAI's Grok exposes the OpenAI Responses API surface at base URL
// `https://api.x.ai/v1`, so this adapter is structurally near-identical
// to `peers/openai.ts` — same `client.responses.create()` invocation
// shape, same streaming event protocol, same JSON schema text-format
// gate. Only deltas:
//   - `id = "grok"` (5th peer in PEERS as of v2.14.0)
//   - `provider = "xai"`
//   - auth via canonical `GROK_API_KEY`
//   - operator chooses the model through CROSS_REVIEW_GROK_MODEL:
//       * grok-4-latest / grok-4.20 / grok-4.20-reasoning:
//         xAI automatic reasoning; omit reasoning.effort
//       * grok-4.3: explicit reasoning.effort supported through high
//       * grok-4.20-multi-agent: explicit multi-agent reasoning effort
//   - OpenAI client constructed with `baseURL: "https://api.x.ai/v1"`
//
// Copied from openai.ts rather than refactored into a shared base
// because the OpenAI adapter has provider-specific quirks (stream event
// shapes, error classification heuristics) that are easier to maintain
// per-adapter than to abstract; same precedent the codebase already
// follows with deepseek (which also uses an OpenAI-compatible surface).
// v2.27.1 (cold-start hardening): reuse the lazy OpenAI ctor loaded by
// peers/openai.ts. Type-only import preserves annotations.
import type OpenAI from "openai";
import { pairScopedCacheKey } from "../core/prompt-parts.js";
import { statusInstruction, statusJsonSchema } from "../core/status.js";
import type {
  AppConfig,
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
import { loadOpenAICtor, streamingFailureErrorFromEvent } from "./openai.js";
import { withRetry } from "./retry.js";
import { textFromOpenAIResponse, userPrompt } from "./text.js";

type GrokUsage = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  total_tokens?: number | undefined;
  output_tokens_details?: {
    reasoning_tokens?: number | undefined;
  };
  prompt_tokens_details?: {
    cached_tokens?: number | undefined;
  };
  input_tokens_details?: {
    cached_tokens?: number | undefined;
  };
};

type GrokStreamEvent = {
  type: string;
  delta?: unknown | undefined;
  response?: {
    usage?: GrokUsage | null | undefined;
    model?: string | undefined;
    error?:
      | {
          message?: string | undefined;
          code?: string | null | undefined;
          type?: string | undefined;
          param?: string | null | undefined;
        }
      | null
      | undefined;
  };
  error?:
    | {
        message?: string | undefined;
        code?: string | null | undefined;
        type?: string | undefined;
        param?: string | null | undefined;
      }
    | null
    | undefined;
};

const GROK_BASE_URL = "https://api.x.ai/v1";

function usageFromGrok(usage: GrokUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  // v2.21.0 (caching): xAI's grok-4.3 mirrors the OpenAI Responses API
  // shape and surfaces cached tokens under prompt_tokens_details. The
  // adapter is OpenAI-compatible so the same parsing path applies.
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = usage.input_tokens ?? 0;
  const result: TokenUsage = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
  };
  if (cached > 0) {
    result.cache_read_tokens = cached;
    if (inputTokens > cached) result.cache_write_tokens = inputTokens - cached;
    result.cache_provider_mode = "auto";
  } else {
    result.cache_provider_mode = "auto";
  }
  return result;
}

// v2.16.0 clarification (operator directive 2026-05-05) / v2.18.4 update
// (Codex audit 2026-05-07 P2.1): per CURRENT xAI docs at
// https://docs.x.ai/developers/model-capabilities/text/reasoning,
// BOTH `grok-4.20-multi-agent` AND `grok-4.3` accept the
// `reasoning.effort` parameter (xAI added grok-4.3 reasoning_effort
// support after v2.16.0 froze; verified via WebFetch 2026-05-07).
// Their accepted value sets DIFFER:
//   - grok-4.3: { "none", "low" (default), "medium", "high" }
//   - grok-4.20-multi-agent: { "low", "medium", "high", "xhigh" }
// The internal config scale uses
// { "none", "minimal", "low", "medium", "high", "xhigh", "max" } so this
// adapter clamps to each model's accepted set: for grok-4.3,
// "xhigh"/"max" downgrade to "high"; for multi-agent, "max" maps to
// "xhigh" (existing behavior). Other Grok-4 models such as
// `grok-4-latest`, `grok-4.20`, and `grok-4.20-reasoning` rely on xAI
// automatic reasoning and must not receive the explicit field.
//
// Important semantic difference: on `grok-4.20-multi-agent`, the
// `reasoning.effort` parameter controls **how many agents collaborate**
// (low/medium/high/xhigh maps to 4 or 16 agents), NOT chain-of-thought
// depth as on OpenAI/Anthropic. Operators tuning the field need this in
// mind. Mapped through `grokEffort()` below — same OpenAI-style enum so
// the v2.14.x config surface remains consistent across peers.
type GrokReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

function grokEffort(value: AppConfig["reasoning_effort"][PeerId]): GrokReasoningEffort {
  return value === "max" ? "xhigh" : (value ?? "xhigh");
}

// v2.18.4 / Codex audit 2026-05-07 P2.1: per-model effort clamp.
// grok-4.3 accepts only { none, low, medium, high } per xAI docs; the
// internal config scale can reach "xhigh"/"max" which the multi-agent
// model accepts but grok-4.3 would 400 on. Clamp before send.
//
// v2.18.5 / anti-drift driver (operator directive 2026-05-07): exported
// so the smoke harness can verify the clamp shape directly. Behavior
// unchanged for in-file callers.
export function clampEffortForModel(
  effort: GrokReasoningEffort,
  model: string,
): GrokReasoningEffort {
  if (model === "grok-4.3") {
    // grok-4.3 accepts only { none, low, medium, high }. Our internal
    // post-grokEffort scale is { none, minimal, low, medium, high,
    // xhigh } — `max` already collapsed to `xhigh` upstream. Clamp
    // `xhigh` and `minimal` to `high` (xhigh has no equivalent on
    // 4.3; `minimal` is a non-standard value xAI does not accept).
    if (effort === "xhigh" || effort === "minimal") return "high";
    // none/low/medium/high pass through unchanged.
    return effort;
  }
  // grok-4.20-multi-agent and others: existing scale unchanged.
  return effort;
}

// v2.15.0/v2.16.0: per-model reasoning capability detection. Per
// official xAI docs, `grok-4.3` and `grok-4.20-multi-agent` accept the
// `reasoning.effort` body field. Other Grok models (including
// `grok-4-latest`, `grok-4.20`, and `grok-4.20-reasoning`) have automatic
// reasoning by design in this runtime, so the field is unnecessary and
// omitted.
//
// Pre-v2.15 the GrokAdapter unconditionally included
// `reasoning: { effort }` in every body, locking the operator to
// `grok-4.20-multi-agent` to avoid 400s (v2.14.1 hotfix). v2.15
// detects the configured model and omits the field for non-allowlist
// models, freeing the operator to use ANY Grok model — including
// cheaper ones for routine cross-reviews while reserving 16-agent
// xhigh runs for heavy tasks.
//
// Allowlist is an explicit Set so adding a new reasoning-capable
// model is a one-line change here. Future: if xAI exposes a model
// capability discovery endpoint, replace the static set with a
// runtime probe + cache.
export const GROK_REASONING_EFFORT_MODELS: ReadonlySet<string> = new Set([
  "grok-4.20-multi-agent",
  // v2.18.4 / Codex audit 2026-05-07 P2.1: xAI docs (WebFetch verified
  // 2026-05-07) document grok-4.3 as supporting reasoning_effort with
  // { none, low (default), medium, high }. Added to allowlist so the
  // adapter sends the field; clampEffortForModel narrows xhigh/max to
  // "high" for this model.
  "grok-4.3",
]);

export function modelAcceptsReasoningEffort(model: string): boolean {
  return GROK_REASONING_EFFORT_MODELS.has(model);
}

export class GrokAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "grok";
  provider = "xai";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.grok;
  }

  // v2.21.0 (caching): construct a per-call client so we can attach a
  // dynamic x-grok-conv-id header derived from the pair-scoped cache
  // key. xAI uses the header to bucket cache entries the same way
  // OpenAI uses prompt_cache_key — it ties a sequence of calls to the
  // same conversation/cache scope.
  private async client(callerForCache?: PeerId | "operator"): Promise<OpenAI> {
    const apiKey = this.config.api_keys.grok;
    if (!apiKey) {
      throw new Error("GROK_API_KEY was not found in environment variables.");
    }
    const Ctor = await loadOpenAICtor();
    if (this.config.cache.enabled) {
      const convId = pairScopedCacheKey(
        this.id,
        callerForCache ?? "operator",
        this.config.cache.schema_version,
      );
      return new Ctor({
        apiKey,
        baseURL: GROK_BASE_URL,
        defaultHeaders: { "x-grok-conv-id": convId },
      });
    }
    return new Ctor({ apiKey, baseURL: GROK_BASE_URL });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.grok);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.grok,
        message: "GROK_API_KEY is missing.",
      };
    }
    try {
      // probe does not need cache scope — it lists models, not posts.
      const probeClient = await this.client();
      await probeClient.models.list();
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.grok,
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
        model_selection: this.config.model_selection.grok,
        message: failure.message,
      };
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.call.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Grok review attempt ${attempt}`,
        });
        const cacheKey = pairScopedCacheKey(
          this.id,
          context.caller ?? "operator",
          this.config.cache.schema_version,
        );
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
          ...(modelAcceptsReasoningEffort(this.model)
            ? {
                reasoning: {
                  effort: clampEffortForModel(
                    grokEffort(
                      context.reasoning_effort_override ?? this.config.reasoning_effort.grok,
                    ),
                    this.model,
                  ),
                },
              }
            : {}),
          store: false,
          max_output_tokens: this.config.max_output_tokens,
          ...(this.config.cache.enabled
            ? {
                prompt_cache_key: cacheKey,
                prompt_cache_retention: (this.config.cache.ttl.openai === "1h"
                  ? "24h"
                  : "in_memory") as "in_memory" | "24h",
              }
            : {}),
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "response.output_text.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          const reviewClient = await this.client(context.caller);
          const stream = await reviewClient.responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<GrokStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromGrok(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              throw streamingFailureErrorFromEvent(event, "Grok streaming response failed.");
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.resultFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const reviewClient = await this.client(context.caller);
        const response = await reviewClient.responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.resultFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromGrok(response.usage),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    const started = Date.now();
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.generate.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Grok generation attempt ${attempt}`,
        });
        const cacheKey = pairScopedCacheKey(
          this.id,
          context.caller ?? "operator",
          this.config.cache.schema_version,
        );
        const body = {
          model: this.model,
          input: [
            { role: "system" as const, content: this.systemPrompt(context) },
            { role: "user" as const, content: userPrompt(prompt) },
          ],
          ...(modelAcceptsReasoningEffort(this.model)
            ? {
                reasoning: {
                  effort: clampEffortForModel(
                    grokEffort(
                      context.reasoning_effort_override ?? this.config.reasoning_effort.grok,
                    ),
                    this.model,
                  ),
                },
              }
            : {}),
          store: false,
          max_output_tokens: this.config.max_output_tokens,
          ...(this.config.cache.enabled
            ? {
                prompt_cache_key: cacheKey,
                prompt_cache_retention: (this.config.cache.ttl.openai === "1h"
                  ? "24h"
                  : "in_memory") as "in_memory" | "24h",
              }
            : {}),
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "response.output_text.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          const generateClient = await this.client(context.caller);
          const stream = await generateClient.responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<GrokStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromGrok(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              throw streamingFailureErrorFromEvent(event, "Grok streaming response failed.");
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.generationFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const generateClient = await this.client(context.caller);
        const response = await generateClient.responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.generationFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromGrok(response.usage),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
