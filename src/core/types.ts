// v2.14.0 (item 5, operator directive 2026-05-04): Grok joined the
// quarteto, making it a quinteto. Per `project_cross_review_v2_grok_integration_pending.md`,
// xAI's Grok uses the OpenAI Responses API surface at base URL
// `https://api.x.ai/v1`. Auth is via GROK_API_KEY. Operators may choose
// `grok-4-latest` / `grok-4.3` (xAI automatic reasoning, no
// reasoning.effort body field) or `grok-4.20-multi-agent` (explicit
// reasoning.effort supported).
// Adapter at `peers/grok.ts` inherits the same Responses API code path
// the OpenAI adapter uses.
//
// v3.0.0 (operator directive 2026-05-12): Perplexity joined the
// quinteto, making it a sexteto. Per
// `project_cross_review_v2_v300_perplexity_sixth_peer.md`, Perplexity's
// Sonar API is OpenAI-Chat-Completions-compatible but lives at a
// distinct endpoint `https://api.perplexity.ai/v1/sonar`. Auth is via
// PERPLEXITY_API_KEY. Operators may choose `sonar` / `sonar-pro` /
// `sonar-reasoning-pro` (default; reasoning + grounding) /
// `sonar-deep-research` (multi-hop research; minutes per call).
// Distinct architectural traits vs the other 5 peers: (1) EVERY call
// performs web search by default — peer becomes a real-time fact-check
// channel; (2) system prompts ONLY shape tone/style of the final
// answer — the search component does not attend to them; (3) pricing
// has a third dimension (per-1000-request fee that scales with
// `search_context_size` low/medium/high) beyond input/output tokens;
// (4) usage.cost is reported per-call by the API in USD breakdown
// (a built-in we read directly for FinOps reconciliation, distinct
// from the config-driven cost layer); (5) `reasoning_effort` enum is
// `minimal|low|medium|high` only (no `xhigh`/`max`/`none`). All 6
// peers remain symmetric in role assignment — caller / lead_peer /
// reviewer — only the workspace HARD GATE rules apply uniformly
// (caller != lead_peer != reviewer).
// Adapter at `peers/perplexity.ts` reuses the shared `loadOpenAICtor`
// helper introduced in v2.27.1.
export const PEERS = ["codex", "claude", "gemini", "deepseek", "grok", "perplexity"] as const;
export type PeerId = (typeof PEERS)[number];

export const STATUSES = ["READY", "NOT_READY", "NEEDS_EVIDENCE"] as const;
export type ReviewStatus = (typeof STATUSES)[number];

export type Confidence = "verified" | "inferred" | "unknown";
export type SessionOutcome = "converged" | "aborted" | "max-rounds";
// v2.13.0: ship vs review session intent. `ship` (default) means
// `initial_draft` is the artifact under refinement — lead_peer produces
// a NEW REVISED VERSION as prose. `review` means `initial_draft` is the
// review subject — lead may emit a structured response. Disambiguates
// the v2.12 lead_peer meta-review drift on "Review v..." task wording.
// v2.25.0: `circular` adds a third mode — serial deliberative custody
// imported from maestro-app. Caller submits an artifact; the rotator
// for the round revises or returns unchanged; the artifact rotates to
// the next non-caller peer. Convergence = full rotation completes
// without any rotator producing a substantive change. There is no
// parallel peer-voting step in this mode — the rotator IS the actor
// each round. Best applied to producing/refining shared prose
// artifacts (specs, design docs, CHANGELOGs, README copy). For
// approve/reject judgments over external code/artifacts, prefer ship
// or review modes.
export type SessionMode = "ship" | "review" | "circular";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SessionControlStatus =
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "recovered_after_restart";
export type DecisionQuality =
  | "clean"
  | "format_warning"
  | "recovered"
  | "needs_operator_review"
  | "failed";

export interface ModelCandidate {
  id: string;
  display_name?: string;
  source: "api" | "documented-priority" | "env-override";
  metadata?: Record<string, unknown>;
}

