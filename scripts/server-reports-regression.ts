import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionCostBreakdown, sessionReportMarkdown } from "../src/core/reports.js";
import type {
  EvidenceChecklistItem,
  PeerResult,
  ReviewRound,
  SessionEvent,
  SessionMeta,
} from "../src/core/types.js";
import { markdownResult, summarizeSessionForList } from "../src/mcp/server.js";

const now = "2026-07-17T12:00:00.000Z";

function baseSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: "00000000-0000-4000-8000-000000000001",
    version: "4.5.17",
    accounting_schema_version: 2,
    created_at: now,
    updated_at: now,
    task: "Targeted server/report regression fixture.",
    caller: "codex",
    capability_snapshot: [],
    rounds: [],
    totals: {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
      cost: {
        currency: "USD",
        estimated: false,
        source: "unknown-rate",
      },
    },
    ...overrides,
  };
}

function checklistItem(
  id: string,
  status?: EvidenceChecklistItem["status"],
): EvidenceChecklistItem {
  return {
    id,
    peer: "claude",
    ask: `Evidence ask ${id}`,
    first_round: 1,
    last_round: 1,
    round_count: 1,
    first_seen_at: now,
    last_seen_at: now,
    ...(status === undefined ? {} : { status }),
  };
}

const peerWithRequests = {
  peer: "claude",
  provider: "anthropic",
  model: "claude-fable-5",
  status: "NOT_READY",
  structured: {
    status: "NOT_READY",
    summary: "Blocking evidence remains.",
    confidence: "verified",
    evidence_sources: [],
    caller_requests: ["Attach the exact raw test output."],
    follow_ups: ["Re-run the focused regression after attaching it."],
  },
  text: "fixture",
  raw: {},
  latency_ms: 1,
  attempts: 1,
  parser_warnings: [],
  decision_quality: "clean",
} as unknown as PeerResult;

const roundWithRequests = {
  round: 1,
  started_at: now,
  completed_at: now,
  caller_status: "READY",
  prompt_file: "round-1-prompt.md",
  peers: [peerWithRequests],
  rejected: [],
  convergence: {
    converged: false,
    reason: "peer_not_ready",
    ready_peers: [],
    not_ready_peers: ["claude"],
    needs_evidence_peers: [],
    rejected_peers: [],
    skipped_peers: [],
    decision_quality: { claude: "clean" },
    blocking_details: ["claude: NOT_READY"],
  },
} as unknown as ReviewRound;

const failures: string[] = [];

