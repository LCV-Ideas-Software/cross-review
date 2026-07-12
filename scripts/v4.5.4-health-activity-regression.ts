import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { sessionReportMarkdown } from "../src/core/reports.js";
import { SessionStore } from "../src/core/session-store.js";
import type { AppConfig, ConvergenceHealth, RuntimeEvent, SessionMeta } from "../src/core/types.js";

type AuditableHealth = ConvergenceHealth & {
  last_activity_at?: string | undefined;
  last_state_transition_at?: string | undefined;
};

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const roots: string[] = [];
const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

function storeFor(label: string): SessionStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v454-health-${label}-`));
  roots.push(dataDir);
  return new SessionStore({ ...loadConfig(), data_dir: dataDir });
}

function health(meta: SessionMeta): AuditableHealth {
  assert.ok(meta.convergence_health, "session must persist convergence health");
  return meta.convergence_health as AuditableHealth;
}

function orchestratorFor(
  label: string,
  mutateConfig?: (config: AppConfig) => void,
): CrossReviewOrchestrator {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v454-terminal-${label}-`));
  roots.push(dataDir);
  const config: AppConfig = {
    ...loadConfig(),
    data_dir: dataDir,
    stub: true,
    evidence_preflight_enabled: false,
    truthfulness_preflight_enabled: false,
  };
  mutateConfig?.(config);
  const holder: { orchestrator?: CrossReviewOrchestrator } = {};
  const emit = (event: RuntimeEvent): void => {
    void holder.orchestrator?.store.appendEvent(event);
  };
  const orchestrator = new CrossReviewOrchestrator(config, emit);
  holder.orchestrator = orchestrator;
  return orchestrator;
}

async function assertTerminalEventAndCompleteReport(
  orchestrator: CrossReviewOrchestrator,
  sessionId: string,
  requiredEventType: string,
): Promise<void> {
  await orchestrator.store.flushPendingEvents();
  const events = orchestrator.store.readEvents(sessionId);
  assert.equal(
    events.at(-1)?.type,
    "session.finalized",
    `${requiredEventType} must be persisted before the terminal session.finalized event`,
  );
  assert.equal(
    events.filter((event) => event.type === "session.finalized").length,
    1,
    "a terminal flow must persist exactly one session.finalized event",
  );
  const report = fs.readFileSync(
    path.join(orchestrator.store.sessionDir(sessionId), "session-report.md"),
    "utf8",
  );
  assert.match(
    report,
    new RegExp(requiredEventType.replaceAll(".", "\\.")),
    `terminal report must contain ${requiredEventType}`,
  );
  assert.match(report, /session\.finalized/, "terminal report must contain session.finalized");
}

