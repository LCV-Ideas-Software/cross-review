#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getFileConfigRuntimeStatus,
  loadConfig,
  missingFinancialControlVars,
  RELEASE_DATE,
  VERSION,
} from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { maxOutputTokensForPeer } from "../core/output-budget.js";
import { sessionReportMarkdown } from "../core/reports.js";
import type {
  ConvergenceScope,
  PeerId,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionMeta,
} from "../core/types.js";
import { PEERS } from "../core/types.js";
import { EventLog } from "../observability/logger.js";
import { safeErrorMessage } from "../security/redact.js";

const PeerSchema = z.enum(PEERS);
// v2.18.6 / Gemini-API compat: `caller` accepts any peer + "operator".
// Pre-v2.18.6 we used `CallerSchema`
// which the MCP SDK serialized as `anyOf: [enum, const]` — Gemini API's
// function-declaration validator rejects that shape. A flat enum is
// runtime-equivalent (same accepted values, same TS inferred type) and
// produces a clean single `enum` in the wire JSON Schema.
const CallerSchema = z.enum([...PEERS, "operator"] as const);
const ResponseFormatSchema = z.enum(["json", "markdown"]).default("json");
const SessionListOutcomeFilterSchema = z
  .enum(["all", "open", "converged", "aborted", "max-rounds"])
  .default("all");
const SessionListDetailSchema = z.enum(["summary", "full"]).default("summary");
const SESSION_LIST_DEFAULT_LIMIT = 25;
const SESSION_LIST_MAX_LIMIT = 100;
// v2.15.0 (item 2): per-call reasoning_effort overrides. Optional partial
// record keyed by peer id; missing keys fall back to the global config
// default (CROSS_REVIEW_<PEER>_REASONING_EFFORT env var, ultimately
// resolved by core/config.ts). The string enum mirrors `ReasoningEffort`
// in core/types.ts. Each adapter that consumes effort reads the override
// from `PeerCallContext.reasoning_effort_override`. Adapters without an
// effort knob (gemini today) silently ignore it.
//
// v2.18.6 / Gemini-API compat: pre-v2.18.6 this was `z.record(PeerSchema,
// ReasoningEffortSchema).optional()`. The MCP SDK serialized that as
// `{type:"object", propertyNames:{enum:[...]}, additionalProperties:{enum:[...]},
// required:[<all peers>]}` — non-standard OpenAPI 3.0 (Gemini API
// rejects `propertyNames`) plus a phantom `required` listing all peers
// despite the field being `.optional()`. Flattening to an explicit
// `z.object({codex?, claude?, gemini?, deepseek?, grok?, perplexity?})`
// (v3.7.1 / AUDIT-4: comment refreshed — perplexity has been the 6th peer
// since v3.0.0) produces a clean `{type:"object", properties:{...}}`
// accepted by every host; runtime accepts the same
// `{codex:"high", claude:"low"}` shape.
const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const ReasoningEffortOverridesSchema = z
  .object({
    codex: ReasoningEffortSchema.optional(),
    claude: ReasoningEffortSchema.optional(),
    gemini: ReasoningEffortSchema.optional(),
    deepseek: ReasoningEffortSchema.optional(),
    grok: ReasoningEffortSchema.optional(),
    // v3.0.0: Perplexity 6th peer. Sonar API accepts only
    // `minimal|low|medium|high` on-the-wire (clamped at the adapter
    // boundary); the schema still accepts the full internal scale so
    // operators can mirror their global config style — the adapter
    // narrows to Perplexity's accepted set at call time.
    perplexity: ReasoningEffortSchema.optional(),
  })
  .optional()
  .describe(
    "Optional per-peer reasoning_effort overrides for this call. Keys are peer ids (codex|claude|gemini|deepseek|grok|perplexity); missing keys fall back to global config. This is a shared scale: adapters normalize unsupported literals to the selected model's documented enum (`ultra` becomes max on GPT-5.6 and high on Grok 4.5; older GPT-5 families use their own ceilings).",
  );
// v2.4.0 / audit closure (P1.2): UUIDv4 regex was already accepting
// case-insensitive matches via the /i flag, but zod did not normalize the
// output. On case-sensitive filesystems (Linux, macOS) the same logical
// session would resolve to two different on-disk paths depending on how
// the caller capitalized the id; on Windows the read/write paths could
// drift between contexts. The transform below collapses the value to
// lowercase before any downstream consumer touches it, eliminating that
// TOCTOU surface without breaking existing UUIDv4 producers.
export const SessionIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    "session_id must be a valid UUIDv4",
  )
  .transform((value) => value.toLowerCase());
const ReviewFocusSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .describe(
    "Optional provider-neutral review scope anchor. This is not Claude Code's /focus UI command; it is injected as a front-loaded Review Focus prompt block for every selected peer, including OUT OF SCOPE handling for unrelated findings.",
  )
  .optional();

// v2.4.0 / audit closure (P2.5): MCP input-schema caps for the high-volume
// LLM input fields that previously only enforced `.min(1)`. The MCP
// StdioServerTransport does not impose a per-message cap, so a misbehaving
// caller — or any deployment that drifts off the trusted-host model — can
// OOM the orchestrator or burn provider tokens with one large prompt. The
// caps below are deliberately generous (an order of magnitude above the
// in-process `config.prompt.max_*` values) so they let normal usage
// through while rejecting obvious abuse before parser/spawn/persistence
// touch the bytes. Mirrors the v1.6.7 P1.1 hardening.
const SCHEMA_TASK_MAX_CHARS = 32_000;
const SCHEMA_DRAFT_MAX_CHARS = 200_000;
const SCHEMA_INITIAL_DRAFT_MAX_CHARS = 200_000;

