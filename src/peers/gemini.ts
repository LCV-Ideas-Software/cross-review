// v2.27.1 (cold-start hardening): SDK lazy-loaded via dynamic import
// inside `client()` so the @google/genai module tree is not pulled at
// server boot. The `ThinkingLevel` enum is also runtime — exposed via
// the loader's return shape so `geminiThinkingConfig` keeps a stable
// signature without re-importing the module per call. Type-only import
// preserves all annotations.
import type { GoogleGenAI, ThinkingLevel } from "@google/genai";
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

function geminiThinkingConfig(
  model: string,
  ThinkingLevelEnum: typeof ThinkingLevel,
): {
  includeThoughts: false;
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
} {
  if (/gemini-3/i.test(model)) {
    return { includeThoughts: false, thinkingLevel: ThinkingLevelEnum.HIGH };
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
        const reviewClient = await this.client();
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}\n\n${statusInstruction()}`,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: statusJsonSchema,
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model, reviewClient.ThinkingLevel),
            ...(context.signal ? { abortSignal: context.signal } : {}),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await reviewClient.ai.models.generateContentStream(params);
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
        const response = (await reviewClient.ai.models.generateContent(params)) as GeminiResponse;
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
        const generateClient = await this.client();
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}`,
          config: {
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model, generateClient.ThinkingLevel),
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
        const response = (await generateClient.ai.models.generateContent(params)) as GeminiResponse;
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
