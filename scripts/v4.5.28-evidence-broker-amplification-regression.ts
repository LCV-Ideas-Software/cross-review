import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import {
  EvidenceChecklistContractViolationError,
  SessionStore,
} from "../src/core/session-store.js";
import type {
  AppConfig,
  EvidenceChecklistItem,
  PeerAdapter,
  PeerId,
  PeerResult,
  RuntimeEvent,
} from "../src/core/types.js";
import { PEERS } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
process.env.CROSS_REVIEW_TEST_QUIET = "1";

const tempDirs: string[] = [];

function fixtureConfig(label: string): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cross-review-v4528-broker-amplification-${label}-`),
  );
  tempDirs.push(dataDir);
  return {
    ...base,
    stub: true,
    data_dir: dataDir,
    evidence_preflight_enabled: false,
    truthfulness_preflight_enabled: false,
    cache: { ...base.cache, enabled: false },
    peer_enabled: Object.fromEntries(PEERS.map((peer) => [peer, true])) as Record<PeerId, boolean>,
    evidence_broker: {
      max_requests_per_peer_round: 8,
      max_requests_per_round: 24,
      max_items_per_session: 64,
      max_chars_per_session: 64_000,
    },
    evidence_judge_autowire: {
      ...base.evidence_judge_autowire,
      mode: "off",
      active: false,
      peer: undefined,
      consensus_peers: [],
    },
    cost_rates: Object.fromEntries(
      PEERS.map((peer) => [
        peer,
        {
          input_per_million: 0,
          output_per_million: 0,
          ...(peer === "perplexity"
            ? {
                // v4.6.0: the canonical Agent API pin bills web_search per invocation.
                search_queries_per_1000: 0,
                request_fee_low_per_1000: 0,
                request_fee_medium_per_1000: 0,
                request_fee_high_per_1000: 0,
              }
            : {}),
        },
      ]),
    ) as AppConfig["cost_rates"],
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

function adapters(
  config: AppConfig,
  call: (peer: PeerId) => Promise<PeerResult>,
): Record<PeerId, PeerAdapter> {
  return Object.fromEntries(
    PEERS.map((peer) => {
      const adapter = new StubAdapter(config, peer);
      adapter.call = async () => call(peer);
      return [peer, adapter];
    }),
  ) as unknown as Record<PeerId, PeerAdapter>;
}

function needsEvidence(peer: PeerId, asks: string[]): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    raw_status: "NEEDS_EVIDENCE",
    parsed_status: "NEEDS_EVIDENCE",
    normalized_status: "NEEDS_EVIDENCE",
    status: "NEEDS_EVIDENCE",
    structured: {
      status: "NEEDS_EVIDENCE",
      summary: "The submitted artifact still requires concrete evidence.",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: asks,
      follow_ups: [],
    },
    text: JSON.stringify({
      status: "NEEDS_EVIDENCE",
      summary: "The submitted artifact still requires concrete evidence.",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: asks,
      follow_ups: [],
    }),
    raw: { fixture: true },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    cost: {
      currency: "USD",
      total_cost: 0,
      estimated: false,
      source: "stub",
    },
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  };
}

function legacyChecklist(count: number): EvidenceChecklistItem[] {
  const ts = "2026-07-21T00:00:00.000Z";
  return Array.from({ length: count }, (_, index) => {
    const peer = PEERS[index % PEERS.length] ?? "codex";
    const ask =
      `Legacy blocker ${String(index + 1).padStart(3, "0")}: provide exact file:line, SHA-256, ` +
      `literal quote and raw command output for check ${"x".repeat(160)}.`;
    return {
      id: crypto.createHash("sha256").update(`${peer}:${ask}`).digest("hex").slice(0, 16),
      peer,
      first_round: Math.floor(index / PEERS.length) + 1,
      last_round: 11,
      round_count: 1,
      ask,
      first_seen_at: ts,
      last_seen_at: ts,
      status: index < 26 ? "open" : "not_resurfaced",
    };
  });
}

async function legacySessionStopsBeforeDispatch(): Promise<void> {
  const config = fixtureConfig("legacy-pre-dispatch");
  let providerCalls = 0;
  const emitted: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => emitted.push(event),
    () =>
      adapters(config, async (peer) => {
        providerCalls += 1;
        return needsEvidence(peer, ["This call must never run."]);
      }),
  );
  const initialized = await orchestrator.store.init(
    "Legacy 142-item Evidence Broker amplification fixture.",
    "operator",
    [],
  );
  const meta = orchestrator.store.read(initialized.session_id);
  meta.evidence_checklist = legacyChecklist(142);
  meta.updated_at = new Date().toISOString();
  fs.writeFileSync(
    orchestrator.store.metaPath(initialized.session_id),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  const result = await orchestrator.askPeers({
    session_id: initialized.session_id,
    task: meta.task,
    draft: "A subsequent draft must not trigger another amplified provider round.",
    caller: "operator",
    peers: ["codex", "gemini"],
  });

  assert.equal(providerCalls, 0, "a legacy oversized checklist reached a paid adapter");
  assert.equal(result.session.outcome, "aborted");
  assert.equal(result.session.outcome_reason, "evidence_checklist_contract_violation");
  assert.equal(result.session.evidence_checklist?.length, 142, "legacy blockers were dropped");
  assert.equal(result.round.peers.length, 0);
  assert.equal(
    result.round.rejected.every(
      (failure) => failure.failure_class === "evidence_broker_contract" && failure.attempts === 0,
    ),
    true,
  );
  const circuit = emitted.find(
    (event) => event.type === "session.evidence_checklist_circuit_breaker_tripped",
  );
  assert.equal(circuit?.data?.phase, "pre_dispatch");
  assert.equal(circuit?.data?.paid_provider_calls_started, 0);
  const prompt = fs.readFileSync(
    path.join(orchestrator.store.sessionDir(initialized.session_id), result.round.prompt_file),
    "utf8",
  );
  assert.ok(prompt.length < 2_000, "the synthetic stop prompt reinjected the oversized checklist");
  assert.doesNotMatch(prompt, /Legacy blocker 142/);
}

async function overLimitRoundIsDurableAndAtomic(): Promise<void> {
  const config = fixtureConfig("post-round");
  let providerCalls = 0;
  const emitted: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => emitted.push(event),
    () =>
      adapters(config, async (peer) => {
        providerCalls += 1;
        return needsEvidence(
          peer,
          peer === "codex"
            ? Array.from(
                { length: 9 },
                (_, index) => `Codex blocker ${index + 1}: provide the exact raw record.`,
              )
            : ["Gemini blocker 1: provide the exact raw record."],
        );
      }),
  );

  const result = await orchestrator.askPeers({
    task: "A single peer returns nine distinct Evidence Broker requests.",
    draft: "Fixture draft.",
    caller: "operator",
    peers: ["codex", "gemini"],
  });

  assert.equal(providerCalls, 2, "the fixture did not execute exactly one review round");
  assert.equal(result.session.outcome, "aborted");
  assert.equal(result.session.outcome_reason, "evidence_checklist_contract_violation");
  assert.equal(result.round.peers.length, 2, "the paid round disappeared from the audit record");
  assert.equal(
    result.round.peers.find((peer) => peer.peer === "codex")?.structured?.caller_requests?.length,
    9,
    "the over-limit blocker list was silently truncated",
  );
  assert.equal(
    result.session.evidence_checklist?.length ?? 0,
    0,
    "an over-limit round partially mutated the checklist",
  );
  const circuit = emitted.find(
    (event) => event.type === "session.evidence_checklist_circuit_breaker_tripped",
  );
  assert.equal(circuit?.data?.phase, "post_round");
  assert.equal(circuit?.data?.checklist_mutated, false);
  assert.equal(circuit?.data?.automatic_judges_started, 0);

  await assert.rejects(
    orchestrator.askPeers({
      session_id: result.session.session_id,
      task: "A single peer returns nine distinct Evidence Broker requests.",
      draft: "A later draft.",
      caller: "operator",
      peers: ["codex", "gemini"],
    }),
    /session_already_finalized/,
  );
  assert.equal(providerCalls, 2, "a paid round started after the circuit breaker finalized");
}

async function dedupeAndGlobalLimitsAreAtomic(): Promise<void> {
  const config = fixtureConfig("admission");
  const store = new SessionStore(config);
  const dedupeSession = await store.init("Exact same-owner dedupe fixture.", "operator", []);
  const repeated = Array.from({ length: 30 }, () => ({
    peer: "codex" as const,
    ask: "Provide the exact raw test transcript.",
  }));
  const deduplicated = await store.appendEvidenceChecklistItems(
    dedupeSession.session_id,
    1,
    repeated,
  );
  assert.equal(deduplicated.length, 1, "exact same-owner duplicates were not collapsed");

  const roundSession = await store.init("Per-round admission fixture.", "operator", []);
  const twentyFive = Array.from({ length: 25 }, (_, index) => ({
    peer: PEERS[Math.floor(index / 8)] ?? "codex",
    ask: `Round blocker ${index + 1}: provide raw evidence.`,
  }));
  await assert.rejects(
    store.appendEvidenceChecklistItems(roundSession.session_id, 1, twentyFive),
    (error: unknown) => {
      assert.ok(error instanceof EvidenceChecklistContractViolationError);
      assert.ok(
        error.admission.violations.some(
          (violation) => violation.limit === "max_requests_per_round",
        ),
      );
      return true;
    },
  );
  assert.equal(
    store.read(roundSession.session_id).evidence_checklist?.length ?? 0,
    0,
    "a rejected per-round batch was partially committed",
  );

  const globalSession = await store.init("Global admission fixture.", "operator", []);
  const batch = (offset: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      peer: PEERS[Math.floor(index / 8)] ?? "codex",
      ask: `Global blocker ${offset + index + 1}: provide raw evidence.`,
    }));
  await store.appendEvidenceChecklistItems(globalSession.session_id, 1, batch(0, 24));
  await store.appendEvidenceChecklistItems(globalSession.session_id, 2, batch(24, 24));
  await assert.rejects(
    store.appendEvidenceChecklistItems(globalSession.session_id, 3, batch(48, 17)),
    (error: unknown) => {
      assert.ok(error instanceof EvidenceChecklistContractViolationError);
      assert.ok(
        error.admission.violations.some(
          (violation) =>
            violation.limit === "max_items_per_session" &&
            violation.observed === 65 &&
            violation.maximum === 64,
        ),
      );
      return true;
    },
  );
  assert.equal(
    store.read(globalSession.session_id).evidence_checklist?.length,
    48,
    "a rejected global batch was partially committed",
  );
}

try {
  await legacySessionStopsBeforeDispatch();
  await overLimitRoundIsDurableAndAtomic();
  await dedupeAndGlobalLimitsAreAtomic();
  console.log("[v4.5.28-evidence-broker-amplification-regression] PASS");
} finally {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
