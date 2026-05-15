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
import { withRetry } from "./retry.js";
import { textFromOpenAIResponse, userPrompt } from "./text.js";

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type OpenAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  // OpenAI may return additional cache fields under input_tokens_details
  // depending on the API surface; tolerate both.
  input_tokens_details?: {
    cached_tokens?: number;
  };
};

type OpenAIStreamEvent = {
  type: string;
  delta?: unknown;
  response?: {
    usage?: OpenAIUsage | null;
    model?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
};

function usageFromOpenAI(usage: OpenAIUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
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
    // OpenAI does not separately report write tokens; the diff between
    // total input and cached tokens is the "fresh" input tokens that
    // were potentially cacheable for the next call.
    if (inputTokens > cached) result.cache_write_tokens = inputTokens - cached;
    result.cache_provider_mode = "auto";
  } else {
    result.cache_provider_mode = "auto";
  }
  return result;
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

function openAIEffort(value: AppConfig["reasoning_effort"][PeerId]): OpenAIReasoningEffort {
  return value === "max" ? "xhigh" : (value ?? "xhigh");
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
            effort: openAIEffort(
              context.reasoning_effort_override ?? this.config.reasoning_effort.codex,
            ),
          },
          store: false,
          // OpenAI Responses API uses max_output_tokens, not Chat Completions max_tokens.
          max_output_tokens: this.config.max_output_tokens,
          // v2.21.0 (caching): pair-scoped prompt_cache_key. OpenAI uses
          // this to bucket cache entries; same caller+peer pair shares
          // hits across rounds within the configured retention window.
          // v2.21.0 (caching): prompt_cache_retention accepts only
          // "in_memory" | "24h" per OpenAI Responses API SDK types.
          // We translate the operator-facing config flag (5m or 1h) to
          // the closest accepted value: anything other than 1h →
          // "in_memory" (the API default of ~5min); 1h → "24h"
          // (extended retention, the only longer option).
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
          const reviewClient = await this.client();
          const stream = await reviewClient.responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<OpenAIStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromOpenAI(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              const message =
                event.type === "response.failed"
                  ? event.response?.error?.message
                  : event.error?.message;
              throw new Error(message ?? "OpenAI streaming response failed.");
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
        const reviewClient = await this.client();
        const response = await reviewClient.responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.resultFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromOpenAI(response.usage),
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
            effort: openAIEffort(
              context.reasoning_effort_override ?? this.config.reasoning_effort.codex,
            ),
          },
          store: false,
          max_output_tokens: this.config.max_output_tokens,
          // v2.21.0 (caching): prompt_cache_retention accepts only
          // "in_memory" | "24h" per OpenAI Responses API SDK types.
          // We translate the operator-facing config flag (5m or 1h) to
          // the closest accepted value: anything other than 1h →
          // "in_memory" (the API default of ~5min); 1h → "24h"
          // (extended retention, the only longer option).
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
          const generateClient = await this.client();
          const stream = await generateClient.responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<OpenAIStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromOpenAI(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              const message =
                event.type === "response.failed"
                  ? event.response?.error?.message
                  : event.error?.message;
              throw new Error(message ?? "OpenAI streaming response failed.");
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
        const generateClient = await this.client();
        const response = await generateClient.responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.generationFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromOpenAI(response.usage),
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