export interface ModelSelection {
  peer: PeerId;
  selected: string;
  candidates: ModelCandidate[];
  source_url: string;
  reason: string;
  confidence: Confidence;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  // v2.21.0 (caching): canonical cross-provider cache telemetry. Adapters
  // populate these from provider-native fields (Anthropic
  // cache_creation_input_tokens / cache_read_input_tokens; OpenAI
  // prompt_tokens_details.cached_tokens; DeepSeek
  // prompt_cache_hit_tokens / prompt_cache_miss_tokens; Gemini
  // usageMetadata.cachedContentTokenCount; Grok mirrors OpenAI). The
  // shape is uniform so the cost layer + dashboard + manifest never
  // branch on provider.
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_provider_mode?: "auto" | "explicit" | "implicit" | "not_supported";
  cache_key_hash?: string;
  // v3.0.0 (Perplexity 6th peer): Sonar API reports additional token
  // categories and a search-query count alongside prompt/completion.
  // `citation_tokens` is the number of tokens spent inlining the
  // citation block (sonar-deep-research) — separately billed at
  // citation_tokens_per_million. `num_search_queries` is the count of
  // distinct web-search invocations the model issued during the
  // request — separately billed at search_queries_per_1000 for
  // sonar-deep-research. Both are absent for non-perplexity peers and
  // for non-deep-research perplexity models.
  citation_tokens?: number;
  num_search_queries?: number;
  // v3.0.0: Perplexity API also returns its OWN per-call cost
  // breakdown (`usage.cost.total_cost` etc.) in USD. We capture it
  // here for telemetry/reconciliation, but the config-driven cost
  // layer (estimateCost in core/cost.ts) remains AUTHORITATIVE for
  // budget decisions — operator-controlled rates take precedence over
  // provider-reported costs to keep the no-hardcoded-financials
  // contract intact.
  provider_reported_total_cost_usd?: number;
  // v3.0.0 R1 fix (codex cross-review catch 2026-05-12): per-call
  // signal that a Perplexity Sonar call actually performed a web search
  // on the wire. The relator (generate) role forces disable_search:true
  // regardless of operator config; without this signal, estimateCost()
  // would charge a request fee for searches that did not run. False
  // means the adapter sent disable_search:true; true means search was
  // active. Undefined (legacy/stub paths) → cost layer falls back to
  // the global config.perplexity.disable_search check. Set only by
  // PerplexityAdapter; ignored by all other peers' cost branches.
  search_performed?: boolean;
}

export interface CostEstimate {
  currency: "USD";
  input_cost?: number;
  output_cost?: number;
  total_cost?: number;
  estimated: boolean;
  // v2.5.0: "stub" tags zero-cost results emitted by the StubAdapter so
  // FinOps consumers can distinguish synthetic test runs from real spend.
  source: "configured-rate" | "unknown-rate" | "stub";
  // v2.21.0 (caching): when cache_read_tokens > 0 and a cache rate card
  // entry exists for the peer's provider, the cost layer computes the
  // delta savings vs the un-cached fresh-input rate and surfaces it
  // here. `cache_savings_unknown=true` when cache telemetry is present
  // but the rate card has no entry for the provider — operators see "we
  // got a cache hit but cannot price it" instead of a silent zero.
  cache_savings_usd?: number;
  cache_savings_unknown?: boolean;
  // v2.26.0: itemized cache costs surfaced when env-configured cache rates are
  // present and the call exhibited cache_read or cache_write tokens. These
  // ADD to total_cost (separate from input_cost which represents fresh
  // non-cached input). Operators see the full-precision breakdown in
  // session reports + dashboards.
  cache_read_cost?: number;
  cache_write_cost?: number;
  // v2.26.0: pricing-tier breadcrumbs for FinOps audit. `tier_used` indicates
  // which rate variant was picked by selectRate() at estimation time.
  // Possible values: "base" | "extended" | "promo" | "promo_extended".
  // Absent when source is "stub" or "unknown-rate".
  tier_used?: "base" | "extended" | "promo" | "promo_extended";
  // v3.0.0 (Perplexity 6th peer): Perplexity-specific cost line items.
  // request_cost is the per-1000-request fee scaled by
  // search_context_size (low/medium/high). citation_tokens_cost,
  // deep_research_reasoning_tokens_cost and search_queries_cost apply
  // only to the `sonar-deep-research` model — they are absent for
  // `sonar` / `sonar-pro` / `sonar-reasoning-pro` even when the peer is
  // perplexity. All four ADD to total_cost (separate from input_cost
  // which represents fresh non-cached input tokens). Absent for all
  // non-perplexity peers.
  request_cost?: number;
  citation_tokens_cost?: number;
  deep_research_reasoning_tokens_cost?: number;
  search_queries_cost?: number;
}

// v2.21.0 (caching): per-session manifest of every cached call. Persisted
// to <data_dir>/sessions/<session_id>/cache_manifest.json with the same
// atomic-write pattern as meta.json. Each entry corresponds to one peer
// call. The dashboard + reports tooling read this to show cache-hit
// rate per peer, per round, per provider mode without re-walking
// events.ndjson. Schema versioned via cache_schema_version so future
// breaking changes can be detected by manifest readers.
export interface CacheManifestEntry {
  ts: string;
  round: number;
  peer: PeerId;
  provider: string;
  model: string;
  cache_key_hash: string;
  cache_provider_mode: "auto" | "explicit" | "implicit" | "not_supported";
  read_tokens?: number;
  write_tokens?: number;
  hit: boolean;
  latency_ms: number;
  estimated_savings_usd?: number;
  savings_unknown?: boolean;
}

export interface CacheManifest {
  session_id: string;
  cache_schema_version: string;
  created_at: string;
  updated_at: string;
  entries: CacheManifestEntry[];
}

export interface PeerStructuredStatus {
  status: ReviewStatus;
  summary?: string;
  confidence?: Confidence;
  evidence_sources?: string[];
  caller_requests?: string[];
  follow_ups?: string[];
}

