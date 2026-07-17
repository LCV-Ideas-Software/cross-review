import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCacheManifest } from "../src/core/cache-manifest.js";
import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import type {
  AppConfig,
  EvidenceAskJudgment,
  GenerationResult,
  PeerAdapter,
  PeerId,
} from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const tempDirs: string[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function fixtureConfig(label: string): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v4518-${label}-`));
  tempDirs.push(dataDir);
  return {
    ...base,
    stub: true,
    data_dir: dataDir,
    cache: { ...base.cache, enabled: true },
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
    },
  };
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
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_read_tokens: 7,
      cache_write_tokens: 11,
      cache_provider_mode: "explicit",
      cache_key_hash: "a".repeat(64),
    },
    cost: {
      currency: "USD",
      estimated: false,
      source: "configured-rate",
      total_cost: 0,
    },
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
  };
}

async function seededJudge(label: string) {
  const orchestrator = new CrossReviewOrchestrator(fixtureConfig(label), () => {});
  const session = await orchestrator.store.init(`v4.5.18 ${label}`, "operator", []);
  await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
    { peer: "gemini", ask: "Provide exact raw test output." },
  ]);
  return { orchestrator, sessionId: session.session_id };
}

type Regression = { name: string; run: () => void | Promise<void> };

const regressions: Regression[] = [
  {
    name: "judge budget includes the paid round that is still in flight",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("pending-round-cost");
      await orchestrator.store.setSessionTraceability(sessionId, {
        requested_max_rounds: 1,
        effective_max_rounds: 1,
        requested_max_cost_usd: 10,
        effective_cost_ceiling_usd: 10,
        cost_ceiling_source: "call_arg",
      });
      let calls = 0;
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        calls += 1;
        return judgment();
      };
      const judge = orchestrator.runEvidenceChecklistJudgePass.bind(orchestrator) as (
        params: Parameters<typeof orchestrator.runEvidenceChecklistJudgePass>[0] & {
          pending_round_cost_usd: number;
        },
      ) => ReturnType<typeof orchestrator.runEvidenceChecklistJudgePass>;
      await assert.rejects(
        () =>
          judge({
            session_id: sessionId,
            judge_peer: "claude",
            draft: "fixture draft",
            pending_round_cost_usd: 11,
          }),
        /evidence_judge_budget_preflight/,
      );
      assert.equal(
        calls,
        0,
        "judge dispatched despite round-in-flight already exhausting the ceiling",
      );
    },
  },
  {
    name: "judge budget does not count durable in-flight settlements twice",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("settlement-not-double-counted");
      await orchestrator.store.setSessionTraceability(sessionId, {
        requested_max_rounds: 1,
        effective_max_rounds: 1,
        requested_max_cost_usd: 10,
        effective_cost_ceiling_usd: 10,
        cost_ceiling_source: "call_arg",
      });
      await orchestrator.store.markInFlight(sessionId, {
        round: 1,
        peers: ["gemini"],
        started_at: new Date().toISOString(),
        scope: {
          petitioner: "operator",
          caller: "operator",
          acting_peer: "operator",
          caller_status: "READY",
          expected_peers: ["gemini"],
          reviewer_peers: ["gemini"],
        },
      });
      const settled = await new StubAdapter(orchestrator.config, "gemini").call(
        "Stable fixture result.",
        {
          session_id: sessionId,
          round: 1,
          task: "settlement budget fixture",
          emit: () => {},
        },
      );
      settled.cost = {
        currency: "USD",
        estimated: false,
        source: "configured-rate",
        total_cost: 6,
      };
      await orchestrator.store.saveInFlightPeerResult(sessionId, 1, settled);

      let calls = 0;
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        calls += 1;
        return judgment();
      };
      await orchestrator.runEvidenceChecklistJudgePass({
        session_id: sessionId,
        judge_peer: "claude",
        draft: "fixture draft",
        pending_round_cost_usd: 6,
      });
      assert.equal(
        calls,
        1,
        "the already-durable $6 settlement was added twice and falsely exhausted the $10 ceiling",
      );
    },
  },
  {
    name: "judge budget fails closed for historical unpriced provider attempts",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("historical-unpriced");
      await orchestrator.store.recordPeerFailureAccounting(
        sessionId,
        0,
        {
          peer: "gemini",
          provider: "fixture-provider",
          model: "fixture-model",
          failure_class: "unknown",
          message: "Historical provider attempt has no complete rate card.",
          retryable: false,
          attempts: 1,
          latency_ms: 1,
          billing_status: "unknown",
          unpriced_attempts: 1,
        },
        "historical-unpriced",
      );
      let calls = 0;
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        calls += 1;
        return judgment();
      };
      await assert.rejects(
        () =>
          orchestrator.runEvidenceChecklistJudgePass({
            session_id: sessionId,
            judge_peer: "claude",
            draft: "fixture draft",
          }),
        /evidence_judge_budget_preflight/,
      );
      assert.equal(calls, 0, "judge dispatched despite unknown historical provider spend");
    },
  },
  {
    name: "generation budget preflight preserves the published max-rounds budget outcome",
    run: async () => {
      const config = fixtureConfig("generation-budget-outcome");
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init("v4.5.18 generation budget", "operator", []);
      await orchestrator.store.setSessionTraceability(session.session_id, {
        requested_max_rounds: 1,
        effective_max_rounds: 1,
        requested_max_cost_usd: 0,
        effective_cost_ceiling_usd: 0,
        cost_ceiling_source: "call_arg",
      });
      let calls = 0;
      const adapter: PeerAdapter = {
        ...orchestrator.adapters.claude,
        generate: async (): Promise<GenerationResult> => {
          calls += 1;
          throw new Error("generation must not dispatch");
        },
      };
      const generate = orchestrator as unknown as {
        generateWithFailureAccounting(
          target: PeerAdapter,
          prompt: string,
          context: {
            session_id: string;
            round: number;
            task: string;
            emit: () => void;
          },
          label: string,
        ): Promise<GenerationResult>;
      };
      await assert.rejects(
        () =>
          generate.generateWithFailureAccounting(
            adapter,
            "paid generation",
            {
              session_id: session.session_id,
              round: 1,
              task: "fixture",
              emit: () => {},
            },
            "fixture",
          ),
        /generation_budget_preflight/,
      );
      const meta = orchestrator.store.read(session.session_id);
      assert.equal(calls, 0);
      assert.equal(meta.outcome, "max-rounds");
      assert.equal(meta.outcome_reason, "generation_budget_preflight");
    },
  },
  {
    name: "generation budget fails closed for historical unpriced provider attempts",
    run: async () => {
      const config = fixtureConfig("generation-historical-unpriced");
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init(
        "v4.5.18 unknown generation budget",
        "operator",
        [],
      );
      await orchestrator.store.recordPeerFailureAccounting(
        session.session_id,
        0,
        {
          peer: "gemini",
          provider: "fixture-provider",
          model: "fixture-model",
          failure_class: "unknown",
          message: "Historical provider attempt has no complete rate card.",
          retryable: false,
          attempts: 1,
          latency_ms: 1,
          billing_status: "unknown",
          unpriced_attempts: 1,
        },
        "historical-unpriced",
      );
      let calls = 0;
      const adapter: PeerAdapter = {
        ...orchestrator.adapters.claude,
        generate: async (): Promise<GenerationResult> => {
          calls += 1;
          throw new Error("generation must not dispatch");
        },
      };
      const generate = orchestrator as unknown as {
        generateWithFailureAccounting(
          target: PeerAdapter,
          prompt: string,
          context: {
            session_id: string;
            round: number;
            task: string;
            emit: () => void;
          },
          label: string,
        ): Promise<GenerationResult>;
      };

      await assert.rejects(
        () =>
          generate.generateWithFailureAccounting(
            adapter,
            "paid generation",
            {
              session_id: session.session_id,
              round: 1,
              task: "fixture",
              emit: () => {},
            },
            "fixture",
          ),
        /generation_budget_preflight/,
      );
      assert.equal(calls, 0, "generation dispatched despite unknown historical provider spend");
      assert.equal(orchestrator.store.read(session.session_id).outcome, "max-rounds");
    },
  },
  {
    name: "judge cache usage is durable and distinguished in cache_manifest",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("judge-cache-manifest");
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => judgment();
      await orchestrator.runEvidenceChecklistJudgePass({
        session_id: sessionId,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      const manifest = readCacheManifest(orchestrator.config.data_dir, sessionId);
      const judgeEntry = manifest?.entries.find(
        (entry) => (entry as unknown as { call_kind?: string }).call_kind === "evidence_judge",
      ) as (Record<string, unknown> & { read_tokens?: number; write_tokens?: number }) | undefined;
      assert.ok(judgeEntry, "judge cache usage was omitted from cache_manifest");
      assert.equal(judgeEntry.read_tokens, 7);
      assert.equal(judgeEntry.write_tokens, 11);
      assert.equal(judgeEntry.call_kind, "evidence_judge");
    },
  },
  {
    name: "a paid evidence judge is reserved durably before provider dispatch",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("judge-pre-dispatch-reservation");
      const started = deferred<void>();
      const release = deferred<void>();
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        started.resolve();
        await release.promise;
        return judgment();
      };
      const pass = orchestrator.runEvidenceChecklistJudgePass({
        session_id: sessionId,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      await started.promise;
      const inFlight = orchestrator.store.read(sessionId) as unknown as {
        pending_provider_call_reservations?: Array<{ call_kind?: string }>;
      };
      assert.equal(
        inFlight.pending_provider_call_reservations?.length,
        1,
        "a crash while a judge provider call is outstanding must have a durable unknown-spend reservation",
      );
      assert.equal(
        inFlight.pending_provider_call_reservations?.[0]?.call_kind,
        "evidence_judge",
        "the durable reservation must identify the paid non-review call class",
      );
      release.resolve();
      await pass;
      assert.equal(
        (
          orchestrator.store.read(sessionId) as unknown as {
            pending_provider_call_reservations?: unknown[];
          }
        ).pending_provider_call_reservations?.length ?? 0,
        0,
        "a settled judge call must consume its dispatch reservation atomically",
      );
    },
  },
  {
    name: "a cancelled synchronous evidence judge closes its session automatically after settlement",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("judge-cancel-terminal");
      const started = deferred<void>();
      const release = deferred<void>();
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => {
        started.resolve();
        await release.promise;
        return judgment();
      };
      const pass = orchestrator.runEvidenceChecklistJudgePass({
        session_id: sessionId,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      await started.promise;
      await orchestrator.store.requestCancellation(sessionId, "test_judge_cancellation");
      release.resolve();
      await pass;
      const terminal = orchestrator.store.read(sessionId);
      assert.equal(
        terminal.outcome,
        "aborted",
        "a cancellation during a synchronous judge must not leave the session open",
      );
      assert.equal(terminal.outcome_reason, "session_cancelled");
    },
  },
  {
    name: "a cancellation between judge validation and locked promotion keeps the checklist item open",
    run: async () => {
      const { orchestrator, sessionId } = await seededJudge("judge-cancel-promotion-race");
      assert.equal(
        orchestrator.store.read(sessionId).evidence_checklist?.[0]?.status ?? "open",
        "open",
        "the seeded judge fixture must begin with the original open evidence item",
      );
      const originalPromotion = orchestrator.store.markEvidenceItemAddressedByJudge.bind(
        orchestrator.store,
      );
      const storeHarness = orchestrator.store as unknown as {
        markEvidenceItemAddressedByJudge: (
          ...args: Parameters<typeof originalPromotion>
        ) => ReturnType<typeof originalPromotion>;
      };
      storeHarness.markEvidenceItemAddressedByJudge = async (...args) => {
        // This is the exact interleaving: the orchestrator has already checked
        // cancellation, then another caller records it just before the
        // promotion obtains the session lock.
        await orchestrator.store.requestCancellation(sessionId, "test_promotion_race_cancellation");
        return originalPromotion(...args);
      };
      orchestrator.adapters.claude.judgeEvidenceAsk = async () => ({
        ...judgment(),
        satisfied: true,
        confidence: "verified",
        rationale: "The exact fixture evidence satisfies the checklist ask.",
      });

      const result = await orchestrator.runEvidenceChecklistJudgePass({
        session_id: sessionId,
        judge_peer: "claude",
        draft: "fixture draft",
      });
      const terminal = orchestrator.store.read(sessionId);
      assert.equal(
        result.promoted.length,
        0,
        "a cancellation racing promotion must not report a promoted evidence item",
      );
      assert.equal(
        terminal.evidence_checklist?.[0]?.status ?? "open",
        "open",
        "the session lock must refuse judge promotion after cancellation was persisted",
      );
      assert.equal(terminal.outcome, "aborted");
      assert.equal(terminal.outcome_reason, "session_cancelled");
    },
  },
  {
    name: "generation ledger precedes cache telemetry and uses the canonical artifact label",
    run: async () => {
      const config = fixtureConfig("generation-before-cache");
      const adapters = Object.fromEntries(
        (Object.keys(config.peer_enabled) as PeerId[]).map((peer) => [
          peer,
          new StubAdapter(config, peer),
        ]),
      ) as unknown as Record<PeerId, PeerAdapter>;
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.initSession(
        "Persist a normal generation before cache telemetry.",
        "operator",
      );
      let observedCacheLabel: string | undefined;
      const harness = orchestrator as unknown as {
        recordCacheTelemetry(
          sessionId: string,
          round: number,
          result: GenerationResult,
          callKind: string,
          callLabel?: string,
        ): Promise<void>;
      };
      harness.recordCacheTelemetry = async (_sessionId, _round, _result, _callKind, callLabel) => {
        observedCacheLabel = callLabel;
        throw new Error("simulated_cache_manifest_crash");
      };

      await assert.rejects(
        () =>
          orchestrator.runUntilUnanimous({
            session_id: session.session_id,
            task: session.task,
            caller: "operator",
            lead_peer: "claude",
            peers: ["claude", "gemini"],
            max_rounds: 1,
          }),
        /simulated_cache_manifest_crash/,
      );

      const persisted = orchestrator.store.read(session.session_id);
      assert.equal(
        persisted.generation_files?.length,
        1,
        "a cache-manifest crash must not erase the already returned provider generation",
      );
      const generation = persisted.generation_files?.[0];
      assert.equal(generation?.label, "initial-draft");
      assert.match(generation?.path ?? "", /round-0-claude-initial-draft\.json$/);
      assert.equal(
        observedCacheLabel,
        "initial-draft",
        "cache telemetry must use the same canonical label as the durable generation artifact",
      );
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.18-budget-cache] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.18-budget-cache] FAIL: ${regression.name}\n  ${message}`);
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
