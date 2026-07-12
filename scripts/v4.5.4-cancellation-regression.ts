import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { sessionCostBreakdown } from "../src/core/reports.js";
import { SessionStore } from "../src/core/session-store.js";
import type {
  AppConfig,
  PeerCallContext,
  PeerFailure,
  PeerProbeResult,
  PeerResult,
  RuntimeEvent,
} from "../src/core/types.js";
import { classifyProviderError } from "../src/peers/errors.js";
import { withRetry } from "../src/peers/retry.js";
import { StubAdapter } from "../src/peers/stub.js";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

type SignalAwareWithRetry = <T>(
  config: AppConfig,
  run: (attempt: number) => Promise<T>,
  onFailure: (error: unknown, attempt: number, started: number) => PeerFailure,
  options?: { signal?: AbortSignal | undefined },
) => Promise<T>;

const signalAwareWithRetry = withRetry as SignalAwareWithRetry;
const tempRoots = new Set<string>();
const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

function tempDataDir(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v454-${label}-`));
  tempRoots.add(root);
  return root;
}

function testConfig(label: string): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    data_dir: tempDataDir(label),
    stub: true,
    evidence_preflight_enabled: false,
    truthfulness_preflight_enabled: false,
    fallback_models: {
      ...base.fallback_models,
      claude: [],
    },
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
    retry: {
      ...base.retry,
      max_attempts: 3,
      base_delay_ms: 1,
      max_delay_ms: 1,
    },
  };
}

function createOrchestrator(
  config: AppConfig,
  persistEvents = false,
): { orchestrator: CrossReviewOrchestrator; observed: RuntimeEvent[] } {
  const observed: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(config, (event) => {
    const stamped = { ...event, ts: event.ts ?? new Date().toISOString() };
    observed.push(stamped);
    if (persistEvents) void orchestrator.store.appendEvent(stamped);
  });
  return { orchestrator, observed };
}

function providerFailure(error: unknown, attempt: number, started: number): PeerFailure {
  return classifyProviderError(
    "perplexity",
    "perplexity",
    "sonar-reasoning-pro",
    error,
    attempt,
    started,
  );
}

const regressions: Regression[] = [
  {
    name: "abort-message-classifies-as-cancelled-nonretryable",
    run: () => {
      const failure = providerFailure(new Error("Request was aborted"), 1, Date.now());
      assert.equal(failure.failure_class, "cancelled");
      assert.equal(failure.retryable, false);
    },
  },
  {
    name: "withRetry-preaborted-signal-makes-zero-calls",
    run: async () => {
      const config = testConfig("retry-preaborted");
      const controller = new AbortController();
      controller.abort("regression_preaborted");
      let calls = 0;
      let rejected = false;
      try {
        await signalAwareWithRetry(
          config,
          async () => {
            calls += 1;
            return "must-not-run";
          },
          providerFailure,
          { signal: controller.signal },
        );
      } catch {
        rejected = true;
      }
      assert.equal(calls, 0, "a pre-aborted signal must prevent attempt 1");
      assert.equal(rejected, true, "a pre-aborted retry operation must reject as cancelled");
    },
  },
  {
    name: "withRetry-abort-during-attempt-never-starts-attempt-two",
    run: async () => {
      const config = testConfig("retry-midabort");
      const controller = new AbortController();
      let calls = 0;
      let terminalFailure: PeerFailure | undefined;
      try {
        await signalAwareWithRetry(
          config,
          async () => {
            calls += 1;
            controller.abort("regression_mid_attempt");
            throw new Error("Request was aborted");
          },
          (error, attempt, started) => {
            terminalFailure = providerFailure(error, attempt, started);
            return terminalFailure;
          },
          { signal: controller.signal },
        );
      } catch {
        // Expected cancellation.
      }
      assert.equal(calls, 1, "AbortSignal must be a hard retry barrier");
      assert.equal(terminalFailure?.failure_class, "cancelled");
      assert.equal(terminalFailure?.retryable, false);
    },
  },
  {
    name: "max-rounds-is-a-hard-limit-and-effective-metadata-is-truthful",
    run: async () => {
      const { orchestrator } = createOrchestrator(testConfig("hard-max-rounds"));
      const result = await orchestrator.runUntilUnanimous({
        task: "v4.5.4 regression: max_rounds must be a hard caller ceiling.",
        initial_draft: "FORCE_NEEDS_EVIDENCE",
        caller: "operator",
        lead_peer: "codex",
        peers: ["claude"],
        max_rounds: 1,
      });
      const meta = orchestrator.store.read(result.session.session_id);
      assert.equal(result.rounds, 1, "max_rounds=1 must execute exactly one review round");
      assert.equal(meta.rounds.length, 1);
      assert.equal(meta.effective_max_rounds, 1);
      assert.ok(
        (meta.effective_max_rounds ?? 0) >= meta.rounds.length,
        "effective_max_rounds must never be lower than the number of persisted rounds",
      );
    },
  },
  {
    name: "persisted-cancellation-blocks-format-recovery",
    run: async () => {
      const { orchestrator, observed } = createOrchestrator(testConfig("cancel-recovery"));
      const originalCall = StubAdapter.prototype.call;
      let firstReview = true;
      StubAdapter.prototype.call = async function (
        prompt: string,
        context: PeerCallContext,
      ): Promise<PeerResult> {
        if (firstReview) {
          firstReview = false;
          const result = await originalCall.call(this, `${prompt}\nFORCE_BAD_FORMAT`, context);
          await orchestrator.store.requestCancellation(
            context.session_id,
            "regression_cancel_before_recovery",
          );
          return result;
        }
        return originalCall.call(this, prompt, context);
      };
      try {
        await orchestrator.askPeers({
          task: "v4.5.4 regression: cancellation blocks format recovery.",
          draft: "ordinary draft",
          caller: "operator",
          peers: ["claude"],
        });
      } finally {
        StubAdapter.prototype.call = originalCall;
      }
      assert.equal(
        observed.some((event) => event.type === "peer.format_recovery.started"),
        false,
        "persisted cancellation must prevent a paid format/decision recovery",
      );
    },
  },
  {
    name: "persisted-cancellation-blocks-fallback",
    run: async () => {
      const config = testConfig("cancel-fallback");
      config.fallback_models = { ...config.fallback_models, claude: ["claude-fallback"] };
      const { orchestrator } = createOrchestrator(config);
      const originalCall = StubAdapter.prototype.call;
      let fallbackCalls = 0;
      StubAdapter.prototype.call = async function (
        prompt: string,
        context: PeerCallContext,
      ): Promise<PeerResult> {
        if (this.id === "claude" && !this.model.includes("fallback")) {
          await orchestrator.store.requestCancellation(
            context.session_id,
            "regression_cancel_before_fallback",
          );
          throw new Error("network fetch failed");
        }
        if (this.id === "claude") fallbackCalls += 1;
        return originalCall.call(this, prompt, context);
      };
      try {
        await orchestrator.askPeers({
          task: "v4.5.4 regression: cancellation blocks fallback.",
          draft: "ordinary draft",
          caller: "operator",
          peers: ["claude"],
        });
      } finally {
        StubAdapter.prototype.call = originalCall;
      }
      assert.equal(fallbackCalls, 0, "persisted cancellation must prevent fallback dispatch");
    },
  },
  {
    name: "persisted-cancellation-blocks-evidence-judge",
    run: async () => {
      const config = testConfig("cancel-judge");
      config.evidence_judge_autowire = {
        ...config.evidence_judge_autowire,
        mode: "shadow",
        active: true,
        peer: "claude",
      };
      const { orchestrator, observed } = createOrchestrator(config);
      const appendItems = orchestrator.store.appendEvidenceChecklistItems.bind(orchestrator.store);
      orchestrator.store.appendEvidenceChecklistItems = async (...args) => {
        const result = await appendItems(...args);
        await orchestrator.store.requestCancellation(args[0], "regression_cancel_before_judge");
        return result;
      };
      await orchestrator.askPeers({
        task: "v4.5.4 regression: cancellation blocks evidence judges.",
        draft: "FORCE_NEEDS_EVIDENCE",
        caller: "operator",
        // The judge is Claude. Gemini's independent ask ensures this exercises
        // a real judge dispatch rather than the self_judgment_forbidden skip.
        peers: ["claude", "gemini"],
      });
      assert.equal(
        observed.some((event) => event.type === "peer.judge.started"),
        false,
        "persisted cancellation must prevent judge dispatch",
      );
    },
  },
  {
    name: "persisted-cancellation-blocks-auto-grant-and-relator",
    run: async () => {
      const { orchestrator, observed } = createOrchestrator(testConfig("cancel-auto-grant"));
      const askPeers = orchestrator.askPeers.bind(orchestrator);
      let cancellationPersistedAt = -1;
      let injected = false;
      orchestrator.askPeers = async (input) => {
        const result = await askPeers(input);
        if (!injected) {
          injected = true;
          await orchestrator.store.requestCancellation(
            result.session.session_id,
            "regression_cancel_before_auto_grant",
          );
          cancellationPersistedAt = observed.length;
        }
        return result;
      };
      const result = await orchestrator.runUntilUnanimous({
        task: "v4.5.4 regression: cancellation blocks auto-grant and relator.",
        initial_draft: "FORCE_NEEDS_EVIDENCE",
        caller: "operator",
        lead_peer: "codex",
        peers: ["claude"],
        max_rounds: 1,
      });
      const afterCancellation = observed.slice(cancellationPersistedAt);
      assert.equal(
        afterCancellation.some((event) => event.type === "session.auto_round_granted"),
        false,
        "cancelled sessions must not authorize a new round",
      );
      assert.equal(
        afterCancellation.some((event) => event.type === "peer.generate.started"),
        false,
        "cancelled sessions must not start a relator revision",
      );
      assert.equal(result.session.outcome, "aborted");
      assert.equal(result.session.outcome_reason, "session_cancelled");
    },
  },
  {
    name: "terminal-report-meta-and-events-agree-without-manual-refresh",
    run: async () => {
      const { orchestrator } = createOrchestrator(testConfig("terminal-report"), true);
      const result = await orchestrator.runUntilUnanimous({
        task: "v4.5.4 regression: terminal report must be current automatically.",
        initial_draft: "FORCE_NOT_READY",
        caller: "operator",
        lead_peer: "codex",
        peers: ["claude"],
        max_rounds: 1,
      });
      await orchestrator.store.flushPendingEvents();
      const sessionId = result.session.session_id;
      const meta = orchestrator.store.read(sessionId);
      const report = fs.readFileSync(
        path.join(orchestrator.store.sessionDir(sessionId), "session-report.md"),
        "utf8",
      );
      const events = orchestrator.store.readEvents(sessionId);
      assert.equal(meta.outcome, "max-rounds");
      assert.match(report, /^- Outcome: max-rounds$/m);
      assert.match(report, /^- Outcome reason: max_rounds_without_unanimity$/m);
      assert.equal(events.at(-1)?.type, "session.finalized");
      assert.equal(events.at(-1)?.data?.reason, meta.outcome_reason);
    },
  },
  {
    name: "mark-cancelled-accounts-an-interrupted-in-flight-round",
    run: async () => {
      const store = new SessionStore(testConfig("cancelled-in-flight-accounting"));
      const session = await store.init("cancelled in-flight accounting", "operator", []);
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
      await store.requestCancellation(session.session_id, "cancel with providers in flight");
      await store.markCancelled(session.session_id, "session_cancelled");

      const meta = store.read(session.session_id);
      assert.equal(meta.in_flight, undefined);
      assert.equal(meta.failed_attempts?.length, 2);
      assert.deepEqual(meta.failed_attempts?.map((failure) => failure.peer).sort(), [
        "claude",
        "gemini",
      ]);
      assert.equal(sessionCostBreakdown(meta).unpriced_failed_attempts, 2);
      assert.equal(sessionCostBreakdown(meta).reconciled, false);
    },
  },
  {
    name: "events-A-B-C-remain-before-terminal-transition",
    run: async () => {
      const badOrders: string[][] = [];
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const store = new SessionStore(testConfig(`event-order-${iteration}`));
        const session = await store.init(`event order ${iteration}`, "operator", []);
        const pending = ["A", "B", "C"].map((message) =>
          store.appendEvent({
            type: "session.regression_event",
            session_id: session.session_id,
            message,
          }),
        );
        await store.finalize(session.session_id, "aborted", "regression_terminal");
        await Promise.all(pending);
        const order = store.readEvents(session.session_id).map((event) => event.message ?? "");
        const expected = ["A", "B", "C", "Session finalized as aborted: regression_terminal"];
        if (JSON.stringify(order) !== JSON.stringify(expected)) badOrders.push(order);
      }
      assert.deepEqual(
        badOrders,
        [],
        `fire-and-forget events were overtaken by terminal persistence: ${JSON.stringify(badOrders)}`,
      );
    },
  },
  {
    name: "contest-successor-preserves-snapshot-focus-and-seed-draft",
    run: async () => {
      const config = testConfig("contest-custody");
      const store = new SessionStore(config);
      const snapshot: PeerProbeResult[] = [
        {
          peer: "claude",
          provider: "anthropic",
          model: "claude-fable-5",
          available: true,
          auth_present: true,
          latency_ms: 7,
        },
      ];
      const focus = "Preserve this exact contest review focus.";
      const seedDraft = "# Contested successor seed\n\nPreserve this draft verbatim.";
      const original = await store.init("original contested task", "operator", snapshot, focus);
      await store.finalize(original.session_id, "max-rounds", "regression_fixture");
      const contested = await store.contestVerdict({
        session_id: original.session_id,
        reason: "Open a successor without dropping the autos.",
        new_task: "successor task",
        new_initial_draft: seedDraft,
        new_caller: "operator",
      });
      const successor = store.read(contested.new_session_id);
      assert.deepEqual(successor.capability_snapshot, snapshot);
      assert.equal(successor.review_focus, focus);
      const seedPath = path.join(
        store.sessionDir(successor.session_id),
        "agent-runs",
        "round-0-draft.md",
      );
      assert.equal(fs.existsSync(seedPath), true, "new_initial_draft must be durably persisted");
      assert.equal(fs.readFileSync(seedPath, "utf8"), seedDraft);
    },
  },
  {
    name: "reason-limits-are-exposed-in-tool-schemas-and-descriptions",
    run: () => {
      const source = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
      const contracts = [
        { tool: "session_cancel_job", max: 300 },
        { tool: "contest_verdict", max: 4_000 },
        { tool: "escalate_to_operator", max: 1_000 },
        { tool: "session_sweep", max: 200 },
        { tool: "session_finalize", max: 200 },
      ];
      const missing: string[] = [];
      for (const contract of contracts) {
        const marker = `registerTool(\n    "${contract.tool}"`;
        const start = source.indexOf(marker);
        const end = start < 0 ? -1 : source.indexOf("registerTool(", start + marker.length);
        const block = start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
        const schemaPrefix = block.slice(0, block.indexOf("annotations:"));
        const maxPattern = new RegExp(
          `reason:\\s*z\\.string\\(\\)${
            contract.tool === "session_finalize" ? "" : "\\.min\\(1\\)"
          }\\.max\\(${String(contract.max).replace(/000$/, "_?000")}\\)`,
        );
        if (!maxPattern.test(schemaPrefix))
          missing.push(`${contract.tool}:schema-max=${contract.max}`);
        const descriptionPrefix = block.slice(0, block.indexOf("inputSchema:"));
        const humanMaxPattern = new RegExp(
          `\\b${contract.max.toLocaleString("en-US").replace(",", "[,]?")}\\b`,
        );
        if (!humanMaxPattern.test(descriptionPrefix)) {
          missing.push(`${contract.tool}:description-max=${contract.max}`);
        }
      }
      assert.deepEqual(
        missing,
        [],
        `undocumented or missing reason constraints: ${missing.join(", ")}`,
      );
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.4-regression] ${regression.name}: PASS`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.4-regression] ${regression.name}: RED\n${message}`);
  }
}

for (const root of tempRoots) {
  fs.rmSync(root, { recursive: true, force: true });
}
if (previousStubConfirmation === undefined) delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
else process.env.CROSS_REVIEW_STUB_CONFIRMED = previousStubConfirmation;

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
