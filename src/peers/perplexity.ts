// v3.0.0 (operator directive 2026-05-12): Perplexity 6th peer.
//
// Perplexity's Sonar API exposes an OpenAI-Chat-Completions-compatible
// shape at `https://api.perplexity.ai` (the OpenAI Node SDK routes
// `/v1/chat/completions` calls through to `/v1/sonar` on Perplexity's
// side). Auth is HTTPBearer via PERPLEXITY_API_KEY.
//
// CONSIDERABLE DIFFERENCES vs the other 5 peers (operator-flagged):
//
// 1. WEB SEARCH IS DEFAULT. Every call performs a real-time web search
//    unless `disable_search: true` is set. The peer becomes a fact-check
//    overlay on top of the reasoning; citations + search_results are
//    always returned alongside the assistant message.
//
// 2. SYSTEM PROMPT IS HALF-HONORED. Per official docs: "the real-time
//    search component of Sonar models does not attend to the system
//    prompt." System messages shape ONLY the tone/style of the final
//    answer; the web-search query is derived from the user message.
//    For cross-review, this means the structured statusJsonSchema is
//    less strictly followed than with the other 5 peers — the adapter
//    must be tolerant of soft-format responses.
//
// 3. REASONING_EFFORT enum is `minimal|low|medium|high` — no `none`,
//    no `xhigh`, no `max`. The internal config scale includes the
//    larger values; `clampEffortForPerplexity()` narrows them down.
//
// 4. PRICING IS 3-DIMENSIONAL: input + output ($/M tokens) PLUS a
//    per-1000-request fee that scales with `search_context_size`
//    (low/medium/high). Sonar Deep Research adds a 4th dimension
//    (citation_tokens, reasoning_tokens, search_queries — all
//    separately billed). The cost layer reads ALL of these from
//    AppConfig.cost_rates.perplexity (via env vars).
//
// 5. USAGE.COST IS REPORTED PER-CALL BY THE API. Distinct from the
//    config-driven cost layer, Perplexity returns a `usage.cost` block
//    with USD breakdown (input_tokens_cost, output_tokens_cost,
//    reasoning_tokens_cost, request_cost, citation_tokens_cost,
//    search_queries_cost, total_cost). We surface that as a separate
//    telemetry signal but rely on the config-driven cost for budget
//    decisions (operator-controlled rates remain authoritative).
//
// All 6 peers remain symmetric in role assignment — Perplexity can be
// caller, lead_peer, or reviewer; the workspace HARD GATE
// (caller != lead_peer != reviewer per session) applies uniformly.
import type OpenAI from "openai";
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
import { BasePeerAdapter, StreamBuffer, type TokenEventBuffer } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { loadOpenAICtor } from "./openai.js";
import { withRetry } from "./retry.js";
import {
  assertChatCompletionTerminal,
  assertChatStreamCompleted,
  observeChatStreamTerminals,
} from "./terminal.js";
import { userPrompt } from "./text.js";

const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

// Sonar API usage shape (extends OpenAI Chat usage with citation_tokens,
// reasoning_tokens, num_search_queries, and a cost breakdown).
type SonarCostBreakdown = {
  input_tokens_cost?: number | undefined;
  output_tokens_cost?: number | undefined;
  reasoning_tokens_cost?: number | undefined;
  request_cost?: number | undefined;
  citation_tokens_cost?: number | undefined;
  search_queries_cost?: number | undefined;
  total_cost?: number | undefined;
};

type SonarUsage = {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  reasoning_tokens?: number | undefined;
  citation_tokens?: number | undefined;
  num_search_queries?: number | undefined;
  search_context_size?: string | undefined;
  cost?: SonarCostBreakdown | undefined;
};