function check(name: string, test: () => void): void {
  try {
    test();
    console.log(`[server-reports-regression] ${name}: PASS`);
  } catch (error) {
    failures.push(
      `[server-reports-regression] ${name}: FAIL\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  }
}

check("session_list_legacy_open_and_not_resurfaced_counts", () => {
  const summary = summarizeSessionForList(
    baseSession({
      evidence_checklist: [
        checklistItem("legacy-open"),
        checklistItem("explicit-open", "open"),
        checklistItem("not-resurfaced", "not_resurfaced"),
        checklistItem("satisfied", "satisfied"),
      ],
    }),
  );
  assert.equal(summary.open_evidence_items, 2);
  assert.equal(summary.not_resurfaced_evidence_items, 1);
});

check("accounting_v2_zero_calls_is_exact_zero", () => {
  const session = baseSession();
  const breakdown = sessionCostBreakdown(session);
  assert.equal(breakdown.total, 0);
  assert.equal(breakdown.peer_total, 0);
  assert.equal(breakdown.generation_total, 0);
  assert.equal(breakdown.failed_attempt_total, 0);
  assert.equal(breakdown.reconciled, true);
  assert.match(sessionReportMarkdown(session), /- Cost: \$0\.000000 USD/);
});

check("pending paid reservations keep accounting incomplete", () => {
  const session = baseSession({
    in_flight: {
      round: 1,
      peers: ["claude"],
      started_at: now,
      status: "running",
      provider_call_reservations: [
        {
          id: "format-recovery-pending",
          peer: "claude",
          provider: "anthropic",
          model: "claude-fable-5",
          label: "format-recovery",
          started_at: now,
        },
      ],
    },
    pending_provider_call_reservations: [
      {
        id: "judge-pending",
        peer: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
        label: "judge-evidence-1",
        started_at: now,
        round: 1,
        call_kind: "evidence_judge",
        owner_pid: process.pid,
      },
    ],
  });
  const breakdown = sessionCostBreakdown(session);
  assert.equal(breakdown.total, null, "a live paid call has no final bill yet");
  assert.equal(
    breakdown.unpriced_failed_attempts,
    3,
    "the unsettled primary peer remains billable alongside both secondary reservations",
  );
  assert.equal(breakdown.reconciled, false);
  assert.match(sessionReportMarkdown(session), /- Cost: unknown/);
  assert.match(sessionReportMarkdown(session), /- Unpriced provider attempts: 3/);
});

check("in-flight generation keeps accounting incomplete", () => {
  const session = baseSession({
    generation_in_flight: {
      peer: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      label: "lead-generation",
      round: 1,
      started_at: now,
      owner_pid: process.pid,
    },
  });
  const breakdown = sessionCostBreakdown(session);
  assert.equal(breakdown.total, null, "a dispatched generation has no final bill yet");
  assert.equal(breakdown.unpriced_failed_attempts, 1);
  assert.equal(breakdown.reconciled, false);
  assert.match(sessionReportMarkdown(session), /- Cost: unknown/);
  assert.match(sessionReportMarkdown(session), /- Unpriced provider attempts: 1/);
});

check("unsettled primary peers keep accounting incomplete", () => {
  const session = baseSession({
    in_flight: {
      round: 1,
      peers: ["claude", "gemini"],
      started_at: now,
      status: "running",
    },
  });
  const breakdown = sessionCostBreakdown(session);
  assert.equal(breakdown.total, null, "primary review calls have no final bill yet");
  assert.equal(breakdown.unpriced_failed_attempts, 2);
  assert.equal(breakdown.reconciled, false);
  assert.match(sessionReportMarkdown(session), /- Cost: unknown/);
  assert.match(sessionReportMarkdown(session), /- Unpriced provider attempts: 2/);
});

check("report_surfaces_requests_and_bounded_non_streaming_timeline", () => {
  const session = baseSession({
    rounds: [roundWithRequests],
    totals: {
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
      cost: {
        currency: "USD",
        estimated: false,
        source: "unknown-rate",
      },
    },
  });
  const ordinaryEvent = (index: number): SessionEvent => ({
    seq: index + 1,
    ts: now,
    type: "session.fixture",
    message: `ordinary-event-${String(index + 1).padStart(3, "0")}`,
  });
  const streamingEvent = (index: number): SessionEvent => ({
    seq: 106 + index,
    ts: now,
    type: "peer.token.delta",
    peer: "claude",
    message: `streaming-delta-${index + 1}`,
  });
  const ordinaryEvents = Array.from({ length: 105 }, (_, index) => ordinaryEvent(index));
  const streamingEvents = Array.from({ length: 3 }, (_, index) => streamingEvent(index));

  const report = sessionReportMarkdown(session, [...ordinaryEvents, ...streamingEvents]);
  assert.match(report, /Caller request: Attach the exact raw test output\./);
  assert.match(report, /Follow-up: Re-run the focused regression after attaching it\./);
  assert.doesNotMatch(report, /streaming-delta-/);
  assert.doesNotMatch(report, /peer\.token\.delta/);
  assert.match(report, /3 streaming token event\(s\) suppressed/i);
  assert.match(report, /Timeline truncated: showing latest 100 of 105/i);
  assert.doesNotMatch(report, /ordinary-event-001/);
  assert.match(report, /ordinary-event-105/);
});

check("markdown_omits_undefined_object_fields", () => {
  const markdown = markdownResult({
    health: {
      state: "healthy",
      idle_ms: undefined,
    },
  });
  assert.doesNotMatch(markdown, /undefined/);
  assert.doesNotMatch(markdown, /idle_ms/);
});

check("server_info_surfaces_evidence_judge_reasoning_effort", () => {
  const source = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  const block = source.match(
    /evidence_judge_autowire:\s*\{([\s\S]*?)\n\s*\},\n\s*\/\/ v2\.14\.0/,
  )?.[1];
  assert.ok(block, "server_info evidence_judge_autowire block was not found");
  assert.match(
    block,
    /\breasoning_effort\s*:/,
    "server_info cannot reveal the evidence-judge reasoning effort loaded in this window",
  );
});

if (failures.length > 0) {
  throw new Error(`\n${failures.join("\n\n")}`);
}
