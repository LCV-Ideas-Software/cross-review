#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RELEASE_DATE, VERSION, loadConfig, missingFinancialControlVars } from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { PEERS } from "../core/types.js";
import type { PeerId, RuntimeCapabilities, RuntimeEvent } from "../core/types.js";
import { sessionReportMarkdown } from "../core/reports.js";
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
// required:[<all 5 peers>]}` — non-standard OpenAPI 3.0 (Gemini API
// rejects `propertyNames`) plus a phantom `required` listing all peers
// despite the field being `.optional()`. Flattening to an explicit
// `z.object({codex?, claude?, gemini?, deepseek?, grok?})` produces a
// clean `{type:"object", properties:{...}}` accepted by every host;
// runtime accepts the same `{codex:"high", claude:"low"}` shape.
const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
    "Optional per-peer reasoning_effort overrides for this call. Keys are peer ids (codex|claude|gemini|deepseek|grok|perplexity); missing keys fall back to global config. Useful to dial down expensive peers (e.g. Grok grok-4.20-multi-agent xhigh = 16 agents, or Perplexity sonar-deep-research that bills citation + reasoning + search queries separately) for routine reviews without editing the 7 MCP configs.",
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

// v2.17.0 (operator directive 2026-05-05): identity forgery rejection.
// Pre-v2.17.0, `caller` arrived from input and was trusted unconditionally
// — there was no `clientInfo` capture and no cross-check. An agent (e.g.
// Codex CLI from the operator's terminal) could pass `caller="claude"`
// while its MCP client identified itself as "codex", impersonating Claude
// in tribunal sessions. Empirical evidence: cross-review-v2 session
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
  isHardEnforceMode,
  verifyTokenForCaller,
  type HostTokensRecord,
  type ParentProcessSnapshot,
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
//   1. caller="operator" → human-driven, non-agent identity. Returns
//      identity_verified=false, verification_method="none". Token check is
//      skipped by design — operator is a non-PEER identity, the gate-setter
//      themselves; AI agents cannot forge "I'm not an AI agent" because:
//      (a) F1 cross-review-v2 R2 codex catch hardening: if the calling host
//      carries CROSS_REVIEW_CALLER_TOKEN, it IS an agent host (the token
//      bind is to a specific AI agent's identity). Declaring caller="operator"
//      from such a host is identity forgery and throws. Only HOSTS WITHOUT
//      a token (genuinely human-driven curl/dashboard/stdio) can declare
//      operator. (b) downstream privilege model: operator caller is never
//      added to PEERS panels, never participates in tribunal review, never
//      gets identity_verified=true — verifying code paths that gate on
//      identity_verified or peer-membership are unaffected by operator
//      caller. Hard-enforce mode does NOT apply to operator (the
//      gate-setter is exempt from their own gate by design).
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
  // operator is a non-agent identity; nothing to forge against PEERS list.
  // BUT: if the calling host carries CROSS_REVIEW_CALLER_TOKEN, it IS an
  // agent host (token binds to a specific agent's identity). Declaring
  // operator from such a host is identity forgery — throw.
  if (declaredCaller === "operator") {
    const presented = process.env.CROSS_REVIEW_CALLER_TOKEN;
    if (typeof presented === "string" && presented.trim().length > 0) {
      throw new Error(
        "identity_forgery_blocked: caller='operator' is not permitted from a host that carries CROSS_REVIEW_CALLER_TOKEN. The token binds to a specific AI agent's identity; declaring operator from such a host is a forgery attempt. Either drop the token from the calling host's env (genuine human-driven invocations should not carry an agent token) or pass the actual agent caller that matches the token.",
      );
    }
    return {
      identity_verified: false, // no agent claim made; nothing to verify
      verification_method: "none",
      client_info_name: clientInfo?.name ?? null,
      identity_metadata,
    };
  }
  const candidates = getCallerCandidatesFromClientInfo(clientInfo);
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
    peers?: PeerId[];
    lead_peer?: PeerId;
    caller?: PeerId | "operator";
    session_id?: string;
  },