const regressions: Regression[] = [
  {
    name: "activity-events-do-not-masquerade-as-state-transitions",
    run: async () => {
      const store = storeFor("activity");
      const initialized = await store.init("health activity regression", "operator", []);
      const initialHealth = health(initialized);
      assert.ok(initialHealth.last_activity_at, "init must persist last_activity_at");
      assert.ok(
        initialHealth.last_state_transition_at,
        "init must persist last_state_transition_at",
      );
      assert.equal(initialHealth.last_event_at, initialHealth.last_activity_at);

      const transitionAt = initialHealth.last_state_transition_at;
      assert.ok(transitionAt);
      const activityAt = new Date(Date.parse(transitionAt) + 1_000).toISOString();
      await store.appendEvent({
        type: "provider.token",
        session_id: initialized.session_id,
        ts: activityAt,
        message: "provider remains active without changing convergence state",
        data: { delta_chars: 8 },
      });

      const active = store.read(initialized.session_id);
      const activeHealth = health(active);
      assert.equal(activeHealth.state, "idle");
      assert.equal(activeHealth.last_activity_at, activityAt);
      assert.equal(activeHealth.last_event_at, activityAt, "legacy alias must track activity");
      assert.equal(
        activeHealth.last_state_transition_at,
        transitionAt,
        "an event without a health transition must not move the transition timestamp",
      );
    },
  },
  {
    name: "legacy-last-event-at-remains-a-compatible-activity-alias",
    run: async () => {
      const store = storeFor("legacy");
      const initialized = await store.init("legacy health timestamp regression", "operator", []);
      const metaPath = store.metaPath(initialized.session_id);
      const legacy = JSON.parse(fs.readFileSync(metaPath, "utf8")) as SessionMeta;
      const originalLastEvent = health(legacy).last_event_at;
      delete (legacy.convergence_health as AuditableHealth).last_activity_at;
      delete (legacy.convergence_health as AuditableHealth).last_state_transition_at;
      fs.writeFileSync(metaPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

      const activityAt = new Date(Date.parse(originalLastEvent) + 2_000).toISOString();
      await store.appendEvent({
        type: "provider.token",
        session_id: initialized.session_id,
        ts: activityAt,
        data: { delta_chars: 3 },
      });
      const migratedHealth = health(store.read(initialized.session_id));
      assert.equal(migratedHealth.last_activity_at, activityAt);
      assert.equal(migratedHealth.last_event_at, activityAt);
      assert.equal(
        migratedHealth.last_state_transition_at,
        originalLastEvent,
        "legacy last_event_at must seed the missing transition timestamp",
      );
    },
  },
  {
    name: "terminal-abort-health-exposes-the-real-outcome",
    run: async () => {
      const store = storeFor("abort");
      const initialized = await store.init("terminal abort health regression", "operator", []);
      const terminal = await store.finalize(
        initialized.session_id,
        "aborted",
        "needs_truthfulness_preflight",
      );
      const terminalHealth = health(terminal);
      assert.equal(terminal.outcome, "aborted");
      assert.equal(terminal.outcome_reason, "needs_truthfulness_preflight");
      assert.equal(terminalHealth.state, "aborted");
      assert.match(terminalHealth.detail, /needs_truthfulness_preflight/);
      assert.equal(terminalHealth.last_event_at, terminalHealth.last_activity_at);
      assert.ok(terminalHealth.last_state_transition_at);

      const report = sessionReportMarkdown(terminal, store.readEvents(initialized.session_id));
      assert.match(report, /Outcome reason: needs_truthfulness_preflight/);
      assert.match(report, /Health: aborted - needs_truthfulness_preflight/);
      assert.match(report, /Last activity:/);
      assert.match(report, /Last state transition:/);
    },
  },
  {
    name: "terminal-cancellation-is-not-reported-as-stale",
    run: async () => {
      const store = storeFor("cancelled");
      const initialized = await store.init(
        "terminal cancellation health regression",
        "operator",
        [],
      );
      await store.requestCancellation(initialized.session_id, "operator stopped the run");
      const terminal = await store.markCancelled(initialized.session_id, "session_cancelled");
      const terminalHealth = health(terminal);
      assert.equal(terminal.outcome, "aborted");
      assert.equal(terminal.outcome_reason, "session_cancelled");
      assert.equal(terminalHealth.state, "cancelled");
      assert.match(terminalHealth.detail, /session_cancelled/);
    },
  },
  {
    name: "post-terminal-events-are-rejected-without-rewriting-the-append-only-stream",
    run: async () => {
      const store = storeFor("append-only-terminal");
      const initialized = await store.init("append-only terminal regression", "operator", []);
      await store.finalize(initialized.session_id, "aborted", "fixture_terminal");
      const before = fs.readFileSync(store.eventsPath(initialized.session_id), "utf8");

      await store.appendEvent({
        type: "round.completed",
        session_id: initialized.session_id,
        message: "this event arrived too late and must not rewrite history",
      });
      await store.flushPendingEvents();

      const after = fs.readFileSync(store.eventsPath(initialized.session_id), "utf8");
      assert.equal(
        after,
        before,
        "post-terminal rejection must preserve events.ndjson byte-for-byte",
      );
      assert.equal(store.readEvents(initialized.session_id).at(-1)?.type, "session.finalized");
    },
  },
  {
    name: "idle-sweep-regenerates-a-complete-terminal-report",
    run: async () => {
      const store = storeFor("idle-sweep-report");
      const initialized = await store.init("idle sweep terminal report", "operator", []);
      store.saveReport(initialized.session_id, sessionReportMarkdown(initialized, []));
      const stale = store.read(initialized.session_id);
      stale.updated_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(store.metaPath(initialized.session_id), JSON.stringify(stale), "utf8");

      const swept = await store.sweepIdle(24 * 60 * 60 * 1000, "aborted", "stale");
      assert.equal(swept.length, 1);
      assert.equal(store.readEvents(initialized.session_id).at(-1)?.type, "session.finalized");
      const report = fs.readFileSync(
        path.join(store.sessionDir(initialized.session_id), "session-report.md"),
        "utf8",
      );
      assert.match(report, /Outcome: aborted/);
      assert.match(report, /Outcome reason: stale/);
      assert.match(report, /session\.finalized/);
    },
  },
  {
    name: "budget-preflight-persists-operational-event-before-terminal-and-in-report",
    run: async () => {
      const orchestrator = orchestratorFor("budget", (config) => {
        config.cost_rates = {
          ...config.cost_rates,
          codex: { input_per_million: 1, output_per_million: 1 },
        };
        config.budget = {
          ...config.budget,
          preflight_max_round_cost_usd: 0.000000001,
          max_session_cost_usd: 10_000,
        };
      });
      const result = await orchestrator.askPeers({
        task: "Terminal ordering budget-preflight regression.",
        draft: "Static review artifact.",
        caller: "operator",
        peers: ["codex"],
      });
      assert.equal(result.session.outcome_reason, "budget_preflight");
      await assertTerminalEventAndCompleteReport(
        orchestrator,
        result.session.session_id,
        "round.blocked.budget_preflight",
      );
    },
  },
  {
    name: "converged-round-completes-before-terminal-and-is-present-in-report",
    run: async () => {
      const orchestrator = orchestratorFor("converged", (config) => {
        config.budget = {
          ...config.budget,
          preflight_max_round_cost_usd: 10_000,
          max_session_cost_usd: 10_000,
        };
      });
      const result = await orchestrator.askPeers({
        task: "Terminal ordering convergence regression.",
        draft: "Static review artifact with no blocking defect.",
        caller: "operator",
        peers: ["codex"],
      });
      assert.equal(result.converged, true);
      assert.equal(result.session.outcome, "converged");
      await assertTerminalEventAndCompleteReport(
        orchestrator,
        result.session.session_id,
        "round.completed",
      );
    },
  },
];

const failures: string[] = [];
try {
  for (const regression of regressions) {
    try {
      await regression.run();
      console.log(`[health-activity] ${regression.name}: PASS`);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      failures.push(`${regression.name}: ${message}`);
      console.error(`[health-activity] ${regression.name}: RED`);
    }
  }
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  if (previousStubConfirmation === undefined) delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
  else process.env.CROSS_REVIEW_STUB_CONFIRMED = previousStubConfirmation;
}

if (failures.length > 0) {
  throw new Error(`health/activity regressions (${failures.length}):\n${failures.join("\n\n")}`);
}

console.log(`[health-activity] ${regressions.length}/${regressions.length} regressions passed.`);
