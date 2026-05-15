import type {
  AppConfig,
  Confidence,
  EvidenceAskJudgment,
  GenerationResult,
  PeerCallContext,
  PeerId,
  PeerResult,
  TokenUsage,
} from "../core/types.js";
import { estimateCost } from "../core/cost.js";
import { decisionQualityFromStatus, parsePeerStatus } from "../core/status.js";
import { redact } from "../security/redact.js";

// v2.4.0 / audit closure (P2.9): defensive cap on accumulated streaming
// text per peer call. Pre-v2.4.0 every adapter used `text += delta`
// without bound, so a hostile or buggy peer could OOM the orchestrator
// by emitting unbounded tokens. The cap is per-call (not per-session)
// and very generous — 16 MiB is roughly 4M tokens, well above any
// legitimate response. When the cap is exceeded the helper throws a
// retryable error so the retry loop can shorten the prompt instead of
// crashing the process.
export const STREAM_TEXT_MAX_BYTES = 16 * 1024 * 1024;

export class StreamBufferOverflowError extends Error {
  constructor(peer: string, bytes: number) {
    super(
      `${peer} streaming response exceeded ${STREAM_TEXT_MAX_BYTES} bytes (got ${bytes}); aborting to protect the orchestrator from OOM.`,
    );
    this.name = "StreamBufferOverflowError";
  }
}

// v2.4.0 cross-review R2 (codex): byte-budget pre-check BEFORE
// concatenation. Pre-R2 the helper computed `combined = buffer + delta`
// first and only THEN tested the byte length, so a hostile peer could
// allocate a multi-GB string before triggering the throw — the very OOM
// we are trying to prevent. R2 measures the buffer + delta byte counts
// separately (no allocation beyond the strings already in hand) and
// throws BEFORE the concatenation is materialized.
// v2.4.0 cross-review R3 (gemini): O(1) per-append byte accounting.
// R2 closed Codex's pre-allocation concern by measuring bytes BEFORE
// concatenation, but Gemini caught the resulting O(N^2) regression —
// `Buffer.byteLength(buffer, "utf8")` rescans the entire accumulated
// string on every delta, so a 16 MiB stream emitted in 100-byte chunks
// pays 16 MiB x 160 000 chunks ~= 2.5 TB of scanning before the cap is
// reached, which DoS-locks the event loop. R3 introduces a stateful
// `StreamBuffer` class that maintains a running byte counter — each
// append measures only the delta (O(deltaLength)) and increments the
// counter, never re-scanning the accumulated text. Adapters use the
// class form; the legacy free-function is kept as a stateless shim.
export class StreamBuffer {
  private buffer = "";
  private bytes = 0;

  constructor(private readonly peer: string) {}

  // Append a delta. Throws StreamBufferOverflowError BEFORE any
  // concatenation if the projected size would exceed the cap.
  // Time complexity: O(delta.length) — independent of accumulated size.
  append(delta: string): string {
    if (!delta) return this.buffer;
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    const projected = this.bytes + deltaBytes;
    if (projected > STREAM_TEXT_MAX_BYTES) {
      throw new StreamBufferOverflowError(this.peer, projected);
    }
    this.buffer += delta;
    this.bytes = projected;
    return this.buffer;
  }

  text(): string {
    return this.buffer;
  }

  byteLength(): number {
    return this.bytes;
  }
}

// Legacy free-function shim. Stateless callers (tests, edge cases) may
// still use it; production adapters MUST use StreamBuffer for O(1)
// amortized cost.
export function appendStreamText(peer: string, buffer: string, delta: string): string {
  if (!delta) return buffer;
  const projected = Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(delta, "utf8");
  if (projected > STREAM_TEXT_MAX_BYTES) {
    throw new StreamBufferOverflowError(peer, projected);
  }
  return buffer + delta;
}

// v2.6.0 (Codex+Gemini audit, 2026-05-03): coalesce streaming token
// deltas before emit. Empirical measurement of 253 historical sessions
// surfaced 96 282 of 98 664 events (97.6%) as `peer.token.delta` —
// dominant noise in events.ndjson. Each provider chunk used to fire a
// dedicated event; a single response could produce 50-200 events. We
// now buffer deltas and flush a coalesced delta either when the buffer
// crosses a char-count threshold (synchronous) OR when a setTimeout
// for the configured ms threshold fires (covers stream stalls — Gemini
// R1 catch). Total emitted chars are preserved; the difference is
// event granularity, not content.
//
// Verbose escape hatch: `CROSS_REVIEW_TOKEN_DELTA_VERBOSE=1` makes
// every chunk emit immediately (legacy v2.5.x behavior) for operators
// who want chunk-level observability.
export class TokenEventBuffer {
  private buffered = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private completed = false;

