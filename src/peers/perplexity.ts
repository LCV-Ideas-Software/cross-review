// v3.0.0 (operator directive 2026-05-12): Perplexity 6th peer.
// v4.6.0 (provider-doc refresh 2026-08-23): Agent API migration.
//
// Perplexity retires the Sonar Chat Completions API on 27/09/2026
// ("Sonar Chat Completions is now Agent API. Sonar will be supported
// until September 27, 2026" — docs.perplexity.ai model pages). The Agent
// API is `POST https://api.perplexity.ai/v1/agent`, with `/v1/responses`
// documented as an alias for OpenAI SDK compatibility: the request and
// response shapes follow the OpenAI Responses API, so this adapter uses
// the shared `openai` client at base URL `https://api.perplexity.ai/v1`
// and `client.responses.create()` — the same protocol peers/openai.ts and
// peers/grok.ts already speak. Auth is HTTPBearer via PERPLEXITY_API_KEY.
//
// Model ids use the documented `provider/model` form (for example the
// canonical pin `perplexity/kimi-k3`). Legacy unprefixed Sonar ids
// (`sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research`)
// belong to the retiring Chat Completions surface and are rejected with a
// diagnostic error before any network call.
//
// CONSIDERABLE DIFFERENCES vs the other 5 peers (operator-flagged):
//
// 1. WEB SEARCH IS A TOOL. Search runs only when the request declares
//    `tools: [{ type: "web_search" }]`. The reviewer role sends the tool
//    (fact-check overlay, per config); the relator/judge role never does.
//    Search results come back as `search_results` output items alongside
//    the assistant `message` item.
//
// 2. REASONING EFFORT is the Responses `reasoning.effort` object with the
//    documented enum `minimal|low|medium|high|xhigh|max` (API reference,
//    verified live with `perplexity/kimi-k3` on 23/08/2026).
//
// 3. PRICING IS 3-DIMENSIONAL: input + output ($/M tokens, plus a cache
//    read rate) PLUS a per-invocation web-search tool fee reported in
//    `usage.tool_calls_details`. `max_steps` bounds the agent loop but NOT
//    the number of web-search invocations inside a step (3 parallel
//    searches were observed with `max_steps: 1`), so post-call accounting
//    is exact from `tool_calls_details` while the preflight uses the
//    declared `perplexity.web_search_invocations_estimate`.
//
// 4. USAGE.INPUT_TOKENS INCLUDES CACHED TOKENS. The provider bills fresh
//    input at the input rate and `input_tokens_details.cache_read_input_tokens`
//    at the cache rate, so the adapter splits them into the mutually
//    exclusive TokenUsage buckets before cost.ts prices them.
//
// 5. USAGE.COST IS REPORTED PER-CALL BY THE API. Distinct from the
//    config-driven cost layer, the Agent API returns a `usage.cost` block
//    (input_cost, output_cost, cache_read_cost, tool_calls_cost,
//    total_cost). We surface `total_cost` as a separate telemetry signal
//    but rely on the config-driven cost for budget decisions
//    (operator-controlled rates remain authoritative).
//
// All 6 peers remain symmetric in role assignment — Perplexity can be
// caller, lead_peer, or reviewer; the workspace HARD GATE
// (caller != lead_peer != reviewer per session) applies uniformly.
import type OpenAI from "openai";
import { isPerplexityAgentModel } from "../core/cost.js";
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
import { BasePeerAdapter, StreamBuffer, type TokenEventBuffer } from "./base.js";
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

// The OpenAI SDK appends `/responses` to the base URL, which lands on the
// documented Agent API alias `POST /v1/responses`.
export const PERPLEXITY_BASE_URL = "https://api.perplexity.ai/v1";
export const PERPLEXITY_SONAR_SUNSET_DATE = "27/09/2026";
export const PERPLEXITY_AGENT_MODELS_DOCS = "https://docs.perplexity.ai/docs/agent-api/models";