export interface PeerResult {
  peer: PeerId;
  provider: string;
  model: string;
  model_reported?: string;
  model_match?: boolean;
  status: ReviewStatus | null;
  structured: PeerStructuredStatus | null;
  text: string;
  raw: unknown;
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms: number;
  attempts: number;
  parser_warnings: string[];
  decision_quality: DecisionQuality;
  fallback?: FallbackEvent;
}

export interface GenerationResult {
  peer: PeerId;
  provider: string;
  model: string;
  model_reported?: string;
  model_match?: boolean;
  text: string;
  raw: unknown;
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms: number;
  attempts: number;
  fallback?: FallbackEvent;
  // v2.23.0: parser-side diagnostics produced by provider adapters when the
  // response payload was technically valid (tokens billed) but yielded a
  // text field that the orchestrator cannot use as next-round draft. The
  // canonical case is Claude Opus with extended thinking returning a
  // content array composed only of thinking/redacted_thinking blocks
  // and no final text block — see "anthropic_thinking_only_no_text_block".
  // The relator-revision path in CrossReviewOrchestrator inspects this
  // field before promoting `generation.text` to the next-round draft.
  parser_warnings?: string[];
}

export interface FallbackEvent {
  peer: PeerId;
  provider: string;
  from_model: string;
  to_model: string;
  reason: string;
  ts: string;
}

export interface PeerFailure {
  peer: PeerId;
  provider: string;
  model?: string;
  failure_class:
    | "auth"
    | "rate_limit"
    | "prompt_flagged_by_moderation"
    | "silent_model_downgrade"
    | "provider_error"
    | "network"
    | "timeout"
    | "schema"
    | "unparseable_after_recovery"
    | "budget_exceeded"
    | "budget_preflight"
    | "cancelled"
    | "fallback_exhausted"
    | "format_recovery_exhausted"
    | "stream_buffer_overflow"
    | "unknown";
  message: string;
  retryable: boolean;
  recovery_hint?: "wait_and_retry" | "reformulate_and_retry" | "consult_docs_then_revise";
  reformulation_advice?: string;
  retry_after_ms?: number;
  attempts: number;
  latency_ms: number;
  // v2.15.0 (item 5): when a provider 4xx error message cites a named
  // parameter (e.g. "Argument not supported on this model: reasoning.effort"),
  // the classifier surfaces a `consult_docs_then_revise` hint pointing
  // at the official docs URL for the offending field. This enforces the
  // workspace HARD RULE `feedback_consult_docs_before_amputating.md`:
  // operators should consult the official docs FIRST and never amputate
  // a feature to silence a 400. The field is set by classifyProviderError
  // when the regex below matches and a docs URL is known for the peer.
  docs_hint?: {
    parameter: string;
    docs_url?: string;
  };
}

export interface InFlightRound {
  round: number;
  peers: PeerId[];
  started_at: string;
  status: "running";
}

export interface ConvergenceScope {
  // Petitioner/impetrante: the caller that submitted the case. This is
  // the canonical actor for the self-review prohibition.
  petitioner?: PeerId | "operator";
  caller: PeerId | "operator";
  // Actor currently presenting the draft/status for this round. In
  // runUntilUnanimous this is usually the lead_peer; in direct ask_peers
  // it is normally the same as caller. Kept separate so persisted audit
  // state never has to pretend the relator is the petitioner.
  acting_peer?: PeerId | "operator";
  caller_status: ReviewStatus;
  expected_peers: PeerId[];
  reviewer_peers: PeerId[];
  lead_peer?: PeerId;
}

export interface ConvergenceHealth {
  state: "idle" | "running" | "converged" | "blocked" | "stale";
  last_event_at: string;
  detail: string;
  idle_ms?: number;
}

export interface EvidenceAttachment {
  ts: string;
  label: string;
  path: string;
  content_type?: string;
}

// v2.7.0 Evidence Broker: when a peer returns NEEDS_EVIDENCE with
// `caller_requests`, the runtime aggregates each ask into a structured
// checklist that gets surfaced into subsequent revision prompts.
// Empirical driver: the 253-session corpus showed 200+ NEEDS_EVIDENCE
// blockers across peers, and many sessions repeated the same ask
// across multiple rounds without explicit acknowledgement.
//
// v2.8.0 lifecycle: items default to "open" and the runtime promotes
// them to "addressed" when a subsequent round goes by without the
// peer resurfacing the same ask (resurfacing-inference). The operator
// can move items to terminal states via session_evidence_checklist_update.
// Conflict rule: when a peer resurfaces an "addressed" item it reverts
// to "open" — the peer's NEEDS_EVIDENCE wins over the runtime's
// inference. Terminal operator statuses are NOT auto-reverted; the
// runtime emits a peer_resurfaced_terminal event so the operator
// notices peers still asking for something they explicitly closed.
export type EvidenceChecklistStatus = "open" | "addressed" | "satisfied" | "deferred" | "rejected";

