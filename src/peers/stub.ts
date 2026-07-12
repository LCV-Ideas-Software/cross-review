import type {
  AppConfig,
  CostEstimate,
  EvidenceAskJudgment,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerProbeResult,
  PeerResult,
} from "../core/types.js";
import { BasePeerAdapter } from "./base.js";

const PROVIDERS: Record<PeerId, string> = {
  codex: "stub-openai",
  claude: "stub-anthropic",
  gemini: "stub-google",
  deepseek: "stub-deepseek",
  // v2.14.0: stub provider id for the Grok adapter so smoke runs
  // without the real xAI API key.
  grok: "stub-xai",
  // v3.0.0: stub provider id for the Perplexity adapter so smoke runs
  // without the real Sonar API key.
  perplexity: "stub-perplexity",
};

// v2.5.0 fix (Codex audit P1, 2026-05-03): stub adapters must NEVER attribute
// real currency to a session. Pre-v2.5.0, the stub passed prompt/text
// character counts as `usage.input_tokens`/`usage.output_tokens`, which
// `estimateCost` then multiplied by the configured cost-rate-per-million,
// producing tens of dollars of phantom spend in `meta.json` and
// `totals.cost.total_cost`. The fix overrides the cost field on every
// stub-emitted PeerResult / GenerationResult to a canonical zero-cost
// estimate tagged `source: "stub"` so downstream FinOps tooling can both
// (a) ignore the row and (b) audit that no paid provider call ever ran.
// The token usage shape stays intact so smoke tests that check
// `usage.total_tokens > 0` continue to pass.
//
// Test-only escape hatch: `CROSS_REVIEW_STUB_FORCE_REAL_COST=1` lets
// the smoke suite exercise budget_exceeded enforcement (which is
// arithmetically driven by `cost.total_cost`). It MUST NOT be set in
// any production-like environment; the env-confirmation gate that
// `CROSS_REVIEW_STUB` already enforces is the upstream guard.
function shouldForceRealStubCost(): boolean {
  return process.env.CROSS_REVIEW_STUB_FORCE_REAL_COST === "1";
}
function stubZeroCost(): CostEstimate {
  return {
    currency: "USD",
    input_cost: 0,
    output_cost: 0,
    total_cost: 0,
    estimated: false,
    source: "stub",
  };
}

export class StubAdapter extends BasePeerAdapter implements PeerAdapter {
  provider: string;
  model: string;

  constructor(
    config: AppConfig,
    readonly id: PeerId,
    modelOverride?: string,
  ) {
    super(config);
    this.provider = PROVIDERS[id];
    this.model = modelOverride ?? config.models[id];
  }

  private streamStubText(context: PeerCallContext, phase: "review" | "generation", text: string) {
    if (!this.shouldStreamTokens(context)) return;
    const tokenStream = this.createTokenEventBuffer(context, phase, "stub.chunk");
    for (const delta of text.match(/.{1,32}/gs) ?? []) {
      tokenStream.append(delta);
    }
    tokenStream.complete(text.length);
  }