  constructor(
    private readonly flushDelta: (delta: string) => void,
    private readonly emitCompleted: (chars: number) => void,
    private readonly charsThreshold: number,
    private readonly msThreshold: number,
    private readonly verbose: boolean,
  ) {}

  append(delta: string): void {
    if (!delta || this.completed) return;
    if (this.verbose) {
      this.flushDelta(delta);
      return;
    }
    this.buffered += delta;
    if (this.buffered.length >= this.charsThreshold) {
      this.flushPending();
      return;
    }
    // v2.6.0 R1 fix (Gemini): setTimeout covers stream stalls. If a
    // chunk arrives but no further chunks for `msThreshold` ms (network
    // pause, slow LLM), the timer ensures the buffered delta still
    // emits without waiting for `complete()` or the next chunk.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushPending();
      }, this.msThreshold);
      // Don't keep the event loop alive just for this timer.
      this.flushTimer.unref?.();
    }
  }

  private flushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.buffered) return;
    const pending = this.buffered;
    this.buffered = "";
    this.flushDelta(pending);
  }

  // v2.6.0 R1 fix (Codex): try/finally guarantees emitCompleted fires
  // even if the final flushDelta throws. Marks completed so any
  // late-arriving append (e.g. from a delayed event handler) is a no-op
  // rather than re-emitting after completion.
  complete(chars: number): void {
    if (this.completed) return;
    this.completed = true;
    try {
      this.flushPending();
    } finally {
      this.emitCompleted(chars);
    }
  }
}

export abstract class BasePeerAdapter {
  abstract id: PeerId;
  abstract provider: string;
  abstract model: string;
  // v2.9.0: declare `generate` here so the default judgeEvidenceAsk
  // implementation below can route through it without each subclass
  // re-defining the abstract signature. Subclasses must implement
  // generate() as their existing PeerAdapter contract requires.
  abstract generate(prompt: string, context: PeerCallContext): Promise<GenerationResult>;

  protected constructor(protected readonly config: AppConfig) {}

  private modelMatches(reported?: string): boolean | undefined {
    if (!reported) return undefined;
    const requestedModel = this.normalizeModelId(this.model);
    const reportedModel = this.normalizeModelId(reported);
    if (reportedModel === requestedModel) return true;
    // A concrete dated id of the requested base id is a match:
    // `gpt-5.5` → `gpt-5.5-2026-04-23`.
    if (reportedModel.startsWith(`${requestedModel}-`)) return true;
    // v3.7.4: a `-latest` alias resolves provider-side to a concrete
    // dated id that reports the model FAMILY, not the literal alias
    // string — xAI returns `grok-4-0709` for the pinned `grok-4-latest`.
    // That is the alias resolving, NOT a silent downgrade. Strip the
    // `-latest` suffix to the family stem and match the reported id
    // against the stem: `grok-4-latest` → stem `grok-4` → `grok-4-0709`
    // matches. A genuine cross-family downgrade (e.g. `grok-3-*` for a
    // `grok-4-latest` pin) does not start with the stem, so it is still
    // flagged as `silent_model_downgrade` — the no-downgrade protection
    // is preserved.
    if (requestedModel.endsWith("-latest")) {
      const familyStem = requestedModel.slice(0, -"-latest".length);
      return reportedModel === familyStem || reportedModel.startsWith(`${familyStem}-`);
    }
    return false;
  }

