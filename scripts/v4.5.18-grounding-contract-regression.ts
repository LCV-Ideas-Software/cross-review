import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDecisionRetryPrompt,
  groundReadyPeerEvidence,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
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

// CROSREV-32 (GitHub #268): a gh-style single-line JSON attachment. The first
// check name deliberately carries a lexicon word (`Run`), so at least one
// GitHub URL in the attachment sits inside an instructional-looking clause
// and would be dropped from the corpus by the assertive filter; that is what
// pins the structural fix. Identifier-class tokens present in the corpus are
// proof of existence regardless of the surrounding prose.
const CHECKS_REPOSITORY_URL = "https://github.com/example-org/example-repo";
const CHECK_NAMES = [
  "Run tests",
  "Lint",
  "Typecheck",
  "Build",
  "Format",
  "Biome",
  "Smoke",
  "Pack",
  "CodeQL",
  "Scorecard",
  "Zizmor",
  "Dependency review",
  "Docs",
];
const CHECK_DETAILS_URLS = CHECK_NAMES.map(
  (_, index) => `${CHECKS_REPOSITORY_URL}/actions/runs/1000000001/job/${2000000001 + index}`,
);
const CHECKS_ATTACHMENT = {
  relative_path: "evidence/pr-checks.json",
  sha256: "0123456789abcdef".repeat(4),
  content: JSON.stringify({
    statusCheckRollup: CHECK_NAMES.map((name, index) => ({
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: CHECK_DETAILS_URLS[index],
    })),
  }),
};

// The provider serialized the peer's JSON once more, so the persisted source
// string keeps `\"` around the quoted fragment.
function escapedChecksCitation(detailsUrl: string): string {
  return [
    `Attachment: ${CHECKS_ATTACHMENT.relative_path}`,
    `sha256=${CHECKS_ATTACHMENT.sha256}`,
    `Artifact quote: "\\"detailsUrl\\":\\"${detailsUrl}\\""`,
  ].join("\n");
}

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

