import assert from "node:assert/strict";

import {
  evidencePreflight,
  groundReadyPeerEvidence,
  peerAuthoredEvidenceChecklistAsks,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import { parsePeerStatus, statusJsonSchema } from "../src/core/status.js";
import type { PeerId, PeerResult } from "../src/core/types.js";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

type EvidenceAttachment = {
  relative_path: string;
  sha256: string;
  content: string;
};

const RUNTIME_FACTS = {
  runtime_version: "4.5.3",
  release_date: "2026-07-11",
  model_pins: {
    gemini: "gemini-3.1-pro-preview",
  },
} as const;

const EVIDENCE_PATH = "evidence/caller-submitted-test-output.txt";
const EVIDENCE_SHA = "7b7ff5b959d17e07f20d5b3a481a3f320624af987cd38a1d3df3d8635c8f8a31";
const EVIDENCE_CONTENT = ["COMMAND: npm test", "EXIT_CODE: 0", "Tests 74 passed (74)"].join("\n");

function readyPeer(
  evidenceSources: string[],
  peer: PeerId = "claude",
  lineage: Record<string, unknown> = {},
): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    status: "READY",
    structured: {
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: evidenceSources,
      caller_requests: [],
      follow_ups: [],
    },
    text: "",
    raw: {},
    latency_ms: 0,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
    ...lineage,
  } as PeerResult;
}

function citation(attachment: EvidenceAttachment, quote: string): string {
  return [
    `Attachment: ${attachment.relative_path}`,
    `sha256=${attachment.sha256}`,
    `Artifact quote: "${quote}"`,
  ].join("\n");
}

function groundingInput(
  artifactText: string,
  attachments: EvidenceAttachment[] = [
    {
      relative_path: EVIDENCE_PATH,
      sha256: EVIDENCE_SHA,
      content: EVIDENCE_CONTENT,
    },
  ],
) {
  return {
    artifactText,
    attachedEvidenceText: "",
    attachmentRefs: attachments.map((attachment) => attachment.relative_path),
    evidenceAttachments: attachments.map(({ relative_path, sha256 }) => ({
      relative_path,
      sha256,
    })),
    callerSubmittedAttachments: attachments,
    requirePeerSubmittedCorroboration: true,
    runtimeFacts: RUNTIME_FACTS,
  } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
}

const defaultAttachment: EvidenceAttachment = {
  relative_path: EVIDENCE_PATH,
  sha256: EVIDENCE_SHA,
  content: EVIDENCE_CONTENT,
};

