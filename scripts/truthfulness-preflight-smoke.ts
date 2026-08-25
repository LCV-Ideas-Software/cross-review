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

  const futureConditionalInstruction = truthfulnessPreflight({
    task: "Review this release plan.",
    initialDraft:
      "After merge and exact-head green CI, retry v1.2.5 first and verify immutable release evidence before considering v1.2.6.",
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.deepEqual(
    {
      pass: futureConditionalInstruction.pass,
      current_state_claim_matched: futureConditionalInstruction.current_state_claim_matched,
      issue_classes: futureConditionalInstruction.issue_classes,
    },
    {
      pass: true,
      current_state_claim_matched: false,
      issue_classes: [],
    },
    "v4.5.28 / truthfulness_preflight: a future temporal prerequisite must not be reclassified as current state",
  );

  const assertiveStateAfterTemporalPreamble = truthfulnessPreflight({
    task: "Review this status report.",
    initialDraft: "After the merge completed, CI is green.",
    runtimeFacts,
    attachmentsPresent: false,
  });
  assert.equal(
    assertiveStateAfterTemporalPreamble.pass,
    false,
    "v4.5.28 / truthfulness_preflight: stripping a temporal preamble must preserve an assertive main clause",
  );
  assert.ok(
    assertiveStateAfterTemporalPreamble.issue_classes.includes("unsupported_current_state_claim"),
    "v4.5.28 / truthfulness_preflight: a real current-state assertion must still fail closed",
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
    grok: "grok-4.6",
    perplexity: "perplexity/kimi-k3",
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
      task: `Check the currently loaded cross-review runtime ${peer} model.`,
      initialDraft: `The currently loaded cross-review runtime ${peer} model is ${wrongModels[peer]}.`,
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
      task: `Check the currently loaded cross-review runtime ${peer} model.`,
      initialDraft: `The currently loaded cross-review runtime ${peer} model is ${modelPins[peer]}.`,
      runtimeFacts: { model_pins: modelPins },
      attachmentsPresent: false,
    });
    assert.equal(matching.pass, true, `matching ${peer} model pin must pass`);
  }

  // Codex review of PR #234 (head b0b681d): a Perplexity pin routed to another
  // family through the Agent API is attributed to the Perplexity claim, never to
  // the native peer of that family; native claims keep contradicting.
  const routedPins = { ...modelPins, perplexity: "openai/gpt-5.5" } as const;
  const routedTruth = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft: "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(routedTruth.pass, true, "a truthful routed Perplexity pin must pass");
  const routedLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft: "The currently loaded cross-review runtime perplexity model is openai/gpt-5.4.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(routedLie.pass, false, "a wrong routed Perplexity pin must still contradict");
  const nativeLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime codex model.",
    initialDraft: "The currently loaded cross-review runtime codex model is gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(nativeLie.pass, false, "the native codex claim must still contradict its pin");
  // Codex review of PR #234 (head 4be7e8b): attribution is per occurrence —
  // a mixed sentence with a routed Perplexity claim AND a standalone native
  // claim of the same token must still contradict the native pin.
  const mixedLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime model pins.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5 and the cross-review runtime codex model is gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    mixedLie.pass,
    false,
    "a standalone native occurrence next to a routed claim must still contradict",
  );
  // Codex review round 5: the provider segment is part of the routed claim —
  // asserting a DIFFERENT route than the pinned one must contradict.
  const wrongRouteLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft: "The currently loaded cross-review runtime perplexity model is xai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(wrongRouteLie.pass, false, "a different provider route must contradict the pin");
  // And routed syntax inside a NATIVE claim stays attributed to that peer.
  const nativeRoutedLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime codex model.",
    initialDraft: "The currently loaded cross-review runtime codex model is openai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    nativeRoutedLie.pass,
    false,
    "provider-qualified native claims must still contradict the native pin",
  );
  // Codex review round 6: a claim repeating the same model under several
  // routes must have EVERY routed occurrence checked - the divergent second
  // route contradicts even when the first one matches the pin.
  const dualRouteLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5 and xai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(dualRouteLie.pass, false, "a second divergent route must contradict the pin");
  // Codex review round 7: occurrence OWNERSHIP is positional. Identical
  // routed occurrences owned by different named claims must be judged
  // against their own peer's pin; negation must survive provider-qualified
  // syntax; and routed model families outside the native allowlist must
  // still be parsed.
  const identicalRouteTwoClaimsLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime models.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5 and the currently loaded codex model is openai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    identicalRouteTwoClaimsLie.pass,
    false,
    "an occurrence owned by the codex claim must be judged against the codex pin",
  );
  const identicalRouteTwoClaimsTruth = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime models.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5 and the currently loaded codex model is gpt-5.6-sol.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    identicalRouteTwoClaimsTruth.pass,
    true,
    "two truthful named claims on one line must pass",
  );
  const negatedRoutedPinLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is not openai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    negatedRoutedPinLie.pass,
    false,
    "denying the routed pin must contradict even with the provider segment after the negation",
  );
  const negatedDivergentRouteTruth = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5, not xai/gpt-5.5.",
    runtimeFacts: { model_pins: routedPins },
    attachmentsPresent: false,
  });
  assert.equal(
    negatedDivergentRouteTruth.pass,
    true,
    "denying a divergent route while asserting the pinned one must pass",
  );
  const genericRoutedFamilyLie = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft: "The currently loaded cross-review runtime perplexity model is zeta/qwen3-max.",
    runtimeFacts: { model_pins: { ...routedPins, perplexity: "zeta/llama-4.1" } },
    attachmentsPresent: false,
  });
  assert.equal(
    genericRoutedFamilyLie.pass,
    false,
    "a routed family outside the native allowlist must still be parsed and contradict",
  );
  // Red-team hardening (round 7b): representative regressions from the
  // 38-case adversarial sweep (see PR #234).
  const rt = (draft: string, pins: Record<string, string>) =>
    truthfulnessPreflight({
      task: "Check the currently loaded cross-review runtime models.",
      initialDraft: draft,
      runtimeFacts: { model_pins: pins },
      attachmentsPresent: false,
    }).pass;
  const genericPins = { ...routedPins, perplexity: "zeta/llama-4.1" };
  const plainPins = { ...modelPins };
  assert.equal(
    rt(
      "The currently loaded cross-review runtime pins perplexity to perplexity/kimi-k3, with the adapter wired in src/v2-parser of the harness.",
      plainPins,
    ),
    true,
    "a file path must not become a routed occurrence",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime routes perplexity through openai/gpt-5.5 at https://api.openai.com/v1/responses.",
      routedPins,
    ),
    true,
    "URLs must be masked before route collection",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime, revalidated in the 2026/aug23 sweep, still pins perplexity to perplexity/kimi-k3.",
      plainPins,
    ),
    true,
    "date-like fragments must not become routed occurrences",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime confirms the codex peer is not currently gpt-5.5 and pins it to gpt-5.6-sol.",
      plainPins,
    ),
    true,
    "negation must survive an intervening adverb",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime pins grok to grok-4.6, neither grok-4.5 nor grok-3.",
      plainPins,
    ),
    true,
    "neither/nor denials must not count as assertions",
  );
  assert.equal(
    rt(
      "No currently loaded cross-review runtime, o peer grok não roda mais o antigo grok-4.5 e usa o grok-4.6.",
      plainPins,
    ),
    true,
    "portuguese não…mais denial must not count as an assertion",
  );
  assert.equal(
    rt(
      "Perplexity output in the currently loaded cross-review runtime is served from openai/gpt-5.5.",
      plainPins,
    ),
    false,
    "'served from' is a source preposition, not a negation: the wrong route must contradict",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime pins claude-fable-5 and serves gpt-5.6-sol to the Codex peer.",
      plainPins,
    ),
    true,
    "an alias embedded in a model token must not steal clause ownership",
  );
  assert.equal(
    rt(
      "Per the notes in src/gemini/routing.md, the currently loaded cross-review runtime serves gpt-5.6-sol to the Codex peer.",
      plainPins,
    ),
    true,
    "an alias inside a file path must not steal clause ownership",
  );
  assert.equal(
    rt("The currently loaded cross-review runtime serves grok-4.6 to the Gemini peer.", plainPins),
    false,
    "an alias after the token inside the clause owns it: the swapped claim must contradict",
  );
  assert.equal(
    rt(
      "In the currently loaded cross-review runtime, openai/gpt-5.6-sol serves the Codex peer, and the Perplexity peer is pinned to zeta/llama-4.1.",
      genericPins,
    ),
    true,
    "an ownerless routed occurrence must not be adopted by the routable peer blanketly",
  );
  assert.equal(
    rt(
      "The Perplexity peer in the currently loaded cross-review runtime is routed through zeta / gpt-5.5.",
      routedPins,
    ),
    false,
    "whitespace around the route slash must not hide the wrong provider",
  );
  assert.equal(
    rt(
      "The Codex peer in the currently loaded cross-review runtime is running gpt_5.6_sol.",
      plainPins,
    ),
    true,
    "underscore separators are cosmetic: the canonical token must match the pin",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime now has the perplexity peer on zeta llama-4.2.",
      genericPins,
    ),
    false,
    "a slashless token of the routed pin's family must stay visible and contradict",
  );
  // Codex review round 8: configured pins are ALWAYS visible - a routed id
  // whose model segment has no digit (perplexity/sonar is an accepted Agent
  // API id) must still be parsed, so denying or asserting it is judged.
  const sonarPins = { ...modelPins, perplexity: "perplexity/sonar" };
  assert.equal(
    rt(
      "The currently loaded cross-review runtime perplexity model is not perplexity/sonar.",
      sonarPins,
    ),
    false,
    "denying a configured no-digit routed pin must contradict",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime perplexity model is perplexity/sonar.",
      sonarPins,
    ),
    true,
    "asserting the configured no-digit routed pin must pass",
  );
  assert.equal(
    rt("The currently loaded cross-review runtime perplexity model is not sonar.", sonarPins),
    false,
    "denying the configured pin's bare model segment must contradict",
  );
  assert.equal(
    rt("The currently loaded cross-review runtime perplexity model is sonar.", sonarPins),
    true,
    "asserting the configured pin's bare model segment must pass",
  );
  // Round 8 structural inversion (operator directive): the gate defaults
  // to FAIL-CLOSED - an asserted model value that is no configured pin
  // contradicts even without an identifiable owner, and a model claim the
  // parser cannot validate affirmatively is unsupported instead of passing.
  assert.equal(
    rt(
      "The currently loaded cross-review runtime drives its heavy-reasoning slot with gpt-9.9-sol.",
      plainPins,
    ),
    false,
    "an asserted model value that matches no configured pin must contradict (ownerless periphrasis)",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime is running the claude peer on nothing if not claude-fable-6.",
      plainPins,
    ),
    false,
    "a model claim with no affirmatively validated view must be fail-closed, not silently passed",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime roadmap says the codex peer will move to gpt-7 next quarter.",
      plainPins,
    ),
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (restate with the exact pin or use structured evidence). Was: future/planning statements are not current-state assertions for the no-pin rule",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime perplexity model is openai/gpt-5.5, not xai/gpt-5.5.",
      routedPins,
    ),
    true,
    "denying a non-pin while asserting the pinned route must still pass",
  );
  // Codex review round 9: markdown code-span delimiters must not break the
  // negation window, and the future exemption is clause-scoped.
  assert.equal(
    rt(
      "The currently loaded cross-review runtime perplexity model is not `perplexity/kimi-k3`.",
      plainPins,
    ),
    false,
    "denying the pin wrapped in markdown backticks must still contradict",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime perplexity model is `perplexity/kimi-k3`.",
      plainPins,
    ),
    true,
    "asserting the pin wrapped in markdown backticks must pass",
  );
  assert.equal(
    rt(
      "The currently loaded cross-review runtime codex model is gpt-5.5, and the perplexity peer will change next release.",
      plainPins,
    ),
    false,
    "a future clause elsewhere must not exempt a false current claim in its own clause",
  );
  // And the wrapped `models/provider/model` pin form is normalized before
  // comparison, so a truthful claim of the routed model still passes.
  const wrappedPins = { ...modelPins, perplexity: "models/perplexity/kimi-k3" } as const;
  const wrappedTruth = truthfulnessPreflight({
    task: "Check the currently loaded cross-review runtime perplexity model.",
    initialDraft:
      "The currently loaded cross-review runtime perplexity model is perplexity/kimi-k3.",
    runtimeFacts: { model_pins: wrappedPins },
    attachmentsPresent: false,
  });
  assert.equal(wrappedTruth.pass, true, "a models/-wrapped Perplexity pin must normalize");

  // CROSREV-21 (#237 phase 2, extending #239 item 3): the zero-occurrence
  // guard with structured-evidence anchoring. A model-scoped assertive
  // line with a peer alias and ZERO capturable model tokens (fragmented
  // ids — the single residual false negative of the PR #234 38-case
  // red-team sweep) is LOCATED by the lexicon but cannot be judged by it:
  // it is rejected outright as an unsupported current-state claim with a
  // single restatement instruction (no evidence-corroboration channel) —
  // never a silent pass.
  const anchored = (draft: string, evidence?: string, caller?: "claude") =>
    truthfulnessPreflight({
      task: "Check the currently loaded cross-review runtime models.",
      initialDraft: draft,
      ...(evidence !== undefined ? { structuredEvidence: evidence } : {}),
      ...(caller !== undefined ? { caller } : {}),
      runtimeFacts: { model_pins: plainPins },
      attachmentsPresent: false,
    });
  const fragMissing = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
  );
  assert.equal(
    fragMissing.pass,
    false,
    "a fragmented model id (no capturable token) must not pass silently",
  );
  assert.ok(
    fragMissing.issue_classes.includes("unsupported_current_state_claim"),
    "the fragmented claim is unsupported, not a contradiction",
  );
  assert.ok(
    fragMissing.reason.includes("no capturable model token"),
    `the reason names the zero-occurrence anchor requirement: ${fragMissing.reason}`,
  );
  const denialNoToken = anchored("The cross-review runtime Codex model is not the configured pin.");
  assert.equal(
    denialNoToken.pass,
    false,
    "denying the pin without naming any token must not pass silently (#239 item 3)",
  );
  const fragCorroborated = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    'server_info models: {"codex":"gpt-5.6-sol","claude":"claude-fable-5"}',
  );
  assert.equal(
    fragCorroborated.pass,
    false,
    "structural inversion: evidence can never anchor an unparseable claim - restate is the only path",
  );
  const fragPeerEvidence = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    'server_info models: {"codex":"gpt-5.6-sol"}',
    "claude",
  );
  assert.equal(
    fragPeerEvidence.pass,
    false,
    "structural inversion: peer-supplied evidence cannot anchor an unparseable claim either",
  );
  const rcCannotCorroborate = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    "runtime_capabilities: version 4.6.2, api_only true. Also mentions gpt-5.6-sol in passing.",
  );
  assert.equal(
    rcCannotCorroborate.pass,
    false,
    "runtime_capabilities exposes no model ids and prose mentions carry no model-pin record marker — they cannot corroborate a model-pin claim",
  );
  const wrongPinEvidence = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    'server_info models: {"codex":"gpt-5.5"}',
  );
  assert.equal(
    wrongPinEvidence.pass,
    false,
    "structured evidence naming a DIFFERENT value than the configured pin does not anchor the claim",
  );
  const pathAliasNoTrigger = anchored(
    "The cross-review model_pin table is documented in src/gemini/routing.md for reference.",
  );
  assert.equal(
    pathAliasNoTrigger.pass,
    true,
    "an alias inside a masked path must not trigger the zero-occurrence guard",
  );
  const historicalFragment = anchored(
    "When the audit began, the cross-review runtime codex model was gpt five six sol.",
  );
  assert.equal(
    historicalFragment.pass,
    false,
    "a historical fragmented claim routes to the historical-provenance branch, not a silent pass",
  );
  assert.ok(
    historicalFragment.issue_classes.includes("unsupported_historical_claim"),
    "historical fragmented claims keep the historical issue class",
  );
  const capturedTokenUnchanged = anchored(
    "The currently loaded cross-review runtime codex model is gpt-5.6-sol.",
  );
  assert.equal(
    capturedTokenUnchanged.pass,
    true,
    "captured truthful tokens keep judging against config with no evidence requirement",
  );
  // Codex review of PR #247, round 1.
  const futureShield = anchored(
    "The cross-review runtime codex peer currently runs gpt five six sol, and will use gpt-6 next quarter.",
  );
  assert.equal(
    futureShield.pass,
    false,
    "a capturable FUTURE occurrence must not shield an unparseable current claim in another clause",
  );
  const onlyFutureStillExempt = anchored(
    "The cross-review runtime roadmap says the codex peer will move to gpt-7 next quarter.",
  );
  assert.equal(
    onlyFutureStillExempt.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: a line that is ONLY a future/planning statement keeps its S3 exemption",
  );
  const prefixEvidence = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    'server_info models: {"codex":"gpt-5.6-solar"}',
  );
  assert.equal(
    prefixEvidence.pass,
    false,
    "a longer model id sharing the pin as a prefix is not corroboration (delimited match required)",
  );
  const aliasNoModel = anchored(
    "The cross-review runtime uses OpenAI authentication in production.",
  );
  assert.equal(
    aliasNoModel.pass,
    true,
    "assertive runtime prose naming a provider for a non-model purpose is not a model-pin claim",
  );
  // Codex review of PR #247, round 2.
  const perPeerMix = anchored(
    "The cross-review runtime codex peer runs gpt five six sol, and the claude peer is claude-fable-5.",
  );
  assert.equal(
    perPeerMix.pass,
    false,
    "another peer's capturable occurrence must not shield a fragmented claim (per-peer guard)",
  );
  const currentBesidePlanned = anchored(
    "The cross-review runtime Codex model is currently gpt five six sol before a planned upgrade.",
  );
  assert.equal(
    currentBesidePlanned.pass,
    false,
    "planning language in the same segment must not hide an assertive current subclause",
  );
  const markerPinSeparate = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    "server_info request failed\nplanned pin: gpt-5.6-sol",
  );
  assert.equal(
    markerPinSeparate.pass,
    false,
    "the marker and the pin value must correlate within ONE evidence record",
  );
  const jsonPrettyRecord = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    'server_info models:\n  {\n    "codex": "gpt-5.6-sol"\n  }',
  );
  assert.equal(
    jsonPrettyRecord.pass,
    false,
    "structural inversion: no evidence format anchors an unparseable claim",
  );
  const crossClauseModelLanguage = anchored(
    "The cross-review runtime uses OpenAI authentication currently, and the Gemini model will change next quarter.",
  );
  assert.equal(
    crossClauseModelLanguage.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: model language inside a masked future clause must not convert a non-model alias into a claim",
  );
  const denialWithEvidence = anchored(
    "The cross-review runtime Codex model is not the configured pin.",
    'server_info models: {"codex":"gpt-5.6-sol"}',
  );
  assert.equal(
    denialWithEvidence.pass,
    false,
    "pin-affirming evidence cannot anchor a claim that DENIES the pin (polarity check)",
  );
  // Codex review of PR #247, round 3.
  const wrongValueAnchored = anchored(
    "The cross-review runtime codex peer runs alpha beta seven in production.",
    'server_info models: {"codex":"gpt-5.6-sol"}',
  );
  assert.equal(
    wrongValueAnchored.pass,
    false,
    "pin-affirming evidence cannot anchor a claim whose fragments name a DIFFERENT value",
  );
  const currentBeforePlannedToken = anchored(
    "The cross-review runtime Codex model is currently gpt-5.5 before a planned upgrade.",
  );
  assert.equal(
    currentBeforePlannedToken.pass,
    false,
    "a captured current token before a planning marker is judged (and contradicts the pin)",
  );
  assert.ok(
    currentBeforePlannedToken.issue_classes.includes("runtime_contradiction"),
    "the pre-marker token keeps its current classification",
  );
  const clauseScopedDenial = anchored(
    "The cross-review runtime Codex model is gpt five six sol, and production is not publicly reachable.",
    'server_info models: {"codex":"gpt-5.6-sol"}',
  );
  assert.equal(
    clauseScopedDenial.pass,
    false,
    "structural inversion: the fragmented claim blocks with a restate instruction regardless of other clauses",
  );
  const rawServerInfoJson = anchored(
    "The cross-review runtime codex peer runs gpt five six sol in production.",
    '{\n  "name": "cross-review",\n  "models": {\n    "codex": "gpt-5.6-sol"\n  }\n}',
  );
  assert.equal(
    rawServerInfoJson.pass,
    false,
    "structural inversion: even the raw server_info payload cannot anchor an unparseable claim",
  );
  const indirectRequest = anchored(
    "We need to determine which model the cross-review runtime Codex peer uses.",
  );
  assert.equal(
    indirectRequest.pass,
    true,
    "an indirect request (determine which ...) is not an assertion and never trips the guard",
  );
  const historicalPlusCurrent = anchored(
    "When the audit began, the cross-review runtime Claude model was running fine, and the Codex model currently runs alpha beta seven.",
    "Historical runtime snapshot from events.ndjson: workflow_start server_info version=4.2.0; later reload server_info version=4.2.1.",
  );
  assert.equal(
    historicalPlusCurrent.pass,
    false,
    "the historical exemption is clause-scoped — a current fragmented claim beside it still needs its own anchor",
  );
  // Codex review of PR #247, round 4 (structural inversion).
  const perClaimSamePeer = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol, and the Codex model runs alpha beta seven.",
  );
  assert.equal(
    perClaimSamePeer.pass,
    false,
    "a captured claim never shields a second unparseable claim of the SAME peer (per-alias consumption)",
  );
  const requestPlusAssertion = anchored(
    "We need to determine which model Claude uses, and the cross-review runtime Codex model currently runs alpha beta seven.",
  );
  assert.equal(
    requestPlusAssertion.pass,
    false,
    "the indirect-request exemption is clause-scoped - the separate assertive claim still blocks",
  );
  const contrastRenewal = anchored(
    "The cross-review runtime Codex model will change later but currently uses gpt-5.5.",
  );
  assert.equal(
    contrastRenewal.pass,
    false,
    "a current marker after a future one renews the current assertion (nearest-marker rule)",
  );
  assert.ok(
    contrastRenewal.issue_classes.includes("runtime_contradiction"),
    "the renewed current token is judged by value and contradicts the pin",
  );
  // Codex review of PR #247, round 5 (locator refinements).
  const crossClauseConsumption = anchored(
    "The cross-review runtime Codex model runs alpha beta seven, and gpt-5.6-sol is documented elsewhere.",
  );
  assert.equal(
    crossClauseConsumption.pass,
    false,
    "a captured token in ANOTHER clause never consumes the fragmented claim's alias (same-clause ownership only)",
  );
  const renewedZeroToken = anchored(
    "The cross-review runtime model will change later but currently Codex runs alpha beta seven.",
  );
  assert.equal(
    renewedZeroToken.pass,
    false,
    "a current assertion resuming after a future marker (with a contrast word) stays visible to the guard",
  );
  const clauseScopedModelLanguage = anchored(
    "The cross-review runtime uses OpenAI authentication currently, and the model documentation was updated.",
  );
  assert.equal(
    clauseScopedModelLanguage.pass,
    true,
    "model language in an unrelated clause must not convert a non-model alias into a claim",
  );
  const modalHypothetical = anchored(
    "The cross-review runtime Codex model would currently use gpt-5.5 if the legacy override were enabled.",
  );
  assert.equal(
    modalHypothetical.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: a current marker inside a modal scope (no contrast word) does not renew an actual-state assertion",
  );
  const quotedAliasClaim = anchored(
    'The cross-review runtime model named "Codex" currently runs alpha beta seven.',
  );
  assert.equal(
    quotedAliasClaim.pass,
    false,
    "a single-alias quote is nomenclature, not a quoted log line - the claim still blocks",
  );
  // Codex review of PR #247, round 6.
  const plannedAdjective = anchored(
    "The planned deployment currently runs the cross-review runtime Codex model gpt-5.5.",
  );
  assert.equal(
    plannedAdjective.pass,
    false,
    "a nominal planning word (planned deployment) does not open modal scope - the explicit current marker renews and the captured token contradicts",
  );
  assert.ok(
    plannedAdjective.issue_classes.includes("runtime_contradiction"),
    "the current captured token is judged by value",
  );
  const historicalIntroWithEvidence = anchored(
    "When the audit began, the cross-review runtime Codex model was alpha beta seven.",
    "Historical runtime snapshot from events.ndjson: workflow_start server_info version=4.2.0; later reload server_info version=4.2.1.",
  );
  assert.equal(
    historicalIntroWithEvidence.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: the historical scope crosses its introductory comma - a fully historical sentence with valid timing evidence passes",
  );
  const curlyQuoteExample = anchored(
    "The cross-review runtime model documentation quotes “Codex runs alpha beta seven” as a rejected example.",
  );
  assert.equal(
    curlyQuoteExample.pass,
    true,
    "typographic quotes mask multi-word quoted examples like straight quotes do",
  );
  // Codex review of PR #247, round 7.
  const whileConjunction = anchored(
    "The cross-review runtime Codex model runs alpha beta seven while gpt-5.6-sol is documented elsewhere.",
  );
  assert.equal(
    whileConjunction.pass,
    false,
    "a subordinating conjunction (while) is a clause boundary - the truthful token in the other clause cannot consume the alias of the fragmented claim",
  );
  assert.ok(
    whileConjunction.issue_classes.includes("unsupported_current_state_claim"),
    "the fragmented claim beside a while-clause stays located and blocked",
  );
  const upcomingModel = anchored("The upcoming cross-review runtime Codex model is gpt-5.5.");
  assert.equal(
    upcomingModel.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: a nominal planning word modifying the MODEL itself (the upcoming ... model is X) keeps the future exemption - its copular verb is the future phrase's own predication",
  );
  const anaphoricAlias = anchored(
    "The cross-review runtime model is alpha beta seven, and Codex runs it.",
  );
  assert.equal(
    anaphoricAlias.pass,
    false,
    "an alias clause that refers back to a preceding model antecedent (runs it) carries the model relation - the fragmented claim stays blocked",
  );
  const colonRequest = anchored(
    "We need to determine which model Claude uses: the cross-review runtime Codex model currently runs alpha beta seven.",
  );
  assert.equal(
    colonRequest.pass,
    false,
    "a colon ends the indirect-request scope - the assertive claim after it still reaches the zero-token guard",
  );
  const andNowTransition = anchored(
    "When the audit began, the old settings were recorded, and now the cross-review runtime Codex model remains alpha beta seven.",
    "Historical runtime snapshot from events.ndjson: workflow_start server_info version=4.2.0; later reload server_info version=4.2.1.",
  );
  assert.equal(
    andNowTransition.pass,
    false,
    "a now/remains transition ends the historical carry - the plainly current fragmented claim is blocked even with valid timing evidence",
  );
  // Codex review of PR #247, round 8.
  const labelColon = anchored("The cross-review runtime Codex model: gpt-5.6-sol.");
  assert.equal(
    labelColon.pass,
    true,
    "a label colon followed by a capturable token is not a clause boundary - the truthful label/value construction keeps alias ownership",
  );
  const labelColonLie = anchored("The cross-review runtime Codex model: alpha beta seven.");
  assert.equal(
    labelColonLie.pass,
    false,
    "a label colon followed by a FRAGMENTED value still separates - the alias stays unconsumed and the claim is blocked",
  );
  const postpositivePlanning = anchored(
    "The cross-review runtime Codex model in the planned deployment is gpt-5.5.",
  );
  assert.equal(
    postpositivePlanning.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: a postpositive planning modifier qualifying the preceding model phrase keeps the S3 future exemption",
  );
  const modelDocumentation = anchored(
    "The cross-review runtime Codex model documentation is available.",
  );
  assert.equal(
    modelDocumentation.pass,
    true,
    "a model noun modifying a meta noun (documentation) asserts nothing about the configured pin - no relation, no block",
  );
  // Codex review of PR #247, round 9.
  const currentAdjective = anchored(
    "The current cross-review runtime Codex model gpt-5.5 will be replaced next quarter.",
  );
  assert.equal(
    currentAdjective.pass,
    false,
    "the explicit 'current' adjective marks the assertion current - later planning language cannot exempt the contradictory pin",
  );
  assert.ok(
    currentAdjective.issue_classes.includes("runtime_contradiction"),
    "the current-adjective claim is judged by value",
  );
  const causalConjunction = anchored(
    "The cross-review runtime Codex model runs alpha beta seven because gpt-5.6-sol is documented elsewhere.",
  );
  assert.equal(
    causalConjunction.pass,
    false,
    "a causal conjunction (because) is a clause boundary - the truthful token cannot consume the fragmented claim's alias",
  );
  const labelColonCode = anchored("The cross-review runtime Codex model: `gpt-5.6-sol`.");
  assert.equal(
    labelColonCode.pass,
    true,
    "a label colon followed by a formatting wrapper (inline code) around the token still keeps alias ownership",
  );
  const planningDashboard = anchored(
    "The server currently runs the cross-review runtime Codex model in the planned deployment dashboard using gpt-5.6-sol.",
  );
  assert.equal(
    planningDashboard.pass,
    true,
    "a nominal planning word after an existing current verb does not capture the predicated model head - the truthful pin stays current",
  );
  const xaiAliasFragment = anchored("The cross-review runtime x.ai model runs alpha beta seven.");
  assert.equal(
    xaiAliasFragment.pass,
    false,
    "the dot inside a recognized alias (x.ai) is not a clause boundary - the fragmented claim stays located and blocked",
  );
  const fragmentedRoute = anchored(
    "The cross-review runtime model uses perplexity/alpha beta seven.",
  );
  assert.equal(
    fragmentedRoute.pass,
    false,
    "a provider alias prefixing an unparseable route survives the path mask - the fragmented route claim is blocked",
  );
  // Codex review of PR #247, round 10.
  const secondPredicate = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but runs alpha beta seven.",
  );
  assert.equal(
    secondPredicate.pass,
    false,
    "alias consumption shields only the captured predicate - an orphan verb after the consuming token reopens the zero-token guard",
  );
  assert.ok(
    secondPredicate.issue_classes.includes("unsupported_current_state_claim"),
    "the fragmented second predicate is located and blocked",
  );
  const futureSecondPredicate = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but will adopt a newer build next quarter.",
  );
  assert.equal(
    futureSecondPredicate.pass,
    true,
    "a FUTURE second predicate stays masked - contrastive planning after a truthful pin is not an orphan assertion",
  );
  const inlineCodeExample = anchored(
    "The cross-review runtime documentation gives `Codex model runs alpha beta seven` as a rejected claim.",
  );
  assert.equal(
    inlineCodeExample.pass,
    true,
    "a multi-word inline code span masks like a quotation - a quoted example is not a live assertion",
  );
  // Codex review of PR #247, round 11.
  const possessiveApostrophes = anchored(
    "The cross-review runtime's Codex model's current identity is alpha beta seven.",
  );
  assert.equal(
    possessiveApostrophes.pass,
    false,
    "in-word possessive apostrophes are not quote delimiters - the alias stays visible and the fragmented claim is blocked",
  );
  const reversedPredicate = anchored(
    "The cross-review runtime Codex model runs alpha beta seven but is gpt-5.6-sol.",
  );
  assert.equal(
    reversedPredicate.pass,
    false,
    "a fragmented predicate BEFORE the consuming token is inspected too - two assertion verbs between alias and token reopen the guard",
  );
  const reportingVerb = anchored(
    "The upcoming documentation explains that the cross-review runtime Codex model currently runs alpha beta seven.",
  );
  assert.equal(
    reportingVerb.pass,
    false,
    "a completive (that/que) inside the nominal span ends the planning scope - the reported runtime assertion is judged current",
  );
  // Codex review of PR #247, round 12.
  const subjectModal = anchored(
    "The cross-review runtime Codex model could use gpt-5.5 if the override were enabled.",
  );
  assert.equal(
    subjectModal.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: subject-first modals (could/may/might/should) open modal future scope - a hypothetical configuration is not a runtime contradiction",
  );
  const auxiliaryParticiple = anchored(
    "The cross-review runtime Codex model is currently using gpt-5.6-sol.",
  );
  assert.equal(
    auxiliaryParticiple.pass,
    true,
    "an auxiliary-plus-participle phrase (is currently using) is ONE predicate - the truthful pin is not an orphan-predicate violation",
  );
  // Codex review of PR #247, round 13.
  const defaultsTo = anchored(
    "The cross-review runtime Codex model defaults to gpt-5.5 before a planned upgrade.",
  );
  assert.equal(
    defaultsTo.pass,
    false,
    "a planning marker AFTER an already-predicated value cannot retroactively exempt it - the contradictory pin is judged current",
  );
  assert.ok(
    defaultsTo.issue_classes.includes("runtime_contradiction"),
    "the predicated value is judged by value",
  );
  const equalsPredicate = anchored(
    "The cross-review runtime Codex model equals alpha beta seven but is gpt-5.6-sol.",
  );
  assert.equal(
    equalsPredicate.pass,
    false,
    "a fragmented value candidate between alias and consuming token reopens the guard regardless of the verb used (equals)",
  );
  const descriptiveTail = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but remains available during migration.",
  );
  assert.equal(
    descriptiveTail.pass,
    true,
    "a descriptive trailing predicate (remains available) supplies no fragmented model value - the validated pin passes",
  );
  const confirmIf = anchored(
    "We need to confirm if the cross-review runtime Codex model runs alpha beta seven.",
  );
  assert.equal(
    confirmIf.pass,
    true,
    "'if' stays attached to its indirect-request verb (confirm if) - the legitimate request is masked, not asserted",
  );
  const betweenRange = anchored(
    "Between R1 and R3, the cross-review runtime Codex model was alpha beta seven.",
    "Historical runtime snapshot from events.ndjson: workflow_start server_info version=4.2.0; later reload server_info version=4.2.1.",
  );
  assert.equal(
    betweenRange.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: the 'and' inside a historical range (Between R1 and R3) is not a clause boundary - the historical construction masks whole",
  );
  // Codex review of PR #247, round 14.
  const coordinatedPredicate = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol, and runs alpha beta seven.",
  );
  assert.equal(
    coordinatedPredicate.pass,
    false,
    "a coordinated predicate with an elided subject inherits the model subject - the fragmented claim is blocked",
  );
  const coordinatedBenign = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol, and runs smoothly.",
  );
  assert.equal(
    coordinatedBenign.pass,
    true,
    "a coordinated predicate with no fragmented value candidate (runs smoothly) stays valid",
  );
  const singleOpaqueValue = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but uses Orion.",
  );
  assert.equal(
    singleOpaqueValue.pass,
    false,
    "a single capitalized opaque word (Orion) after a validated pin is a value candidate - the second predicate reopens the guard",
  );
  const gptAlias = anchored("The cross-review runtime GPT model runs alpha beta seven.");
  assert.equal(
    gptAlias.pass,
    false,
    "standalone GPT is a Codex alias - the fragmented claim is located and blocked",
  );
  // Codex review of PR #247, round 15.
  const coordDefaults = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol, and defaults to alpha beta seven.",
  );
  assert.equal(
    coordDefaults.pass,
    false,
    "an elided-subject coordinate is detected by its missing determiner, not a verb allowlist - 'and defaults to alpha beta seven' is blocked",
  );
  const lowercaseOpaque = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but uses orion.",
  );
  assert.equal(
    lowercaseOpaque.pass,
    false,
    "a lone opaque word after a USAGE verb (uses orion) is a value candidate even lowercase",
  );
  const canCapability = anchored(
    "The cross-review runtime Codex model can use gpt-5.5 when configured.",
  );
  assert.equal(
    canCapability.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: subject-first 'can' opens modal capability scope - a possible configuration is not a contradiction",
  );
  const runtimeUses = anchored("The cross-review runtime uses Codex alpha beta seven.");
  assert.equal(
    runtimeUses.pass,
    false,
    "a direct runtime-use predicate (uses Codex <value>) is a model relation - the fragmented claim is located and blocked",
  );
  const compositeAlias = anchored("The cross-review runtime OpenAI Codex model is gpt-5.6-sol.");
  assert.equal(
    compositeAlias.pass,
    true,
    "adjacent same-peer aliases (OpenAI Codex) are consumed together by the captured predicate",
  );
  const sinceRelational = anchored(
    "The cross-review runtime Codex model has remained unchanged since gpt-5.6-sol was deployed.",
  );
  assert.equal(
    sinceRelational.pass,
    false,
    "HARDENED CONTRACT: this family now BLOCKS by design (state the exact pin adjacent or use structured evidence). Was: a subordinate clause supplying the subject's own value consumes the alias when the alias clause holds no fragmented candidate",
  );
  const zeroComplementizer = anchored(
    "The upcoming documentation explains the cross-review runtime Codex model currently runs alpha beta seven.",
  );
  assert.equal(
    zeroComplementizer.pass,
    false,
    "a reporting verb ends the nominal planning scope even with a zero complementizer - the reported claim is judged current",
  );
  // Codex review of PR #247, round 16.
  const mayMonth = anchored("The cross-review runtime Codex model as of May is gpt-5.5.");
  assert.equal(
    mayMonth.pass,
    false,
    "the month name May (after a date preposition) is not a modal - the contradictory pin is judged current",
  );
  assert.ok(
    mayMonth.issue_classes.includes("runtime_contradiction"),
    "the as-of-May claim is judged by value",
  );
  const descriptiveCoordinate = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol, and performs careful reviews.",
  );
  assert.equal(
    descriptiveCoordinate.pass,
    true,
    "a descriptive coordinate (performs careful reviews) carries no code word and is not a model-identity candidate",
  );
  const denialSubordinate = anchored(
    "The cross-review runtime Codex model is not the configured model pin at present, although gpt-5.6-sol appears in the documentation.",
  );
  assert.equal(
    denialSubordinate.pass,
    false,
    "a NEGATED alias clause is never consumed cross-clause - the denial cannot be validated by a token in an unrelated subordinate",
  );
  const apiIntegration = anchored("The cross-review runtime uses OpenAI APIs for embeddings.");
  assert.equal(
    apiIntegration.pass,
    true,
    "provider API/SDK integration prose is not a model-pin relation",
  );
  // Codex review of PR #247, round 17 (KEEP-area findings only; the
  // modal-grammar finding is suspended pending the structural design
  // decision).
  const quotedComposite = anchored(
    'The cross-review runtime "OpenAI Codex" model runs alpha beta seven.',
  );
  assert.equal(
    quotedComposite.pass,
    false,
    "an all-alias composite quote (OpenAI Codex) is nomenclature like the single-alias case - the fragmented claim stays located",
  );
  const possessiveComposite = anchored(
    "The cross-review runtime OpenAI's Codex model is gpt-5.6-sol.",
  );
  assert.equal(
    possessiveComposite.pass,
    true,
    "a possessive separator inside a same-peer composite name (OpenAI's Codex) does not break consumption",
  );
  const terminalPathAlias = anchored(
    "The cross-review model_pin table is documented in docs/gemini.md for reference.",
  );
  assert.equal(
    terminalPathAlias.pass,
    true,
    "an alias in the TERMINAL path segment (docs/gemini.md) is masked with the whole filesystem path",
  );
  // Codex review of PR #247, round 18 (KEEP-area findings).
  const defaultsToOrion = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol but defaults to orion.",
  );
  assert.equal(
    defaultsToOrion.pass,
    false,
    "a lowercase opaque value after an open-class verb plus 'to' (defaults to orion) is a model-value slot - the second claim reopens the guard",
  );
  const committedBenign = anchored(
    "The cross-review runtime Codex model is gpt-5.6-sol and remains stable in production.",
  );
  assert.equal(
    committedBenign.pass,
    true,
    "a stative description without a value slot stays valid",
  );
  {
    const longChain = `The cross-review runtime Codex model is documented at ${"a/".repeat(20_000)}a for reference.`;
    const chainStart = Date.now();
    const chainResult = anchored(longChain);
    const chainMs = Date.now() - chainStart;
    assert.ok(
      chainMs < 3_000,
      `terminal-path masking stays linear on a forty-thousand-character slash chain (${chainMs}ms)`,
    );
    assert.equal(typeof chainResult.pass, "boolean", "the long-chain draft still evaluates");
  }
  {
    const manyAliases = `The cross-review runtime ${"Codex ".repeat(6_000)}model is gpt-5.6-sol.`;
    const linearStart = Date.now();
    const linearResult = anchored(manyAliases);
    const linearMs = Date.now() - linearStart;
    assert.ok(
      linearMs < 3_000,
      `adjacent-alias consumption expands in linear time (${linearMs}ms for six thousand aliases)`,
    );
    assert.equal(typeof linearResult.pass, "boolean", "the oversized-alias draft still evaluates");
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