function usageFromSonar(
  usage: SonarUsage | null | undefined,
  searchPerformed: boolean,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const result: TokenUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.reasoning_tokens,
  };
  // Perplexity does NOT document a prompt-cache surface in the public
  // Sonar API. Surface this explicitly so the cost layer + dashboard
  // never silently treat the absence as a hit.
  result.cache_provider_mode = "not_supported";
  // v3.0.0: Sonar-specific categories surfaced so the cost layer can
  // compute citation_tokens_cost + search_queries_cost (deep-research
  // models). Absent on non-deep-research models.
  if (typeof usage.citation_tokens === "number") {
    result.citation_tokens = usage.citation_tokens;
  }
  if (typeof usage.num_search_queries === "number") {
    result.num_search_queries = usage.num_search_queries;
  }
  // v3.0.0 R1 fix (codex cross-review catch 2026-05-12): per-call
  // signal that the cost layer needs to correctly attribute the
  // request fee. Relator (generate) calls force disable_search:true
  // on the wire regardless of operator config — without this signal,
  // estimateCost() would charge a request fee for searches that did
  // not actually run.
  result.search_performed = searchPerformed;
  // v3.0.0: capture provider-reported total cost for telemetry. The
  // config-driven cost.ts estimateCost remains authoritative; this is
  // a sanity-check signal only.
  if (typeof usage.cost?.total_cost === "number") {
    result.provider_reported_total_cost_usd = usage.cost.total_cost;
  }
  return result;
}

// Extract plain text from a Sonar non-streamed response. Tolerant of
// soft-format outputs because, per #2 above, the search component may
// not strictly honor the requested JSON schema. Callers downstream
// (resultFromText -> status.ts decisionQualityFromStatus) classify the
// quality of the parsed response.
//
// v3.2.0 fix (codex catch sess 41244a1c, observed across v3.0.0+):
// sonar-reasoning-pro and sonar-deep-research models always emit a
// `<think>...</think>` reasoning preamble before the actual structured
// answer. The shared status parser in `core/status.ts` requires the
// text to begin with JSON-shaped content (or contain it within
// extractable shape); the thinking block breaks both code paths and
// the format-recovery retry inherits the same problem. Strip every
// `<think>...</think>` block (non-greedy across lines, multiple
// occurrences) before downstream extraction. Real Sonar responses
// never legitimately include the literal substring "<think>" inside
// the structured payload, so this is safe.
const PERPLEXITY_THINKING_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const PERPLEXITY_OPEN_THINKING_BLOCK = /<think\b[^>]*>[\s\S]*$/i;
const PERPLEXITY_PARTIAL_THINKING_TAG = /<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i;
type TokenEventSink = {
  append(delta: string): void;
  complete(chars: number): void;
};

export function stripPerplexityThinkingBlock(raw: string): string {
  return raw.replace(PERPLEXITY_THINKING_BLOCK, "").trim();
}

export function stripPerplexityThinkingForTokenEvents(raw: string): string {
  return raw
    .replace(PERPLEXITY_THINKING_BLOCK, "")
    .replace(PERPLEXITY_OPEN_THINKING_BLOCK, "")
    .replace(PERPLEXITY_PARTIAL_THINKING_TAG, "");
}

function createPerplexityTokenEventBuffer(tokenStream: TokenEventBuffer): TokenEventSink {
  let raw = "";
  let emitted = "";
  return {
    append(delta: string): void {
      raw += delta;
      const visible = stripPerplexityThinkingForTokenEvents(raw);
      if (!visible.startsWith(emitted)) {
        emitted = visible;
        return;
      }
      const next = visible.slice(emitted.length);
      emitted = visible;
      tokenStream.append(next);
    },
    complete(chars: number): void {
      const visible = stripPerplexityThinkingForTokenEvents(raw);
      if (visible.startsWith(emitted)) {
        tokenStream.append(visible.slice(emitted.length));
      }
      tokenStream.complete(chars);
    },
  };
}

function sonarText(response: {
  choices?: Array<{ message?: { content?: string | null } }> | undefined;
}): string {
  const raw = response.choices?.[0]?.message?.content?.trim() || JSON.stringify(response);
  return stripPerplexityThinkingBlock(raw);
}