// Agent API model ids are `provider/model` (e.g. `perplexity/kimi-k3`,
// `openai/gpt-5.6-sol`). Anything without the provider segment is a
// legacy Sonar Chat Completions id, which this adapter no longer speaks.
// The single implementation lives in core/cost.ts so the adapter, the cost
// layer, the financial preflight and the server boot notice can never
// disagree about the same pin (including the `models/` prefix rule).
export { isPerplexityAgentModel } from "../core/cost.js";

export class PerplexityModelUnsupportedError extends Error {
  constructor(model: string) {
    super(
      `perplexity_model_unsupported: "${model}" is not a Perplexity Agent API model id. ` +
        `Perplexity retires the Sonar Chat Completions API on ${PERPLEXITY_SONAR_SUNSET_DATE} and ` +
        `cross-review >= 4.6.0 speaks only the Agent API (POST ${PERPLEXITY_BASE_URL}/responses), ` +
        `whose ids use the documented provider/model form — canonical pin: perplexity/kimi-k3. ` +
        `Set CROSS_REVIEW_PERPLEXITY_MODEL (or central config models.perplexity) to a documented id: ` +
        PERPLEXITY_AGENT_MODELS_DOCS,
    );
    this.name = "PerplexityModelUnsupportedError";
  }
}

export function assertPerplexityAgentModel(model: string): void {
  if (!isPerplexityAgentModel(model)) throw new PerplexityModelUnsupportedError(model);
}

// Agent API usage shape (Responses-style token buckets plus Perplexity's
// tool invocation counters and per-call cost breakdown).
type AgentToolCallDetail = number | { invocation?: number | undefined } | null | undefined;

type AgentUsage = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  total_tokens?: number | undefined;
  input_tokens_details?: {
    cached_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
  } | null;
  output_tokens_details?: { reasoning_tokens?: number | undefined } | null;
  tool_calls_details?: Record<string, AgentToolCallDetail> | null;
  cost?: { total_cost?: number | undefined; tool_calls_cost?: number | undefined } | null;
};

// The API reference names the tool `web_search`; live responses report the
// invocation counter under `search_web` (observed 23/08/2026). Read both so
// a documentation/runtime naming drift never silently zeroes the fee.
const WEB_SEARCH_TOOL_COUNTER_KEYS = ["search_web", "web_search"] as const;

function toolInvocations(detail: AgentToolCallDetail): number {
  if (typeof detail === "number") return detail;
  if (detail && typeof detail.invocation === "number") return detail.invocation;
  return 0;
}

export function usageFromAgentApi(
  usage: AgentUsage | null | undefined,
  searchPerformed: boolean,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const details = usage.input_tokens_details ?? undefined;
  const cacheRead = details?.cache_read_input_tokens ?? details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_creation_input_tokens ?? 0;
  const providerInput = usage.input_tokens ?? 0;
  // Provider input totals include cached reads (verified: 112 input tokens
  // with 60 cached were billed as 52 fresh + 60 cache reads). The canonical
  // TokenUsage contract stores mutually exclusive buckets so cost.ts prices
  // each token exactly once.
  const freshInput = Math.max(0, providerInput - cacheRead - cacheWrite);
  const result: TokenUsage = {
    input_tokens: usage.input_tokens === undefined ? undefined : freshInput,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
  };
  if (cacheRead > 0) result.cache_read_tokens = cacheRead;
  if (cacheWrite > 0) result.cache_write_tokens = cacheWrite;
  result.cache_provider_mode = "auto";
  // Web-search invocations are billed per call by the Agent API. Surface
  // them as `num_search_queries` so cost.ts prices them at the configured
  // `search_queries_per_1000` rate.
  const searchInvocations = WEB_SEARCH_TOOL_COUNTER_KEYS.reduce(
    (sum, key) => sum + toolInvocations(usage.tool_calls_details?.[key]),
    0,
  );
  if (searchInvocations > 0 || usage.tool_calls_details) {
    result.num_search_queries = searchInvocations;
  }
  // Per-call search signal retained for observability: true when the
  // request declared the web_search tool.
  result.search_performed = searchPerformed;
  // Capture the provider-reported total cost for telemetry. The
  // config-driven cost.ts estimateCost remains authoritative; this is a
  // sanity-check signal only.
  if (typeof usage.cost?.total_cost === "number") {
    result.provider_reported_total_cost_usd = usage.cost.total_cost;
  }
  return result;
}

