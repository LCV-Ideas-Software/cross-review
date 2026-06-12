import assert from "node:assert/strict";
import fs from "node:fs";

import { truthfulnessPreflight } from "../src/core/orchestrator.js";

// v4.3.9: extracted from scripts/smoke.ts so truthfulness preflight can be
// verified independently of the full smoke suite.
// v4.2.2 — truthfulness_preflight_test. Pins the guard added after the
// Claude Code Opus 4.8 incident where a report asserted
// "v4.2.0 current production" despite live server_info showing
// v4.2.1. The old evidence preflight only checked completed-work
// claims (tests/diff/build) and did not reject current-runtime
// contradictions or unsupported historical timing narratives.
{
  const runtimeFacts = {
    runtime_version: "4.2.1",
    release_date: "2026-05-21",
    model_pins: {
      claude: "claude-opus-4-8",
      grok: "grok-4.3",
    },
  };

  const contradictedByRuntime = truthfulnessPreflight({
    task: "Audit all sessions generated with the current cross-review version.",
    initialDraft:
      'Live server_info: {"version":"4.2.1","release_date":"2026-05-21"}\nAudit report for cross-review v4.2.0 current production, released 2026-05-17.',
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    contradictedByRuntime.pass,
    false,
    "v4.2.2 / truthfulness_preflight: current-runtime version claim contradicting runtime facts must trip even when server_info text is present",
  );
  assert.ok(
    contradictedByRuntime.contradictions.some((item: string) => item.includes("4.2.0")),
    "v4.2.2 / truthfulness_preflight: mismatch diagnostics must include the contradicted version token",
  );
  assert.ok(
    contradictedByRuntime.issue_classes?.includes("runtime_contradiction"),
    "v4.2.4 / truthfulness_preflight: runtime contradictions must surface issue_classes=runtime_contradiction",
  );

  const backedByRuntime = truthfulnessPreflight({
    task: "Audit all sessions generated with the current cross-review version.",
    initialDraft:
      'Live server_info: {"version":"4.2.1","release_date":"2026-05-21"}\nAudit report for cross-review v4.2.1 current production, released 2026-05-21.',
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    backedByRuntime.pass,
    true,
    "v4.2.2 / truthfulness_preflight: current-runtime claim matching runtime facts must pass",
  );

  const unsupportedCurrentState = truthfulnessPreflight({
    task: "Audit all sessions generated with the current cross-review version.",
    initialDraft: "Audit report for cross-review v4.2.1 current production.",
    runtimeFacts: {},
    attachmentsPresent: false,
  });
  assert.equal(
    unsupportedCurrentState.pass,
    false,
    "v4.2.2 / truthfulness_preflight: current-runtime claim without runtime facts or source evidence must trip",
  );
  assert.ok(
    unsupportedCurrentState.issue_classes?.includes("unsupported_current_state_claim"),
    "v4.2.4 / truthfulness_preflight: unsupported current-state claims must have their own issue class",
  );

  const historicalChangelog = truthfulnessPreflight({
    task: "Review this changelog text.",
    initialDraft: "v4.2.0 was released on 2026-05-17. v4.2.1 was released on 2026-05-21.",
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    historicalChangelog.pass,
    true,
    "v4.2.2 / truthfulness_preflight: historical version text without current/timing claims must not trip",
  );

  const fabricatedTiming = truthfulnessPreflight({
    task: "Explain why the report said v4.2.0.",
    initialDraft:
      "When the workflow began, cross-review was running v4.2.0. It was bumped to v4.2.1 between R1 and R3.",
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    fabricatedTiming.pass,
    false,
    "v4.2.2 / truthfulness_preflight: historical runtime timing narrative without snapshot evidence must trip",
  );
  assert.ok(
    fabricatedTiming.issue_classes?.includes("unsupported_historical_claim"),
    "v4.2.4 / truthfulness_preflight: historical timing claims without snapshot evidence must surface unsupported_historical_claim",
  );
  assert.ok(
    /attachments_present=false/.test(fabricatedTiming.reason) &&
      /session_attach_evidence/.test(fabricatedTiming.reason),
    "v4.2.4 / truthfulness_preflight: failure reason must tell operators that no attachment was visible and how to fix it",
  );

  const fabricatedWorkflowClaim = truthfulnessPreflight({
    task: "Summarize the release closure.",
    initialDraft:
      "I triggered the workflow dispatch after operator authorization and confirmed the remote deployment succeeded.",
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    fabricatedWorkflowClaim.pass,
    false,
    "v4.2.4 / truthfulness_preflight: fabricated workflow or authorization claims must trip before paid calls",
  );
  assert.ok(
    fabricatedWorkflowClaim.issue_classes?.includes("fabrication_pattern"),
    "v4.2.4 / truthfulness_preflight: fabricated workflow/authorization claims must surface issue_classes=fabrication_pattern",
  );

  const withStructuredEvidence = truthfulnessPreflight({
    task: "Explain why the report said v4.2.0.",
    initialDraft:
      "When the workflow began, cross-review was running v4.2.0. It was bumped to v4.2.1 between R1 and R3.",
    runtimeFacts,
    structuredEvidence:
      "Historical runtime snapshot from events.ndjson: workflow_start server_info version=4.2.0; later reload server_info version=4.2.1.",
    attachmentsPresent: false,
  });
  assert.equal(
    withStructuredEvidence.pass,
    true,
    "v4.2.2 / truthfulness_preflight: structured evidence can satisfy historical timing claims",
  );

  const orchSrcTruth = fs.readFileSync(
    new URL("../src/core/orchestrator.ts", import.meta.url),
    "utf8",
  );
  const configSrcTruth = fs.readFileSync(new URL("../src/core/config.ts", import.meta.url), "utf8");
  assert.ok(
    /export function truthfulnessPreflight\b/.test(orchSrcTruth),
    "v4.2.2 / truthfulness_preflight: truthfulnessPreflight must be exported",
  );
  assert.ok(
    /truthfulness_preflight_enabled/.test(orchSrcTruth) &&
      /askPeers[\s\S]+truthfulnessPreflight/.test(orchSrcTruth) &&
      /runUntilUnanimous[\s\S]+truthfulnessPreflight/.test(orchSrcTruth),
    "v4.2.2 / truthfulness_preflight: both askPeers and runUntilUnanimous must gate on config.truthfulness_preflight_enabled",
  );
  assert.ok(
    /recordPreflightFailure/.test(orchSrcTruth),
    "v4.2.4 / truthfulness_preflight: preflight aborts without rounds must still persist failed_attempts metadata",
  );
  assert.ok(
    /boolEnv\("CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT", true\)/.test(configSrcTruth),
    "v4.2.2 / truthfulness_preflight: CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT env var must default ON",
  );
  console.log("[smoke] truthfulness_preflight_test: PASS");
}

// v4.2.4 — truthfulness_preflight_runtime_contract_test.
// A failed preflight should be inspectable without scraping events, and
// operators should be able to re-run the same read-only preflight after
// attaching evidence instead of starting duplicate sessions.
{
  const orchSrcTruth = fs.readFileSync(
    new URL("../src/core/orchestrator.ts", import.meta.url),
    "utf8",
  );
  const storeSrcTruth = fs.readFileSync(
    new URL("../src/core/session-store.ts", import.meta.url),
    "utf8",
  );
  const serverSrcTruth = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  assert.ok(
    /recordPreflightFailure/.test(storeSrcTruth) &&
      /failed_attempts/.test(storeSrcTruth) &&
      /truthfulness_preflight/.test(storeSrcTruth),
    "v4.2.4 / truthfulness_preflight: SessionStore must persist preflight failed_attempts even when no round is appended",
  );
  const runUntilIndex = orchSrcTruth.indexOf("async runUntilUnanimous");
  const truthfulnessIndex = orchSrcTruth.indexOf(
    "const truthfulness = truthfulnessPreflight",
    runUntilIndex,
  );
  const evidenceIndex = orchSrcTruth.indexOf("const preflight = evidencePreflight", runUntilIndex);
  const leadGenerationIndex = orchSrcTruth.indexOf(
    "const generation = await adapters[leadPeer].generate",
    runUntilIndex,
  );
  assert.ok(
    runUntilIndex >= 0 &&
      truthfulnessIndex > runUntilIndex &&
      evidenceIndex > truthfulnessIndex &&
      leadGenerationIndex > evidenceIndex,
    "v4.2.4 / truthfulness_preflight: runUntilUnanimous must run truthfulness/evidence preflight before paid lead generation",
  );
  assert.ok(
    /"session_truthfulness_preflight_check"/.test(serverSrcTruth) &&
      /readEvidenceAttachments/.test(serverSrcTruth) &&
      /truthfulnessPreflight/.test(serverSrcTruth),
    "v4.2.4 / truthfulness_preflight: MCP must expose a read-only session_truthfulness_preflight_check retest tool",
  );
  assert.ok(
    /"session_truthfulness_preflight_check"/.test(serverSrcTruth) &&
      /TOOL_NAMES[\s\S]*session_truthfulness_preflight_check/.test(serverSrcTruth),
    "v4.2.4 / truthfulness_preflight: server_info tool list must include session_truthfulness_preflight_check",
  );
  console.log("[smoke] truthfulness_preflight_runtime_contract_test: PASS");
}
