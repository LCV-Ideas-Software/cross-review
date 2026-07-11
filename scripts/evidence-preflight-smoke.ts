import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import {
  blockConvergenceForUnresolvedEvidence,
  checkConvergence,
} from "../src/core/convergence.js";
import { CrossReviewOrchestrator, evidencePreflight } from "../src/core/orchestrator.js";
import type { EvidenceChecklistItem, PeerResult } from "../src/core/types.js";

// v3.5.0 (CRV2-4) - evidence_preflight pure-function behavioral matrix.
//
// The preflight is the highest-false-positive-risk item in v3.5.0, so
// the matrix covers both trip and no-trip paths explicitly: (a) a
// completed-work claim WITH no evidence marker trips; (b) the same
// claim WITH an inline evidence marker passes; (c) a design-review that
// merely mentions "patch" but makes no completed-work claim passes
// (false-positive guard — the disconfirming case); (d) a non-empty
// structured `evidence` field passes unconditionally; (e) attachments
// present passes unconditionally; (f) empty/benign task passes.

// (a) completed-work claim, zero evidence markers -> TRIP.
const tripped = evidencePreflight({
  task: "Pre-commit review of my patch. I ran the tests, 42 passed, and git diff --check is clean.",
  initialDraft: "The change looks good. Build succeeded.",
  attachmentsPresent: false,
});
assert.equal(
  tripped.pass,
  false,
  "v3.5.0 / evidence_preflight: completed-work claim with zero evidence markers must trip",
);
assert.equal(tripped.completed_work_claim_matched, true);
assert.equal(tripped.evidence_marker_found, false);

// (b) same claim WITH an inline evidence marker (fenced block + diff hunk) -> PASS.
const backed = evidencePreflight({
  task: "Pre-commit review of my patch. 42 passed.",
  initialDraft:
    "```text\nTests 42 passed, 0 failed\nEXIT_CODE: 0\n```\n```diff\n@@ -1,3 +1,4 @@\n+const x = 1;\n```\nsrc/foo.ts:12 changed; sha 1a2b3c4d5e6f.",
  attachmentsPresent: false,
});
assert.equal(
  backed.pass,
  true,
  "v3.5.0 / evidence_preflight: completed-work claim backed by inline evidence markers must pass",
);
assert.equal(backed.completed_work_claim_matched, true);
assert.equal(backed.evidence_marker_found, true);

const fakeFence = evidencePreflight({
  task: "Pre-commit review of my patch. 42 passed.",
  initialDraft: "```text\ntrust me\n```",
  attachmentsPresent: false,
});
assert.equal(
  fakeFence.pass,
  false,
  "v4.4.9 / evidence_preflight: a code fence without corresponding raw evidence must not pass",
);

// (c) DESIGN REVIEW false-positive guard: mentions "patch" but makes
//     no completed-work claim -> must PASS (the disconfirming case).
const designReview = evidencePreflight({
  task: "I plan to write a patch for the auth flow. Want design feedback on the approach before I implement - should I use a token refresh queue or a mutex?",
  initialDraft: "Proposed approach: wrap the refresh in a single-flight mutex.",
  attachmentsPresent: false,
});
assert.equal(
  designReview.pass,
  true,
  "v3.5.0 / evidence_preflight: design review mentioning 'patch' with no completed-work claim must NOT trip (false-positive guard)",
);
assert.equal(designReview.completed_work_claim_matched, false);

// (d) structured `evidence` field supplied -> PASS unconditionally
//     even when the task makes a bare completed-work claim.
const withStructured = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  structuredEvidence: "git diff --stat: 3 files changed; test log: 99 passed 0 failed",
  attachmentsPresent: false,
});
assert.equal(
  withStructured.pass,
  true,
  "v3.5.0 / evidence_preflight: non-empty structured evidence field must satisfy preflight unconditionally",
);
assert.equal(withStructured.structured_evidence_supplied, true);

