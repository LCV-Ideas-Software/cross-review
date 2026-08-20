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
import {
  CrossReviewOrchestrator,
  mergeFailureChain,
  mergePeerResultWithFailures,
} from "../src/core/orchestrator.js";
import type {
  AppConfig,
  EvidenceAskJudgment,
  GenerationResult,
  PeerAdapter,
  PeerFailure,
  PeerId,
  PeerResult,
} from "../src/core/types.js";
import { classifyProviderError } from "../src/peers/errors.js";
import { withRetry } from "../src/peers/retry.js";

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
      // All-terminal chains must stamp the marker explicitly (as zero): its
      // presence distinguishes a new-format record from a legacy one, and
      // legacy merged records stay conservatively blocking.
      const allTerminal = mergeFailureChain([terminalCapacityFailure(), terminalCapacityFailure()]);
      assert.equal(
        allTerminal.indeterminate_spend_attempts,
        0,
        "an all-terminal merged chain must carry the marker stamped as zero",
      );
    },
  },
  {
    name: "producers-stamp-the-indeterminate-marker-alongside-unpriced-attempts",
    run: () => {
      // Production evidence (session 9dbeef72, PR #214 gate): a single-attempt
      // auth skip was stamped with unpriced_attempts and unknown billing but
      // no indeterminate marker — indistinguishable from a legacy record, so
      // the classifier's legacy fail-closed rule blocked generation forever.
      // Every producer that stamps unpriced_attempts must stamp the marker.
      const authError = Object.assign(new Error("403 Forbidden: spend cap breached"), {
        status: 403,
      });
      const authFailure = classifyProviderError(
        "gemini",
        "google",
        "fixture-model",
        authError,
        1,
        Date.now(),
      );
      assert.equal(authFailure.unpriced_attempts, 1, "auth skip must stay unpriced");
      assert.equal(
        authFailure.indeterminate_spend_attempts,
        0,
        "a terminal auth skip must stamp an explicit zero marker",
      );
      const networkError = new Error("fetch failed: network connection lost");
      const networkFailure = classifyProviderError(
        "grok",
        "xai",
        "fixture-model",
        networkError,
        1,
        Date.now(),
      );
      assert.equal(networkFailure.failure_class, "network", "fixture must classify as network");
      assert.equal(
        networkFailure.indeterminate_spend_attempts,
        networkFailure.unpriced_attempts,
        "an indeterminate-class failure must stamp its unpriced attempts as indeterminate",
      );
    },
  },
  {
    name: "retry-aggregation-preserves-indeterminate-attempts-of-earlier-tries",
    run: async () => {
      // Review finding (session f131f43f, codex): the retry wrapper derived
      // the marker for the AGGREGATED unpriced attempts solely from the final
      // failure's class/message — a chain of [timeout, auth] settled the
      // timeout try as zero. Each failed try must contribute its own
      // indeterminate share to the aggregate marker.
      const config = fixtureConfig("retry-aggregation");
      config.retry = { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 };
      let attemptNo = 0;
      let caught: unknown;
      try {
        await withRetry(
          config,
          async () => {
            attemptNo += 1;
            if (attemptNo === 1) {
              throw new Error("Request timeout");
            }
            throw Object.assign(new Error("403 Forbidden: spend cap breached"), { status: 403 });
          },
          (error, attempt, startedAt) =>
            classifyProviderError("gemini", "google", "fixture-model", error, attempt, startedAt),
        );
      } catch (error) {
        caught = error;
      }
      const failure = (caught as { peerFailure?: PeerFailure } | undefined)?.peerFailure;
      assert.ok(failure, "withRetry must attach the aggregated failure");
      assert.equal(failure?.unpriced_attempts, 2, "both tries must stay unpriced");
      assert.equal(
        failure?.indeterminate_spend_attempts,
        1,
        "the earlier timeout try must survive aggregation as indeterminate",
      );
      // A SUCCESS after an indeterminate failed try must carry the same
      // per-try share on the result: the settlement writer derives an
      // unknown billing status from unpriced_attempts, so a result without
      // the marker would persist the legacy fail-closed trio.
      const cfg2 = fixtureConfig("retry-aggregation-result");
      cfg2.retry = { ...cfg2.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 };
      let tries = 0;
      const result = await withRetry(
        cfg2,
        async () => {
          tries += 1;
          if (tries === 1) throw new Error("Request timeout");
          return { unpriced_attempts: 1 } as { unpriced_attempts?: number } & {
            indeterminate_spend_attempts?: number;
          };
        },
        (error, attempt, startedAt) =>
          classifyProviderError("gemini", "google", "fixture-model", error, attempt, startedAt),
      );
      assert.equal(
        result.indeterminate_spend_attempts,
        1,
        "a success after an indeterminate try must stamp the per-try share on the result",
      );
      // Round-2 grok finding: a PRICED success whose shape declares no
      // unpriced_attempts of its own must still persist the wrapper-observed
      // shares — deleting both fields dropped the earlier indeterminate try.
      const cfg3 = fixtureConfig("retry-aggregation-priced-success");
      cfg3.retry = { ...cfg3.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 };
      let tries3 = 0;
      const pricedResult = await withRetry(
        cfg3,
        async () => {
          tries3 += 1;
          if (tries3 === 1) throw new Error("Request timeout");
          return {
            cost: { currency: "USD", estimated: false, source: "configured-rate", total_cost: 0.2 },
          } as {
            cost?: unknown;
            unpriced_attempts?: number;
            indeterminate_spend_attempts?: number;
          };
        },
        (error, attempt, startedAt) =>
          classifyProviderError("gemini", "google", "fixture-model", error, attempt, startedAt),
      );
      assert.equal(
        pricedResult.unpriced_attempts,
        1,
        "the wrapper-observed unpriced try must persist on a priced success",
      );
      assert.equal(
        pricedResult.indeterminate_spend_attempts,
        1,
        "the earlier indeterminate try must persist on a priced success",
      );
      // Round-7 codex finding (session f131f43f): a result that arrives with
      // its OWN positive marker (adapter-stamped) must keep it when no
      // wrapper-level prior try exists — replacing it solely from priorSpend
      // rewrote a positive marker as an explicit zero, fail-opening spend.
      const cfg4 = fixtureConfig("retry-aggregation-adapter-stamped-result");
      cfg4.retry = { ...cfg4.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 };
      const stampedResult = await withRetry(
        cfg4,
        async () =>
          ({
            unpriced_attempts: 1,
            indeterminate_spend_attempts: 1,
          }) as { unpriced_attempts?: number; indeterminate_spend_attempts?: number },
        (error, attempt, startedAt) =>
          classifyProviderError("gemini", "google", "fixture-model", error, attempt, startedAt),
      );
      assert.equal(
        stampedResult.unpriced_attempts,
        1,
        "an adapter-declared unpriced attempt must persist without wrapper tries",
      );
      assert.equal(
        stampedResult.indeterminate_spend_attempts,
        1,
        "an adapter-stamped positive marker must survive the wrapper merger",
      );
    },
  },
  {
    name: "re-merging-legacy-links-preserves-their-fail-closed-state",
    run: () => {
      // Round-3 findings (session 6fae863d): a legacy merged link (explicit
      // unpriced attempts, unknown billing, no marker) must contribute its
      // unpriced attempts as indeterminate when merged again — otherwise the
      // re-merge stamps a marker of zero and hidden indeterminate spend
      // becomes new-format settled spend. A missing message on a legacy
      // record must not crash the merge either.
      const legacyMergedLink: PeerFailure = {
        ...terminalCapacityFailure(),
        message: "fixture: legacy merged chain persisted before the marker existed",
        attempts: 2,
        unpriced_attempts: 2,
        billing_status: "unknown",
      };
      const remerged = mergeFailureChain([legacyMergedLink, terminalCapacityFailure()]);
      assert.equal(
        remerged.indeterminate_spend_attempts,
        2,
        "re-merging a legacy link must carry its unpriced attempts as indeterminate",
      );
      const messagelessLegacy = {
        ...legacyMergedLink,
        message: undefined,
      } as unknown as PeerFailure;
      const guarded = mergeFailureChain([messagelessLegacy, terminalCapacityFailure()]);
      assert.equal(
        guarded.indeterminate_spend_attempts,
        2,
        "a legacy record without a message must merge without crashing and stay conservative",
      );
      const legacyResult: PeerResult = {
        peer: "perplexity",
        provider: "fixture-provider",
        model: "fixture-model",
        status: "READY",
        structured: {
          status: "READY",
          summary: "No blocking objections remain.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: [],
          follow_ups: [],
        },
        text: "fixture",
        raw: {},
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        cost: { currency: "USD", estimated: false, source: "configured-rate", total_cost: 0.5 },
        latency_ms: 1,
        attempts: 2,
        unpriced_attempts: 1,
        parser_warnings: [],
        decision_quality: "clean",
      };
      const remergedResult = mergePeerResultWithFailures(legacyResult, [terminalCapacityFailure()]);
      assert.equal(
        remergedResult.indeterminate_spend_attempts,
        1,
        "a legacy priced result with hidden unpriced spend must stay indeterminate on re-merge",
      );
    },
  },
  {
    name: "legacy-merged-record-without-marker-stays-blocked",
    run: async () => {
      // Review finding (session c47016e4, codex): a legacy merged record has
      // no indeterminate_spend_attempts marker, so its earlier links' classes
      // are unrecoverable — an explicit unknown billing marker must keep its
      // conservative fail-closed meaning.
      const harness = await generationHarness("legacy-merged-blocks");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          message: "fixture: legacy merged chain persisted before the marker existed",
          attempts: 2,
          unpriced_attempts: 2,
          billing_status: "unknown",
        },
        "legacy-merged-chain",
      );
      await assert.rejects(() => runGeneration(harness), /generation_budget_preflight/);
      assert.equal(
        harness.calls(),
        0,
        "generation dispatched on a legacy merged record whose links are unrecoverable",
      );
    },
  },
  {
    name: "new-format-all-terminal-merged-chain-settles-zero",
    run: async () => {
      const harness = await generationHarness("new-format-settles");
      await harness.orchestrator.store.recordPeerFailureAccounting(
        harness.sessionId,
        1,
        {
          ...terminalCapacityFailure(),
          message: "fixture: post-fix merged chain of terminal rejections",
          attempts: 2,
          unpriced_attempts: 2,
          billing_status: "unknown",
          indeterminate_spend_attempts: 0,
        },
        "new-format-terminal-chain",
      );
      await assert.rejects(() => runGeneration(harness), /generation_dispatched_past_preflight/);
      assert.equal(
        harness.calls(),
        1,
        "generation stayed blocked by a marker-stamped all-terminal merged chain",
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
