import assert from "node:assert/strict";
import crypto from "node:crypto";

import { groundReadyPeerEvidence } from "../src/core/orchestrator.js";

import {
  decisionQualityFromStatus,
  parsePeerStatus,
  READY_CANONICAL_SUMMARY,
  statusInstruction,
  statusJsonSchema,
  statusSchema,
} from "../src/core/status.js";
import type { PeerResult } from "../src/core/types.js";

const instruction = statusInstruction();
const digest = "a".repeat(64);
const source = [
  "Attachment: evidence/review.txt",
  `sha256=${digest}`,
  'Artifact quote: "Tests 74 passed (74)"',
].join("\n");

assert.match(
  instruction,
  /Canonical citation format for EACH `evidence_sources` string item:/,
  "the prompt must label the canonical per-item citation grammar",
);
assert.match(
  instruction,
  /Attachment: <persisted-path>[\s\S]*sha256=<64 lowercase hex>[\s\S]*Artifact quote: "<literal text from that same attachment>"/,
  "the prompt must state the exact Attachment + digest + literal quote grammar",
);
assert.match(
  instruction,
  /After JSON decoding[\s\S]*three lines[\s\S]*encode the two line breaks as `\\n` in raw JSON/,
  "the prompt must distinguish decoded newlines from valid JSON escaping",
);
assert.match(
  instruction,
  /Artifact quote.*(?:last line|end of the item)/i,
  "the prompt must tell peers that Artifact quote terminates a citation item",
);
assert.match(
  instruction,
  /Multiple sources.*separate.*array items/i,
  "the prompt must forbid joining multiple sources into one citation item",
);
assert.match(
  instruction,
  /at least 12 characters/i,
  "the prompt must expose the parser's minimum literal-quote length",
);
assert.match(
  instruction,
  /(?:target|normally).*500 characters/i,
  "the prompt must recommend a compact evidence quote well below the hard cap",
);
assert.match(
  instruction,
  /smallest sufficient literal/i,
  "anti-verbosity guidance must request the smallest sufficient literal",
);
assert.match(
  instruction,
  /do not dump.*(?:full files|whole files|entire files).*logs.*peer.*provider/i,
  "anti-verbosity guidance must forbid using evidence_sources as an output dump",
);
assert.match(
  instruction,
  /including Claude/i,
  "the anti-shortcut rule must remain explicit for Claude without singling it out for abuse",
);
assert.match(
  instruction,
  /inspect the artifact/i,
  "anti-laziness guidance must require inspecting the artifact",
);
assert.match(
  instruction,
  /decode.*for analysis[\s\S]*physical persisted attachment text/i,
  "decoding an attachment for analysis must not change the cited physical text",
);
assert.match(
  instruction,
  /Checklist-Item: <id>.*before.*Attachment[\s\S]*never insert checklist metadata.*inside.*quote/i,
  "checklist metadata must stay outside the literal citation",
);
assert.match(
  instruction,
  /contiguous literal raw-diff excerpt[\s\S]*Old code quoted only from removed lines/i,
  "the prompt must explain how a literal removal proof remains groundable",
);

assert.equal(
  statusJsonSchema.properties.evidence_sources.items.type,
  "string",
  "the provider contract must preserve string[] compatibility",
);
assert.equal(statusJsonSchema.properties.evidence_sources.maxItems, 30);
assert.equal(statusJsonSchema.properties.evidence_sources.items.maxLength, 2500);

const canonical = {
  status: "READY" as const,
  summary: READY_CANONICAL_SUMMARY,
  confidence: "verified" as const,
  evidence_sources: [source],
  caller_requests: [],
  follow_ups: [],
};
assert.equal(statusSchema.safeParse(canonical).success, true);
assert.equal(
  statusSchema.safeParse({ ...canonical, evidence_sources: [source, source] }).success,
  true,
  "multiple sources remain separate compatible string array items",
);
assert.equal(
  statusSchema.safeParse({
    ...canonical,
    evidence_sources: [
      {
        attachment: "evidence/review.txt",
        sha256: digest,
        quote: "Tests 74 passed (74)",
      },
    ],
  }).success,
  false,
  "the contract must not silently migrate legacy string items to objects",
);

const parsed = parsePeerStatus(JSON.stringify(canonical));
assert.equal(parsed.raw_status, "READY");
assert.equal(parsed.normalized_status, "READY");
assert.deepEqual(parsed.structured?.evidence_sources, [source]);