export interface EvidenceChecklistItem {
  // Stable id derived from sha256(`${peer}:${ask}`); identical asks
  // from the same peer are deduplicated across rounds.
  id: string;
  // Peer that surfaced the ask.
  peer: PeerId;
  // First round in which this ask was seen (does not advance on repeat).
  first_round: number;
  // Most recent round that surfaced this same ask (lets the broker
  // detect "same blocker, n rounds in a row").
  last_round: number;
  // Number of rounds the same ask has surfaced (>=1).
  round_count: number;
  // The verbatim caller_request text from the peer's structured status.
  ask: string;
  // ISO timestamp of first surfacing.
  first_seen_at: string;
  // ISO timestamp of latest surfacing.
  last_seen_at: string;
  // v2.8.0 lifecycle status. Items without `status` are treated as
  // "open" for back-compat with sessions saved by v2.7.x.
  status?: EvidenceChecklistStatus;
  // v2.8.0: round in which the runtime auto-promoted the item to
  // "addressed". Cleared when the item reverts to "open".
  addressed_at_round?: number;
  // v2.9.0: how the runtime promoted the item. "resurfacing" is the
  // v2.8.0 inference (peer did not bring the ask back); "judge" is the
  // v2.9.0 LLM judgment (judge peer ruled the new draft satisfies the
  // ask). Operator-set terminal statuses do not populate this field.
  // Cleared together with addressed_at_round on revert to "open".
  address_method?: "resurfacing" | "judge";
  // v2.9.0: brief verbatim rationale string returned by the judge peer
  // when address_method === "judge". Capped to keep the checklist
  // payload bounded; full rationale lives in the round's prompt/draft
  // artifacts and the evidence_status_history note. Undefined for
  // resurfacing-promoted items.
  judge_rationale?: string;
}

// v2.8.0: durable audit trail for every status transition on an
// evidence checklist item. The runtime appends an entry on every
// auto-transition (resurfacing inference) and on every operator
// call to session_evidence_checklist_update.
export interface EvidenceStatusHistoryEntry {
  ts: string;
  item_id: string;
  from: EvidenceChecklistStatus;
  to: EvidenceChecklistStatus;
  by: "runtime" | "operator";
  round?: number;
  note?: string;
}

export interface GenerationArtifact {
  ts: string;
  round: number;
  label: string;
  peer: PeerId;
  path: string;
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms?: number;
}

export interface OperatorEscalation {
  ts: string;
  reason: string;
  severity: "info" | "warning" | "critical";
}

export interface SessionControl {
  status: SessionControlStatus;
  reason?: string;
  job_id?: string;
  requested_at?: string;
  updated_at: string;
}

export interface RuntimeCapabilities {
  stable_release: boolean;
  api_only: boolean;
  cli_execution: false;
  durable_sessions: true;
  async_jobs: true;
  cancellation: true;
  restart_recovery: true;
  event_streaming: true;
  token_streaming: boolean;
  budget_preflight: true;
  model_fallback: true;
  metrics: true;
}

export interface PeerAdapter {
  id: PeerId;
  provider: string;
  model: string;
  call(prompt: string, context: PeerCallContext): Promise<PeerResult>;
  generate(prompt: string, context: PeerCallContext): Promise<GenerationResult>;
  // v2.9.0: judge an open evidence-checklist ask against a draft. The
  // judge sees only `ask + draft` (no session history) — by design.
  // Returns a structured judgment with confidence so the orchestrator
  // can promote items to "addressed" only when the judge is verified.
  // Default implementation lives on BasePeerAdapter and routes through
  // `generate()`; provider adapters do NOT need to override unless they
  // want a specialized structured-output path.
  judgeEvidenceAsk(
    ask: string,
    draft: string,
    context: PeerCallContext,
  ): Promise<EvidenceAskJudgment>;
  probe(): Promise<PeerProbeResult>;
}

// v2.9.0: structured outcome of one judge call. `satisfied === true`
// AND `confidence === "verified"` is the only combination the runtime
// uses to promote `open → addressed` (method = "judge"). Other
// confidences (`inferred`, `unknown`) leave status unchanged so the
// peer reviewers retain the final word.
export interface EvidenceAskJudgment {
  peer: PeerId;
  provider: string;
  model: string;
  satisfied: boolean;
  confidence: Confidence;
  // Brief verbatim rationale (typically 1-3 sentences). Surfaced into
  // the checklist item's `judge_rationale` and the history entry note
  // when the judgment promotes the item.
  rationale: string;
  // Raw provider response — for postmortem analysis only; the runtime
  // does not parse this beyond pulling `satisfied/confidence/rationale`.
  raw: unknown;
  // Token usage + cost (if rates are configured). Plumbed through the
  // same `mergeUsage`/`mergeCost` paths as `PeerResult` for FinOps
  // accounting.
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms: number;
  attempts: number;
  // Parser warnings encountered while extracting structured fields from
  // the provider response. Non-empty does not invalidate the judgment;
  // it surfaces format-stability concerns to the dashboard.
  parser_warnings: string[];
}

