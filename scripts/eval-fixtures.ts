import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { truthfulnessPreflight } from "../src/core/orchestrator.js";
import { sessionReportMarkdown } from "../src/core/reports.js";
import { SessionStore } from "../src/core/session-store.js";
import { parsePeerStatus } from "../src/core/status.js";

function evalTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-eval-${label}-`));
}

export const truthfulnessCases = [
  {
    name: "current runtime contradiction is blocked",
    input: {
      task: "The current cross-review runtime is 4.2.4.",
      runtimeFacts: { runtime_version: "4.2.5", release_date: "2026-06-05" },
      attachmentsPresent: false,
    },
    expectPass: false,
    expectIssueClass: "runtime_contradiction",
  },
  {
    name: "matching current runtime facts pass",
    input: {
      task: "server_info shows current cross-review runtime 4.2.5.",
      runtimeFacts: { runtime_version: "4.2.5", release_date: "2026-06-05" },
      attachmentsPresent: false,
    },
    expectPass: true,
  },
  {
    name: "historical timing claim needs snapshot evidence",
    input: {
      task: "When the audit began, cross-review was running 4.2.4.",
      runtimeFacts: { runtime_version: "4.2.5", release_date: "2026-06-05" },
      attachmentsPresent: false,
    },
    expectPass: false,
    expectIssueClass: "unsupported_historical_claim",
  },
] as const;

export const parserCases = [
  {
    name: "verified with empty evidence gets empty-evidence warning",
    text: JSON.stringify({
      status: "READY",
      summary: "ok",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: [],
      follow_ups: [],
    }),
    expectStatus: "READY",
    expectWarning: "verified_without_evidence_sources",
  },
  {
    name: "verified with attached evidence path is concrete",
    text: JSON.stringify({
      status: "READY",
      summary: "ok",
      confidence: "verified",
      evidence_sources: ["evidence/2026-06-05T00-00-00Z-raw-smoke.txt: npm test 42 passed"],
      caller_requests: [],
      follow_ups: [],
    }),
    expectStatus: "READY",
    absentWarning: "verified_without_evidence_sources",
  },
] as const;

export const reportCases = [
  {
    name: "cost split and unresolved evidence are surfaced",
    peerCost: 14.652426,
    generationCost: 1.876718,
    totalCost: 16.529144,
    unresolvedAsk: "attach raw npm test output",
  },
] as const;

for (const testCase of truthfulnessCases) {
  const result = truthfulnessPreflight({
    task: testCase.input.task,
    runtimeFacts: testCase.input.runtimeFacts,
    attachmentsPresent: testCase.input.attachmentsPresent,
  });
  assert.equal(result.pass, testCase.expectPass, testCase.name);
  if ("expectIssueClass" in testCase) {
    assert.ok(result.issue_classes.includes(testCase.expectIssueClass), testCase.name);
  }
}

for (const testCase of parserCases) {
  const result = parsePeerStatus(testCase.text);
  assert.equal(result.status, testCase.expectStatus, testCase.name);
  if ("expectWarning" in testCase) {
    assert.ok(result.parser_warnings.includes(testCase.expectWarning), testCase.name);
  }
  if ("absentWarning" in testCase) {
    assert.ok(!result.parser_warnings.includes(testCase.absentWarning), testCase.name);
  }
}

for (const testCase of reportCases) {
  const store = new SessionStore({
    ...loadConfig(),
    data_dir: evalTmpDir("report"),
  });
  const session = await store.init(`eval report fixture: ${testCase.name}`, "operator", []);
  const meta = store.read(session.session_id);
  const ts = new Date().toISOString();
  meta.rounds = [
    {
      round: 1,
      started_at: ts,
      completed_at: ts,
      caller_status: "READY",
      prompt_file: "agent-runs/round-1-prompt.md",
      peers: [
        {
          peer: "codex",
          provider: "openai",
          model: "gpt-5.5",
          status: "READY",
          structured: {
            status: "READY",
            summary: "ready",
            confidence: "verified",
            evidence_sources: ["server_info: version 4.2.5"],
            caller_requests: [],
            follow_ups: [],
          },
          text: "{}",
          raw: { fixture: true },
          decision_quality: "clean",
          parser_warnings: [],
          attempts: 1,
          latency_ms: 1,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          cost: {
            currency: "USD",
            estimated: false,
            source: "configured-rate",
            total_cost: testCase.peerCost,
          },
        },
      ],
      rejected: [],
      convergence: {
        converged: true,
        reason: "fixture",
        ready_peers: ["codex"],
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
    },
  ];
  meta.generation_files = [
    {
      round: 0,
      peer: "codex",
      label: "initial_draft",
      path: "agent-runs/round-0-initial-draft.md",
      ts,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      cost: {
        currency: "USD",
        estimated: false,
        source: "configured-rate",
        total_cost: testCase.generationCost,
      },
    },
  ];
  meta.totals.cost = {
    currency: "USD",
    estimated: false,
    source: "configured-rate",
    total_cost: testCase.totalCost,
  };
  meta.evidence_checklist = [
    {
      id: "eval-1",
      peer: "codex",
      first_round: 1,
      last_round: 1,
      round_count: 1,
      ask: testCase.unresolvedAsk,
      first_seen_at: ts,
      last_seen_at: ts,
      status: "not_resurfaced",
      addressed_at_round: 2,
      address_method: "resurfacing",
    },
  ];
  fs.writeFileSync(store.metaPath(session.session_id), JSON.stringify(meta));
  const report = sessionReportMarkdown(store.read(session.session_id), []);
  assert.ok(report.includes("$16.529144 USD = $14.652426 peer + $1.876718 generation"));
  assert.ok(report.includes("## Unresolved Evidence Disposition"));
  assert.ok(report.includes(testCase.unresolvedAsk));
}

console.log(
  JSON.stringify({
    ok: true,
    truthfulness_cases: truthfulnessCases.length,
    parser_cases: parserCases.length,
    report_cases: reportCases.length,
  }),
);
