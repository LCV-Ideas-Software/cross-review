// Reuse the official lazy OpenAI SDK constructor for DeepSeek's native
// Responses-compatible endpoint. No Chat or model fallback is configured.
import type OpenAI from "openai";
import { maxOutputTokensForPeer } from "../core/output-budget.js";
import { portableStatusJsonSchema, statusInstruction } from "../core/status.js";
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
import {
  assertResponsesCompletion,
  assertResponsesStreamCompleted,
  assertResponsesStreamNotRefused,
  observeResponsesStreamRefusal,
  observeResponsesStreamTerminal,
  withEstimatedTerminalBilling,
} from "./terminal.js";
import { userPrompt } from "./text.js";

type DeepSeekUsage = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  total_tokens?: number | undefined;
  input_tokens_details?: { cached_tokens?: number | undefined };
  output_tokens_details?: { reasoning_tokens?: number | undefined };
};
type DeepSeekResponse = {
  id?: string | undefined;
  status?: string | undefined;
  model?: string | undefined;
  incomplete_details?: { reason?: string | undefined } | null | undefined;
  output?: unknown;
  usage?: DeepSeekUsage | null | undefined;
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
type DeepSeekStreamEvent = Parameters<typeof streamingFailureErrorFromEvent>[0] & {
  type: string;
  delta?: unknown;
  response?: DeepSeekResponse;
};

function usageFromResponse(usage: DeepSeekUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  // Native input totals include cache reads; native output totals already
  // include reasoning. Keep mutually exclusive input buckets and never add
  // reasoning again. Responses has no cache-miss/write counter.
  const result: TokenUsage = {
    input_tokens:
      usage.input_tokens === undefined ? undefined : Math.max(0, usage.input_tokens - cached),
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
    cache_provider_mode: "auto",
  };
  if (cached > 0) result.cache_read_tokens = cached;
  return result;
}

function assistantOutput(response: DeepSeekResponse | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(response?.output)) return [];
  return response.output.filter(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === "object" &&
      item.type === "message" &&
      item.role === "assistant" &&
      Array.isArray(item.content),
  );
}