function textResult(value: unknown, responseFormat = "json") {
  const text =
    responseFormat === "markdown" && typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

type SessionListOutcomeFilter = z.infer<typeof SessionListOutcomeFilterSchema>;
type SessionListDetail = z.infer<typeof SessionListDetailSchema>;

function textPreview(value: string, maxChars = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function matchesSessionListOutcome(meta: SessionMeta, outcomeFilter: SessionListOutcomeFilter) {
  if (outcomeFilter === "all") return true;
  if (outcomeFilter === "open") return !meta.outcome;
  return meta.outcome === outcomeFilter;
}

function summarizeSessionForList(meta: SessionMeta) {
  return {
    session_id: meta.session_id,
    version: meta.version,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    caller: meta.caller,
    outcome: meta.outcome ?? "open",
    outcome_reason: meta.outcome_reason ?? null,
    convergence_health: meta.convergence_health?.state ?? null,
    control_status: meta.control?.status ?? null,
    rounds: meta.rounds.length,
    in_flight: Boolean(meta.in_flight),
    generation_in_flight: Boolean(meta.generation_in_flight),
    open_evidence_items:
      meta.evidence_checklist?.filter((item) => item.status === "open").length ?? 0,
    lead_peer: meta.convergence_scope?.lead_peer ?? null,
    voting_peers:
      meta.convergence_scope?.voting_peers ?? meta.convergence_scope?.reviewer_peers ?? [],
    review_focus: meta.review_focus ?? null,
    task_preview: textPreview(meta.task),
  };
}

function sessionListPayload(
  metas: SessionMeta[],
  limit: number,
  offset: number,
  outcomeFilter: SessionListOutcomeFilter,
  detail: SessionListDetail,
) {
  const filtered = metas.filter((meta) => matchesSessionListOutcome(meta, outcomeFilter));
  const page = filtered.slice(offset, offset + limit);
  return {
    sessions: detail === "full" ? page : page.map((meta) => summarizeSessionForList(meta)),
    pagination: {
      total: filtered.length,
      returned: page.length,
      offset,
      limit,
      has_more: offset + page.length < filtered.length,
    },
    outcome_filter: outcomeFilter,
    detail,
  };
}

function sessionInitMarkdown(meta: SessionMeta): string {
  const availablePeers = meta.capability_snapshot
    .filter((probe) => probe.available)
    .map((probe) => probe.peer)
    .join(", ");
  return [
    `# cross-review session ${meta.session_id}`,
    "",
    `- version: ${meta.version}`,
    `- caller: ${meta.caller}`,
    `- created_at: ${meta.created_at}`,
    `- updated_at: ${meta.updated_at}`,
    `- outcome: ${meta.outcome ?? "open"}`,
    `- rounds: ${meta.rounds.length}`,
    `- review_focus: ${meta.review_focus ?? "none"}`,
    `- available_peers: ${availablePeers || "none"}`,
    "",
    "## Task",
    "",
    meta.task,
  ].join("\n");
}

// v2.17.0 (operator directive 2026-05-05): identity forgery rejection.
// Pre-v2.17.0, `caller` arrived from input and was trusted unconditionally
// — there was no `clientInfo` capture and no cross-check. An agent (e.g.
// Codex CLI from the operator's terminal) could pass `caller="claude"`
// while its MCP client identified itself as "codex", impersonating Claude
// in tribunal sessions. Empirical evidence: cross-review session
// `0994cbaf-c270-4eaa-b42b-a0e638b9d1b6` (2026-05-05T05:30:10Z) was
// created by Codex with caller=claude for exactly this purpose.
//
// `getCallerCandidatesFromClientInfo` walks PEERS for substring matches
// in clientInfo.name (lowercased). `verifyCallerIdentity` cross-checks
// the declared `caller` (from input) against the substrings; mismatch
// with a single-resolved client throws `identity_forgery_blocked`.
//
// Permissive cases preserved: (a) caller="operator" → OK (explicit
// "I'm the human operator" identity, no agent claim made); (b) clientInfo
// doesn't resolve to a known agent → OK (legitimate override for headless
// hosts); (c) declared caller matches clientInfo-derived candidate → OK.
//
// Blocked: (1) declared caller is a known agent + clientInfo resolves to
// a different known agent; (2) declared caller is a known agent +
// clientInfo resolves to MULTIPLE known agents (ambiguous host cannot
// validate the claim).
export type ClientInfo = { name?: string; version?: string } | undefined;

// v2.18.0 / F1 caller capability tokens — runtime record set at boot.
// Surfaced to verifyCallerIdentity for the token-overlay step. Module-level
// state because the token map is loaded once per server boot (file I/O on
// every call would be wasteful and gives an attacker a TOCTOU window).
import {
  ensureHostTokens,
  generateHostTokens as f1GenerateHostTokens,
  getParentProcessSnapshot,
  type HostTokensRecord,
  isHardEnforceMode,
  type ParentProcessSnapshot,
  verifyTokenForCaller,
} from "../core/caller-tokens.js";

let HOST_TOKENS_RECORD: HostTokensRecord | null = null;

export function getHostTokensRecord(): HostTokensRecord | null {
  return HOST_TOKENS_RECORD;
}
export function setHostTokensRecord(record: HostTokensRecord | null): void {
  HOST_TOKENS_RECORD = record;
}
export function initHostTokensRecord(dataDir: string): void {
  try {
    const record = ensureHostTokens(dataDir);
    HOST_TOKENS_RECORD = record || null;
  } catch {
    HOST_TOKENS_RECORD = null;
  }
}

export function getCallerCandidatesFromClientInfo(clientInfo: ClientInfo): PeerId[] {
  const name = String(clientInfo?.name || "").toLowerCase();
  if (!name) return [];
  const candidates: PeerId[] = [];
  for (const peer of PEERS) {
    if (name.includes(peer)) candidates.push(peer);
  }
  return candidates;
}

export type IdentityVerificationMethod = "token" | "client_info" | "none";

export interface CallerIdentityResult {
  identity_verified: boolean;
  verification_method: IdentityVerificationMethod;
  client_info_name: string | null;
  identity_metadata: ParentProcessSnapshot;
}

// v2.18.0 / F1: token verification overlays the v2.17.0 clientInfo gate.
// Decision tree (in order):
//   1. caller="operator" → require the distinct operator capability token.
//      A client name is self-declared and cannot authenticate a human; tokenless
//      or peer-token hosts therefore fail closed regardless of hard-enforce
//      mode. The operator token belongs only in a dedicated human console,
//      never in a model host.
//   2. v2.17.0 clientInfo cross-check throws → propagate (preserves all
//      existing forgery rejections).
//   3. CROSS_REVIEW_CALLER_TOKEN env present → must resolve to declaredCaller
//      via host-tokens.json; mismatch / unknown / file-missing → throws.
//      Match → upgrade verification_method to "token".
//   4. CROSS_REVIEW_CALLER_TOKEN absent + CROSS_REVIEW_REQUIRE_TOKEN=true →
//      throws (hard-enforce mode opted into by operator).
//   5. CROSS_REVIEW_CALLER_TOKEN absent + permissive (default) → return
//      whatever clientInfo cross-check yielded ("client_info" if matched,
//      "none" if unknown).
// All paths attach identity_metadata with a best-effort parent-process
// snapshot for forensics (Option C / Hybrid per design memory).
export function verifyCallerIdentity(
  declaredCaller: PeerId | "operator",
  clientInfo: ClientInfo,
): CallerIdentityResult {
  const identity_metadata = getParentProcessSnapshot();
  const candidates = getCallerCandidatesFromClientInfo(clientInfo);
  if (declaredCaller === "operator") {
    if (candidates.length > 0) {
      throw new Error(
        `identity_forgery_blocked: caller='operator' is not permitted from an agent-identified host. clientInfo.name='${clientInfo?.name}' resolves to ${candidates.join(", ")}; declare the actual peer identity (and present its token when required).`,
      );
    }
    const tokenResult = verifyTokenForCaller("operator", HOST_TOKENS_RECORD);
    if (!tokenResult.verified) {
      throw new Error(
        "operator_authority_required: caller='operator' requires the dedicated operator capability token in CROSS_REVIEW_CALLER_TOKEN. Use a separate human-console MCP host; never place this token in a model host.",
      );
    }
    return {
      identity_verified: true,
      verification_method: "token",
      client_info_name: clientInfo?.name ?? null,
      identity_metadata,
    };
  }
  if (candidates.length >= 2) {
    throw new Error(
      `identity_forgery_blocked: clientInfo.name='${clientInfo?.name}' matches multiple agents (${candidates.join(", ")}); cannot validate declared caller='${declaredCaller}' against an ambiguous client. Pass the request from a host whose clientInfo.name resolves to a single agent.`,
    );
  }
  if (candidates.length === 1 && candidates[0] !== declaredCaller) {
    throw new Error(
      `identity_forgery_blocked: declared caller='${declaredCaller}' contradicts clientInfo.name='${clientInfo?.name}' which resolves to '${candidates[0]}'. An agent cannot self-declare a different identity than its MCP host (operator directive 2026-05-05). If this is a legitimate cross-host setup, ensure clientInfo.name does not contain a different agent's name as substring.`,
    );
  }

  let verification_method: IdentityVerificationMethod =
    candidates.length === 1 ? "client_info" : "none";
  let identity_verified = candidates.length === 1;

  // Token overlay (v2.18.0 F1).
  const tokenResult = verifyTokenForCaller(declaredCaller, HOST_TOKENS_RECORD);
  if (tokenResult.verified) {
    verification_method = "token";
    identity_verified = true;
  } else if (isHardEnforceMode()) {
    throw new Error(
      "identity_forgery_blocked: CROSS_REVIEW_REQUIRE_TOKEN=true is set but no CROSS_REVIEW_CALLER_TOKEN was provided in this call's environment. Either remove the hard-enforce flag or distribute host-tokens.json to the calling host's MCP env.",
    );
  }

  return {
    identity_verified,
    verification_method,
    client_info_name: clientInfo?.name ?? null,
    identity_metadata,
  };
}

// v3.3.0 (operator directive 2026-05-12): caller peer-selection lock.
// "TODOS OS AGENTES/PEERS SEMPRE PARTICIPAM, INDEPENDENTE DA ESCOLHA OU
// VONTADE DO CALLER." Applied at the MCP-tool boundary so every
// externally-driven call has caller-supplied `peers` and (for peer
// callers) `lead_peer` stripped before reaching the orchestrator.
// Internal call sites (orchestrator's own runUntilUnanimous → askPeers
// loop, smoke harness) bypass the lock by construction — they do not go
// through this boundary. Operator caller may still pin `lead_peer`
// explicitly (legitimate testing/debug; operator is the meta-authority,
// not a session participant whose vote can be biased).
//
// `emitFn` carries the audit trail to the eventLog/store so the operator
// can inspect who tried to game which peer in/out via `session_events`.
export function lockCallerPeerSelection<
  T extends {
    peers?: PeerId[] | undefined;
    lead_peer?: PeerId | undefined;
    caller?: PeerId | "operator" | undefined;
    session_id?: string | undefined;
  },
>(
  input: T,
  ctx: {
    site: "ask_peers" | "session_start_round" | "run_until_unanimous" | "session_start_unanimous";
    emit: (event: RuntimeEvent) => void;
    // v3.7.5 (A2, logs+sessions study 2026-05-15): the server-configured
    // enabled set. Pre-v3.7.5 the lock fired its audit event every time
    // `peers` was non-empty, including when the caller passed a list
    // IDENTICAL to the enabled set (no actual override). 13 of 106
    // recent audit events were such no-op overrides (caller=claude,
    // ignored_peers = full 6-peer panel = enabled set). When this
    // field is supplied the lock short-circuits the emit when the
    // caller-supplied panel set-equals the enabled set; otherwise
    // (legacy callers, undefined) any explicitly supplied list is treated
    // as an override, including an empty list that would otherwise turn the
    // full-panel lock into a no-reviewer abort.
    enabledPeers?: readonly PeerId[] | undefined;
  },
): T {
  const caller: PeerId | "operator" = input.caller ?? "operator";
  // peers panel: locked for ALL callers (including operator). The
  // server-configured `peer_enabled` set is the only knob; operators
  // tune via env vars, not via per-call overrides that callers can
  // exploit.
  const callerSuppliedPeers = Array.isArray(input.peers) ? [...input.peers] : undefined;
  // v3.7.5 (A2): treat caller-supplied panel as an OVERRIDE only when
  // it differs from the enabled set. Sorted set-equality (case-sensitive
  // since PeerId is a closed string union). Backward-compat: when
  // `enabledPeers` is undefined (no caller passed it), the lock keeps
  // the v3.3.0 behavior — any non-empty list is treated as an override.
  const callerPanelMatchesEnabled =
    ctx.enabledPeers !== undefined &&
    callerSuppliedPeers !== undefined &&
    callerSuppliedPeers.length === ctx.enabledPeers.length &&
    [...callerSuppliedPeers].sort().join("|") === [...ctx.enabledPeers].sort().join("|");
  const peerPanelOverridden = callerSuppliedPeers !== undefined && !callerPanelMatchesEnabled;
  // lead_peer: locked for peer callers (forces lottery so callers cannot
  // pin a sympathetic relator). Operator caller may pin lead_peer for
  // legitimate testing.
  const leadPeerOverridden = caller !== "operator" && input.lead_peer !== undefined;

  if (peerPanelOverridden || leadPeerOverridden) {
    ctx.emit({
      type: "session.caller_peer_selection_ignored",
      session_id: input.session_id,
      message: `caller_peer_selection_lock: caller=${caller} attempted to ${peerPanelOverridden ? "override the reviewer panel" : "pin lead_peer"} via ${ctx.site}; the request was silently overridden — operator directive 2026-05-12 ("TODOS OS AGENTES/PEERS SEMPRE PARTICIPAM").`,
      data: {
        site: ctx.site,
        caller,
        peer_panel_overridden: peerPanelOverridden,
        ignored_peers: peerPanelOverridden ? callerSuppliedPeers : undefined,
        lead_peer_overridden: leadPeerOverridden,
        ignored_lead_peer: leadPeerOverridden ? input.lead_peer : undefined,
      },
    });
  }

  // Strip the locked fields. The orchestrator's defaults (full PEERS,
  // lottery for lead_peer when caller is a peer) take over.
  const sanitized: T = { ...input };
  if (peerPanelOverridden) delete sanitized.peers;
  if (leadPeerOverridden) delete sanitized.lead_peer;
  return sanitized;
}

// v3.6.0 (B3 + B4, logs+sessions study) — top-level human-readable
// `notices` for tool responses. The 169-session corpus showed two
// recurring misreads even after the relevant metadata existed:
//  - B3: a caller reading the relator's exclusion from the voting panel
//    as "the runtime dropped a peer" (v3.5.0 added
//    convergence_scope.lead_peer_role but it sits nested — Codex still
//    misread it live on session a3c2660d).
//  - B4: `session.caller_peer_selection_ignored` fired 30x — callers
//    repeatedly try to curate the panel; the v3.3.0 lock silently
//    overrides but nothing surfaces in the response they read.
// This helper derives a short, can't-miss `notices: string[]` from the
// pre-lock input vs the orchestrator output. Bounded (max 2 entries),
// only populated when applicable.
export function buildResponseNotices<
  T extends {
    peers?: PeerId[] | undefined;
    lead_peer?: PeerId | undefined;
    caller?: PeerId | "operator" | undefined;
  },
>(
  originalInput: T,
  output: { session?: { convergence_scope?: ConvergenceScope | undefined } | undefined },
  enabledPeers?: readonly PeerId[] | undefined,
): string[] {
  const notices: string[] = [];
  // B4 — peer-selection lock notice. If the caller supplied `peers` or
  // (as a peer caller) `lead_peer`, the v3.3.0 lock stripped it.
  const caller: PeerId | "operator" = originalInput.caller ?? "operator";
  const suppliedPeers = Array.isArray(originalInput.peers) ? originalInput.peers : undefined;
  const suppliedPeersMatchEnabled =
    enabledPeers !== undefined &&
    suppliedPeers !== undefined &&
    suppliedPeers.length === enabledPeers.length &&
    [...suppliedPeers].sort().join("|") === [...enabledPeers].sort().join("|");
  const triedPeers =
    suppliedPeers !== undefined && suppliedPeers.length > 0 && !suppliedPeersMatchEnabled;
  const triedLeadPeer = caller !== "operator" && originalInput.lead_peer !== undefined;
  if (triedPeers || triedLeadPeer) {
    notices.push(
      `peer_selection_lock: your ${triedPeers ? "`peers` panel" : "`lead_peer` pin"} was ignored — ` +
        `cross-review always uses the full server-configured peer set (operator directive 2026-05-12: ` +
        `"TODOS OS AGENTES/PEERS SEMPRE PARTICIPAM"). Tune the panel via CROSS_REVIEW_PEER_<NAME> env vars, not per-call.`,
    );
  }
  // B3 — relator-non-voting notice. When a lead_peer is set, spell out
  // that it is the non-voting relator and who the voting colegiado is,
  // so its absence from the vote is never misread as a dropped peer.
  const scope = output.session?.convergence_scope;
  if (scope?.lead_peer && scope.lead_peer_role === "relator_non_voting") {
    const voters = (scope.voting_peers ?? scope.reviewer_peers ?? []).join(", ");
    notices.push(
      `relator_non_voting: \`${scope.lead_peer}\` is the lottery-selected relator — it authors/revises the ` +
        `artifact and is DELIBERATELY excluded from the voting colegiado (anti-self-review HARD GATE). ` +
        `Voting peers: ${voters || "(none)"}. This is by design, not a dropped peer.`,
    );
  }
  return notices;
}

type JobKind = "ask_peers" | "run_until_unanimous" | "durable_session_round";
export type JobStatus = {
  job_id: string;
  kind: JobKind;
  session_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at?: string | undefined;
  error?: string | undefined;
  result_summary?: Record<string, unknown> | undefined;
};

type DurableSessionState = Pick<
  SessionMeta,
  "session_id" | "outcome" | "outcome_reason" | "in_flight" | "generation_in_flight" | "control"
>;

export type DurableJobStatus = JobStatus & {
  kind: "durable_session_round";
  source: "durable_session";
  round: number;
  peers: PeerId[];
  control_status: NonNullable<SessionMeta["control"]>["status"] | null;
  cancellation_requested: boolean;
};

/**
 * Process-local job maps are only an optimization. The persisted session is
 * the cross-window authority for whether work is still active.
 */
export function durableSessionExecutionActive(session: DurableSessionState): boolean {
  if (session.outcome) return false;
  return (
    Boolean(session.in_flight) ||
    Boolean(session.generation_in_flight) ||
    session.control?.status === "running" ||
    session.control?.status === "cancel_requested"
  );
}

export function durableSessionCancellationWon(
  session: DurableSessionState,
  signalAborted = false,
): boolean {
  return (
    signalAborted ||
    (session.outcome === "aborted" && session.outcome_reason === "session_cancelled") ||
    session.control?.status === "cancelled"
  );
}

/**
 * A background rejection may arrive after the routine has already persisted
 * its terminal snapshot. In that case the process-local catch handler must not
 * append an automatic operator escalation or rewrite the sealed meta/report.
 */
export function shouldEscalateBackgroundJobFailure(
  session: DurableSessionState | undefined,
): boolean {
  return Boolean(session && !session.outcome);
}

/**
 * Build the job-shaped view returned by session_poll when another MCP host
 * owns the real AbortController and this process therefore has no local job.
 */
export function synthesizeDurableJob(
  session: DurableSessionState,
  localJobs: readonly JobStatus[],
): DurableJobStatus | null {
  if (session.outcome || localJobs.some((job) => job.status === "running")) return null;
  const controlActive =
    session.control?.status === "running" || session.control?.status === "cancel_requested";
  if (!session.in_flight && !session.generation_in_flight && !controlActive) return null;
  return {
    job_id: session.control?.job_id ?? session.session_id,
    kind: "durable_session_round",
    session_id: session.session_id,
    status: "running",
    started_at:
      session.in_flight?.started_at ??
      session.generation_in_flight?.started_at ??
      session.control?.requested_at ??
      session.control?.updated_at ??
      "",
    source: "durable_session",
    round: session.in_flight?.round ?? session.generation_in_flight?.round ?? 0,
    peers:
      session.in_flight?.peers ??
      (session.generation_in_flight ? [session.generation_in_flight.peer] : []),
    control_status: session.control?.status ?? null,
    cancellation_requested: session.control?.status === "cancel_requested",
  };
}

/**
 * Observe cancellation written by a sibling MCP process. This closes the
 * process-local AbortController gap without holding a session lock for the
 * duration of a provider call. Read failures are transient/best-effort; the
 * next interval retries until the job settles.
 */
export function watchDurableCancellation(
  job: Pick<JobStatus, "job_id" | "session_id">,
  controller: AbortController,
  readSession: () => DurableSessionState,
  intervalMs = 250,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    controller.signal.removeEventListener("abort", stop);
  };
  const observe = () => {
    if (stopped || controller.signal.aborted) return;
    try {
      const session = readSession();
      const control = session.control;
      if (
        control?.status === "cancel_requested" &&
        (!control.job_id || control.job_id === job.job_id)
      ) {
        controller.abort(control.reason ?? "session_cancelled");
      }
    } catch {
      // A sibling may be atomically replacing meta.json. Retry on the next tick.
    }
  };

  controller.signal.addEventListener("abort", stop, { once: true });
  observe();
  if (!stopped) {
    timer = setInterval(observe, Math.max(5, intervalMs));
    timer.unref();
  }
  return stop;
}

/**
 * Close the startup gap between the watcher's first read and its next poll.
 * The caller invokes this with the state returned by the atomic
 * markBackgroundJobRunning transition, immediately before it could dispatch
 * any work.
 */
export function throwIfDurableCancellationRequested(
  job: Pick<JobStatus, "job_id">,
  controller: AbortController,
  session: DurableSessionState,
): void {
  const control = session.control;
  if (control?.status !== "cancel_requested" || (control.job_id && control.job_id !== job.job_id)) {
    return;
  }
  const reason = control.reason ?? "session_cancelled";
  controller.abort(reason);
  const error = new Error(reason);
  error.name = "AbortError";
  throw error;
}

function createRuntime() {
  const config = loadConfig();
  const eventLog = new EventLog(config);
  const holder: { orchestrator?: CrossReviewOrchestrator } = {};
  const emit = (event: RuntimeEvent) => {
    // Stamp once at occurrence time and pass the same timestamp to both
    // sinks.  Previously EventLog and SessionStore independently stamped
    // their copies, so persistence latency could masquerade as event time.
    const stamped = { ...event, ts: event.ts ?? now() };
    eventLog.emit(stamped);
    // Fire-and-forget: appendEvent is async (v4.1.0 proper-lockfile lock)
    // but the emit pipeline must stay sync — callers that need synchronous
    // persistence guarantees should await appendEvent directly. Unhandled
    // rejections are swallowed inside appendEvent.
    void holder.orchestrator?.store.appendEvent(stamped);
  };
  const orchestrator = new CrossReviewOrchestrator(config, emit);
  holder.orchestrator = orchestrator;
  return {
    config,
    eventLog,
    orchestrator,
    // v3.3.0: exposed so the caller-peer-selection lock can route audit
    // events through the same emitter the orchestrator uses (eventLog +
    // session-store append). Public so the handler closures below can
    // grab it without re-plumbing the orchestrator's private emit.
    emit,
    jobs: new Map<string, JobStatus>(),
    controllers: new Map<string, AbortController>(),
  };
}

type Runtime = ReturnType<typeof createRuntime>;

function recordIdentityForgeryBlocked(
  runtime: Runtime,
  site: string,
  caller: PeerId | "operator",
  clientInfo: ClientInfo,
  error: unknown,
  session_id?: string,
): void {
  runtime.emit({
    type: "session.identity_forgery_blocked",
    session_id,
    message: "identity_forgery_blocked: caller identity verification failed.",
    data: {
      site,
      caller,
      client_info_name: clientInfo?.name ?? null,
      error: safeErrorMessage(error),
      identity_metadata: getParentProcessSnapshot(),
    },
  });
}

function verifyToolCallerIdentity(
  runtime: Runtime,
  site: string,
  caller: PeerId | "operator",
  clientInfo: ClientInfo,
  session_id?: string,
): CallerIdentityResult {
  try {
    const identity = verifyCallerIdentity(caller, clientInfo);
    runtime.emit({
      type: "session.identity_verified",
      session_id,
      message: "caller identity verification completed.",
      data: {
        site,
        caller,
        identity_verified: identity.identity_verified,
        verification_method: identity.verification_method,
        client_info_name: identity.client_info_name,
        identity_metadata: identity.identity_metadata,
      },
    });
    return identity;
  } catch (error) {
    recordIdentityForgeryBlocked(runtime, site, caller, clientInfo, error, session_id);
    throw error;
  }
}

function verifyOperatorToolCallerIdentity(
  runtime: Runtime,
  site: string,
  caller: PeerId | "operator",
  clientInfo: ClientInfo,
  session_id?: string,
): CallerIdentityResult {
  const identity = verifyToolCallerIdentity(runtime, site, caller, clientInfo, session_id);
  if (caller !== "operator") {
    const error = new Error(
      `operator_authority_required: ${site} mutates authoritative evidence, terminal state, or security configuration and may only be called by the human operator; received caller='${caller}'.`,
    );
    runtime.emit({
      type: "session.operator_authority_blocked",
      session_id,
      message: error.message,
      data: {
        site,
        caller,
        verification_method: identity.verification_method,
        client_info_name: identity.client_info_name,
      },
    });
    throw error;
  }
  if (!identity.identity_verified || identity.verification_method !== "token") {
    const error = new Error(
      `operator_authority_required: ${site} requires a verified dedicated operator capability token.`,
    );
    runtime.emit({
      type: "session.operator_authority_blocked",
      session_id,
      message: error.message,
      data: {
        site,
        caller,
        verification_method: identity.verification_method,
        client_info_name: identity.client_info_name,
      },
    });
    throw error;
  }
  return identity;
}

export function assertSessionMutationAuthority(
  site: string,
  caller: PeerId | "operator",
  identity: CallerIdentityResult,
  sessionOwner: PeerId | "operator" | null,
): void {
  if (caller === "operator") {
    if (identity.identity_verified && identity.verification_method === "token") return;
    throw new Error(
      `operator_authority_required: ${site} requires the dedicated verified operator capability token.`,
    );
  }
  if (!identity.identity_verified || identity.verification_method !== "token") {
    throw new Error(
      `session_owner_token_required: ${site} requires the verified capability token for session petitioner '${sessionOwner}'.`,
    );
  }
  if (sessionOwner === null) {
    throw new Error(
      `session_owner_unverified: ${site} cannot derive an explicit persisted petitioner for this legacy session; the dedicated operator token is required.`,
    );
  }
  if (caller !== sessionOwner) {
    throw new Error(
      `session_owner_mismatch: ${site} may be called only by session petitioner '${sessionOwner}' or the human operator; received caller='${caller}'.`,
    );
  }
}

export function hasTrustedPetitionerProvenance(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = version.match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
  );
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  // Petitioner and acting-peer provenance became durable and distinct in
  // v2.16. Older sessions may later acquire a petitioner field derived from
  // historically ambiguous `caller` metadata, so presence alone is not proof.
  return major > 2 || (major === 2 && minor >= 16);
}

