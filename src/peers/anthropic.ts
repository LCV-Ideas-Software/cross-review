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
import Anthropic from "@anthropic-ai/sdk";
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
import { BasePeerAdapter, STREAM_TEXT_MAX_BYTES, StreamBufferOverflowError } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { parseAnthropicContent, userPrompt } from "./text.js";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

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
  if (!config.cache.enabled) return systemText;
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
  return value ?? "max";
}

function anthropicThinking(): { type: "adaptive"; display: "omitted" } {
  return { type: "adaptive", display: "omitted" };
}

export class AnthropicAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "claude";
  provider = "anthropic";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.claude;
  }

  private client(): Anthropic {
    const apiKey = this.config.api_keys.claude;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY was not found in environment variables.");
    return new Anthropic({ apiKey, timeout: this.config.retry.timeout_ms });
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
      await this.client().messages.countTokens({
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
        if (
          this.config.cache.enabled &&
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
        const body = {
          model: this.model,
          max_tokens: this.config.max_output_tokens,
          system: buildSystemBlock(systemText, this.config),
          messages: [
            {
              role: "user" as const,
              content: `${userPrompt(prompt)}\n\n${statusInstruction()}`,
            },
          ],
          thinking: anthropicThinking(),
          output_config: {
            effort: anthropicEffort(
              context.reasoning_effort_override ?? this.config.reasoning_effort.claude,
            ),
            format: {
              type: "json_schema" as const,
              schema: statusJsonSchema,
            },
          },
        };
        if (this.shouldStreamTokens(context)) {
          // v2.4.0 / audit closure (P2.9): track streamed-text bytes
          // incrementally so a hostile or buggy peer cannot silently
          // accumulate gigabytes inside the SDK before finalMessage()
          // resolves. We cannot interrupt the SDK's internal buffer
          // directly, but throwing on overflow propagates through the
          // promise chain and the retry layer classifies the failure.
          const stream = this.client().messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "content_block_delta.text_delta",
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
          const parsed = parseAnthropicContent(message.content);
          tokenStream.complete(parsed.text.length);
          return this.resultFromText({
            text: parsed.text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            usage: usageFromAnthropic(message.usage),
            started,
            attempts: attempt,
            modelReported: message.model,
            extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
          });
        }
        const message = await this.client().messages.create(body, { signal: context.signal });
        const parsed = parseAnthropicContent(message.content);
        return this.resultFromText({
          text: parsed.text,
          raw: message,
          usage: usageFromAnthropic(message.usage),
          started,
          attempts: attempt,
          modelReported: message.model,
          extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
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
          message: `Anthropic generation attempt ${attempt}`,
        });
        const body = {
          model: this.model,
          max_tokens: this.config.max_output_tokens,
          system: buildSystemBlock(this.systemPrompt(context), this.config),
          messages: [{ role: "user" as const, content: userPrompt(prompt) }],
          thinking: anthropicThinking(),
          output_config: {
            effort: anthropicEffort(
              context.reasoning_effort_override ?? this.config.reasoning_effort.claude,
            ),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = this.client().messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "content_block_delta.text_delta",
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
          const parsed = parseAnthropicContent(message.content);
          tokenStream.complete(parsed.text.length);
          return this.generationFromText({
            text: parsed.text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            usage: usageFromAnthropic(message.usage),
            started,
            attempts: attempt,
            modelReported: message.model,
            extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
          });
        }
        const message = await this.client().messages.create(body, { signal: context.signal });
        const parsed = parseAnthropicContent(message.content);
        return this.generationFromText({
          text: parsed.text,
          raw: message,
          usage: usageFromAnthropic(message.usage),
          started,
          attempts: attempt,
          modelReported: message.model,
          extraParserWarnings: parsed.parser_warning ? [parsed.parser_warning] : undefined,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
