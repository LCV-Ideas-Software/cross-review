// v2.27.1 (cold-start hardening): reuse the lazy OpenAI ctor loaded by
// peers/openai.ts. DeepSeek + OpenAI + Grok share the same `openai`
// package, so a single dynamic import resolves the SDK module exactly
// once across all three adapters. Type-only import preserves the
// `OpenAI.ChatCompletionCreateParams*` namespace types at compile time.
import type OpenAI from "openai";
import { statusInstruction } from "../core/status.js";
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
import { loadOpenAICtor } from "./openai.js";
import { withRetry } from "./retry.js";
import { userPrompt } from "./text.js";

type ChatUsage = {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  completion_tokens_details?: {
    reasoning_tokens?: number | undefined;
  };
  // v2.21.0 (caching): DeepSeek surfaces cache telemetry on the
  // OpenAI-compatible Chat Completions response with two non-OpenAI
  // fields. Read both, treat miss as fresh tokens (cache_write_tokens)
  // even though DeepSeek auto-caches without explicit write semantics —
  // this lets operators observe what fraction of input was eligible
  // for future cache hits.
  prompt_cache_hit_tokens?: number | undefined;
  prompt_cache_miss_tokens?: number | undefined;
};

type DeepSeekReasoningEffort = "high" | "max";
type DeepSeekThinkingExtension = {
  thinking: {
    type: "enabled";
    reasoning_effort: DeepSeekReasoningEffort;
  };
};
type DeepSeekChatPayload = OpenAI.ChatCompletionCreateParamsNonStreaming &
  DeepSeekThinkingExtension;
type DeepSeekChatStreamPayload = OpenAI.ChatCompletionCreateParamsStreaming &
  DeepSeekThinkingExtension;

function usageFromChat(usage: ChatUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
  const result: TokenUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
  if (cacheHit > 0 || cacheMiss > 0) {
    if (cacheHit > 0) result.cache_read_tokens = cacheHit;
    if (cacheMiss > 0) result.cache_write_tokens = cacheMiss;
    result.cache_provider_mode = "auto";
  }
  return result;
}

function chatText(response: {
  choices?: Array<{ message?: { content?: string | null } }> | undefined;
}): string {
  return response.choices?.[0]?.message?.content?.trim() || JSON.stringify(response);
}

function deepSeekReasoningEffort(
  value: AppConfig["reasoning_effort"][PeerId],
): DeepSeekReasoningEffort {
  return value === "max" || value === "xhigh" ? "max" : "high";
}

function deepSeekThinking(
  config: AppConfig,
  override?: AppConfig["reasoning_effort"][PeerId],
): DeepSeekThinkingExtension {
  return {
    thinking: {
      type: "enabled",
      reasoning_effort: deepSeekReasoningEffort(override ?? config.reasoning_effort.deepseek),
    },
  };
}

export class DeepSeekAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "deepseek";
  provider = "deepseek";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.deepseek;
  }

  private async client(): Promise<OpenAI> {
    const apiKey = this.config.api_keys.deepseek;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY was not found in environment variables.");
    const Ctor = await loadOpenAICtor();
    return new Ctor({ apiKey, baseURL: "https://api.deepseek.com" });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.deepseek);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.deepseek,
        message: "DEEPSEEK_API_KEY is missing.",
      };
    }
    try {
      const probeClient = await this.client();
      await probeClient.models.list({ timeout: this.config.retry.timeout_ms });
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.deepseek,
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
        model_selection: this.config.model_selection.deepseek,
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
          message: `DeepSeek review attempt ${attempt}`,
        });
        const payload: DeepSeekChatPayload = {
          ...deepSeekThinking(this.config, context.reasoning_effort_override),
          model: this.model,
          messages: [
            { role: "system", content: this.systemPrompt(context) },
            { role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` },
          ],
          response_format: { type: "json_object" },
          max_tokens: this.config.max_output_tokens,
        };
        // DeepSeek's OpenAI-compatible API accepts the non-OpenAI `thinking` body field;
        // the OpenAI JS client forwards unknown body keys, and the real API smoke verifies it.
        if (this.shouldStreamTokens(context)) {
          const streamPayload: DeepSeekChatStreamPayload = {
            ...payload,
            stream: true,
            stream_options: { include_usage: true },
          };
          const reviewClient = await this.client();
          const stream = await reviewClient.chat.completions.create(streamPayload, {
            signal: context.signal,
            timeout: this.config.retry.timeout_ms,
          });
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "chat.completion.chunk.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let chunks = 0;
          for await (const chunk of stream) {
            chunks += 1;
            modelReported = chunk.model ?? modelReported;
            usage = usageFromChat(chunk.usage) ?? usage;
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta?.content ?? "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.resultFromText({
            text,
            raw: { streamed: true, provider: this.provider, chunks, model: modelReported },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const reviewClient = await this.client();
        const response = await reviewClient.chat.completions.create(payload, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.resultFromText({
          text: chatText(response),
          raw: response,
          usage: usageFromChat(response.usage),
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
          message: `DeepSeek generation attempt ${attempt}`,
        });
        const payload: DeepSeekChatPayload = {
          ...deepSeekThinking(this.config, context.reasoning_effort_override),
          model: this.model,
          messages: [
            { role: "system", content: this.systemPrompt(context) },
            { role: "user", content: userPrompt(prompt) },
          ],
          max_tokens: this.config.max_output_tokens,
        };
        // DeepSeek's OpenAI-compatible API accepts the non-OpenAI `thinking` body field;
        // the OpenAI JS client forwards unknown body keys, and the real API smoke verifies it.
        if (this.shouldStreamTokens(context)) {
          const streamPayload: DeepSeekChatStreamPayload = {
            ...payload,
            stream: true,
            stream_options: { include_usage: true },
          };
          const generateClient = await this.client();
          const stream = await generateClient.chat.completions.create(streamPayload, {
            signal: context.signal,
            timeout: this.config.retry.timeout_ms,
          });
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "chat.completion.chunk.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let chunks = 0;
          for await (const chunk of stream) {
            chunks += 1;
            modelReported = chunk.model ?? modelReported;
            usage = usageFromChat(chunk.usage) ?? usage;
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta?.content ?? "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.generationFromText({
            text,
            raw: { streamed: true, provider: this.provider, chunks, model: modelReported },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const generateClient = await this.client();
        const response = await generateClient.chat.completions.create(payload, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.generationFromText({
          text: chatText(response),
          raw: response,
          usage: usageFromChat(response.usage),
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
