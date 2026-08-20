// v4.5.41 regression: terminal provider failures without observed work settle
// as zero spend instead of permanently poisoning the session budget gates.
//
// Contract under test (issue #211): a durable terminal provider outcome that
// reported no usage and no cost (quota skip, capacity rejection, immediate
// provider error) bills nothing and must not block later generation or judge
// passes as "unpriced or still unsettled" spend. Spend stays indeterminate —
// and keeps blocking — only when the attempt's outcome never became durable:
// network/timeout/stream_buffer_overflow/unknown failure classes and
// interrupted-attempt records stamped with the
// `possible_provider_attempt_interrupted` message sentinel.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator, mergeFailureChain } from "../src/core/orchestrator.js";
import type {
  AppConfig,
  EvidenceAskJudgment,
  GenerationResult,
  PeerAdapter,
  PeerFailure,
  PeerId,
} from "../src/core/types.js";

process.env.CROSS_REVIEW_STUB = "1";
const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const tempDirs: string[] = [];

function fixtureConfig(label: string): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v4541-${label}-`));
  tempDirs.push(dataDir);
  return {
    ...base,
    stub: true,
    data_dir: dataDir,
    peer_enabled: Object.fromEntries(
      (Object.keys(base.peer_enabled) as PeerId[]).map((peer) => [peer, true]),
    ) as AppConfig["peer_enabled"],
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
    cost_rates: {
      ...base.cost_rates,
      claude: { input_per_million: 1, output_per_million: 1 },
      gemini: { input_per_million: 1, output_per_million: 1 },
    },
  };
}

function terminalCapacityFailure(): PeerFailure {
  // Shape observed in production (issue #211, session 00700538): the provider
  // answered with a durable capacity rejection before generating anything —
  // no usage, no cost, no billing_status on the record.
  return {
    peer: "grok",
    provider: "fixture-provider",
    model: "fixture-model",
    failure_class: "provider_error",
    message: "fixture: provider is at capacity, request rejected before generation",
    retryable: false,
    attempts: 1,
    latency_ms: 560,
  };
}

interface GenerationHarness {
  orchestrator: CrossReviewOrchestrator;
  sessionId: string;
  adapter: PeerAdapter;
  calls: () => number;
}

async function generationHarness(label: string): Promise<GenerationHarness> {
  const orchestrator = new CrossReviewOrchestrator(fixtureConfig(label), () => {});
  const session = await orchestrator.store.init(`v4.5.41 ${label}`, "operator", []);
  let calls = 0;
  const adapter: PeerAdapter = {
    ...orchestrator.adapters.claude,
    generate: async (): Promise<GenerationResult> => {
      calls += 1;
      throw new Error("generation_dispatched_past_preflight");
    },
  };
  return { orchestrator, sessionId: session.session_id, adapter, calls: () => calls };
}

async function runGeneration(harness: GenerationHarness): Promise<void> {
  const generate = harness.orchestrator as unknown as {
    generateWithFailureAccounting(
      target: PeerAdapter,
      prompt: string,
      context: { session_id: string; round: number; task: string; emit: () => void },
      label: string,
    ): Promise<GenerationResult>;
  };
  await generate.generateWithFailureAccounting(
    harness.adapter,
    "paid generation",
    { session_id: harness.sessionId, round: 1, task: "fixture", emit: () => {} },
    "fixture",
  );
}

function judgment(peer: PeerId = "claude"): EvidenceAskJudgment {
  return {
    peer,
    provider: "fixture-provider",
    model: "fixture-model",
    satisfied: false,
    confidence: "verified",
    rationale: "The requested evidence is not present.",
    raw: { fixture: true },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    cost: { currency: "USD", estimated: false, source: "configured-rate", total_cost: 0 },
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
  };
}

type Regression = { name: string; run: () => void | Promise<void> };

const regressions: Regression[] = [
  {
    name: "terminal-provider-error-without-usage-settles-as-zero-and-generation-proceeds",
    run: async () => {
      const harness = await generationHarness("terminal-error");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        terminalCapacityFailure(),
        "capacity-rejection",
      );
      await assert.rejects(() => runGeneration(harness), /generation_dispatched_past_preflight/);
      assert.equal(
        harness.calls(),
        1,
        "generation stayed blocked by a zero-billed terminal provider failure",
      );
    },
  },
  {
    name: "priced-result-with-unpriced-terminal-retry-does-not-block-generation",
    run: async () => {
      // Shape observed in production: a peer whose final attempt settled with
      // a priced cost after an earlier terminal failed attempt that reported
      // no usage (merged accounting stamps unpriced_attempts > 0).
      const harness = await generationHarness("priced-with-retry");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          peer: "perplexity",
          message: "fixture: first attempt rejected terminally, second attempt priced",
          attempts: 2,
          unpriced_attempts: 1,
          billing_status: "reported",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          cost: { currency: "USD", estimated: false, source: "configured-rate", total_cost: 0.5 },
        },
        "priced-with-unpriced-retry",
      );
      await assert.rejects(() => runGeneration(harness), /generation_dispatched_past_preflight/);
      assert.equal(
        harness.calls(),
        1,
        "generation stayed blocked by a priced result carrying a zero-billed retry",
      );
    },
  },
  {
    name: "timeout-attempt-without-usage-still-blocks-generation",
    run: async () => {
      const harness = await generationHarness("timeout-blocks");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          failure_class: "timeout",
          message: "fixture: client-side abort mid-call; provider-side spend indeterminate",
        },
        "timeout-attempt",
      );
      await assert.rejects(() => runGeneration(harness), /generation_budget_preflight/);
      assert.equal(harness.calls(), 0, "generation dispatched despite indeterminate timeout spend");
    },
  },
  {
    name: "interrupted-attempt-sentinel-still-blocks-generation",
    run: async () => {
      const harness = await generationHarness("interrupted-blocks");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          message:
            "possible_provider_attempt_interrupted: fixture; round 1 ended without a durable provider result.",
          billing_status: "unknown",
          unpriced_attempts: 1,
        },
        "interrupted-attempt",
      );
      await assert.rejects(() => runGeneration(harness), /generation_budget_preflight/);
      assert.equal(harness.calls(), 0, "generation dispatched despite interrupted-attempt spend");
    },
  },
  {
    name: "mixed-chain-merge-preserves-indeterminate-attempts",
    run: () => {
      // A merged chain keeps only the last failure's class; without a
      // dedicated marker, [timeout, provider_error] would settle as zero and
      // under-count a client-side abort the provider may have billed.
      const timeoutFailure: PeerFailure = {
        ...terminalCapacityFailure(),
        failure_class: "timeout",
        message: "fixture: first attempt aborted client-side",
      };
      const merged = mergeFailureChain([timeoutFailure, terminalCapacityFailure()]);
      assert.equal(merged.failure_class, "provider_error", "merge must keep the last class");
      assert.equal(
        merged.indeterminate_spend_attempts,
        1,
        "the indeterminate timeout attempt must survive the merge as a spend marker",
      );
    },
  },
  {
    name: "merged-record-with-indeterminate-attempts-still-blocks-generation",
    run: async () => {
      const harness = await generationHarness("mixed-chain-blocks");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          message: "fixture: merged chain ending in a terminal rejection",
          attempts: 2,
          unpriced_attempts: 2,
          billing_status: "unknown",
          indeterminate_spend_attempts: 1,
        },
        "mixed-chain",
      );
      await assert.rejects(() => runGeneration(harness), /generation_budget_preflight/);
      assert.equal(
        harness.calls(),
        0,
        "generation dispatched despite an indeterminate attempt inside a merged chain",
      );
    },
  },
  {
    name: "evidence-judge-pass-proceeds-after-terminal-provider-error-without-usage",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(fixtureConfig("judge-proceeds"), () => {});
      const session = await orchestrator.store.init("v4.5.41 judge-proceeds", "operator", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "gemini", ask: "Provide exact raw test output." },
      ]);
      await orchestrator.store.recordPeerFailureAccounting(
        session.session_id,
        1,
        terminalCapacityFailure(),
        "capacity-rejection",
      );
      let calls = 0;
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        calls += 1;
        return judgment();
      };
      await orchestrator.runEvidenceChecklistJudgePass({
        session_id: session.session_id,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      assert.equal(
        calls,
        1,
        "judge pass stayed blocked by a zero-billed terminal provider failure",
      );
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.41-spend-settlement] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.41-spend-settlement] FAIL: ${regression.name}\n${message}`);
  }
}

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
if (previousStubConfirmation === undefined) delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
else process.env.CROSS_REVIEW_STUB_CONFIRMED = previousStubConfirmation;

console.log(
  JSON.stringify(
    {
      total: regressions.length,
      passed: regressions.length - failures.length,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exit(1);
