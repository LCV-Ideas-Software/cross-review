import assert from "node:assert/strict";

import {
  parsePeerStatus,
  READY_CANONICAL_SUMMARY,
  statusInstruction,
  statusJsonSchema,
  statusSchema,
} from "../src/core/status.js";

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

console.log("[status-citation-contract-smoke] PASS");
