import assert from "node:assert/strict";
import fs from "node:fs";

import { evidencePreflight } from "../src/core/orchestrator.js";

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
    "```diff\n@@ -1,3 +1,4 @@\n+const x = 1;\n```\nsrc/foo.ts:12 changed; sha 1a2b3c4d5e6f.",
  attachmentsPresent: false,
});
assert.equal(
  backed.pass,
  true,
  "v3.5.0 / evidence_preflight: completed-work claim backed by inline evidence markers must pass",
);
assert.equal(backed.completed_work_claim_matched, true);
assert.equal(backed.evidence_marker_found, true);

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

// (e) attachments present -> PASS unconditionally.
const withAttachments = evidencePreflight({
  task: "Review my patch - 99 passed.",
  initialDraft: "no markers here",
  attachmentsPresent: true,
});
assert.equal(
  withAttachments.pass,
  true,
  "v3.5.0 / evidence_preflight: attached evidence must satisfy preflight unconditionally",
);
assert.equal(withAttachments.attachments_present, true);

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
});
assert.equal(
  attachedEvidenceReference.pass,
  true,
  "v4.3.7 / evidence_preflight: referenced evidence artifacts present in attachments must pass",
);

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
