import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { sessionCostBreakdown } from "../src/core/reports.js";
import { SessionStore } from "../src/core/session-store.js";
import * as serverModule from "../src/mcp/server.js";

type DurableState = {
  session_id: string;
  outcome?: "converged" | "aborted" | "max-rounds" | undefined;
  outcome_reason?: string | undefined;
  in_flight?:
    | {
        round: number;
        peers: string[];
        started_at: string;
        status: "running";
      }
    | undefined;
  generation_in_flight?:
    | {
        peer: string;
        provider: string;
        model: string;
        label: string;
        round: number;
        started_at: string;
        owner_pid: number;
      }
    | undefined;
  control?:
    | {
        status: "running" | "cancel_requested" | "cancelled" | "recovered_after_restart";
        reason?: string | undefined;
        job_id?: string | undefined;
        requested_at?: string | undefined;
        owner_pid?: number | undefined;
        updated_at: string;
      }
    | undefined;
};

type LocalJob = {
  job_id: string;
  kind: "ask_peers" | "run_until_unanimous";
  session_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
};

type DurableJobsApi = {
  durableSessionExecutionActive?: (session: DurableState) => boolean;
  durableSessionCancellationWon?: (session: DurableState, signalAborted?: boolean) => boolean;
  shouldEscalateBackgroundJobFailure?: (session: DurableState | undefined) => boolean;
  watchDurableCancellation?: (
    job: LocalJob,
    controller: AbortController,
    readSession: () => DurableState,
    intervalMs?: number,
  ) => () => void;
  throwIfDurableCancellationRequested?: (
    job: Pick<LocalJob, "job_id">,
    controller: AbortController,
    session: DurableState,
  ) => void;
  synthesizeDurableJob?: (
    session: DurableState,
    localJobs: LocalJob[],
  ) => Record<string, unknown> | null;
};

const api = serverModule as unknown as DurableJobsApi;
const sessionId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const wrongJobId = "33333333-3333-4333-8333-333333333333";
const startedAt = "2026-07-11T12:00:00.000Z";

function seedPersistedGenerationDispatch(
  store: SessionStore,
  targetSessionId: string,
  started = new Date().toISOString(),
): void {
  const meta = store.read(targetSessionId);
  Object.assign(meta, {
    generation_in_flight: {
      peer: "claude",
      provider: "anthropic",
      model: "claude-fable-5",
      label: "initial/background generation",
      round: 0,
      started_at: started,
      owner_pid: process.pid,
    },
  });
  fs.writeFileSync(store.metaPath(targetSessionId), JSON.stringify(meta), "utf8");
}