  private normalizeModelId(model: string): string {
    return model.trim().replace(/^models\//i, "");
  }

  protected shouldStreamTokens(context: PeerCallContext): boolean {
    return Boolean(context.stream_tokens && this.config.streaming.tokens);
  }

  protected emitTokenDelta(
    context: PeerCallContext,
    params: { phase: "review" | "generation"; delta: string; source?: string },
  ): void {
    if (!this.shouldStreamTokens(context) || !params.delta) return;
    const data: Record<string, unknown> = {
      phase: params.phase,
      provider: this.provider,
      model: this.model,
      source: params.source ?? "text",
      chars: params.delta.length,
    };
    if (this.config.streaming.include_text) {
      data.delta = redact(params.delta);
    }
    context.emit({
      type: "peer.token.delta",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: `${this.id} streamed ${params.delta.length} chars.`,
      data,
    });
  }

  protected emitTokenCompleted(
    context: PeerCallContext,
    params: { phase: "review" | "generation"; chars: number },
  ): void {
    if (!this.shouldStreamTokens(context)) return;
    context.emit({
      type: "peer.token.completed",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: `${this.id} completed token streaming.`,
      data: {
        phase: params.phase,
        provider: this.provider,
        model: this.model,
        chars: params.chars,
      },
    });
  }

  // v2.6.0: build a per-call TokenEventBuffer that coalesces token
  // deltas before emit. Each adapter call should construct the buffer
  // once at the start of streaming, append every chunk, and call
  // complete() at the end. The buffer respects shouldStreamTokens (no-
  // op when streaming is disabled) and the verbose escape hatch.
  protected createTokenEventBuffer(
    context: PeerCallContext,
    phase: "review" | "generation",
    source = "text",
  ): TokenEventBuffer {
    const flushDelta = (delta: string) => this.emitTokenDelta(context, { phase, delta, source });
    const emitCompleted = (chars: number) => this.emitTokenCompleted(context, { phase, chars });
    // v2.6.0 R1 (Gemini catch): renamed to charsThreshold for clarity
    // (we measure UTF-16 code units, not UTF-8 bytes). The legacy env
    // var name is preserved for op compatibility but read into the
    // semantically correct field. A new alias env var is also accepted.
    // v3.6.0 (B2, logs+sessions study): default raised 1024 -> 16384.
    // The 169-session corpus showed token.delta events were 79.5% of all
    // 42541 persisted events even with the operator's config.json at
    // 4096 — session_doctor flagged this directly. A 16384 default cuts
    // delta-event volume ~16x vs the old 1024 default (~4x vs 4096)
    // while keeping streaming responsive. Operators who want
    // fine-grained streaming lower it via CROSS_REVIEW_TOKEN_DELTA_CHARS_THRESHOLD.
    const charsThreshold = Math.max(
      1,
      Number.parseInt(
        process.env.CROSS_REVIEW_TOKEN_DELTA_CHARS_THRESHOLD ??
          process.env.CROSS_REVIEW_TOKEN_DELTA_BYTES_THRESHOLD ??
          "",
        10,
      ) || 16384,
    );
    const msThreshold = Math.max(
      1,
      Number.parseInt(process.env.CROSS_REVIEW_TOKEN_DELTA_MS_THRESHOLD ?? "", 10) || 250,
    );
    const verbose = process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE === "1";
    return new TokenEventBuffer(flushDelta, emitCompleted, charsThreshold, msThreshold, verbose);
  }

  protected resultFromText(params: {
    text: string;
    raw: unknown;
    usage?: TokenUsage;
    started: number;
    attempts: number;
    modelReported?: string;
    // v2.23.0: provider-side parser diagnostics (e.g. Anthropic
    // thinking-only response with no final text block). Merged AFTER
    // status-parser warnings so the model-mismatch warning still
    // appears last.
    extraParserWarnings?: string[];
  }): PeerResult {
    const parsed = parsePeerStatus(params.text);
    const modelMatch = this.modelMatches(params.modelReported);
    const extra = params.extraParserWarnings ?? [];
    const baseWarnings = [...parsed.parser_warnings, ...extra];
    const parserWarnings =
      modelMatch === false
        ? [
            ...baseWarnings,
            `reported model ${params.modelReported} did not match requested model ${this.model}`,
          ]
        : baseWarnings;
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      model_reported: params.modelReported,
      model_match: modelMatch,
      status: modelMatch === false ? null : parsed.status,
      structured: parsed.structured,
      text: params.text,
      raw: params.raw,
      usage: params.usage,
      cost: estimateCost(this.config, this.id, params.usage),
      latency_ms: Date.now() - params.started,
      attempts: params.attempts,
      parser_warnings: parserWarnings,
      decision_quality:
        modelMatch === false ? "failed" : decisionQualityFromStatus(parsed.status, parserWarnings),
    };
  }