// Agent API output is an array of typed items: `search_results` /
// `fetch_url_results` items precede the assistant `message`, whose
// `content` holds `output_text` parts. Only message text is the review.
type AgentOutputItem = {
  type?: string | undefined;
  content?: Array<{ type?: string | undefined; text?: string | undefined }> | null | undefined;
};

function agentOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output as AgentOutputItem[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

// v3.2.0 fix (codex catch sess 41244a1c, observed across v3.0.0+): Sonar
// reasoning models emitted a `<think>...</think>` preamble before the
// structured answer. The Agent API separates reasoning into
// `response.reasoning.*` stream events, but third-party reasoning models
// routed through it can still surface the tag inside message text. The
// shared status parser in `core/status.ts` requires the text to begin
// with JSON-shaped content; strip every `<think>...</think>` block
// (non-greedy across lines, multiple occurrences) before downstream
// extraction. Structured payloads never legitimately include the literal
// substring "<think>", so this is safe.
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

function agentText(response: { output?: unknown; output_text?: unknown }): string {
  const messageText = agentOutputText(response.output).trim();
  const helperText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  // Codex review of PR #234 (head 633f543): a completed response without
  // assistant message text (degenerate reasoning- or tool-only terminal)
  // must surface as EMPTY text — the status parser and the orchestrator's
  // empty-generation guards handle that — never as a nonempty JSON
  // serialization of the provider envelope that could be promoted as a
  // relator draft. The full envelope stays available in `raw`.
  return stripPerplexityThinkingBlock(messageText || helperText);
}

// Agent API `reasoning.effort` enum (API reference; verified live with
// perplexity/kimi-k3 at `max` on 23/08/2026). The internal config scale
// adds `none` and the operator-facing `ultra` alias; normalize both so the
// on-wire value is always one the Agent API documents.
//
// Exported so the smoke harness can verify the clamp shape directly
// (anti-drift, same pattern as `clampEffortForModel` in grok.ts).
type PerplexityReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function clampEffortForPerplexity(
  effort: AppConfig["reasoning_effort"][PeerId],
): PerplexityReasoningEffort {
  switch (effort) {
    case "none":
    case "minimal":
      return "minimal";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    // `max` is the documented ceiling; `ultra` is the compatibility alias
    // and is never transmitted; an unset value takes the canonical maximum
    // reasoning stance shared by the other peers.
    default:
      return "max";
  }
}

// Perplexity-specific request body extension on top of the OpenAI
// Responses params: the documented `web_search` tool, the agent-loop
// bound and the top-level structured-output wrapper. The OpenAI Node SDK
// forwards unknown body fields untouched, so these knobs reach the wire.
type PerplexityAgentOptions = {
  reasoning: { effort: PerplexityReasoningEffort };
  tools?: Array<{ type: "web_search"; search_context_size: "low" | "medium" | "high" }>;
  max_steps?: number;
};

type PerplexityAgentPayload = PerplexityAgentOptions & {
  model: string;
  instructions: string;
  input: Array<{ role: "user"; content: string }>;
  max_output_tokens: number;
  store: false;
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: typeof portableStatusJsonSchema };
  };
  stream?: boolean;
};

type AgentStreamEvent = {
  type: string;
  delta?: unknown | undefined;
  message?: string | undefined;
  code?: string | null | undefined;
  param?: string | null | undefined;
  status?: number | undefined;
  statusCode?: number | undefined;
  response?: {
    id?: string | undefined;
    status?: string | undefined;
    incomplete_details?: { reason?: string | undefined } | null;
    usage?: AgentUsage | null | undefined;
    model?: string | undefined;
    output?: unknown;
    error?: { message?: string | undefined; code?: string | null | undefined } | null | undefined;
  };
  error?: { message?: string | undefined; code?: string | null | undefined } | null | undefined;
};