function checksGroundingInput() {
  return {
    ...groundingInput(),
    attachmentRefs: [CHECKS_ATTACHMENT.relative_path],
    evidenceAttachments: [
      { relative_path: CHECKS_ATTACHMENT.relative_path, sha256: CHECKS_ATTACHMENT.sha256 },
    ],
    callerSubmittedAttachments: [CHECKS_ATTACHMENT],
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
    name: "server-issued checklist ids repeated by a peer are not fabricated evidence",
    run: () => {
      const checklistIds = ["8197001b4386e9bb", "b6671ea0b3a1b864", "4407b8766d1d4101"];
      const sources = checklistIds.map((id) =>
        [
          `Checklist-Item: ${id}`,
          `Attachment: ${ATTACHMENT.relative_path}`,
          `sha256=${ATTACHMENT.sha256}`,
          'Artifact quote: "src/index.ts:10: return verifiedValue;"',
        ].join("\n"),
      );
      const knownChecklistGrounding = groundReadyPeerEvidence(peerResult("READY", sources), {
        ...groundingInput(),
        evidenceChecklistItemIds: checklistIds,
      });

      assert.equal(
        knownChecklistGrounding.fabrication.fabricated,
        false,
        "identifiers issued by the server in the round prompt must be part of the provenance corpus",
      );
      assert.equal(
        knownChecklistGrounding.result.status,
        "READY",
        "a verified READY with three grounded checklist citations must remain definitive",
      );

      const unknownChecklistGrounding = groundReadyPeerEvidence(
        peerResult("READY", sources),
        groundingInput(),
      );
      assert.equal(
        unknownChecklistGrounding.fabrication.fabricated,
        true,
        "unrecognized checklist-like hex identifiers must remain subject to fabrication detection",
      );
      assert.equal(unknownChecklistGrounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "GitHub URLs quoted from the attachment in provider-escaped form are not fabricated evidence",
    run: () => {
      assert.ok(
        CHECK_DETAILS_URLS.length >= 13,
        "the fixture mirrors the session shape: at least 13 correlated GitHub URLs",
      );
      const sources = CHECK_DETAILS_URLS.map(escapedChecksCitation);
      const grounding = groundReadyPeerEvidence(
        peerResult("READY", sources),
        checksGroundingInput(),
      );

      assert.equal(
        grounding.fabrication.suspicious_assertion_count,
        0,
        `a GitHub URL present in the attachment bytes is not a suspicious assertion, even when the provider escaped the quote and the attachment clause carries a lexicon word (sample=${JSON.stringify(
          grounding.fabrication.suspicious_assertion_sample,
        )})`,
      );
      assert.equal(
        grounding.fabrication.fabricated,
        false,
        "correlated identifier-class sources must not trip the fabrication detector",
      );
      assert.deepEqual(grounding.unsupported_sources, []);
      assert.equal(grounding.source_diagnostics.length, CHECK_DETAILS_URLS.length);
      assert.ok(
        grounding.source_diagnostics.every(
          (diagnostic) =>
            diagnostic.supported &&
            diagnostic.attachment_custody_claimed &&
            diagnostic.correlated_attachment === CHECKS_ATTACHMENT.relative_path,
        ),
        "every source must be supported and correlated to the same attachment",
      );
      assert.equal(
        grounding.result.status,
        "READY",
        "a READY vote whose every source is correlated to the active attachment must remain definitive",
      );
    },
  },
  {
    name: "a GitHub URL absent from the corpus still downgrades a READY vote as fabricated",
    run: () => {
      const inventedUrl = `${CHECKS_REPOSITORY_URL}/actions/runs/1000000001/job/2000009999`;
      const grounding = groundReadyPeerEvidence(
        peerResult("READY", [escapedChecksCitation(inventedUrl)]),
        checksGroundingInput(),
      );

      assert.equal(
        grounding.fabrication.fabricated,
        true,
        "a GitHub URL that no corpus tier contains remains a fabricated source",
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(
        grounding.result.parser_warnings.includes("ready_evidence_sources_fabricated"),
        "the downgrade must carry the fabricated-sources rule",
      );
      assert.ok(
        (grounding.result.decision_transformations ?? []).some(
          (transformation) => transformation.rule === "ready_evidence_sources_fabricated",
        ),
        "the decision transformation must record ready_evidence_sources_fabricated",
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
    name: "aggregate caller-evidence failures identify the exact unsupported artifact claim",
    run: () => {
      const source = [
        `Attachment: ${ATTACHMENT.relative_path}`,
        `sha256=${ATTACHMENT.sha256}`,
        'Artifact quote: "src/index.ts:10: return verifiedValue;"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(peerResult("READY", [source]), {
        ...groundingInput(),
        artifactText: "Implementation candidate under review. Tests 9 passed, 0 failed.",
        callerSubmittedAttachments: [
          {
            ...ATTACHMENT,
            content: `${ATTACHMENT.content}\nTests 9 passed, 0 failed.`,
          },
        ],
        requirePeerSubmittedCorroboration: true,
      });

      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.deepEqual(grounding.failed_claim_diagnostics, [
        {
          corpus: "peer_sources",
          claim_type: "operational_assertion",
          index: 0,
          claim_excerpt: "9 passed",
        },
        {
          corpus: "peer_sources",
          claim_type: "operational_assertion",
          index: 1,
          claim_excerpt: "0 failed",
        },
      ]);
      const transformation = grounding.result.decision_transformations?.at(-1);
      assert.deepEqual(
        (transformation?.details as { failed_claim_diagnostics?: unknown })
          ?.failed_claim_diagnostics,
        grounding.failed_claim_diagnostics,
        "claim-level diagnostics must be persisted with the status transformation",
      );
    },
  },
  {
    name: "full decision retry preserves the active caller evidence snapshot",
    run: () => {
      const config = {
        prompt: {
          max_task_chars: 8_000,
          max_review_focus_chars: 2_000,
          max_history_chars: 20_000,
          max_draft_chars: 40_000,
          max_prior_rounds: 5,
          max_peer_requests: 8,
          max_attached_evidence_chars: 200_000,
        },
      } as Parameters<typeof buildDecisionRetryPrompt>[3];
      const attachment = {
        label: "caller-structured-evidence",
        relative_path: "evidence/caller-structured-evidence.txt",
        content: "PROOF_ACTIVE_ATTACHMENT: sha256 bytes survived recovery",
        bytes: 54,
        truncated: false,
        provenance_status: "verified" as const,
        authority_status: "caller_submitted_unverified" as const,
        sha256: "b".repeat(64),
        attached_by: "codex" as const,
      };
      const prompt = buildDecisionRetryPrompt(
        {
          task: "Review a rollout from raw evidence.",
          rounds: [],
          evidence_checklist: [
            {
              id: "ev-1",
              peer: "perplexity",
              first_round: 1,
              round_count: 1,
              status: "open",
              ask: "Show the raw SHA-256-backed log.",
            },
          ],
        } as unknown as Parameters<typeof buildDecisionRetryPrompt>[0],
        "The rollout is ready for closure.",
        "",
        config,
        undefined,
        [attachment],
      );

      assert.match(prompt, /## Peer-Submitted Evidence \(UNVERIFIED\)/);
      assert.ok(prompt.includes(attachment.relative_path));
      assert.match(prompt, /PROOF_ACTIVE_ATTACHMENT: sha256 bytes survived recovery/);
      assert.match(prompt, new RegExp(attachment.sha256));
      assert.match(prompt, /## Outstanding Evidence Asks/);
      assert.match(prompt, /Checklist-Item: ev-1/);
    },
  },
  {
    name: "literal JSON fragments remain groundable without artificial quote wrappers",
    run: () => {
      const jsonAttachment = {
        relative_path: "evidence/session-snapshot.txt",
        sha256: "e00bdc6d3f29e682e7e6586c09eba32ed57521d11d56404545939f95370e132e",
        content: [
          '"org":{"activeCount":11,"allMainVerified":true,"openPR":0}',
          '"process": {',
          '  "package_version": "1.2.10",',
          '  "bundle_matches_release_checkout": true',
          "}",
        ].join("\n"),
      };
      const sources = [
        [
          `Attachment: ${jsonAttachment.relative_path}`,
          `sha256=${jsonAttachment.sha256}`,
          'Artifact quote: "org":{"activeCount":11,"allMainVerified":true,"openPR":0}',
        ].join("\n"),
        [
          `Attachment: ${jsonAttachment.relative_path}`,
          `sha256=${jsonAttachment.sha256}`,
          [
            'Artifact quote: "package_version": "1.2.10",',
            '  "bundle_matches_release_checkout": true',
          ].join("\n"),
        ].join("\n"),
      ];

      const grounding = groundReadyPeerEvidence(peerResult("READY", sources), {
        ...groundingInput(),
        attachmentRefs: [jsonAttachment.relative_path],
        evidenceAttachments: [jsonAttachment],
        callerSubmittedAttachments: [jsonAttachment],
      });

      assert.equal(
        grounding.result.status,
        "READY",
        "byte-exact JSON fragments must not require an extra pair of artificial wrapper quotes",
      );
      assert.deepEqual(
        grounding.source_diagnostics.map((diagnostic) => diagnostic.supported),
        [true, true],
      );

      const inventedSuffix = groundReadyPeerEvidence(
        peerResult("READY", [`${sources[0]} INVENTED_SUFFIX`]),
        {
          ...groundingInput(),
          attachmentRefs: [jsonAttachment.relative_path],
          evidenceAttachments: [jsonAttachment],
          callerSubmittedAttachments: [jsonAttachment],
        },
      );
      assert.equal(
        inventedSuffix.result.status,
        "NEEDS_EVIDENCE",
        "a JSON-looking quote with invented bytes must remain fail-closed",
      );

      const wrongDigest = sources[0]?.replace(jsonAttachment.sha256, "f".repeat(64)) ?? "";
      const wrongCustody = groundReadyPeerEvidence(peerResult("READY", [wrongDigest]), {
        ...groundingInput(),
        attachmentRefs: [jsonAttachment.relative_path],
        evidenceAttachments: [jsonAttachment],
        callerSubmittedAttachments: [jsonAttachment],
      });
      assert.equal(
        wrongCustody.result.status,
        "NEEDS_EVIDENCE",
        "literal bytes with an incorrect digest must remain fail-closed",
      );

      const coalescedSource = [
        `Attachment: ${jsonAttachment.relative_path}`,
        `sha256=${jsonAttachment.sha256}`,
        'Artifact quote: "org":{"activeCount":11}, "package_version":"1.2.10"',
      ].join("\n");
      const mixedSources = groundReadyPeerEvidence(
        peerResult("READY", [sources[0] ?? "", coalescedSource]),
        {
          ...groundingInput(),
          attachmentRefs: [jsonAttachment.relative_path],
          evidenceAttachments: [jsonAttachment],
          callerSubmittedAttachments: [jsonAttachment],
        },
      );
      assert.equal(
        mixedSources.result.status,
        "NEEDS_EVIDENCE",
        "one valid source must not mask a second non-contiguous source",
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
