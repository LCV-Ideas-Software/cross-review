import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import type { AppConfig, PeerAdapter, PeerId } from "../src/core/types.js";
import { PEERS } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PreflightKind = "truthfulness" | "evidence";

const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const tempRoots = new Set<string>();

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function tempDataDir(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v4518-${label}-`));
  tempRoots.add(root);
  return root;
}

function regressionConfig(label: string, preflight: PreflightKind | "off" = "off"): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    data_dir: tempDataDir(label),
    stub: true,
    peer_enabled: Object.fromEntries(PEERS.map((peer) => [peer, true])) as Record<PeerId, boolean>,
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
    truthfulness_preflight_enabled: preflight === "truthfulness",
    evidence_preflight_enabled: preflight === "evidence",
    evidence_judge_autowire: {
      ...base.evidence_judge_autowire,
      mode: "off",
      active: false,
      peer: undefined,
      consensus_peers: [],
    },
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

function initialDraftFixture(kind: PreflightKind): string {
  return kind === "truthfulness"
    ? "The current production deployment is healthy and green."
    : "The completed patch passed 42 tests and the build succeeded.";
}

function taskFixture(kind: PreflightKind): string {
  return kind === "truthfulness"
    ? "Review this operational state report."
    : "Review the completed implementation and its successful test run.";
}

async function blockedPreflightFixture(kind: PreflightKind, label: string) {
  const config = regressionConfig(label, kind);
  const orchestrator = new CrossReviewOrchestrator(config);
  const draft = initialDraftFixture(kind);
  const result = await orchestrator.runUntilUnanimous({
    task: taskFixture(kind),
    initial_draft: draft,
    caller: "operator",
    lead_peer: "codex",
    peers: ["codex", "claude"],
    max_rounds: 1,
  });
  await orchestrator.store.flushPendingEvents();
  return { config, draft, orchestrator, result };
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fs.existsSync(file);
}

function persistDeadInFlightOwner(orchestrator: CrossReviewOrchestrator, sessionId: string): void {
  const meta = orchestrator.store.read(sessionId);
  if (!meta.in_flight) throw new Error("fixture requires an in-flight round");
  meta.in_flight.owner_pid = 2_147_483_647;
  for (const reservation of meta.in_flight.provider_call_reservations ?? []) {
    reservation.owner_pid = 2_147_483_647;
  }
  fs.writeFileSync(orchestrator.store.metaPath(sessionId), JSON.stringify(meta), "utf8");
}

const regressions: Regression[] = [
  ...(["truthfulness", "evidence"] as const).flatMap((kind): Regression[] => [
    {
      name: `${kind} preflight persists the exact round-0 draft before returning`,
      run: async () => {
        const fixture = await blockedPreflightFixture(kind, `${kind}-draft`);
        const draftFile = path.join(
          fixture.orchestrator.store.sessionDir(fixture.result.session.session_id),
          "agent-runs",
          "round-0-draft.md",
        );
        assert.equal(
          fs.readFileSync(draftFile, "utf8"),
          fixture.draft,
          "the rejected caller draft must remain durably auditable byte-for-byte",
        );
      },
    },
    {
      name: `${kind} preflight terminates the session with a specific aborted reason`,
      run: async () => {
        const fixture = await blockedPreflightFixture(kind, `${kind}-terminal`);
        const persisted = fixture.orchestrator.store.read(fixture.result.session.session_id);
        assert.deepEqual(
          {
            returned_outcome: fixture.result.session.outcome,
            returned_reason: fixture.result.session.outcome_reason,
            persisted_outcome: persisted.outcome,
            persisted_reason: persisted.outcome_reason,
            converged: fixture.result.converged,
            rounds: fixture.result.rounds,
          },
          {
            returned_outcome: "aborted",
            returned_reason: `needs_${kind}_preflight`,
            persisted_outcome: "aborted",
            persisted_reason: `needs_${kind}_preflight`,
            converged: false,
            rounds: 0,
          },
          "a run-until preflight rejection is terminal and must not leave an ambiguous open session",
        );
      },
    },
  ]),
  {
    name: "a fast provider result is durable while a slower peer is still running",
    run: async () => {
      const config = regressionConfig("peer-response-before-barrier");
      const fastReturned = deferred<void>();
      const slowStarted = deferred<void>();
      const releaseSlow = deferred<void>();
      const adapters = Object.fromEntries(
        PEERS.map((peer) => [peer, new StubAdapter(config, peer)]),
      ) as unknown as Record<PeerId, PeerAdapter>;

      const fastCall = adapters.claude.call.bind(adapters.claude);
      adapters.claude.call = async (prompt, context) => {
        const result = await fastCall(prompt, context);
        fastReturned.resolve();
        return {
          ...result,
          usage: {
            input_tokens: 101,
            output_tokens: 17,
            total_tokens: 118,
          },
          cost: {
            currency: "USD",
            input_cost: 0.2,
            output_cost: 0.121,
            total_cost: 0.321,
            estimated: false,
            source: "configured-rate",
          },
        };
      };

      const slowCall = adapters.gemini.call.bind(adapters.gemini);
      adapters.gemini.call = async (prompt, context) => {
        slowStarted.resolve();
        await releaseSlow.promise;
        return await slowCall(prompt, context);
      };

      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.initSession(
        "Persist each provider response before the all-peer barrier.",
        "operator",
      );
      const roundPromise = orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Static implementation candidate for a durability-only regression.",
        caller: "operator",
        peers: ["claude", "gemini"],
      });

      await Promise.all([fastReturned.promise, slowStarted.promise]);
      const fastResponseFile = path.join(
        orchestrator.store.sessionDir(session.session_id),
        "agent-runs",
        "round-1-claude-provider-response.json",
      );

      let regressionError: unknown;
      try {
        const persistedBeforeBarrier = await waitForFile(fastResponseFile, 750);
        assert.equal(
          persistedBeforeBarrier,
          true,
          "the fast result must be written before the slower provider finishes, not after Promise.all",
        );
        const persisted = JSON.parse(fs.readFileSync(fastResponseFile, "utf8")) as {
          peer?: string;
        };
        assert.equal(persisted.peer, "claude");

        persistDeadInFlightOwner(orchestrator, session.session_id);
        const recovered = await orchestrator.store.recoverInterruptedSessions();
        assert.deepEqual(
          recovered.map((meta) => meta.session_id),
          [session.session_id],
          "the simulated restart must recover the interrupted round",
        );
        const recoveredMeta = orchestrator.store.read(session.session_id);
        const unknownPeers = (recoveredMeta.failed_attempts ?? [])
          .filter(
            (failure) =>
              failure.billing_status === "unknown" || (failure.unpriced_attempts ?? 0) > 0,
          )
          .map((failure) => failure.peer)
          .sort();
        assert.deepEqual(
          unknownPeers,
          ["gemini"],
          "recovery must mark only the unresolved peer as an unknown attempt",
        );
        assert.equal(recoveredMeta.totals.usage.input_tokens, 101);
        assert.equal(recoveredMeta.totals.usage.output_tokens, 17);
        assert.equal(
          recoveredMeta.totals.usage.total_tokens,
          118,
          "the provider result persisted before the barrier must remain in the exact usage ledger",
        );
        assert.equal(
          recoveredMeta.totals.cost.total_cost,
          0.321,
          "the provider result persisted before the barrier must retain its exact cost after recovery",
        );
      } catch (error) {
        regressionError = error;
      } finally {
        releaseSlow.resolve();
        try {
          await roundPromise;
        } catch {
          // The pre-crash promise no longer owns the recovered session. A
          // late settlement may therefore be rejected by the fixed runtime.
        }
      }

      if (regressionError) throw regressionError;
    },
  },
  {
    name: "a partially priced settlement is reported as billing unknown",
    run: async () => {
      const config = regressionConfig("partially-priced-settlement");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Partially priced settlement contract.",
        "operator",
        [],
      );
      await orchestrator.store.markInFlight(session.session_id, {
        round: 1,
        peers: ["codex"],
        started_at: new Date().toISOString(),
        scope: {
          petitioner: "operator",
          caller: "operator",
          acting_peer: "operator",
          caller_status: "READY",
          expected_peers: ["codex"],
          reviewer_peers: ["codex"],
        },
      });
      const result = await orchestrator.adapters.codex.call("Stable fixture result.", {
        session_id: session.session_id,
        round: 1,
        task: session.task,
        emit: () => {},
      });
      result.cost = {
        currency: "USD",
        estimated: false,
        source: "configured-rate",
        total_cost: 0.25,
      };
      result.unpriced_attempts = 1;
      await orchestrator.store.saveInFlightPeerResult(session.session_id, 1, result);
      assert.equal(
        orchestrator.store.read(session.session_id).in_flight?.provider_settlements?.[0]
          ?.billing_status,
        "unknown",
        "a partial numeric total must not conceal an additional unpriced provider attempt",
      );
    },
  },
  {
    name: "an interrupted format-recovery reservation becomes one unpriced attempt",
    run: async () => {
      const config = regressionConfig("format-recovery-interrupted");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Account for a recovery call interrupted after dispatch.",
        "operator",
        [],
      );
      await orchestrator.store.markInFlight(session.session_id, {
        round: 1,
        peers: ["codex"],
        started_at: new Date().toISOString(),
        scope: {
          petitioner: "operator",
          caller: "operator",
          acting_peer: "operator",
          caller_status: "READY",
          expected_peers: ["codex"],
          reviewer_peers: ["codex"],
        },
      });
      const initial = await orchestrator.adapters.codex.call("FORCE_BAD_FORMAT", {
        session_id: session.session_id,
        round: 1,
        task: session.task,
        emit: () => {},
      });
      initial.cost = {
        currency: "USD",
        estimated: false,
        source: "configured-rate",
        total_cost: 0.25,
      };
      await orchestrator.store.saveInFlightPeerResult(session.session_id, 1, initial);
      await orchestrator.store.reserveInFlightProviderCall(session.session_id, 1, {
        peer: "codex",
        provider: initial.provider,
        model: initial.model,
        label: "format-recovery",
      });

      persistDeadInFlightOwner(orchestrator, session.session_id);
      await orchestrator.store.recoverInterruptedSessions();
      const recovered = orchestrator.store.read(session.session_id);
      const unknown = (recovered.failed_attempts ?? []).filter(
        (failure) => (failure.unpriced_attempts ?? 0) > 0,
      );
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0]?.peer, "codex");
      assert.match(unknown[0]?.message ?? "", /format-recovery/);
      assert.equal(recovered.totals.cost.total_cost, 0.25);
      assert.equal(recovered.in_flight, undefined);
    },
  },
  {
    name: "an interrupted evidence-judge reservation becomes one unpriced attempt",
    run: async () => {
      const config = regressionConfig("evidence-judge-interrupted");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Account for an evidence-judge call interrupted after dispatch.",
        "operator",
        [],
      );
      await orchestrator.store.reservePendingProviderCall(session.session_id, {
        peer: "claude",
        provider: "fixture-claude",
        model: "fixture-claude",
        round: 1,
        label: "judge-checklist-1",
        call_kind: "evidence_judge",
      });
      const metaPath = orchestrator.store.metaPath(session.session_id);
      const persisted = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        pending_provider_call_reservations?: Array<{ owner_pid?: number }>;
      };
      const reservation = persisted.pending_provider_call_reservations?.[0];
      assert.ok(reservation, "fixture must create a pending evidence-judge reservation");
      reservation.owner_pid = 2_147_483_647;
      fs.writeFileSync(metaPath, JSON.stringify(persisted), "utf8");

      const recoveredSessions = await orchestrator.store.recoverInterruptedSessions();
      assert.deepEqual(
        recoveredSessions.map((meta) => meta.session_id),
        [session.session_id],
        "restart recovery must reconcile an outstanding paid judge call",
      );
      const recovered = orchestrator.store.read(session.session_id);
      const unknown = (recovered.failed_attempts ?? []).filter(
        (failure) => (failure.unpriced_attempts ?? 0) > 0,
      );
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0]?.peer, "claude");
      assert.match(unknown[0]?.message ?? "", /evidence_judge\/judge-checklist-1/);
      assert.equal(recovered.pending_provider_call_reservations?.length ?? 0, 0);
    },
  },
  {
    name: "a live evidence-judge reservation is never recovered by a concurrent host",
    run: async () => {
      const config = regressionConfig("evidence-judge-live-owner");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Do not reconcile a still-running evidence judge.",
        "operator",
        [],
      );
      await orchestrator.store.reservePendingProviderCall(session.session_id, {
        peer: "claude",
        provider: "fixture-claude",
        model: "fixture-claude",
        round: 1,
        label: "judge-live-owner",
        call_kind: "evidence_judge",
      });

      const recoveredSessions = await orchestrator.store.recoverInterruptedSessions();
      assert.deepEqual(
        recoveredSessions,
        [],
        "a recovery request from another host must not reclassify a live paid judge call as unknown",
      );
      assert.equal(
        orchestrator.store.read(session.session_id).pending_provider_call_reservations?.length,
        1,
      );
    },
  },
  {
    name: "startup reconciliation automatically accounts for a dead evidence-judge owner",
    run: async () => {
      const config = regressionConfig("evidence-judge-startup-sweep");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Automatically reconcile a judge call after host death.",
        "operator",
        [],
      );
      await orchestrator.store.reservePendingProviderCall(session.session_id, {
        peer: "claude",
        provider: "fixture-claude",
        model: "fixture-claude",
        round: 1,
        label: "judge-dead-owner",
        call_kind: "evidence_judge",
      });
      const metaPath = orchestrator.store.metaPath(session.session_id);
      const persisted = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        pending_provider_call_reservations?: Array<{ owner_pid?: number }>;
      };
      const reservation = persisted.pending_provider_call_reservations?.[0];
      assert.ok(reservation, "fixture must create a pending evidence-judge reservation");
      reservation.owner_pid = 2_147_483_647;
      fs.writeFileSync(metaPath, JSON.stringify(persisted), "utf8");

      const store = orchestrator.store as unknown as {
        clearStalePendingProviderCalls(): Promise<{ scanned: number; cleared: number }>;
      };
      const sweep = await store.clearStalePendingProviderCalls();
      assert.equal(sweep.scanned, 1);
      assert.equal(
        sweep.cleared,
        1,
        "a dead owner must be reconciled at startup without a tool call",
      );
      const recovered = orchestrator.store.read(session.session_id);
      assert.equal(recovered.pending_provider_call_reservations?.length ?? 0, 0);
      assert.equal(
        (recovered.failed_attempts ?? []).filter((failure) => (failure.unpriced_attempts ?? 0) > 0)
          .length,
        1,
      );
    },
  },
  {
    name: "format recovery is settled durably before the round append barrier",
    run: async () => {
      const config = regressionConfig("format-recovery-settlement");
      const adapters = Object.fromEntries(
        PEERS.map((peer) => [peer, new StubAdapter(config, peer)]),
      ) as unknown as Record<PeerId, PeerAdapter>;
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.store.init(
        "Persist every paid format-recovery call.",
        "operator",
        [],
      );
      const originalCall = adapters.codex.call.bind(adapters.codex);
      let providerCalls = 0;
      adapters.codex.call = async (prompt, context) => {
        providerCalls += 1;
        const result = await originalCall(prompt, context);
        return {
          ...result,
          usage: {
            input_tokens: providerCalls === 1 ? 100 : 40,
            output_tokens: providerCalls === 1 ? 20 : 10,
            total_tokens: providerCalls === 1 ? 120 : 50,
          },
          cost: {
            currency: "USD",
            estimated: false,
            source: "configured-rate",
            total_cost: providerCalls === 1 ? 0.25 : 0.1,
          },
          attempts: 1,
        };
      };

      const originalSavePeerResult = orchestrator.store.savePeerResult.bind(orchestrator.store);
      orchestrator.store.savePeerResult = async (sessionId, round, result, label) => {
        const artifact = await originalSavePeerResult(sessionId, round, result, label);
        if ((label ?? "peer-response") === "peer-response") {
          throw new Error("simulated_crash_after_format_recovery");
        }
        return artifact;
      };

      await assert.rejects(
        () =>
          orchestrator.askPeers({
            session_id: session.session_id,
            task: session.task,
            draft: "FORCE_BAD_FORMAT",
            caller: "operator",
            peers: ["codex"],
          }),
        /simulated_crash_after_format_recovery/,
      );
      assert.equal(providerCalls, 2, "fixture did not exercise the paid format-recovery call");
      const meta = orchestrator.store.read(session.session_id);
      const settlements = meta.in_flight?.provider_settlements ?? [];
      assert.equal(
        settlements.reduce((sum, settlement) => sum + settlement.attempts, 0),
        2,
        "the recovery attempt disappeared from the durable settlement ledger",
      );
      assert.equal(
        settlements.reduce((sum, settlement) => sum + (settlement.cost?.total_cost ?? 0), 0),
        0.35,
        "the recovery cost disappeared from the durable settlement ledger",
      );
      assert.equal(meta.totals.usage.total_tokens, 170);
    },
  },
  {
    name: "restart finalizes an already appended unanimous round without human action",
    run: async () => {
      const config = regressionConfig("append-before-finalize");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.initSession(
        "Seal an appended unanimous round after a host crash.",
        "operator",
      );
      const originalFinalize = orchestrator.store.finalize.bind(orchestrator.store);
      orchestrator.store.finalize = async () => {
        throw new Error("simulated_crash_between_append_and_finalize");
      };
      await assert.rejects(
        () =>
          orchestrator.askPeers({
            session_id: session.session_id,
            task: session.task,
            draft: "Stable fixture draft.",
            caller: "operator",
            peers: ["codex", "claude"],
          }),
        /simulated_crash_between_append_and_finalize/,
      );
      orchestrator.store.finalize = originalFinalize;
      const stranded = orchestrator.store.read(session.session_id);
      assert.equal(stranded.outcome, undefined);
      assert.equal(stranded.rounds.at(-1)?.convergence.converged, true);
      assert.ok(stranded.in_flight, "the appended round must remain recoverable");

      persistDeadInFlightOwner(orchestrator, session.session_id);
      const startupSweep = await orchestrator.store.clearStaleInFlight();
      assert.equal(
        startupSweep.cleared,
        1,
        "the automatic startup sweep must seal an appended unanimous round immediately",
      );
      const recovered = orchestrator.store.read(session.session_id);
      assert.equal(
        recovered.outcome,
        "converged",
        "a restart must seal durable unanimity rather than leave a human-finalization gap",
      );
      assert.match(recovered.outcome_reason ?? "", /unanimous|recovered/);
      assert.equal(
        fs.readFileSync(
          path.join(orchestrator.store.sessionDir(session.session_id), "final.md"),
          "utf8",
        ),
        "Stable fixture draft.",
        "automatic terminal recovery must restore the same durable final artifact",
      );
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];

try {
  for (const regression of regressions) {
    try {
      await regression.run();
      console.log(`[GREEN] ${regression.name}`);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      failures.push({ name: regression.name, error: message });
      console.error(`[RED] ${regression.name}`);
      console.error(`      ${message.replace(/\s+/g, " ").trim()}`);
    }
  }
} finally {
  if (previousStubConfirmation === undefined) {
    delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
  } else {
    process.env.CROSS_REVIEW_STUB_CONFIRMED = previousStubConfirmation;
  }
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
}

console.log(
  `[v4.5.18-durability-regression] ${regressions.length - failures.length}/${regressions.length} GREEN; ${failures.length}/${regressions.length} RED`,
);

if (failures.length > 0) process.exitCode = 1;
