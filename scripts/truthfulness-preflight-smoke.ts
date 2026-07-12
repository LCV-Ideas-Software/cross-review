import assert from "node:assert/strict";
import fs from "node:fs";

import { checkConvergence } from "../src/core/convergence.js";
import {
  detectFabricatedEvidence,
  groundReadyPeerEvidence,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import { parsePeerStatus } from "../src/core/status.js";
import type { PeerResult } from "../src/core/types.js";

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
      /inline|evidence field/.test(fabricatedTiming.reason) &&
      /no manual operator attachment/.test(fabricatedTiming.reason),
    "v4.5.1 / truthfulness_preflight: remediation must accept authenticated caller evidence without manual attachment",
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
    "v4.5.1 / truthfulness_preflight: preflight blocks without rounds must still persist failed_attempts metadata",
  );
  assert.ok(
    /boolEnv\("CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT", true\)/.test(configSrcTruth),
    "v4.2.2 / truthfulness_preflight: CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT env var must default ON",
  );
  console.log("[smoke] truthfulness_preflight_test: PASS");
}

// v4.4.9 — adversarial truthfulness/convergence regressions. These cases
// model a lazy peer returning a cosmetically valid READY without doing the
// evidentiary work, plus the model/runtime and fabrication bypasses found in
// the six-provider audit.
{
  const verifiedWithoutEvidence = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(
    verifiedWithoutEvidence.status,
    "NEEDS_EVIDENCE",
    "v4.4.9 / truthfulness: READY+verified without evidence must downgrade",
  );

  const verifiedWithGenericEvidence = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: ["I checked it carefully."],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(
    verifiedWithGenericEvidence.status,
    "NEEDS_EVIDENCE",
    "v4.4.9 / truthfulness: generic prose is not a concrete evidence source",
  );

  const verifiedWithNonexistentFile = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: ["src/does-not-exist.ts:999"],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(
    verifiedWithNonexistentFile.status,
    "NEEDS_EVIDENCE",
    "A bare file:line string is not provenance-grade evidence and may point to a nonexistent file.",
  );

  const verifiedWithConcreteEvidence = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: ['server_info: {"version":"4.5.0","models":{"claude":"claude-fable-5"}}'],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(verifiedWithConcreteEvidence.status, "READY");

  const inferredWithoutEvidence = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "inferred",
      evidence_sources: [],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(
    inferredWithoutEvidence.status,
    "NEEDS_EVIDENCE",
    "v4.5.0 / truthfulness: a lazy READY cannot bypass grounding by choosing confidence=inferred",
  );

  const inferredWithFakeFence = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "inferred",
      evidence_sources: ["```text\ntrust me\n```"],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(
    inferredWithFakeFence.status,
    "NEEDS_EVIDENCE",
    "v4.5.0 / truthfulness: an empty-looking code fence is not concrete READY evidence",
  );

  const readyPeer = (source: string): PeerResult => ({
    peer: "claude",
    provider: "anthropic",
    model: "claude-fable-5",
    model_reported: "claude-fable-5",
    model_match: true,
    status: "READY",
    structured: {
      status: "READY",
      summary: "Looks correct.",
      confidence: "inferred",
      evidence_sources: [source],
      caller_requests: [],
      follow_ups: [],
    },
    text: "fixture",
    raw: {},
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  });
  const inventedAttachment = groundReadyPeerEvidence(readyPeer("Attachment: never-existed.log"), {
    artifactText: "The authorization flow uses a single-flight refresh queue.",
    attachedEvidenceText: "",
    attachmentRefs: [],
    runtimeFacts: {},
  });
  assert.equal(
    inventedAttachment.result.status,
    "NEEDS_EVIDENCE",
    "v4.5.0 / truthfulness: a peer cannot cite a nonexistent attachment to manufacture READY",
  );
  const copiedArtifactEvidence = groundReadyPeerEvidence(
    readyPeer('Artifact quote: "single-flight refresh queue"'),
    {
      artifactText: "The authorization flow uses a single-flight refresh queue.",
      attachedEvidenceText: "",
      attachmentRefs: [],
      runtimeFacts: {},
    },
  );
  assert.equal(
    copiedArtifactEvidence.result.status,
    "READY",
    "v4.5.0 / truthfulness: a verbatim artifact citation demonstrates grounded review",
  );
  const inventedCount = groundReadyPeerEvidence(readyPeer("Tests 99 passed, 0 failed"), {
    artifactText: "Tests 42 passed, 0 failed",
    attachedEvidenceText: "",
    attachmentRefs: [],
    runtimeFacts: {},
  });
  assert.equal(
    inventedCount.result.status,
    "NEEDS_EVIDENCE",
    "v4.5.0 / truthfulness: a peer cannot invent a different test count in evidence_sources",
  );

  for (const incomplete of ['{"status":"READY"}', '{"status":"READY",', "STATUS: READY"]) {
    const parsed = parsePeerStatus(incomplete);
    assert.notEqual(
      parsed.status,
      "READY",
      `v4.4.9 / truthfulness: incomplete or legacy READY must not converge (${incomplete})`,
    );
  }

  // Defence in depth: convergence must reject a hand-constructed result that
  // still carries the historical verified-without-evidence warning.
  const warnedReady: PeerResult = {
    peer: "claude",
    provider: "anthropic",
    model: "claude-fable-5",
    status: "READY",
    structured: {
      status: "READY",
      summary: "Verified.",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: [],
      follow_ups: [],
    },
    text: "",
    raw: {},
    latency_ms: 0,
    attempts: 1,
    parser_warnings: ["verified_without_evidence_sources"],
    decision_quality: "format_warning",
  };
  assert.equal(
    checkConvergence(["claude"], "READY", [warnedReady], []).converged,
    false,
    "v4.4.9 / truthfulness: warning-bearing READY must not converge",
  );

  const modelPins = {
    codex: "gpt-5.6-sol",
    claude: "claude-fable-5",
    gemini: "gemini-3.1-pro",
    deepseek: "deepseek-v4-pro",
    grok: "grok-4.5",
    perplexity: "sonar-reasoning-pro",
  } as const;
  const wrongModels = {
    codex: "gpt-5.5",
    claude: "claude-opus-4-8",
    gemini: "gemini-2.5-pro",
    deepseek: "deepseek-v3.2",
    grok: "grok-4.3",
    perplexity: "sonar-pro",
  } as const;
  for (const peer of Object.keys(modelPins) as Array<keyof typeof modelPins>) {
    const contradicted = truthfulnessPreflight({
      task: `Check the currently loaded ${peer} model.`,
      initialDraft: `The currently loaded ${peer} model is ${wrongModels[peer]}.`,
      runtimeFacts: { model_pins: modelPins },
      attachmentsPresent: false,
    });
    assert.equal(
      contradicted.pass,
      false,
      `v4.4.9 / truthfulness: ${peer} current model contradiction must fail`,
    );
    assert.ok(contradicted.issue_classes.includes("runtime_contradiction"));

    const matching = truthfulnessPreflight({
      task: `Check the currently loaded ${peer} model.`,
      initialDraft: `The currently loaded ${peer} model is ${modelPins[peer]}.`,
      runtimeFacts: { model_pins: modelPins },
      attachmentsPresent: false,
    });
    assert.equal(matching.pass, true, `matching ${peer} model pin must pass`);
  }

  const singleOperationalLie = detectFabricatedEvidence(
    "Local validation completed with 42 passed, 0 failed.",
    { provenanceCorpus: "", priorDraftCorpus: "", narrativeCorpus: "" },
  );
  assert.equal(
    singleOperationalLie.fabricated,
    true,
    "v4.4.9 / fabrication: one uncorroborated operational claim is enough",
  );

  const uppercaseHashes = detectFabricatedEvidence(
    "Reported hashes ABCDEF0123456789, FEDCBA9876543210, AABBCCDDEEFF0011.",
    { provenanceCorpus: "", priorDraftCorpus: "", narrativeCorpus: "" },
  );
  assert.equal(
    uppercaseHashes.fabricated,
    true,
    "v4.4.9 / fabrication: hash detection must be case-insensitive",
  );

  const nonAssertiveInstructions = detectFabricatedEvidence(
    "Do not claim 42 passed. Please run cargo test and npm run test before reporting results.",
    { provenanceCorpus: "", priorDraftCorpus: "", narrativeCorpus: "" },
  );
  assert.equal(
    nonAssertiveInstructions.fabricated,
    false,
    "v4.4.9 / fabrication: negated/instructional command text is not a completed-work claim",
  );

  const unsupportedWorkflow = truthfulnessPreflight({
    task: "Summarize deployment closure.",
    initialDraft: "I triggered the deployment and confirmed the remote deployment succeeded.",
    structuredEvidence: "trust me",
    attachmentsPresent: false,
    runtimeFacts: { runtime_version: "4.4.9" },
  });
  assert.equal(
    unsupportedWorkflow.pass,
    false,
    "v4.4.9 / truthfulness: generic structured evidence must not bless a workflow claim",
  );

  const unrelatedAttachment = truthfulnessPreflight({
    task: "Summarize deployment closure.",
    initialDraft: "I triggered the deployment and confirmed the remote deployment succeeded.",
    attachmentsPresent: true,
    attachedEvidenceText: "unrelated lint output",
    runtimeFacts: { runtime_version: "4.4.9" },
  });
  assert.equal(
    unrelatedAttachment.pass,
    false,
    "v4.4.9 / truthfulness: an unrelated attachment must not bless a workflow claim",
  );

  const corroboratedWorkflow = truthfulnessPreflight({
    task: "Summarize deployment closure.",
    initialDraft: "I triggered the deployment and confirmed the remote deployment succeeded.",
    structuredEvidence:
      "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
    attachmentsPresent: false,
    runtimeFacts: { runtime_version: "4.4.9" },
  });
  assert.equal(
    corroboratedWorkflow.pass,
    true,
    "v4.4.9 / truthfulness: value-corresponding workflow evidence must pass",
  );

  const peerSubmittedWorkflow = truthfulnessPreflight({
    task: "Summarize deployment closure.",
    initialDraft: "I triggered the deployment and confirmed the remote deployment succeeded.",
    caller: "claude",
    structuredEvidence:
      "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
    attachmentsPresent: false,
    runtimeFacts: { runtime_version: "4.5.0" },
  });
  assert.equal(
    peerSubmittedWorkflow.pass,
    true,
    "v4.5.1 / truthfulness: value-corresponding authenticated peer evidence must not require an operator attachment",
  );
  assert.equal(
    peerSubmittedWorkflow.independent_review_required,
    true,
    "peer-submitted workflow evidence must be admitted but remain subject to strict independent panel corroboration",
  );
  assert.equal(peerSubmittedWorkflow.operator_grounded, false);

  const peerUsesCustodiedWorkflowEvidence = truthfulnessPreflight({
    task: "Summarize deployment closure.",
    initialDraft: "I triggered the deployment and confirmed the remote deployment succeeded.",
    caller: "claude",
    attachmentsPresent: true,
    attachedEvidenceText:
      "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
    operatorVerifiedEvidenceText:
      "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
    runtimeFacts: { runtime_version: "4.5.0" },
  });
  assert.equal(
    peerUsesCustodiedWorkflowEvidence.pass,
    true,
    "v4.5.0 / truthfulness: a peer may rely on operator-custodied attached evidence",
  );
  assert.equal(peerUsesCustodiedWorkflowEvidence.independent_review_required, false);
  assert.equal(peerUsesCustodiedWorkflowEvidence.operator_grounded, true);

  const orchestratorSource = fs.readFileSync(
    new URL("../src/core/orchestrator.ts", import.meta.url),
    "utf8",
  );
  const circularStart = orchestratorSource.indexOf("private async runCircularLoop");
  const circularEnd = orchestratorSource.indexOf("async runUntilUnanimous", circularStart);
  const circularSource = orchestratorSource.slice(circularStart, circularEnd);
  assert.ok(/truthfulnessPreflight/.test(circularSource));
  assert.ok(/detectMetaAuditFabrication/.test(circularSource));
  assert.ok(/model_match\s*===\s*false/.test(circularSource));
  assert.ok(
    (orchestratorSource.match(/model_match\s*===\s*false/g) ?? []).length >= 3,
    "v4.4.9 / lead integrity: ship initial/revision and circular generation must reject model mismatch",
  );

  console.log("[smoke] adversarial_truthfulness_and_convergence_test: PASS");
}