// v3.0.0: Perplexity reasoning_effort enum is `minimal|low|medium|high`.
// The internal config scale can reach `xhigh`/`max` (used by other
// peers). Clamp down so the on-wire value is always one Perplexity
// accepts.
//
// Exported so the smoke harness can verify the clamp shape directly
// (anti-drift, same pattern as `clampEffortForModel` in grok.ts).
type PerplexityReasoningEffort = "minimal" | "low" | "medium" | "high";

export function clampEffortForPerplexity(
  effort: AppConfig["reasoning_effort"][PeerId],
): PerplexityReasoningEffort {
  switch (effort) {
    case "none":
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

// v3.0.0: Sonar models that accept the `reasoning_effort` body field.
// Per docs, only `sonar-reasoning-pro` and `sonar-deep-research`
// recognize it; `sonar` and `sonar-pro` ignore the field (no chain-
// of-thought stage). Exported for smoke verification.
export const PERPLEXITY_REASONING_EFFORT_MODELS: ReadonlySet<string> = new Set([
  "sonar-reasoning-pro",
  "sonar-deep-research",
]);

export function perplexityAcceptsReasoningEffort(model: string): boolean {
  return PERPLEXITY_REASONING_EFFORT_MODELS.has(model);
}

// Type the Perplexity-specific request body extension (web_search_options
// + search-control fields) as an additive overlay on top of the
// OpenAI Chat Completions params type. The OpenAI Node SDK forwards
// unknown body fields untouched, so Perplexity's Sonar-only knobs
// reach the wire without TypeScript complaints.
type PerplexitySonarOptions = {
  web_search_options?: {
    search_context_size: "low" | "medium" | "high";
  };
  disable_search?: boolean;
  reasoning_effort?: PerplexityReasoningEffort;
};

type PerplexityChatPayload = OpenAI.ChatCompletionCreateParamsNonStreaming & PerplexitySonarOptions;
type PerplexityChatStreamPayload = OpenAI.ChatCompletionCreateParamsStreaming &
  PerplexitySonarOptions;

// v3.0.0 (operator directive 2026-05-12): role-aware search behavior.
// Perplexity's web-search differentiator is most valuable in the
// REVIEWER role (fact-check overlay on the draft under review). In the
// RELATOR role (lead_peer revising consensus into a new draft) or
// during PROBE (health check), the search component should be OFF
// because the task is synthesis, not external lookup. The role is
// inferred from which adapter method the orchestrator invokes:
//   - `call()`  → reviewer  → search HONORED per config (default ON)
//   - `generate()` → relator  → search FORCED OFF
//   - `probe()` → auth_only by default; live probe uses search FORCED OFF
// This preserves Perplexity's role-symmetry across the sexteto (it can
// still be caller / lead_peer / reviewer per session) while the
// adapter's internal contract ensures the search behavior matches the
// role the peer is currently playing.
type SonarRole = "reviewer" | "relator";

function buildSonarOptions(
  config: AppConfig,
  model: string,
  role: SonarRole,
  effortOverride?: AppConfig["reasoning_effort"][PeerId],
): PerplexitySonarOptions {
  const opts: PerplexitySonarOptions = {
    web_search_options: { search_context_size: config.perplexity.search_context_size },
  };
  // Relator (generate) role: search is structurally inappropriate
  // because the task is to synthesize a revised draft from the other
  // peers' verdicts, not to consult external sources. Force-off
  // regardless of operator config.
  // Reviewer (call) role: search active per config (default true; can
  // be disabled via CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH=true).
  if (role === "relator" || config.perplexity.disable_search) {
    opts.disable_search = true;
  }
  if (perplexityAcceptsReasoningEffort(model)) {
    opts.reasoning_effort = clampEffortForPerplexity(
      effortOverride ?? config.reasoning_effort.perplexity,
    );
  }
  return opts;
}

export class PerplexityAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "perplexity";
  provider = "perplexity";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.perplexity;
  }

  // Per v2.27.1 cold-start hardening: reuse the lazy OpenAI SDK ctor
  // shared with peers/openai.ts + peers/deepseek.ts + peers/grok.ts so
  // the `openai` module is loaded exactly once across all four
  // OpenAI-SDK-driven adapters.
  private async client(): Promise<OpenAI> {
    const apiKey = this.config.api_keys.perplexity;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY was not found in environment variables.");
    const Ctor = await loadOpenAICtor();
    return new Ctor({ apiKey, baseURL: PERPLEXITY_BASE_URL });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.perplexity);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.perplexity,
        message: "PERPLEXITY_API_KEY is missing.",
      };
    }
    if (this.config.perplexity.probe_mode === "auth_only") {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.perplexity,
        message:
          "Perplexity probe_mode=auth_only: skipped tokenized Sonar round-trip because Perplexity does not document a zero-token model/auth endpoint.",
      };
    }
    // Perplexity does not document a public `models.list` endpoint via
    // the OpenAI-SDK base path. Live probe uses a minimal `disable_search`
    // call to avoid burning a request fee on the health check; Sonar
    // reasoning models reject values below 16 even for probes.
    try {
      const probeClient = await this.client();
      const probePayload: PerplexityChatPayload = {
        model: this.model,
        messages: [{ role: "user", content: "." }],
        max_tokens: 16,
        disable_search: true,
      };
      await probeClient.chat.completions.create(probePayload, {
        timeout: this.config.retry.timeout_ms,
      });
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.perplexity,
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
        model_selection: this.config.model_selection.perplexity,
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
          message: `Perplexity review attempt ${attempt}`,
        });
        const sonarOptions = buildSonarOptions(
          this.config,
          this.model,
          "reviewer",
          context.reasoning_effort_override,
        );
        // v3.0.0 R1 fix (codex catch): the reviewer role HONORS config;
        // disable_search is only set on the wire when config explicitly
        // turns it off. Derive search_performed from the actual on-wire
        // option so the cost layer charges request fee iff a search
        // really ran.
        const searchPerformed = sonarOptions.disable_search !== true;
        const payload: PerplexityChatPayload = {
          ...sonarOptions,
          model: this.model,
          messages: [
            { role: "system", content: this.systemPrompt(context) },
            { role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` },
          ],
          // Perplexity supports the OpenAI structured-output shape, but
          // the docs warn the FIRST request with a new schema can
          // incur 10-30s latency. Because the same statusJsonSchema is
          // reused across every cross-review call, that one-time cost
          // is amortized for the operator. Schema `name` is required
          // (1-64 alphanumeric chars).
          response_format: {
            type: "json_schema",
            json_schema: { name: "cross_review_status", schema: statusJsonSchema },
          } as NonNullable<OpenAI.ChatCompletionCreateParams["response_format"]>,
          max_tokens: this.config.max_output_tokens,
        };
        if (this.shouldStreamTokens(context)) {
          const streamPayload: PerplexityChatStreamPayload = {
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
          const perplexityTokenStream = createPerplexityTokenEventBuffer(tokenStream);
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let chunks = 0;
          const completedChoices = new Set<number>();
          for await (const chunk of stream) {
            chunks += 1;
            modelReported = chunk.model ?? modelReported;
            usage =
              usageFromSonar(chunk.usage as SonarUsage | null | undefined, searchPerformed) ??
              usage;
            observeChatStreamTerminals(chunk.choices, completedChoices, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "review",
              allowToolCalls: false,
            });
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta?.content ?? "";
              stream_buffer.append(delta);
              perplexityTokenStream.append(delta);
            }
          }
          assertChatStreamCompleted(completedChoices, {
            context,
            peer: this.id,
            provider: this.provider,
            model: this.model,
            phase: "review",
          });
          // v3.4.0 Fix #1: apply stripPerplexityThinkingBlock to the
          // streamed text. Non-streaming path at line ~426 uses
          // sonarText(response) which already strips; streaming path was
          // bypassing the strip entirely, causing <think> preambles from
          // sonar-reasoning-pro to reach the status parser and fail with
          // unparseable_after_recovery despite valid trailing JSON.
          // Forensic evidence: sess f9a19401 (v3.3.0 self-investigation)
          // — 4 peers converged READY on this exact diagnosis. Affected
          // sessions: f72e597a, 99d46a2b, 00d92cce, 59776026, 41244a1c,
          // e23d6920. Perplexity ready_rate was 0.28125 vs ~1.0 for
          // other peers; this restores parity at the streaming path.
          const text = stripPerplexityThinkingBlock(stream_buffer.text());
          perplexityTokenStream.complete(text.length);
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
        assertChatCompletionTerminal(response.choices, {
          context,
          peer: this.id,
          provider: this.provider,
          model: this.model,
          phase: "review",
          allowToolCalls: false,
        });
        return this.resultFromText({
          text: sonarText(response),
          raw: response,
          usage: usageFromSonar((response as { usage?: SonarUsage }).usage, searchPerformed),
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
          message: `Perplexity generation attempt ${attempt}`,
        });
        const sonarOptions = buildSonarOptions(
          this.config,
          this.model,
          "relator",
          context.reasoning_effort_override,
        );
        // v3.0.0 R1 fix (codex catch): the relator role ALWAYS forces
        // disable_search:true on the wire (synthesis task, not external
        // lookup). search_performed is unconditionally false so the
        // cost layer's request-fee accounting does not charge for a
        // search that did not run.
        const searchPerformed = sonarOptions.disable_search !== true;
        const payload: PerplexityChatPayload = {
          ...sonarOptions,
          model: this.model,
          messages: [
            { role: "system", content: this.systemPrompt(context) },
            { role: "user", content: userPrompt(prompt) },
          ],
          max_tokens: this.config.max_output_tokens,
        };
        if (this.shouldStreamTokens(context)) {
          const streamPayload: PerplexityChatStreamPayload = {
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
          const perplexityTokenStream = createPerplexityTokenEventBuffer(tokenStream);
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          let chunks = 0;
          const completedChoices = new Set<number>();
          for await (const chunk of stream) {
            chunks += 1;
            modelReported = chunk.model ?? modelReported;
            usage =
              usageFromSonar(chunk.usage as SonarUsage | null | undefined, searchPerformed) ??
              usage;
            observeChatStreamTerminals(chunk.choices, completedChoices, {
              context,
              peer: this.id,
              provider: this.provider,
              model: this.model,
              phase: "generation",
              allowToolCalls: false,
            });
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta?.content ?? "";
              stream_buffer.append(delta);
              perplexityTokenStream.append(delta);
            }
          }
          assertChatStreamCompleted(completedChoices, {
            context,
            peer: this.id,
            provider: this.provider,
            model: this.model,
            phase: "generation",
          });
          // v3.4.0 Fix #1: streaming-path strip parity for generation
          // (relator) path — same root cause as the call() branch above.
          // When Perplexity is sortead as relator (e.g. sess 51973fac),
          // the streamed `<think>` block reached round-N-draft.md
          // verbatim and confused downstream reviewers into reviewing
          // the think reasoning itself. Strip at the streaming boundary
          // so the relator artifact is clean before persistence.
          const text = stripPerplexityThinkingBlock(stream_buffer.text());
          perplexityTokenStream.complete(text.length);
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
        assertChatCompletionTerminal(response.choices, {
          context,
          peer: this.id,
          provider: this.provider,
          model: this.model,
          phase: "generation",
          allowToolCalls: false,
        });
        return this.generationFromText({
          text: sonarText(response),
          raw: response,
          usage: usageFromSonar((response as { usage?: SonarUsage }).usage, searchPerformed),
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