function responseText(response: DeepSeekResponse | undefined, boundedStream = false): string {
  // Only final assistant output_text is a draft/verdict. Never serialize an
  // empty response envelope or a reasoning item into generation text.
  const parts = assistantOutput(response)
    .flatMap((item) => item.content as unknown[])
    .filter(
      (part): part is { type: "output_text"; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text);
  if (!boundedStream) return parts.join("").trim();
  // The native completed object may carry text without provisional deltas.
  // Apply the same existing per-call byte cap before concatenating its parts.
  const buffer = new StreamBuffer("deepseek");
  for (const part of parts) buffer.append(part);
  return buffer.text().trim();
}

function deepSeekReasoningEffort(
  value: AppConfig["reasoning_effort"][PeerId],
): "low" | "high" | "max" {
  if (value === "none" || value === "minimal" || value === "low") return "low";
  return value === "max" || value === "ultra" ? "max" : "high";
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
    return new Ctor({ apiKey, baseURL: "https://api.deepseek.com", maxRetries: 0 });
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
      const models = await probeClient.models.list({ timeout: this.config.retry.timeout_ms });
      const available = models.data.some((model) => model.id === this.model);
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.deepseek,
        ...(available
          ? {}
          : {
              message: `DeepSeek model ${this.model} was not returned by the authenticated model catalog.`,
            }),
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

  private async response(
    prompt: string,
    context: PeerCallContext,
    phase: "review" | "generation",
    attempt: number,
  ) {
    const body = {
      model: this.model,
      // DeepSeek inserts instructions as the first system message. A
      // developer input role is treated as user and cannot carry this policy.
      instructions: this.systemPrompt(context),
      input:
        phase === "review" ? `${userPrompt(prompt)}\n\n${statusInstruction()}` : userPrompt(prompt),
      reasoning: {
        effort: deepSeekReasoningEffort(
          context.reasoning_effort_override ?? this.config.reasoning_effort.deepseek,
        ),
      },
      max_output_tokens:
        context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
      ...(phase === "review"
        ? {
            text: {
              format: {
                type: "json_schema" as const,
                name: "cross_review_status",
                schema: portableStatusJsonSchema,
              },
            },
          }
        : {}),
    };
    // Native Responses is stateless and automatically cached. Do not send
    // unsupported store/cache/search/stream_options fields or a Chat fallback.
    const client = await this.client();
    const options = { signal: context.signal, timeout: this.config.retry.timeout_ms };
    const terminalParams = {
      context,
      peer: this.id,
      provider: this.provider,
      model: this.model,
      phase,
    };
    if (!this.shouldStreamTokens(context)) {
      const response = await client.responses.create(
        body as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        options,
      );
      const usage = usageFromResponse(response.usage);
      withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
        if (response.error)
          throw streamingFailureErrorFromEvent(
            { type: "response.failed", response },
            "DeepSeek response failed.",
          );
        assertResponsesCompletion(response, terminalParams);
      });
      const text = responseText(response);
      return {
        text,
        raw: response,
        usage,
        modelReported: response.model,
        extraParserWarnings: text ? [] : ["deepseek_completed_without_assistant_text"],
      };
    }
    const streamBuffer = new StreamBuffer(this.id);
    const tokenStream = this.createTokenEventBuffer(
      context,
      phase,
      "response.output_text.delta",
      attempt,
    );
    const stream = await client.responses.create(
      { ...body, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
      options,
    );
    let terminal: DeepSeekResponse | undefined;
    let usage: TokenUsage | undefined;
    let responseCompleted = false;
    let responseRefused = false;
    let chunks = 0;
    for await (const event of stream as AsyncIterable<DeepSeekStreamEvent>) {
      chunks += 1;
      responseRefused = observeResponsesStreamRefusal(event, responseRefused);
      usage = usageFromResponse(event.response?.usage) ?? usage;
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      )
        terminal = event.response;
      withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
        if (
          event.type === "response.failed" ||
          event.type === "error" ||
          event.type === "response.error"
        ) {
          throw streamingFailureErrorFromEvent(event, "DeepSeek streaming response failed.");
        }
        responseCompleted = observeResponsesStreamTerminal(
          event,
          responseCompleted,
          terminalParams,
        );
      });
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        streamBuffer.append(event.delta);
        tokenStream.append(event.delta);
      }
    }
    withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
      assertResponsesStreamCompleted(responseCompleted, terminalParams);
      assertResponsesStreamNotRefused(responseRefused, terminalParams);
    });
    // The completed event carries the full native response. Provisional text
    // deltas or reasoning cannot replace a missing final assistant message.
    const text = withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () =>
      responseText(terminal, true),
    );
    tokenStream.complete(text.length);
    return {
      text,
      raw: {
        streamed: true,
        provider: this.provider,
        chunks,
        model: terminal?.model ?? null,
        response_id: terminal?.id ?? null,
        status: terminal?.status ?? null,
        incomplete_details: terminal?.incomplete_details ?? null,
        error: terminal?.error ?? null,
        output: assistantOutput(terminal),
        usage: terminal?.usage ?? null,
      },
      usage,
      modelReported: terminal?.model,
      extraParserWarnings: text ? [] : ["deepseek_completed_without_assistant_text"],
    };
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
        const response = await this.response(prompt, context, "review", attempt);
        return this.resultFromText({ ...response, started, attempts: attempt });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "review", attempt);
        return classifyProviderError(this.id, this.provider, this.model, error, attempt, started);
      },
      { signal: context.signal },
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
        const response = await this.response(prompt, context, "generation", attempt);
        return this.generationFromText({ ...response, started, attempts: attempt });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "generation", attempt);
        return classifyProviderError(this.id, this.provider, this.model, error, attempt, started);
      },
      { signal: context.signal },
    );
  }
}