export interface PeerCallContext {
  session_id: string;
  round: number;
  task: string;
  signal?: AbortSignal;
  stream?: boolean;
  stream_tokens?: boolean;
  emit(event: RuntimeEvent): void;
  // v2.15.0 (item 2): per-call reasoning_effort override. When supplied,
  // the adapter reads this instead of `config.reasoning_effort[peer_id]`
  // for the current call. Operator uses this to dial down expensive
  // peers (e.g. Grok grok-4.20-multi-agent xhigh = 16 agents = $1+/call)
  // for routine cross-reviews while keeping the global default at xhigh
  // for ship-critical paths. The adapter is responsible for honoring
  // the field; OpenAI/Anthropic/Gemini/DeepSeek treat it as
  // chain-of-thought depth, Grok treats it as agent count (semantic
  // divergence per peers/grok.ts header).
  reasoning_effort_override?: ReasoningEffort;
  // v2.21.0 (caching): caller identity plumbed to the adapter so
  // OpenAI/Grok adapters can build a pair-scoped prompt_cache_key
  // (peer:caller:vN). Defaults to "operator" when omitted by the
  // orchestrator (preserves pre-v2.21.0 caller-less calls).
  caller?: PeerId | "operator";
}

export interface PeerProbeResult {
  peer: PeerId;
  provider: string;
  model: string;
  available: boolean;
  auth_present: boolean;
  latency_ms: number;
  model_selection?: ModelSelection;
  message?: string;
}

export interface RuntimeEvent {
  seq?: number;
  type: string;
  ts?: string;
  session_id?: string;
  round?: number;
  peer?: PeerId;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SessionEvent extends RuntimeEvent {
  seq: number;
}

export interface SessionMeta {
  session_id: string;
  version: string;
  created_at: string;
  updated_at: string;
  task: string;
  review_focus?: string;
  caller: PeerId | "operator";
  outcome?: SessionOutcome;
  outcome_reason?: string;
  capability_snapshot: PeerProbeResult[];
  in_flight?: InFlightRound;
  convergence_scope?: ConvergenceScope;
  convergence_health?: ConvergenceHealth;
  failed_attempts?: Array<PeerFailure & { round: number }>;
  evidence_files?: EvidenceAttachment[];
  evidence_checklist?: EvidenceChecklistItem[];
  // v2.8.0: durable audit trail for every status transition on an
  // evidence checklist item (auto + operator). Newest entries appended.
  evidence_status_history?: EvidenceStatusHistoryEntry[];
  generation_files?: GenerationArtifact[];
  operator_escalations?: OperatorEscalation[];
  control?: SessionControl;
  fallback_events?: FallbackEvent[];
  rounds: ReviewRound[];
  totals: {
    usage: TokenUsage;
    cost: CostEstimate;
  };
  // v2.14.0 (item 4): tribunal-colegiado contestation chain. Per the
  // memory `project_cross_review_v2_tribunal_colegiado_model.md`:
  // caller READY = acata; caller NOT_READY = contesta → novo ciclo.
  // When this session was contested by the caller, the runtime
  // populates `contestation`; when a new session was initialized to
  // re-deliberate a previous session, the new session's
  // `contests_session_id` points back. Both are append-only — once
  // set, they preserve the chain of custody across sessions.
  contestation?: {
    contested_at: string;
    reason: string;
    original_outcome: SessionOutcome | null;
    new_session_id: string;
  };
  contests_session_id?: string;
  // v2.25.0 (circular mode): durable bookkeeping for the serial
  // deliberative loop. Populated only when the session was started
  // with `mode: "circular"`. `rotation_order` is the deterministic
  // rotation derived from the session's caller-excluded peer list at
  // session_init (length >= 2 enforced). `consecutive_no_change_count`
  // tracks how many consecutive rounds the rotator returned the
  // artifact unchanged — convergence fires when it reaches
  // `rotation_order.length` (i.e. one full rotation with every peer
  // approving the current artifact without modification).
  // `last_revision_round` is the round number of the most recent
  // substantive revision (used by the dashboard / metrics to show
  // "ratchet progress"). Absent on ship/review sessions for back-compat.
  circular_state?: {
    rotation_order: PeerId[];
    consecutive_no_change_count: number;
    last_revision_round: number | null;
  };
  // v2.22.0 (B.P3): per-round cost telemetry + budget ceiling snapshot.
  // `cost_ceiling_usd` captures `config.budget.max_session_cost_usd` at
  // session_init time so subsequent retroactive analysis can compute
  // budget pressure even if the operator changed the env-var midway.
  // `costs_per_round[i]` is the incremental USD cost of round i+1 (i.e.
  // `costs_per_round` length tracks `rounds.length`). `budget_warning_emitted`
  // is the one-shot guard for `session.budget_warning` event idempotency
  // — the event fires once when cumulative cost crosses 75% of the
  // ceiling, never again. All three fields are optional for legacy
  // back-compat with sessions saved by v2.21.x and earlier.
  cost_ceiling_usd?: number | null;
  costs_per_round?: number[];
  budget_warning_emitted?: boolean;
}

export interface ReviewRound {
  round: number;
  started_at: string;
  completed_at?: string;
  caller_status: ReviewStatus;
  draft_file?: string;
  prompt_file: string;
  peers: PeerResult[];
  rejected: PeerFailure[];
  convergence: ConvergenceResult;
}

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
  latest_round_converged?: boolean;
  session_quorum_converged?: boolean;
  recovery_converged?: boolean;
  quorum_peers?: PeerId[];
  ready_peers: PeerId[];
  not_ready_peers: PeerId[];
  needs_evidence_peers: PeerId[];
  rejected_peers: PeerId[];
  decision_quality: Record<PeerId, DecisionQuality>;
  blocking_details: string[];
}

