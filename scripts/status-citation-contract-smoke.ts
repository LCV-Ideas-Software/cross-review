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

console.log("[status-citation-contract-smoke] PASS");