// (e) Attachment presence alone is not proof. Its content must corroborate
//     the operational values/assertions in the claim.
const withGenericAttachment = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  attachmentsPresent: true,
  attachedEvidenceText: "trust me",
});
assert.equal(
  withGenericAttachment.pass,
  false,
  "v4.4.9 / evidence_preflight: generic attachment content must not satisfy a 99-passed claim",
);
assert.equal(withGenericAttachment.attachments_present, true);

const withMatchingAttachment = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  attachmentsPresent: true,
  attachedEvidenceText: "Tests 99 passed, 0 failed\nEXIT_CODE: 0",
});
assert.equal(
  withMatchingAttachment.pass,
  true,
  "v4.4.9 / evidence_preflight: matching raw attachment content must satisfy the claim",
);

const withGenericStructuredEvidence = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  structuredEvidence: "trust me",
  attachmentsPresent: false,
});
assert.equal(
  withGenericStructuredEvidence.pass,
  false,
  "v4.4.9 / evidence_preflight: generic structuredEvidence must not satisfy a 99-passed claim",
);

const peerCannotSelfAttestStructuredEvidence = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  caller: "claude",
  structuredEvidence: "Tests 99 passed, 0 failed\nEXIT_CODE: 0",
  attachmentsPresent: false,
});
assert.equal(
  peerCannotSelfAttestStructuredEvidence.pass,
  false,
  "v4.5.0 / evidence_preflight: a peer caller cannot turn its own structured text into provenance-grade evidence",
);

const peerCanUseOperatorCustodiedAttachment = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  caller: "claude",
  attachedEvidenceText: "Tests 99 passed, 0 failed\nEXIT_CODE: 0",
  attachmentsPresent: true,
});
assert.equal(
  peerCanUseOperatorCustodiedAttachment.pass,
  true,
  "v4.5.0 / evidence_preflight: a peer may rely on content already admitted through operator-only attachment custody",
);

const mismatchedStructuredValue = evidencePreflight({
  task: "Review my patch - 99 passed.",
  structuredEvidence: "Tests 199 passed, 0 failed\nEXIT_CODE: 0",
  attachmentsPresent: false,
});
assert.equal(
  mismatchedStructuredValue.pass,
  false,
  "v4.4.9 / evidence_preflight: 199 passed must not corroborate 99 passed by substring",
);

const contradictedAttachmentOutcome = evidencePreflight({
  task: "Review my patch - 99 passed.",
  attachmentsPresent: true,
  attachedEvidenceText: "Tests 99 failed\nEXIT_CODE: 1",
});
assert.equal(
  contradictedAttachmentOutcome.pass,
  false,
  "v4.4.9 / evidence_preflight: a matching number with the opposite outcome must not pass",
);

// (e2) attached evidence is not a blank cheque: if the review text
//      explicitly points to another evidence artifact that is not attached,
//      the preflight must block before paid calls.
const unattachedEvidenceReference = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "The summary is attached, but the literal disk grep proof is in wmx4fm04e.output.",
  structuredEvidence:
    "Attached release-candidate-evidence-pack.txt summarizes the run; T3 literal evidence deferred to wmx4fm04e.output.",
  attachmentsPresent: true,
  attachedEvidenceRefs: ["release-candidate-evidence-pack.txt"],
});
assert.equal(
  unattachedEvidenceReference.pass,
  false,
  "v4.3.7 / evidence_preflight: referenced external evidence artifacts must be attached",
);
assert.deepEqual(unattachedEvidenceReference.unattached_evidence_references, ["wmx4fm04e.output"]);

const attachedEvidenceReference = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "The summary and literal disk grep proof are attached.",
  structuredEvidence:
    "Attached release-candidate-evidence-pack.txt summarizes the run; T3 literal evidence is in wmx4fm04e.output.",
  attachmentsPresent: true,
  attachedEvidenceRefs: ["release-candidate-evidence-pack.txt", "wmx4fm04e.output"],
  attachedEvidenceText: "npm run smoke\nTests 12 passed, 0 failed\nEXIT_CODE: 0",
});
assert.equal(
  attachedEvidenceReference.pass,
  true,
  "v4.3.7 / evidence_preflight: referenced evidence artifacts present in attachments must pass",
);