export interface AppConfig {
  version: string;
  data_dir: string;
  log_level: string;
  stub: boolean;
  dashboard_port: number;
  retry: {
    max_attempts: number;
    base_delay_ms: number;
    max_delay_ms: number;
    timeout_ms: number;
  };
  budget: {
    max_session_cost_usd?: number;
    until_stopped_max_cost_usd?: number;
    preflight_max_round_cost_usd?: number;
    require_rates_for_budget: boolean;
    default_max_rounds: number;
    // v2.25.0 (circular mode): see AppConfig docs in config.ts. Used by
    // runUntilUnanimous when sessionMode === "circular" to derive
    // `effectiveMaxRounds = circular_max_rotations × rotation_order.length`.
    circular_max_rotations: number;
  };
  prompt: {
    max_task_chars: number;
    max_review_focus_chars: number;
    max_history_chars: number;
    max_draft_chars: number;
    max_prior_rounds: number;
    max_peer_requests: number;
    // v2.14.0 (path-A structural fix): cap on the total bytes of
    // attached evidence inlined into peer-facing prompts. The caller
    // anexa via `session_attach_evidence` (existing MCP tool); the
    // attachedEvidenceBlock helper walks meta.evidence_files, reads
    // each file from disk, and inlines up to this cap. Default 80_000
    // bytes balances "enough room for codex's literal evidence asks"
    // against "fits comfortably in the smaller peer context windows".
    max_attached_evidence_chars: number;
  };
  max_output_tokens: number;
  streaming: {
    events: boolean;
    tokens: boolean;
    include_text: boolean;
  };
  models: Record<PeerId, string>;
  fallback_models: Partial<Record<PeerId, string[]>>;
  reasoning_effort: Partial<Record<PeerId, ReasoningEffort>>;
  model_selection: Partial<Record<PeerId, ModelSelection>>;
  api_keys: Record<PeerId, string | undefined>;
  // v2.26.0: cost_rates expanded to a complete pricing model — base + extended-tier
  // (e.g. Gemini >200K) + cache (read+write) + promo (limited-time discount that
  // expires at promo_expires_at) for each variant. Only `input_per_million` and
  // `output_per_million` are required (backward compat with v2.0.0+); every
  // other field is optional. The cost layer's selectRate() chooses the right
  // value per (category, tier, promo-active?) at estimateCost() time.
  cost_rates: Partial<
    Record<
      PeerId,
      {
        input_per_million: number;
        output_per_million: number;
        // Extended-tier rates (used when total input tokens exceed
        // threshold_tokens; e.g., Gemini ≤200K vs >200K).
        input_extended_per_million?: number;
        output_extended_per_million?: number;
        // Cache rates (read = cache hit, write = cache creation).
        // For Anthropic, cache_write reflects 1h TTL pricing per workspace
        // policy (most common server-default); operators can set a lower
        // value if they exclusively use 5m TTL.
        cache_read_per_million?: number;
        cache_write_per_million?: number;
        cache_read_extended_per_million?: number;
        cache_write_extended_per_million?: number;
        // Promo rates (limited-time discounts; e.g., DeepSeek v4-pro 75% off
        // until 2026-05-31). Selection requires promo_expires_at to be present
        // AND today < promo_expires_at AND the corresponding promo field set.
        promo_input_per_million?: number;
        promo_output_per_million?: number;
        promo_input_extended_per_million?: number;
        promo_output_extended_per_million?: number;
        promo_cache_read_per_million?: number;
        promo_cache_write_per_million?: number;
        promo_cache_read_extended_per_million?: number;
        promo_cache_write_extended_per_million?: number;
        promo_expires_at?: string; // ISO 8601 UTC timestamp
        // Threshold for extended tier (in tokens). When total input >
        // threshold, *_extended_per_million fields are used (when set). Null
        // or undefined means no tier split for this provider.
        threshold_tokens?: number;
        // v3.0.0 (Perplexity 6th peer): Perplexity bills BOTH per-token
        // AND per-request, where the request fee scales with
        // `search_context_size` (low/medium/high). Other providers bill
        // only per-token, so these fields are undefined for them.
        // Operator configures via
        // CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_<LOW|MEDIUM|HIGH>_USD_PER_1000_REQUESTS.
        request_fee_low_per_1000?: number;
        request_fee_medium_per_1000?: number;
        request_fee_high_per_1000?: number;
        // v3.0.0 (Perplexity Sonar Deep Research only): citation_tokens
        // and search_queries are billed separately from
        // input/output/reasoning. Other Sonar models (sonar / sonar-pro /
        // sonar-reasoning-pro) leave these undefined. reasoning_tokens
        // for Sonar Deep Research are also billed separately from output
        // (other peers fold reasoning into output billing).
        citation_tokens_per_million?: number;
        deep_research_reasoning_tokens_per_million?: number;
        search_queries_per_1000?: number;
      }
    >
  >;
  // v2.12.0: judge auto-wire surfaced as first-class config so server_info,
  // dashboard and orchestrator share one source of truth instead of each
  // call site re-reading env vars. The boot notice and the shadow path in
  // orchestrator.ts both use this struct.
  evidence_judge_autowire: EvidenceJudgeAutowireConfig;
  // v2.14.0 (operator directive 2026-05-04): per-peer enable/disable
  // surface so the operator can exclude empirically-weak peers per
  // workspace without editing code. Set via env vars
  // `CROSS_REVIEW_V2_PEER_<NAME>=on|off` (default `on`). Minimum 2
  // peers enabled at boot — boot fails fast otherwise. Lottery and
  // dispatch filter `selectedPeers` to the enabled set; an explicit
  // `lead_peer` or `peers` referencing a disabled peer is hard-rejected
  // at the orchestrator boundary.
  peer_enabled: Record<PeerId, boolean>;
  // v2.21.0 (caching): cross-provider prompt caching. Default-on; the
  // operator can switch off globally via
  // CROSS_REVIEW_V2_DISABLE_CACHE=true, override per-provider TTL via
  // CROSS_REVIEW_V2_CACHE_TTL_ANTHROPIC=5m|1h /
  // CROSS_REVIEW_V2_CACHE_TTL_OPENAI=5m|1h, and bump the schema version
  // when materially changing prompt structure to invalidate stale
  // caches via CROSS_REVIEW_V2_CACHE_SCHEMA_VERSION. The schema_version
  // ALSO appears on the first line of `stablePrefix` so any structural
  // shift produces a different cache_key_hash by design.
  cache: {
    schema_version: string;
    enabled: boolean;
    ttl: {
      anthropic: "5m" | "1h";
      openai: "5m" | "1h";
    };
  };
  // v3.0.0 (Perplexity 6th peer): per-call knobs that are specific to
  // Perplexity Sonar API. `search_context_size` controls the breadth of
  // the underlying web search (low/medium/high) and drives both quality
  // AND per-1000-request fee. `disable_search` turns off the web-search
  // component entirely (peer becomes a pure LLM reasoning over the
  // attached evidence; pricing reduces to token-based only). Set via
  // CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE (default "low") and
  // CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH (default false).
  perplexity: {
    search_context_size: "low" | "medium" | "high";
    disable_search: boolean;
  };
}