  protected generationFromText(params: {
    text: string;
    raw: unknown;
    usage?: TokenUsage;
    started: number;
    attempts: number;
    modelReported?: string;
    // v2.23.0: provider-side parser diagnostics propagated to the
    // GenerationResult so the relator-revision path in the orchestrator
    // can detect provider degenerate outputs (e.g. Anthropic extended
    // thinking returning only thinking blocks with no text block) and
    // refuse to promote an empty `text` to next-round draft.
    extraParserWarnings?: string[];
  }): GenerationResult {
    const modelMatch = this.modelMatches(params.modelReported);
    const extra = params.extraParserWarnings ?? [];
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      model_reported: params.modelReported,
      model_match: modelMatch,
      text: params.text,
      raw: params.raw,
      usage: params.usage,
      cost: estimateCost(this.config, this.id, params.usage),
      latency_ms: Date.now() - params.started,
      attempts: params.attempts,
      parser_warnings: extra.length > 0 ? extra : undefined,
    };
  }

  protected systemPrompt(context: PeerCallContext): string {
    return [
      "You are a peer reviewer in cross-review.",
      "Your job is to review the caller's work rigorously and independently.",
      "Do not rubber-stamp. Do not invent evidence.",
      "Unanimity is required: READY only when no blocking issue remains.",
      `Session: ${context.session_id}`,
      `Round: ${context.round}`,
      "Original task:",
      context.task,
    ].join("\n\n");
  }

  // v2.9.0: default judge implementation. Builds a tightly-scoped prompt
  // that gives the LLM ONLY the ask + draft (no session history per
  // design) and asks for a structured boolean satisfied + confidence +
  // rationale. Routes through this.generate() so cost/usage/latency are
  // accounted by the same FinOps path as generations. Provider adapters
  // can override if they want to use structured-output APIs (e.g. OpenAI
  // structured outputs, Gemini json mode) for stricter parsing.
  async judgeEvidenceAsk(
    ask: string,
    draft: string,
    context: PeerCallContext,
  ): Promise<EvidenceAskJudgment> {
    const prompt = this.buildJudgePrompt(ask, draft);
    const generation = await this.generate(prompt, context);
    return this.parseJudgeResponse(generation, draft.length);
  }

  protected buildJudgePrompt(ask: string, draft: string): string {
    return [
      "# Evidence Ask Judgment",
      "",
      "You are a judge. The caller has revised a draft and wants to know whether the revision SATISFIES one specific evidence ask raised by a peer in a prior round.",
      "Your job is single-question: does the draft below answer the ask?",
      "Do NOT review the draft for other issues. Do NOT propose new asks. Do NOT rubber-stamp.",
      "",
      "## Ask (verbatim peer caller_request)",
      ask,
      "",
      "## Draft (the proposed revised solution)",
      draft,
      "",
      "## Output format (REQUIRED — JSON object, exactly these keys)",
      '{ "satisfied": <true|false>, "confidence": "<verified|inferred|unknown>", "rationale": "<one or two sentences>" }',
      "",
      "Rules:",
      '- "satisfied": true ONLY if the draft contains concrete evidence that answers the ask (file:line, grep output, diff, MD5, log line, etc.).',
      '- "confidence": "verified" ONLY if you traced the evidence in the draft itself; "inferred" if plausible but you could not directly trace it; "unknown" if you cannot tell.',
      "- The runtime promotes the ask to addressed only when satisfied=true AND confidence=verified. Anything else leaves the ask open.",
      '- "rationale": brief, verbatim citation if possible (e.g. "Draft includes the literal `git diff --stat` output requested by the ask").',
    ].join("\n");
  }

  protected parseJudgeResponse(
    generation: GenerationResult,
    draftLength: number,
  ): EvidenceAskJudgment {
    void draftLength;
    const parserWarnings: string[] = [];
    let satisfied = false;
    let confidence: Confidence = "unknown";
    let rationale = "";
    try {
      const trimmed = generation.text.trim();
      // Tolerate fenced ```json blocks and stray prose around the JSON.
      const jsonStart = trimmed.indexOf("{");
      const jsonEnd = trimmed.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd < jsonStart) {
        parserWarnings.push("judge_response_missing_json_object");
      } else {
        const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
          satisfied?: unknown;
          confidence?: unknown;
          rationale?: unknown;
        };
        if (typeof payload.satisfied === "boolean") {
          satisfied = payload.satisfied;
        } else {
          parserWarnings.push("judge_response_satisfied_not_boolean");
        }
        if (
          payload.confidence === "verified" ||
          payload.confidence === "inferred" ||
          payload.confidence === "unknown"
        ) {
          confidence = payload.confidence;
        } else {
          parserWarnings.push("judge_response_confidence_unrecognized");
        }
        if (typeof payload.rationale === "string") {
          rationale = payload.rationale.trim().slice(0, 800);
        } else {
          parserWarnings.push("judge_response_rationale_missing");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parserWarnings.push(`judge_response_parse_failed:${message}`);
    }
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      satisfied,
      confidence,
      rationale,
      raw: generation.raw,
      usage: generation.usage,
      cost: generation.cost,
      latency_ms: generation.latency_ms,
      attempts: generation.attempts,
      parser_warnings: parserWarnings,
    };
  }
}