const bareFilenameReferenceMatchesPathAttachment = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "The literal production log proof is in prod.log.",
  attachmentsPresent: true,
  attachedEvidenceRefs: ["logs/prod.log"],
  attachedEvidenceText: "npm run smoke\nTests 12 passed, 0 failed\nEXIT_CODE: 0",
});
assert.equal(
  bareFilenameReferenceMatchesPathAttachment.pass,
  true,
  "v4.3.9 / evidence_preflight: bare evidence refs may match an attached path basename",
);

const pathSpecificReference = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "The raw production log proof is in logs/prod.log.",
  structuredEvidence:
    "Attached prod.log is a summary, but the literal source-of-truth is logs/prod.log.",
  attachmentsPresent: true,
  attachedEvidenceRefs: ["prod.log"],
});
assert.equal(
  pathSpecificReference.pass,
  false,
  "v4.3.9 / evidence_preflight: path-qualified evidence refs must not pass via basename-only attachments",
);
assert.deepEqual(pathSpecificReference.unattached_evidence_references, ["logs/prod.log"]);

const normalizedPathReference = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "The raw production log proof is in ./logs/prod.log.",
  structuredEvidence: "The same source-of-truth may be cited as logs\\prod.log in Windows output.",
  attachmentsPresent: true,
  attachedEvidenceRefs: ["logs/prod.log"],
  attachedEvidenceText: "npm run smoke\nTests 12 passed, 0 failed\nEXIT_CODE: 0",
});
assert.equal(
  normalizedPathReference.pass,
  true,
  "v4.3.9 / evidence_preflight: dot-slash and backslash path-qualified refs normalize to attached paths",
);

const broaderArtifactExtensions = evidencePreflight({
  task: "Review this release audit. npm run smoke passed.",
  initialDraft: "Literal evidence lives in audit.md, changes.diff, fix.patch, and metrics.csv.",
  attachmentsPresent: false,
});
assert.equal(
  broaderArtifactExtensions.pass,
  false,
  "v4.3.9 / evidence_preflight: md/diff/patch/csv evidence artifact refs must be detected",
);
assert.deepEqual(broaderArtifactExtensions.unattached_evidence_references, [
  "audit.md",
  "changes.diff",
  "fix.patch",
  "metrics.csv",
]);

// (f) benign task with no completed-work claim -> PASS (nothing to preflight).
const benign = evidencePreflight({
  task: "Review this CHANGELOG wording for clarity.",
  initialDraft: "## v1.2.3\n- Improved wording.",
  attachmentsPresent: false,
});
assert.equal(
  benign.pass,
  true,
  "v3.5.0 / evidence_preflight: benign task with no completed-work claim must pass",
);

// (g) Negated/instructional command mentions are not completed-work claims.
// Tightening the fabrication threshold to one assertion must not turn design
// instructions into false evidence failures.
for (const task of [
  "Please run cargo test and git diff before implementation.",
  "I did not run cargo test, and no git diff was produced.",
]) {
  const nonAssertive = evidencePreflight({
    task,
    initialDraft: "Design discussion only.",
    attachmentsPresent: false,
  });
  assert.equal(
    nonAssertive.pass,
    true,
    `v4.4.9 / evidence_preflight: non-assertive command context must pass (${task})`,
  );
  assert.equal(nonAssertive.completed_work_claim_matched, false);
}

// (h) A peer silently dropping an evidence ask is not satisfaction. Both
// open and not_resurfaced items must veto an otherwise unanimous result.
const readyPeer: PeerResult = {
  peer: "claude",
  provider: "anthropic",
  model: "claude-fable-5",
  status: "READY",
  structured: {
    status: "READY",
    summary: "No objection.",
    confidence: "inferred",
    evidence_sources: ["Attachment: deterministic-evidence-preflight-fixture"],
    caller_requests: [],
    follow_ups: [],
  },
  text: "",
  raw: {},
  latency_ms: 0,
  attempts: 1,
  parser_warnings: [],
  decision_quality: "clean",
};
const unanimous = checkConvergence(["claude"], "READY", [readyPeer], []);
assert.equal(unanimous.converged, true);

