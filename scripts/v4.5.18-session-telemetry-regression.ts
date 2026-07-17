import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import type { AppConfig, PeerId, RuntimeEvent } from "../src/core/types.js";
import { PEERS } from "../src/core/types.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const tempDirs: string[] = [];

function fixtureConfig(label: string): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v4518-${label}-`));
  tempDirs.push(dataDir);
  return {
    ...base,
    stub: true,
    data_dir: dataDir,
    peer_enabled: Object.fromEntries(PEERS.map((peer) => [peer, true])) as Record<PeerId, boolean>,
    cost_rates: Object.fromEntries(
      PEERS.map((peer) => [
        peer,
        peer === "perplexity"
          ? {
              input_per_million: 0,
              output_per_million: 0,
              request_fee_low_per_1000: 0,
              request_fee_medium_per_1000: 0,
              request_fee_high_per_1000: 0,
            }
          : { input_per_million: 0, output_per_million: 0 },
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

type Regression = { name: string; run: () => void | Promise<void> };

const regressions: Regression[] = [
  {
    name: "session persists a redacted effective-config snapshot and digest",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(fixtureConfig("config-snapshot"), () => {});
      const session = await orchestrator.store.init("config snapshot", "operator", []);
      const meta = orchestrator.store.read(session.session_id) as unknown as {
        effective_config_snapshot?: Record<string, unknown>;
        effective_config_sha256?: string;
      };
      assert.match(meta.effective_config_sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.ok(meta.effective_config_snapshot, "effective config snapshot is absent");
      assert.deepEqual(
        {
          models: meta.effective_config_snapshot?.models,
          reasoning_effort: meta.effective_config_snapshot?.reasoning_effort,
          retry: meta.effective_config_snapshot?.retry,
          evidence_judge_autowire: meta.effective_config_snapshot?.evidence_judge_autowire,
          cost_rates: meta.effective_config_snapshot?.cost_rates,
        },
        {
          models: orchestrator.config.models,
          reasoning_effort: orchestrator.config.reasoning_effort,
          retry: orchestrator.config.retry,
          evidence_judge_autowire: orchestrator.config.evidence_judge_autowire,
          cost_rates: orchestrator.config.cost_rates,
        },
      );
      assert.equal(
        Object.hasOwn(meta.effective_config_snapshot ?? {}, "api_keys"),
        false,
        "credential material must never enter session metadata",
      );
    },
  },
  {
    name: "unanimous negative judges are classified as unsatisfied, not disagreement",
    run: async () => {
      const events: RuntimeEvent[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        fixtureConfig("consensus-taxonomy"),
        (event) => events.push(event),
      );
      const session = await orchestrator.store.init("consensus taxonomy", "operator", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "codex", ask: "Provide the exact fixture evidence." },
      ]);
      const result = await orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: session.session_id,
        judge_peers: ["codex", "claude", "gemini"],
        draft: "FORCE_JUDGE_UNKNOWN",
        mode: "shadow",
      });
      assert.equal(result.consensus_decisions[0]?.reason, "consensus_unsatisfied");
      assert.equal(result.skipped[0]?.reason, "consensus_unsatisfied");
      assert.equal(result.shadow_decisions[0]?.reason, "consensus_unsatisfied");
      const started = events.find(
        (event) => event.type === "session.evidence_judge_consensus_pass.started",
      );
      assert.match(started?.message ?? "", /configured/i);
      assert.deepEqual(
        (started?.data as { configured_judge_peers?: PeerId[] } | undefined)
          ?.configured_judge_peers,
        ["codex", "claude", "gemini"],
      );
      const decision = events.find(
        (event) => event.type === "session.evidence_judge_pass.shadow_decision",
      );
      const shadowData = decision?.data as
        | {
            judge_peer?: PeerId;
            judge_peers?: PeerId[];
            per_peer_verdict?: Record<string, string>;
          }
        | undefined;
      assert.equal(decision?.peer, undefined);
      assert.equal(shadowData?.judge_peer, undefined);
      assert.deepEqual(shadowData?.judge_peers, ["claude", "gemini"]);
      assert.deepEqual(shadowData?.per_peer_verdict, {
        claude: "disagree",
        gemini: "disagree",
      });
    },
  },
  {
    name: "active consensus keeps legacy attribution only for a real promotion",
    run: async () => {
      const events: RuntimeEvent[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        fixtureConfig("consensus-active-attribution"),
        (event) => events.push(event),
      );
      const session = await orchestrator.store.init("consensus active attribution", "operator", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "codex", ask: "Provide the exact fixture evidence." },
      ]);
      const result = await orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: session.session_id,
        judge_peers: ["codex", "claude", "gemini"],
        draft: "FORCE_JUDGE_SATISFIED",
        mode: "active",
      });
      assert.equal(result.promoted.length, 1);
      const promotion = events.find(
        (event) => event.type === "session.evidence_checklist_addressed",
      );
      const promotionData = promotion?.data as
        | {
            judge_peer?: PeerId;
            judge_peers?: PeerId[];
            per_peer_verdict?: Record<string, string>;
          }
        | undefined;
      assert.equal(promotionData?.judge_peer, "claude");
      assert.deepEqual(promotionData?.judge_peers, ["claude", "gemini"]);
      assert.deepEqual(promotionData?.per_peer_verdict, {
        claude: "verified_satisfied",
        gemini: "verified_satisfied",
      });
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.18-session-telemetry] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.18-session-telemetry] FAIL: ${regression.name}\n  ${message}`);
  }
}

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

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
