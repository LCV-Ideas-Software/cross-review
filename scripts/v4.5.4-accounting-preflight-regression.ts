import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { sessionCostBreakdown, sessionReportMarkdown } from "../src/core/reports.js";
import { SessionStore } from "../src/core/session-store.js";
import type {
  AppConfig,
  GenerationResult,
  PeerFailure,
  PeerResult,
  RuntimeEvent,
} from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { classifyProviderError } from "../src/peers/errors.js";
import { withRetry } from "../src/peers/retry.js";

const roots: string[] = [];
const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

function config(label: string): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v454-account-${label}-`));
  roots.push(dataDir);
  const base = loadConfig();
  return {
    ...base,
    data_dir: dataDir,
    stub: true,
    evidence_preflight_enabled: true,
    truthfulness_preflight_enabled: true,
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
    retry: { ...base.retry, max_attempts: 1, base_delay_ms: 1, max_delay_ms: 1 },
  };
}

function fixturePeer(cost: number, unpricedAttempts = 0): PeerResult {
  return {
    peer: "claude",
    provider: "fixture",
    model: "fixture",
    status: "READY",
    structured: {
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: ['Artifact quote: "fixture evidence is present"'],
      caller_requests: [],
      follow_ups: [],
    },
    text: "fixture",
    raw: {},
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    cost: {
      currency: "USD",
      estimated: false,
      source: "configured-rate",
      total_cost: cost,
    },
    latency_ms: 1,
    attempts: 1 + unpricedAttempts,
    ...(unpricedAttempts > 0 ? { unpriced_attempts: unpricedAttempts } : {}),
    parser_warnings: [],
    decision_quality: "clean",
  };
}

const regressions: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: "explicit-preflight-remains-read-only-while-real-gates-are-durable",
    run: async () => {
      const cfg = config("preflight");
      const observed: RuntimeEvent[] = [];
      const orchestrator = new CrossReviewOrchestrator(cfg, (event) => observed.push(event));
      const session = await orchestrator.store.init("Review a static note.", "operator", []);
      const explicit = orchestrator.checkSessionPreflights({
        sessionId: session.session_id,
        task: session.task,
        draft: "Static implementation note with no operational claim.",
        caller: "operator",
      });
      assert.equal(explicit.pass, true);
      assert.deepEqual(orchestrator.store.read(session.session_id).preflight_checks ?? [], []);

      await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Static implementation note with no operational claim.",
        caller: "operator",
        peers: ["claude"],
      });
      const checks = orchestrator.store.read(session.session_id).preflight_checks ?? [];
      assert.deepEqual(checks.map((check) => `${check.gate}:${check.phase}:${check.pass}`).sort(), [
        "evidence:review_round:true",
        "truthfulness:review_round:true",
      ]);
      assert.equal(
        observed.filter((event) => event.type === "session.preflight_checked").length,
        2,
      );
    },
  },
  {
    name: "accounting-v2-refuses-reconciliation-when-any-attempt-is-unpriced",
    run: async () => {
      const store = new SessionStore(config("coverage"));
      const session = await store.init("Accounting coverage fixture", "operator", []);
      const failure: PeerFailure = {
        peer: "gemini",
        provider: "fixture",
        model: "fixture",
        failure_class: "provider_error",
        message: "one billed terminal plus one unknown retry",
        retryable: false,
        attempts: 2,
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        cost: {
          currency: "USD",
          estimated: false,
          source: "configured-rate",
          total_cost: 0.5,
        },
        billing_status: "unknown",
        unpriced_attempts: 1,
        latency_ms: 1,
      };
      const peer = fixturePeer(1, 1);
      await store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/fixture-prompt.md",
        peers: [peer],
        rejected: [failure],
        convergence: {
          converged: false,
          reason: "fixture",
          ready_peers: ["claude"],
          not_ready_peers: [],
          needs_evidence_peers: [],
          rejected_peers: ["gemini"],
          skipped_peers: [],
          decision_quality: {
            codex: "clean",
            claude: "clean",
            gemini: "failed",
            deepseek: "clean",
            grok: "clean",
            perplexity: "clean",
          },
          blocking_details: ["fixture"],
        },
        convergence_scope: {
          caller: "operator",
          caller_status: "READY",
          expected_peers: ["claude", "gemini"],
          reviewer_peers: ["claude", "gemini"],
        },
        started_at: new Date().toISOString(),
      });
      const meta = store.read(session.session_id);
      assert.equal(meta.totals.cost.total_cost, 1.5);
      assert.equal(meta.costs_per_round?.[0], 1.5);
      const breakdown = sessionCostBreakdown(meta);
      assert.equal(breakdown.failed_attempt_total, 0.5);
      assert.equal(breakdown.unpriced_failed_attempts, 2);
      assert.equal(breakdown.reconciled, false);
      assert.match(sessionReportMarkdown(meta, []), /Cost reconciliation: incomplete/);
    },
  },
  {
    name: "legacy-session-can-never-retroclaim-complete-accounting",
    run: async () => {
      const store = new SessionStore(config("legacy"));
      const session = await store.init("Legacy accounting fixture", "operator", []);
      const meta = store.read(session.session_id);
      delete meta.accounting_schema_version;
      meta.totals.cost = {
        currency: "USD",
        estimated: false,
        source: "configured-rate",
        total_cost: 0,
      };
      fs.writeFileSync(store.metaPath(session.session_id), JSON.stringify(meta));
      const breakdown = sessionCostBreakdown(store.read(session.session_id));
      assert.equal(breakdown.accounting_coverage, "legacy_unknown");
      assert.equal(breakdown.reconciled, false);
    },
  },
  {
    name: "dead-pre-round-background-owner-records-a-conservative-generation-attempt",
    run: async () => {
      const store = new SessionStore(config("pre-round-generation-ghost"));
      const session = await store.init("Pre-round background generation ghost", "operator", [
        {
          peer: "claude",
          provider: "anthropic",
          model: "claude-fable-5",
          available: true,
          auth_present: true,
          latency_ms: 1,
        },
      ]);
      await store.markBackgroundJobRunning(session.session_id, {
        job_id: "44444444-4444-4444-8444-444444444444",
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

      await store.recoverInterruptedSessions(new Set());

      const meta = store.read(session.session_id);
      assert.equal(meta.failed_attempts?.length, 1);
      const ghost = meta.failed_attempts?.[0];
      assert.equal(ghost?.peer, "claude");
      assert.equal(ghost?.billing_status, "unknown");
      assert.equal(ghost?.unpriced_attempts, 1);
      assert.match(ghost?.message ?? "", /initial\/background generation/i);
      const breakdown = sessionCostBreakdown(meta);
      assert.equal(breakdown.unpriced_failed_attempts, 1);
      assert.equal(breakdown.reconciled, false);
    },
  },
  {
    name: "pre-dispatch-cancellation-remains-fully-reconciled",
    run: async () => {
      const store = new SessionStore(config("pre-dispatch-cancel"));
      const session = await store.init("Pre-dispatch cancellation", "operator", []);
      const jobId = "55555555-5555-4555-8555-555555555555";
      await store.markBackgroundJobRunning(session.session_id, {
        job_id: jobId,
        owner_pid: process.pid,
      });
      await store.requestCancellation(session.session_id, "cancel before provider call", jobId);
      await store.markCancelled(session.session_id, "session_cancelled");

      const meta = store.read(session.session_id);
      assert.equal(meta.failed_attempts?.length ?? 0, 0);
      const breakdown = sessionCostBreakdown(meta);
      assert.equal(breakdown.unpriced_failed_attempts, 0);
    },
  },
  {
    name: "synchronous-generation-dispatch-marker-does-not-depend-on-background-control",
    run: async () => {
      const store = new SessionStore(config("sync-generation-marker"));
      const session = await store.init("Synchronous paid generation", "operator", []);
      const mark = store.markBackgroundGenerationInFlight as unknown as (
        sessionId: string,
        generation: {
          peer: "claude";
          provider: string;
          model: string;
          label: string;
          round: number;
          started_at: string;
          owner_pid: number;
        },
      ) => Promise<unknown>;
      await mark.call(store, session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "initial-draft-failure",
        round: 0,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      const meta = store.read(session.session_id) as typeof session & {
        generation_in_flight?: { peer: string } | undefined;
      };
      assert.equal(meta.control, undefined);
      assert.equal(meta.generation_in_flight?.peer, "claude");
    },
  },
  {
    name: "dead-synchronous-generation-marker-is-recovered-and-accounted",
    run: async () => {
      const store = new SessionStore(config("sync-generation-recovery"));
      const session = await store.init("Dead synchronous generation", "operator", []);
      const meta = store.read(session.session_id);
      Object.assign(meta, {
        generation_in_flight: {
          peer: "claude",
          provider: "anthropic",
          model: "claude-fable-5",
          label: "initial-draft-failure",
          round: 0,
          started_at: new Date().toISOString(),
          owner_pid: 2_147_483_647,
        },
      });
      fs.writeFileSync(store.metaPath(session.session_id), JSON.stringify(meta), "utf8");

      const recovered = await store.recoverInterruptedSessions(new Set());
      assert.equal(recovered.length, 1);
      const after = store.read(session.session_id) as typeof session & {
        generation_in_flight?: unknown;
      };
      assert.equal(after.generation_in_flight, undefined);
      assert.equal(after.failed_attempts?.[0]?.billing_status, "unknown");
      assert.equal(sessionCostBreakdown(after).unpriced_failed_attempts, 1);
      assert.equal(sessionCostBreakdown(after).reconciled, false);
    },
  },
  {
    name: "generation-result-and-marker-settlement-are-one-durable-transition",
    run: async () => {
      const store = new SessionStore(config("generation-marker-success"));
      const session = await store.init("Generation marker success settlement", "operator", []);
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "initial-draft-failure",
        round: 0,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      const generation: GenerationResult = {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        text: "settled generation",
        raw: {},
        latency_ms: 1,
        attempts: 1,
      };

      await store.saveGeneration(session.session_id, 0, generation, "initial-draft");

      const meta = store.read(session.session_id);
      assert.equal(meta.generation_in_flight, undefined);
      assert.equal(meta.generation_files?.length, 1);
      assert.equal(meta.failed_attempts?.length ?? 0, 0);
    },
  },
  {
    name: "generation-failure-and-marker-settlement-are-one-durable-transition",
    run: async () => {
      const store = new SessionStore(config("generation-marker-failure"));
      const session = await store.init("Generation marker failure settlement", "operator", []);
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "initial-draft-failure",
        round: 0,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      const failure: PeerFailure = {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        failure_class: "provider_error",
        message: "provider returned an accounted failure",
        retryable: false,
        attempts: 1,
        latency_ms: 1,
        billing_status: "reported",
      };

      await store.recordPeerFailureAccounting(
        session.session_id,
        0,
        failure,
        "initial-draft-failure",
      );

      const meta = store.read(session.session_id);
      assert.equal(meta.generation_in_flight, undefined);
      assert.equal(meta.failed_attempts?.length, 1);
      assert.equal(meta.failed_attempts?.[0]?.message, failure.message);
    },
  },
  {
    name: "late-generation-success-cannot-rewrite-a-cancelled-terminal-snapshot",
    run: async () => {
      const store = new SessionStore(config("late-generation-success"));
      const session = await store.init("Late generation success", "operator", []);
      const jobId = "66666666-6666-4666-8666-666666666666";
      await store.markBackgroundJobRunning(session.session_id, {
        job_id: jobId,
        owner_pid: process.pid,
      });
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "initial-draft-failure",
        round: 0,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      await store.requestCancellation(session.session_id, "cancel while provider runs", jobId);
      await store.markCancelled(session.session_id, "session_cancelled");
      const reportPath = path.join(store.sessionDir(session.session_id), "session-report.md");
      const metaBefore = fs.readFileSync(store.metaPath(session.session_id), "utf8");
      const reportBefore = fs.readFileSync(reportPath, "utf8");

      await assert.rejects(
        () =>
          store.saveGeneration(
            session.session_id,
            0,
            {
              peer: "claude",
              provider: "anthropic",
              model: "claude-fable-5",
              text: "provider returned after cancellation settled",
              raw: {},
              latency_ms: 1,
              attempts: 1,
            },
            "initial-draft",
          ),
        /post_terminal_generation_settlement/,
      );

      assert.equal(fs.readFileSync(store.metaPath(session.session_id), "utf8"), metaBefore);
      assert.equal(fs.readFileSync(reportPath, "utf8"), reportBefore);
    },
  },
  {
    name: "late-generation-failure-cannot-rewrite-a-cancelled-terminal-snapshot",
    run: async () => {
      const store = new SessionStore(config("late-generation-failure"));
      const session = await store.init("Late generation failure", "operator", []);
      const jobId = "77777777-7777-4777-8777-777777777777";
      await store.markBackgroundJobRunning(session.session_id, {
        job_id: jobId,
        owner_pid: process.pid,
      });
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "initial-draft-failure",
        round: 0,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      await store.requestCancellation(session.session_id, "cancel while provider runs", jobId);
      await store.markCancelled(session.session_id, "session_cancelled");
      const reportPath = path.join(store.sessionDir(session.session_id), "session-report.md");
      const metaBefore = fs.readFileSync(store.metaPath(session.session_id), "utf8");
      const reportBefore = fs.readFileSync(reportPath, "utf8");

      await assert.rejects(
        () =>
          store.recordPeerFailureAccounting(
            session.session_id,
            0,
            {
              peer: "claude",
              provider: "anthropic",
              model: "claude-fable-5",
              failure_class: "provider_error",
              message: "provider failed after cancellation settled",
              retryable: false,
              attempts: 1,
              latency_ms: 1,
              billing_status: "reported",
            },
            "initial-draft-failure",
          ),
        /post_terminal_failure_settlement/,
      );

      assert.equal(fs.readFileSync(store.metaPath(session.session_id), "utf8"), metaBefore);
      assert.equal(fs.readFileSync(reportPath, "utf8"), reportBefore);
    },
  },
  {
    name: "finalize-winning-before-generation-marker-prevents-provider-dispatch",
    run: async () => {
      const store = new SessionStore(config("finalize-before-generation-marker"));
      const session = await store.init("Finalize before generation marker", "operator", []);
      await store.finalize(session.session_id, "aborted", "operator_requested");

      await assert.rejects(
        () =>
          store.markBackgroundGenerationInFlight(session.session_id, {
            peer: "claude",
            provider: "anthropic",
            model: "claude-fable-5",
            label: "initial-draft-failure",
            round: 0,
            started_at: new Date().toISOString(),
            owner_pid: process.pid,
          }),
        /session_already_finalized/,
      );
      assert.equal(store.read(session.session_id).generation_in_flight, undefined);
    },
  },
  {
    name: "paid-result-followed-by-abort-retains-billing-on-the-cancelled-failure",
    run: async () => {
      const cfg = config("abort-billing");
      const controller = new AbortController();
      let failure: PeerFailure | undefined;
      try {
        await withRetry(
          cfg,
          async () => {
            controller.abort("after provider settlement");
            return fixturePeer(0.42);
          },
          (error, attempt, started) =>
            classifyProviderError("claude", "fixture", "fixture", error, attempt, started),
          { signal: controller.signal },
        );
      } catch (error) {
        failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      }
      assert.equal(failure?.failure_class, "cancelled");
      assert.equal(failure?.cost?.total_cost, 0.42);
      assert.equal(failure?.unpriced_attempts ?? 0, 0);
    },
  },
  {
    name: "repeated-generation-labels-preserve-distinct-raw-artifacts",
    run: async () => {
      const store = new SessionStore(config("unique-artifacts"));
      const session = await store.init("Unique artifact fixture", "operator", []);
      const generation: GenerationResult = {
        peer: "claude",
        provider: "fixture",
        model: "fixture",
        text: "fixture",
        raw: {},
        latency_ms: 1,
        attempts: 1,
      };
      const first = await store.saveGeneration(session.session_id, 1, generation, "judge-item");
      const second = await store.saveGeneration(session.session_id, 1, generation, "judge-item");
      assert.notEqual(first, second);
      assert.equal(fs.existsSync(path.join(store.sessionDir(session.session_id), first)), true);
      assert.equal(fs.existsSync(path.join(store.sessionDir(session.session_id), second)), true);
    },
  },
  {
    name: "skipped-provider-failures-remain-in-the-durable-cost-ledger",
    run: async () => {
      const cfg = config("skipped-ledger");
      cfg.stub = false;
      cfg.cost_rates = {
        ...cfg.cost_rates,
        claude: { input_per_million: 1, output_per_million: 1 },
      };
      cfg.fallback_models = { ...cfg.fallback_models, claude: [] };
      const skippedFailure: PeerFailure = {
        peer: "claude",
        provider: "anthropic",
        model: cfg.models.claude,
        failure_class: "network",
        message: "fixture network failure after one priced and one unpriced attempt",
        retryable: true,
        attempts: 2,
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        cost: {
          currency: "USD",
          estimated: false,
          source: "configured-rate",
          total_cost: 0.42,
        },
        billing_status: "unknown",
        unpriced_attempts: 1,
        latency_ms: 1,
      };
      const originalCall = AnthropicAdapter.prototype.call;
      AnthropicAdapter.prototype.call = async () => {
        const error = new Error("fixture network failure");
        Object.defineProperty(error, "peerFailure", {
          configurable: true,
          value: skippedFailure,
        });
        throw error;
      };
      try {
        const orchestrator = new CrossReviewOrchestrator(cfg);
        const session = await orchestrator.store.init("Skipped ledger fixture", "operator", []);
        await orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: "Static implementation note with no operational claim.",
          caller: "operator",
          peers: ["claude"],
        });

        const meta = orchestrator.store.read(session.session_id);
        assert.equal(meta.rounds[0]?.convergence.skipped_peers.includes("claude"), true);
        assert.equal(meta.failed_attempts?.length, 1);
        assert.equal(meta.failed_attempts?.[0]?.cost?.total_cost, 0.42);
        assert.equal(meta.totals.cost.total_cost, 0.42);
        assert.equal(meta.costs_per_round?.[0], 0.42);
        const breakdown = sessionCostBreakdown(meta);
        assert.equal(breakdown.unpriced_failed_attempts, 1);
        assert.equal(breakdown.reconciled, false);
      } finally {
        AnthropicAdapter.prototype.call = originalCall;
      }
    },
  },
  {
    name: "failed-lead-generation-is-accounted-before-the-error-escapes",
    run: async () => {
      const cfg = config("lead-generation-ledger");
      cfg.stub = false;
      cfg.cost_rates = {
        ...cfg.cost_rates,
        claude: { input_per_million: 1, output_per_million: 1 },
        gemini: { input_per_million: 1, output_per_million: 1 },
      };
      cfg.fallback_models = { ...cfg.fallback_models, claude: [] };
      const generationFailure: PeerFailure = {
        peer: "claude",
        provider: "anthropic",
        model: cfg.models.claude,
        failure_class: "network",
        message: "fixture generation failed after a priced attempt",
        retryable: true,
        attempts: 2,
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        cost: {
          currency: "USD",
          estimated: false,
          source: "configured-rate",
          total_cost: 0.25,
        },
        billing_status: "unknown",
        unpriced_attempts: 1,
        latency_ms: 1,
      };
      const originalGenerate = AnthropicAdapter.prototype.generate;
      AnthropicAdapter.prototype.generate = async () => {
        const error = new Error("fixture generation failure");
        Object.defineProperty(error, "peerFailure", {
          configurable: true,
          value: generationFailure,
        });
        throw error;
      };
      try {
        const orchestrator = new CrossReviewOrchestrator(cfg);
        const session = await orchestrator.store.init(
          "Compose a static fixture note.",
          "operator",
          [],
        );
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
          /fixture generation failure/,
        );
        const meta = orchestrator.store.read(session.session_id);
        assert.equal(meta.failed_attempts?.length, 1);
        assert.equal(meta.failed_attempts?.[0]?.cost?.total_cost, 0.25);
        assert.equal(meta.totals.cost.total_cost, 0.25);
        const breakdown = sessionCostBreakdown(meta);
        assert.equal(breakdown.unpriced_failed_attempts, 1);
        assert.equal(breakdown.reconciled, false);
      } finally {
        AnthropicAdapter.prototype.generate = originalGenerate;
      }
    },
  },
  {
    name: "persisted-per-call-ceiling-blocks-reviewers-before-dispatch",
    run: async () => {
      const cfg = config("persisted-review-ceiling");
      cfg.stub = false;
      cfg.cost_rates = {
        ...cfg.cost_rates,
        claude: { input_per_million: 1, output_per_million: 1 },
      };
      let calls = 0;
      const originalCall = AnthropicAdapter.prototype.call;
      AnthropicAdapter.prototype.call = async () => {
        calls += 1;
        return {
          ...fixturePeer(0.01),
          peer: "claude",
          provider: "anthropic",
          model: cfg.models.claude,
          model_reported: cfg.models.claude,
        };
      };
      try {
        const orchestrator = new CrossReviewOrchestrator(cfg);
        const session = await orchestrator.store.init("Persisted ceiling fixture", "operator", []);
        await orchestrator.store.setSessionTraceability(session.session_id, {
          requested_max_rounds: 1,
          effective_max_rounds: 1,
          requested_max_cost_usd: 0.000001,
          effective_cost_ceiling_usd: 0.000001,
          cost_ceiling_source: "call_arg",
        });
        const output = await orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: "Static implementation note with no operational claim.",
          caller: "operator",
          peers: ["claude"],
        });
        assert.equal(calls, 0);
        assert.equal(output.round.rejected[0]?.failure_class, "budget_preflight");
      } finally {
        AnthropicAdapter.prototype.call = originalCall;
      }
    },
  },
  {
    name: "per-call-ceiling-blocks-lead-generation-before-dispatch",
    run: async () => {
      const cfg = config("lead-generation-ceiling");
      cfg.stub = false;
      cfg.cost_rates = {
        ...cfg.cost_rates,
        claude: { input_per_million: 1, output_per_million: 1 },
        gemini: { input_per_million: 1, output_per_million: 1 },
      };
      let calls = 0;
      const originalGenerate = AnthropicAdapter.prototype.generate;
      AnthropicAdapter.prototype.generate = async () => {
        calls += 1;
        throw new Error("generation_dispatched_past_budget");
      };
      try {
        const orchestrator = new CrossReviewOrchestrator(cfg);
        const session = await orchestrator.store.init("Lead budget fixture", "operator", []);
        await assert.rejects(
          () =>
            orchestrator.runUntilUnanimous({
              session_id: session.session_id,
              task: session.task,
              caller: "operator",
              lead_peer: "claude",
              peers: ["claude", "gemini"],
              max_rounds: 1,
              max_cost_usd: 0.000001,
            }),
          /generation_budget_preflight/,
        );
        assert.equal(calls, 0);
        const meta = orchestrator.store.read(session.session_id);
        assert.equal(meta.outcome, "max-rounds");
        assert.equal(meta.failed_attempts?.[0]?.failure_class, "budget_preflight");
      } finally {
        AnthropicAdapter.prototype.generate = originalGenerate;
      }
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.4-accounting] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.4-accounting] FAIL: ${regression.name}\n${message}`);
  }
}

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
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
if (failures.length > 0) process.exitCode = 1;
