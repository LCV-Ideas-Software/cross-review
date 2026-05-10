import { GoogleGenAI, ThinkingLevel } from "@google/genai";
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
import { statusInstruction, statusJsonSchema } from "../core/status.js";
import { BasePeerAdapter, StreamBuffer } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { userPrompt } from "./text.js";

type GeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  // v2.21.0 (caching): Gemini supports an IMPLICIT cache that is auto-
  // applied. We only consume telemetry — no payload changes. When the
  // service caches a prefix it reports `cachedContentTokenCount`; we
  // surface this as cache_read_tokens with mode="implicit". Explicit
  // `caches.create` is intentionally NOT enabled here (deferred to a
  // future ship) to avoid contention with `thinking` configurations.
  cachedContentTokenCount?: number;
};

type GeminiResponse = {
  text?: string;
  modelVersion?: string;
  usageMetadata?: GeminiUsage;
};

function usageFromGemini(usage: GeminiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cachedContentTokenCount ?? 0;
  const result: TokenUsage = {
    input_tokens: usage.promptTokenCount,
    output_tokens: usage.candidatesTokenCount,
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

function geminiThinkingConfig(model: string): {
  includeThoughts: false;
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
} {
  if (/gemini-3/i.test(model)) {
    return { includeThoughts: false, thinkingLevel: ThinkingLevel.HIGH };
  }
  return { includeThoughts: false, thinkingBudget: -1 };
}

export class GeminiAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "gemini";
  provider = "google";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.gemini;
  }

  private client(): GoogleGenAI {
    const apiKey = this.config.api_keys.gemini;
    if (!apiKey) throw new Error("GEMINI_API_KEY was not found in environment variables.");
    return new GoogleGenAI({ apiKey });
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
      const pager = await this.client().models.list({ config: { pageSize: 1 } });
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
        // v2.4.0 / audit closure (P2.8): pass AbortSignal to GoogleGenAI.
        // The SDK accepts `requestOptions.signal`; without it,
        // session_cancel_job cannot interrupt an in-flight Gemini call
        // and continues burning tokens until the response naturally
        // arrives.
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}\n\n${statusInstruction()}`,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: statusJsonSchema,
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model),
            abortSignal: context.signal,
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await this.client().models.generateContentStream(params);
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "generateContentStream.text",
          );
          let last: GeminiResponse | undefined;
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const delta = chunk.text ?? "";
            stream_buffer.append(delta);
            tokenStream.append(delta);
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.resultFromText({
            text: text || (last?.text ?? JSON.stringify(last ?? {})),
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: usageFromGemini(last?.usageMetadata),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
          });
        }
        const response = (await this.client().models.generateContent(params)) as GeminiResponse;
        return this.resultFromText({
          text: response.text ?? JSON.stringify(response),
          raw: response,
          usage: usageFromGemini(response.usageMetadata),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
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
          message: `Gemini generation attempt ${attempt}`,
        });
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}`,
          config: {
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model),
            abortSignal: context.signal,
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await this.client().models.generateContentStream(params);
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "generateContentStream.text",
          );
          let last: GeminiResponse | undefined;
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const delta = chunk.text ?? "";
            stream_buffer.append(delta);
            tokenStream.append(delta);
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.generationFromText({
            text: text || (last?.text ?? JSON.stringify(last ?? {})),
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: usageFromGemini(last?.usageMetadata),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
          });
        }
        const response = (await this.client().models.generateContent(params)) as GeminiResponse;
        return this.generationFromText({
          text: response.text ?? JSON.stringify(response),
          raw: response,
          usage: usageFromGemini(response.usageMetadata),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