const serverDemotionCases = [
  {
    name: "lossy schema recovery",
    response: JSON.stringify({ ...canonical, summary: "x".repeat(801) }),
    warning: "ready_rejected_lossy_parse",
  },
  {
    name: "unknown confidence",
    response: JSON.stringify({ ...canonical, confidence: "unknown" }),
    warning: "ready_with_unknown_confidence",
  },
  {
    name: "noncanonical summary",
    response: JSON.stringify({ ...canonical, summary: "Looks good." }),
    warning: "ready_noncanonical_summary",
  },
  {
    name: "external narrative",
    response: `Narrative outside the envelope.\n${JSON.stringify(canonical)}`,
    warning: "ready_with_external_narrative",
  },
  {
    name: "missing concrete evidence",
    response: JSON.stringify({ ...canonical, evidence_sources: [] }),
    warning: "verified_without_evidence_sources",
  },
] as const;

for (const testCase of serverDemotionCases) {
  const demoted = parsePeerStatus(testCase.response);
  assert.equal(demoted.raw_status, "READY", `${testCase.name}: raw peer vote`);
  assert.equal(demoted.normalized_status, "NEEDS_EVIDENCE", `${testCase.name}: server demotion`);
  assert.ok(demoted.parser_warnings.includes(testCase.warning), `${testCase.name}: warning`);
  assert.deepEqual(
    demoted.structured?.caller_requests,
    [],
    `${testCase.name}: server remediation must not become a peer-authored checklist ask`,
  );
  assert.equal(
    typeof demoted.decision_transformations.at(-1)?.details?.remediation,
    "string",
    `${testCase.name}: remediation remains available in the transformation audit trail`,
  );
}

const peerAuthoredAsk = "Provide raw npm test output with EXIT_CODE: 0.";
const contradictoryReady = parsePeerStatus(
  JSON.stringify({ ...canonical, caller_requests: [peerAuthoredAsk] }),
);
assert.equal(contradictoryReady.normalized_status, "NEEDS_EVIDENCE");
assert.deepEqual(
  contradictoryReady.structured?.caller_requests,
  [peerAuthoredAsk],
  "a genuine peer-authored ask must survive READY invariant enforcement unchanged",
);

const explicitNeedsEvidence = parsePeerStatus(
  JSON.stringify({
    ...canonical,
    status: "NEEDS_EVIDENCE",
    summary: "Raw test output is required.",
    caller_requests: [peerAuthoredAsk],
  }),
);
assert.equal(explicitNeedsEvidence.raw_status, "NEEDS_EVIDENCE");
assert.equal(explicitNeedsEvidence.normalized_status, "NEEDS_EVIDENCE");
assert.deepEqual(
  explicitNeedsEvidence.structured?.caller_requests,
  [peerAuthoredAsk],
  "an explicit NEEDS_EVIDENCE verdict must keep its real evidence request",
);

type Attachment = {
  relative_path: string;
  content: string;
  sha256: string;
};