// v4.5.0 adversarial regression: a peer already knows runtime metadata such
// as its own model id and the server version. Those facts are not evidence
// that it reviewed the artifact and must never be sufficient for READY.
{
  const lazyRuntimeMetadataReady = (source: string): PeerResult => ({
    peer: "claude",
    provider: "anthropic",
    model: "claude-fable-5",
    model_reported: "claude-fable-5",
    model_match: true,
    status: "READY",
    structured: {
      status: "READY",
      summary: "Everything is fine.",
      confidence: "inferred",
      evidence_sources: [source],
      caller_requests: [],
      follow_ups: [],
    },
    text: "fixture",
    raw: {},
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  });
  for (const source of ['{"model":"claude-fable-5"}', '{"version":"4.5.0"}']) {
    const grounded = groundReadyPeerEvidence(lazyRuntimeMetadataReady(source), {
      artifactText: "Arbitrary artifact text with a severe authorization defect.",
      attachedEvidenceText: "",
      attachmentRefs: [],
      runtimeFacts: {
        runtime_version: "4.5.0",
        model_pins: { claude: "claude-fable-5" },
      },
    });
    assert.equal(
      grounded.result.status,
      "NEEDS_EVIDENCE",
      `runtime metadata alone must not ground READY: ${source}`,
    );
  }

  const lossy = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: `${"A".repeat(900)} BLOCKING DEFECT REMAINS`,
      confidence: "inferred",
      evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.notEqual(lossy.status, "READY", "lossy/truncated READY must fail closed");

  const contradictory = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "Blocking defect remains: authorization bypass; must fix before approval.",
      confidence: "inferred",
      evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
      caller_requests: ["Fix the authorization bypass."],
      follow_ups: [],
    }),
  );
  assert.notEqual(
    contradictory.status,
    "READY",
    "READY must not contradict its blocking summary or actionable caller requests",
  );

  const canonicalReady = parsePeerStatus(
    JSON.stringify({
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "inferred",
      evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
      caller_requests: [],
      follow_ups: [],
    }),
  );
  assert.equal(canonicalReady.status, "READY", "canonical READY summary must remain valid");

  for (const nonEmptyArrays of [
    { caller_requests: [""], follow_ups: [] },
    { caller_requests: [], follow_ups: ["   "] },
  ]) {
    const paddedEmptyReady = parsePeerStatus(
      JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        ...nonEmptyArrays,
      }),
    );
    assert.equal(
      paddedEmptyReady.status,
      "NEEDS_EVIDENCE",
      "READY requires literally empty caller_requests and follow_ups arrays",
    );
  }

  for (const extra of [
    { blocking_findings: ["Critical authorization bypass remains."] },
    { notes: "Do not approve; severe flaw remains." },
  ]) {
    const extraPropertyReady = parsePeerStatus(
      JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        caller_requests: [],
        follow_ups: [],
        ...extra,
      }),
    );
    assert.notEqual(
      extraPropertyReady.status,
      "READY",
      "READY must reject undeclared properties instead of stripping contradictory content",
    );
  }

  for (const duplicateKeyPayload of [
    '{"status":"NOT_READY","status":"READY","summary":"No blocking objections remain.","confidence":"inferred","evidence_sources":["Artifact quote: \\"arbitrary artifact text\\""],"caller_requests":[],"follow_ups":[]}',
    '{"status":"READY","summary":"Critical defect remains; do not approve.","summary":"No blocking objections remain.","confidence":"inferred","evidence_sources":["Artifact quote: \\"arbitrary artifact text\\""],"caller_requests":[],"follow_ups":[]}',
    '{"status":"READY","summary":"No blocking objections remain.","confidence":"inferred","evidence_sources":["Artifact quote: \\"arbitrary artifact text\\""],"caller_requests":["Do not approve"],"caller_requests":[],"follow_ups":[]}',
  ]) {
    const duplicateKeyReady = parsePeerStatus(duplicateKeyPayload);
    assert.notEqual(
      duplicateKeyReady.status,
      "READY",
      "duplicate JSON properties must not use last-key-wins semantics for READY",
    );
  }

  for (const summary of [
    "No blocking issues remain.",
    "The blocking issue was fixed; no blockers remain.",
    "Nenhum item bloqueante permanece.",
    "O item bloqueante foi corrigido; não há bloqueios.",
  ]) {
    const honestReady = parsePeerStatus(
      JSON.stringify({
        status: "READY",
        summary,
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        caller_requests: [],
        follow_ups: [],
      }),
    );
    assert.equal(
      honestReady.status,
      "NEEDS_EVIDENCE",
      `noncanonical READY wording must fail closed without being misclassified as NOT_READY: ${summary}`,
    );
    assert.ok(honestReady.parser_warnings.includes("ready_noncanonical_summary"));
  }

  const contradictoryNarrative = parsePeerStatus(
    [
      "A blocking defect remains in authorization and must be fixed before approval.",
      "```json",
      JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        caller_requests: [],
        follow_ups: [],
      }),
      "```",
    ].join("\n"),
  );
  assert.notEqual(
    contradictoryNarrative.status,
    "READY",
    "assertive blocking prose outside the status JSON must invalidate READY",
  );

  for (const narrative of [
    "A critical defect remains and requires correction before approval.",
    "Uma falha crítica permanece e exige correção antes da aprovação.",
    "There is no blocking issue; however, a critical defect still remains.",
  ]) {
    const paraphrasedContradiction = parsePeerStatus(
      [
        narrative,
        "```json",
        JSON.stringify({
          status: "READY",
          summary: "No blocking objections remain.",
          confidence: "inferred",
          evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
          caller_requests: [],
          follow_ups: [],
        }),
        "```",
      ].join("\n"),
    );
    assert.notEqual(
      paraphrasedContradiction.status,
      "READY",
      `unresolved-defect paraphrase outside the status JSON must invalidate READY: ${narrative}`,
    );
  }

  for (const summary of [
    "A critical defect remains and requires correction before approval.",
    "Uma falha crítica permanece e exige correção antes da aprovação.",
    "A serious flaw is outstanding and approval should wait.",
    "The implementation remains unsafe; do not merge yet.",
    "Shipping must wait for remediation of the authorization gap.",
    "Ainda existe uma brecha grave; não aprove por enquanto.",
    "A liberação deve aguardar a correção desta inconsistência.",
  ]) {
    const paraphrasedStructuredContradiction = parsePeerStatus(
      JSON.stringify({
        status: "READY",
        summary,
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        caller_requests: [],
        follow_ups: [],
      }),
    );
    assert.notEqual(
      paraphrasedStructuredContradiction.status,
      "READY",
      `unresolved-defect paraphrase inside READY summary must invalidate READY: ${summary}`,
    );
  }

  const neutralNarrativeReady = parsePeerStatus(
    [
      "Review complete.",
      "```json",
      JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "inferred",
        evidence_sources: ['Artifact quote: "arbitrary artifact text"'],
        caller_requests: [],
        follow_ups: [],
      }),
      "```",
    ].join("\n"),
  );
  assert.equal(
    neutralNarrativeReady.status,
    "NEEDS_EVIDENCE",
    "READY with any narrative outside its structured envelope must fail closed",
  );
  assert.ok(neutralNarrativeReady.parser_warnings.includes("ready_with_external_narrative"));

  console.log("[smoke] lazy_ready_runtime_metadata_and_contradiction_test: PASS");
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
    "const generation = await this.generateWithFailureAccounting",
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
    /"session_preflight_check"/.test(serverSrcTruth) &&
      /"session_truthfulness_preflight_check"/.test(serverSrcTruth) &&
      /checkSessionPreflights/.test(serverSrcTruth) &&
      /truthfulnessPreflight/.test(orchSrcTruth) &&
      /evidencePreflight/.test(orchSrcTruth),
    "v4.5.1 / preflight: MCP must expose a read-only combined preflight plus the legacy alias",
  );
  assert.ok(
    /"session_truthfulness_preflight_check"/.test(serverSrcTruth) &&
      /const toolNames: string\[\] = \[\]/.test(serverSrcTruth) &&
      /toolNames\.push\(name\)/.test(serverSrcTruth) &&
      /registerTool\(\s*\n\s*"session_truthfulness_preflight_check"/.test(serverSrcTruth) &&
      /tools: toolNames/.test(serverSrcTruth),
    "v4.4.0 / truthfulness_preflight: server_info tool list must derive from real registerTool calls and include session_truthfulness_preflight_check",
  );
  console.log("[smoke] truthfulness_preflight_runtime_contract_test: PASS");
}
