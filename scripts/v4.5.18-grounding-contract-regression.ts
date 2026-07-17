import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groundReadyPeerEvidence, truthfulnessPreflight } from "../src/core/orchestrator.js";
import type { PeerResult, ReviewStatus } from "../src/core/types.js";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const RUNTIME_FACTS = {
  runtime_version: "4.5.17",
  release_date: "2026-07-17",
  model_pins: {},
} as const;

const ATTACHMENT = {
  relative_path: "evidence/review-output.txt",
  sha256: "7b7ff5b959d17e07f20d5b3a481a3f320624af987cd38a1d3df3d8635c8f8a31",
  content: "src/index.ts:10: return verifiedValue;\nEXIT_CODE: 0",
};

function peerResult(status: ReviewStatus, evidenceSources: string[]): PeerResult {
  return {
    peer: "claude",
    provider: "fixture-claude",
    model: "fixture-claude",
    raw_status: status,
    parsed_status: status,
    normalized_status: status,
    status,
    structured: {
      status,
      summary:
        status === "NOT_READY"
          ? "A factual blocking defect exists at src/index.ts:10."
          : "Additional evidence is required.",
      confidence: "verified",
      evidence_sources: evidenceSources,
      caller_requests:
        status === "NEEDS_EVIDENCE" ? ["Provide the cited raw source material."] : [],
      follow_ups: [],
    },
    text: "",
    raw: {},
    latency_ms: 0,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  };
}

function groundingInput() {
  return {
    artifactText: "Implementation candidate under review.",
    attachedEvidenceText: "",
    attachmentRefs: [ATTACHMENT.relative_path],
    evidenceAttachments: [
      {
        relative_path: ATTACHMENT.relative_path,
        sha256: ATTACHMENT.sha256,
      },
    ],
    callerSubmittedAttachments: [ATTACHMENT],
    requirePeerSubmittedCorroboration: false,
    runtimeFacts: RUNTIME_FACTS,
  } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
}

const regressions: Regression[] = [
  {
    name: "a factual NOT_READY without evidence cannot remain clean or definitive",
    run: () => {
      const grounding = groundReadyPeerEvidence(peerResult("NOT_READY", []), groundingInput());

      assert.equal(
        grounding.result.status,
        "NEEDS_EVIDENCE",
        "an ungrounded factual blocker must become an evidence request, not a definitive rejection",
      );
      assert.equal(grounding.grounded, false);
      assert.notEqual(
        grounding.result.decision_quality,
        "clean",
        "an ungrounded blocker must remain visibly non-clean",
      );
      assert.ok(
        grounding.result.parser_warnings.length > 0,
        "the normalization reason must be durable and auditable",
      );
    },
  },
  {
    name: "NEEDS_EVIDENCE with a fabricated SHA-256 is visibly non-clean",
    run: () => {
      const fabricatedSha = "f".repeat(64);
      const source = [
        `Attachment: ${ATTACHMENT.relative_path}`,
        `sha256=${fabricatedSha}`,
        'Artifact quote: "EXIT_CODE: 0"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(
        peerResult("NEEDS_EVIDENCE", [source]),
        groundingInput(),
      );

      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.equal(
        grounding.grounded,
        false,
        "a fabricated attachment digest must never be reported as grounded",
      );
      assert.notEqual(
        grounding.result.decision_quality,
        "clean",
        "fabricated evidence on an evidence request must remain visibly non-clean",
      );
      assert.ok(
        grounding.result.parser_warnings.length > 0,
        "the fabricated or ungrounded citation must produce an auditable warning",
      );
      assert.ok(
        grounding.source_diagnostics.some((diagnostic) => !diagnostic.supported),
        "the mismatched attachment digest must be identified as unsupported",
      );
    },
  },
  {
    name: "a factual NOT_READY must correlate its blocker with the cited source",
    run: () => {
      const source = [
        `Attachment: ${ATTACHMENT.relative_path}`,
        `sha256=${ATTACHMENT.sha256}`,
        'Artifact quote: "src/index.ts:10: return verifiedValue;"',
      ].join("\n");
      const blocker = peerResult("NOT_READY", [source]);
      blocker.structured = {
        status: "NOT_READY",
        summary: "A SQL injection defect blocks release at db.ts:99.",
        confidence: "verified",
        evidence_sources: [source],
        caller_requests: [],
        follow_ups: [],
      };
      const grounding = groundReadyPeerEvidence(blocker, groundingInput());

      assert.equal(
        grounding.result.status,
        "NEEDS_EVIDENCE",
        "an authentic but irrelevant quote cannot support a factual blocking verdict",
      );
      assert.equal(grounding.grounded, false);
      assert.ok(
        grounding.failed_predicates.includes("blocking_claims_correlated_to_sources"),
        "the durable diagnostics must identify missing blocker-to-source correlation",
      );
    },
  },
  {
    name: "Service Bindings narrative is not a service-health claim",
    run: () => {
      const bindingNarrative = truthfulnessPreflight({
        task: "Review the regression-risk note.",
        initialDraft:
          "F MEDIUM regression risk — caminho ativo Pages->Workers usa Service Bindings.",
        structuredEvidence:
          'wrangler.jsonc:12: "services": [{ "binding": "API", "service": "astrologo-api" }]',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(
        bindingNarrative.pass,
        true,
        "describing an active code path that uses Service Bindings must not assert service health",
      );
      assert.ok(
        !bindingNarrative.issue_classes.includes("unsupported_current_state_claim"),
        "Service Bindings must not trigger the generic service-state detector",
      );

      const realServiceState = truthfulnessPreflight({
        task: "Review the operational status.",
        initialDraft: "The current service is healthy.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(
        realServiceState.pass,
        false,
        "a real service-health assertion without raw status evidence must remain blocked",
      );
      assert.ok(realServiceState.issue_classes.includes("unsupported_current_state_claim"));
    },
  },
  {
    name: "the shared session contract requires neither MD5 nor human finalization",
    run: () => {
      const source = readFileSync(new URL("../src/core/orchestrator.ts", import.meta.url), "utf8");
      const contractMatch = source.match(
        /function sessionContractDirectives\(\): string\[\] \{[\s\S]*?\n\}\n\nfunction normalizeReviewFocus/,
      );
      assert.ok(contractMatch, "sessionContractDirectives source block must remain discoverable");
      const contract = contractMatch[0];
      const forbiddenRequirements = [
        /\bMD5\b/i.test(contract) ? "MD5" : undefined,
        /\bhuman operator\b/i.test(contract) ? "human operator" : undefined,
        /\boperator console\b/i.test(contract) ? "operator console" : undefined,
        /\bescalate_to_operator\b/i.test(contract) ? "escalate_to_operator" : undefined,
      ].filter((value): value is string => value !== undefined);

      assert.deepEqual(
        forbiddenRequirements,
        [],
        "the shared contract must neither require MD5 nor delegate normal finalization to a human/operator path",
      );
    },
  },
];

const failures: Array<{ name: string; error: unknown }> = [];

for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[GREEN] ${regression.name}`);
  } catch (error) {
    failures.push({ name: regression.name, error });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[RED] ${regression.name}`);
    console.error(`      ${message.replace(/\s+/g, " ").trim()}`);
  }
}

console.log(
  `[v4.5.18-grounding-contract-regression] ${regressions.length - failures.length}/${regressions.length} GREEN; ${failures.length}/${regressions.length} RED`,
);

if (failures.length > 0) process.exitCode = 1;