function verifySessionMutationAuthority(
  runtime: Runtime,
  site: string,
  caller: PeerId | "operator",
  clientInfo: ClientInfo,
  sessionId: string,
): CallerIdentityResult {
  const identity = verifyToolCallerIdentity(runtime, site, caller, clientInfo, sessionId);
  const session = runtime.orchestrator.store.read(sessionId);
  const sessionOwner = hasTrustedPetitionerProvenance(session.version)
    ? (session.convergence_scope?.petitioner ?? session.caller)
    : null;
  try {
    assertSessionMutationAuthority(site, caller, identity, sessionOwner);
    return identity;
  } catch (error) {
    runtime.emit({
      type: "session.session_authority_blocked",
      session_id: sessionId,
      message: safeErrorMessage(error),
      data: {
        site,
        caller,
        session_owner: sessionOwner,
        verification_method: identity.verification_method,
        client_info_name: identity.client_info_name,
      },
    });
    throw error;
  }
}

function installSignalFlushHandlers(runtime: Runtime): void {
  let shuttingDown = false;
  const flushAndExit = (signal: "SIGTERM" | "SIGINT") => {
    if (shuttingDown) return;
    shuttingDown = true;
    const flush = Promise.all([
      runtime.orchestrator.store.flushPendingEvents(),
      runtime.eventLog.flush(),
    ]);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    void Promise.race([flush, timeout])
      .catch((error) => {
        console.error(`[cross-review] ${signal} flush error: ${safeErrorMessage(error)}`);
      })
      .finally(() => {
        console.error(`[cross-review] ${signal} received; pending event flush attempted.`);
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => flushAndExit("SIGTERM"));
  process.on("SIGINT", () => flushAndExit("SIGINT"));
}

function now(): string {
  return new Date().toISOString();
}

export function pruneCompletedJobs(jobs: Map<string, JobStatus>, maxCompleted = 500): void {
  const completed = [...jobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
  for (const job of completed.slice(0, Math.max(0, completed.length - maxCompleted))) {
    jobs.delete(job.job_id);
  }
}

function summarizeJobResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && "session" in result) {
    const session = (result as { session?: { session_id?: string; outcome?: string } }).session;
    return {
      session_id: session?.session_id,
      outcome: session?.outcome,
      converged: "converged" in result ? (result as { converged?: boolean }).converged : undefined,
      rounds: "rounds" in result ? (result as { rounds?: number }).rounds : undefined,
    };
  }
  return {};
}

function startJob(
  runtime: Runtime,
  kind: JobKind,
  sessionId: string,
  run: (signal: AbortSignal) => Promise<unknown>,
): JobStatus {
  const controller = new AbortController();
  const job: JobStatus = {
    job_id: crypto.randomUUID(),
    kind,
    session_id: sessionId,
    status: "running",
    started_at: now(),
  };
  runtime.jobs.set(job.job_id, job);
  pruneCompletedJobs(runtime.jobs);
  runtime.controllers.set(job.job_id, controller);
  const stopDurableCancellationWatch = watchDurableCancellation(job, controller, () =>
    runtime.orchestrator.store.read(sessionId),
  );
  void Promise.resolve()
    .then(async () => {
      const persisted = await runtime.orchestrator.store.markBackgroundJobRunning(sessionId, {
        job_id: job.job_id,
        owner_pid: process.pid,
      });
      throwIfDurableCancellationRequested(job, controller, persisted);
      return run(controller.signal);
    })
    .then(async (result) => {
      const persisted = runtime.orchestrator.store.read(sessionId);
      const cancellationWon = durableSessionCancellationWon(persisted, controller.signal.aborted);
      job.status = cancellationWon ? "cancelled" : "completed";
      job.completed_at = now();
      job.result_summary = summarizeJobResult(result);
      runtime.controllers.delete(job.job_id);
      if (cancellationWon) {
        try {
          await runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } catch {
          // The job status remains visible even if a session write fails.
        }
      } else {
        await runtime.orchestrator.store.clearBackgroundJobControl(sessionId, job.job_id);
      }
    })
    .catch(async (error) => {
      let persisted: SessionMeta | undefined;
      try {
        persisted = runtime.orchestrator.store.read(sessionId);
      } catch {
        // Preserve the process-local result when durable state is temporarily unreadable.
      }
      const cancellationWon = persisted
        ? durableSessionCancellationWon(persisted, controller.signal.aborted)
        : controller.signal.aborted;
      job.status = cancellationWon ? "cancelled" : "failed";
      job.completed_at = now();
      job.error = safeErrorMessage(error);
      runtime.controllers.delete(job.job_id);
      try {
        if (cancellationWon) {
          await runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } else if (!shouldEscalateBackgroundJobFailure(persisted)) {
          // The routine already sealed its own terminal failure snapshot.
          // Process-local bookkeeping must not mutate meta/report afterward.
          return;
        } else {
          await runtime.orchestrator.store.clearBackgroundJobControl(sessionId, job.job_id);
          await runtime.orchestrator.store.escalateToOperator(sessionId, {
            reason: `Background job failed: ${job.error}`,
            severity: "critical",
          });
        }
      } catch {
        // Job state remains available even if the session cannot be updated.
      }
    })
    .finally(stopDurableCancellationWatch);
  return job;
}

function runtimeCapabilities(runtime: Runtime): RuntimeCapabilities {
  return {
    stable_release: true,
    api_only: true,
    cli_execution: false,
    durable_sessions: true,
    async_jobs: true,
    cancellation: true,
    restart_recovery: true,
    event_streaming: true,
    token_streaming: runtime.config.streaming.tokens,
    budget_preflight: true,
    // v3.7.3 (operator no-fallback directive 2026-05-14): honest flag —
    // `true` ONLY when the user has explicitly declared fallback models in
    // the central config. The default is NO fallback: a peer whose pinned
    // model is unavailable is retried on the SAME model, then skipped (the
    // round converges on the remaining peers). cross-review never
    // hardcodes a model downgrade — fallback is a deliberate user opt-in.
    model_fallback: Object.values(runtime.config.fallback_models).some(
      (models) => models.length > 0,
    ),
    metrics: true,
  };
}

export async function main(): Promise<void> {
  const runtime = createRuntime();
  // v2.18.0 / F1: initialize the per-host token map (load existing OR
  // generate with mode 0o600). Legacy v1 records are migrated in place by
  // adding a seventh, distinct operator capability. Failure leaves peer
  // clientInfo checks available in permissive mode, but operator calls remain
  // fail-closed because a client name cannot authenticate a human.
  initHostTokensRecord(runtime.config.data_dir);
  const tokensRecord = getHostTokensRecord();
  if (tokensRecord && process.env.CROSS_REVIEW_TEST_QUIET !== "1") {
    process.stderr.write(
      `[cross-review] caller capability tokens loaded from ${tokensRecord.filePath} (generated_at=${tokensRecord.generated_at || "unknown"}; distribute each peer token only to its model host and keep the distinct operator token only in a dedicated human console).\n`,
    );
  } else if (!tokensRecord && process.env.CROSS_REVIEW_TEST_QUIET !== "1") {
    process.stderr.write(
      `[cross-review] caller capability tokens unavailable (failed to load or generate host-tokens.json); peer clientInfo checks remain available but operator tools are disabled fail-closed. Set CROSS_REVIEW_TOKENS_FILE to a writable path or fix data_dir permissions.\n`,
    );
  }
  const server = new McpServer({
    name: "cross-review",
    version: VERSION,
  });
  const toolNames: string[] = [];
  const registerTool: McpServer["registerTool"] = (name, config, callback) => {
    toolNames.push(name);
    return server.registerTool(name, config, callback);
  };
  // v3.7.5 (A2, logs+sessions study 2026-05-15): snapshot the enabled
  // peer set once at boot. Static after config load — `peer_enabled` is
  // env-driven and the runtime does not mutate it. Each lock call
  // passes this into ctx so the audit event only fires when the caller
  // actually overrides the panel (not when the supplied list happens
  // to equal the enabled set).
  const enabledPeersSnapshot: readonly PeerId[] = PEERS.filter(
    (peer) => runtime.config.peer_enabled[peer],
  );

  registerTool(
    "server_info",
    {
      title: "Server Info",
      description:
        "Return runtime information for the API-only Cross Review MCP server, including version, data directory and active security mode.",
      inputSchema: z.object({
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) =>
      textResult(
        {
          name: "cross-review",
          publisher: "LCV Ideas & Software",
          version: VERSION,
          release_date: RELEASE_DATE,
          sponsors_url: "https://cross-review.lcv.dev",
          transport: "stdio",
          api_only: true,
          cli_execution: false,
          stable_release: true,
          capabilities: runtimeCapabilities(runtime),
          tools: toolNames,
          data_dir: runtime.config.data_dir,
          log_file: runtime.eventLog.path(),
          config_load: getFileConfigRuntimeStatus() ?? null,
          config_precedence: [
            "process.env",
            "Windows user environment/registry",
            "central config.json",
            "hardcoded defaults",
          ],
          models: runtime.config.models,
          model_selection: runtime.config.model_selection,
          fallback_models: runtime.config.fallback_models,
          reasoning_effort: runtime.config.reasoning_effort,
          cost_rates: runtime.config.cost_rates,
          cache: runtime.config.cache,
          perplexity: runtime.config.perplexity,
          stub: runtime.config.stub,
          retry_timeout_ms: runtime.config.retry.timeout_ms,
          budget: runtime.config.budget,
          financial_controls: (() => {
            // v3.7.0 (AUDIT-4, Codex super-audit 2026-05-14): readiness
            // is computed over the ENABLED peer subset, not the full
            // PEERS roster. Pre-v3.7.0 a missing rate card for a peer
            // the operator had disabled (CROSS_REVIEW_PEER_<NAME>=off)
            // would falsely report paid_calls_ready=false even though
            // that peer is never called.
            const enabledPeers = PEERS.filter((peer) => runtime.config.peer_enabled[peer]);
            const missingVars = missingFinancialControlVars(runtime.config, enabledPeers, {
              untilStopped: true,
            });
            return {
              paid_calls_ready: missingVars.length === 0,
              missing_variables: missingVars,
              policy:
                "Paid provider calls are blocked until budget ceilings and per-peer USD-per-million rate cards are explicitly configured.",
            };
          })(),
          prompt: runtime.config.prompt,
          max_output_tokens: runtime.config.max_output_tokens,
          max_output_tokens_by_peer: Object.fromEntries(
            PEERS.map((peer) => [peer, maxOutputTokensForPeer(runtime.config, peer)]),
          ),
          streaming: runtime.config.streaming,
          // v2.12.0: judge auto-wire is now a first-class observable. Operators
          // checking `server_info` know whether shadow is collecting data,
          // which peer is rated, and whether a typo invalidated the config.
          // v2.15.1: surface `consensus_peers` and `configured_consensus_peers_raw`
          // so the multi-peer judge configuration (parsed from
          // CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS) is visible
          // here instead of silently invisible despite being honored by the
          // dispatcher. v2.15.0 added the parser but forgot the serialization.
          evidence_judge_autowire: {
            mode: runtime.config.evidence_judge_autowire.mode,
            peer: runtime.config.evidence_judge_autowire.peer ?? null,
            active: runtime.config.evidence_judge_autowire.active,
            max_items_per_pass: runtime.config.evidence_judge_autowire.max_items_per_pass,
            configured_mode_raw: runtime.config.evidence_judge_autowire.configured_mode_raw,
            configured_peer_raw: runtime.config.evidence_judge_autowire.configured_peer_raw,
            consensus_peers: runtime.config.evidence_judge_autowire.consensus_peers,
            configured_consensus_peers_raw:
              runtime.config.evidence_judge_autowire.configured_consensus_peers_raw,
          },
          // v2.14.0: per-peer enable/disable surface. Operators inspecting
          // server_info see the resolved enabled/disabled state of each peer.
          peer_enabled: runtime.config.peer_enabled,
          peers_enabled_count: Object.values(runtime.config.peer_enabled).filter(Boolean).length,
          // v2.18.0 / F1: caller capability tokens status. Surfaces (a)
          // whether host-tokens.json is loaded (operators confirm gate is
          // armed without reading the file), (b) the file path so the
          // operator can locate secrets to distribute, (c) hard-enforce
          // mode flag, (d) generated_at timestamp for rotation audit.
          caller_tokens: {
            loaded: getHostTokensRecord() !== null,
            file_path: getHostTokensRecord()?.filePath ?? null,
            generated_at: getHostTokensRecord()?.generated_at ?? null,
            hard_enforce: isHardEnforceMode(),
            agents: getHostTokensRecord() ? [...PEERS] : [],
            operator_capability_loaded: Boolean(getHostTokensRecord()?.map.operator),
            operator_capability_required: true,
            identities: getHostTokensRecord() ? Object.keys(getHostTokensRecord()?.map ?? {}) : [],
          },
          codeql_policy:
            "Repository policy: committed Advanced CodeQL workflow (.github/workflows/codeql.yml, security-extended); avoid duplicate Default Setup.",
          secrets_policy: "API keys are read from Windows environment variables only.",
        },
        response_format,
      ),
  );

  registerTool(
    "runtime_capabilities",
    {
      title: "Runtime Capabilities",
      description:
        "Return the stable cross-review runtime capability contract and active tool list.",
      inputSchema: z.object({
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) =>
      textResult(
        {
          name: "cross-review",
          version: VERSION,
          release_date: RELEASE_DATE,
          capabilities: runtimeCapabilities(runtime),
          tools: toolNames,
        },
        response_format,
      ),
  );

  registerTool(
    "probe_peers",
    {
      title: "Probe Peers",
      description:
        "Query official provider APIs to discover available models for the current API keys, select the highest-capability documented model, and verify provider reachability.",
      inputSchema: z.object({
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ response_format }) =>
      textResult(await runtime.orchestrator.probeAll(), response_format),
  );

  registerTool(
    "session_init",
    {
      title: "Initialize Session",
      description:
        "Create a durable cross-review session after probing provider availability and model selection. This does not call reviewer models yet.",
      inputSchema: z.object({
        task: z.string().min(1).describe("Original task or artifact being reviewed."),
        review_focus: ReviewFocusSchema,
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ task, review_focus, caller, response_format }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      verifyToolCallerIdentity(runtime, "session_init", caller, server.server.getClientVersion());
      const meta = await runtime.orchestrator.initSession(task, caller, review_focus);
      return response_format === "markdown"
        ? textResult(sessionInitMarkdown(meta), "markdown")
        : textResult(meta, response_format);
    },
  );

  registerTool(
    "session_list",
    {
      title: "List Sessions",
      description:
        "List durable sessions saved under the local data directory. The default response is paginated and summary-only to keep stdio transports bounded; use session_read for one full session or detail='full' for a bounded page of full metadata.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSION_LIST_MAX_LIMIT)
          .default(SESSION_LIST_DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
        outcome_filter: SessionListOutcomeFilterSchema,
        detail: SessionListDetailSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, offset, outcome_filter, detail, response_format }) =>
      textResult(
        sessionListPayload(
          runtime.orchestrator.store.list(),
          limit,
          offset,
          outcome_filter,
          detail,
        ),
        response_format,
      ),
  );

  registerTool(
    "session_read",
    {
      title: "Read Session",
      description: "Read a durable session meta.json by session_id.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) =>
      textResult(runtime.orchestrator.store.read(session_id), response_format),
  );

  registerTool(
    "ask_peers",
    {
      title: "Ask Peers",
      description:
        "Run a real API review round against selected peers. Runtime default uses real provider APIs; stubs run only when CROSS_REVIEW_STUB=1.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        draft: z.string().min(1).max(SCHEMA_DRAFT_MAX_CHARS),
        evidence: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        caller: CallerSchema.default("operator"),
        caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
        peers: z
          .array(PeerSchema)
          .min(0)
          // v3.7.0 (AUDIT-3, Codex super-audit 2026-05-14): PEERS has 6
          // entries since v3.0.0 (Perplexity) — `.max(5)` was a stale
          // regression that rejected an explicit full 6-peer panel
          // before the v3.3.0 peer-selection lock could act, and the
          // emitted JSON Schema announced maxItems:5 contradicting the
          // 6-element default. `.max(PEERS.length)` tracks the roster.
          .max(PEERS.length)
          .default([...PEERS] as PeerId[]),
        reasoning_effort_overrides: ReasoningEffortOverridesSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      if (input.session_id) {
        verifySessionMutationAuthority(
          runtime,
          "ask_peers",
          input.caller,
          server.server.getClientVersion(),
          input.session_id,
        );
      } else {
        verifyToolCallerIdentity(
          runtime,
          "ask_peers",
          input.caller,
          server.server.getClientVersion(),
        );
      }
      // v3.3.0: caller peer-selection lock — silently strips
      // caller-supplied `peers` (and, for peer callers, `lead_peer`) and
      // emits an audit event for the operator. See lockCallerPeerSelection
      // for the full rationale.
      const locked = lockCallerPeerSelection(input, {
        site: "ask_peers",
        emit: runtime.emit,
        enabledPeers: enabledPeersSnapshot,
      });
      const askPeersOut = await runtime.orchestrator.askPeers(locked);
      // v3.6.0 (B3 + B4): surface relator-non-voting + peer-lock notices.
      return textResult(
        { ...askPeersOut, notices: buildResponseNotices(input, askPeersOut, enabledPeersSnapshot) },
        response_format,
      );
    },
  );

  registerTool(
    "session_start_round",
    {
      title: "Start Review Round",
      description:
        "Start a real peer-review round in the background and return immediately with a session_id/job_id for polling.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        draft: z.string().min(1).max(SCHEMA_DRAFT_MAX_CHARS),
        evidence: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        caller: CallerSchema.default("operator"),
        caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
        peers: z
          .array(PeerSchema)
          .min(0)
          // v3.7.0 (AUDIT-3, Codex super-audit 2026-05-14): PEERS has 6
          // entries since v3.0.0 (Perplexity) — `.max(5)` was a stale
          // regression that rejected an explicit full 6-peer panel
          // before the v3.3.0 peer-selection lock could act, and the
          // emitted JSON Schema announced maxItems:5 contradicting the
          // 6-element default. `.max(PEERS.length)` tracks the roster.
          .max(PEERS.length)
          .default([...PEERS] as PeerId[]),
        reasoning_effort_overrides: ReasoningEffortOverridesSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      if (input.session_id) {
        verifySessionMutationAuthority(
          runtime,
          "session_start_round",
          input.caller,
          server.server.getClientVersion(),
          input.session_id,
        );
      } else {
        verifyToolCallerIdentity(
          runtime,
          "session_start_round",
          input.caller,
          server.server.getClientVersion(),
        );
      }
      // v3.3.0: caller peer-selection lock.
      const locked = lockCallerPeerSelection(input, {
        site: "session_start_round",
        emit: runtime.emit,
        enabledPeers: enabledPeersSnapshot,
      });
      const session = locked.session_id
        ? runtime.orchestrator.store.read(locked.session_id)
        : await runtime.orchestrator.initSession(locked.task, locked.caller, locked.review_focus);
      const job = startJob(runtime, "ask_peers", session.session_id, (signal) =>
        runtime.orchestrator.askPeers({ ...locked, session_id: session.session_id, signal }),
      );
      return textResult(
        {
          session_id: session.session_id,
          job,
          poll_tool: "session_poll",
          events_tool: "session_events",
          // v3.6.0 (B4): peer-lock notice surfaces at job start; the
          // relator-non-voting notice (B3) surfaces later via session_poll
          // once the round resolves convergence_scope.
          notices: buildResponseNotices(input, {}, enabledPeersSnapshot),
        },
        response_format,
      );
    },
  );

  registerTool(
    "run_until_unanimous",
    {
      title: "Run Until Unanimous",
      description:
        "Generate or revise a draft and continue real API peer-review rounds until unanimous READY or the configured max_rounds is reached. v2.11.0: when `caller` is set to a peer id (claude|codex|gemini|deepseek|grok|perplexity), the relator lottery activates: omit `lead_peer` to have the server randomly select a non-caller peer as relator (modeled on judicial colegiados), or supply an explicit `lead_peer` that is NOT the caller. An explicit `lead_peer === caller` is rejected at the server with `caller_cannot_be_lead_peer` — an agent never reviews itself (workspace HARD GATE).",
      inputSchema: z.object({
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        initial_draft: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        // v2.11.0: lead_peer is now optional. When omitted with a peer
        // caller, the relator lottery picks one. When omitted with an
        // operator caller, the orchestrator uses "codex" if it is enabled,
        // else the first enabled session peer (v3.7.1 / AUDIT-4: comment
        // refreshed — v3.7.0 / AUDIT-2 replaced the pre-v3.7.0 hardcoded
        // "codex" that ignored peer_enabled).
        lead_peer: PeerSchema.optional(),
        // v2.11.0: caller identifies the petitioner for the lottery.
        // Default "operator" preserves v2.10.0 behavior (no exclusion).
        caller: CallerSchema.default("operator"),
        peers: z
          .array(PeerSchema)
          .min(0)
          // v3.7.0 (AUDIT-3, Codex super-audit 2026-05-14): PEERS has 6
          // entries since v3.0.0 (Perplexity) — `.max(5)` was a stale
          // regression that rejected an explicit full 6-peer panel
          // before the v3.3.0 peer-selection lock could act, and the
          // emitted JSON Schema announced maxItems:5 contradicting the
          // 6-element default. `.max(PEERS.length)` tracks the roster.
          .max(PEERS.length)
          .default([...PEERS] as PeerId[]),
        max_rounds: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(8)
          .describe("Hard review-round ceiling unless allow_auto_extension is explicitly true."),
        allow_auto_extension: z
          .boolean()
          .default(false)
          .describe(
            "Opt in to at most two evidence-only auto-extensions. False keeps max_rounds rigid.",
          ),
        until_stopped: z.boolean().default(false),
        max_cost_usd: z.number().positive().optional(),
        reasoning_effort_overrides: ReasoningEffortOverridesSchema,
        // v2.13.0: ship vs review intent. `ship` (default) — initial_draft
        // is the artifact under refinement; lead_peer produces a NEW
        // REVISED VERSION as prose. `review` — initial_draft is the
        // review subject; lead may emit structured responses.
        // Disambiguates the v2.12 lead_peer meta-review drift bug
        // when the `task` field is phrased as a review act
        // ("Review v..."). See session.lead_drift_detected event.
        // v2.25.0: `circular` joins as a third mode — serial deliberative
        // custody (imported from maestro-app). Caller submits the artifact;
        // rotator-of-the-round either approves unchanged or revises;
        // convergence = full rotation completes without substantive change.
        // No parallel peer-voting in circular mode. Best for producing
        // shared prose/spec artifacts. For approve/reject judgments over
        // external code, prefer ship (default) or review.
        mode: z.enum(["ship", "review", "circular"]).default("ship"),
        // v3.5.0 (CRV2-4): optional structured evidence supplied up-front.
        // The preflight checks value correspondence with every operational
        // claim; presence alone is never proof. Peer material is persisted,
        // hashed and transported as unverified review evidence without a
        // manual operator attachment step.
        evidence: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      verifyToolCallerIdentity(
        runtime,
        "run_until_unanimous",
        input.caller,
        server.server.getClientVersion(),
      );
      // v3.3.0: caller peer-selection lock — peers panel always full
      // enabled set; lead_peer ignored for peer callers (forced lottery).
      const locked = lockCallerPeerSelection(input, {
        site: "run_until_unanimous",
        emit: runtime.emit,
        enabledPeers: enabledPeersSnapshot,
      });
      const runOut = await runtime.orchestrator.runUntilUnanimous(locked);
      // v3.6.0 (B3 + B4): surface relator-non-voting + peer-lock notices.
      return textResult(
        { ...runOut, notices: buildResponseNotices(input, runOut, enabledPeersSnapshot) },
        response_format,
      );
    },
  );

  registerTool(
    "session_start_unanimous",
    {
      title: "Start Until Unanimous",
      description:
        "Start real API generation/revision rounds in the background until unanimity, max_rounds or budget limit. v2.11.0: same `caller` + relator-lottery semantics as `run_until_unanimous` — see that tool for details.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        initial_draft: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        lead_peer: PeerSchema.optional(),
        caller: CallerSchema.default("operator"),
        peers: z
          .array(PeerSchema)
          .min(0)
          // v3.7.0 (AUDIT-3, Codex super-audit 2026-05-14): PEERS has 6
          // entries since v3.0.0 (Perplexity) — `.max(5)` was a stale
          // regression that rejected an explicit full 6-peer panel
          // before the v3.3.0 peer-selection lock could act, and the
          // emitted JSON Schema announced maxItems:5 contradicting the
          // 6-element default. `.max(PEERS.length)` tracks the roster.
          .max(PEERS.length)
          .default([...PEERS] as PeerId[]),
        max_rounds: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(8)
          .describe("Hard review-round ceiling unless allow_auto_extension is explicitly true."),
        allow_auto_extension: z
          .boolean()
          .default(false)
          .describe(
            "Opt in to at most two evidence-only auto-extensions. False keeps max_rounds rigid.",
          ),
        until_stopped: z.boolean().default(false),
        max_cost_usd: z.number().positive().optional(),
        reasoning_effort_overrides: ReasoningEffortOverridesSchema,
        // v2.13.0: see run_until_unanimous for `mode` semantics.
        // v2.25.0: `circular` joins as a third mode — serial deliberative
        // custody (imported from maestro-app). Caller submits the artifact;
        // rotator-of-the-round either approves unchanged or revises;
        // convergence = full rotation completes without substantive change.
        // No parallel peer-voting in circular mode. Best for producing
        // shared prose/spec artifacts. For approve/reject judgments over
        // external code, prefer ship (default) or review.
        mode: z.enum(["ship", "review", "circular"]).default("ship"),
        // v3.5.0 (CRV2-4): optional structured evidence supplied up-front.
        // The preflight checks value correspondence with every operational
        // claim; presence alone is never proof. Peer material is persisted,
        // hashed and transported as unverified review evidence without a
        // manual operator attachment step.
        evidence: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      if (input.session_id) {
        verifySessionMutationAuthority(
          runtime,
          "session_start_unanimous",
          input.caller,
          server.server.getClientVersion(),
          input.session_id,
        );
      } else {
        verifyToolCallerIdentity(
          runtime,
          "session_start_unanimous",
          input.caller,
          server.server.getClientVersion(),
        );
      }
      // v3.3.0: caller peer-selection lock.
      const locked = lockCallerPeerSelection(input, {
        site: "session_start_unanimous",
        emit: runtime.emit,
        enabledPeers: enabledPeersSnapshot,
      });
      // v2.16.0: the durable session caller is always the petitioner,
      // never the relator. Older code used lead_peer as caller for some
      // operator-started unanimous jobs, which polluted audits with
      // caller/lead conflation. Relator identity belongs in
      // convergence_scope.lead_peer after runUntilUnanimous resolves it.
      const initCaller = locked.caller;
      const session = locked.session_id
        ? runtime.orchestrator.store.read(locked.session_id)
        : await runtime.orchestrator.initSession(locked.task, initCaller, locked.review_focus);
      const job = startJob(runtime, "run_until_unanimous", session.session_id, (signal) =>
        runtime.orchestrator.runUntilUnanimous({
          ...locked,
          session_id: session.session_id,
          signal,
        }),
      );
      return textResult(
        {
          session_id: session.session_id,
          job,
          poll_tool: "session_poll",
          events_tool: "session_events",
          // v3.6.0 (B4): peer-lock notice at job start; relator-non-voting
          // notice (B3) surfaces via session_poll once the round resolves.
          notices: buildResponseNotices(input, {}, enabledPeersSnapshot),
        },
        response_format,
      );
    },
  );

  registerTool(
    "session_cancel_job",
    {
      title: "Cancel Session Job",
      description:
        "Request cancellation for running background jobs in a durable session. The reason accepts at most 300 characters. Requires the verified capability token of the persisted session petitioner, or the dedicated operator token; another peer cannot cancel the job. Provider calls receive AbortSignal where the provider client supports it.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        job_id: SessionIdSchema.optional(),
        reason: z.string().min(1).max(300).default("requester_requested"),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, job_id, reason, caller, response_format }) => {
      verifySessionMutationAuthority(
        runtime,
        "session_cancel_job",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      const jobs = [...runtime.jobs.values()].filter(
        (job) =>
          job.session_id === session_id &&
          job.status === "running" &&
          (!job_id || job.job_id === job_id),
      );
      const session = runtime.orchestrator.store.read(session_id);
      const durableExecutionActive = durableSessionExecutionActive(session);
      if (!jobs.length && !durableExecutionActive) {
        return textResult(
          {
            session_id,
            requested: false,
            reason: "no_running_job_matched",
            matched_jobs: [],
          },
          response_format,
        );
      }
      const meta = await runtime.orchestrator.store.requestCancellation(session_id, reason, job_id);
      for (const job of jobs) {
        runtime.controllers.get(job.job_id)?.abort(reason);
      }
      const durableJob = synthesizeDurableJob(meta, jobs);
      return textResult(
        {
          session_id,
          requested: true,
          matched_jobs: jobs,
          durable_execution: durableJob,
          control: meta.control,
        },
        response_format,
      );
    },
  );

  registerTool(
    "session_recover_interrupted",
    {
      title: "Recover Interrupted Sessions",
      description:
        "Mark unfinished sessions with stale in-flight rounds as recovered after a MCP host restart so they can be resumed explicitly.",
      inputSchema: z.object({
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caller, response_format }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_recover_interrupted",
        caller,
        server.server.getClientVersion(),
      );
      const active = new Set(
        [...runtime.jobs.values()]
          .filter((job) => job.status === "running")
          .map((job) => job.session_id),
      );
      return textResult(
        {
          recovered: await runtime.orchestrator.store.recoverInterruptedSessions(active),
        },
        response_format,
      );
    },
  );

  registerTool(
    "session_poll",
    {
      title: "Poll Session",
      description:
        "Return durable session state and background job status without waiting for provider calls to finish.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const localJobs = [...runtime.jobs.values()].filter((job) => job.session_id === session_id);
      const durableJob = synthesizeDurableJob(session, localJobs);
      const jobs = durableJob ? [...localJobs, durableJob] : localJobs;
      // v3.6.0 (B1, logs+sessions study): `needs_attention` — derived
      // convenience flag. The 169-session corpus showed 28 non-terminal
      // sessions (5 open + 9 stale + 14 blocked), many abandoned by the
      // caller until the 24h sweep aborted them. This flag is true when
      // the session has no terminal `outcome` AND its health is stale or
      // blocked AND there is no running job — i.e. it is sitting
      // un-finalized with nothing in flight and needs the caller/operator
      // workflow to continue, contest, cancel, or finalize it.
      const hasRunningJob = jobs.some((job) => job.status === "running");
      const healthState = session.convergence_health?.state;
      const needsAttention =
        !session.outcome &&
        !hasRunningJob &&
        (healthState === "stale" || healthState === "blocked");
      // v3.6.0 (B3): relator-non-voting notice surfaced on poll, so an
      // async caller that started via session_start_round /
      // session_start_unanimous sees it once convergence_scope resolves.
      const scope = session.convergence_scope;
      const notices: string[] = [];
      if (scope?.lead_peer && scope.lead_peer_role === "relator_non_voting") {
        const voters = (scope.voting_peers ?? scope.reviewer_peers ?? []).join(", ");
        notices.push(
          `relator_non_voting: \`${scope.lead_peer}\` is the lottery-selected relator — it authors/revises the ` +
            `artifact and is DELIBERATELY excluded from the voting colegiado (anti-self-review HARD GATE). ` +
            `Voting peers: ${voters || "(none)"}. This is by design, not a dropped peer.`,
        );
      }
      if (needsAttention) {
        notices.push(
          `needs_attention: this session is non-terminal (outcome=null), health=${healthState}, and has no ` +
            `running job — finalize, contest, continue, or cancel it. The 24h stale-session sweep is only a backstop.`,
        );
      }
      return textResult(
        {
          session_id,
          outcome: session.outcome,
          health: session.convergence_health,
          in_flight: session.in_flight,
          generation_in_flight: session.generation_in_flight,
          rounds: session.rounds.length,
          latest_round: session.rounds.at(-1) ?? null,
          jobs,
          control: session.control,
          needs_attention: needsAttention,
          notices,
        },
        response_format,
      );
    },
  );

  registerTool(
    "session_metrics",
    {
      title: "Session Metrics",
      description:
        "Return aggregate observability metrics across all sessions, or only one session when session_id is provided.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) =>
      textResult(runtime.orchestrator.store.metrics(session_id), response_format),
  );

  registerTool(
    "session_peer_reliability_report",
    {
      title: "Peer Reliability Report",
      description:
        "Read-only per-peer reliability telemetry: READY/NEEDS_EVIDENCE/NOT_READY counts, parser warnings, provider errors, unresolved evidence asks, fabrication events, latency and cost. Observational only; does not change peer selection or mutate sessions.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) =>
      textResult(runtime.orchestrator.store.peerReliabilityReport(session_id), response_format),
  );

  registerTool(
    "session_doctor",
    {
      title: "Session Doctor",
      description:
        'Operational audit across durable sessions: open/stale/blocked cases, legacy self-lead metadata, open evidence asks (with per-peer item type drill-down + chronic blockers since v2.22), Grok provider errors, and token-event noise. Read-only by default (does not modify sessions). Terminal max-rounds and terminal not_resurfaced history stay in totals but are not default operational findings; pass include_terminal_findings=true to enumerate that historical inventory. Pass include_legacy=true to enumerate per-session self_lead_metadata entries (hidden by default since v2.22 because pre-v2.16 sessions carry the legacy artifact at ~38% rate; totals.self_lead_metadata count is always visible). v3.6.0: pass repair=true (opt-in) to recompute convergence_health for sessions stuck in the contradictory outcome="converged"+health="blocked" state left by pre-v3.2.0 corruption — only that specific contradiction is touched, only when explicitly requested; the `repaired` array lists what was fixed.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        // v2.22.0 (A.P2): opt-in enumeration of legacy self_lead_metadata
        // entries. Defaults to false; the headline count in totals stays
        // visible even when the array is suppressed.
        include_legacy: z.boolean().optional(),
        // v3.6.0 (C): opt-in repair pass. Default false keeps the tool
        // strictly read-only. When true, the contradictory
        // outcome="converged"+health="blocked" state (pre-v3.2.0
        // corruption artifact) has convergence_health recomputed from the
        // latest round; the `repaired` array reports what changed.
        repair: z.boolean().optional(),
        // v4.4.6: opt-in enumeration of terminal max-rounds and
        // terminal not_resurfaced historical inventory. Defaults false
        // so findings stay action-oriented while totals remain complete.
        include_terminal_findings: z.boolean().optional(),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        // v3.6.0: no longer unconditionally read-only — repair=true
        // mutates sessions, so readOnlyHint must be false.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      limit,
      include_legacy,
      repair,
      include_terminal_findings,
      caller,
      response_format,
    }) => {
      if (repair) {
        verifyOperatorToolCallerIdentity(
          runtime,
          "session_doctor.repair",
          caller,
          server.server.getClientVersion(),
        );
      } else {
        verifyToolCallerIdentity(
          runtime,
          "session_doctor",
          caller,
          server.server.getClientVersion(),
        );
      }
      return textResult(
        await runtime.orchestrator.store.sessionDoctor(
          limit,
          include_legacy ?? false,
          repair ?? false,
          include_terminal_findings ?? false,
        ),
        response_format,
      );
    },
  );

  registerTool(
    "session_events",
    {
      title: "Read Session Events",
      description:
        "Read durable session events from events.ndjson. Use since_seq to incrementally poll long-running sessions.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        since_seq: z.number().int().min(0).default(0),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, since_seq, response_format }) =>
      textResult(
        {
          session_id,
          events: runtime.orchestrator.store.readEvents(session_id, since_seq),
        },
        response_format,
      ),
  );

  registerTool(
    "session_report",
    {
      title: "Session Report",
      description:
        "Generate and save a Markdown report with convergence, peer decisions, failures, costs and latest events.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const markdown = sessionReportMarkdown(
        session,
        runtime.orchestrator.store.readEvents(session_id),
      );
      const path = runtime.orchestrator.store.saveReport(session_id, markdown);
      return response_format === "markdown"
        ? textResult(markdown, "markdown")
        : textResult({ session_id, path, markdown }, response_format);
    },
  );

  registerTool(
    "session_check_convergence",
    {
      title: "Check Convergence",
      description:
        "Return the latest durable convergence state, health and scope for a saved session without calling providers.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const latestRound = session.rounds.at(-1);
      return textResult(
        {
          session_id: session.session_id,
          outcome: session.outcome,
          outcome_reason: session.outcome_reason,
          convergence: latestRound?.convergence ?? null,
          convergence_health: session.convergence_health,
          convergence_scope: session.convergence_scope,
          in_flight: session.in_flight,
          generation_in_flight: session.generation_in_flight,
          failed_attempts: session.failed_attempts ?? [],
        },
        response_format,
      );
    },
  );

  const savedSessionPreflightSchema = z.object({
    session_id: SessionIdSchema,
    task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS).optional(),
    draft: z.string().min(1).max(SCHEMA_DRAFT_MAX_CHARS).optional(),
    evidence: z.string().min(1).max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
    caller: CallerSchema.default("operator"),
    response_format: ResponseFormatSchema,
  });
  const savedSessionPreflightHandler =
    (site: "session_preflight_check" | "session_truthfulness_preflight_check") =>
    async ({
      session_id,
      task,
      draft,
      evidence,
      caller,
      response_format,
    }: z.infer<typeof savedSessionPreflightSchema>) => {
      verifyToolCallerIdentity(runtime, site, caller, server.server.getClientVersion(), session_id);
      const session = runtime.orchestrator.store.read(session_id);
      const latestDraftPath = session.rounds.at(-1)?.draft_file;
      let effectiveDraft = draft;
      if (!effectiveDraft && latestDraftPath) {
        effectiveDraft = runtime.orchestrator.store.readTextArtifact(
          session_id,
          latestDraftPath,
          SCHEMA_DRAFT_MAX_CHARS,
        );
      }
      const result = runtime.orchestrator.checkSessionPreflights({
        sessionId: session_id,
        task: task ?? session.task,
        draft: effectiveDraft,
        evidence,
        caller,
      });
      const truthfulness = result.truthfulness.result;
      const evidenceResult = result.evidence.result;
      return textResult(
        {
          session_id: session.session_id,
          used_task_source: task ? "input" : "session",
          used_draft_source: draft ? "input" : latestDraftPath ? latestDraftPath : null,
          pass: result.pass,
          reason: result.pass
            ? "all enabled submission preflights passed"
            : `submission blocked by preflight gate(s): ${result.blocking_gates.join(", ")}`,
          blocking_gates: result.blocking_gates,
          truthfulness_pass: result.truthfulness.pass,
          evidence_pass: result.evidence.pass,
          truthfulness: result.truthfulness,
          evidence: result.evidence,
          // Legacy truthfulness fields remain additive for existing clients.
          issue_classes: truthfulness?.issue_classes ?? [],
          current_state_claim_matched: truthfulness?.current_state_claim_matched ?? false,
          historical_state_claim_matched: truthfulness?.historical_state_claim_matched ?? false,
          contradictions: truthfulness?.contradictions ?? [],
          unsupported_claims: truthfulness?.unsupported_claims ?? [],
          structured_evidence_supplied:
            truthfulness?.structured_evidence_supplied ??
            evidenceResult?.structured_evidence_supplied ??
            false,
          attachments_present:
            result.reviewable_attachment_count > 0 || result.operator_verified_attachment_count > 0,
          attached_evidence_count: result.reviewable_attachment_count,
          operator_verified_evidence_count: result.operator_verified_attachment_count,
          evidence_files: session.evidence_files ?? [],
          source_marker_found: truthfulness?.source_marker_found ?? false,
          runtime_facts_available: truthfulness?.runtime_facts_available ?? true,
        },
        response_format,
      );
    };

  registerTool(
    "session_preflight_check",
    {
      title: "Check Submission Preflights",
      description:
        "Run the same enabled evidence and truthfulness gates used by a real review round, without calling providers. Peer-submitted inline/structured evidence is checked as review material and requires no manual operator attachment.",
      inputSchema: savedSessionPreflightSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    savedSessionPreflightHandler("session_preflight_check"),
  );

  registerTool(
    "session_truthfulness_preflight_check",
    {
      title: "Check Submission Preflights (Legacy Alias)",
      description:
        "Backward-compatible alias for session_preflight_check. Its top-level pass now reflects both enabled runtime gates, eliminating truthfulness-only false positives.",
      inputSchema: savedSessionPreflightSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    savedSessionPreflightHandler("session_truthfulness_preflight_check"),
  );

  registerTool(
    "session_attach_evidence",
    {
      title: "Attach Evidence",
      description:
        "Persist a text evidence artifact under a durable session evidence directory and register it in session metadata.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        label: z.string().min(1).max(120),
        content: z.string().min(1).max(2_000_000),
        content_type: z.string().min(1).max(120).default("text/plain"),
        extension: z.string().min(1).max(16).default("txt"),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, label, content, content_type, extension, caller, response_format }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_attach_evidence",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.store.attachEvidence(session_id, {
          label,
          content,
          content_type,
          extension,
          attached_by: caller,
          origin: "session_attach_evidence",
        }),
        response_format,
      );
    },
  );

  registerTool(
    "session_evidence_checklist_update",
    {
      title: "Update Evidence Checklist Item Status",
      description:
        "Operator workflow for the v2.7.0 Evidence Broker. Mark a checklist item as 'satisfied' (operator confirms the ask was answered), 'deferred' (out of scope for this session), 'rejected' (ask itself is unfounded), or 'open' (retract a prior terminal status). The 'addressed' status is reserved for runtime auto-promotion (resurfacing inference) and cannot be set via this tool. Every transition is appended to evidence_status_history with the operator's optional note.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        item_id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-f0-9]+$/i, "item_id must be a hex string"),
        status: z.enum(["open", "satisfied", "deferred", "rejected"]),
        note: z.string().min(1).max(2000).optional(),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, item_id, status, note, caller, response_format }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_evidence_checklist_update",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.store.setEvidenceChecklistItemStatus(
          session_id,
          item_id,
          status,
          {
            note,
            by: "operator",
          },
        ),
        response_format,
      );
    },
  );

  registerTool(
    "session_evidence_judge_pass",
    {
      title: "Run Evidence Judge Pass",
      description:
        "Operator-authorized LLM satisfied-detection for the Evidence Broker. Requires the dedicated operator capability token. The configured judge peer reads each currently-open checklist item against the supplied draft and returns a structured judgment; a peer can never judge its own evidence ask. The runtime promotes only items where satisfied=true AND confidence='verified'; everything else stays open. Terminal operator statuses and already-addressed items are never touched. Optional shadow_mode records non-mutating decisions.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        judge_peer: PeerSchema,
        draft: z.string().min(1).max(200_000),
        item_ids: z
          .array(
            z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-f0-9]+$/i, "item_id must be a hex string"),
          )
          .max(64)
          .optional(),
        round: z.number().int().min(1).max(10_000).optional(),
        review_focus: z.string().min(1).max(4000).optional(),
        shadow_mode: z.boolean().optional(),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      session_id,
      judge_peer,
      draft,
      item_ids,
      round,
      review_focus,
      shadow_mode,
      caller,
      response_format,
    }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_evidence_judge_pass",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.runEvidenceChecklistJudgePass({
          session_id,
          judge_peer,
          draft,
          item_ids,
          round,
          review_focus,
          mode: shadow_mode ? "shadow" : "active",
        }),
        response_format,
      );
    },
  );

  // v2.14.0 (item 3): multi-peer judge consensus pass. Fires the judge
  // call against MULTIPLE peers in parallel for each open evidence
  // checklist item; promotes the item ONLY when all configured judge
  // peers agree (unanimous verified-satisfied + non-empty rationale +
  // zero parser_warnings). Reduces single-judge bias risk before
  // operator-wide active-mode autowire is enabled in high-stakes
  // scenarios. Cost-aware: each item costs N peer calls in parallel.
  registerTool(
    "session_evidence_judge_consensus_pass",
    {
      title: "Run Evidence Judge Consensus Pass",
      description:
        "Operator-authorized multi-peer evidence judgment. Requires the dedicated operator capability token and at least two distinct enabled judge peers. A peer is forbidden from ruling on its own evidence ask; any self-judge member makes that item's consensus fail closed. Active mode promotes only unanimous verified-satisfied judgments with non-empty rationales and zero parser warnings; shadow mode never mutates state.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        // v3.7.0 (AUDIT-3): .max(PEERS.length) — same stale-`.max(5)`
        // regression as the `peers` panel; the 6-peer roster (Perplexity
        // since v3.0.0) must be representable in a judge consensus.
        judge_peers: z.array(PeerSchema).min(2).max(PEERS.length),
        draft: z.string().min(1).max(200_000),
        item_ids: z
          .array(
            z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-f0-9]+$/i, "item_id must be a hex string"),
          )
          .max(64)
          .optional(),
        round: z.number().int().min(1).max(10_000).optional(),
        review_focus: z.string().min(1).max(4_000).optional(),
        shadow_mode: z.boolean().optional(),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      session_id,
      judge_peers,
      draft,
      item_ids,
      round,
      review_focus,
      shadow_mode,
      caller,
      response_format,
    }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_evidence_judge_consensus_pass",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.runEvidenceChecklistJudgeConsensusPass({
          session_id,
          judge_peers,
          draft,
          item_ids,
          round,
          review_focus,
          mode: shadow_mode ? "shadow" : "active",
        }),
        response_format,
      );
    },
  );

  // v2.14.0 (item 1): precision/recall/F1 of the shadow judge against
  // empirical ground truth (whether peers raised the same ask in a
  // subsequent round). Walks events.ndjson per session, correlates
  // each `session.evidence_judge_pass.shadow_decision` event with the
  // matching evidence_checklist item by id, and rolls up per
  // judge_peer. Operator-triggered observability — DOES NOT mutate
  // session state; safe to run on any session.
  registerTool(
    "session_judgment_precision_report",
    {
      title: "Judgment Precision Report",
      description:
        "v2.14.0 — compute precision/recall/F1 of the shadow judge against the empirical ground truth (whether peers raised the same ask in a subsequent round). Walks `session.evidence_judge_pass.shadow_decision` events across all sessions (or a single session via session_id, or filtered by judge peer / since timestamp), correlates each decision with the subsequent evidence_checklist resurfacing behavior, and returns per-peer TP/FP/TN/FN counts plus precision/recall/F1. Decisions whose item.last_round equals the judge round AND no later round exists are excluded as 'no ground truth' (we cannot tell if the ask would have come back). Operator uses this to decide whether to flip a peer from shadow to active mode (item 2 / v2.13).",
      inputSchema: z.object({
        peer: PeerSchema.optional(),
        since: z.string().min(1).max(64).optional(),
        session_id: SessionIdSchema.optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ peer, since, session_id, response_format }) =>
      textResult(
        runtime.orchestrator.store.computeJudgmentPrecisionReport({
          peer,
          since,
          session_id,
        }),
        response_format,
      ),
  );

  // v2.14.0 (item 4): tribunal-colegiado contestation. Per the memory
  // `project_cross_review_v2_tribunal_colegiado_model.md`, caller can
  // formally contest a final verdict, opening a new deliberation cycle
  // within the same autos. The original session is preserved (append-
  // only); a new session is initialized with a structural reference
  // back. Petitioner NOT_READY (contesta) → use this tool. Petitioner READY
  // (acata) → notify the human operator, whose dedicated console finalizes.
  registerTool(
    "contest_verdict",
    {
      title: "Contest Verdict",
      description:
        "v2.14.0 — formally contest a final verdict and open a new deliberation cycle. The reason accepts at most 4,000 characters. Requires the verified capability token of the persisted session petitioner, or the dedicated operator token. Petitioner READY (acata) → notify the human operator so the dedicated console can finalize; petitioner NOT_READY (contesta) → contest_verdict. Stamps the original session's meta with a `contestation` record (timestamp + reason + original_outcome + new_session_id) and initializes a NEW session whose `contests_session_id` points back to the contested session, preserving the chain of custody append-only across sessions. The original session must be in a final state (converged/aborted/max-rounds); contesting an in-flight session throws cannot_contest_in_flight_session. Once contested, a session cannot be contested again (chain-of-custody invariant) — contest the LATEST session in the chain.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        reason: z.string().min(1).max(4_000),
        new_task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        new_initial_draft: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        caller: CallerSchema.default("operator"),
        new_caller: CallerSchema.optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      session_id,
      reason,
      new_task,
      new_initial_draft,
      caller,
      new_caller,
      response_format,
    }) => {
      verifySessionMutationAuthority(
        runtime,
        "contest_verdict",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      // Resolve the new caller before entering the store; omitting the field
      // must never trigger a hidden fallback to "operator" in persistence.
      const effectiveNewCaller = new_caller ?? caller;
      if (effectiveNewCaller !== caller) {
        verifyToolCallerIdentity(
          runtime,
          "contest_verdict.new_caller",
          effectiveNewCaller,
          server.server.getClientVersion(),
          session_id,
        );
      }
      return textResult(
        await runtime.orchestrator.store.contestVerdict({
          session_id,
          reason,
          new_task,
          new_initial_draft,
          new_caller: effectiveNewCaller,
        }),
        response_format,
      );
    },
  );

  registerTool(
    "regenerate_caller_tokens",
    {
      title: "Regenerate Caller Tokens (F1)",
      description:
        "Rotate the seven caller capability tokens (six peer identities plus a distinct operator). Requires the current dedicated operator token. The response exposes fingerprints only. Distribute each peer token only to its matching model host; keep the operator token exclusively in a separate human-console MCP host. Never place the operator token in Codex, Claude, Gemini, DeepSeek, Grok or Perplexity host configuration.",
      inputSchema: z.object({
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ caller, response_format }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "regenerate_caller_tokens",
        caller,
        server.server.getClientVersion(),
      );
      const generated = f1GenerateHostTokens(runtime.config.data_dir, {
        overwrite: true,
      });
      if (!generated) {
        throw new Error(
          "regenerate_caller_tokens: failed to write host-tokens.json (no record returned); check data_dir / CROSS_REVIEW_TOKENS_FILE permissions.",
        );
      }
      setHostTokensRecord({
        filePath: generated.filePath,
        map: generated.map,
        generated_at: generated.generated_at,
      });
      const token_fingerprints = Object.fromEntries(
        Object.entries(generated.map).map(([agent, token]) => [
          agent,
          crypto.createHash("sha256").update(token).digest("hex").slice(0, 16),
        ]),
      );
      return textResult(
        {
          ok: true,
          file_path: generated.filePath,
          generated_at: generated.generated_at,
          token_fingerprints,
          next_steps: [
            "Read host-tokens.json locally and copy each peer secret only into its matching model host as CROSS_REVIEW_CALLER_TOKEN.",
            "Put the distinct operator secret only in a dedicated human-console MCP host; never expose it to a model host.",
            "Reload the affected MCP hosts so the new env value is picked up.",
            "Stale tokens will start being rejected with identity_forgery_blocked: token does not match any known agent.",
          ],
        },
        response_format,
      );
    },
  );

  registerTool(
    "escalate_to_operator",
    {
      title: "Escalate To Operator",
      description:
        "Record a durable operator escalation for sessions that require human judgment or external intervention. The reason accepts at most 1,000 characters.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        reason: z.string().min(1).max(1000),
        severity: z.enum(["info", "warning", "critical"]).default("warning"),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, reason, severity, caller, response_format }) => {
      verifyToolCallerIdentity(
        runtime,
        "escalate_to_operator",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.store.escalateToOperator(session_id, { reason, severity }),
        response_format,
      );
    },
  );

  registerTool(
    "session_sweep",
    {
      title: "Sweep Idle Sessions",
      description:
        "Finalize unfinished sessions whose metadata has been idle for at least 24 hours. The terminal reason accepts at most 200 characters. v3.7.5 (B1): opt-in `prune_corrupt` also removes stale entries from the corrupt_sessions/ quarantine directory.",
      inputSchema: z.object({
        idle_minutes: z.number().min(1440).max(100_000).default(1440),
        outcome: z.enum(["aborted", "max-rounds"]).default("aborted"),
        reason: z.string().min(1).max(200).default("stale"),
        // v3.7.5 (B1, logs+sessions study 2026-05-15): opt-in
        // quarantine cleanup. Default false → behavior identical to
        // v3.7.4 (returns the SessionMeta[] array). When true, the
        // response wraps the array in `{ swept, pruned_corrupt }` and
        // additionally removes corrupt_sessions/* entries older than
        // `corrupt_min_age_days` (default 30 days).
        prune_corrupt: z.boolean().default(false),
        corrupt_min_age_days: z.number().int().min(1).max(365).default(30),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      idle_minutes,
      outcome,
      reason,
      prune_corrupt,
      corrupt_min_age_days,
      caller,
      response_format,
    }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_sweep",
        caller,
        server.server.getClientVersion(),
      );
      const swept = await runtime.orchestrator.store.sweepIdle(
        idle_minutes * 60_000,
        outcome,
        reason,
      );
      if (!prune_corrupt) {
        return textResult(swept, response_format);
      }
      const pruneReport = runtime.orchestrator.store.pruneCorruptSessions(
        corrupt_min_age_days * 24 * 60 * 60 * 1000,
      );
      return textResult(
        {
          swept,
          pruned_corrupt: {
            threshold_days: corrupt_min_age_days,
            ...pruneReport,
          },
        },
        response_format,
      );
    },
  );

  registerTool(
    "session_finalize",
    {
      title: "Finalize Session",
      description:
        "Operator-only: mark a durable session as converged, aborted or max-rounds with an optional reason of at most 200 characters. Requires the dedicated operator capability token from a separate human-console host.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        outcome: z.enum(["converged", "aborted", "max-rounds"]),
        reason: z.string().max(200).optional(),
        caller: CallerSchema.default("operator"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, outcome, reason, caller, response_format }) => {
      verifyOperatorToolCallerIdentity(
        runtime,
        "session_finalize",
        caller,
        server.server.getClientVersion(),
        session_id,
      );
      return textResult(
        await runtime.orchestrator.store.finalize(session_id, outcome, reason),
        response_format,
      );
    },
  );

  await server.connect(new StdioServerTransport());
  installSignalFlushHandlers(runtime);
  console.error("cross-review running on stdio");

  // v2.27.1 (cold-start hardening): boot-time sweeps + notices are
  // deferred 30s instead of running on `setImmediate`. The Claude Code
  // MCP host has a stricter spawn-to-initialize timeout than other hosts;
  // pre-v2.27.1 the FS walks (4 sweeps × up to 209 session dirs each on
  // a busy operator) plus the boot notices ran on the same event-loop
  // tick as the initialize handshake response, pushing it past Claude
  // Code's threshold while remaining tolerated by Codex CLI / Gemini
  // Code Assist / VS Code / Antigravity / Grok CLI / DeepSeek CLI.
  // Deferring 30s lets the handshake respond in <200 ms while keeping
  // the housekeeping work — it just runs once the operator is idle.
  // 0 ms would also work but a small delay leaves room for an
  // immediate `tools/list` follow-up to also clear before disk I/O.
  const STARTUP_SWEEP_DELAY_MS = 30_000;
  setTimeout(() => {
    try {
      const tmpSweep = runtime.orchestrator.store.sweepOrphanTmpFiles();
      if (tmpSweep.scanned > 0) {
        console.error("[cross-review] startup tmp sweep:", JSON.stringify(tmpSweep));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review] startup tmp sweep error: ${message}`);
    }
  }, STARTUP_SWEEP_DELAY_MS);
  setTimeout(() => {
    void (async () => {
      try {
        const inFlightSweep = await runtime.orchestrator.store.clearStaleInFlight();
        if (inFlightSweep.scanned > 0) {
          console.error("[cross-review] startup in_flight sweep:", JSON.stringify(inFlightSweep));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cross-review] startup in_flight sweep error: ${message}`);
      }
    })();
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.5.0: companion to clearStaleInFlight — abort sessions that the
  // dedicated operator console never finalized. Runs AFTER the in_flight sweep (deferred via
  // setTimeout, same delay so order is preserved by registration order)
  // so a session whose in_flight got cleared this same boot is
  // immediately eligible for staleness review.
  setTimeout(() => {
    void (async () => {
      try {
        const abortSweep = await runtime.orchestrator.store.abortStaleSessions();
        if (abortSweep.scanned > 0) {
          console.error(
            "[cross-review] startup stale-session abort sweep:",
            JSON.stringify(abortSweep),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cross-review] startup stale-session abort sweep error: ${message}`);
      }
    })();
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.27.0: prune finalized sessions older than CROSS_REVIEW_PRUNE_AFTER_DAYS
  // (default 60). Empirically motivated by 534 sessions accumulated by
  // 2026-05-12 inflating sweep + list cost. Disable with PRUNE_AFTER_DAYS=0.
  setTimeout(() => {
    try {
      const envDisable = (process.env.CROSS_REVIEW_PRUNE_AFTER_DAYS ?? "").trim() === "0";
      if (envDisable) return;
      const pruneSweep = runtime.orchestrator.store.pruneOldSessions();
      if (pruneSweep.pruned > 0) {
        console.error("[cross-review] startup prune sweep:", JSON.stringify(pruneSweep));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review] startup prune sweep error: ${message}`);
    }
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.10.0 / v2.12.0: surface judge auto-wire misconfiguration at boot.
  // Per operator request the runtime never throws on a stray env value (a
  // typo must not break a paying review-host); we log a single notice so
  // the operator notices the dead-letter case during real runs. Source of
  // truth is `runtime.config.evidence_judge_autowire` (parsed by
  // loadConfig); this notice no longer re-reads env vars.
  setTimeout(() => {
    const autowire = runtime.config.evidence_judge_autowire;
    if (autowire.mode === "off" && autowire.configured_mode_raw === "") return;
    if (autowire.mode !== "off" && autowire.mode !== "shadow" && autowire.mode !== "active") {
      console.error(
        `[cross-review] notice: CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_MODE="${autowire.configured_mode_raw}" is not recognized; valid values are "off", "shadow" and "active". Auto-wire will be skipped.`,
      );
      return;
    }
    if (autowire.mode === "off") return;
    if (!autowire.active) {
      console.error(
        `[cross-review] notice: CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_MODE=${autowire.mode} is set but CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_PEER ("${autowire.configured_peer_raw}") is missing or not one of codex|claude|gemini|deepseek. ${autowire.mode === "active" ? "Active" : "Shadow"} auto-wire will be skipped per round; configure the peer to enable it.`,
      );
      return;
    }
    if (autowire.mode === "active") {
      // v2.14.0 item 2: WARN loudly when active mode is on. Active
      // mutates session state; operator must have validated the
      // judge_peer's precision via session_judgment_precision_report
      // before flipping. Surface the WARN every boot so an inadvertent
      // env carry-over from a test run is visible.
      console.error(
        `[cross-review] WARN: judge auto-wire active in ACTIVE mode via peer "${autowire.peer}" — verified-satisfied judgments WILL mutate evidence checklist state (markEvidenceItemAddressedByJudge). Run session_judgment_precision_report and confirm the judge's F1 is acceptable before relying on this in production. Set MODE=shadow to revert to non-mutating data collection.`,
      );
      return;
    }
    console.error(
      `[cross-review] notice: judge auto-wire active in SHADOW mode via peer "${autowire.peer}" (max_items_per_pass=${autowire.max_items_per_pass}). Every askPeers round will fire a non-mutating judge pass; events session.evidence_judge_pass.shadow_decision are emitted per item.`,
    );
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.15.0 (item 4A boot warning): when operator configured a
  // CROSS_REVIEW_GROK_REASONING_EFFORT but the chosen model is NOT in
  // the allowlist (Grok 4.5, 4.20 multi-agent and 4.3 accept the field
  // per xAI docs — see GROK_REASONING_EFFORT_MODELS_BOOT_NOTICE below),
  // inform that the value will be ignored at the wire level.
  // Catches misconfigurations early instead of letting the operator
  // assume reasoning intensity is being applied when xAI silently
  // ignores it (or when a future model would reject with 400).
  setTimeout(() => {
    if (!runtime.config.peer_enabled.grok) return;
    const grokModel = runtime.config.models.grok;
    const reasoningSetExplicitly = Boolean(process.env.CROSS_REVIEW_GROK_REASONING_EFFORT);
    if (!reasoningSetExplicitly) return;
    if (GROK_REASONING_EFFORT_MODELS_BOOT_NOTICE.has(grokModel)) return;
    console.error(
      `[cross-review] notice: GrokAdapter — model="${grokModel}" does NOT accept reasoning.effort per xAI docs. CROSS_REVIEW_GROK_REASONING_EFFORT="${process.env.CROSS_REVIEW_GROK_REASONING_EFFORT}" will be IGNORED at the wire level for this model. Use grok-4.5 (default), grok-4.20-multi-agent, or grok-4.3 for explicit control.`,
    );
  }, STARTUP_SWEEP_DELAY_MS);
  // v3.0.0: Perplexity sixth peer — boot notice for reasoning_effort
  // capability. Only `sonar-reasoning-pro` and `sonar-deep-research`
  // accept `reasoning_effort` per Perplexity docs (sonar / sonar-pro
  // ignore the field — no chain-of-thought stage). When the operator
  // configures CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT but the chosen
  // model lacks the capability, surface a stderr notice so the operator
  // sees the dead-letter case during real runs.
  setTimeout(() => {
    if (!runtime.config.peer_enabled.perplexity) return;
    const perplexityModel = runtime.config.models.perplexity;
    const reasoningSetExplicitly = Boolean(process.env.CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT);
    if (!reasoningSetExplicitly) return;
    if (PERPLEXITY_REASONING_EFFORT_MODELS_BOOT_NOTICE.has(perplexityModel)) return;
    console.error(
      `[cross-review] notice: PerplexityAdapter — model="${perplexityModel}" does NOT accept reasoning_effort per Perplexity docs (only sonar-reasoning-pro and sonar-deep-research do). CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT="${process.env.CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT}" will be IGNORED at the wire level for this model. Set CROSS_REVIEW_PERPLEXITY_MODEL=sonar-reasoning-pro (default) to enable explicit reasoning_effort control.`,
    );
  }, STARTUP_SWEEP_DELAY_MS);
}

// v2.15.0: shadow copy of `peers/grok.ts:GROK_REASONING_EFFORT_MODELS`
// for the boot notice. Avoids creating a hard import dependency from
// the server boot path into a peer adapter module. If xAI adds models
// to the reasoning-capable set, both lists must update together.
const GROK_REASONING_EFFORT_MODELS_BOOT_NOTICE: ReadonlySet<string> = new Set([
  "grok-4.5",
  "grok-4.20-multi-agent",
  // v3.7.3 (Codex v3.7.2 parecer, AUDIT-2): this shadow set had drifted
  // from `peers/grok.ts:GROK_REASONING_EFFORT_MODELS`, which has accepted
  // grok-4.3 since v2.18.4 (xAI docs WebFetch-verified 2026-05-07). Kept
  // in sync per the "both lists must update together" contract above.
  "grok-4.3",
]);

// v3.0.0: shadow copy of `peers/perplexity.ts:PERPLEXITY_REASONING_EFFORT_MODELS`
// for the boot notice (same rationale as the GROK_* shadow above — no
// hard import dependency from server boot path into the adapter).
// When Perplexity adds new reasoning-capable models, both lists must
// update together.
const PERPLEXITY_REASONING_EFFORT_MODELS_BOOT_NOTICE: ReadonlySet<string> = new Set([
  "sonar-reasoning-pro",
  "sonar-deep-research",
]);

// v2.4.0 / cross-review R6 follow-up (CI failure 25199679588): guard
// main() so it only runs when this module is invoked as the entry point
// (e.g. `bin/cross-review` or `node dist/src/mcp/server.js`). Without
// the guard, any module that imports a named export from here (the smoke
// suite imports `SessionIdSchema` and `pruneCompletedJobs`) triggers a
// full server boot at import time — and in CI that boot ran with the
// stub flag set but without confirmation, tripping the v2.4.0 P1.1
// fail-fast gate before scripts/smoke.ts could write the confirmation
// env var. Both paths must be canonicalized because Node resolves the ESM
// module through npm's symlink/junction while process.argv[1] can retain the
// linked bin path. A plain path.resolve comparison therefore exits silently
// for legitimate symlinked or junction-backed development entry paths.
export function isMainModule(moduleUrl: string, argvEntry?: string): boolean {
  if (!argvEntry) return false;

  const canonicalPath = (candidate: string): string => {
    try {
      return fs.realpathSync.native(candidate);
    } catch {
      // Preserve the normal direct-entry comparison if an unusual launcher
      // removes or virtualizes the entry path before this module initializes.
      return path.resolve(candidate);
    }
  };

  const moduleFile = canonicalPath(fileURLToPath(moduleUrl));
  const argvFile = canonicalPath(argvEntry);
  return process.platform === "win32"
    ? moduleFile.toLowerCase() === argvFile.toLowerCase()
    : moduleFile === argvFile;
}

const __isMainModule = isMainModule(import.meta.url, process.argv[1]);

if (__isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