const checklistItem = (status: EvidenceChecklistItem["status"]): EvidenceChecklistItem => ({
  id: "deadbeefdeadbeef",
  peer: "claude",
  first_round: 1,
  last_round: 1,
  round_count: 1,
  ask: "Attach the raw test output.",
  first_seen_at: "2026-07-10T00:00:00.000Z",
  last_seen_at: "2026-07-10T00:00:00.000Z",
  status,
});

for (const status of ["open", "not_resurfaced"] as const) {
  const gated = blockConvergenceForUnresolvedEvidence(unanimous, [checklistItem(status)]);
  assert.equal(gated.converged, false, `${status} evidence must block convergence`);
  assert.match(gated.reason, /unresolved_evidence/);
}
for (const status of ["addressed", "satisfied", "deferred", "rejected"] as const) {
  const gated = blockConvergenceForUnresolvedEvidence(unanimous, [checklistItem(status)]);
  assert.equal(gated.converged, true, `${status} evidence must not block convergence`);
}

const genericCiSuccess = evidencePreflight({
  task: "Review the completed implementation.",
  initialDraft: "The CI completed without errors and every check succeeded.",
  caller: "claude",
  attachmentsPresent: false,
});
assert.equal(
  genericCiSuccess.pass,
  false,
  "peer-authored generic CI/check success claims require operator-custodied evidence",
);

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
const directEvents: string[] = [];
const directConfig = {
  ...loadConfig(),
  data_dir: fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-direct-preflight-")),
};
const directOrchestrator = new CrossReviewOrchestrator(directConfig, (event) =>
  directEvents.push(event.type),
);
const directBlocked = await directOrchestrator.askPeers({
  task: "Review the completed implementation.",
  draft: "The CI completed without errors and every check succeeded.",
  caller: "claude",
  peers: ["codex"],
});
assert.equal(directBlocked.converged, false);
assert.equal(directBlocked.round.peers.length, 0);
assert.ok(
  directBlocked.round.rejected.every((failure) => failure.failure_class === "evidence_preflight"),
  "direct askPeers must materialize a local evidence_preflight failure",
);
assert.equal(
  directEvents.includes("peer.call.started"),
  false,
  "preflight must run before peer calls",
);

// Source pins: env var + config flag + orchestrator wiring + outcome reason.
const orchSrcPf = fs.readFileSync(new URL("../src/core/orchestrator.ts", import.meta.url), "utf8");
const configSrcPf = fs.readFileSync(new URL("../src/core/config.ts", import.meta.url), "utf8");
assert.ok(
  /export function evidencePreflight\b/.test(orchSrcPf),
  "v3.5.0 / evidence_preflight: evidencePreflight must be exported",
);
assert.ok(
  /this\.config\.evidence_preflight_enabled/.test(orchSrcPf),
  "v3.5.0 / evidence_preflight: runUntilUnanimous must gate on config.evidence_preflight_enabled",
);
const askPeersStart = orchSrcPf.indexOf("async askPeers");
const runUntilStart = orchSrcPf.indexOf("async runUntilUnanimous", askPeersStart);
const askPeersSource = orchSrcPf.slice(askPeersStart, runUntilStart);
assert.ok(
  /evidencePreflight\(/.test(askPeersSource),
  "v4.5.0 / evidence_preflight: direct askPeers must run evidence preflight before paid calls",
);
assert.ok(
  /"needs_evidence_preflight"/.test(orchSrcPf),
  "v3.5.0 / evidence_preflight: finalize reason `needs_evidence_preflight` must be wired",
);
assert.ok(
  /session\.evidence_preflight_failed/.test(orchSrcPf),
  "v3.5.0 / evidence_preflight: event `session.evidence_preflight_failed` must be emitted",
);
assert.ok(
  /boolEnv\("CROSS_REVIEW_EVIDENCE_PREFLIGHT", true\)/.test(configSrcPf),
  "v3.5.0 / evidence_preflight: CROSS_REVIEW_EVIDENCE_PREFLIGHT env var must default ON",
);

console.log("[smoke] evidence_preflight_test: PASS");