type AgentResponse = {
  id?: string | undefined;
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null | undefined;
  usage?: AgentUsage | null | undefined;
  model?: string | undefined;
  output?: unknown;
  output_text?: unknown;
  error?: { message?: string | undefined; code?: string | null | undefined } | null | undefined;
};

// An `incomplete` Agent API terminal (output budget exhausted) arrives with
// `usage: null` (observed live on 23/08/2026), yet the provider billed the
// prompt and the whole output budget. A rejected attempt without usage would
// settle as zero spend in the session ledger, so the adapter prices such
// terminals with the same conservative envelope the round preflight uses:
// prompt characters / 4 for input and the requested max_output_tokens for
// output. Failed or cancelled terminals keep provider-reported usage only —
// the provider does not document billing for them.
export function estimatedIncompleteUsage(
  payload: { instructions: string; input: Array<{ content: string }>; max_output_tokens: number },
  searchPerformed: boolean,
  webSearchInvocationsEstimate: number,
): TokenUsage {
  const promptChars =
    payload.instructions.length + payload.input.reduce((sum, item) => sum + item.content.length, 0);
  const inputTokens = Math.ceil(promptChars / 4);
  const outputTokens = payload.max_output_tokens;
  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cache_provider_mode: "auto",
    search_performed: searchPerformed,
  };
  // A reviewer request declared the web_search tool, so searches may have
  // been billed before the output budget ran out. Price the declared
  // preflight estimate (the same envelope estimatedPeerRoundCost uses) so
  // the search dimension is never silently dropped from the ledger.
  if (searchPerformed) usage.num_search_queries = webSearchInvocationsEstimate;
  return usage;
}

function isIncompleteTerminal(status: unknown): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "incomplete";
}

// v3.0.0 (operator directive 2026-05-12): role-aware search behavior.
// Perplexity's web-search differentiator is most valuable in the
// REVIEWER role (fact-check overlay on the draft under review). In the
// RELATOR role (lead_peer revising consensus into a new draft) or
// during PROBE (health check), the search tool must be OFF because the
// task is synthesis, not external lookup. The role is inferred from
// which adapter method the orchestrator invokes:
//   - `call()`  → reviewer  → web_search tool SENT per config (default ON)
//   - `generate()` → relator  → web_search tool NEVER sent
//   - `probe()` → auth_only by default; live probe sends no tools
// This preserves Perplexity's role-symmetry across the sexteto (it can
// still be caller / lead_peer / reviewer per session) while the
// adapter's internal contract ensures the search behavior matches the
// role the peer is currently playing.
type PerplexityRole = "reviewer" | "relator";

export function buildAgentOptions(
  config: AppConfig,
  role: PerplexityRole,
  effortOverride?: AppConfig["reasoning_effort"][PeerId],
): { options: PerplexityAgentOptions; searchPerformed: boolean } {
  const options: PerplexityAgentOptions = {
    reasoning: {
      effort: clampEffortForPerplexity(effortOverride ?? config.reasoning_effort.perplexity),
    },
  };
  // Relator (generate) role: search is structurally inappropriate
  // because the task is to synthesize a revised draft from the other
  // peers' verdicts, not to consult external sources. Never send the tool
  // regardless of operator config.
  // Reviewer (call) role: search active per config (default true; can
  // be disabled via CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH=true).
  const searchDisabled = role === "relator" || config.perplexity.disable_search;
  if (searchDisabled) {
    return { options, searchPerformed: false };
  }
  options.tools = [
    { type: "web_search", search_context_size: config.perplexity.search_context_size },
  ];
  // `max_steps` bounds the agent research loop on the wire. It does not
  // bound web-search invocations inside a step (see header note 3).
  options.max_steps = config.perplexity.max_steps;
  return { options, searchPerformed: true };
}