>(
  input: T,
  ctx: {
    site: "ask_peers" | "session_start_round" | "run_until_unanimous" | "session_start_unanimous";
    emit: (event: RuntimeEvent) => void;
  },
): T {
  const caller: PeerId | "operator" = input.caller ?? "operator";
  // peers panel: locked for ALL callers (including operator). The
  // server-configured `peer_enabled` set is the only knob; operators
  // tune via env vars, not via per-call overrides that callers can
  // exploit.
  const callerSuppliedPeers = Array.isArray(input.peers) ? [...input.peers] : undefined;
  const peerPanelOverridden = !!callerSuppliedPeers && callerSuppliedPeers.length > 0;
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

type JobKind = "ask_peers" | "run_until_unanimous";
export type JobStatus = {
  job_id: string;
  kind: JobKind;
  session_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at?: string;
  error?: string;
  result_summary?: Record<string, unknown>;
};

function createRuntime() {
  const config = loadConfig();
  const eventLog = new EventLog(config);
  const holder: { orchestrator?: CrossReviewOrchestrator } = {};
  const emit = (event: RuntimeEvent) => {
    eventLog.emit(event);
    holder.orchestrator?.store.appendEvent(event);
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
  void run(controller.signal)
    .then((result) => {
      job.status = controller.signal.aborted ? "cancelled" : "completed";
      job.completed_at = now();
      job.result_summary = summarizeJobResult(result);
      runtime.controllers.delete(job.job_id);
      if (controller.signal.aborted) {
        try {
          runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } catch {
          // The job status remains visible even if a session write fails.
        }
      }
    })
    .catch((error) => {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.completed_at = now();
      job.error = safeErrorMessage(error);
      runtime.controllers.delete(job.job_id);
      try {
        if (controller.signal.aborted) {
          runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } else {
          runtime.orchestrator.store.escalateToOperator(sessionId, {
            reason: `Background job failed: ${job.error}`,
            severity: "critical",
          });
        }
      } catch {
        // Job state remains available even if the session cannot be updated.
      }
    });
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
    model_fallback: true,
    metrics: true,
  };
}

const TOOL_NAMES = [
  "server_info",
  "runtime_capabilities",
  "probe_peers",
  "session_init",
  "session_list",
  "session_read",
  "ask_peers",
  "session_start_round",
  "run_until_unanimous",
  "session_start_unanimous",
  "session_cancel_job",
  "session_recover_interrupted",
  "session_poll",
  "session_events",
  "session_metrics",
  "session_doctor",
  "session_report",
  "session_check_convergence",
  "session_attach_evidence",
  "session_evidence_checklist_update",
  "session_evidence_judge_pass",
  "session_evidence_judge_consensus_pass",
  "session_judgment_precision_report",
  "contest_verdict",
  "escalate_to_operator",
  "regenerate_caller_tokens",
  "session_sweep",
  "session_finalize",
] as const;

export async function main(): Promise<void> {
  const runtime = createRuntime();
  // v2.18.0 / F1: initialize the per-host token map (load existing OR
  // generate with mode 0o600). Failure is non-fatal — the v2.17.0
  // clientInfo gate still works for non-migrated hosts. One-shot stderr
  // line on first generation publishes the file path so the operator can
  // distribute the per-agent secrets.
  initHostTokensRecord(runtime.config.data_dir);
  const tokensRecord = getHostTokensRecord();
  if (tokensRecord && process.env.CROSS_REVIEW_V2_TEST_QUIET !== "1") {
    process.stderr.write(
      `[cross-review-v2] F1 caller capability tokens loaded from ${tokensRecord.filePath} (generated_at=${tokensRecord.generated_at || "unknown"}; distribute the per-agent secrets to each MCP host config as CROSS_REVIEW_CALLER_TOKEN to enable verification_method=token; v2.17.0 clientInfo gate remains active as fallback).\n`,
    );
  } else if (!tokensRecord && process.env.CROSS_REVIEW_V2_TEST_QUIET !== "1") {
    process.stderr.write(
      `[cross-review-v2] F1 caller capability tokens unavailable (failed to load or generate host-tokens.json); the v2.17.0 clientInfo identity gate remains active. Set CROSS_REVIEW_TOKENS_FILE to a writable path or fix data_dir permissions to enable token verification.\n`,
    );
  }
  const server = new McpServer({
    name: "cross-review-v2",
    version: VERSION,
  });

  server.registerTool(
    "server_info",
    {
      title: "Server Info",
      description:
        "Return runtime information for the API-only Cross Review MCP server, including version, data directory and active security mode.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
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
          name: "cross-review-v2",
          publisher: "LCV Ideas & Software",
          version: VERSION,
          release_date: RELEASE_DATE,
          sponsors_url: "https://cross-review-v2.lcv.dev",
          transport: "stdio",
          api_only: true,
          cli_execution: false,
          stable_release: true,
          capabilities: runtimeCapabilities(runtime),
          tools: TOOL_NAMES,
          data_dir: runtime.config.data_dir,
          log_file: runtime.eventLog.path(),
          stub: runtime.config.stub,
          retry_timeout_ms: runtime.config.retry.timeout_ms,
          budget: runtime.config.budget,
          financial_controls: {
            paid_calls_ready:
              missingFinancialControlVars(runtime.config, [...PEERS], {
                untilStopped: true,
              }).length === 0,
            missing_variables: missingFinancialControlVars(runtime.config, [...PEERS], {
              untilStopped: true,
            }),
            policy:
              "Paid provider calls are blocked until budget ceilings and per-peer USD-per-million rate cards are explicitly configured.",
          },
          prompt: runtime.config.prompt,
          max_output_tokens: runtime.config.max_output_tokens,
          streaming: runtime.config.streaming,
          // v2.12.0: judge auto-wire is now a first-class observable. Operators
          // checking `server_info` know whether shadow is collecting data,
          // which peer is rated, and whether a typo invalidated the config.
          // v2.15.1: surface `consensus_peers` and `configured_consensus_peers_raw`
          // so the multi-peer judge configuration (parsed from
          // CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS) is visible
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
            agents: getHostTokensRecord() ? Object.keys(getHostTokensRecord()?.map ?? {}) : [],
          },
          codeql_policy: "Default Setup on GitHub; no advanced workflow committed.",
          secrets_policy: "API keys are read from Windows environment variables only.",
        },
        response_format,
      ),
  );

  server.registerTool(
    "runtime_capabilities",
    {
      title: "Runtime Capabilities",
      description:
        "Return the stable cross-review-v2 runtime capability contract and active tool list.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
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
          name: "cross-review-v2",
          version: VERSION,
          release_date: RELEASE_DATE,
          capabilities: runtimeCapabilities(runtime),
          tools: TOOL_NAMES,
        },
        response_format,
      ),
  );

  server.registerTool(
    "probe_peers",
    {
      title: "Probe Peers",
      description:
        "Query official provider APIs to discover available models for the current API keys, select the highest-capability documented model, and verify provider reachability.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
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

  server.registerTool(
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
      verifyCallerIdentity(caller, server.server.getClientVersion());
      return textResult(
        await runtime.orchestrator.initSession(task, caller, review_focus),
        response_format,
      );
    },
  );

  server.registerTool(
    "session_list",
    {
      title: "List Sessions",
      description: "List durable sessions saved under the local data directory.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => textResult(runtime.orchestrator.store.list(), response_format),
  );

  server.registerTool(
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

  server.registerTool(
    "ask_peers",
    {
      title: "Ask Peers",
      description:
        "Run a real API review round against selected peers. Runtime default uses real provider APIs; stubs run only when CROSS_REVIEW_V2_STUB=1.",
      inputSchema: z.object({
        session_id: SessionIdSchema.optional(),
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        draft: z.string().min(1).max(SCHEMA_DRAFT_MAX_CHARS),
        caller: CallerSchema.default("operator"),
        caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
        peers: z
          .array(PeerSchema)
          .min(1)
          .max(5)
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
      verifyCallerIdentity(input.caller, server.server.getClientVersion());
      // v3.3.0: caller peer-selection lock — silently strips
      // caller-supplied `peers` (and, for peer callers, `lead_peer`) and
      // emits an audit event for the operator. See lockCallerPeerSelection
      // for the full rationale.
      const locked = lockCallerPeerSelection(input, {
        site: "ask_peers",
        emit: runtime.emit,
      });
      return textResult(await runtime.orchestrator.askPeers(locked), response_format);
    },
  );

  server.registerTool(
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
        caller: CallerSchema.default("operator"),
        caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
        peers: z
          .array(PeerSchema)
          .min(1)
          .max(5)
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
      verifyCallerIdentity(input.caller, server.server.getClientVersion());
      // v3.3.0: caller peer-selection lock.
      const locked = lockCallerPeerSelection(input, {
        site: "session_start_round",
        emit: runtime.emit,
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
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "run_until_unanimous",
    {
      title: "Run Until Unanimous",
      description:
        "Generate or revise a draft and continue real API peer-review rounds until unanimous READY or the configured max_rounds is reached. v2.11.0: when `caller` is set to a peer id (claude|codex|gemini|deepseek|grok), the relator lottery activates: omit `lead_peer` to have the server randomly select a non-caller peer as relator (modeled on judicial colegiados), or supply an explicit `lead_peer` that is NOT the caller. An explicit `lead_peer === caller` is rejected at the server with `caller_cannot_be_lead_peer` — an agent never reviews itself (workspace HARD GATE).",
      inputSchema: z.object({
        task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        review_focus: ReviewFocusSchema,
        initial_draft: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
        // v2.11.0: lead_peer is now optional. When omitted with a peer
        // caller, the relator lottery picks one. When omitted with
        // operator caller, the orchestrator uses "codex" (v2.10 default
        // preserved).
        lead_peer: PeerSchema.optional(),
        // v2.11.0: caller identifies the petitioner for the lottery.
        // Default "operator" preserves v2.10.0 behavior (no exclusion).
        caller: CallerSchema.default("operator"),
        peers: z
          .array(PeerSchema)
          .min(1)
          .max(5)
          .default([...PEERS] as PeerId[]),
        max_rounds: z.number().int().min(1).max(1000).default(8),
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
      verifyCallerIdentity(input.caller, server.server.getClientVersion());
      // v3.3.0: caller peer-selection lock — peers panel always full
      // enabled set; lead_peer ignored for peer callers (forced lottery).
      const locked = lockCallerPeerSelection(input, {
        site: "run_until_unanimous",
        emit: runtime.emit,
      });
      return textResult(await runtime.orchestrator.runUntilUnanimous(locked), response_format);
    },
  );

  server.registerTool(
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
          .min(1)
          .max(5)
          .default([...PEERS] as PeerId[]),
        max_rounds: z.number().int().min(1).max(1000).default(8),
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
      verifyCallerIdentity(input.caller, server.server.getClientVersion());
      // v3.3.0: caller peer-selection lock.
      const locked = lockCallerPeerSelection(input, {
        site: "session_start_unanimous",
        emit: runtime.emit,
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
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_cancel_job",
    {
      title: "Cancel Session Job",
      description:
        "Request cancellation for running background jobs in a durable session. Provider calls receive AbortSignal where the provider client supports it.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        job_id: SessionIdSchema.optional(),
        reason: z.string().min(1).max(300).default("operator_requested"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, job_id, reason, response_format }) => {
      const jobs = [...runtime.jobs.values()].filter(
        (job) =>
          job.session_id === session_id &&
          job.status === "running" &&
          (!job_id || job.job_id === job_id),
      );
      const meta = runtime.orchestrator.store.requestCancellation(session_id, reason, job_id);
      for (const job of jobs) {
        runtime.controllers.get(job.job_id)?.abort(reason);
      }
      if (!jobs.length) {
        runtime.orchestrator.store.markCancelled(session_id, reason);
      }
      return textResult(
        {
          session_id,
          requested: true,
          matched_jobs: jobs,
          control: meta.control,
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_recover_interrupted",
    {
      title: "Recover Interrupted Sessions",
      description:
        "Mark unfinished sessions with stale in-flight rounds as recovered after a MCP host restart so they can be resumed explicitly.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      const active = new Set(
        [...runtime.jobs.values()]
          .filter((job) => job.status === "running")
          .map((job) => job.session_id),
      );
      return textResult(
        {
          recovered: runtime.orchestrator.store.recoverInterruptedSessions(active),
        },
        response_format,
      );
    },
  );

  server.registerTool(
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
      const jobs = [...runtime.jobs.values()].filter((job) => job.session_id === session_id);
      return textResult(
        {
          session_id,
          outcome: session.outcome,
          health: session.convergence_health,
          in_flight: session.in_flight,
          rounds: session.rounds.length,
          latest_round: session.rounds.at(-1) ?? null,
          jobs,
          control: session.control,
        },
        response_format,
      );
    },
  );

  server.registerTool(
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

  server.registerTool(
    "session_doctor",
    {
      title: "Session Doctor",
      description:
        "Read-only operational audit across durable sessions: open/stale/blocked cases, legacy self-lead metadata, open evidence asks (with per-peer item type drill-down + chronic blockers since v2.22), Grok provider errors, and token-event noise. Does not modify sessions. Pass include_legacy=true to enumerate per-session self_lead_metadata entries (hidden by default since v2.22 because pre-v2.16 sessions carry the legacy artifact at ~38% rate; totals.self_lead_metadata count is always visible).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        // v2.22.0 (A.P2): opt-in enumeration of legacy self_lead_metadata
        // entries. Defaults to false; the headline count in totals stays
        // visible even when the array is suppressed.
        include_legacy: z.boolean().optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, include_legacy, response_format }) =>
      textResult(
        runtime.orchestrator.store.sessionDoctor(limit, include_legacy ?? false),
        response_format,
      ),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
          failed_attempts: session.failed_attempts ?? [],
        },
        response_format,
      );
    },
  );

  server.registerTool(
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
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, label, content, content_type, extension, response_format }) =>
      textResult(
        runtime.orchestrator.store.attachEvidence(session_id, {
          label,
          content,
          content_type,
          extension,
        }),
        response_format,
      ),
  );

  server.registerTool(
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
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, item_id, status, note, response_format }) =>
      textResult(
        runtime.orchestrator.store.setEvidenceChecklistItemStatus(session_id, item_id, status, {
          note,
          by: "operator",
        }),
        response_format,
      ),
  );

  server.registerTool(
    "session_evidence_judge_pass",
    {
      title: "Run Evidence Judge Pass",
      description:
        "v2.9.0 LLM-based satisfied detection for the Evidence Broker. The configured judge peer reads each currently-open checklist item against the supplied draft and returns a structured judgment (satisfied + confidence + rationale). The runtime promotes only items where satisfied=true AND confidence='verified'; everything else stays open. Terminal operator statuses (satisfied/deferred/rejected) and items already addressed by resurfacing-inference are NEVER touched. Items per pass are capped via CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS (default 8). Optional item_ids filter narrows the pass to specific items; omit for all-open. The judge_peer is the LLM that performs the judgment — choose any peer with a configured API key. v2.10.0: optional shadow_mode (default false) routes the pass through a non-mutating path that emits session.evidence_judge_pass.shadow_decision events without touching checklist state — operators use it to collect empirical judgment-quality data before relying on active mutation.",
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
      response_format,
    }) =>
      textResult(
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
      ),
  );

  // v2.14.0 (item 3): multi-peer judge consensus pass. Fires the judge
  // call against MULTIPLE peers in parallel for each open evidence
  // checklist item; promotes the item ONLY when all configured judge
  // peers agree (unanimous verified-satisfied + non-empty rationale +
  // zero parser_warnings). Reduces single-judge bias risk before
  // operator-wide active-mode autowire is enabled in high-stakes
  // scenarios. Cost-aware: each item costs N peer calls in parallel.
  server.registerTool(
    "session_evidence_judge_consensus_pass",
    {
      title: "Run Evidence Judge Consensus Pass",
      description:
        "v2.14.0 — multi-peer consensus judge pass. Fires `judgeEvidenceAsk` against ALL `judge_peers` in parallel for each open checklist item; promotes (active mode) ONLY when all peers return verified-satisfied with non-empty rationale and zero parser_warnings. Disagreement leaves the item open with `reason=consensus_disagreement` and `per_peer` details. Shadow mode emits `session.evidence_judge_pass.shadow_decision` events with `consensus_peers` so the precision report tool sees consensus runs in its corpus. Requires at least 2 judge_peers; single-peer callers should use `session_evidence_judge_pass`. All judge_peers must be enabled (CROSS_REVIEW_V2_PEER_<NAME>=on).",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        judge_peers: z.array(PeerSchema).min(2).max(5),
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
      response_format,
    }) =>
      textResult(
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
      ),
  );

  // v2.14.0 (item 1): precision/recall/F1 of the shadow judge against
  // empirical ground truth (whether peers raised the same ask in a
  // subsequent round). Walks events.ndjson per session, correlates
  // each `session.evidence_judge_pass.shadow_decision` event with the
  // matching evidence_checklist item by id, and rolls up per
  // judge_peer. Operator-triggered observability — DOES NOT mutate
  // session state; safe to run on any session.
  server.registerTool(
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
  // back. Caller NOT_READY (contesta) → use this tool. Caller READY
  // (acata) → use session_finalize as before.
  server.registerTool(
    "contest_verdict",
    {
      title: "Contest Verdict",
      description:
        "v2.14.0 — formally contest a final verdict and open a new deliberation cycle. Per the cross-review-v2 tribunal-colegiado model: caller READY (acata) → session_finalize as usual; caller NOT_READY (contesta) → contest_verdict. Stamps the original session's meta with a `contestation` record (timestamp + reason + original_outcome + new_session_id) and initializes a NEW session whose `contests_session_id` points back to the contested session, preserving the chain of custody append-only across sessions. The original session must be in a final state (converged/aborted/max-rounds); contesting an in-flight session throws cannot_contest_in_flight_session. Once contested, a session cannot be contested again (chain-of-custody invariant) — contest the LATEST session in the chain.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        reason: z.string().min(1).max(4_000),
        new_task: z.string().min(1).max(SCHEMA_TASK_MAX_CHARS),
        new_initial_draft: z.string().max(SCHEMA_INITIAL_DRAFT_MAX_CHARS).optional(),
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
    async ({ session_id, reason, new_task, new_initial_draft, new_caller, response_format }) => {
      // v2.17.0: identity forgery rejection (operator directive 2026-05-05).
      // Skip when new_caller is undefined (orchestrator falls back to a
      // sensible default); otherwise verify like the other handlers.
      if (new_caller !== undefined) {
        verifyCallerIdentity(new_caller, server.server.getClientVersion());
      }
      return textResult(
        runtime.orchestrator.store.contestVerdict({
          session_id,
          reason,
          new_task,
          new_initial_draft,
          new_caller,
        }),
        response_format,
      );
    },
  );

  server.registerTool(
    "regenerate_caller_tokens",
    {
      title: "Regenerate Caller Tokens (F1)",
      description:
        "v2.18.0 / F1 (caller capability tokens). Rotate the per-host secret tokens used by the F1 identity gate. OVERWRITES the existing host-tokens.json file (default location: <data_dir>/host-tokens.json; override via CROSS_REVIEW_TOKENS_FILE env var) with freshly generated 256-bit hex secrets — one per agent (codex, claude, gemini, deepseek, grok). Returns the new map so the operator can copy each per-agent secret into the corresponding MCP host config as CROSS_REVIEW_CALLER_TOKEN. AFTER calling this tool, every MCP host carrying a stale token will start being rejected with identity_forgery_blocked: token does not match any known agent. The operator MUST redistribute the secrets and reload the affected hosts. Use cases: (a) initial deployment after first-boot generation; (b) suspected token leak; (c) periodic rotation. The tool has no input parameters and no auth gate — local filesystem access already implies the ability to read or rewrite host-tokens.json directly, so the MCP surface adds no new exposure.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
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
      return textResult(
        {
          ok: true,
          file_path: generated.filePath,
          generated_at: generated.generated_at,
          tokens: generated.map,
          next_steps: [
            "Copy each per-agent secret into the corresponding MCP host config as CROSS_REVIEW_CALLER_TOKEN.",
            "Reload the affected MCP hosts so the new env value is picked up.",
            "Stale tokens will start being rejected with identity_forgery_blocked: token does not match any known agent.",
          ],
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "escalate_to_operator",
    {
      title: "Escalate To Operator",
      description:
        "Record a durable operator escalation for sessions that require human judgment or external intervention.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        reason: z.string().min(1).max(1000),
        severity: z.enum(["info", "warning", "critical"]).default("warning"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, reason, severity, response_format }) =>
      textResult(
        runtime.orchestrator.store.escalateToOperator(session_id, { reason, severity }),
        response_format,
      ),
  );

  server.registerTool(
    "session_sweep",
    {
      title: "Sweep Idle Sessions",
      description:
        "Finalize unfinished sessions whose metadata has been idle for at least 24 hours.",
      inputSchema: z.object({
        idle_minutes: z.number().min(1440).max(100_000).default(1440),
        outcome: z.enum(["aborted", "max-rounds"]).default("aborted"),
        reason: z.string().min(1).max(200).default("stale"),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ idle_minutes, outcome, reason, response_format }) =>
      textResult(
        runtime.orchestrator.store.sweepIdle(idle_minutes * 60_000, outcome, reason),
        response_format,
      ),
  );

  server.registerTool(
    "session_finalize",
    {
      title: "Finalize Session",
      description:
        "Mark a durable session as converged, aborted or max-rounds with an optional reason.",
      inputSchema: z.object({
        session_id: SessionIdSchema,
        outcome: z.enum(["converged", "aborted", "max-rounds"]),
        reason: z.string().max(200).optional(),
        response_format: ResponseFormatSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, outcome, reason, response_format }) =>
      textResult(runtime.orchestrator.store.finalize(session_id, outcome, reason), response_format),
  );

  await server.connect(new StdioServerTransport());
  console.error("cross-review-v2 running on stdio");

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
        console.error("[cross-review-v2] startup tmp sweep:", JSON.stringify(tmpSweep));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review-v2] startup tmp sweep error: ${message}`);
    }
  }, STARTUP_SWEEP_DELAY_MS);
  setTimeout(() => {
    try {
      const inFlightSweep = runtime.orchestrator.store.clearStaleInFlight();
      if (inFlightSweep.scanned > 0) {
        console.error("[cross-review-v2] startup in_flight sweep:", JSON.stringify(inFlightSweep));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review-v2] startup in_flight sweep error: ${message}`);
    }
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.5.0: companion to clearStaleInFlight — abort sessions that the
  // caller never finalized. Runs AFTER the in_flight sweep (deferred via
  // setTimeout, same delay so order is preserved by registration order)
  // so a session whose in_flight got cleared this same boot is
  // immediately eligible for staleness review.
  setTimeout(() => {
    try {
      const abortSweep = runtime.orchestrator.store.abortStaleSessions();
      if (abortSweep.scanned > 0) {
        console.error(
          "[cross-review-v2] startup stale-session abort sweep:",
          JSON.stringify(abortSweep),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review-v2] startup stale-session abort sweep error: ${message}`);
    }
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.27.0: prune finalized sessions older than CROSS_REVIEW_V2_PRUNE_AFTER_DAYS
  // (default 60). Empirically motivated by 534 sessions accumulated by
  // 2026-05-12 inflating sweep + list cost. Disable with PRUNE_AFTER_DAYS=0.
  setTimeout(() => {
    try {
      const envDisable = (process.env.CROSS_REVIEW_V2_PRUNE_AFTER_DAYS ?? "").trim() === "0";
      if (envDisable) return;
      const pruneSweep = runtime.orchestrator.store.pruneOldSessions();
      if (pruneSweep.pruned > 0) {
        console.error("[cross-review-v2] startup prune sweep:", JSON.stringify(pruneSweep));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cross-review-v2] startup prune sweep error: ${message}`);
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
        `[cross-review-v2] notice: CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE="${autowire.configured_mode_raw}" is not recognized; valid values are "off", "shadow" and "active". Auto-wire will be skipped.`,
      );
      return;
    }
    if (autowire.mode === "off") return;
    if (!autowire.active) {
      console.error(
        `[cross-review-v2] notice: CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE=${autowire.mode} is set but CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER ("${autowire.configured_peer_raw}") is missing or not one of codex|claude|gemini|deepseek. ${autowire.mode === "active" ? "Active" : "Shadow"} auto-wire will be skipped per round; configure the peer to enable it.`,
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
        `[cross-review-v2] WARN: judge auto-wire active in ACTIVE mode via peer "${autowire.peer}" — verified-satisfied judgments WILL mutate evidence checklist state (markEvidenceItemAddressedByJudge). Run session_judgment_precision_report and confirm the judge's F1 is acceptable before relying on this in production. Set MODE=shadow to revert to non-mutating data collection.`,
      );
      return;
    }
    console.error(
      `[cross-review-v2] notice: judge auto-wire active in SHADOW mode via peer "${autowire.peer}" (max_items_per_pass=${autowire.max_items_per_pass}). Every askPeers round will fire a non-mutating judge pass; events session.evidence_judge_pass.shadow_decision are emitted per item.`,
    );
  }, STARTUP_SWEEP_DELAY_MS);
  // v2.15.0 (item 4A boot warning): when operator configured a
  // CROSS_REVIEW_GROK_REASONING_EFFORT but the chosen model is NOT in
  // the allowlist (only grok-4.20-multi-agent accepts the field per xAI
  // docs), inform that the value will be ignored at the wire level.
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
      `[cross-review-v2] notice: GrokAdapter — model="${grokModel}" does NOT accept reasoning.effort per xAI docs (only grok-4.20-multi-agent does). CROSS_REVIEW_GROK_REASONING_EFFORT="${process.env.CROSS_REVIEW_GROK_REASONING_EFFORT}" will be IGNORED at the wire level for this model. xAI auto-applies reasoning internally for the Grok-4 lineup. Set CROSS_REVIEW_GROK_MODEL=grok-4.20-multi-agent to enable agent-count control via reasoning.effort.`,
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
      `[cross-review-v2] notice: PerplexityAdapter — model="${perplexityModel}" does NOT accept reasoning_effort per Perplexity docs (only sonar-reasoning-pro and sonar-deep-research do). CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT="${process.env.CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT}" will be IGNORED at the wire level for this model. Set CROSS_REVIEW_PERPLEXITY_MODEL=sonar-reasoning-pro (default) to enable explicit reasoning_effort control.`,
    );
  }, STARTUP_SWEEP_DELAY_MS);
}

// v2.15.0: shadow copy of `peers/grok.ts:GROK_REASONING_EFFORT_MODELS`
// for the boot notice. Avoids creating a hard import dependency from
// the server boot path into a peer adapter module. If xAI adds models
// to the reasoning-capable set, both lists must update together.
const GROK_REASONING_EFFORT_MODELS_BOOT_NOTICE: ReadonlySet<string> = new Set([
  "grok-4.20-multi-agent",
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

// v2.4.0 / cross-review-v2 R6 follow-up (CI failure 25199679588): guard
// main() so it only runs when this module is invoked as the entry point
// (e.g. `bin/cross-review-v2` or `node dist/src/mcp/server.js`). Without
// the guard, any module that imports a named export from here (the smoke
// suite imports `SessionIdSchema` and `pruneCompletedJobs`) triggers a
// full server boot at import time — and in CI that boot ran with the
// stub flag set but without confirmation, tripping the v2.4.0 P1.1
// fail-fast gate before scripts/smoke.ts could write the confirmation
// env var. Comparing `import.meta.url` to `process.argv[1]` is the
// canonical ESM "is main module" check; a side benefit is that bin
// installs (which resolve through symlinks) still match because we
// compare resolved paths.
const __isMainModule = (() => {
  if (!process.argv[1]) return false;
  const moduleFile = fileURLToPath(import.meta.url);
  const argvFile = path.resolve(process.argv[1]);
  return moduleFile === argvFile;
})();

if (__isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
