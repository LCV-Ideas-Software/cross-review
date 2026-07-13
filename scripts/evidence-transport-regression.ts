import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { checkConvergence } from "../src/core/convergence.js";
import {
  blockConvergenceForPeerSubmittedEvidencePanel,
  CrossReviewOrchestrator,
  evidencePreflight,
  groundReadyPeerEvidence,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import { sessionReportMarkdown } from "../src/core/reports.js";
import { extractChecklistCommands } from "../src/core/session-store.js";
import type { PeerAdapter, PeerId, PeerResult } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

// Regression coverage for the v4.5.0 evidence dead-end reported by a Codex
// caller. These cases intentionally describe the desired contract:
//
// 1. Authenticated peer-submitted raw evidence is transportable, but remains
//    explicitly UNVERIFIED (it is not promoted to operator-verified custody).
// 2. runUntilUnanimous.evidence reaches the actual reviewer prompt.
// 3. The public saved-session preflight checks the same evidence AND
//    truthfulness gates that a real round checks.
// 4. A terminal outcome produced by the internal askPeers call is preserved;
//    the outer loop cannot overwrite it with max-rounds.
// 5. Peer-submitted evidence can converge without operator custody only after
//    a genuinely independent, strictly grounded colegiado review.
//
// Keep this focused regression independent from the broader behavioral matrix
// so transport, combined-preflight and terminal-state failures stay obvious.

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

function regressionConfig(prefix: string) {
  const base = loadConfig();
  return {
    ...base,
    data_dir: fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-${prefix}-`)),
    // Keep the stub fixture independent from an operator's central config.
    // Production correctly fails closed when rate cards are absent, but these
    // regressions exercise evidence transport rather than financial controls.
    cost_rates: {
      codex: { input_per_million: 0, output_per_million: 0 },
      claude: { input_per_million: 0, output_per_million: 0 },
      gemini: { input_per_million: 0, output_per_million: 0 },
      deepseek: { input_per_million: 0, output_per_million: 0 },
      grok: { input_per_million: 0, output_per_million: 0 },
      perplexity: {
        input_per_million: 0,
        output_per_million: 0,
        request_fee_low_per_1000: 0,
        request_fee_medium_per_1000: 0,
        request_fee_high_per_1000: 0,
      },
    },
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const PEER_INLINE_SENTINEL = "PEER_INLINE_RAW_SENTINEL_4f52b7";
const STRUCTURED_SENTINEL = "RUN_UNTIL_EVIDENCE_SENTINEL_8c31da";
const RETRY_BAD_SNAPSHOT_SENTINEL = "RETRY_BAD_SNAPSHOT_7521be";
const RETRY_GOOD_SNAPSHOT_SENTINEL = "RETRY_GOOD_SNAPSHOT_0dd4f9";
const PRIOR_SUCCESS_SNAPSHOT_SENTINEL = "PRIOR_SUCCESS_SNAPSHOT_f9a37c";
const PANEL_EVIDENCE_PATH = "evidence/caller-submitted-tests.txt";
const PANEL_EVIDENCE_SHA = "7b7ff5b959d17e07f20d5b3a481a3f320624af987cd38a1d3df3d8635c8f8a31";
const PANEL_EVIDENCE_CONTENT = [
  "COMMAND: npm test",
  "EXIT_CODE: 0",
  "Test Files 13 passed (13)",
  "Tests 74 passed (74)",
  `sha256=${PANEL_EVIDENCE_SHA}`,
].join("\n");
const GENERATED_EVIDENCE_PATH =
  "evidence/2026-07-11T21-15-48-680Z-caller-structured-evidence-70d40191-c100-4144-9fbd-eca598d4af03.txt";
const GENERATED_EVIDENCE_SHA = "43009998c876789fa9a74e04363f3109a932883212ebeae1fb14cc9f5aa84285";
const GENERATED_EVIDENCE_CONTENT = 'STDOUT: package.json:3:  "version": "4.5.3",';
const GENERATED_DIFF_LINE = "diff --git a/CHANGELOG.md b/CHANGELOG.md";

function readyPeer(
  peer: PeerId,
  confidence: "verified" | "inferred",
  evidenceSources: string[],
): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    status: "READY",
    structured: {
      status: "READY",
      summary: "No blocking issue remains.",
      confidence,
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
  };
}

function peerSubmittedGroundingInput(artifactText: string) {
  return {
    artifactText: `${artifactText}\nThe completed implementation reports npm test with 74 passed.`,
    attachedEvidenceText: "",
    attachmentRefs: [PANEL_EVIDENCE_PATH],
    runtimeFacts: {},
    callerSubmittedAttachments: [
      {
        relative_path: PANEL_EVIDENCE_PATH,
        sha256: PANEL_EVIDENCE_SHA,
        content: PANEL_EVIDENCE_CONTENT,
      },
    ],
  } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
}

const regressions: Regression[] = [
  {
    name: "authenticated generated path, SHA-256, and literal quote are not fabricated evidence",
    run: () => {
      const source = [
        `Attachment: ${GENERATED_EVIDENCE_PATH}`,
        `sha256=${GENERATED_EVIDENCE_SHA}`,
        `"${GENERATED_EVIDENCE_CONTENT}"`,
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: "Release metadata candidate under review.",
        attachedEvidenceText: "",
        attachmentRefs: [GENERATED_EVIDENCE_PATH],
        callerSubmittedAttachments: [
          {
            relative_path: GENERATED_EVIDENCE_PATH,
            sha256: GENERATED_EVIDENCE_SHA,
            content: GENERATED_EVIDENCE_CONTENT,
          },
        ],
        runtimeFacts: { runtime_version: "4.5.2" },
      });

      assert.equal(
        grounding.grounded,
        true,
        "integrity metadata generated by cross-review belongs to the authenticated provenance corpus",
      );
      assert.equal(grounding.fabrication.fabricated, false);
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "source release version bump metadata is not a historical runtime timing claim",
    run: () => {
      const result = truthfulnessPreflight({
        task: "Review the release candidate.",
        initialDraft:
          "Release metadata and versioning are consistently bumped to v02.20.00 across CHANGELOG.md, README.md, SECURITY.md, package.json, package-lock.json, and APP_VERSION in App.tsx.",
        structuredEvidence: [
          'package.json:3: "version": "2.20.0"',
          'App.tsx:31: const APP_VERSION = "2.20.0";',
        ].join("\n"),
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.2" },
      });

      assert.equal(
        result.pass,
        true,
        "a product source-version bump must not require workflow-start runtime provenance",
      );
      assert.equal(result.historical_state_claim_matched, false);
      assert.deepEqual(result.issue_classes, []);
    },
  },
  {
    name: "explicit single-quoted artifact quote grounds a generated attachment citation",
    run: () => {
      const source =
        `Attachment: ${GENERATED_EVIDENCE_PATH}; sha256=${GENERATED_EVIDENCE_SHA}; ` +
        `Artifact quote: '${GENERATED_DIFF_LINE}'`;
      const grounding = groundReadyPeerEvidence(readyPeer("deepseek", "verified", [source]), {
        artifactText: "Release metadata candidate under review.",
        attachedEvidenceText: "",
        attachmentRefs: [GENERATED_EVIDENCE_PATH],
        callerSubmittedAttachments: [
          {
            relative_path: GENERATED_EVIDENCE_PATH,
            sha256: GENERATED_EVIDENCE_SHA,
            content: GENERATED_DIFF_LINE,
          },
        ],
        runtimeFacts: { runtime_version: "4.5.2" },
      });

      assert.equal(
        grounding.grounded,
        true,
        "Artifact quote: '...' is a valid paired literal citation, not ungrounded prose",
      );
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "explicit artifact quote may contain inner quotes and line breaks",
    run: () => {
      const literal = [
        "export interface ResolvedEvidenceAttachment {",
        "  label: string;",
        '  authority_status: "operator_verified" | "caller_submitted_unverified";',
        "}",
      ].join("\n");
      const source = `Artifact quote: "${literal}"`;
      const grounding = groundReadyPeerEvidence(readyPeer("gemini", "verified", [source]), {
        artifactText: literal,
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });

      assert.equal(grounding.grounded, true);
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "explicit artifact quote rejects a true prefix with an invented suffix",
    run: () => {
      const literal = 'const actualSha256 = crypto.createHash("sha256").update(persisted);';
      const source = `Artifact quote: "${literal} invented suffix"`;
      const grounding = groundReadyPeerEvidence(readyPeer("grok", "verified", [source]), {
        artifactText: literal,
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });

      assert.equal(
        grounding.grounded,
        false,
        "an explicit wrapper must be correlated as a whole, not by a truthful prefix",
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "altered generated-attachment digest remains rejected",
    run: () => {
      const operationalEvidence = [
        "COMMAND: npm test",
        "EXIT_CODE: 0",
        "Tests 74 passed (74)",
      ].join("\n");
      const alteredSha = `5${GENERATED_EVIDENCE_SHA.slice(1)}`;
      const source = [
        `Attachment: ${GENERATED_EVIDENCE_PATH}`,
        `sha256=${alteredSha}`,
        'Artifact quote: "Tests 74 passed (74)"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: "The completed implementation reports npm test with 74 passed.",
        attachedEvidenceText: "",
        attachmentRefs: [GENERATED_EVIDENCE_PATH],
        evidenceAttachments: [
          {
            relative_path: GENERATED_EVIDENCE_PATH,
            sha256: GENERATED_EVIDENCE_SHA,
          },
        ],
        callerSubmittedAttachments: [
          {
            relative_path: GENERATED_EVIDENCE_PATH,
            sha256: GENERATED_EVIDENCE_SHA,
            content: operationalEvidence,
          },
        ],
        requirePeerSubmittedCorroboration: true,
        runtimeFacts: { runtime_version: "4.5.2" },
      });

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "ordinary apostrophes are not parsed as artifact quotes",
    run: () => {
      const source = "The reviewer's observation isn't accepted.";
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: "s observation isn",
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "peer inline raw evidence is admitted as peer-submitted/unverified and reaches a stub round",
    run: async () => {
      const task = "Review the completed implementation. The test suite reports 74 passed.";
      const draft = [
        "Implementation candidate for review.",
        "",
        "## Raw evidence supplied by the authenticated Codex caller",
        "```text",
        PEER_INLINE_SENTINEL,
        "$ npm test",
        "Test Files 13 passed (13)",
        "Tests 74 passed (74)",
        "EXIT_CODE: 0",
        "```",
      ].join("\n");

      const purePreflight = evidencePreflight({
        task,
        initialDraft: draft,
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.equal(
        purePreflight.pass,
        true,
        "authenticated peer raw output must pass transport admission without becoming operator-verified evidence",
      );

      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("peer-inline"), (event) =>
        events.push(event.type),
      );
      const result = await orchestrator.askPeers({
        task,
        draft,
        caller: "codex",
        peers: ["claude"],
      });

      assert.equal(
        result.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
        false,
        "peer-submitted raw evidence must not be discarded by the round evidence gate",
      );
      assert.equal(result.round.peers.length, 1, "the reviewer stub must receive the round");
      assert.equal(
        events.includes("peer.call.started"),
        true,
        "admitted peer evidence must reach an actual reviewer call",
      );

      const promptPath = path.join(
        orchestrator.store.sessionDir(result.session.session_id),
        result.round.prompt_file,
      );
      const prompt = fs.readFileSync(promptPath, "utf8");
      assert.match(prompt, new RegExp(PEER_INLINE_SENTINEL));
      assert.match(
        prompt,
        /peer[- ]submitted[\s\S]{0,80}unverified|unverified[\s\S]{0,80}peer[- ]submitted/i,
        "reviewer prompt must distinguish peer-submitted evidence from operator-verified custody",
      );
    },
  },
  {
    name: "one independent voter cannot converge peer-submitted operational evidence",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("single-voter-panel"));
      const result = await orchestrator.askPeers({
        task: "Review completed implementation: npm test reports 74 passed.",
        draft: PANEL_EVIDENCE_CONTENT,
        caller: "codex",
        peers: ["claude"],
      });

      assert.equal(
        result.converged,
        false,
        "peer-submitted operational evidence requires at least two independent voting reviewers",
      );
      assert.match(
        result.round.convergence.reason,
        /peer.submitted|independent.*panel|colegiado/i,
        "the convergence record must expose the independent-panel blocker",
      );
    },
  },
  {
    name: "one voter cannot converge peer-submitted workflow self-attestation",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("workflow-panel"));
      const result = await orchestrator.askPeers({
        task: "I triggered the deployment and confirmed the remote deployment succeeded.",
        draft: "Deployment closure report.",
        evidence:
          "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
        caller: "codex",
        peers: ["claude"],
      });

      assert.equal(result.converged, false);
      assert.match(result.round.convergence.reason, /peer.submitted.*independent.*panel/i);
    },
  },
  {
    name: "READY inferred cannot corroborate peer-submitted operational evidence",
    run: () => {
      const source = [
        `Attachment: ${PANEL_EVIDENCE_PATH}`,
        `sha256=${PANEL_EVIDENCE_SHA}`,
        '"Tests 74 passed (74)"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(
        readyPeer("claude", "inferred", [source]),
        peerSubmittedGroundingInput("Implementation candidate under review."),
      );

      assert.equal(
        grounding.grounded,
        false,
        "an inferred vote is not independent verification of caller-submitted operational output",
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "narrative-only READY citation cannot corroborate peer-submitted operational evidence",
    run: () => {
      const narrative = "The caller says npm test passed with 74 tests.";
      const grounding = groundReadyPeerEvidence(
        readyPeer("claude", "verified", [narrative]),
        peerSubmittedGroundingInput(narrative),
      );

      assert.equal(
        grounding.grounded,
        false,
        "a verbatim narrative sentence is not a path/hash/raw-value citation",
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "requester reverification closes only value-correlated asks from that requester",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-item-correlation"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification item-correlation fixture.",
        "codex",
      );
      const testAsk = "Provide raw npm test output proving Tests 74 passed (74).";
      const rollbackAsk =
        "Provide the migration rollback log for deployment rollback_id=rollback-991.";
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask: testAsk },
        { peer: "claude", ask: rollbackAsk },
      ]);

      const promoted = await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
        session.session_id,
        {
          round: 2,
          peer: "claude",
          evidence_sources: [
            [
              `Attachment: ${PANEL_EVIDENCE_PATH}`,
              `sha256=${PANEL_EVIDENCE_SHA}`,
              '"COMMAND: npm test"',
              '"EXIT_CODE: 0"',
              '"Tests 74 passed (74)"',
            ].join("\n"),
          ],
        },
      );
      const byAsk = new Map(
        (orchestrator.store.read(session.session_id).evidence_checklist ?? []).map((item) => [
          item.ask,
          item,
        ]),
      );

      assert.deepEqual(
        promoted.map(({ item }) => item.ask),
        [testAsk],
        "requester_reverified must not bulk-close an unrelated ask merely because the same peer returned READY/verified",
      );
      assert.equal(byAsk.get(testAsk)?.status, "addressed");
      assert.equal(
        byAsk.get(rollbackAsk)?.status ?? "open",
        "open",
        "an ask whose requested value/domain is absent from evidence_sources must remain unresolved",
      );
    },
  },
  {
    name: "generic evidence remains available beside a source routed to another checklist item",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-mixed-routed-and-generic-sources"),
      );
      const session = await orchestrator.initSession(
        "Requester mixed-routing regression fixture.",
        "codex",
      );
      const testAsk = "Provide raw npm test output proving Tests 74 passed (74).";
      const rollbackAsk =
        "Provide the migration rollback log for deployment rollback_id=rollback-991.";
      const unrelatedAsk =
        "Provide the migration rollback log for deployment rollback_id=rollback-unrelated-451.";
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [
          { peer: "claude", ask: testAsk },
          { peer: "claude", ask: rollbackAsk },
          { peer: "claude", ask: unrelatedAsk },
        ],
      );
      const testItem = checklist.find((item) => item.ask === testAsk);
      assert.ok(testItem);

      const promoted = await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
        session.session_id,
        {
          round: 2,
          peer: "claude",
          evidence_sources: [
            [
              `Checklist-Item: ${testItem.id}`,
              `Attachment: ${PANEL_EVIDENCE_PATH}`,
              `sha256=${PANEL_EVIDENCE_SHA}`,
              'Artifact quote: "COMMAND: npm test | EXIT_CODE: 0 | Tests 74 passed (74)"',
            ].join("\n"),
            [
              `Attachment: ${PANEL_EVIDENCE_PATH}`,
              `sha256=${PANEL_EVIDENCE_SHA}`,
              'Artifact quote: "ROLLBACK_EXACT: rollback_id=rollback-991 | status: success | deployment rollback completed"',
            ].join("\n"),
          ],
        },
      );

      assert.deepEqual(
        promoted.map(({ item }) => item.ask),
        [testAsk, rollbackAsk],
        "an ID-routed source must not discard a separate generic source that answers another ask",
      );
      const byAsk = new Map(
        (orchestrator.store.read(session.session_id).evidence_checklist ?? []).map((item) => [
          item.ask,
          item,
        ]),
      );
      assert.equal(byAsk.get(unrelatedAsk)?.status ?? "open", "open");
    },
  },
  {
    name: "checklist references resurface their ancestor instead of creating recursive blockers",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("checklist-reference-deduplication"),
      );
      const session = await orchestrator.initSession(
        "Checklist reference deduplication fixture.",
        "codex",
      );
      const original = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "perplexity", ask: "Provide raw git diff --check output and exit code." }],
      );
      const item = original[0];
      assert.ok(item);

      const samePeer = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        2,
        [
          {
            peer: "perplexity",
            ask: `Checklist-Item: ${item.id} — The same request remains required.`,
          },
        ],
      );
      assert.equal(samePeer.length, 1);
      assert.equal(samePeer[0]?.id, item.id);
      assert.equal(samePeer[0]?.last_round, 2);
      assert.equal(samePeer[0]?.round_count, 2);

      const crossPeer = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        3,
        [
          {
            peer: "deepseek",
            ask: `Checklist-Item: ${item.id} — The same raw transcript remains required.`,
          },
          {
            peer: "perplexity",
            ask: `Checklist-Item: ${item.id} — The same request remains required, and also provide rollback_id=rollback-new-991.`,
          },
        ],
      );
      assert.equal(
        crossPeer.length,
        3,
        "cross-peer references and same-owner references with a new requirement must not be silently discarded",
      );
      assert.ok(crossPeer.some((entry) => entry.id !== item.id && entry.peer === "deepseek"));
      assert.ok(crossPeer.some((entry) => entry.ask.includes("rollback-new-991")));

      const legacyMeta = orchestrator.store.read(session.session_id);
      legacyMeta.evidence_checklist = [
        ...(legacyMeta.evidence_checklist ?? []),
        {
          id: "feedfacefeedface",
          peer: "perplexity",
          first_round: 4,
          last_round: 4,
          round_count: 1,
          ask: `Checklist-Item: ${item.id} — The same request remains required.`,
          first_seen_at: "2026-07-13T00:00:00.000Z",
          last_seen_at: "2026-07-13T00:00:00.000Z",
          status: "not_resurfaced",
        },
        {
          id: "cafebabecafebabe",
          peer: "perplexity",
          first_round: 5,
          last_round: 5,
          round_count: 1,
          ask: "Checklist-Item: feedfacefeedface — The same request remains required.",
          first_seen_at: "2026-07-13T00:01:00.000Z",
          last_seen_at: "2026-07-13T00:01:00.000Z",
          status: "not_resurfaced",
        },
        {
          id: "deaddeaddeaddead",
          peer: "deepseek",
          first_round: 4,
          last_round: 4,
          round_count: 1,
          ask: `Checklist-Item: ${item.id} — The same request remains required.`,
          first_seen_at: "2026-07-13T00:02:00.000Z",
          last_seen_at: "2026-07-13T00:02:00.000Z",
          status: "not_resurfaced",
        },
        {
          id: "1111111111111111",
          peer: "perplexity",
          first_round: 6,
          last_round: 6,
          round_count: 1,
          ask: "Checklist-Item: 2222222222222222 — The same cyclic request remains required.",
          first_seen_at: "2026-07-13T00:03:00.000Z",
          last_seen_at: "2026-07-13T00:03:00.000Z",
          status: "not_resurfaced",
        },
        {
          id: "2222222222222222",
          peer: "perplexity",
          first_round: 6,
          last_round: 6,
          round_count: 1,
          ask: "Checklist-Item: 1111111111111111 — The same cyclic request remains required.",
          first_seen_at: "2026-07-13T00:04:00.000Z",
          last_seen_at: "2026-07-13T00:04:00.000Z",
          status: "not_resurfaced",
        },
      ];
      fs.writeFileSync(
        path.join(orchestrator.store.sessionDir(session.session_id), "meta.json"),
        `${JSON.stringify(legacyMeta, null, 2)}\n`,
        "utf8",
      );
      const collapsed = await orchestrator.store.collapseReferencedEvidenceChecklistAliases(
        session.session_id,
      );
      assert.deepEqual(
        collapsed.map((entry) => entry.alias_item_id),
        ["feedfacefeedface", "cafebabecafebabe"],
      );
      assert.ok(collapsed.every((entry) => entry.merged_into_item_id === item.id));
      const repaired = orchestrator.store.read(session.session_id);
      assert.equal(repaired.evidence_checklist?.length, 6);
      assert.equal(repaired.evidence_checklist_alias_collapses?.length, 2);
      assert.ok(repaired.evidence_checklist?.some((entry) => entry.id === "deaddeaddeaddead"));
      assert.ok(repaired.evidence_checklist?.some((entry) => entry.id === "1111111111111111"));
      assert.ok(repaired.evidence_checklist?.some((entry) => entry.id === "2222222222222222"));
    },
  },
  {
    name: "requester reverification accepts alternative line evidence and ignores e.g. abbreviation",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-alternative-and-abbreviation-correlation"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification field-regression fixture.",
        "codex",
      );
      const flowAsk =
        "Attach the current state of the code sections under review (generateValidated, executeOneAnalysisStep, isRetryableTransportError) with line numbers, or a git diff for the patch, to allow static verification of the flow proof.";
      const validationAsk =
        "Provide raw vitest output (e.g., terminal log) showing 281 passed tests and exit code 0 for the same code version.";
      const unrelatedAsk =
        "Provide the deployment rollback log for rollback_id=rollback-unrelated-451.";
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 2, [
        { peer: "deepseek", ask: flowAsk },
        { peer: "deepseek", ask: validationAsk },
        { peer: "deepseek", ask: unrelatedAsk },
      ]);
      await orchestrator.store.runEvidenceChecklistAddressDetection(session.session_id, 3);

      const promoted = await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
        session.session_id,
        {
          round: 7,
          peer: "deepseek",
          evidence_sources: [
            [
              "Attachment: evidence/caller-structured-evidence.txt",
              `sha256=${PANEL_EVIDENCE_SHA}`,
              'Artifact quote: "d92c514fe23ae202 FLOW400_EXACT: analisar.ts:480 wraps the provider error as GeminiStepAttemptError category transport with cause; analisar.ts:1965 evaluates isRetryableTransportError(error.cause); analisar.ts:294 excludes HTTP 400; analisar.partitioned.test.ts:397,407,409 prove status 400, one provider call, retryable false."',
            ].join("\n"),
            [
              "Attachment: evidence/caller-structured-evidence.txt",
              `sha256=${PANEL_EVIDENCE_SHA}`,
              'Artifact quote: "9fef850cd87a2caf VALIDATION_EXACT: Process exit code: 0 | Vitest v4.1.10 | Test Files 50 passed (50) | Tests 281 passed (281) | Duration 13.37s"',
            ].join("\n"),
          ],
        },
      );
      const checklist = orchestrator.store.read(session.session_id).evidence_checklist ?? [];

      assert.deepEqual(
        promoted.map(({ item }) => item.ask),
        [flowAsk, validationAsk],
        "the requester's strictly grounded alternatives must close both historical asks",
      );
      const byAsk = new Map(checklist.map((item) => [item.ask, item]));
      assert.deepEqual(
        [flowAsk, validationAsk].map((ask) => ({
          status: byAsk.get(ask)?.status,
          method: byAsk.get(ask)?.address_method,
        })),
        [
          { status: "addressed", method: "requester_reverified" },
          { status: "addressed", method: "requester_reverified" },
        ],
        "both not_resurfaced asks must become requester_reverified instead of blocking unanimity",
      );
      assert.equal(
        byAsk.get(unrelatedAsk)?.status,
        "not_resurfaced",
        "sources routed to two checklist IDs must not cross-contaminate a third ask from the same peer",
      );
    },
  },
  {
    name: "requester reverification handles diff-grep alternatives and routed Portuguese asks",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-observed-language-classes"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification observed-language fixture.",
        "codex",
      );
      const versionAsk =
        "Cite diff/grep lines showing version bump to v02.22.03 and updates to changelog, README, SECURITY, and methodology docs.";
      const identityAsk =
        "Forneça evidência de que a injeção de identidade no servidor e validação canônica são testadas, com nomes específicos dos testes e saída bruta de aprovação.";
      const redactionAsk =
        "Forneça saída de grep ou conteúdo de arquivo demonstrando a implementação de redação de segredos e as asserções de teste de regressão correspondentes.";
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [
          { peer: "claude", ask: versionAsk },
          { peer: "deepseek", ask: identityAsk },
          { peer: "deepseek", ask: redactionAsk },
        ],
      );
      const identityItem = checklist.find((item) => item.ask === identityAsk);
      const redactionItem = checklist.find((item) => item.ask === redactionAsk);
      assert.ok(identityItem && redactionItem);
      const partialVersion =
        await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
          session.session_id,
          {
            round: 2,
            peer: "claude",
            evidence_sources: [
              'Artifact quote: "VERSION_PARTIAL: astrologo-frontend/package.json:3 current v02.22.03."',
            ],
          },
        );
      const irrelevantDeepSeek =
        await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
          session.session_id,
          {
            round: 2,
            peer: "deepseek",
            evidence_sources: [
              `Artifact quote: "${identityItem.id} IRRELEVANT: settings.ts:10 changes the visual theme."`,
              `Artifact quote: "${identityItem.id} VALIDATION: Process exit code: 0 | Tests 281 passed (281)."`,
              `Artifact quote: "${redactionItem.id} IRRELEVANT: settings.ts:10 changes the visual theme."`,
            ],
          },
        );
      assert.deepEqual(partialVersion, []);
      assert.deepEqual(irrelevantDeepSeek, []);
      const versionPromoted =
        await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
          session.session_id,
          {
            round: 2,
            peer: "claude",
            evidence_sources: [
              'Artifact quote: "VERSION_EXACT: astrologo-frontend/package.json:3 version=2.22.3; README.md:18,24 current v02.22.03; SECURITY.md:5 supported v02.22.03; CHANGELOG.md:5 release section; docs/METODOLOGIA_MAPAS_AVANCADOS.md:148 documents v02.22.03."',
            ],
          },
        );
      const deepseekPromoted =
        await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
          session.session_id,
          {
            round: 2,
            peer: "deepseek",
            evidence_sources: [
              `Artifact quote: "${identityItem.id} IDENTITY_EXACT: analisar.ts:511-573 injects server-owned identity before canonical validation; analisar.partitioned.test.ts:326-370 proves the canonical result."`,
              `Artifact quote: "${identityItem.id} VALIDATION_EXACT: Process exit code: 0 | Tests 281 passed (281)."`,
              `Artifact quote: "${redactionItem.id} DIAGNOSTIC_EXACT: analisar.ts:219-271 redacts credentials; analisar.partitioned.test.ts:390-415 contains the regression assertions."`,
            ],
          },
        );

      assert.deepEqual(
        [...versionPromoted, ...deepseekPromoted].map(({ item }) => item.ask),
        [versionAsk, identityAsk, redactionAsk],
      );
    },
  },
  {
    name: "requester reverification requires every explicitly conjunctive code symbol",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-conjunctive-code-symbols"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification conjunctive-symbol fixture.",
        "codex",
      );
      const ask =
        "Provide all code sections generateValidated, executeOneAnalysisStep, and isRetryableTransportError with line numbers.";
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "deepseek", ask }],
      );
      const item = checklist[0];
      assert.ok(item);

      const promoted = await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
        session.session_id,
        {
          round: 2,
          peer: "deepseek",
          evidence_sources: [
            `Artifact quote: "${item.id} PARTIAL_EXACT: analisar.ts:480 shows generateValidated."`,
          ],
        },
      );

      assert.deepEqual(promoted, []);
      assert.equal(
        orchestrator.store.read(session.session_id).evidence_checklist?.[0]?.status ?? "open",
        "open",
      );
    },
  },
  {
    name: "requester code-symbol extraction is bounded on repeated uppercase backtracking input",
    run: async () => {
      const probe = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          [
            'import { extractChecklistCodeSymbols } from "./src/core/session-store.ts";',
            'const adversarial = "a" + "A".repeat(100_000) + "_";',
            "if (extractChecklistCodeSymbols(adversarial).length !== 0) process.exit(2);",
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 2_000,
          windowsHide: true,
        },
      );
      assert.equal(
        probe.error,
        undefined,
        `production symbol extraction exceeded its 2s adversarial deadline: ${probe.error?.message}`,
      );
      assert.equal(
        probe.status,
        0,
        `production symbol extraction probe failed: ${probe.stderr || probe.stdout}`,
      );

      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-linear-code-symbol-extraction"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification linear code-symbol fixture.",
        "codex",
      );
      const ask = "Provide generateValidated with line numbers.";
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "deepseek", ask }],
      );
      const item = checklist[0];
      assert.ok(item);

      const promoted = await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
        session.session_id,
        {
          round: 2,
          peer: "deepseek",
          evidence_sources: [
            `Artifact quote: "${item.id} SOURCE_EXACT: analisar.ts:480 shows generateValidated."`,
          ],
        },
      );

      assert.deepEqual(
        promoted.map(({ item: promotedItem }) => promotedItem.ask),
        [ask],
        "the bounded extractor must preserve requested camelCase symbol correlation",
      );
    },
  },
  {
    name: "direct review rounds surface outstanding checklist IDs to reviewers",
    run: async () => {
      const config = regressionConfig("direct-round-checklist-routing");
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.initSession(
        "Direct review checklist-routing fixture.",
        "codex",
      );
      const ask = "Provide raw npm test output showing Tests 74 passed (74).";
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "claude", ask }],
      );

      const result = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Implementation candidate under review.",
        caller: "codex",
        peers: ["claude"],
      });
      const prompt = fs.readFileSync(
        path.join(config.data_dir, "sessions", session.session_id, result.round.prompt_file),
        "utf8",
      );

      assert.match(prompt, /## Outstanding Evidence Asks/);
      assert.ok(
        prompt.includes(`Checklist-Item: ${checklist[0]?.id}`),
        "ask_peers/session_start_round must route every unresolved checklist id without caller intervention",
      );
      assert.ok(prompt.includes(ask));
    },
  },
  {
    name: "five grounded READY peers close routed historical asks and converge",
    run: async () => {
      const config = regressionConfig("requester-five-peer-e2e");
      const events: string[] = [];
      const votingPeers: PeerId[] = ["claude", "gemini", "deepseek", "grok", "perplexity"];
      let flowLine = "";
      let validationLine = "";
      const adapters = {} as Record<PeerId, PeerAdapter>;
      const callCounts = new Map<PeerId, number>();
      for (const peer of ["codex", ...votingPeers] as PeerId[]) {
        const adapter = new StubAdapter(config, peer);
        adapter.call = async (prompt) => {
          callCounts.set(peer, (callCounts.get(peer) ?? 0) + 1);
          const attachment = prompt.match(
            /### caller-structured-evidence — `([^`]+)`[^\n]*\nIntegrity: sha256=`([a-f0-9]{64})`/i,
          );
          assert.ok(attachment, `${peer} must receive the persisted caller evidence identity`);
          const [, attachmentPath, attachmentSha] = attachment;
          const source = (line: string) =>
            [
              `Attachment: ${attachmentPath}`,
              `sha256=${attachmentSha}`,
              `Artifact quote: "${line}"`,
            ].join("\n");
          return readyPeer(peer, "verified", [source(flowLine), source(validationLine)]);
        };
        adapters[peer] = adapter;
      }
      assert.throws(
        () => new CrossReviewOrchestrator({ ...config, stub: false }, undefined, () => adapters),
        /injected_adapter_factory_forbidden/,
        "stub=false must reject injected adapters before probes or paid review calls",
      );
      const orchestrator = new CrossReviewOrchestrator(
        config,
        (event) => events.push(event.type),
        () => adapters,
      );
      const session = await orchestrator.initSession(
        "Five-peer requester reverification integration fixture.",
        "codex",
      );
      const flowAsk =
        "Attach the current state of the code sections under review (generateValidated, executeOneAnalysisStep, isRetryableTransportError) with line numbers, or a git diff for the patch, to allow static verification of the flow proof.";
      const validationAsk =
        "Provide raw vitest output (e.g., terminal log) showing 281 passed tests and exit code 0 for the same code version.";
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [],
        rejected: [],
        convergence: checkConvergence(
          ["claude", "gemini", "deepseek", "grok", "perplexity"],
          "READY",
          [],
          [],
        ),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude", "gemini", "deepseek", "grok", "perplexity"],
          reviewer_peers: ["claude", "gemini", "deepseek", "grok", "perplexity"],
        },
        started_at: new Date().toISOString(),
      });
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [
          { peer: "deepseek", ask: flowAsk },
          { peer: "deepseek", ask: validationAsk },
        ],
      );
      const flowItem = checklist.find((item) => item.ask === flowAsk);
      const validationItem = checklist.find((item) => item.ask === validationAsk);
      assert.equal(flowItem?.id, "d92c514fe23ae202");
      assert.equal(validationItem?.id, "9fef850cd87a2caf");
      flowLine =
        `${flowItem.id} FLOW400_EXACT: analisar.ts:480 wraps the provider error as GeminiStepAttemptError category transport with cause; ` +
        "analisar.ts:1965 evaluates isRetryableTransportError(error.cause); analisar.ts:294 excludes HTTP 400; " +
        "analisar.partitioned.test.ts:397,407,409 prove status 400, one provider call, retryable false.";
      validationLine = `${validationItem.id} VALIDATION_EXACT: Process exit code: 0 | Vitest v4.1.10 | Test Files 50 passed (50) | Tests 281 passed (281) | Duration 13.37s`;
      await orchestrator.store.runEvidenceChecklistAddressDetection(session.session_id, 2);
      assert.ok(
        (orchestrator.store.read(session.session_id).evidence_checklist ?? []).every(
          (item) => item.status === "not_resurfaced",
        ),
      );

      const result = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Implementation candidate under review.",
        evidence: [flowLine, validationLine].join("\n"),
        caller: "codex",
        peers: votingPeers,
      });
      const persisted = orchestrator.store.read(session.session_id);

      assert.equal(result.round.peers.length, 5);
      assert.ok(result.round.peers.every((peer) => peer.status === "READY"));
      assert.ok(
        (persisted.evidence_checklist ?? []).every(
          (item) => item.status === "addressed" && item.address_method === "requester_reverified",
        ),
      );
      assert.ok(events.includes("session.evidence_checklist_requester_reverified"));
      assert.equal(callCounts.get("codex") ?? 0, 0);
      assert.deepEqual(
        votingPeers.map((peer) => callCounts.get(peer) ?? 0),
        [1, 1, 1, 1, 1],
      );
      assert.equal(result.converged, true);
      assert.equal(result.round.convergence.converged, true);
    },
  },
  {
    name: "post-round checklist promotion is persisted before final convergence is returned",
    run: async () => {
      const base = regressionConfig("post-round-convergence-persistence");
      const config = {
        ...base,
        evidence_judge_autowire: {
          ...base.evidence_judge_autowire,
          mode: "active" as const,
          active: true,
          peer: "codex" as const,
          consensus_peers: [],
        },
      };
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.initSession(
        "Review a design fixture without operational claims.",
        "operator",
      );
      const initialChecklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "claude", ask: "Provide the exact design invariant and its rationale." }],
      );
      const initialItem = initialChecklist[0];
      assert.ok(initialItem);
      let appendObservedReconciledChecklist = false;
      let concurrentOperatorMutationError: unknown;
      const appendRound = orchestrator.store.appendRound.bind(orchestrator.store);
      orchestrator.store.appendRound = async (...args) => {
        appendObservedReconciledChecklist =
          orchestrator.store
            .read(session.session_id)
            .evidence_checklist?.every((item) => item.status === "addressed") === true;
        assert.equal(
          appendObservedReconciledChecklist,
          true,
          "the durable round must not be appended before checklist/judge reconciliation",
        );
        const appended = await appendRound(...args);
        try {
          await orchestrator.store.setEvidenceChecklistItemStatus(
            session.session_id,
            initialItem.id,
            "open",
          );
        } catch (error) {
          concurrentOperatorMutationError = error;
        }
        return appended;
      };

      const result = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "FORCE_JUDGE_SATISFIED: the exact invariant and rationale are present.",
        caller: "operator",
        peers: ["claude", "codex"],
      });
      const persisted = orchestrator.store.read(session.session_id);
      const latest = persisted.rounds.at(-1);

      assert.equal(result.converged, true);
      assert.equal(result.round.convergence.converged, true);
      assert.equal(latest?.convergence.converged, true);
      assert.equal(persisted.outcome, "converged");
      assert.equal(persisted.convergence_health?.state, "converged");
      assert.equal(appendObservedReconciledChecklist, true);
      assert.match(
        concurrentOperatorMutationError instanceof Error
          ? concurrentOperatorMutationError.message
          : String(concurrentOperatorMutationError),
        /evidence_checklist_update_in_flight/,
        "the converged append-to-finalize interval must retain the in-flight reservation",
      );
      assert.ok(
        persisted.evidence_checklist?.every((item) => item.status === "addressed"),
        "the persisted checklist and convergence must describe the same post-judge state",
      );
    },
  },
  {
    name: "unresolved historical asks persist one coherent blocked state after READY votes",
    run: async () => {
      const config = regressionConfig("blocked-convergence-persistence");
      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(config, (event) => events.push(event.type));
      const session = await orchestrator.initSession(
        "Review a design fixture without operational claims.",
        "codex",
      );
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        {
          peer: "claude",
          ask: "Provide design-invariant-id=invariant-991 and its exact rationale.",
        },
      ]);

      const result = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Current design continuation does not contain the requested invariant.",
        caller: "codex",
        peers: ["claude"],
      });
      const persisted = orchestrator.store.read(session.session_id);
      const latest = persisted.rounds.at(-1)?.convergence;
      assert.equal(result.converged, false);
      assert.equal(result.round.convergence.converged, false);
      assert.equal(latest?.converged, false);
      assert.equal(persisted.convergence_health?.state, "blocked");
      assert.deepEqual(
        latest?.ready_peers.filter((peer) => latest.needs_evidence_peers.includes(peer)),
        [],
      );
      assert.ok(events.includes("session.evidence_checklist_blocks_convergence"));
    },
  },
  {
    name: "interrupted rounds roll back journaled evidence-broker mutations",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("interrupted-broker-rollback"),
      );
      const session = await orchestrator.initSession(
        "Interrupted evidence broker transaction fixture.",
        "codex",
      );
      const scope = {
        petitioner: "codex" as const,
        caller: "codex" as const,
        caller_status: "READY" as const,
        expected_peers: ["claude" as const],
        reviewer_peers: ["claude" as const],
      };
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [], []),
        convergence_scope: scope,
        started_at: new Date().toISOString(),
      });
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "claude", ask: "Provide the exact rollback transcript." }],
      );
      const original = checklist[0];
      assert.ok(original);
      await orchestrator.store.markInFlight(session.session_id, {
        round: 2,
        peers: ["claude"],
        started_at: new Date().toISOString(),
        scope,
      });
      await assert.rejects(
        orchestrator.store.setEvidenceChecklistItemStatus(
          session.session_id,
          original.id,
          "satisfied",
        ),
        /evidence_checklist_update_in_flight/,
        "an operator mutation must not enter the interval covered by the runtime rollback journal",
      );
      await orchestrator.store.runEvidenceChecklistAddressDetection(session.session_id, 2);
      assert.equal(
        orchestrator.store.read(session.session_id).evidence_checklist?.[0]?.status,
        "not_resurfaced",
      );

      await orchestrator.store.recoverInterruptedSessions();
      const recovered = orchestrator.store.read(session.session_id);
      assert.equal(recovered.in_flight, undefined);
      assert.equal(recovered.evidence_checklist?.[0]?.id, original.id);
      assert.equal(
        recovered.evidence_checklist?.[0]?.status,
        undefined,
        "an interrupted, non-appended round must not retain its broker state transition",
      );
      assert.deepEqual(
        recovered.evidence_status_history ?? [],
        [],
        "an interrupted round must roll back its broker history together with checklist state",
      );
      assert.ok(
        orchestrator.store
          .readEvents(session.session_id)
          .some((event) => event.type === "session.evidence_broker_transaction_rolled_back"),
        "recovery must append an explicit compensation event for broker transitions it rolled back",
      );
    },
  },
  {
    name: "appendRound gates convergence from the checklist inside its durable lock",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("append-round-checklist-atomic-gate"),
      );
      const session = await orchestrator.initSession(
        "Atomic checklist convergence fixture.",
        "codex",
      );
      const scope = {
        petitioner: "codex" as const,
        caller: "codex" as const,
        caller_status: "READY" as const,
        expected_peers: ["claude" as const],
        reviewer_peers: ["claude" as const],
      };
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 0, [
        { peer: "claude", ask: "Provide release-proof-id=proof-atomic-991." },
      ]);
      await orchestrator.store.markInFlight(session.session_id, {
        round: 1,
        peers: ["claude"],
        started_at: new Date().toISOString(),
        scope,
      });
      const ready = readyPeer("claude", "verified", ["design-only fixture"]);
      const staleReady = checkConvergence(["claude"], "READY", [ready], []);
      assert.equal(staleReady.converged, true);

      const round = await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [ready],
        rejected: [],
        convergence: staleReady,
        convergence_scope: scope,
        started_at: new Date().toISOString(),
      });
      const persisted = orchestrator.store.read(session.session_id);
      assert.equal(round.convergence.converged, false);
      assert.match(round.convergence.reason, /unresolved_evidence/);
      assert.equal(persisted.rounds.at(-1)?.convergence.converged, false);
      assert.equal(persisted.convergence_health?.state, "blocked");
    },
  },
  {
    name: "resuming a legacy session removes only proven runtime-authored checklist asks",
    run: async () => {
      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("runtime-remediation-reclassification"),
        (event) => events.push(event.type),
      );
      const session = await orchestrator.initSession(
        "Review the implementation candidate.",
        "codex",
      );
      const runtimeAsk =
        "Cite evidence verbatim from the reviewed artifact, authenticated caller submission, or operator-verified attachments; invented or untraceable sources cannot support READY.";
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask: runtimeAsk },
      ]);
      const providerText = JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "verified",
        evidence_sources: [],
        caller_requests: [],
        follow_ups: [],
      });
      const legacyDemotion: PeerResult = {
        ...readyPeer("claude", "verified", []),
        raw_status: "READY",
        parsed_status: "READY",
        normalized_status: "NEEDS_EVIDENCE",
        status: "NEEDS_EVIDENCE",
        structured: {
          status: "NEEDS_EVIDENCE",
          summary: "No blocking objections remain.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: [runtimeAsk],
          follow_ups: [],
        },
        text: providerText,
        parser_warnings: ["ready_evidence_sources_missing"],
        decision_quality: "needs_operator_review",
      };
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [legacyDemotion],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [legacyDemotion], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });

      const resumed = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Implementation candidate under review.",
        caller: "codex",
        peers: ["claude"],
      });
      const persisted = orchestrator.store.read(session.session_id);

      assert.equal(resumed.converged, true);
      assert.deepEqual(persisted.evidence_checklist, []);
      assert.equal(persisted.evidence_checklist_runtime_reclassifications?.length, 1);
      assert.equal(
        persisted.evidence_checklist_runtime_reclassifications?.[0]?.reason,
        "runtime_remediation_misattributed_as_peer_request",
      );
      assert.ok(events.includes("session.evidence_checklist_runtime_remediation_reclassified"));
      assert.match(
        sessionReportMarkdown(persisted, []),
        /Runtime Checklist Reclassifications[\s\S]*ready_evidence_sources_missing/,
      );
    },
  },
  {
    name: "legacy repair never erases a genuine earlier ask after a later synthetic collision",
    run: async () => {
      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("runtime-remediation-origin-collision"),
        (event) => events.push(event.type),
      );
      const session = await orchestrator.initSession(
        "Review the implementation candidate with a real evidence request.",
        "codex",
      );
      const collidingAsk =
        "Cite evidence verbatim from the reviewed artifact, authenticated caller submission, or operator-verified attachments; invented or untraceable sources cannot support READY.";
      const genuineText = JSON.stringify({
        status: "NEEDS_EVIDENCE",
        summary: "A concrete citation is required.",
        confidence: "verified",
        evidence_sources: [],
        caller_requests: [collidingAsk],
        follow_ups: [],
      });
      const genuineRequest: PeerResult = {
        ...readyPeer("claude", "verified", []),
        raw_status: "NEEDS_EVIDENCE",
        parsed_status: "NEEDS_EVIDENCE",
        normalized_status: "NEEDS_EVIDENCE",
        status: "NEEDS_EVIDENCE",
        structured: JSON.parse(genuineText),
        text: genuineText,
        decision_quality: "needs_operator_review",
      };
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask: collidingAsk },
      ]);
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [genuineRequest],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [genuineRequest], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });

      const laterProviderText = JSON.stringify({
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "verified",
        evidence_sources: [],
        caller_requests: [],
        follow_ups: [],
      });
      const laterSyntheticDemotion: PeerResult = {
        ...readyPeer("claude", "verified", []),
        raw_status: "READY",
        parsed_status: "READY",
        normalized_status: "NEEDS_EVIDENCE",
        status: "NEEDS_EVIDENCE",
        structured: {
          status: "NEEDS_EVIDENCE",
          summary: "No blocking objections remain.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: [collidingAsk],
          follow_ups: [],
        },
        text: laterProviderText,
        parser_warnings: ["ready_evidence_sources_missing"],
        decision_quality: "needs_operator_review",
      };
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 2, [
        { peer: "claude", ask: collidingAsk },
      ]);
      await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-2-prompt.md",
        peers: [laterSyntheticDemotion],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [laterSyntheticDemotion], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });

      const resumed = await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Implementation candidate under review.",
        caller: "codex",
        peers: ["claude"],
      });
      const persisted = orchestrator.store.read(session.session_id);

      assert.equal(resumed.converged, false);
      assert.equal(persisted.evidence_checklist?.length, 1);
      assert.equal(persisted.evidence_checklist?.[0]?.ask, collidingAsk);
      assert.equal(persisted.evidence_checklist_runtime_reclassifications, undefined);
      assert.equal(
        events.includes("session.evidence_checklist_runtime_remediation_reclassified"),
        false,
      );
    },
  },
  {
    name: "requester reverification rejects Checklist-Item plus an irrelevant artifact quote",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-irrelevant-checklist-id"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification irrelevant-citation fixture.",
        "codex",
      );
      const ask = "Provide independent evidence that the implementation is correct.";
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask },
      ]);
      const item = orchestrator.store.read(session.session_id).evidence_checklist?.[0];
      assert.ok(item, "fixture must create one evidence checklist item");

      const artifact =
        "This implementation changes the settings screen and contains an unrelated descriptive sentence.";
      const source = [
        `Checklist-Item: ${item.id}`,
        'Artifact quote: "This implementation changes the settings screen"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: artifact,
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });
      const promoted =
        grounding.grounded &&
        grounding.result.status === "READY" &&
        grounding.result.structured?.confidence === "verified"
          ? await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
              session.session_id,
              { round: 2, peer: "claude", evidence_sources: [source] },
            )
          : [];
      const persisted = orchestrator.store.read(session.session_id).evidence_checklist?.[0];

      assert.deepEqual(
        {
          promoted_asks: promoted.map(({ item: promotedItem }) => promotedItem.ask),
          persisted_status: persisted?.status ?? "open",
        },
        {
          promoted_asks: [],
          persisted_status: "open",
        },
        "a Checklist-Item id identifies the ask but does not prove an unrelated artifact quote answers it",
      );
    },
  },
  {
    name: "checklist command extraction stays bounded on repeated double-hyphen fragments",
    run: () => {
      const adversarialAsk = `git status ${"-- -".repeat(24)}!`;
      const startedAt = performance.now();
      extractChecklistCommands(adversarialAsk);
      const elapsedMs = performance.now() - startedAt;
      assert.ok(
        elapsedMs < 100,
        `command extraction took ${elapsedMs.toFixed(3)}ms for ${adversarialAsk.length} characters`,
      );
    },
  },
  {
    name: "requester reverification rejects command-name-only documentation quote",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("requester-command-name-only"),
      );
      const session = await orchestrator.initSession(
        "Requester reverification command-name-only fixture.",
        "codex",
      );
      const ask = "Provide raw npm test output proving execution.";
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask },
      ]);
      const item = orchestrator.store.read(session.session_id).evidence_checklist?.[0];
      assert.ok(item, "fixture must create one evidence checklist item");

      const artifact = "The documentation mentions npm test as a command users may run.";
      const source = [`Checklist-Item: ${item.id}`, `Artifact quote: "${artifact}"`].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: artifact,
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });
      const promoted = grounding.grounded
        ? await orchestrator.store.markEvidenceItemsAddressedByRequesterReverification(
            session.session_id,
            { round: 2, peer: "claude", evidence_sources: [source] },
          )
        : [];
      const persisted = orchestrator.store.read(session.session_id).evidence_checklist?.[0];

      assert.deepEqual(
        {
          promoted_asks: promoted.map(({ item: promotedItem }) => promotedItem.ask),
          persisted_status: persisted?.status ?? "open",
        },
        {
          promoted_asks: [],
          persisted_status: "open",
        },
        "mentioning the requested command in documentation is not raw execution output",
      );
    },
  },
  {
    name: "historical peer-only claim requires strict path hash raw grounding before panel convergence",
    run: () => {
      const historicalClaim =
        "When the workflow began, cross-review runtime version 4.5.0 was in use.";
      const historicalRaw = "session_read snapshot captured for workflow start";
      const historicalPath = "evidence/workflow-start-snapshot.txt";
      const historicalSha = "a".repeat(64);
      const truthfulness = truthfulnessPreflight({
        task: historicalClaim,
        initialDraft: "Historical runtime report.",
        structuredEvidence: historicalRaw,
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      const groundingInput = {
        artifactText: historicalClaim,
        attachedEvidenceText: "",
        attachmentRefs: [historicalPath],
        callerSubmittedAttachments: [
          {
            label: "workflow-start-snapshot",
            relative_path: historicalPath,
            sha256: historicalSha,
            content: historicalRaw,
          },
        ],
        runtimeFacts: {},
      } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
      // Both reviewers merely echo the historical claim. Neither cites the
      // persisted path, digest or a raw snapshot line.
      const claude = groundReadyPeerEvidence(
        readyPeer("claude", "verified", [historicalClaim]),
        groundingInput,
      );
      const gemini = groundReadyPeerEvidence(
        readyPeer("gemini", "verified", [historicalClaim]),
        groundingInput,
      );
      const base = checkConvergence(
        ["claude", "gemini"],
        "READY",
        [claude.result, gemini.result],
        [],
      );
      const corroboratingPeers: PeerId[] = [];
      if (claude.peer_submitted_evidence_corroborated) corroboratingPeers.push("claude");
      if (gemini.peer_submitted_evidence_corroborated) corroboratingPeers.push("gemini");
      const gated = blockConvergenceForPeerSubmittedEvidencePanel(base, {
        required: truthfulness.independent_review_required,
        corroborating_peers: corroboratingPeers,
      });

      assert.deepEqual(
        {
          truthfulness_pass: truthfulness.pass,
          independent_review_required: truthfulness.independent_review_required,
          claude_peer_evidence_required: claude.peer_submitted_evidence_required,
          claude_grounded: claude.grounded,
          claude_corroborated: claude.peer_submitted_evidence_corroborated,
          gemini_peer_evidence_required: gemini.peer_submitted_evidence_required,
          gemini_grounded: gemini.grounded,
          gemini_corroborated: gemini.peer_submitted_evidence_corroborated,
          panel_converged: gated.converged,
        },
        {
          truthfulness_pass: true,
          independent_review_required: true,
          claude_peer_evidence_required: true,
          claude_grounded: false,
          claude_corroborated: false,
          gemini_peer_evidence_required: true,
          gemini_grounded: false,
          gemini_corroborated: false,
          panel_converged: false,
        },
        "historical peer-only provenance must not be corroborated by two reviewers merely echoing the claim",
      );
    },
  },
  {
    name: "negative narrative cannot masquerade as successful command evidence",
    run: () => {
      const claim = "The implementation is complete and npm run test passed.";
      for (const [language, evidence] of [
        ["English", "npm run test was NOT executed; only the documentation looks ok."],
        ["Portuguese", "npm run test não foi executado; somente a documentação parece ok."],
      ] as const) {
        const evidencePath = `evidence/caller-structured-evidence-${language.toLowerCase()}.txt`;
        const evidenceSha = "b".repeat(64);
        const preflight = evidencePreflight({
          task: claim,
          initialDraft: "Release report.",
          structuredEvidence: evidence,
          caller: "codex",
          attachmentsPresent: false,
        });
        const groundingInput = {
          artifactText: claim,
          attachedEvidenceText: "",
          attachmentRefs: [evidencePath],
          callerSubmittedAttachments: [
            {
              relative_path: evidencePath,
              sha256: evidenceSha,
              content: evidence,
            },
          ],
          runtimeFacts: {},
        } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
        const source = [
          `Attachment: ${evidencePath}`,
          `sha256=${evidenceSha}`,
          `"${evidence}"`,
        ].join("\n");
        const claude = groundReadyPeerEvidence(
          readyPeer("claude", "verified", [source]),
          groundingInput,
        );
        const gemini = groundReadyPeerEvidence(
          readyPeer("gemini", "verified", [source]),
          groundingInput,
        );
        const base = checkConvergence(
          ["claude", "gemini"],
          "READY",
          [claude.result, gemini.result],
          [],
        );
        const gated = blockConvergenceForPeerSubmittedEvidencePanel(base, {
          required:
            preflight.pass &&
            preflight.completed_work_claim_matched &&
            !preflight.operator_grounded,
          corroborating_peers: [
            ...(claude.peer_submitted_evidence_corroborated ? (["claude"] as PeerId[]) : []),
            ...(gemini.peer_submitted_evidence_corroborated ? (["gemini"] as PeerId[]) : []),
          ],
        });

        assert.deepEqual(
          {
            preflight_pass: preflight.pass,
            claude_grounded: claude.grounded,
            gemini_grounded: gemini.grounded,
            panel_converged: gated.converged,
          },
          {
            preflight_pass: false,
            claude_grounded: false,
            gemini_grounded: false,
            panel_converged: false,
          },
          `${language}: a negated non-execution statement plus an unrelated 'ok' token is not successful raw command output`,
        );
      }
    },
  },
  {
    name: "corrected evidence snapshot supersedes a failed snapshot in the same askPeers session",
    run: async () => {
      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("same-session-corrected-snapshot"),
        (event) => events.push(event.type),
      );
      const task = "Review the completed implementation: npm run test passed with 74 passed.";
      const failedEvidence = [
        RETRY_BAD_SNAPSHOT_SENTINEL,
        "COMMAND: npm run test",
        "EXIT_CODE: 1",
        "Tests 74 failed (74)",
      ].join("\n");
      const correctedEvidence = [
        RETRY_GOOD_SNAPSHOT_SENTINEL,
        "COMMAND: npm run test",
        "EXIT_CODE: 0",
        "Tests 74 passed (74)",
      ].join("\n");

      const first = await orchestrator.askPeers({
        task,
        draft: "Implementation snapshot awaiting evidence validation.",
        evidence: failedEvidence,
        caller: "codex",
        peers: ["claude", "gemini"],
      });
      assert.equal(
        first.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
        true,
        "the failed EXIT_CODE 1 snapshot must be rejected before peer calls",
      );
      assert.equal(events.filter((type) => type === "peer.call.started").length, 0);

      const second = await orchestrator.askPeers({
        session_id: first.session.session_id,
        task,
        draft: "Corrected implementation snapshot awaiting independent review.",
        evidence: correctedEvidence,
        caller: "codex",
        peers: ["claude", "gemini"],
      });
      assert.equal(
        second.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
        false,
        "the current corrected snapshot must not inherit the prior snapshot's EXIT_CODE 1",
      );
      assert.equal(second.round.peers.length, 2, "the corrected snapshot must reach both peers");
      assert.equal(
        events.filter((type) => type === "peer.call.started").length,
        2,
        "the corrected snapshot must dispatch the configured independent panel",
      );

      const promptPath = path.join(
        orchestrator.store.sessionDir(second.session.session_id),
        second.round.prompt_file,
      );
      const prompt = fs.readFileSync(promptPath, "utf8");
      assert.match(prompt, new RegExp(RETRY_GOOD_SNAPSHOT_SENTINEL));
      assert.doesNotMatch(
        prompt,
        new RegExp(RETRY_BAD_SNAPSHOT_SENTINEL),
        "reviewers must receive the current evidence snapshot, not superseded failed attachments",
      );
      const persisted = orchestrator.store.read(second.session.session_id);
      assert.equal(
        persisted.caller_evidence_submissions?.length,
        2,
        "both submissions remain append-only audit history",
      );
      const activeSubmission = persisted.caller_evidence_submissions?.at(-1);
      assert.equal(
        persisted.active_caller_evidence_submission_id,
        activeSubmission?.submission_id,
        "the corrected submission manifest must be the sole active caller snapshot",
      );
      assert.equal(activeSubmission?.attachment_paths.length, 1);
      assert.equal(
        orchestrator.store.readEvidenceAttachments(second.session.session_id, 200_000).length,
        1,
        "superseded blobs stay durable but cannot re-enter the review corpus",
      );
    },
  },
  {
    name: "a new askPeers snapshot without evidence cannot reuse an older successful snapshot",
    run: async () => {
      const events: string[] = [];
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("new-snapshot-no-evidence"),
        (event) => events.push(event.type),
      );
      const task = "Review the completed implementation: npm run test passed.";
      const priorSuccess = [
        PRIOR_SUCCESS_SNAPSHOT_SENTINEL,
        "COMMAND: npm run test",
        "EXIT_CODE: 0",
        "Tests 74 passed (74)",
      ].join("\n");

      const first = await orchestrator.askPeers({
        task,
        draft: "First implementation snapshot.",
        evidence: priorSuccess,
        caller: "codex",
        peers: ["claude"],
      });
      assert.equal(
        first.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
        false,
        "the first snapshot fixture must establish a valid successful evidence record",
      );
      const callsAfterFirstSnapshot = events.filter((type) => type === "peer.call.started").length;
      assert.equal(
        callsAfterFirstSnapshot,
        1,
        "one reviewer keeps the first peer-submitted-evidence round non-terminal for the retry fixture",
      );
      await orchestrator.store.appendEvidenceChecklistItems(first.session.session_id, 1, [
        {
          peer: "claude",
          ask: "Provide the raw npm run test transcript proving the current snapshot.",
        },
      ]);

      const second = await orchestrator.askPeers({
        session_id: first.session.session_id,
        task,
        draft: "Second implementation snapshot claims tests passed but supplies no raw evidence.",
        caller: "codex",
        peers: ["claude"],
      });
      assert.equal(
        second.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
        true,
        "each new snapshot must supply its own correlated evidence instead of borrowing an earlier success",
      );
      assert.equal(
        second.round.peers.length,
        0,
        "the evidence-less snapshot must stop before peers",
      );
      assert.equal(
        events.filter((type) => type === "peer.call.started").length,
        callsAfterFirstSnapshot,
        "an older successful attachment must not authorize new paid peer calls",
      );
      const persisted = orchestrator.store.read(second.session.session_id);
      const emptySnapshot = persisted.caller_evidence_submissions?.at(-1);
      assert.equal(persisted.active_caller_evidence_submission_id, emptySnapshot?.submission_id);
      assert.deepEqual(
        emptySnapshot?.attachment_paths,
        [],
        "channel absence is explicit in the new snapshot and supersedes every automatic prior channel",
      );
      assert.deepEqual(
        orchestrator.store.readEvidenceAttachments(second.session.session_id, 200_000),
        [],
      );
    },
  },
  {
    name: "restart replays snapshot-scoped grounded READY evidence without reinjecting old blobs",
    run: async () => {
      const config = regressionConfig("historical-reverification-replay");
      const firstRuntime = new CrossReviewOrchestrator(config);
      const session = await firstRuntime.initSession(
        "Historical requester reverification replay fixture.",
        "codex",
      );
      await firstRuntime.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-1-prompt.md",
        peers: [],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });
      const checklist = await firstRuntime.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "claude", ask: "Provide raw npm test output proving Tests 74 passed (74)." }],
      );
      const item = checklist[0];
      assert.ok(item);
      const evidenceContent = [
        "HISTORICAL_REPLAY_SENTINEL",
        "COMMAND: npm test",
        "EXIT_CODE: 0",
        "Tests 74 passed (74)",
      ].join("\n");
      const submission = await firstRuntime.store.attachCallerEvidenceSubmission(
        session.session_id,
        {
          submitted_by: "codex",
          artifact_text: "Round 2 artifact",
          items: [
            {
              label: "round-2-evidence",
              content: evidenceContent,
              content_type: "text/plain; charset=utf-8",
              extension: "txt",
            },
          ],
        },
      );
      const attachmentPath = submission.submission.attachment_paths[0];
      const attachment = submission.meta.evidence_files?.find(
        (candidate) => candidate.path === attachmentPath && "sha256" in candidate,
      );
      assert.ok(attachment && "sha256" in attachment);
      const source = [
        `Checklist-Item: ${item.id}`,
        `Attachment: ${attachmentPath}`,
        `sha256=${attachment.sha256}`,
        "COMMAND: npm test",
        "EXIT_CODE: 0",
        'Artifact quote: "Tests 74 passed (74)"',
      ].join("\n");
      const historicalPeer = {
        ...readyPeer("claude", "verified", [source]),
        raw_status: "READY" as const,
        parsed_status: "READY" as const,
        normalized_status: "READY" as const,
      };
      await firstRuntime.store.appendRound(session.session_id, {
        caller_status: "READY",
        prompt_file: "agent-runs/round-2-prompt.md",
        peers: [historicalPeer],
        rejected: [],
        convergence: checkConvergence(["claude"], "READY", [historicalPeer], []),
        convergence_scope: {
          petitioner: "codex",
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });

      const events: string[] = [];
      const restarted = new CrossReviewOrchestrator(config, (event) => events.push(event.type));
      let replayObservedAtomicReservation = false;
      const collapseAliases = restarted.store.collapseReferencedEvidenceChecklistAliases.bind(
        restarted.store,
      );
      restarted.store.collapseReferencedEvidenceChecklistAliases = async (...args) => {
        replayObservedAtomicReservation =
          restarted.store.read(session.session_id).in_flight?.round === 3;
        return collapseAliases(...args);
      };
      const result = await restarted.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Current design-only continuation with no operational claim.",
        caller: "codex",
        peers: ["claude"],
      });
      const persisted = restarted.store.read(session.session_id);
      assert.equal(persisted.evidence_checklist?.[0]?.status, "addressed");
      assert.equal(persisted.evidence_checklist?.[0]?.address_method, "requester_reverified");
      assert.ok(events.includes("session.evidence_checklist_historical_reverification_replayed"));
      assert.equal(
        replayObservedAtomicReservation,
        true,
        "session resume repairs must run only after markInFlight wins the atomic round reservation",
      );
      const prompt = fs.readFileSync(
        path.join(restarted.store.sessionDir(result.session.session_id), result.round.prompt_file),
        "utf8",
      );
      assert.doesNotMatch(
        prompt,
        /HISTORICAL_REPLAY_SENTINEL/,
        "historical bytes are replayed locally and must not become stale current-review context",
      );
    },
  },
  {
    name: "narrative success tokens are not raw operational evidence",
    run: () => {
      const variants = [
        {
          label: "isolated git diff --stat token",
          claim: "The implementation is complete and git diff confirms the changes.",
          evidence: "git diff --stat",
        },
        {
          label: "short git status clean narrative",
          claim: "The implementation is complete and git status is clean.",
          evidence: "git status clean",
        },
        {
          label: "tests passed narrative",
          claim: "The implementation is complete and tests passed.",
          evidence: "tests passed",
        },
        {
          label: "build succeeded narrative",
          claim: "The implementation is complete and build succeeded.",
          evidence: "build succeeded",
        },
        {
          label: "all checks passed narrative",
          claim: "The implementation is complete and all checks passed.",
          evidence: "all checks passed",
        },
      ];
      const results = variants.map(({ label, claim, evidence }) => ({
        label,
        pass: evidencePreflight({
          task: claim,
          initialDraft: "Release snapshot awaiting evidence validation.",
          structuredEvidence: evidence,
          caller: "codex",
          attachmentsPresent: false,
        }).pass,
      }));

      assert.deepEqual(
        results,
        variants.map(({ label }) => ({ label, pass: false })),
        "echoing a command or success phrase is narrative self-attestation, not raw result evidence",
      );
    },
  },
  {
    name: "no-claim preflight cannot manufacture operator evidence authority",
    run: () => {
      const result = evidencePreflight({
        task: "Review the proposed session API design.",
        initialDraft: "This is a design artifact with no completed-work assertion.",
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.deepEqual(
        {
          pass: result.pass,
          completed_work_claim_matched: result.completed_work_claim_matched,
          operator_grounded: result.operator_grounded,
          evidence_authority: result.evidence_authority,
        },
        {
          pass: true,
          completed_work_claim_matched: false,
          operator_grounded: false,
          evidence_authority: "none",
        },
        "absence of a claim/evidence is neutral and must never be labeled operator_verified",
      );
    },
  },
  {
    name: "unattached design reference cannot manufacture caller evidence authority",
    run: () => {
      const result = evidencePreflight({
        task: "Review the proposed session API design.",
        initialDraft: "Consult the raw design evidence in design-context.log for background.",
        structuredEvidence: "Narrative design context only; no completed-work assertion.",
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.deepEqual(
        {
          pass: result.pass,
          completed_work_claim_matched: result.completed_work_claim_matched,
          unattached_evidence_references: result.unattached_evidence_references,
          operator_grounded: result.operator_grounded,
          evidence_authority: result.evidence_authority,
        },
        {
          pass: false,
          completed_work_claim_matched: false,
          unattached_evidence_references: ["design-context.log"],
          operator_grounded: false,
          evidence_authority: "none",
        },
        "an unrelated narrative and missing design reference are not evidence authority when no completed-work claim exists",
      );
    },
  },
  {
    name: "source member access cannot masquerade as an unattached log artifact",
    run: () => {
      const result = evidencePreflight({
        task: "Review the proposed API design.",
        initialDraft: 'Example source line: console.log("evidence marker");',
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.deepEqual(
        {
          pass: result.pass,
          completed_work_claim_matched: result.completed_work_claim_matched,
          unattached_evidence_references: result.unattached_evidence_references,
        },
        {
          pass: true,
          completed_work_claim_matched: false,
          unattached_evidence_references: [],
        },
        "console.log is source member access, not a referenced evidence file",
      );
    },
  },
  {
    name: "modal non-execution cannot masquerade as successful command evidence",
    run: () => {
      const result = evidencePreflight({
        task: "The implementation is complete and npm run test passed.",
        initialDraft: "Release report.",
        structuredEvidence: "npm run test could not be run; only the documentation looks ok.",
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.equal(
        result.pass,
        false,
        "could-not-be-run is an explicit non-execution signal even when unrelated text says ok",
      );
    },
  },
  {
    name: "skipped command cannot masquerade as successful command evidence",
    run: () => {
      const result = evidencePreflight({
        task: "The implementation is complete and npm run test passed.",
        initialDraft: "Release report.",
        structuredEvidence: "npm run test was skipped; the documentation check is green.",
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.equal(
        result.pass,
        false,
        "a skipped command is not successful execution evidence even when another check is green",
      );
    },
  },
  {
    name: "adjacent non-execution synonyms cannot borrow an unrelated success token",
    run: () => {
      const claim = "The implementation is complete and npm run test passed.";
      const evidenceVariants = [
        "npm run test was not attempted; the documentation passed.",
        "npm run test never started; the documentation passed.",
        "npm run test was aborted before execution; the documentation passed.",
      ];
      const results = evidenceVariants.map((evidence) => ({
        evidence,
        pass: evidencePreflight({
          task: claim,
          initialDraft: "Release report.",
          structuredEvidence: evidence,
          caller: "codex",
          attachmentsPresent: false,
        }).pass,
      }));
      assert.deepEqual(
        results,
        evidenceVariants.map((evidence) => ({ evidence, pass: false })),
        "attempted/started/aborted non-execution evidence must fail closed despite an unrelated success token",
      );
    },
  },
  {
    name: "same-line result from another command cannot corroborate the target command",
    run: () => {
      const result = evidencePreflight({
        task: "The implementation is complete and npm run test passed.",
        initialDraft: "Release report.",
        structuredEvidence: "npm run test; npm run docs passed.",
        caller: "codex",
        attachmentsPresent: false,
      });
      assert.equal(
        result.pass,
        false,
        "npm run docs passed does not prove npm run test passed merely because both commands share a line",
      );
    },
  },
  {
    name: "current and historical operational claims without version tokens require evidence",
    run: () => {
      const current = truthfulnessPreflight({
        task: "The current production deployment is healthy and green.",
        initialDraft: "Operational status report.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      const historical = truthfulnessPreflight({
        task: "When the workflow began, the local cross-review runtime was healthy.",
        initialDraft: "Historical status report.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      const instruction = truthfulnessPreflight({
        task: "Verify current production health and report whether it is green.",
        initialDraft: "Review request, not a completed-work assertion.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });

      assert.deepEqual(
        {
          current_pass: current.pass,
          current_matched: current.current_state_claim_matched,
          current_issues: current.issue_classes,
          historical_pass: historical.pass,
          historical_matched: historical.historical_state_claim_matched,
          historical_issues: historical.issue_classes,
          instruction_pass: instruction.pass,
          instruction_current_matched: instruction.current_state_claim_matched,
        },
        {
          current_pass: false,
          current_matched: true,
          current_issues: ["unsupported_current_state_claim"],
          historical_pass: false,
          historical_matched: true,
          historical_issues: ["unsupported_historical_claim"],
          instruction_pass: true,
          instruction_current_matched: false,
        },
        "operational current/history claims must not disappear merely because they contain no version/date token",
      );
    },
  },
  {
    name: "current operational-state synonym requires correlated evidence",
    run: () => {
      const result = truthfulnessPreflight({
        task: "Production is fully operational.",
        initialDraft: "Operational status report.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      assert.deepEqual(
        {
          pass: result.pass,
          current_state_claim_matched: result.current_state_claim_matched,
          issue_classes: result.issue_classes,
        },
        {
          pass: false,
          current_state_claim_matched: true,
          issue_classes: ["unsupported_current_state_claim"],
        },
        "operational is a positive production-state assertion, not neutral prose",
      );
    },
  },
  {
    name: "current runtime snapshot cannot corroborate a historical workflow-start claim",
    run: () => {
      const claim = "When the workflow began, cross-review runtime version 4.5.0 was in use.";
      const currentSnapshot = "server_info current runtime_version=4.5.0";
      const evidencePath = "evidence/workflow-start-snapshot.txt";
      const evidenceSha = "c".repeat(64);
      const preflight = truthfulnessPreflight({
        task: claim,
        initialDraft: "Historical runtime report.",
        structuredEvidence: currentSnapshot,
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      const groundingInput = {
        artifactText: claim,
        attachedEvidenceText: "",
        attachmentRefs: [evidencePath],
        callerSubmittedAttachments: [
          {
            relative_path: evidencePath,
            sha256: evidenceSha,
            content: currentSnapshot,
          },
        ],
        requirePeerSubmittedCorroboration: preflight.independent_review_required,
        runtimeFacts: { runtime_version: "4.5.1" },
      } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
      const source = [
        `Attachment: ${evidencePath}`,
        `sha256=${evidenceSha}`,
        `"${currentSnapshot}"`,
      ].join("\n");
      const claude = groundReadyPeerEvidence(
        readyPeer("claude", "verified", [source]),
        groundingInput,
      );
      const gemini = groundReadyPeerEvidence(
        readyPeer("gemini", "verified", [source]),
        groundingInput,
      );
      const base = checkConvergence(
        ["claude", "gemini"],
        "READY",
        [claude.result, gemini.result],
        [],
      );
      const gated = blockConvergenceForPeerSubmittedEvidencePanel(base, {
        required: preflight.independent_review_required,
        corroborating_peers: [
          ...(claude.peer_submitted_evidence_corroborated ? (["claude"] as PeerId[]) : []),
          ...(gemini.peer_submitted_evidence_corroborated ? (["gemini"] as PeerId[]) : []),
        ],
      });

      assert.deepEqual(
        {
          claude_grounded: claude.grounded,
          gemini_grounded: gemini.grounded,
          panel_converged: gated.converged,
        },
        {
          claude_grounded: false,
          gemini_grounded: false,
          panel_converged: false,
        },
        "matching version text from a current snapshot does not prove what was loaded at workflow start",
      );
    },
  },
  {
    name: "unrelated start timestamp cannot temporalize a current runtime snapshot",
    run: () => {
      const claim = "When the workflow began, cross-review runtime version 4.5.0 was in use.";
      const mixedEvidence = [
        "workflow_started_at=2026-07-10T10:00:00Z",
        "server_info current runtime_version=4.5.0",
      ].join("\n");
      const evidencePath = "evidence/mixed-current-and-start-metadata.txt";
      const evidenceSha = "d".repeat(64);
      const preflight = truthfulnessPreflight({
        task: claim,
        initialDraft: "Historical runtime report.",
        structuredEvidence: mixedEvidence,
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.1" },
      });
      const source = [
        `Attachment: ${evidencePath}`,
        `sha256=${evidenceSha}`,
        '"workflow_started_at=2026-07-10T10:00:00Z"',
        '"server_info current runtime_version=4.5.0"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), {
        artifactText: claim,
        attachedEvidenceText: "",
        attachmentRefs: [evidencePath],
        callerSubmittedAttachments: [
          {
            relative_path: evidencePath,
            sha256: evidenceSha,
            content: mixedEvidence,
          },
        ],
        requirePeerSubmittedCorroboration: preflight.independent_review_required,
        runtimeFacts: { runtime_version: "4.5.1" },
      });

      assert.deepEqual(
        {
          grounded: grounding.grounded,
          corroborated: grounding.peer_submitted_evidence_corroborated,
        },
        {
          grounded: false,
          corroborated: false,
        },
        "a start timestamp and a current value on separate records do not prove the value at start",
      );
    },
  },
  {
    name: "two independent verified reviewers with path hash and raw value may converge",
    run: () => {
      const source = [
        `Attachment: ${PANEL_EVIDENCE_PATH}`,
        `sha256=${PANEL_EVIDENCE_SHA}`,
        '"COMMAND: npm test"',
        '"EXIT_CODE: 0"',
        '"Tests 74 passed (74)"',
      ].join("\n");
      const input = peerSubmittedGroundingInput("Implementation candidate under review.");
      const claude = groundReadyPeerEvidence(readyPeer("claude", "verified", [source]), input);
      const gemini = groundReadyPeerEvidence(readyPeer("gemini", "verified", [source]), input);

      assert.equal(claude.grounded, true);
      assert.equal(gemini.grounded, true);
      const convergence = checkConvergence(
        ["claude", "gemini"],
        "READY",
        [claude.result, gemini.result],
        [],
      );
      assert.equal(
        convergence.converged,
        true,
        "two independent strictly grounded READY votes must not require operator custody",
      );
    },
  },
  {
    name: "runUntilUnanimous evidence is transported verbatim to the reviewer prompt",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("structured-transport"));
      const evidence = [
        STRUCTURED_SENTINEL,
        "COMMAND: npm test",
        "Tests 99 passed, 0 failed",
        "EXIT_CODE: 0",
      ].join("\n");

      const result = await orchestrator.runUntilUnanimous({
        task: "Review this implementation candidate.",
        initial_draft: "Implementation candidate with no operational assertions in this draft.",
        evidence,
        caller: "codex",
        lead_peer: "claude",
        peers: ["claude", "codex", "gemini"],
        max_rounds: 1,
      });

      assert.ok(result.session.rounds.length >= 1, "the stub review round must be persisted");
      const firstRound = result.session.rounds[0];
      assert.ok(firstRound, "round 1 metadata must exist");
      const promptPath = path.join(
        orchestrator.store.sessionDir(result.session.session_id),
        firstRound.prompt_file,
      );
      const prompt = fs.readFileSync(promptPath, "utf8");
      assert.match(
        prompt,
        new RegExp(STRUCTURED_SENTINEL),
        "runUntilUnanimous.evidence must be included verbatim in the reviewer-facing prompt",
      );
    },
  },
  {
    name: "public saved-session preflight mirrors both runtime gates",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("combined-preflight"));
      const session = await orchestrator.store.init(
        "Review completed work: 74 passed.",
        "codex",
        [],
      );
      const combined = orchestrator.checkSessionPreflights({
        sessionId: session.session_id,
        task: session.task,
        draft: "No raw output is included here.",
        caller: "codex",
      });
      assert.equal(combined.truthfulness.pass, true);
      assert.equal(combined.evidence.pass, false);
      assert.equal(combined.pass, false);
      assert.deepEqual(combined.blocking_gates, ["evidence"]);

      const serverSource = fs.readFileSync(
        new URL("../src/mcp/server.ts", import.meta.url),
        "utf8",
      );
      assert.match(serverSource, /"session_preflight_check"/);
      assert.match(serverSource, /"session_truthfulness_preflight_check"/);
      assert.match(serverSource, /checkSessionPreflights\s*\(/);
    },
  },
  {
    name: "peer cannot acquire operator evidence authority through unanimous session continuation",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(
        regressionConfig("operator-owner-confusion"),
      );
      const session = await orchestrator.initSession(
        "Operator-owned session privilege-confusion fixture.",
        "operator",
      );
      let rejection: unknown;
      try {
        await orchestrator.runUntilUnanimous({
          session_id: session.session_id,
          task: session.task,
          initial_draft: "Implementation candidate.",
          evidence: "UNTRUSTED_CLAUDE_EVIDENCE_7a10",
          caller: "claude",
          lead_peer: "claude",
          peers: ["claude", "codex"],
          max_rounds: 1,
        });
      } catch (error) {
        rejection = error;
      }

      const persisted = orchestrator.store.read(session.session_id).evidence_files ?? [];
      const forgedOperatorEvidence = persisted.filter(
        (attachment) =>
          "attached_by" in attachment &&
          attachment.attached_by === "operator" &&
          attachment.origin === "caller_submitted",
      );
      assert.deepEqual(
        forgedOperatorEvidence,
        [],
        "evidence supplied by a peer invoker must never be persisted as operator-owned/operator-verified",
      );
      assert.match(
        rejection instanceof Error ? rejection.message : "",
        /session_owner_mismatch|session mutation|caller.*forbidden|authority/i,
        "a non-owner peer must be rejected before evidence persistence",
      );
    },
  },
  {
    name: "peer cannot forge a different peer owner through unanimous session continuation",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("peer-owner-confusion"));
      const session = await orchestrator.initSession(
        "Codex-owned session privilege-confusion fixture.",
        "codex",
      );
      let rejection: unknown;
      try {
        await orchestrator.runUntilUnanimous({
          session_id: session.session_id,
          task: session.task,
          initial_draft: "Implementation candidate.",
          evidence: "UNTRUSTED_CLAUDE_EVIDENCE_922b",
          caller: "claude",
          lead_peer: "gemini",
          peers: ["codex", "gemini", "deepseek"],
          max_rounds: 1,
        });
      } catch (error) {
        rejection = error;
      }

      const persisted = orchestrator.store.read(session.session_id).evidence_files ?? [];
      const forgedCodexEvidence = persisted.filter(
        (attachment) =>
          "attached_by" in attachment &&
          attachment.attached_by === "codex" &&
          attachment.origin === "caller_submitted",
      );
      assert.deepEqual(
        forgedCodexEvidence,
        [],
        "the runtime must attribute evidence to the authenticated invoker, never to the persisted petitioner",
      );
      assert.match(
        rejection instanceof Error ? rejection.message : "",
        /session_owner_mismatch|session mutation|caller.*forbidden|authority/i,
        "a peer other than the persisted petitioner must be rejected before evidence persistence",
      );
    },
  },
  {
    name: "round starter equivalent rejects non-owner inline evidence before mutation",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("round-owner-confusion"));
      const session = await orchestrator.initSession(
        "Operator-owned round starter: npm test reports 1 passed.",
        "operator",
      );
      await assert.rejects(
        orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: "COMMAND: npm test\nEXIT_CODE: 0\nTests 1 passed (1)",
          caller: "claude",
          peers: ["codex"],
        }),
        /session_owner_mismatch|session mutation|caller.*forbidden|authority/i,
        "session_start_round/ask_peers must reject a non-owner peer even when evidence is inline rather than in the evidence field",
      );
    },
  },
  {
    name: "askPeers rejects a forged petitioner tuple without mutating the persisted owner session",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("forged-petitioner"));
      const session = await orchestrator.initSession(
        "Operator-owned session for forged petitioner regression.",
        "operator",
      );
      const before = orchestrator.store.read(session.session_id);
      let rejection: unknown;

      try {
        await orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: "COMMAND: npm test\nEXIT_CODE: 0\nTests 1 passed (1)",
          petitioner: "codex",
          caller: "claude",
          lead_peer: "claude",
          peers: ["deepseek"],
        });
      } catch (error) {
        rejection = error;
      }

      const after = orchestrator.store.read(session.session_id);
      assert.match(
        rejection instanceof Error ? rejection.message : "",
        /session_owner_mismatch|petitioner.*mismatch|session mutation|authority/i,
        "an internal relator tuple cannot replace the persisted petitioner",
      );
      assert.deepEqual(
        after,
        before,
        "a rejected petitioner override must not append rounds, evidence, convergence scope, or terminal state",
      );
    },
  },
  {
    name: "askPeers legitimate relator continuation preserves owner and does not persist relator inline evidence",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("legitimate-relator"));
      const session = await orchestrator.initSession(
        "Codex-owned session for legitimate internal relator continuation.",
        "codex",
      );

      await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: [
          "Revision authored by the selected relator.",
          "COMMAND: npm test",
          "EXIT_CODE: 0",
          "Tests 1 passed (1)",
        ].join("\n"),
        petitioner: "codex",
        caller: "claude",
        lead_peer: "claude",
        peers: ["gemini", "deepseek"],
      });

      const persisted = orchestrator.store.read(session.session_id);
      assert.equal(persisted.caller, "codex", "the durable session owner must remain Codex");
      assert.equal(
        persisted.convergence_scope?.petitioner,
        "codex",
        "the convergence petitioner must remain the persisted owner",
      );
      assert.equal(
        persisted.convergence_scope?.acting_peer,
        "claude",
        "the relator remains separately attributable as the acting peer",
      );
      const relatorInlineAttachments = (persisted.evidence_files ?? []).filter(
        (attachment) =>
          "attached_by" in attachment &&
          attachment.attached_by === "claude" &&
          attachment.origin === "caller_submitted" &&
          attachment.label === "caller-inline-raw-evidence",
      );
      assert.deepEqual(
        relatorInlineAttachments,
        [],
        "a relator-authored revision must not be promoted into caller-submitted evidence for the petitioner's session",
      );
    },
  },
  {
    name: "runUntilUnanimous preserves an internal askPeers terminal abort",
    run: async () => {
      const orchestrator = new CrossReviewOrchestrator(regressionConfig("terminal-preservation"));
      const originalAskPeers = orchestrator.askPeers.bind(orchestrator);
      const originalFinalize = orchestrator.store.finalize.bind(orchestrator.store);
      let maxRoundsFinalizations = 0;

      orchestrator.store.finalize = async (sessionId, outcome, reason) => {
        if (outcome === "max-rounds") maxRoundsFinalizations += 1;
        return await originalFinalize(sessionId, outcome, reason);
      };
      orchestrator.askPeers = async (input) => {
        const roundResult = await originalAskPeers(input);
        const terminalSession = await orchestrator.store.finalize(
          roundResult.session.session_id,
          "aborted",
          "needs_evidence_preflight",
        );
        return {
          ...roundResult,
          session: terminalSession,
          converged: false,
        };
      };

      const result = await orchestrator.runUntilUnanimous({
        task: "Verify that an internal terminal state is not overwritten by the outer loop.",
        initial_draft: "FORCE_NOT_READY",
        caller: "operator",
        lead_peer: "claude",
        peers: ["claude", "codex"],
        max_rounds: 1,
      });

      assert.equal(
        result.session.outcome,
        "aborted",
        "outer convergence loop must return immediately when askPeers finalizes the session",
      );
      assert.equal(
        result.session.outcome_reason,
        "needs_evidence_preflight",
        "outer convergence loop must preserve the terminal reason produced by askPeers",
      );
      assert.equal(
        maxRoundsFinalizations,
        0,
        "outer convergence loop must not call finalize(max-rounds) after askPeers returns a terminal session",
      );
    },
  },
];

const failures: string[] = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[regression] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${regression.name}: ${message}`);
    console.error(`[regression] RED: ${regression.name}\n  ${message}`);
  }
}

assert.equal(
  failures.length,
  0,
  `evidence transport regressions remain:\n- ${failures.join("\n- ")}`,
);

console.log("[regression] evidence_transport: PASS");