export class PerplexityAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "perplexity";
  provider = "perplexity";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    // The core accepts the Gemini-style `models/` prefix for every peer
    // (cost cards, financial gate, boot notice all normalize it). Strip it
    // once here so the wire always carries the documented `provider/model`
    // id and `response.model` matches the configured pin.
    this.model = (modelOverride ?? config.models.perplexity).trim().replace(/^models\//i, "");
  }

  // Per v2.27.1 cold-start hardening: reuse the lazy OpenAI SDK ctor
  // shared with peers/openai.ts + peers/deepseek.ts + peers/grok.ts so
  // the `openai` module is loaded exactly once across all four
  // OpenAI-SDK-driven adapters. The legacy-Sonar guard runs here so every
  // network path (review, generation, live probe) fails with the
  // diagnostic error before any request is sent.
  private async client(): Promise<OpenAI> {
    assertPerplexityAgentModel(this.model);
    const apiKey = this.config.api_keys.perplexity;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY was not found in environment variables.");
    const Ctor = await loadOpenAICtor();
    return new Ctor({ apiKey, baseURL: PERPLEXITY_BASE_URL });
  }

  private assertResponseTerminal(
    response: AgentResponse,
    context: PeerCallContext,
    phase: "review" | "generation",
    usage: TokenUsage | undefined,
    payload: PerplexityAgentPayload,
    searchPerformed: boolean,
  ): void {
    // An `incomplete` Agent API response arrives with `usage: null`
    // (observed on max_output_tokens exhaustion); price the rejected attempt
    // with the conservative request envelope so it never settles as zero.
    const billingUsage =
      usage ??
      (isIncompleteTerminal(response?.status)
        ? estimatedIncompleteUsage(
            payload,
            searchPerformed,
            this.config.perplexity.web_search_invocations_estimate,
          )
        : undefined);
    withEstimatedTerminalBilling(this.config, this.id, this.model, billingUsage, () => {
      // A `failed` terminal carries the provider error object; surface its
      // message instead of a bare status (same contract as openai.ts/grok.ts).
      if (response?.error) {
        throw streamingFailureErrorFromEvent(
          { type: "response.failed", response: { error: response.error } },
          "Perplexity response failed.",
        );
      }
      assertResponsesCompletion(response, {
        context,
        peer: this.id,
        provider: this.provider,
        model: this.model,
        phase,
      });
    });
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
    if (!isPerplexityAgentModel(this.model)) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.perplexity,
        message: new PerplexityModelUnsupportedError(this.model).message,
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
          "Perplexity probe_mode=auth_only: skipped tokenized Agent API round-trip because Perplexity does not document a zero-token model/auth endpoint.",
      };
    }
    // A live probe is a billable Agent API request. No tools are sent (no
    // search fee) and the output budget is the provider minimum; an
    // `incomplete` status on that budget still proves auth + model reach.
    // v4.6.0 (Codex review of PR #234): the Responses protocol can resolve
    // normally with a `failed` or `cancelled` terminal, so the status is
    // inspected instead of treating every non-throwing response as healthy.
    try {
      const probeClient = await this.client();
      const probePayload = {
        model: this.model,
        input: ".",
        max_output_tokens: 16,
        reasoning: { effort: "minimal" as const },
        store: false as const,
      };
      const probeResponse = (await probeClient.responses.create(
        probePayload as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        { timeout: this.config.retry.timeout_ms },
      )) as unknown as AgentResponse & { error?: { message?: unknown } | null };
      const probeStatus =
        typeof probeResponse?.status === "string" ? probeResponse.status.toLowerCase() : undefined;
      if (probeStatus !== "completed" && probeStatus !== "incomplete") {
        const providerMessage =
          typeof probeResponse?.error?.message === "string" ? probeResponse.error.message : "";
        return {
          peer: this.id,
          provider: this.provider,
          model: this.model,
          available: false,
          auth_present: true,
          latency_ms: Date.now() - started,
          model_selection: this.config.model_selection.perplexity,
          message: `perplexity_probe_terminal_rejected: Agent API returned status=${probeStatus ?? "missing"} for ${this.model}${providerMessage ? ` (${providerMessage})` : ""}; only completed or incomplete prove model reachability.`,
        };
      }
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

  private async streamAgentResponse(
    payload: PerplexityAgentPayload,
    context: PeerCallContext,
    phase: "review" | "generation",
    attempt: number,
    searchPerformed: boolean,
  ): Promise<{
    text: string;
    usage: TokenUsage | undefined;
    modelReported: string | undefined;
    raw: Record<string, unknown>;
  }> {
    const streamClient = await this.client();
    const stream = await streamClient.responses.create(
      { ...payload, stream: true } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { signal: context.signal, timeout: this.config.retry.timeout_ms },
    );
    const stream_buffer = new StreamBuffer(this.id);
    const tokenStream = this.createTokenEventBuffer(
      context,
      phase,
      "response.output_text.delta",
      attempt,
    );
    const perplexityTokenStream = createPerplexityTokenEventBuffer(tokenStream);
    let usage: TokenUsage | undefined;
    let modelReported: string | undefined;
    let requestId: string | undefined;
    let terminalMessageText: string | undefined;
    let responseCompleted = false;
    let responseRefused = false;
    let events = 0;
    for await (const event of stream as AsyncIterable<AgentStreamEvent>) {
      events += 1;
      requestId = event.response?.id ?? requestId;
      responseRefused = observeResponsesStreamRefusal(event, responseRefused);
      const eventUsage = usageFromAgentApi(event.response?.usage, searchPerformed);
      // `response.incomplete` may carry `usage: null`; bill the rejected
      // attempt with the request envelope instead of settling it as zero.
      const terminalBillingUsage =
        eventUsage ??
        (event.type === "response.incomplete" || isIncompleteTerminal(event.response?.status)
          ? estimatedIncompleteUsage(
              payload,
              searchPerformed,
              this.config.perplexity.web_search_invocations_estimate,
            )
          : undefined);
      responseCompleted = withEstimatedTerminalBilling(
        this.config,
        this.id,
        this.model,
        terminalBillingUsage,
        () =>
          observeResponsesStreamTerminal(event, responseCompleted, {
            context,
            peer: this.id,
            provider: this.provider,
            model: this.model,
            phase,
          }),
      );
      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        stream_buffer.append(delta);
        perplexityTokenStream.append(delta);
      } else if (event.type === "response.completed") {
        usage = eventUsage;
        modelReported = event.response?.model;
        // The terminal event carries the aggregate output; retained as the
        // documented fallback when no usable delta text was streamed.
        const aggregate = agentOutputText(event.response?.output);
        if (aggregate.length > 0) terminalMessageText = aggregate;
      } else if (
        event.type === "response.failed" ||
        event.type === "error" ||
        event.type === "response.error"
      ) {
        withEstimatedTerminalBilling(this.config, this.id, this.model, eventUsage, () => {
          throw streamingFailureErrorFromEvent(
            event as Parameters<typeof streamingFailureErrorFromEvent>[0],
            "Perplexity streaming response failed.",
          );
        });
      }
    }
    withEstimatedTerminalBilling(this.config, this.id, this.model, usage, () => {
      assertResponsesStreamCompleted(responseCompleted, {
        context,
        peer: this.id,
        provider: this.provider,
        model: this.model,
        phase,
      });
      assertResponsesStreamNotRefused(responseRefused, {
        context,
        peer: this.id,
        provider: this.provider,
        model: this.model,
        phase,
      });
    });
    // v3.4.0 Fix #1 / v4.5.36: name the raw delta buffer for bounded
    // telemetry, then strip `<think>` blocks so both the reviewer and the
    // relator streaming paths hand clean text to the status parser; the
    // terminal aggregate content is a fallback only when no usable delta
    // remains.
    const rawDeltaText = stream_buffer.text();
    const visibleDeltaText = stripPerplexityThinkingBlock(rawDeltaText);
    const visibleTerminalText = stripPerplexityThinkingBlock(terminalMessageText ?? "");
    const terminalMessageFallbackUsed =
      visibleDeltaText.length === 0 && visibleTerminalText.length > 0;
    if (terminalMessageFallbackUsed && terminalMessageText) {
      perplexityTokenStream.append(terminalMessageText);
    }
    const text = terminalMessageFallbackUsed ? visibleTerminalText : visibleDeltaText;
    perplexityTokenStream.complete(text.length);
    return {
      text,
      usage,
      modelReported,
      raw: {
        streamed: true,
        provider: this.provider,
        events,
        model: modelReported,
        request_id: requestId,
        raw_delta_chars: rawDeltaText.length,
        terminal_message_chars: terminalMessageText?.length ?? 0,
        visible_chars: text.length,
        terminal_message_fallback_used: terminalMessageFallbackUsed,
        empty_usable_output: text.length === 0,
      },
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
          message: `Perplexity review attempt ${attempt}`,
        });
        const { options, searchPerformed } = buildAgentOptions(
          this.config,
          "reviewer",
          context.reasoning_effort_override,
        );
        const payload: PerplexityAgentPayload = {
          ...options,
          model: this.model,
          instructions: this.systemPrompt(context),
          input: [{ role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` }],
          // The Agent API documents a top-level `response_format` wrapper
          // (name + schema) rather than the OpenAI `text.format` object.
          // Send the portable structural projection and retain the complete
          // limits in the prompt and local Zod validator, because the
          // backend model behind the Agent API is provider-agnostic.
          response_format: {
            type: "json_schema",
            json_schema: { name: "cross_review_status", schema: portableStatusJsonSchema },
          },
          max_output_tokens:
            context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
          store: false,
        };
        if (this.shouldStreamTokens(context)) {
          const streamed = await this.streamAgentResponse(
            payload,
            context,
            "review",
            attempt,
            searchPerformed,
          );
          return this.resultFromText({
            text: streamed.text,
            raw: streamed.raw,
            usage: streamed.usage,
            started,
            attempts: attempt,
            modelReported: streamed.modelReported,
          });
        }
        const reviewClient = await this.client();
        const response = (await reviewClient.responses.create(
          payload as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        )) as unknown as AgentResponse;
        const responseUsage = usageFromAgentApi(response.usage, searchPerformed);
        this.assertResponseTerminal(
          response,
          context,
          "review",
          responseUsage,
          payload,
          searchPerformed,
        );
        return this.resultFromText({
          text: agentText(response),
          raw: response,
          usage: responseUsage,
          started,
          attempts: attempt,
          modelReported: response.model,
        });
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
          message: `Perplexity generation attempt ${attempt}`,
        });
        const { options, searchPerformed } = buildAgentOptions(
          this.config,
          "relator",
          context.reasoning_effort_override,
        );
        const payload: PerplexityAgentPayload = {
          ...options,
          model: this.model,
          instructions: this.systemPrompt(context),
          input: [{ role: "user", content: userPrompt(prompt) }],
          max_output_tokens:
            context.max_output_tokens_override ?? maxOutputTokensForPeer(this.config, this.id),
          store: false,
        };
        if (this.shouldStreamTokens(context)) {
          const streamed = await this.streamAgentResponse(
            payload,
            context,
            "generation",
            attempt,
            searchPerformed,
          );
          return this.generationFromText({
            text: streamed.text,
            raw: streamed.raw,
            usage: streamed.usage,
            started,
            attempts: attempt,
            modelReported: streamed.modelReported,
          });
        }
        const generateClient = await this.client();
        const response = (await generateClient.responses.create(
          payload as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        )) as unknown as AgentResponse;
        const responseUsage = usageFromAgentApi(response.usage, searchPerformed);
        this.assertResponseTerminal(
          response,
          context,
          "generation",
          responseUsage,
          payload,
          searchPerformed,
        );
        return this.generationFromText({
          text: agentText(response),
          raw: response,
          usage: responseUsage,
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) => {
        this.discardTokenEventBuffer(context, "generation", attempt);
        return classifyProviderError(this.id, this.provider, this.model, error, attempt, started);
      },
      { signal: context.signal },
    );
  }
}