function attachment(name: string, content: string): Attachment {
  return {
    relative_path: `evidence/${name}`,
    content,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function citation(item: Attachment, quote: string): string {
  return `Attachment: ${item.relative_path}\nsha256=${item.sha256}\nArtifact quote: "${quote}"`;
}

function groundCitation(item: Attachment, sources: string[], checklistIds: string[] = []) {
  const text = JSON.stringify({ ...canonical, evidence_sources: sources });
  const decision = parsePeerStatus(text);
  assert.equal(decision.normalized_status, "READY", "the response envelope itself is valid");
  const peer: PeerResult = {
    peer: "gemini",
    provider: "fixture-gemini",
    model: "fixture-gemini",
    ...decision,
    text,
    raw: {},
    latency_ms: 0,
    attempts: 0,
    decision_quality: decisionQualityFromStatus(decision.status, decision.parser_warnings),
  };
  return groundReadyPeerEvidence(peer, {
    artifactText: "Review proposed source changes.",
    attachedEvidenceText: "",
    attachmentRefs: [item.relative_path],
    evidenceAttachments: [item],
    callerSubmittedAttachments: [item],
    evidenceChecklistItemIds: checklistIds,
    runtimeFacts: {},
  });
}

const jsonLines = attachment(
  "patch-lines.json",
  JSON.stringify(['+const mode = "strict";'], null, 2),
);
const literal = attachment(
  "literal.txt",
  'const integrityMode = "strict";\nTests 74 passed (74)\nNo blocking objections remain.\nCorreções de configuração concluídas.\nconst message = "<verified>";\nif (enabled) {  return true; }\napi_key = [REDACTED]',
);
const patch = attachment(
  "change.patch",
  "diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-const insecureMode = true;\n+const insecureMode = false;\n",
);
const checklistId = "0123456789abcdef";
const groundingCases = [
  {
    name: "physically escaped JSON-array source quote",
    item: jsonLines,
    sources: [citation(jsonLines, '+const mode = \\"strict\\";')],
    expected: "READY",
  },
  {
    name: "decoded JSON value presented as physical attachment text",
    item: jsonLines,
    sources: [citation(jsonLines, '+const mode = "strict";')],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "same-artifact literal",
    item: literal,
    sources: [citation(literal, 'const integrityMode = "strict";')],
    expected: "READY",
  },
  {
    name: "correct literal with wrong digest",
    item: literal,
    sources: [
      citation(literal, 'const integrityMode = "strict";').replace(literal.sha256, "f".repeat(64)),
    ],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "correct literal from a different named attachment",
    item: literal,
    sources: [
      citation(literal, 'const integrityMode = "strict";').replace(
        literal.relative_path,
        "evidence/other.txt",
      ),
    ],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "invented literal suffix",
    item: literal,
    sources: [citation(literal, 'const integrityMode = "strict"; invented suffix')],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "one valid source masking a second invented source",
    item: literal,
    sources: [
      citation(literal, "Tests 74 passed (74)"),
      citation(literal, "invented evidence literal"),
    ],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "rationale appended after the literal",
    item: literal,
    sources: [
      `${citation(literal, "Tests 74 passed (74)")} Therefore the implementation is correct.`,
    ],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "old-code-only quote from removed hunk",
    item: patch,
    sources: [citation(patch, "-const insecureMode = true;")],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "contiguous removed and added raw diff lines",
    item: patch,
    sources: [citation(patch, "-const insecureMode = true;\n+const insecureMode = false;")],
    expected: "READY",
  },
  {
    name: "contiguous actual hunk header and removal",
    item: patch,
    sources: [citation(patch, "@@ -1 +1 @@\n-const insecureMode = true;")],
    expected: "READY",
  },
  {
    name: "literal Unicode",
    item: literal,
    sources: [citation(literal, "Correções de configuração concluídas.")],
    expected: "READY",
  },
  {
    name: "additional inner Unicode escape layer",
    item: literal,
    sources: [
      citation(literal, "Corre\\u00e7\\u00f5es de configura\\u00e7\\u00e3o conclu\\u00eddas."),
    ],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "canonical same-artifact assurance is not rejected by the generic lexicon",
    item: literal,
    sources: [citation(literal, "No blocking objections remain.")],
    expected: "READY",
  },
  {
    name: "checklist metadata before the canonical citation",
    item: literal,
    sources: [`Checklist-Item: ${checklistId}\n${citation(literal, "Tests 74 passed (74)")}`],
    expected: "READY",
  },
  {
    name: "checklist metadata interleaved inside the literal",
    item: literal,
    sources: [citation(literal, `Tests 74 passed (74)\nChecklist-Item: ${checklistId}`)],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "HTML entity conversion changes the actual quote",
    item: literal,
    sources: [citation(literal, 'const message = "&lt;verified&gt;";')],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "whitespace normalization changes the actual quote",
    item: literal,
    sources: [citation(literal, "if (enabled) { return true; }")],
    expected: "NEEDS_EVIDENCE",
  },
  {
    name: "already-redacted literal remains reviewable without reconstructing a key",
    item: literal,
    sources: [citation(literal, "api_key = [REDACTED]")],
    expected: "READY",
  },
] as const;

for (const testCase of groundingCases) {
  const grounded = groundCitation(testCase.item, [...testCase.sources], [checklistId]);
  assert.equal(grounded.result.status, testCase.expected, testCase.name);
  assert.equal(grounded.grounded, testCase.expected === "READY", testCase.name);
  if (testCase.expected === "NEEDS_EVIDENCE") {
    assert.ok(
      grounded.failed_predicates.includes("every_source_independently_grounded"),
      `${testCase.name}: the concrete failed predicate remains visible`,
    );
  }
}

console.log("[status-citation-contract-smoke] PASS");
