import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCacheManifest } from "../src/core/cache-manifest.js";
import { loadConfig } from "../src/core/config.js";
import { checkConvergence } from "../src/core/convergence.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { sessionReportMarkdown } from "../src/core/reports.js";
import type { AppConfig, PeerId, PeerResult, RuntimeEvent, TokenUsage } from "../src/core/types.js";

// RED contract for the v4.5.3 field failures around consensus self-exclusion,
// shadow observability, judge accounting, cache identity, and decision traces.
// Keep this driver isolated from package scripts until production implements
// the contract. Every case runs even when earlier cases fail.

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const ALL_PEERS: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok", "perplexity"];
const tempDirs: string[] = [];

function regressionConfig(label: string): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v454-${label}-`));
  tempDirs.push(dataDir);
  return {
    ...base,
    stub: true,
    data_dir: dataDir,
    peer_enabled: Object.fromEntries(
      ALL_PEERS.map((peer) => [peer, true]),
    ) as AppConfig["peer_enabled"],
    cache: {
      ...base.cache,
      enabled: true,
    },
    cost_rates: {
      codex: { input_per_million: 0, output_per_million: 0 },
      claude: { input_per_million: 0, output_per_million: 0 },
      gemini: { input_per_million: 0, output_per_million: 0 },
      deepseek: { input_per_million: 0, output_per_million: 0 },
      grok: { input_per_million: 0, output_per_million: 0 },
      perplexity: {
        input_per_million: 0,
        output_per_million: 0,
        request_fee_low_per_1000: 0,
        request_fee_medium_per_1000: 0,
        request_fee_high_per_1000: 0,
      },
    },
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

function fixturePeer(
  peer: PeerId,
  status: "READY" | "NEEDS_EVIDENCE" = "NEEDS_EVIDENCE",
): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    status,
    structured: {
      status,
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: ['Artifact quote: "const fixture = true;"'],
      caller_requests: status === "NEEDS_EVIDENCE" ? ["Provide fixture evidence."] : [],
      follow_ups: [],
    },
    text: JSON.stringify({ status: "READY" }),
    raw: { fixture: true },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    cost: {
      currency: "USD",
      estimated: false,
      source: "configured-rate",
      total_cost: 0,
    },
    latency_ms: 1,
    attempts: 1,
    parser_warnings: status === "NEEDS_EVIDENCE" ? ["fixture_normalization"] : [],
    decision_quality: status === "NEEDS_EVIDENCE" ? "format_warning" : "clean",
  };
}

async function seededJudgeFixture(label: string, owner: PeerId = "gemini") {
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(regressionConfig(label), (event) => {
    events.push(event);
  });
  const session = await orchestrator.store.init(`v4.5.4 ${label}`, "operator", []);
  await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
    { peer: owner, ask: "Provide the exact fixture evidence." },
  ]);
  const item = orchestrator.store.read(session.session_id).evidence_checklist?.[0];
  assert.ok(item, "fixture must create one evidence checklist item");
  return { orchestrator, session_id: session.session_id, item, events };
}

function eventData(event: RuntimeEvent | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

function expectAll(checks: Array<{ ok: boolean; message: string }>): void {
  const failures = checks.filter((check) => !check.ok).map((check) => check.message);
  assert.deepEqual(failures, [], failures.join(" | "));
}

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const consensusPanel: PeerId[] = ["claude", "gemini", "grok", "perplexity"];

const regressions: Regression[] = [
  {
    name: "consensus excludes the Gemini item owner and promotes on three eligible votes",
    run: async () => {
      const fixture = await seededJudgeFixture("consensus-self-exclusion");
      const result = await fixture.orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: fixture.session_id,
        judge_peers: consensusPanel,
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "active",
      });
      const decision = result.consensus_decisions[0] as unknown as Record<string, unknown>;
      const eligible = decision?.eligible_judge_peers as unknown;
      expectAll([
        { ok: result.promoted.length === 1, message: "the item was not promoted" },
        {
          ok: JSON.stringify(eligible) === JSON.stringify(["claude", "grok", "perplexity"]),
          message: `eligible_judge_peers was ${JSON.stringify(eligible)}`,
        },
        {
          ok:
            result.promoted[0] !== undefined &&
            Object.keys(result.promoted[0].rationales).sort().join(",") ===
              "claude,grok,perplexity",
          message: "promotion did not contain exactly the three independent rationales",
        },
      ]);
    },
  },
  {
    name: "consensus reports insufficient_independent_judges before dispatch",
    run: async () => {
      const fixture = await seededJudgeFixture("consensus-insufficient");
      const result = await fixture.orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: fixture.session_id,
        judge_peers: ["gemini", "claude"],
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "active",
      });
      const dynamicResult = result as unknown as Record<string, unknown>;
      const decision = result.consensus_decisions[0] as unknown as Record<string, unknown>;
      const reason =
        dynamicResult.reason ??
        decision?.reason ??
        (result.skipped[0] as unknown as Record<string, unknown> | undefined)?.reason;
      const judgeStarts = fixture.events.filter((event) => event.type === "peer.judge.started");
      expectAll([
        {
          ok: reason === "insufficient_independent_judges",
          message: `reason was ${String(reason)}`,
        },
        {
          ok: judgeStarts.length === 0,
          message: `${judgeStarts.length} paid judge dispatch(es) occurred before insufficiency was reported`,
        },
      ]);
    },
  },
  {
    name: "positive consensus shadow returns and emits would_promote without mutation",
    run: async () => {
      const fixture = await seededJudgeFixture("shadow-positive");
      const result = await fixture.orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: fixture.session_id,
        judge_peers: ["claude", "grok", "perplexity"],
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "shadow",
      });
      const dynamicResult = result as unknown as {
        shadow_decisions?: Array<{ item_id?: string; would_promote?: boolean }>;
      };
      const decisions = fixture.events.filter(
        (event) => event.type === "session.evidence_judge_pass.shadow_decision",
      );
      const persisted = fixture.orchestrator.store
        .read(fixture.session_id)
        .evidence_checklist?.find((item) => item.id === fixture.item.id);
      expectAll([
        {
          ok:
            dynamicResult.shadow_decisions?.length === 1 &&
            dynamicResult.shadow_decisions[0]?.would_promote === true,
          message: "consensus return omitted the positive shadow decision",
        },
        {
          ok: decisions.length === 1 && eventData(decisions[0]).would_promote === true,
          message: "positive shadow_decision event was not emitted exactly once",
        },
        { ok: result.promoted.length === 0, message: "shadow mode populated promoted[]" },
        {
          ok: (persisted?.status ?? "open") === "open",
          message: `shadow mode mutated checklist status to ${String(persisted?.status)}`,
        },
      ]);
    },
  },
  {
    name: "negative consensus shadow emits an observable decision",
    run: async () => {
      const fixture = await seededJudgeFixture("shadow-negative");
      await fixture.orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: fixture.session_id,
        judge_peers: ["claude", "grok", "perplexity"],
        draft: "FORCE_JUDGE_UNKNOWN",
        mode: "shadow",
      });
      const decisions = fixture.events.filter(
        (event) => event.type === "session.evidence_judge_pass.shadow_decision",
      );
      expectAll([
        {
          ok: decisions.length === 1,
          message: `expected one negative shadow decision, observed ${decisions.length}`,
        },
        {
          ok: decisions.length === 1 && eventData(decisions[0]).would_promote === false,
          message: "negative shadow decision did not carry would_promote=false",
        },
      ]);
    },
  },
  {
    name: "consensus shadow completion separates would-promote decisions from mutations",
    run: async () => {
      const fixture = await seededJudgeFixture("shadow-completion");
      await fixture.orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: fixture.session_id,
        judge_peers: ["claude", "grok", "perplexity"],
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "shadow",
      });
      const completed = fixture.events.find(
        (event) => event.type === "session.evidence_judge_consensus_pass.completed",
      );
      const data = eventData(completed);
      expectAll([
        {
          ok: data.would_promote_count === 1,
          message: `would_promote_count was ${String(data.would_promote_count)}`,
        },
        {
          ok: data.mutation_count === 0,
          message: `mutation_count was ${String(data.mutation_count)}`,
        },
        {
          ok:
            typeof completed?.message === "string" &&
            /1\s+would[_ -]?promote/i.test(completed.message) &&
            /0\s+mutation/i.test(completed.message),
          message: `completion message conflated promotion and mutation: ${completed?.message ?? "missing"}`,
        },
      ]);
    },
  },
  {
    name: "successful judge generations are persisted and included in session totals",
    run: async () => {
      const fixture = await seededJudgeFixture("judge-ledger", "gemini");
      const before =
        fixture.orchestrator.store.read(fixture.session_id).totals.usage.total_tokens ?? 0;
      await fixture.orchestrator.runEvidenceChecklistJudgePass({
        session_id: fixture.session_id,
        judge_peer: "claude",
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "active",
      });
      const after = fixture.orchestrator.store.read(fixture.session_id);
      const judgeArtifacts = (after.generation_files ?? []).filter((artifact) =>
        artifact.label.toLowerCase().includes("judge"),
      );
      expectAll([
        {
          ok: judgeArtifacts.length === 1,
          message: `expected one durable judge generation, observed ${judgeArtifacts.length}`,
        },
        {
          ok: (after.totals.usage.total_tokens ?? 0) > before,
          message: `judge tokens were omitted from totals (${before} -> ${after.totals.usage.total_tokens ?? 0})`,
        },
      ]);
    },
  },
  {
    name: "cache telemetry never persists an empty cache identity",
    run: async () => {
      const config = regressionConfig("cache-key");
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init("v4.5.4 cache identity", "operator", []);
      const cached = fixturePeer("grok", "READY");
      cached.usage = {
        ...(cached.usage as TokenUsage),
        cache_read_tokens: 32,
        cache_write_tokens: 0,
        cache_provider_mode: "auto",
      };
      const recorder = orchestrator as unknown as {
        recordCacheTelemetry: (
          sessionId: string,
          round: number,
          peerResult: PeerResult,
        ) => Promise<void>;
      };
      assert.equal(typeof recorder.recordCacheTelemetry, "function");
      await recorder.recordCacheTelemetry(session.session_id, 1, cached);
      const manifest = readCacheManifest(config.data_dir, session.session_id);
      const entry = manifest?.entries[0] as unknown as Record<string, unknown> | undefined;
      const keyHash = entry?.cache_key_hash;
      const unavailableReason = entry?.cache_key_unavailable_reason ?? entry?.unavailable_reason;
      const hasRealHash = typeof keyHash === "string" && /^[0-9a-f]{64}$/i.test(keyHash);
      const explicitlyUnavailable =
        keyHash === null &&
        typeof unavailableReason === "string" &&
        unavailableReason.trim() !== "";
      assert.ok(
        hasRealHash || explicitlyUnavailable,
        `cache identity must be sha256 or null+reason; got hash=${JSON.stringify(keyHash)} reason=${JSON.stringify(unavailableReason)}`,
      );
    },
  },
  {
    name: "failed judge calls persist billable usage and cost",
    run: async () => {
      const fixture = await seededJudgeFixture("judge-failure-ledger", "gemini");
      fixture.orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        const error = new Error("fixture judge terminal failure") as Error & {
          usage?: TokenUsage;
          cost?: PeerResult["cost"];
          accounted_attempts?: number;
        };
        error.usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };
        error.cost = {
          currency: "USD",
          estimated: false,
          source: "configured-rate",
          total_cost: 0.25,
        };
        error.accounted_attempts = 1;
        throw error;
      };
      const result = await fixture.orchestrator.runEvidenceChecklistJudgePass({
        session_id: fixture.session_id,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      assert.equal(result.skipped[0]?.reason, "judge_failed");
      const meta = fixture.orchestrator.store.read(fixture.session_id);
      const failure = meta.failed_attempts?.find((item) => item.peer === "claude");
      assert.equal(failure?.cost?.total_cost, 0.25);
      assert.equal(meta.totals.cost.total_cost, 0.25);
      assert.ok(
        fs
          .readdirSync(
            path.join(fixture.orchestrator.store.sessionDir(fixture.session_id), "agent-runs"),
          )
          .some((name) => name.includes("judge-") && name.includes("failure")),
      );
    },
  },
  {
    name: "persisted per-call ceiling blocks single and consensus judges before dispatch",
    run: async () => {
      const single = await seededJudgeFixture("single-persisted-ceiling", "gemini");
      single.orchestrator.config.cost_rates.claude = {
        input_per_million: 1,
        output_per_million: 1,
      };
      await single.orchestrator.store.setSessionTraceability(single.session_id, {
        requested_max_rounds: 1,
        effective_max_rounds: 1,
        requested_max_cost_usd: 0.000001,
        effective_cost_ceiling_usd: 0.000001,
        cost_ceiling_source: "call_arg",
      });
      let singleCalls = 0;
      single.orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        singleCalls += 1;
        throw new Error("single judge should not dispatch");
      };
      await assert.rejects(
        () =>
          single.orchestrator.runEvidenceChecklistJudgePass({
            session_id: single.session_id,
            judge_peer: "claude",
            draft: "fixture draft",
          }),
        /evidence_judge_budget_preflight/,
      );

      const consensus = await seededJudgeFixture("consensus-persisted-ceiling", "codex");
      consensus.orchestrator.config.cost_rates.claude = {
        input_per_million: 1,
        output_per_million: 1,
      };
      consensus.orchestrator.config.cost_rates.gemini = {
        input_per_million: 1,
        output_per_million: 1,
      };
      await consensus.orchestrator.store.setSessionTraceability(consensus.session_id, {
        requested_max_rounds: 1,
        effective_max_rounds: 1,
        requested_max_cost_usd: 0.000001,
        effective_cost_ceiling_usd: 0.000001,
        cost_ceiling_source: "call_arg",
      });
      let consensusCalls = 0;
      for (const peer of ["claude", "gemini"] as const) {
        consensus.orchestrator.adapters[peer].judgeEvidenceAsk = async () => {
          consensusCalls += 1;
          throw new Error("consensus judge should not dispatch");
        };
      }
      await assert.rejects(
        () =>
          consensus.orchestrator.runEvidenceChecklistJudgeConsensusPass({
            session_id: consensus.session_id,
            judge_peers: ["claude", "gemini"],
            draft: "fixture draft",
          }),
        /evidence_judge_budget_preflight/,
      );
      assert.equal(singleCalls, 0);
      assert.equal(consensusCalls, 0);
    },
  },
  {
    name: "session report keeps rounds under Peer Decisions and shows the full status chain",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("decision-report"),
        () => {},
      );
      const session = await orchestrator.store.init("v4.5.4 decision trace", "operator", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "gemini", ask: "Keep the evidence section visible in this report fixture." },
      ]);
      const peer = Object.assign(fixturePeer("gemini", "NEEDS_EVIDENCE"), {
        raw_status: "READY",
        parsed_status: "READY",
        normalized_status: "NEEDS_EVIDENCE",
        decision_transformations: [
          {
            stage: "grounding",
            from: "READY",
            to: "NEEDS_EVIDENCE",
            reasons: ["ready_evidence_sources_ungrounded"],
          },
        ],
      });
      const convergence = checkConvergence(["gemini"], "READY", [peer], []);
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [peer],
        rejected: [],
        convergence,
        convergence_scope: {
          caller: "operator",
          caller_status: "READY",
          expected_peers: ["gemini"],
          reviewer_peers: ["gemini"],
        },
        started_at: new Date().toISOString(),
      });
      const markdown = sessionReportMarkdown(orchestrator.store.read(session.session_id), []);
      const start = markdown.indexOf("## Peer Decisions");
      const nextHeading = start < 0 ? -1 : markdown.indexOf("\n## ", start + 4);
      const peerSection =
        start < 0 ? "" : markdown.slice(start, nextHeading < 0 ? markdown.length : nextHeading);
      expectAll([
        {
          ok: peerSection.includes("### Round 1"),
          message: "Round 1 is outside the Peer Decisions section",
        },
        {
          ok: /raw[_ ]status/i.test(peerSection) && /READY/.test(peerSection),
          message: "raw_status=READY is absent from Peer Decisions",
        },
        {
          ok: /parsed[_ ]status/i.test(peerSection) && /READY/.test(peerSection),
          message: "parsed_status=READY is absent from Peer Decisions",
        },
        {
          ok: /normalized[_ ]status/i.test(peerSection) && /NEEDS_EVIDENCE/.test(peerSection),
          message: "normalized_status=NEEDS_EVIDENCE is absent from Peer Decisions",
        },
      ]);
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];

for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.4-judge-cost] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.4-judge-cost] FAIL: ${regression.name}\n  ${message}`);
  }
}

for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      regressions: regressions.length,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exitCode = 1;