  async probe(): Promise<PeerProbeResult> {
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      available: true,
      auth_present: true,
      latency_ms: 0,
      model_selection: this.config.model_selection[this.id],
      message: "Stub enabled by CROSS_REVIEW_STUB=1.",
    };
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    context.emit({
      type: "peer.call.started",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: "stub review",
    });
    if (context.signal?.aborted) {
      throw new Error("AbortError: stub call cancelled");
    }
    if (prompt.includes("FORCE_MODERATION_FAIL_UNRECOVERABLE")) {
      throw new Error("Invalid prompt: prompt flagged by moderation policy.");
    }
    if (
      prompt.includes("FORCE_MODERATION_FAIL") &&
      !prompt.includes("Compact Moderation-Safe Review")
    ) {
      throw new Error("Invalid prompt: prompt flagged by moderation policy.");
    }
    if (prompt.includes("FORCE_NETWORK_FAIL") && !this.model.includes("fallback")) {
      throw new Error("network fetch failed");
    }
    const text = prompt.includes("Cross Review - Decision Retry")
      ? JSON.stringify({
          status: "READY",
          summary: "No blocking objections remain.",
          confidence: "verified",
          evidence_sources: ["Attachment: deterministic-stub-fixture"],
          caller_requests: [],
          follow_ups: [],
        })
      : prompt.includes("Cross Review - Format Recovery")
        ? prompt.includes("FORCE_RECOVERY_FAIL")
          ? "Still no machine-readable status."
          : JSON.stringify({
              status: "READY",
              summary: "No blocking objections remain.",
              confidence: "verified",
              evidence_sources: ["Attachment: deterministic-stub-fixture"],
              caller_requests: [],
              follow_ups: [],
            })
        : prompt.includes("FORCE_BAD_FORMAT_UNRECOVERABLE")
          ? "I am READY, but this intentionally lacks JSON. FORCE_RECOVERY_FAIL"
          : prompt.includes("FORCE_EMPTY_REVIEW")
            ? ""
            : prompt.includes("FORCE_BAD_FORMAT")
              ? "I am READY, but this intentionally lacks the required machine-readable status object."
              : prompt.includes("FORCE_NOT_READY") || prompt.includes("FORCE_NEEDS_EVIDENCE")
                ? JSON.stringify({
                    status: prompt.includes("FORCE_NEEDS_EVIDENCE")
                      ? "NEEDS_EVIDENCE"
                      : "NOT_READY",
                    summary: "Stub detected a test marker.",
                    confidence: "verified",
                    evidence_sources: [],
                    caller_requests: ["Remove the test marker."],
                    follow_ups: [],
                  })
                : prompt.includes("FORCE_CANCEL_SLOW")
                  ? await new Promise<string>((resolve, reject) => {
                      const timer = setTimeout(
                        () =>
                          resolve(
                            JSON.stringify({
                              status: "READY",
                              summary: "No blocking objections remain.",
                              confidence: "verified",
                              evidence_sources: ["Attachment: deterministic-stub-fixture"],
                              caller_requests: [],
                              follow_ups: [],
                            }),
                          ),
                        10_000,
                      );
                      context.signal?.addEventListener(
                        "abort",
                        () => {
                          clearTimeout(timer);
                          reject(new Error("AbortError: stub call cancelled"));
                        },
                        { once: true },
                      );
                    })
                  : JSON.stringify({
                      status: "READY",
                      summary: "No blocking objections remain.",
                      confidence: "verified",
                      evidence_sources: ["Attachment: deterministic-stub-fixture"],
                      caller_requests: [],
                      follow_ups: [],
                    });
    this.streamStubText(context, "review", text);
    return {
      ...this.resultFromText({
        text,
        raw: { stub: true },
        usage: {
          input_tokens: prompt.length,
          output_tokens: text.length,
          total_tokens: prompt.length + text.length,
        },
        started: Date.now(),
        attempts: 1,
        modelReported: process.env.CROSS_REVIEW_STUB_REPORTED_MODEL,
      }),
      ...(shouldForceRealStubCost() ? {} : { cost: stubZeroCost() }),
    };
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    context.emit({
      type: "peer.generate.started",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: "stub generation",
    });
    // v2.5.0: propagate FORCE_* test markers from the input prompt into
    // the generated draft. Pre-v2.5.0 the stub took a 1200-char slice of
    // the prompt; once cross-review grew per-round prompt headers
    // (review focus, session-start contract directives, etc.) the
    // FORCE_* markers buried in `## Previous Version` fell out of the
    // 1200-char window, breaking smoke tests that rely on multi-round
    // marker continuity (e.g. budget-exceeded test driving claude with
    // FORCE_NOT_READY across 3 rounds). The slice still drives the
    // synthetic body for inspection; the marker preamble guarantees
    // semantic continuity.
    const FORCE_MARKERS = [
      "FORCE_BAD_FORMAT_UNRECOVERABLE",
      "FORCE_MODERATION_FAIL_UNRECOVERABLE",
      "FORCE_BAD_FORMAT",
      "FORCE_MODERATION_FAIL",
      "FORCE_NETWORK_FAIL",
      "FORCE_NEEDS_EVIDENCE",
      "FORCE_NOT_READY",
      "FORCE_RECOVERY_FAIL",
      "FORCE_EMPTY_REVIEW",
      "FORCE_CANCEL_SLOW",
      "FORCE_INITIAL_FABRICATION",
      // v2.13.0: drift simulation. Three shapes covered (resolution
      // path: keyword-prefix → JSON-prefix → markdown-fenced JSON,
      // matching ship-review R1 → R2 → R-fix2 evolution):
      //   FORCE_DRIFT       → keyword-prefix drift (`NEEDS_EVIDENCE\n...`)
      //   FORCE_DRIFT_JSON  → raw JSON drift (`{"status":"NEEDS_EVIDENCE",...}`)
      //   FORCE_DRIFT_MD    → markdown-wrapped JSON drift (` ```json\n{...}\n``` `)
      // FORCE_DRIFT_MD takes precedence over FORCE_DRIFT_JSON, which
      // takes precedence over FORCE_DRIFT.
      "FORCE_DRIFT_MD",
      "FORCE_DRIFT_JSON",
      "FORCE_DRIFT",
    ];
    const carriedMarkers = FORCE_MARKERS.filter((marker) => prompt.includes(marker));
    let driftPrefix: string[] = [];
    if (prompt.includes("FORCE_DRIFT_MD")) {
      driftPrefix = [
        "```json",
        '{"status":"NEEDS_EVIDENCE","summary":"Stub-forced markdown-fenced JSON drift; orchestrator should detect this via PATTERN_STATUS_FIELD.","caller_requests":[]}',
        "```",
        "",
      ];
    } else if (prompt.includes("FORCE_DRIFT_JSON")) {
      driftPrefix = [
        '{"status":"NEEDS_EVIDENCE","summary":"Stub-forced JSON-shape meta-review drift; orchestrator should detect this via PATTERN_STATUS_FIELD.","caller_requests":[]}',
        "",
      ];
    } else if (prompt.includes("FORCE_DRIFT")) {
      driftPrefix = [
        "NEEDS_EVIDENCE",
        "",
        "summary: Stub-forced meta-review drift; orchestrator should detect this and preserve prior draft.",
        "",
      ];
    }
    const fabricatedInitialDraft = prompt.includes("FORCE_INITIAL_FABRICATION")
      ? [
          "# Fabricated Initial Draft",
          "",
          "Local validation: cargo test passed (17 passed, 0 failed). git diff --check passed.",
          "",
        ]
      : [];
    // Initial-draft prompts place protocol/authority instructions before the
    // actual task. Echoing that header into the synthetic artifact makes the
    // anti-fabrication preflight correctly treat the stub draft as a fresh
    // authority claim. Real generators do not copy their system prompt, so the
    // deterministic stub mirrors the intended behavior by retaining only the
    // task section for this path. Revision prompts keep their historical slice.
    const promptForSyntheticDraft = prompt.includes("# Cross Review - First Draft")
      ? (prompt.split("## Task").at(-1) ?? prompt)
      : prompt;
    const text = [
      ...driftPrefix,
      ...fabricatedInitialDraft,
      ...(driftPrefix.length || fabricatedInitialDraft.length ? [] : ["# Test Draft", ""]),
      "This text was generated by the stub only because CROSS_REVIEW_STUB=1 is active.",
      "",
      ...(carriedMarkers.length ? [carriedMarkers.join(" "), ""] : []),
      promptForSyntheticDraft.slice(0, 1200),
    ].join("\n");
    this.streamStubText(context, "generation", text);
    return {
      ...this.generationFromText({
        text,
        raw: { stub: true },
        usage: {
          input_tokens: prompt.length,
          output_tokens: text.length,
          total_tokens: prompt.length + text.length,
        },
        started: Date.now(),
        attempts: 1,
        modelReported: process.env.CROSS_REVIEW_STUB_REPORTED_MODEL,
      }),
      ...(shouldForceRealStubCost() ? {} : { cost: stubZeroCost() }),
    };
  }

  // v2.9.0: deterministic judge response driven by FORCE_JUDGE_* markers
  // in the draft (NOT the prompt; the prompt is built by BasePeerAdapter
  // and includes the ask too). Markers:
  //   FORCE_JUDGE_SATISFIED  → satisfied=true, confidence=verified
  //   FORCE_JUDGE_INFERRED   → satisfied=true, confidence=inferred (NOT promoted by runtime)
  //   FORCE_JUDGE_UNKNOWN    → satisfied=false, confidence=unknown
  //   FORCE_JUDGE_PARSE_FAIL → invalid JSON returned (parser_warnings populated)
  //   default                → satisfied=false, confidence=verified
  override async judgeEvidenceAsk(
    ask: string,
    draft: string,
    context: PeerCallContext,
  ): Promise<EvidenceAskJudgment> {
    void ask;
    context.emit({
      type: "peer.judge.started",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: "stub judge",
    });
    const started = Date.now();
    let payload: {
      satisfied: boolean;
      confidence: "verified" | "inferred" | "unknown";
      rationale: string;
    };
    if (draft.includes("FORCE_JUDGE_PARSE_FAIL")) {
      // Bypass the JSON parser by emitting plain prose.
      const generation: GenerationResult = {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        text: "stub: this response intentionally lacks a JSON object",
        raw: { stub: true },
        usage: { input_tokens: ask.length, output_tokens: 60, total_tokens: ask.length + 60 },
        cost: shouldForceRealStubCost() ? undefined : stubZeroCost(),
        latency_ms: Date.now() - started,
        attempts: 1,
      };
      return this.parseJudgeResponse(generation, draft.length);
    }
    if (draft.includes("FORCE_JUDGE_SATISFIED")) {
      payload = {
        satisfied: true,
        confidence: "verified",
        rationale: "Stub judge: draft contains FORCE_JUDGE_SATISFIED marker.",
      };
    } else if (draft.includes("FORCE_JUDGE_INFERRED")) {
      payload = {
        satisfied: true,
        confidence: "inferred",
        rationale: "Stub judge: draft hints at satisfaction but evidence is indirect.",
      };
    } else if (draft.includes("FORCE_JUDGE_UNKNOWN")) {
      payload = {
        satisfied: false,
        confidence: "unknown",
        rationale: "Stub judge: cannot determine whether the draft satisfies the ask.",
      };
    } else {
      payload = {
        satisfied: false,
        confidence: "verified",
        rationale: "Stub judge default: no FORCE_JUDGE_* marker; treating as not satisfied.",
      };
    }
    const text = JSON.stringify(payload);
    const generation: GenerationResult = {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      text,
      raw: { stub: true, payload },
      usage: {
        input_tokens: ask.length,
        output_tokens: text.length,
        total_tokens: ask.length + text.length,
      },
      cost: shouldForceRealStubCost() ? undefined : stubZeroCost(),
      latency_ms: Date.now() - started,
      attempts: 1,
    };
    return this.parseJudgeResponse(generation, draft.length);
  }
}