// v2.12.0: see AppConfig.evidence_judge_autowire. `mode` is widened to
// string so an invalid env value (typo) survives without throwing — the
// boot notice still warns the operator, and `active` reports whether the
// runtime will actually fire the shadow pass. `peer` is undefined when
// the configured peer name is missing or not in PEERS.
export type EvidenceJudgeAutowireMode = "off" | "shadow" | "active";
export interface EvidenceJudgeAutowireConfig {
  mode: EvidenceJudgeAutowireMode | string;
  peer: PeerId | undefined;
  active: boolean;
  max_items_per_pass: number;
  configured_mode_raw: string;
  configured_peer_raw: string;
  // v2.15.0 (item 1): consensus-based autowire. When set (>=2 enabled
  // peers), the autowire path dispatches to
  // runEvidenceChecklistJudgeConsensusPass instead of single-peer judge.
  // Promotes only when ALL peers return verified-satisfied. Set via env
  // CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS=peer1,peer2,...
  // (comma-separated). Empty list (or single-peer or invalid) → falls
  // back to the v2.12.0 single-peer autowire path.
  consensus_peers: PeerId[];
  configured_consensus_peers_raw: string;
}

// v2.8.0: per-peer health roll-up surfaced through the runtime metrics
// payload and the dashboard. Closes Codex+Gemini audit item "per-provider
// health dashboard" — operators can see at a glance which provider drives
// most of the cost or stalls most of the convergence rounds.
export interface PeerHealthSummary {
  peer: PeerId;
  results_total: number;
  ready_count: number;
  not_ready_count: number;
  needs_evidence_count: number;
  // Results where the peer produced a response but no parseable status
  // (parser fell back to `null`). Distinct from `rejected_total`, which
  // counts requests that never produced a usable response at all.
  unresolved_count: number;
  ready_rate: number;
  needs_evidence_rate: number;
  // null when no result carried a populated total_cost.
  avg_cost_usd: number | null;
  total_cost_usd: number | null;
  parser_warnings_total: number;
  rejected_total: number;
  failures_by_class: Partial<Record<PeerFailure["failure_class"], number>>;
}

// v2.12.0: rollup of `session.evidence_judge_pass.shadow_decision` events
// across sessions. Operator observability: how many decisions has the
// shadow pass produced, what is the would_promote rate per judge_peer,
// what confidence distribution does the judge return. Prereq for v2.13's
// precision-report tool that correlates these with subsequent peer
// behavior.
export interface ShadowJudgmentRollup {
  decisions_total: number;
  would_promote_total: number;
  by_judge_peer: Partial<Record<PeerId, ShadowJudgmentPeerStats>>;
}