const regressions: Regression[] = [
  {
    name: "grounding demotion keeps server remediation out of the peer evidence checklist",
    run: () => {
      const grounding = groundReadyPeerEvidence(
        readyPeer([], "claude", {
          raw_status: "READY",
          parsed_status: "READY",
          normalized_status: "READY",
        }),
        groundingInput("Implementation candidate under review.", []),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(grounding.result.parser_warnings.includes("ready_evidence_sources_missing"));
      assert.deepEqual(
        grounding.result.structured?.caller_requests,
        [],
        "server-authored remediation must not masquerade as a durable peer evidence ask",
      );
      assert.equal(
        grounding.result.decision_transformations?.at(-1)?.details?.remediation,
        "Cite evidence verbatim from the reviewed artifact, authenticated caller submission, or operator-verified attachments; invented or untraceable sources cannot support READY.",
        "the remediation must remain auditable on the server-side decision transformation",
      );
      assert.deepEqual(
        peerAuthoredEvidenceChecklistAsks([grounding.result]),
        [],
        "a server-demoted READY must never enter the durable evidence checklist",
      );

      const genuineAsk = "Provide raw npm test output with EXIT_CODE: 0.";
      const explicitNeedsEvidence: PeerResult = {
        ...readyPeer([], "gemini", {
          raw_status: "NEEDS_EVIDENCE",
          parsed_status: "NEEDS_EVIDENCE",
          normalized_status: "NEEDS_EVIDENCE",
        }),
        status: "NEEDS_EVIDENCE",
        structured: {
          status: "NEEDS_EVIDENCE",
          summary: "Raw test output is required.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: [genuineAsk],
          follow_ups: [],
        },
      };
      assert.deepEqual(
        peerAuthoredEvidenceChecklistAsks([explicitNeedsEvidence]),
        [{ peer: "gemini", ask: genuineAsk }],
        "a genuine NEEDS_EVIDENCE request must remain durable and blocking",
      );

      const parserRewrittenReady: PeerResult = {
        ...explicitNeedsEvidence,
        raw_status: "READY",
        parsed_status: "NEEDS_EVIDENCE",
      };
      assert.deepEqual(
        peerAuthoredEvidenceChecklistAsks([parserRewrittenReady]),
        [],
        "raw provider intent takes precedence over any later parser rewrite",
      );
    },
  },
  {
    name: "two individually valid evidence sources remain grounded as a set",
    run: () => {
      const sources = [
        citation(defaultAttachment, "COMMAND: npm test"),
        citation(defaultAttachment, "Tests 74 passed (74)"),
      ];
      const grounding = groundReadyPeerEvidence(
        readyPeer(sources),
        groundingInput("The completed implementation reports npm test with 74 passed."),
      );

      assert.deepEqual(
        {
          status: grounding.result.status,
          grounded: grounding.grounded,
          unsupported_sources: grounding.unsupported_sources,
          fabricated: grounding.fabrication.fabricated,
          corroborated: grounding.peer_submitted_evidence_corroborated,
        },
        {
          status: "READY",
          grounded: true,
          unsupported_sources: [],
          fabricated: false,
          corroborated: true,
        },
        "valid sources must be validated independently, never reparsed as one joined citation",
      );
    },
  },
  {
    name: "one valid source plus one invented source remains blocked",
    run: () => {
      const invented = citation(defaultAttachment, "Tests 999 passed (999)");
      const grounding = groundReadyPeerEvidence(
        readyPeer([citation(defaultAttachment, "Tests 74 passed (74)"), invented]),
        groundingInput("The completed implementation reports npm test with 74 passed."),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(
        grounding.unsupported_sources.includes(invented) || grounding.fabrication.fabricated,
        "the invented source must remain observable as unsupported or fabricated",
      );
    },
  },
  {
    name: "a digest for attachment A cannot ground a literal that exists only in attachment B",
    run: () => {
      const attachmentA: EvidenceAttachment = {
        relative_path: "evidence/run-a.txt",
        sha256: "a".repeat(64),
        content: "COMMAND: npm test\nEXIT_CODE: 0\nTests 73 passed (73)",
      };
      const attachmentB: EvidenceAttachment = {
        relative_path: "evidence/run-b.txt",
        sha256: "b".repeat(64),
        content: EVIDENCE_CONTENT,
      };
      const mismatchedCitation = citation(attachmentA, "Tests 74 passed (74)");
      const grounding = groundReadyPeerEvidence(
        readyPeer([mismatchedCitation]),
        groundingInput("The completed implementation reports npm test with 74 passed.", [
          attachmentA,
          attachmentB,
        ]),
      );

      assert.equal(
        grounding.grounded,
        false,
        "path, digest and literal must correlate within the same attachment, not a joined corpus",
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(grounding.unsupported_sources.includes(mismatchedCitation));
    },
  },
  {
    name: "an imperative mentioning production is not a current-state claim",
    run: () => {
      const grounding = groundReadyPeerEvidence(
        readyPeer([citation(defaultAttachment, "Tests 74 passed (74)")]),
        groundingInput(
          [
            "Inspect the production wiring and regression tests.",
            "The completed implementation reports npm test with 74 passed.",
          ].join("\n"),
        ),
      );

      assert.equal(grounding.grounded, true);
      assert.equal(grounding.result.status, "READY");
      assert.equal(grounding.peer_submitted_evidence_corroborated, true);
    },
  },
  {
    name: "a real unsupported production-state claim remains blocked",
    run: () => {
      const preflight = truthfulnessPreflight({
        task: "Review the operational report.",
        initialDraft: "The current production deployment is healthy and green.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, false);
      assert.ok(preflight.issue_classes.includes("unsupported_current_state_claim"));
    },
  },
  {
    name: "a reviewed-product version does not contradict the cross-review runtime",
    run: () => {
      const preflight = truthfulnessPreflight({
        task: "Review release metadata.",
        initialDraft: "The current astrologo-app release is v2.20.0.",
        structuredEvidence: "package.json: version=2.20.0",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, true);
      assert.ok(!preflight.issue_classes.includes("runtime_contradiction"));
      assert.deepEqual(preflight.contradictions, []);
    },
  },
  {
    name: "a reviewed-product workflow-start version is not cross-review runtime history",
    run: () => {
      const preflight = truthfulnessPreflight({
        task: "Review the astrologo-app release evidence.",
        initialDraft: "When the workflow began, astrologo-app was at v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, true);
      assert.equal(preflight.historical_state_claim_matched, false);
      assert.ok(!preflight.issue_classes.includes("unsupported_historical_claim"));

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the cross-review runtime at workflow start.",
        initialDraft: "When the workflow began, cross-review was at v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "an English product-version noun phrase stays outside runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Review the astrologo-app release evidence.",
        initialDraft: "When the workflow began, astrologo-app version was v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the cross-review runtime at workflow start.",
        initialDraft: "When the workflow began, cross-review version was v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "a Portuguese product-version noun phrase stays outside runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Revise a evidência de release do astrologo-app.",
        initialDraft: "Quando o workflow começou, a versão do astrologo-app era v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime do cross-review no início do workflow.",
        initialDraft: "Quando o workflow começou, a versão do cross-review era v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "reviewed application history is not local runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Review release evidence.",
        initialDraft: "When the workflow began, the reviewed application version was v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the local runtime.",
        initialDraft: "When the workflow began, the cross-review runtime version was v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "reviewed package history is not local runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Review release evidence.",
        initialDraft: "At workflow start, the reviewed package was at version v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the local runtime.",
        initialDraft: "At workflow start, the cross-review runtime was at version v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "Portuguese reviewed application history is not local runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Revise a evidência de release.",
        initialDraft: "Quando o workflow começou, a versão da aplicação revisada era v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime local.",
        initialDraft:
          "Quando o workflow começou, a versão do runtime local do cross-review era v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "Portuguese reviewed product state is not local runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Revise a evidência de release do astrologo-app.",
        initialDraft: "No início do workflow, o astrologo-app estava na versão v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime local.",
        initialDraft: "No início do workflow, o runtime do cross-review estava na versão v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "an attributed Google GA/stable/production quote is not local operational state",
    run: () => {
      const quote = "generally available (GA), stable, and ready for scaled production use";
      const preflight = truthfulnessPreflight({
        task: "Review the provider migration rationale.",
        initialDraft: `Google documentation says: “${quote}.”`,
        structuredEvidence: `Provider documentation quote: ${quote}.`,
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, true);
      assert.ok(!preflight.issue_classes.includes("unsupported_current_state_claim"));
      assert.deepEqual(preflight.unsupported_claims, []);
    },
  },
  {
    name: "a database migration start date is not cross-review runtime history",
    run: () => {
      const preflight = truthfulnessPreflight({
        task: "Review the database migration note.",
        initialDraft: "The database migration started on 2026-07-10.",
        structuredEvidence: "database_migration_started_at=2026-07-10",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, true);
      assert.equal(preflight.historical_state_claim_matched, false);
      assert.ok(!preflight.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  {
    name: "a contradictory current cross-review runtime claim remains blocked",
    run: () => {
      const preflight = truthfulnessPreflight({
        task: "Audit the currently loaded cross-review runtime.",
        initialDraft: "The current cross-review runtime is v4.5.2.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, false);
      assert.ok(preflight.issue_classes.includes("runtime_contradiction"));
      assert.ok(preflight.contradictions.some((item) => item.includes("4.5.2")));
    },
  },
  {
    name: "provider JSON Schema exposes the same limits enforced by Zod",
    run: () => {
      const schema = statusJsonSchema as unknown as {
        properties: Record<
          string,
          {
            maxLength?: number;
            maxItems?: number;
            items?: { maxLength?: number };
          }
        >;
      };

      assert.deepEqual(
        {
          summary_max_length: schema.properties.summary?.maxLength,
          evidence_max_items: schema.properties.evidence_sources?.maxItems,
          evidence_item_max_length: schema.properties.evidence_sources?.items?.maxLength,
          requests_max_items: schema.properties.caller_requests?.maxItems,
          request_item_max_length: schema.properties.caller_requests?.items?.maxLength,
          follow_ups_max_items: schema.properties.follow_ups?.maxItems,
          follow_up_item_max_length: schema.properties.follow_ups?.items?.maxLength,
        },
        {
          summary_max_length: 800,
          evidence_max_items: 30,
          evidence_item_max_length: 2500,
          requests_max_items: 30,
          request_item_max_length: 1500,
          follow_ups_max_items: 30,
          follow_up_item_max_length: 1500,
        },
      );
    },
  },
  {
    name: "raw parsed and normalized status plus grounding transformation remain observable",
    run: () => {
      const rawText = JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "verified",
        evidence_sources: ['Artifact quote: "invented literal with enough characters"'],
        caller_requests: [],
        follow_ups: [],
      });
      const parsed = parsePeerStatus(rawText) as ReturnType<typeof parsePeerStatus> &
        Record<string, unknown>;
      assert.equal(parsed.status, "READY", "fixture must reach the grounding stage as READY");

      const lineage = {
        raw_status: parsed.raw_status,
        parsed_status: parsed.parsed_status,
        normalized_status: parsed.normalized_status,
        status_transformations: parsed.status_transformations,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer(parsed.structured?.evidence_sources ?? [], "claude", lineage),
        {
          artifactText: "Review this static implementation candidate.",
          attachedEvidenceText: "",
          attachmentRefs: [],
          runtimeFacts: RUNTIME_FACTS,
        },
      );
      const observable = grounding.result as PeerResult & Record<string, unknown>;
      const transformations = observable.status_transformations;

      assert.deepEqual(
        {
          raw_status: observable.raw_status,
          parsed_status: observable.parsed_status,
          normalized_status: observable.normalized_status,
        },
        {
          raw_status: "READY",
          parsed_status: "READY",
          normalized_status: "NEEDS_EVIDENCE",
        },
      );
      assert.ok(Array.isArray(transformations), "status_transformations must be persisted");
      assert.ok(
        transformations.some((entry: unknown) => {
          if (!entry || typeof entry !== "object") return false;
          const item = entry as Record<string, unknown>;
          return (
            item.stage === "grounding" &&
            item.from === "READY" &&
            item.to === "NEEDS_EVIDENCE" &&
            typeof item.rule === "string"
          );
        }),
        "grounding must append the exact READY-to-NEEDS_EVIDENCE transformation rule",
      );
    },
  },
  {
    name: "an inline minified JSON document does not manufacture a CHANGELOG attachment",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the release workflow metadata.",
        structuredEvidence: JSON.stringify({
          step: "Extract release notes from CHANGELOG.md",
          upload: { artifact: "dist" },
        }),
        caller: "codex",
        attachmentsPresent: false,
      });

      assert.equal(preflight.pass, true);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "a genuine reference to missing.log remains blocked",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the release audit.",
        initialDraft: "The literal evidence is in missing.log.",
        caller: "codex",
        attachmentsPresent: false,
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["missing.log"]);
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
  `[v4.5.4-grounding-regression] ${regressions.length - failures.length}/${regressions.length} GREEN; ${failures.length}/${regressions.length} RED`,
);

if (failures.length > 0) process.exitCode = 1;