const regressions: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: "durable-in-flight-is-active-without-a-process-local-job",
    run: () => {
      assert.equal(typeof api.durableSessionExecutionActive, "function");
      assert.equal(
        api.durableSessionExecutionActive?.({
          session_id: sessionId,
          in_flight: {
            round: 3,
            peers: ["claude"],
            started_at: startedAt,
            status: "running",
          },
        }),
        true,
      );
      assert.equal(
        api.durableSessionExecutionActive?.({
          session_id: sessionId,
          control: {
            status: "cancel_requested",
            reason: "remote window",
            updated_at: startedAt,
          },
        }),
        true,
      );
    },
  },
  {
    name: "terminal-cancellation-keeps-the-background-job-from-reporting-completed",
    run: () => {
      assert.equal(typeof api.durableSessionCancellationWon, "function");
      assert.equal(
        api.durableSessionCancellationWon?.(
          {
            session_id: sessionId,
            outcome: "aborted",
            outcome_reason: "session_cancelled",
            control: {
              status: "cancelled",
              reason: "operator cancelled",
              updated_at: startedAt,
            },
          },
          false,
        ),
        true,
      );
    },
  },
  {
    name: "owner-process-observes-a-durable-cancel-request",
    run: async () => {
      assert.equal(typeof api.watchDurableCancellation, "function");
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-durable-"));
      const config = { ...loadConfig(), data_dir: dataDir };
      const ownerStore = new SessionStore(config);
      const siblingStore = new SessionStore(config);
      const session = await ownerStore.init("durable cancellation regression", "operator", []);
      await ownerStore.markInFlight(session.session_id, {
        round: 1,
        peers: ["claude"],
        started_at: new Date().toISOString(),
        scope: {
          petitioner: "operator",
          caller: "operator",
          acting_peer: "operator",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
      });
      const job: LocalJob = {
        job_id: jobId,
        kind: "ask_peers",
        session_id: session.session_id,
        status: "running",
        started_at: startedAt,
      };
      const controller = new AbortController();
      const stop = api.watchDurableCancellation?.(
        job,
        controller,
        () => ownerStore.read(session.session_id),
        5,
      );
      try {
        await siblingStore.requestCancellation(
          session.session_id,
          "cancelled from another MCP window",
          jobId,
        );
        if (!controller.signal.aborted) {
          await Promise.race([
            new Promise<void>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("durable cancellation was not observed")), 250),
            ),
          ]);
        }
        assert.equal(controller.signal.aborted, true);
        assert.equal(controller.signal.reason, "cancelled from another MCP window");
      } finally {
        stop?.();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "background-start-cannot-overwrite-a-durable-cancel-request",
    run: async () => {
      assert.equal(typeof api.watchDurableCancellation, "function");
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-start-race-"));
      try {
        const ownerStore = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const siblingStore = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await ownerStore.init("background start cancellation race", "operator", []);
        const job: LocalJob = {
          job_id: jobId,
          kind: "ask_peers",
          session_id: session.session_id,
          status: "running",
          started_at: startedAt,
        };
        const controller = new AbortController();
        const stop = api.watchDurableCancellation?.(
          job,
          controller,
          () => ownerStore.read(session.session_id),
          5,
        );
        try {
          // Force the exact cross-window interleaving from startJob: its watcher
          // already exists, a sibling persists cancellation, and only then the
          // deferred background-start microtask marks the job as running.
          await siblingStore.requestCancellation(
            session.session_id,
            "cancelled before background start settled",
            jobId,
          );
          await ownerStore.markBackgroundJobRunning(session.session_id, {
            job_id: jobId,
            owner_pid: process.pid,
          });
          const meta = ownerStore.read(session.session_id);
          assert.equal(meta.control?.status, "cancel_requested");
          assert.equal(meta.control?.job_id, jobId);
          assert.equal(meta.control?.reason, "cancelled before background start settled");
          assert.equal(typeof api.throwIfDurableCancellationRequested, "function");
          let providerDispatches = 0;
          assert.throws(
            () => {
              api.throwIfDurableCancellationRequested?.(job, controller, meta as DurableState);
              providerDispatches += 1;
            },
            (error: unknown) =>
              error instanceof Error &&
              error.name === "AbortError" &&
              error.message === "cancelled before background start settled",
          );
          assert.equal(controller.signal.aborted, true);
          assert.equal(providerDispatches, 0);
        } finally {
          stop?.();
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "remote-cancellation-cannot-bind-to-the-wrong-durable-job",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-job-mismatch-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("durable cancellation job identity", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });

        await assert.rejects(
          () =>
            store.requestCancellation(
              session.session_id,
              "must not target another job",
              wrongJobId,
            ),
          /background_job_mismatch/,
        );
        assert.equal(store.read(session.session_id).control?.job_id, jobId);
        assert.equal(store.read(session.session_id).control?.status, "running");

        const canonical = await store.requestCancellation(
          session.session_id,
          "canonicalize omitted job id",
        );
        assert.equal(canonical.control?.job_id, jobId);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "interrupted-recovery-never-steals-a-live-sibling-process-job",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-recovery-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("live sibling recovery guard", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 1,
          peers: ["claude"],
          started_at: new Date().toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude"],
            reviewer_peers: ["claude"],
          },
        });
        const storeApi = store as unknown as {
          markBackgroundJobRunning?: (
            sessionId: string,
            owner: { job_id: string; owner_pid: number },
          ) => Promise<unknown>;
        };
        assert.equal(typeof storeApi.markBackgroundJobRunning, "function");
        await storeApi.markBackgroundJobRunning?.(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        const recovered = await store.recoverInterruptedSessions(new Set());
        assert.deepEqual(recovered, [], "a live sibling owner must not be recovered as stale");
        assert.ok(store.read(session.session_id).in_flight);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "dead-background-owner-without-in-flight-is-recovered",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-dead-owner-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("dead owner before durable round", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: 2_147_483_647,
        });
        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "claude",
          provider: "anthropic",
          model: "claude-fable-5",
          label: "initial/background generation",
          round: 0,
          started_at: new Date().toISOString(),
          owner_pid: 2_147_483_647,
        });
        assert.equal(store.read(session.session_id).in_flight, undefined);

        const recovered = await store.recoverInterruptedSessions(new Set());
        assert.equal(recovered.length, 1);
        const meta = store.read(session.session_id);
        assert.equal(meta.control?.status, "recovered_after_restart");
        assert.equal(api.durableSessionExecutionActive?.(meta as DurableState), false);
        assert.equal(meta.failed_attempts?.length, 1);
        assert.equal(meta.failed_attempts?.[0]?.billing_status, "unknown");
        assert.equal(meta.failed_attempts?.[0]?.unpriced_attempts, 1);
        assert.match(meta.failed_attempts?.[0]?.message ?? "", /initial\/background generation/i);
        assert.equal(sessionCostBreakdown(meta).unpriced_failed_attempts, 1);
        assert.equal(sessionCostBreakdown(meta).reconciled, false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "cancel-requested-pre-round-job-is-visible-to-remote-poll",
    run: () => {
      assert.equal(typeof api.synthesizeDurableJob, "function");
      const synthetic = api.synthesizeDurableJob?.(
        {
          session_id: sessionId,
          control: {
            status: "cancel_requested",
            reason: "owner disappeared after cancellation",
            job_id: jobId,
            owner_pid: 2_147_483_647,
            requested_at: startedAt,
            updated_at: startedAt,
          },
        },
        [],
      );
      assert.equal(synthetic?.job_id, jobId);
      assert.equal(synthetic?.control_status, "cancel_requested");
      assert.equal(synthetic?.cancellation_requested, true);
      assert.equal(synthetic?.round, 0);
      assert.deepEqual(synthetic?.peers, []);
    },
  },
  {
    name: "dead-cancel-requested-owner-without-in-flight-is-recovered",
    run: async () => {
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "cross-review-v454-dead-cancel-owner-"),
      );
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init(
          "dead cancelled owner before durable round",
          "operator",
          [],
        );
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: 2_147_483_647,
        });
        await store.requestCancellation(session.session_id, "cancelled owner disappeared", jobId);

        const recovered = await store.recoverInterruptedSessions(new Set());
        assert.equal(recovered.length, 1);
        const meta = store.read(session.session_id);
        assert.equal(meta.control?.status, "recovered_after_restart");
        assert.equal(api.durableSessionExecutionActive?.(meta as DurableState), false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "terminal-background-clear-is-a-noop-for-meta-and-report",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-terminal-clear-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("terminal background clear", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        await store.finalize(session.session_id, "aborted", "terminal_before_job_cleanup");
        const reportPath = path.join(store.sessionDir(session.session_id), "session-report.md");
        const metaBefore = fs.readFileSync(store.metaPath(session.session_id), "utf8");
        const reportBefore = fs.readFileSync(reportPath, "utf8");

        await store.clearBackgroundJobControl(session.session_id, jobId);

        assert.equal(fs.readFileSync(store.metaPath(session.session_id), "utf8"), metaBefore);
        assert.equal(fs.readFileSync(reportPath, "utf8"), reportBefore);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "stale-in-flight-sweep-never-steals-a-live-background-owner",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-live-owner-sweep-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("live owner stale timestamp", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 1,
          peers: ["claude"],
          started_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude"],
            reviewer_peers: ["claude"],
          },
        });
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });

        const result = await store.clearStaleInFlight();
        assert.equal(result.cleared, 0);
        assert.ok(store.read(session.session_id).in_flight);
        assert.equal(store.read(session.session_id).failed_attempts?.length ?? 0, 0);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "poll-can-synthesize-remote-in-flight-job-state",
    run: () => {
      assert.equal(typeof api.synthesizeDurableJob, "function");
      const state: DurableState = {
        session_id: sessionId,
        in_flight: {
          round: 3,
          peers: ["claude", "gemini"],
          started_at: startedAt,
          status: "running",
        },
      };
      const synthetic = api.synthesizeDurableJob?.(state, []);
      assert.equal(synthetic?.source, "durable_session");
      assert.equal(synthetic?.status, "running");
      assert.equal(synthetic?.round, 3);

      const preRound = api.synthesizeDurableJob?.(
        {
          session_id: sessionId,
          control: {
            status: "running",
            job_id: jobId,
            owner_pid: process.pid,
            updated_at: startedAt,
          },
        },
        [],
      );
      assert.equal(preRound?.job_id, jobId);
      assert.equal(preRound?.control_status, "running");
      assert.equal(preRound?.round, 0);
      assert.deepEqual(preRound?.peers, []);

      const synchronousGeneration = api.synthesizeDurableJob?.(
        {
          session_id: sessionId,
          generation_in_flight: {
            peer: "claude",
            provider: "anthropic",
            model: "claude-fable-5",
            label: "initial-draft-failure",
            round: 0,
            started_at: startedAt,
            owner_pid: process.pid,
          },
        },
        [],
      );
      assert.equal(synchronousGeneration?.round, 0);
      assert.deepEqual(synchronousGeneration?.peers, ["claude"]);
      assert.equal(
        api.durableSessionExecutionActive?.({
          session_id: sessionId,
          generation_in_flight: {
            peer: "claude",
            provider: "anthropic",
            model: "claude-fable-5",
            label: "initial-draft-failure",
            round: 0,
            started_at: startedAt,
            owner_pid: process.pid,
          },
        }),
        true,
      );

      const local: LocalJob = {
        job_id: jobId,
        kind: "ask_peers",
        session_id: sessionId,
        status: "running",
        started_at: startedAt,
      };
      assert.equal(api.synthesizeDurableJob?.(state, [local]), null);
    },
  },
  {
    name: "interrupted-recovery-fails-closed-on-unknown-provider-spend",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-ledger-recovery-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("interrupted billing recovery", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 1,
          peers: ["claude", "gemini"],
          started_at: new Date().toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude", "gemini"],
            reviewer_peers: ["claude", "gemini"],
          },
        });
        await store.recoverInterruptedSessions(new Set());
        const meta = store.read(session.session_id);
        assert.equal(meta.in_flight, undefined);
        assert.equal(meta.failed_attempts?.length, 2);
        assert.deepEqual(meta.failed_attempts?.map((failure) => failure.peer).sort(), [
          "claude",
          "gemini",
        ]);
        assert.equal(sessionCostBreakdown(meta).unpriced_failed_attempts, 2);
        assert.equal(sessionCostBreakdown(meta).reconciled, false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "stale-in-flight-sweep-fails-closed-on-unknown-provider-spend",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-ledger-sweep-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("stale billing sweep", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 2,
          peers: ["claude", "gemini"],
          started_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude", "gemini"],
            reviewer_peers: ["claude", "gemini"],
          },
        });
        const result = await store.clearStaleInFlight();
        assert.equal(result.cleared, 1);
        const meta = store.read(session.session_id);
        assert.equal(meta.in_flight, undefined);
        assert.equal(meta.failed_attempts?.length, 2);
        assert.equal(sessionCostBreakdown(meta).unpriced_failed_attempts, 2);
        assert.equal(sessionCostBreakdown(meta).reconciled, false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "operator-finalize-cannot-erase-an-active-provider-round",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-finalize-guard-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("finalize in-flight guard", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 1,
          peers: ["claude"],
          started_at: new Date().toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude"],
            reviewer_peers: ["claude"],
          },
        });
        await assert.rejects(
          () => store.finalize(session.session_id, "aborted", "operator_requested"),
          /cannot_finalize_in_flight_session/,
        );
        const meta = store.read(session.session_id);
        assert.equal(meta.outcome, undefined);
        assert.ok(meta.in_flight);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "operator-finalize-cannot-erase-an-active-generation-dispatch",
    run: async () => {
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "cross-review-v454-generation-finalize-guard-"),
      );
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("generation finalize guard", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        seedPersistedGenerationDispatch(store, session.session_id);

        await assert.rejects(
          () => store.finalize(session.session_id, "aborted", "operator_requested"),
          /cannot_finalize_generation_in_flight/,
        );
        const meta = store.read(session.session_id);
        assert.equal(meta.outcome, undefined);
        assert.ok(meta.generation_in_flight);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "idle-sweep-cannot-finalize-an-active-generation-dispatch",
    run: async () => {
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "cross-review-v454-generation-sweep-guard-"),
      );
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("generation sweep guard", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        seedPersistedGenerationDispatch(store, session.session_id, staleAt);
        const stale = store.read(session.session_id);
        stale.updated_at = staleAt;
        fs.writeFileSync(store.metaPath(session.session_id), JSON.stringify(stale), "utf8");

        const swept = await store.sweepIdle(0);
        assert.equal(swept.length, 0);
        const meta = store.read(session.session_id);
        assert.equal(meta.outcome, undefined);
        assert.ok(meta.generation_in_flight);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "cancel-before-provider-dispatch-does-not-create-a-ghost-attempt",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-zero-dispatch-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("cancel before background run", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        await store.requestCancellation(session.session_id, "cancel before dispatch", jobId);
        await store.markCancelled(session.session_id, "session_cancelled");

        const meta = store.read(session.session_id);
        assert.equal(meta.failed_attempts?.length ?? 0, 0);
        assert.equal(sessionCostBreakdown(meta).unpriced_failed_attempts, 0);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "durable-cancellation-wins-an-atomic-race-with-converged-finalize",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-cancel-finalize-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("cancel versus converged finalize", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: jobId,
          owner_pid: process.pid,
        });
        await store.appendRound(session.session_id, {
          caller_status: "READY",
          prompt_file: "agent-runs/cancel-finalize-prompt.md",
          peers: [],
          rejected: [],
          convergence: {
            converged: true,
            reason: "fixture_unanimous_ready",
            ready_peers: [],
            not_ready_peers: [],
            needs_evidence_peers: [],
            rejected_peers: [],
            skipped_peers: [],
            decision_quality: {
              codex: "clean",
              claude: "clean",
              gemini: "clean",
              deepseek: "clean",
              grok: "clean",
              perplexity: "clean",
            },
            blocking_details: [],
          },
          convergence_scope: {
            caller: "operator",
            caller_status: "READY",
            expected_peers: [],
            reviewer_peers: [],
          },
          started_at: new Date().toISOString(),
        });
        await store.requestCancellation(session.session_id, "operator cancelled", jobId);

        const finalized = await store.finalize(session.session_id, "converged", "unanimous_ready");
        assert.equal(finalized.outcome, "aborted");
        assert.equal(finalized.outcome_reason, "session_cancelled");
        assert.equal(finalized.control?.status, "cancelled");
        assert.equal(finalized.convergence_health?.state, "cancelled");
        assert.equal(finalized.failed_attempts?.length ?? 0, 0);
        assert.equal(sessionCostBreakdown(finalized).unpriced_failed_attempts, 0);
        assert.equal(store.readEvents(session.session_id).at(-1)?.type, "session.cancelled");
        const report = fs.readFileSync(
          path.join(store.sessionDir(session.session_id), "session-report.md"),
          "utf8",
        );
        assert.match(report, /Outcome: aborted/);
        assert.match(report, /Outcome reason: session_cancelled/);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "terminal-background-failure-does-not-request-operator-escalation",
    run: async () => {
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "cross-review-v454-terminal-escalate-"),
      );
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("terminal escalation immutability", "operator", []);
        assert.equal(typeof api.shouldEscalateBackgroundJobFailure, "function");
        assert.equal(
          api.shouldEscalateBackgroundJobFailure?.(store.read(session.session_id)),
          true,
        );
        await store.finalize(session.session_id, "max-rounds", "generation_budget_preflight");
        const reportPath = path.join(store.sessionDir(session.session_id), "session-report.md");
        const metaBefore = fs.readFileSync(store.metaPath(session.session_id), "utf8");
        const reportBefore = fs.readFileSync(reportPath, "utf8");

        assert.equal(
          api.shouldEscalateBackgroundJobFailure?.(store.read(session.session_id)),
          false,
        );
        assert.equal(api.shouldEscalateBackgroundJobFailure?.(undefined), false);
        assert.equal(fs.readFileSync(store.metaPath(session.session_id), "utf8"), metaBefore);
        assert.equal(fs.readFileSync(reportPath, "utf8"), reportBefore);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "idle-sweep-leaves-in-flight-accounting-to-interruption-recovery",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v454-idle-guard-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("idle in-flight guard", "operator", []);
        await store.markInFlight(session.session_id, {
          round: 1,
          peers: ["claude"],
          started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          scope: {
            petitioner: "operator",
            caller: "operator",
            acting_peer: "operator",
            caller_status: "READY",
            expected_peers: ["claude"],
            reviewer_peers: ["claude"],
          },
        });
        const stale = store.read(session.session_id);
        stale.updated_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(store.metaPath(session.session_id), JSON.stringify(stale), "utf8");
        const swept = await store.sweepIdle(0);
        assert.equal(swept.length, 0);
        const meta = store.read(session.session_id);
        assert.equal(meta.outcome, undefined);
        assert.ok(meta.in_flight);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.4-durable-jobs] ${regression.name}: PASS`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.4-durable-jobs] ${regression.name}: RED\n${message}`);
  }
}

console.log(
  JSON.stringify(
    {
      total: regressions.length,
      passed: regressions.length - failures.length,
      red: failures.length,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exitCode = 1;