// v2.14.0 (item 1): precision/recall/F1 of the shadow judge against
// the empirical "did peer keep asking?" ground truth. Walks
// `session.evidence_judge_pass.shadow_decision` events, correlates
// each with the subsequent peer behavior on the same evidence
// checklist item id (whether peers raised the same ask in a later
// round), and rolls up per `judge_peer`.
//
// Classification (judge's prediction vs ground truth):
//   - judge would_promote=true,  ask resurfaced → FP
//   - judge would_promote=true,  ask not resurfaced → TP
//   - judge would_promote=false, ask resurfaced → TN
//   - judge would_promote=false, ask not resurfaced → FN
//
// Decisions whose item.last_round equals judge_round AND no later
// round exists are excluded from the rollup (insufficient ground
// truth — we can't tell whether the ask would have come back).
export interface JudgmentPrecisionPeerStats {
  judge_peer: PeerId;
  decisions_total: number;
  decisions_with_ground_truth: number;
  decisions_skipped_no_ground_truth: number;
  // Counts.
  true_positive: number;
  false_positive: number;
  true_negative: number;
  false_negative: number;
  // Rates. null when denominator is 0.
  precision: number | null;
  recall: number | null;
  f1: number | null;
  by_confidence: Partial<Record<Confidence, { tp: number; fp: number; tn: number; fn: number }>>;
}

export interface JudgmentPrecisionReport {
  generated_at: string;
  peer_filter?: PeerId;
  since_filter?: string;
  session_filter?: string;
  decisions_total: number;
  decisions_with_ground_truth: number;
  decisions_skipped_no_ground_truth: number;
  by_judge_peer: Partial<Record<PeerId, JudgmentPrecisionPeerStats>>;
}

export interface ShadowJudgmentPeerStats {
  judge_peer: PeerId;
  decisions_total: number;
  would_promote: number;
  would_skip_satisfied_unverified: number;
  would_skip_not_satisfied: number;
  by_confidence: Partial<Record<Confidence, number>>;
  // First and last shadow_decision event timestamps observed for this
  // peer. Helps the operator gauge how long shadow has been collecting
  // data.
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface RuntimeMetrics {
  generated_at: string;
  scope: "all" | "session";
  session_id?: string;
  sessions: {
    total: number;
    converged: number;
    aborted: number;
    max_rounds: number;
    unfinished: number;
  };
  rounds: number;
  peer_results: Partial<Record<PeerId, number>>;
  peer_failures: Partial<Record<PeerFailure["failure_class"], number>>;
  decision_quality: Partial<Record<DecisionQuality, number>>;
  moderation_recoveries: number;
  fallback_events: number;
  total_usage: TokenUsage;
  total_cost: CostEstimate;
  latency_ms: {
    peer_average: number | null;
    generation_average: number | null;
  };
  // v2.8.0
  per_peer_health: Partial<Record<PeerId, PeerHealthSummary>>;
  // v2.12.0
  shadow_judgment: ShadowJudgmentRollup;
}

export interface SessionDoctorEntry {
  session_id: string;
  version?: string;
  caller?: PeerId | "operator";
  petitioner?: PeerId | "operator";
  lead_peer?: PeerId;
  outcome?: SessionOutcome;
  outcome_reason?: string;
  health_state?: ConvergenceHealth["state"];
  health_detail?: string;
  rounds: number;
  updated_at: string;
  open_evidence_items?: number;
  grok_provider_errors?: number;
  event_read_error?: string;
  // v2.22.0 (B.P2): evidence checklist drill-down. Populated only on
  // entries where `open_evidence_items > 0` (i.e. those routed into
  // `findings.open_evidence_sessions`). `item_types` aggregates open
  // items by surfacing peer; `chronic_blockers` lists item ids with
  // `round_count >= 3`. Both are optional for back-compat with consumers
  // reading older snapshots.
  item_types?: Partial<Record<PeerId, number>>;
  chronic_blockers?: string[];
}

export interface SessionDoctorReport {
  generated_at: string;
  scope: "all";
  limit: number;
  totals: {
    sessions: number;
    open: number;
    stale: number;
    blocked: number;
    max_rounds: number;
    self_lead_metadata: number;
    open_evidence_sessions: number;
    grok_provider_error_sessions: number;
    event_read_error_sessions: number;
  };
  findings: {
    open_sessions: SessionDoctorEntry[];
    stale_sessions: SessionDoctorEntry[];
    blocked_sessions: SessionDoctorEntry[];
    max_rounds_sessions: SessionDoctorEntry[];
    self_lead_metadata: SessionDoctorEntry[];
    open_evidence_sessions: SessionDoctorEntry[];
    grok_provider_error_sessions: SessionDoctorEntry[];
    event_read_error_sessions: SessionDoctorEntry[];
  };
  event_noise: {
    events_total: number;
    token_delta_events: number;
    token_completed_events: number;
    token_delta_ratio: number | null;
  };
  recommendations: string[];
}
