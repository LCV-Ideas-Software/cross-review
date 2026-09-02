import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import {
  buildDecisionRetryPrompt,
  buildFormatRecoveryPrompt,
  CrossReviewOrchestrator,
  groundReadyPeerEvidence,
  latestPeerResultsForQuorum,
  reviewedArtifactPromptView,
} from "../src/core/orchestrator.js";
import { sessionCostBreakdown } from "../src/core/reports.js";
import { type PersistedReviewedArtifact, SessionStore } from "../src/core/session-store.js";
import type {
  AppConfig,
  ConvergenceResult,
  ConvergenceScope,
  EvidenceAskJudgment,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerResult,
  ProviderPromptCustody,
  ResolvedEvidenceAttachment,
  ReviewStatus,
  SessionMeta,
} from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";
import { redact } from "../src/security/redact.js";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const tempRoots = new Set<string>();

function tempDataDir(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-artifact-${label}-`));
  tempRoots.add(root);
  return root;
}

async function fixture(label: string) {
  const dataDir = tempDataDir(label);
  const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
  const session = await store.init(`Reviewed artifact fixture ${label}`, "operator", []);
  return { dataDir, store, session };
}

async function generationWithPersistedPrompt(
  store: SessionStore,
  sessionId: string,
  round: number,
  result: GenerationResult,
  label: string,
): Promise<GenerationResult> {
  const prompt = await store.saveProviderPrompt(
    sessionId,
    round,
    result.peer,
    result.provider,
    result.model,
    "generation",
    label,
    `Persisted generation prompt for ${result.peer}/${round}/${label}`,
  );
  return { ...result, provider_prompt: prompt.custody };
}

function stubConfig(label: string): AppConfig {
  return {
    ...loadConfig(),
    data_dir: tempDataDir(label),
    stub: true,
    evidence_preflight_enabled: false,
    truthfulness_preflight_enabled: false,
  };
}

async function withConfirmedStubs<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CROSS_REVIEW_STUB_CONFIRMED;
  process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
    else process.env.CROSS_REVIEW_STUB_CONFIRMED = previous;
  }
}

const CIRCULAR_TEST_PEERS: readonly PeerId[] = [
  "codex",
  "claude",
  "gemini",
  "deepseek",
  "grok",
  "perplexity",
];

function circularAdapterFactory(
  create: (config: AppConfig, peer: PeerId) => PeerAdapter,
): ConstructorParameters<typeof CrossReviewOrchestrator>[2] {
  return ((config: AppConfig) =>
    Object.fromEntries(
      CIRCULAR_TEST_PEERS.map((peer) => [peer, create(config, peer)]),
    )) as ConstructorParameters<typeof CrossReviewOrchestrator>[2];
}

const RUNTIME_FACTS = {
  runtime_version: "4.6.5",
  release_date: "2026-09-01",
  model_pins: {},
} as const;

function persistedArtifact(content: string, round = 1): PersistedReviewedArtifact {
  return {
    artifact_kind: "reviewed_artifact",
    round,
    relative_path: `agent-runs/round-${round}-draft.md`,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function canonicalSource(
  artifact: PersistedReviewedArtifact,
  quote: string,
  location?: string,
): string {
  return [
    ...(location ? [`Location: ${location}`] : []),
    `Attachment: ${artifact.relative_path}`,
    `sha256=${artifact.sha256}`,
    `Artifact quote: "${quote}"`,
  ].join("\n");
}

function peerResult(status: ReviewStatus, sources: string[], summary?: string): PeerResult {
  return {
    peer: "claude",
    provider: "fixture",
    model: "fixture",
    raw_status: status,
    parsed_status: status,
    normalized_status: status,
    status,
    structured: {
      status,
      summary:
        summary ??
        (status === "READY" ? "No blocking objections remain." : "Additional evidence required."),
      confidence: "verified",
      evidence_sources: sources,
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

function peerResultWithCustody(
  artifact: PersistedReviewedArtifact,
  providerPrompt: ProviderPromptCustody,
  status: ReviewStatus = "READY",
): PeerResult {
  return {
    ...peerResult(status, []),
    review_custody: {
      dispatch_kind: "normal",
      reviewed_artifact: {
        relative_path: artifact.relative_path,
        sha256: artifact.sha256,
        visible_utf16_units: artifact.content.length,
        truncated: false,
      },
      visible_attachments: [],
      provider_prompt: providerPrompt,
    },
  };
}

async function fixtureProviderPrompt(
  store: SessionStore,
  sessionId: string,
  round: number,
  label: string,
): Promise<ProviderPromptCustody> {
  return (
    await store.saveProviderPrompt(
      sessionId,
      round,
      "claude",
      "fixture",
      "fixture",
      "peer_review",
      label,
      `Fixture provider prompt: ${label}`,
    )
  ).custody;
}

function groundingInput(
  artifact: PersistedReviewedArtifact,
  maxLength = artifact.content.length,
  overrides: Partial<Parameters<typeof groundReadyPeerEvidence>[1]> = {},
): Parameters<typeof groundReadyPeerEvidence>[1] {
  const view = reviewedArtifactPromptView(artifact, maxLength);
  return {
    artifactText: view.visible_content,
    attachedEvidenceText: "",
    attachmentRefs: [],
    runtimeFacts: RUNTIME_FACTS,
    reviewedArtifactSource: {
      artifact_kind: "reviewed_artifact",
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      content: artifact.content,
      truncated: false,
      visible_content: view.visible_content,
      visibility_truncated: view.truncated,
    },
    ...overrides,
  };
}

function convergence(converged: boolean): ConvergenceResult {
  return {
    converged,
    reason: converged ? "fixture unanimous" : "fixture blocked",
    ready_peers: converged ? ["claude", "codex"] : [],
    not_ready_peers: [],
    needs_evidence_peers: converged ? [] : ["claude"],
    rejected_peers: [],
    skipped_peers: [],
    decision_quality: {
      codex: "clean",
      claude: "clean",
      gemini: "clean",
      deepseek: "clean",
      grok: "clean",
      perplexity: "clean",
    },
    blocking_details: [],
  };
}

function convergenceScope(): ConvergenceScope {
  return {
    caller: "operator",
    caller_status: "READY",
    expected_peers: ["claude", "codex"],
    reviewer_peers: ["claude", "codex"],
  };
}

const regressions: Regression[] = [
  {
    name: "read-back authenticates the exact persisted redacted draft bytes",
    run: async () => {
      const { store, session } = await fixture("readback");
      const draft = "TOKEN=fixture-secret-value\nconst allow = true;\n";
      const relativePath = store.saveDraft(session.session_id, 1, draft);
      const reviewed = store.readReviewedArtifact(session.session_id, 1, draft);
      const persisted = redact(draft);

      assert.equal(relativePath, "agent-runs/round-1-draft.md");
      assert.deepEqual(reviewed, {
        artifact_kind: "reviewed_artifact",
        round: 1,
        relative_path: relativePath,
        sha256: crypto.createHash("sha256").update(persisted, "utf8").digest("hex"),
        bytes: Buffer.byteLength(persisted, "utf8"),
        content: persisted,
      });
      assert.ok(!reviewed.content.includes("fixture-secret-value"));
      assert.equal("origin" in reviewed, false);
      assert.equal("attached_by" in reviewed, false);
      assert.equal("provenance_status" in reviewed, false);
      assert.equal("authority_status" in reviewed, false);
    },
  },
  {
    name: "missing round drafts fail closed",
    run: async () => {
      const { store, session } = await fixture("missing");
      assert.throws(
        () => store.readReviewedArtifact(session.session_id, 1, "missing"),
        /reviewed_artifact_unavailable: agent-runs\/round-1-draft\.md/,
      );
    },
  },
  {
    name: "mutated round draft bytes fail closed",
    run: async () => {
      const { store, session } = await fixture("mutated");
      const draft = "const allow = true;\n";
      const relativePath = store.saveDraft(session.session_id, 2, draft);
      fs.writeFileSync(path.join(store.sessionDir(session.session_id), relativePath), "tampered\n");

      assert.throws(
        () => store.readReviewedArtifact(session.session_id, 2, draft),
        /reviewed_artifact_integrity_mismatch: agent-runs\/round-2-draft\.md/,
      );
    },
  },
  {
    name: "round append persists custody and revalidates the draft bytes",
    run: async () => {
      const { store, session } = await fixture("append-custody");
      const draft = "const appendCustody = true;\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const reviewed = store.readReviewedArtifact(session.session_id, 1, draft);
      const promptFile = store.savePrompt(session.session_id, 1, "fixture prompt");
      const round = await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: reviewed,
        prompt_file: promptFile,
        peers: [],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      assert.deepEqual(round.reviewed_artifact, {
        artifact_kind: "reviewed_artifact",
        relative_path: reviewed.relative_path,
        sha256: reviewed.sha256,
        bytes: reviewed.bytes,
      });
      assert.equal(store.read(session.session_id).reviewed_artifact_custody_schema_version, 1);
      assert.equal(store.readRoundReviewedArtifact(session.session_id, round).content, draft);
    },
  },
  {
    name: "recovery quorum never reuses a READY vote from different artifact bytes",
    run: async () => {
      const { store, session } = await fixture("recovery-artifact-lineage");
      const draftA = "const recoveryArtifact = 'A';\n";
      const draftAFile = store.saveDraft(session.session_id, 1, draftA);
      const artifactA = store.readReviewedArtifact(session.session_id, 1, draftA);
      const promptCustodyA = await fixtureProviderPrompt(store, session.session_id, 1, "fixture-a");
      await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftAFile,
        reviewed_artifact: artifactA,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt A"),
        peers: [peerResultWithCustody(artifactA, promptCustodyA)],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });

      const draftB = "const recoveryArtifact = 'B';\n";
      store.saveDraft(session.session_id, 2, draftB);
      const artifactB = store.readReviewedArtifact(session.session_id, 2, draftB);
      const promptCustodyB = await fixtureProviderPrompt(store, session.session_id, 2, "fixture-b");
      const unchangedRecoveryA = persistedArtifact(draftA, 2);
      const afterA = store.read(session.session_id);
      assert.deepEqual(
        latestPeerResultsForQuorum(afterA, [], ["claude"], unchangedRecoveryA, store, []).map(
          (peer) => peer.peer,
        ),
        ["claude"],
      );
      const historicalPromptPath = path.join(
        store.sessionDir(session.session_id),
        promptCustodyA.relative_path,
      );
      const historicalPromptBytes = fs.readFileSync(historicalPromptPath);
      fs.appendFileSync(historicalPromptPath, "tampered");
      assert.deepEqual(
        latestPeerResultsForQuorum(afterA, [], ["claude"], unchangedRecoveryA, store, []),
        [],
      );
      fs.writeFileSync(historicalPromptPath, historicalPromptBytes);
      assert.deepEqual(
        latestPeerResultsForQuorum(afterA, [], ["claude"], artifactB, store, []),
        [],
      );
      const attachmentAContent = "current evidence corpus A\n";
      const attachedEvidenceA = await store.attachEvidence(session.session_id, {
        label: "recovery-evidence",
        content: attachmentAContent,
        extension: "txt",
        attached_by: "operator",
        origin: "session_attach_evidence",
      });
      const attachmentA: ResolvedEvidenceAttachment = {
        label: "recovery-evidence",
        relative_path: attachedEvidenceA.path,
        content: attachmentAContent,
        bytes: Buffer.byteLength(attachmentAContent, "utf8"),
        truncated: false,
        provenance_status: "verified",
        authority_status: "operator_verified",
        sha256: crypto.createHash("sha256").update(attachmentAContent).digest("hex"),
      };
      const changedContent = "changed evidence corpus B\n";
      const changedAttachment: ResolvedEvidenceAttachment = {
        ...attachmentA,
        content: changedContent,
        bytes: Buffer.byteLength(changedContent, "utf8"),
        sha256: crypto.createHash("sha256").update(changedContent).digest("hex"),
      };
      const changedPathAttachment: ResolvedEvidenceAttachment = {
        ...attachmentA,
        relative_path: "evidence/replacement-evidence.txt",
      };
      const afterAWithEvidence = structuredClone(attachedEvidenceA.meta);
      const historicalCustody = afterAWithEvidence.rounds[0]?.peers[0]?.review_custody;
      assert.ok(historicalCustody);
      historicalCustody.visible_attachments = [
        {
          relative_path: attachmentA.relative_path,
          sha256: attachmentA.sha256 ?? "",
          visible_utf16_units: attachmentA.content.length,
          truncated: attachmentA.truncated,
        },
      ];
      assert.deepEqual(
        latestPeerResultsForQuorum(afterAWithEvidence, [], ["claude"], unchangedRecoveryA, store, [
          attachmentA,
        ]).map((peer) => peer.peer),
        ["claude"],
      );
      for (const activeAttachments of [[], [changedAttachment], [changedPathAttachment]]) {
        assert.deepEqual(
          latestPeerResultsForQuorum(
            afterAWithEvidence,
            [],
            ["claude"],
            unchangedRecoveryA,
            store,
            activeAttachments,
          ),
          [],
        );
      }
      const truncatedReady = structuredClone(afterA);
      const truncatedLineage =
        truncatedReady.rounds[0]?.peers[0]?.review_custody?.reviewed_artifact;
      assert.ok(truncatedLineage);
      truncatedLineage.truncated = true;
      truncatedLineage.visible_utf16_units -= 1;
      assert.deepEqual(
        latestPeerResultsForQuorum(truncatedReady, [], ["claude"], unchangedRecoveryA, store, []),
        [],
      );

      await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: artifactB.relative_path,
        reviewed_artifact: artifactB,
        prompt_file: store.savePrompt(session.session_id, 2, "fixture prompt B"),
        peers: [peerResultWithCustody(artifactB, promptCustodyB)],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      const afterB = store.read(session.session_id);
      assert.deepEqual(
        latestPeerResultsForQuorum(afterB, [], ["claude"], persistedArtifact(draftA, 3), store, []),
        [],
      );
    },
  },
  {
    name: "recovery quorum reauthenticates historical provider prompts inside appendRound",
    run: async () => {
      const { store, session } = await fixture("recovery-prompt-atomic-reauth");
      const draft = "const atomicRecoveryPrompt = true;\n";
      const draftFile1 = store.saveDraft(session.session_id, 1, draft);
      const artifact1 = store.readReviewedArtifact(session.session_id, 1, draft);
      const historicalPrompt = await fixtureProviderPrompt(
        store,
        session.session_id,
        1,
        "historical-recovery",
      );
      await store.appendRound(session.session_id, {
        review_kind: "reviewed_artifact",
        caller_status: "READY",
        draft_file: draftFile1,
        reviewed_artifact: artifact1,
        prompt_file: store.savePrompt(session.session_id, 1, "historical recovery prompt"),
        peers: [peerResultWithCustody(artifact1, historicalPrompt)],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });

      const draftFile2 = store.saveDraft(session.session_id, 2, draft);
      const artifact2 = store.readReviewedArtifact(session.session_id, 2, draft);
      const currentPrompt = (
        await store.saveProviderPrompt(
          session.session_id,
          2,
          "codex",
          "fixture",
          "fixture",
          "peer_review",
          "current-recovery",
          "Current recovery provider prompt",
        )
      ).custody;
      const currentPeer = peerResultWithCustody(artifact2, currentPrompt);
      currentPeer.peer = "codex";
      const historicalPromptPath = path.join(
        store.sessionDir(session.session_id),
        historicalPrompt.relative_path,
      );
      fs.appendFileSync(historicalPromptPath, "tampered");
      await assert.rejects(
        () =>
          store.appendRound(session.session_id, {
            review_kind: "reviewed_artifact",
            caller_status: "READY",
            draft_file: draftFile2,
            reviewed_artifact: artifact2,
            prompt_file: store.savePrompt(session.session_id, 2, "current recovery prompt"),
            peers: [currentPeer],
            rejected: [],
            convergence: {
              ...convergence(true),
              latest_round_converged: true,
              session_quorum_converged: true,
              recovery_converged: true,
              quorum_peers: ["claude", "codex"],
            },
            convergence_scope: convergenceScope(),
            started_at: new Date().toISOString(),
          }),
        /provider_prompt_integrity_mismatch/,
      );
      assert.equal(store.read(session.session_id).rounds.length, 1);
    },
  },
  {
    name: "session metadata rejects removed or mismatched reviewed-artifact custody",
    run: async () => {
      const { store, session } = await fixture("meta-custody-shape");
      const evidenceContent = "evidence 😀 custody\n";
      const attached = await store.attachEvidence(session.session_id, {
        label: "meta-custody-evidence",
        content: evidenceContent,
        extension: "txt",
        attached_by: "operator",
        origin: "session_attach_evidence",
      });
      const evidenceMeta = attached.meta.evidence_files?.find(
        (candidate) => candidate.path === attached.path,
      );
      assert.ok(evidenceMeta && "sha256" in evidenceMeta);
      const draft = "const metaCustody = '😀';\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const artifact = store.readReviewedArtifact(session.session_id, 1, draft);
      const promptCustody = await fixtureProviderPrompt(
        store,
        session.session_id,
        1,
        "meta-custody",
      );
      const reviewedPeer = peerResultWithCustody(artifact, promptCustody);
      assert.ok(reviewedPeer.review_custody);
      reviewedPeer.review_custody.visible_attachments = [
        {
          relative_path: attached.path,
          sha256: evidenceMeta.sha256,
          visible_utf16_units: evidenceContent.length,
          truncated: false,
        },
      ];
      await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: artifact,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
        peers: [reviewedPeer],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      const metaPath = path.join(store.sessionDir(session.session_id), "meta.json");
      const original = store.read(session.session_id);
      const writeMeta = (meta: unknown) => {
        fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
      };
      const expectInvalid = (mutate: (meta: SessionMeta) => void, pattern: RegExp) => {
        const tampered = structuredClone(original);
        mutate(tampered);
        writeMeta(tampered);
        assert.throws(() => store.read(session.session_id), pattern);
      };
      const expectCustodyFailure = (mutate: (meta: SessionMeta) => void, pattern: RegExp) => {
        const tampered = structuredClone(original);
        mutate(tampered);
        writeMeta(tampered);
        const parsed = store.read(session.session_id);
        assert.match(
          store.reviewedArtifactCustodyReportStatus(parsed).failures.join("\n"),
          pattern,
        );
        writeMeta(original);
      };

      try {
        expectInvalid((meta) => {
          delete meta.reviewed_artifact_custody_schema_version;
          delete meta.reviewed_artifact_custody_start_round;
          delete meta.rounds[0]?.reviewed_artifact;
          delete meta.rounds[0]?.peers[0]?.review_custody;
        }, /reviewed_artifact_custody_schema_version 1 is required/);
        expectInvalid((meta) => {
          if (meta.rounds[0]?.reviewed_artifact) {
            meta.rounds[0].reviewed_artifact.sha256 = "0".repeat(64);
          }
        }, /round 1 reviewed_artifact custody is invalid|does not match the round/);
        expectInvalid((meta) => {
          delete meta.rounds[0]?.peers[0]?.review_custody;
        }, /peers\[0\]\.review_custody is required/);
        expectInvalid((meta) => {
          const custody = meta.rounds[0]?.peers[0]?.review_custody;
          if (custody) delete (custody as Partial<typeof custody>).provider_prompt;
        }, /review_custody\.provider_prompt is required/);
        expectInvalid((meta) => {
          const prompt = meta.rounds[0]?.peers[0]?.review_custody?.provider_prompt;
          if (prompt) prompt.sha256 = "f".repeat(64);
        }, /provider_prompt does not match the dispatch ledger/);
        expectInvalid((meta) => {
          delete meta.provider_prompt_custody_schema_version;
          delete meta.provider_prompt_custody_start_round;
          delete meta.provider_prompt_files;
          const custody = meta.rounds[0]?.peers[0]?.review_custody;
          if (custody) delete (custody as Partial<typeof custody>).provider_prompt;
        }, /provider_prompt_custody_schema_version 1 is required/);
        expectInvalid((meta) => {
          delete meta.rounds[0]?.draft_file;
          delete meta.rounds[0]?.reviewed_artifact;
          delete meta.rounds[0]?.peers[0]?.review_custody;
        }, /reviewed_artifact round requires draft_file and custody/);
        expectCustodyFailure((meta) => {
          const lineage = meta.rounds[0]?.peers[0]?.review_custody?.reviewed_artifact;
          if (lineage) lineage.visible_utf16_units = artifact.bytes + 1;
        }, /review_custody reviewed artifact visibility is invalid/);
        expectCustodyFailure((meta) => {
          const lineage = meta.rounds[0]?.peers[0]?.review_custody?.reviewed_artifact;
          if (lineage) lineage.visible_utf16_units = artifact.content.length + 1;
        }, /review_custody reviewed artifact visibility is invalid/);
        expectCustodyFailure((meta) => {
          const lineage = meta.rounds[0]?.peers[0]?.review_custody?.reviewed_artifact;
          if (lineage) lineage.visible_utf16_units = artifact.content.length - 1;
        }, /review_custody reviewed artifact visibility is invalid/);
        expectCustodyFailure((meta) => {
          const lineage = meta.rounds[0]?.peers[0]?.review_custody?.reviewed_artifact;
          if (lineage) lineage.truncated = true;
        }, /review_custody reviewed artifact visibility is invalid/);
        expectInvalid((meta) => {
          const custody = meta.rounds[0]?.peers[0]?.review_custody;
          if (custody) {
            custody.visible_attachments = [
              {
                relative_path: "evidence/not-persisted.txt",
                sha256: "1".repeat(64),
                visible_utf16_units: 1,
                truncated: false,
              },
            ];
          }
        }, /is not a persisted evidence file/);

        const legacy = structuredClone(original);
        // The package already identified itself as 4.6.5 before this custody
        // schema existed. Marker absence, rather than the colliding package
        // version, is therefore the only safe legacy discriminator.
        delete legacy.reviewed_artifact_custody_schema_version;
        delete legacy.reviewed_artifact_custody_start_round;
        delete legacy.provider_prompt_custody_schema_version;
        delete legacy.provider_prompt_custody_start_round;
        delete legacy.provider_prompt_files;
        delete legacy.rounds[0]?.review_kind;
        delete legacy.rounds[0]?.reviewed_artifact;
        delete legacy.rounds[0]?.peers[0]?.review_custody;
        writeMeta(legacy);
        assert.equal(store.read(session.session_id).version, "4.6.5");
        assert.equal(
          store.list().some((candidate) => candidate.session_id === session.session_id),
          true,
        );
        assert.equal(fs.existsSync(store.metaPath(session.session_id)), true);
        assert.equal(fs.existsSync(`${store.metaPath(session.session_id)}.bad`), false);

        const legacyContinuationDraft = "const markerlessLegacyContinuation = true;\n";
        const legacyContinuationDraftFile = store.saveDraft(
          session.session_id,
          2,
          legacyContinuationDraft,
        );
        await store.appendRound(session.session_id, {
          caller_status: "READY",
          draft_file: legacyContinuationDraftFile,
          prompt_file: store.savePrompt(
            session.session_id,
            2,
            "Markerless legacy continuation prompt",
          ),
          peers: [peerResult("READY", [])],
          rejected: [],
          convergence: convergence(false),
          convergence_scope: convergenceScope(),
          started_at: new Date().toISOString(),
        });
        const legacyContinued = store.read(session.session_id);
        assert.equal(legacyContinued.reviewed_artifact_custody_schema_version, undefined);
        assert.equal(legacyContinued.rounds.length, 2);
        assert.equal(legacyContinued.rounds[1]?.review_kind, undefined);
        assert.equal(legacyContinued.rounds[1]?.reviewed_artifact, undefined);
        writeMeta(legacy);

        const legacyMetaBytes = fs.readFileSync(store.metaPath(session.session_id), "utf8");
        const originalRenameSync = fs.renameSync;
        Object.defineProperty(fs, "renameSync", {
          configurable: true,
          value: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (
              path.resolve(String(newPath)) === path.resolve(store.metaPath(session.session_id))
            ) {
              throw Object.assign(new Error("fixture legacy meta rename failure"), { code: "EIO" });
            }
            return originalRenameSync(oldPath, newPath);
          },
        });
        try {
          await assert.rejects(
            store.saveProviderPrompt(
              session.session_id,
              2,
              "claude",
              "fixture",
              "fixture",
              "peer_review",
              "legacy-upgrade-failed",
              "Legacy continuation prompt that must not be half-ledgered",
            ),
            /fixture legacy meta rename failure/,
          );
        } finally {
          Object.defineProperty(fs, "renameSync", {
            configurable: true,
            value: originalRenameSync,
          });
        }
        assert.equal(fs.readFileSync(store.metaPath(session.session_id), "utf8"), legacyMetaBytes);
        const failedUpgrade = store.read(session.session_id);
        assert.equal(failedUpgrade.provider_prompt_custody_schema_version, undefined);
        assert.equal(failedUpgrade.provider_prompt_custody_start_round, undefined);
        assert.equal(failedUpgrade.provider_prompt_files, undefined);
        assert.equal(
          fs
            .readdirSync(path.join(store.sessionDir(session.session_id), "agent-runs"))
            .some((name) => name.includes("legacy-upgrade-failed")),
          false,
        );

        const upgradedPrompt = await store.saveProviderPrompt(
          session.session_id,
          2,
          "claude",
          "fixture",
          "fixture",
          "peer_review",
          "legacy-upgrade",
          "Legacy continuation prompt",
        );
        const promptUpgraded = store.read(session.session_id);
        assert.equal(promptUpgraded.provider_prompt_custody_schema_version, 1);
        assert.equal(promptUpgraded.provider_prompt_custody_start_round, 2);
        assert.equal(promptUpgraded.provider_prompt_files?.length, 1);
        const firstPromptArtifact = promptUpgraded.provider_prompt_files?.[0];
        assert.ok(firstPromptArtifact);
        assert.equal(firstPromptArtifact.relative_path, upgradedPrompt.custody.relative_path);
        assert.equal(firstPromptArtifact.sha256, upgradedPrompt.custody.sha256);
        assert.equal(firstPromptArtifact.bytes, upgradedPrompt.custody.bytes);
        assert.equal(firstPromptArtifact.utf16_units, upgradedPrompt.custody.utf16_units);
        assert.equal(
          fs.readFileSync(
            path.join(store.sessionDir(session.session_id), firstPromptArtifact.relative_path),
            "utf8",
          ),
          upgradedPrompt.content,
        );
        await store.saveProviderPrompt(
          session.session_id,
          2,
          "codex",
          "fixture",
          "fixture",
          "evidence_judge",
          "legacy-second-prompt",
          "Second legacy continuation prompt",
        );
        const twiceUpgraded = store.read(session.session_id);
        assert.equal(twiceUpgraded.provider_prompt_custody_start_round, 2);
        assert.equal(twiceUpgraded.provider_prompt_files?.length, 2);

        const continuationDraft = "const legacyContinuation = true;\n";
        const continuationDraftFile = store.saveDraft(session.session_id, 2, continuationDraft);
        const continuationArtifact = store.readReviewedArtifact(
          session.session_id,
          2,
          continuationDraft,
        );
        await store.appendRound(session.session_id, {
          review_kind: "reviewed_artifact",
          caller_status: "READY",
          draft_file: continuationDraftFile,
          reviewed_artifact: continuationArtifact,
          prompt_file: store.savePrompt(session.session_id, 2, upgradedPrompt.content),
          peers: [peerResultWithCustody(continuationArtifact, upgradedPrompt.custody)],
          rejected: [],
          convergence: convergence(false),
          convergence_scope: convergenceScope(),
          started_at: new Date().toISOString(),
        });
        const fullyUpgraded = store.read(session.session_id);
        assert.equal(fullyUpgraded.reviewed_artifact_custody_schema_version, 1);
        assert.equal(fullyUpgraded.reviewed_artifact_custody_start_round, 2);
        assert.equal(fullyUpgraded.rounds.length, 2);
      } finally {
        writeMeta(original);
      }
      assert.equal(
        store.reviewedArtifactCustodyReportStatus(store.read(session.session_id)).status,
        "verified",
      );
      const evidencePath = path.join(store.sessionDir(session.session_id), attached.path);
      fs.writeFileSync(evidencePath, "mutated evidence bytes\n", "utf8");
      const attachmentStatus = store.reviewedArtifactCustodyReportStatus(
        store.read(session.session_id),
      );
      assert.equal(attachmentStatus.status, "FAILED");
      assert.match(attachmentStatus.failures.join("\n"), /peer attachment custody 0/);
      const doctor = await store.sessionDoctor();
      assert.equal(doctor.totals.reviewed_artifact_custody_failure_sessions, 1);

      fs.writeFileSync(evidencePath, evidenceContent, "utf8");
      assert.equal(
        store.reviewedArtifactCustodyReportStatus(store.read(session.session_id)).status,
        "verified",
      );
      fs.unlinkSync(evidencePath);
      let missingStatus = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(missingStatus.status, "FAILED");
      assert.match(missingStatus.failures.join("\n"), /evidence_integrity_unavailable/);
      fs.mkdirSync(evidencePath);
      missingStatus = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(missingStatus.status, "FAILED");
      assert.match(missingStatus.failures.join("\n"), /evidence_integrity_not_regular_file/);
      fs.rmdirSync(evidencePath);

      fs.writeFileSync(evidencePath, evidenceContent, "utf8");
      const evidenceDirectory = path.dirname(evidencePath);
      const savedEvidenceDirectory = `${evidenceDirectory}-contained-original`;
      const redirectedDirectory = path.join(tempDataDir("redirected-evidence"), "outside");
      fs.mkdirSync(redirectedDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(redirectedDirectory, path.basename(evidencePath)),
        evidenceContent,
        "utf8",
      );
      fs.renameSync(evidenceDirectory, savedEvidenceDirectory);
      try {
        fs.symlinkSync(redirectedDirectory, evidenceDirectory, "junction");
        const redirectedStatus = store.reviewedArtifactCustodyReportStatus(
          store.read(session.session_id),
        );
        assert.equal(redirectedStatus.status, "FAILED");
        assert.match(redirectedStatus.failures.join("\n"), /evidence_integrity_path_not_contained/);
      } finally {
        if (fs.existsSync(evidenceDirectory)) {
          fs.unlinkSync(evidenceDirectory);
        }
        fs.renameSync(savedEvidenceDirectory, evidenceDirectory);
      }
    },
  },
  {
    name: "round append validates attachment visibility against authenticated UTF-16 text",
    run: async () => {
      const runInvalid = async (
        label: string,
        mutate: (
          custody: NonNullable<PeerResult["review_custody"]>["visible_attachments"][number],
        ) => void,
      ) => {
        const { store, session } = await fixture(`attachment-visibility-${label}`);
        const content = "attachment 😀 evidence\n";
        const attached = await store.attachEvidence(session.session_id, {
          label,
          content,
          extension: "txt",
          attached_by: "operator",
          origin: "session_attach_evidence",
        });
        const evidence = attached.meta.evidence_files?.find(
          (candidate) => candidate.path === attached.path,
        );
        assert.ok(evidence && "sha256" in evidence);
        const draft = `const ${label.replace(/-/g, "_")} = true;\n`;
        const draftFile = store.saveDraft(session.session_id, 1, draft);
        const artifact = store.readReviewedArtifact(session.session_id, 1, draft);
        const promptCustody = await fixtureProviderPrompt(
          store,
          session.session_id,
          1,
          `attachment-${label}`,
        );
        const peer = peerResultWithCustody(artifact, promptCustody);
        assert.ok(peer.review_custody);
        const attachment = {
          relative_path: attached.path,
          sha256: evidence.sha256,
          visible_utf16_units: content.length,
          truncated: false,
        };
        mutate(attachment);
        peer.review_custody.visible_attachments = [attachment];
        await assert.rejects(
          () =>
            store.appendRound(session.session_id, {
              caller_status: "READY",
              draft_file: draftFile,
              reviewed_artifact: artifact,
              prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
              peers: [peer],
              rejected: [],
              convergence: convergence(false),
              convergence_scope: convergenceScope(),
              started_at: new Date().toISOString(),
            }),
          /peer attachment custody 0 visibility is invalid/,
        );
      };

      await runInvalid("too-long", (custody) => {
        custody.visible_utf16_units += 1;
      });
      await runInvalid("short-untruncated", (custody) => {
        custody.visible_utf16_units -= 1;
      });
      await runInvalid("false-truncation", (custody) => {
        custody.truncated = true;
      });
    },
  },
  {
    name: "circular revisions retain provider-result custody without claiming reviewed-artifact custody",
    run: async () => {
      const store = new SessionStore({
        ...loadConfig(),
        data_dir: tempDataDir("circular-custody-scope"),
      });
      const session = await store.init(
        "Circular custody scope fixture",
        "operator",
        [],
        undefined,
        "circular",
      );
      await store.setCircularState(session.session_id, {
        rotation_order: ["claude", "codex"],
        consecutive_no_change_count: 0,
        last_revision_round: null,
        next_cursor: 0,
      });
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "fixture",
        model: "fixture",
        label: "rotation",
        round: 1,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      const generation = await generationWithPersistedPrompt(
        store,
        session.session_id,
        1,
        {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          text: "Circular unchanged fixture.\n",
          raw: { fixture: "circular-unchanged" },
          latency_ms: 1,
          attempts: 1,
          parser_warnings: [],
        },
        "rotation",
      );
      await store.saveGeneration(session.session_id, 1, generation, "rotation", undefined, {
        defer_circular_promotion: true,
      });
      const circularPeer = peerResult("READY", []);
      circularPeer.text = generation.text;
      circularPeer.raw = generation.raw;
      await store.appendRound(session.session_id, {
        review_kind: "circular_revision",
        caller_status: "READY",
        prompt_file: store.savePrompt(session.session_id, 1, "circular fixture prompt"),
        peers: [circularPeer],
        rejected: [],
        convergence: convergence(true),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
        circular_state: {
          rotation_order: ["claude", "codex"],
          consecutive_no_change_count: 2,
          last_revision_round: null,
          next_cursor: 0,
        },
        promote_staged_generation: true,
      });
      const persisted = store.read(session.session_id);
      assert.equal(persisted.rounds[0]?.review_kind, "circular_revision");
      assert.equal(persisted.rounds[0]?.reviewed_artifact, undefined);
      assert.equal(persisted.rounds[0]?.provider_result?.artifact_kind, "provider_result");
      assert.equal(store.reviewedArtifactCustodyReportStatus(persisted).status, "verified");
      const finalized = await store.finalize(
        session.session_id,
        "converged",
        "circular_rotation_unchanged",
      );
      assert.equal(finalized.outcome, "converged");
      assert.equal(store.reviewedArtifactCustodyReportStatus(finalized).status, "verified");
      assert.equal(
        fs.existsSync(path.join(store.sessionDir(session.session_id), "final.md")),
        false,
      );
    },
  },
  {
    name: "crash recovery seals circular convergence only from an authenticated provider result",
    run: async () => {
      const prepare = async (label: string, holdInFlight: boolean) => {
        const store = new SessionStore({ ...loadConfig(), data_dir: tempDataDir(label) });
        const session = await store.init(label, "operator", [], undefined, "circular");
        const state = {
          rotation_order: ["claude", "codex"] as PeerId[],
          consecutive_no_change_count: 2,
          last_revision_round: null,
          next_cursor: 0,
        };
        await store.setCircularState(session.session_id, state);
        if (holdInFlight) {
          await store.markInFlight(session.session_id, {
            round: 1,
            peers: ["claude"],
            started_at: new Date().toISOString(),
            scope: convergenceScope(),
          });
        } else {
          await store.markBackgroundJobRunning(session.session_id, {
            job_id: crypto.randomUUID(),
            owner_pid: 999_999_999,
          });
        }
        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          label: "rotation",
          round: 1,
          started_at: new Date().toISOString(),
          owner_pid: process.pid,
        });
        const generation = await generationWithPersistedPrompt(
          store,
          session.session_id,
          1,
          {
            peer: "claude",
            provider: "fixture",
            model: "fixture",
            text: "Recovered circular convergence fixture.\n",
            raw: { fixture: label },
            latency_ms: 1,
            attempts: 1,
            parser_warnings: [],
          },
          "rotation",
        );
        const providerPath = await store.saveGeneration(
          session.session_id,
          1,
          generation,
          "rotation",
          undefined,
          { defer_circular_promotion: true },
        );
        const peer = peerResult("READY", []);
        peer.text = generation.text;
        peer.raw = generation.raw;
        await store.appendRound(session.session_id, {
          review_kind: "circular_revision",
          caller_status: "READY",
          prompt_file: store.savePrompt(session.session_id, 1, "circular recovery prompt"),
          peers: [peer],
          rejected: [],
          convergence: convergence(true),
          convergence_scope: convergenceScope(),
          started_at: new Date().toISOString(),
          hold_in_flight_for_finalize: holdInFlight,
          circular_state: state,
          promote_staged_generation: true,
        });
        if (holdInFlight) {
          const meta = store.read(session.session_id);
          assert.ok(meta.in_flight);
          meta.in_flight.owner_pid = 0;
          fs.writeFileSync(
            store.metaPath(session.session_id),
            `${JSON.stringify(meta, null, 2)}\n`,
          );
        }
        return { store, sessionId: session.session_id, providerPath };
      };

      const authentic = await prepare("circular-converged-orphan", false);
      const recovered = await authentic.store.recoverInterruptedSessions(new Set());
      const terminal = authentic.store.read(authentic.sessionId);
      assert.equal(
        recovered.some((session) => session.session_id === authentic.sessionId),
        true,
      );
      assert.equal(terminal.outcome, "converged");
      assert.equal(terminal.outcome_reason, "circular_full_rotation_no_change");
      assert.equal(terminal.convergence_health?.state, "converged");
      assert.equal(
        authentic.store.reviewedArtifactCustodyReportStatus(terminal).status,
        "verified",
      );

      for (const holdInFlight of [false, true]) {
        const tampered = await prepare(`circular-converged-tampered-${holdInFlight}`, holdInFlight);
        fs.appendFileSync(
          path.join(tampered.store.sessionDir(tampered.sessionId), tampered.providerPath),
          "tampered",
        );
        assert.equal(
          tampered.store.reviewedArtifactCustodyReportStatus(
            tampered.store.read(tampered.sessionId),
          ).status,
          "FAILED",
        );
        await tampered.store.recoverInterruptedSessions(new Set());
        const blocked = tampered.store.read(tampered.sessionId);
        assert.equal(blocked.outcome, undefined);
        assert.equal(tampered.store.reviewedArtifactCustodyReportStatus(blocked).status, "FAILED");
      }
    },
  },
  {
    name: "new sessions persist their mode and circular settlements stay staged until atomic promotion",
    run: async () => {
      const config = { ...loadConfig(), data_dir: tempDataDir("circular-settlement-stage") };
      const store = new SessionStore(config);
      const session = await store.init(
        "Circular settlement fixture",
        "operator",
        [],
        undefined,
        "circular",
      );
      assert.equal(session.mode, "circular");
      await store.setCircularState(session.session_id, {
        rotation_order: ["claude", "codex"],
        consecutive_no_change_count: 0,
        last_revision_round: null,
        next_cursor: 0,
      });
      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "fixture",
        model: "fixture",
        label: "rotation",
        round: 1,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      const generation = await generationWithPersistedPrompt(
        store,
        session.session_id,
        1,
        {
          peer: "claude" as const,
          provider: "fixture",
          model: "fixture",
          text: "Circular staged result.\n",
          raw: { fixture: true },
          usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          cost: {
            currency: "USD",
            input_cost: 0.01,
            output_cost: 0.02,
            total_cost: 0.03,
            estimated: false,
            source: "configured-rate",
          },
          latency_ms: 1,
          attempts: 1,
          parser_warnings: [],
        },
        "rotation",
      );
      const stagedPath = await store.saveGeneration(
        session.session_id,
        1,
        generation,
        "rotation",
        undefined,
        { defer_circular_promotion: true },
      );
      const staged = store.read(session.session_id);
      assert.equal(staged.mode, "circular");
      assert.equal(staged.generation_in_flight?.settled_result_path, stagedPath);
      assert.equal(staged.generation_in_flight?.settled_result_sha256?.length, 64);
      assert.equal(staged.rounds.length, 0);
      const stagedGeneration = store.readStagedCircularGeneration(session.session_id, 1, "claude");
      assert.equal(stagedGeneration?.text, generation.text);
      const circularPeer = peerResult("NOT_READY", []);
      circularPeer.text = generation.text;
      circularPeer.raw = generation.raw;
      circularPeer.usage = generation.usage;
      circularPeer.cost = generation.cost;
      const circularRound: Parameters<SessionStore["appendRound"]>[1] = {
        review_kind: "circular_revision",
        caller_status: "READY",
        prompt_file: store.savePrompt(session.session_id, 1, "circular staged prompt"),
        peers: [circularPeer],
        rejected: [],
        convergence: convergence(false),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
        circular_state: {
          rotation_order: ["claude", "codex"],
          consecutive_no_change_count: 0,
          last_revision_round: 1,
          next_cursor: 1,
        },
        promote_staged_generation: true,
      };
      const providerPromptPath = generation.provider_prompt?.relative_path;
      assert.ok(providerPromptPath);
      const absoluteProviderPromptPath = path.join(
        store.sessionDir(session.session_id),
        providerPromptPath,
      );
      const originalProviderPrompt = fs.readFileSync(absoluteProviderPromptPath);
      fs.appendFileSync(absoluteProviderPromptPath, "tampered");
      await assert.rejects(
        () => store.appendRound(session.session_id, circularRound),
        /provider_prompt_integrity_mismatch/,
      );
      assert.equal(store.read(session.session_id).generation_in_flight !== undefined, true);
      fs.writeFileSync(absoluteProviderPromptPath, originalProviderPrompt);
      await store.appendRound(session.session_id, circularRound);
      const promoted = store.read(session.session_id);
      const promotedProviderResult = (
        promoted.rounds[0] as (typeof promoted.rounds)[number] & {
          provider_result?: {
            artifact_kind: "provider_result";
            relative_path: string;
            sha256: string;
            bytes: number;
          };
        }
      ).provider_result;
      assert.equal(promoted.generation_in_flight, undefined);
      assert.equal(promoted.rounds.length, 1);
      assert.equal(promoted.circular_state?.next_cursor, 1);
      assert.deepEqual(promotedProviderResult, {
        artifact_kind: "provider_result",
        relative_path: stagedPath,
        sha256: staged.generation_in_flight?.settled_result_sha256,
        bytes: staged.generation_in_flight?.settled_result_bytes,
      });
      assert.equal(promoted.generation_files?.length ?? 0, 0);
      assert.equal(promoted.totals.cost.total_cost, 0.03);
      assert.deepEqual(promoted.costs_per_round, [0.03]);

      await store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "codex",
        provider: "fixture",
        model: "fixture",
        label: "rotation",
        round: 2,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });
      await store.saveGeneration(
        session.session_id,
        2,
        await generationWithPersistedPrompt(
          store,
          session.session_id,
          2,
          { ...generation, peer: "codex", text: "Unusable staged result.\n" },
          "rotation",
        ),
        "rotation",
        undefined,
        { defer_circular_promotion: true },
      );
      await store.promoteRejectedCircularGeneration(session.session_id, {
        rotation_order: ["claude", "codex"],
        consecutive_no_change_count: 0,
        last_revision_round: 1,
        next_cursor: 0,
      });
      const rejectedPromoted = store.read(session.session_id);
      assert.equal(rejectedPromoted.generation_in_flight, undefined);
      assert.equal(rejectedPromoted.generation_files?.length, 1);
      assert.equal(rejectedPromoted.generation_files?.[0]?.round, 2);
      assert.equal(rejectedPromoted.circular_state?.next_cursor, 0);
      assert.equal(rejectedPromoted.rounds.length, 1);
      fs.appendFileSync(path.join(store.sessionDir(session.session_id), stagedPath), "tampered");
      assert.equal(
        store.reviewedArtifactCustodyReportStatus(store.read(session.session_id)).status,
        "FAILED",
      );
    },
  },
  {
    name: "a rejected circular attempt can advance to a valid peer without stranding custody",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-reject-then-valid");
        const initialDraft = "Stable circular artifact.\n";
        let calls = 0;
        class RejectThenValidAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            calls += 1;
            const result = await super.generate(prompt, context);
            if (calls === 1) return { ...result, text: "", raw: { fixture: "rejected" } };
            return {
              ...result,
              text: initialDraft,
              raw: { fixture: "accepted" },
              usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
              cost: {
                currency: "USD",
                input_cost: 0.01,
                output_cost: 0.02,
                total_cost: 0.03,
                estimated: false,
                source: "configured-rate",
              },
              unpriced_attempts: 1,
              indeterminate_spend_attempts: 1,
            };
          }
        }
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new RejectThenValidAdapter(factoryConfig, peer),
          ),
        );
        const output = await orchestrator.runUntilUnanimous({
          task: "Advance after one rejected circular attempt.",
          initial_draft: initialDraft,
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 2,
        });
        assert.equal(calls, 2);
        assert.equal(output.session.rounds.length, 1);
        assert.equal(
          output.session.generation_files?.filter((artifact) => artifact.label === "rotation")
            .length,
          1,
        );
        assert.equal(output.session.generation_in_flight, undefined);
        assert.equal(output.session.rounds[0]?.peers[0]?.unpriced_attempts, 1);
        assert.equal(output.session.rounds[0]?.peers[0]?.indeterminate_spend_attempts, 1);
        const breakdown = sessionCostBreakdown(output.session);
        assert.equal(breakdown.unpriced_failed_attempts, 1);
        assert.equal(breakdown.reconciled, false);
      }),
  },
  {
    name: "two rejected circular attempts terminalize without a stranded marker",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-two-rejections");
        let calls = 0;
        class AlwaysRejectAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            calls += 1;
            const result = await super.generate(prompt, context);
            return { ...result, text: "", raw: { fixture: `rejected-${calls}` } };
          }
        }
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new AlwaysRejectAdapter(factoryConfig, peer),
          ),
        );
        const output = await orchestrator.runUntilUnanimous({
          task: "Terminalize repeated rejected circular attempts.",
          initial_draft: "Stable circular artifact.\n",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 2,
        });
        assert.equal(calls, 2);
        assert.equal(output.session.outcome, "aborted");
        assert.equal(output.session.generation_in_flight, undefined);
        assert.equal(
          output.session.generation_files?.filter((artifact) => artifact.label === "rotation")
            .length,
          2,
        );
      }),
  },
  {
    name: "normal and circular generation settlement reject tampered provider prompts including round zero",
    run: async () => {
      const exercise = async (
        label: string,
        mode: "ship" | "circular",
        round: number,
        generationLabel: "initial-draft" | "rotation",
        deferCircularPromotion: boolean,
      ) => {
        const store = new SessionStore({
          ...loadConfig(),
          data_dir: tempDataDir(`generation-prompt-tamper-${label}`),
        });
        const session = await store.init(
          `Generation prompt tamper ${label}`,
          "operator",
          [],
          undefined,
          mode,
        );
        if (mode === "circular") {
          await store.setCircularState(session.session_id, {
            rotation_order: ["codex", "claude"],
            consecutive_no_change_count: 0,
            last_revision_round: null,
            next_cursor: 0,
          });
        }
        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "codex",
          provider: "fixture",
          model: "fixture",
          label: generationLabel,
          round,
          started_at: new Date().toISOString(),
          owner_pid: process.pid,
        });
        const prompt = await store.saveProviderPrompt(
          session.session_id,
          round,
          "codex",
          "fixture",
          "fixture",
          "generation",
          generationLabel,
          `Authentic generation prompt ${label}`,
        );
        fs.writeFileSync(
          path.join(store.sessionDir(session.session_id), prompt.custody.relative_path),
          `Tampered generation prompt ${label}\n`,
          "utf8",
        );
        await assert.rejects(
          store.saveGeneration(
            session.session_id,
            round,
            {
              peer: "codex",
              provider: "fixture",
              model: "fixture",
              text: `Generation result ${label}\n`,
              raw: { label },
              latency_ms: 1,
              attempts: 1,
              parser_warnings: [],
              provider_prompt: prompt.custody,
            },
            generationLabel,
            undefined,
            { defer_circular_promotion: deferCircularPromotion },
          ),
          /provider_prompt_integrity_mismatch/,
        );
      };

      await exercise("normal-round-zero", "ship", 0, "initial-draft", false);
      await exercise("circular-round-zero", "circular", 0, "initial-draft", true);
      await exercise("circular-round-one", "circular", 1, "rotation", true);
    },
  },
  {
    name: "circular cancellation consumes an already-settled generation exactly once",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-settled-cancellation");
        const store = new SessionStore(config);
        const session = await store.init(
          "Cancel after a circular provider result settles.",
          "operator",
          [],
          undefined,
          "circular",
        );
        await store.setCircularState(session.session_id, {
          rotation_order: ["claude", "codex"],
          consecutive_no_change_count: 0,
          last_revision_round: null,
          next_cursor: 0,
        });
        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          label: "rotation",
          round: 1,
          started_at: new Date().toISOString(),
          owner_pid: process.pid,
        });
        const settledGeneration: GenerationResult = {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          text: "Settled circular result before cancellation.\n",
          raw: { fixture: "settled-before-cancellation" },
          usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          cost: {
            currency: "USD",
            input_cost: 0.01,
            output_cost: 0.02,
            total_cost: 0.03,
            estimated: false,
            source: "configured-rate",
          },
          latency_ms: 5,
          attempts: 1,
          parser_warnings: [],
        };
        const stagedPath = await store.saveGeneration(
          session.session_id,
          1,
          await generationWithPersistedPrompt(
            store,
            session.session_id,
            1,
            settledGeneration,
            "rotation",
          ),
          "rotation",
          undefined,
          { defer_circular_promotion: true },
        );
        const beforeCancellation = store.read(session.session_id);
        const settledMarker = beforeCancellation.generation_in_flight;
        assert.ok(settledMarker?.settled_result_path);
        assert.equal(settledMarker.settled_result_path, stagedPath);
        assert.equal(beforeCancellation.totals.cost.total_cost, 0.03);

        const cancelled = await store.markCancelled(session.session_id, "session_cancelled");
        const exactArtifacts = (cancelled.generation_files ?? []).filter(
          (artifact) => artifact.path === stagedPath,
        );
        const fabricatedUnknownAttempts = (cancelled.failed_attempts ?? []).filter(
          (failure) =>
            (failure.indeterminate_spend_attempts ?? 0) > 0 ||
            /possible initial\/background generation attempt interrupted/i.test(failure.message),
        );
        assert.deepEqual(
          {
            outcome: cancelled.outcome,
            outcomeReason: cancelled.outcome_reason,
            markerPresent: cancelled.generation_in_flight !== undefined,
            exactArtifactCount: exactArtifacts.length,
            fabricatedUnknownAttemptCount: fabricatedUnknownAttempts.length,
            totalCost: cancelled.totals.cost.total_cost,
            stagedFileStillExists: fs.existsSync(
              path.join(store.sessionDir(session.session_id), stagedPath),
            ),
          },
          {
            outcome: "aborted",
            outcomeReason: "session_cancelled",
            markerPresent: false,
            exactArtifactCount: 1,
            fabricatedUnknownAttemptCount: 0,
            totalCost: 0.03,
            stagedFileStillExists: true,
          },
        );
        const exactArtifact = exactArtifacts[0];
        assert.equal(exactArtifact?.sha256, settledMarker.settled_result_sha256);
        assert.equal(exactArtifact?.bytes, settledMarker.settled_result_bytes);
        assert.deepEqual(exactArtifact?.usage, settledGeneration.usage);
        assert.deepEqual(exactArtifact?.cost, settledGeneration.cost);

        await store.recoverInterruptedSessions();
        const afterRecovery = store.read(session.session_id);
        assert.equal(afterRecovery.generation_files?.length, 1);
        assert.equal(afterRecovery.failed_attempts?.length ?? 0, 0);
        const idempotentCancellation = await store.markCancelled(
          session.session_id,
          "session_cancelled",
        );
        assert.equal(idempotentCancellation.generation_files?.length, 1);

        // Crash boundary: the cancellation request is durable, the provider
        // result is settled, but the owner dies before calling markCancelled.
        const crashSession = await store.init(
          "Recover cancellation after a circular provider result settles.",
          "operator",
          [],
          undefined,
          "circular",
        );
        await store.setCircularState(crashSession.session_id, {
          rotation_order: ["codex", "claude"],
          consecutive_no_change_count: 0,
          last_revision_round: null,
          next_cursor: 0,
        });
        await store.markBackgroundGenerationInFlight(crashSession.session_id, {
          peer: "codex",
          provider: "fixture",
          model: "fixture",
          label: "rotation",
          round: 1,
          started_at: new Date().toISOString(),
          owner_pid: 0,
        });
        const recoveredStagedPath = await store.saveGeneration(
          crashSession.session_id,
          1,
          await generationWithPersistedPrompt(
            store,
            crashSession.session_id,
            1,
            { ...settledGeneration, peer: "codex" },
            "rotation",
          ),
          "rotation",
          undefined,
          { defer_circular_promotion: true },
        );
        await store.requestCancellation(crashSession.session_id, "fixture_cancel_before_crash");
        await store.recoverInterruptedSessions();
        const recoveredCancellation = store.read(crashSession.session_id);
        assert.deepEqual(
          {
            outcome: recoveredCancellation.outcome,
            outcomeReason: recoveredCancellation.outcome_reason,
            controlStatus: recoveredCancellation.control?.status,
            requestedReason: recoveredCancellation.control?.reason,
            markerPresent: recoveredCancellation.generation_in_flight !== undefined,
            exactArtifactCount: (recoveredCancellation.generation_files ?? []).filter(
              (artifact) => artifact.path === recoveredStagedPath,
            ).length,
            fabricatedUnknownAttemptCount: (recoveredCancellation.failed_attempts ?? []).filter(
              (failure) => (failure.indeterminate_spend_attempts ?? 0) > 0,
            ).length,
            totalCost: recoveredCancellation.totals.cost.total_cost,
          },
          {
            outcome: "aborted",
            outcomeReason: "session_cancelled",
            controlStatus: "cancelled",
            requestedReason: "fixture_cancel_before_crash",
            markerPresent: false,
            exactArtifactCount: 1,
            fabricatedUnknownAttemptCount: 0,
            totalCost: 0.03,
          },
        );

        let providerCalls = 0;
        class CountingAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            providerCalls += 1;
            return super.generate(prompt, context);
          }
        }
        const resumed = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory((factoryConfig, peer) => new CountingAdapter(factoryConfig, peer)),
        );
        await assert.rejects(
          resumed.runUntilUnanimous({
            session_id: session.session_id,
            task: "Cancel after a circular provider result settles.",
            initial_draft: "Caller draft must not restart cancelled provider work.\n",
            caller: "operator",
            peers: ["claude", "codex"],
            mode: "circular",
            max_rounds: 1,
          }),
          /session_already_finalized/,
        );
        assert.equal(providerCalls, 0);
      }),
  },
  {
    name: "a staged circular model mismatch is accounted and terminalized atomically",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-model-mismatch-terminal");
        let generationCalls = 0;
        class ModelMismatchAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            generationCalls += 1;
            const result = await super.generate(prompt, context);
            return {
              ...result,
              model_reported: `${this.model}-unexpected`,
              model_match: false,
            };
          }
        }
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new ModelMismatchAdapter(factoryConfig, peer),
          ),
        );
        const output = await orchestrator.runUntilUnanimous({
          task: "Review a stable circular artifact.",
          initial_draft: "Stable circular artifact.\n",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(output.session.outcome, "aborted");
        assert.equal(output.session.outcome_reason, "lead_silent_model_downgrade");
        assert.equal(output.session.generation_in_flight, undefined);
        assert.equal(output.session.rounds.length, 0);
        assert.equal(
          output.session.generation_files?.filter(
            (artifact) => artifact.round === 1 && artifact.label === "rotation",
          ).length,
          1,
        );
        assert.equal(generationCalls, 1);
      }),
  },
  {
    name: "a staged circular truthfulness rejection is accounted and terminalized atomically",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = {
          ...stubConfig("circular-truthfulness-terminal"),
          truthfulness_preflight_enabled: true,
        };
        let generationCalls = 0;
        class UnsupportedStateAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            generationCalls += 1;
            const result = await super.generate(prompt, context);
            const text = "After the merge completed, CI is green.";
            return { ...result, text, raw: { fixture: true, text } };
          }
        }
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new UnsupportedStateAdapter(factoryConfig, peer),
          ),
        );
        const output = await orchestrator.runUntilUnanimous({
          task: "Review this status report.",
          initial_draft: "Draft awaiting review.\n",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(output.session.outcome, "aborted");
        assert.equal(output.session.outcome_reason, "needs_truthfulness_preflight");
        assert.equal(output.session.generation_in_flight, undefined);
        assert.equal(output.session.rounds.length, 0);
        assert.equal(
          output.session.generation_files?.filter(
            (artifact) => artifact.round === 1 && artifact.label === "rotation",
          ).length,
          1,
        );
        assert.equal(generationCalls, 1);
      }),
  },
  {
    name: "a settled circular round-zero draft survives a crash without a second provider call",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-round-zero-resume");
        let roundZeroCalls = 0;
        class CountingInitialAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            if (context.round === 0) roundZeroCalls += 1;
            return super.generate(prompt, context);
          }
        }
        const adapterFactory = circularAdapterFactory(
          (factoryConfig, peer) => new CountingInitialAdapter(factoryConfig, peer),
        );
        const first = new CrossReviewOrchestrator(config, () => undefined, adapterFactory);
        const originalSaveGeneration = first.store.saveGeneration.bind(first.store);
        let injectCrash = true;
        Object.defineProperty(first.store, "saveGeneration", {
          configurable: true,
          writable: true,
          value: async (...args: Parameters<typeof originalSaveGeneration>) => {
            const saved = await originalSaveGeneration(...args);
            if (injectCrash && args[1] === 0) {
              injectCrash = false;
              throw new Error("fixture_crash_after_round_zero_settlement");
            }
            return saved;
          },
        });
        await assert.rejects(
          first.runUntilUnanimous({
            task: "Create a neutral circular artifact.",
            caller: "operator",
            peers: ["codex", "claude"],
            mode: "circular",
            max_rounds: 1,
          }),
          /fixture_crash_after_round_zero_settlement/,
        );
        const sessionId = first.store.list()[0]?.session_id;
        assert.ok(sessionId);
        const afterCrash = first.store.read(sessionId);
        const stagedMarker = afterCrash.generation_in_flight;
        assert.ok(stagedMarker);
        assert.equal(stagedMarker.round, 0);
        assert.equal(stagedMarker.label, "initial-draft");
        assert.ok(stagedMarker.settled_result_path);
        const stagedInitial = first.store.readStagedCircularGeneration(
          sessionId,
          0,
          stagedMarker.peer,
          "initial-draft",
        );
        assert.ok(stagedInitial);

        const resumed = new CrossReviewOrchestrator(config, () => undefined, adapterFactory);
        const replacementInitialDraft = "Caller replacement must not supersede settled bytes.\n";
        const output = await resumed.runUntilUnanimous({
          session_id: sessionId,
          task: "Create a neutral circular artifact.",
          initial_draft: replacementInitialDraft,
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(roundZeroCalls, 1);
        assert.equal(output.session.generation_in_flight, undefined);
        assert.equal(
          output.session.generation_files?.filter(
            (artifact) => artifact.round === 0 && artifact.label === "initial-draft",
          ).length,
          1,
        );
        const initialCustody = output.session.circular_state?.initial_draft_custody;
        assert.ok(initialCustody);
        assert.equal(initialCustody.sha256.length, 64);
        assert.ok(initialCustody.bytes > 0);
        const acceptedInitial = resumed.store.readAcceptedCircularInitialDraft(sessionId);
        assert.equal(acceptedInitial?.text, stagedInitial.text);
        assert.notEqual(acceptedInitial?.text, replacementInitialDraft);
      }),
  },
  {
    name: "the latest circular round resumes without reading obsolete initial custody",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-latest-round-priority");
        const store = new SessionStore(config);
        const session = await store.init(
          "Resume the latest circular artifact.",
          "operator",
          [],
          undefined,
          "circular",
        );
        const rotationOrder: PeerId[] = ["codex", "claude"];
        await store.setCircularState(session.session_id, {
          rotation_order: rotationOrder,
          consecutive_no_change_count: 0,
          last_revision_round: null,
          next_cursor: 0,
        });
        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "codex",
          provider: "fixture",
          model: "fixture",
          label: "initial-draft",
          round: 0,
          started_at: new Date().toISOString(),
          owner_pid: process.pid,
        });
        const initialGeneration = await generationWithPersistedPrompt(
          store,
          session.session_id,
          0,
          {
            peer: "codex",
            provider: "fixture",
            model: "fixture",
            text: "Accepted initial circular artifact.\n",
            raw: { fixture: "initial" },
            latency_ms: 1,
            attempts: 1,
            parser_warnings: [],
          },
          "initial-draft",
        );
        await store.saveGeneration(
          session.session_id,
          0,
          initialGeneration,
          "initial-draft",
          undefined,
          { defer_circular_promotion: true },
        );
        await store.commitCircularGenerationDisposition(session.session_id, {
          expected: { round: 0, peer: "codex", label: "initial-draft" },
          circular_state: {
            rotation_order: rotationOrder,
            consecutive_no_change_count: 0,
            last_revision_round: null,
            next_cursor: 1,
          },
          disposition: { kind: "accept_initial" },
        });

        await store.markBackgroundGenerationInFlight(session.session_id, {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          label: "rotation",
          round: 1,
          started_at: new Date().toISOString(),
          owner_pid: process.pid,
        });
        const latestText = "Latest durable circular round.\n";
        const rotationGeneration = await generationWithPersistedPrompt(
          store,
          session.session_id,
          1,
          {
            peer: "claude",
            provider: "fixture",
            model: "fixture",
            text: latestText,
            raw: { fixture: "rotation" },
            latency_ms: 1,
            attempts: 1,
            parser_warnings: [],
          },
          "rotation",
        );
        await store.saveGeneration(
          session.session_id,
          1,
          rotationGeneration,
          "rotation",
          undefined,
          { defer_circular_promotion: true },
        );
        const circularPeer = peerResult("NOT_READY", []);
        circularPeer.text = rotationGeneration.text;
        circularPeer.raw = rotationGeneration.raw;
        await store.appendRound(session.session_id, {
          review_kind: "circular_revision",
          caller_status: "READY",
          prompt_file: store.savePrompt(session.session_id, 1, "fixture circular prompt"),
          peers: [circularPeer],
          rejected: [],
          convergence: convergence(false),
          convergence_scope: convergenceScope(),
          started_at: new Date().toISOString(),
          circular_state: {
            rotation_order: rotationOrder,
            consecutive_no_change_count: 0,
            last_revision_round: 1,
            next_cursor: 0,
          },
          promote_staged_generation: true,
        });

        const prepared = store.read(session.session_id);
        const initialArtifact = prepared.generation_files?.find(
          (artifact) => artifact.round === 0 && artifact.label === "initial-draft",
        );
        assert.ok(initialArtifact);
        fs.rmSync(path.join(store.sessionDir(session.session_id), initialArtifact.path));

        const resumed = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory((factoryConfig, peer) => new StubAdapter(factoryConfig, peer)),
        );
        const output = await resumed.runUntilUnanimous({
          session_id: session.session_id,
          task: "Resume the latest circular artifact.",
          initial_draft: "Caller replacement must not supersede the latest round.\n",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(output.session.outcome, "max-rounds");
        assert.equal(output.final_text, latestText);
        assert.equal(output.session.rounds.length, 1);
      }),
  },
  {
    name: "markerless legacy circular continuation preserves its latest durable artifact",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("legacy-circular-continuation");
        const store = new SessionStore(config);
        const session = await store.init(
          "Resume a markerless legacy circular artifact.",
          "operator",
          [],
          undefined,
          "circular",
        );
        await store.setCircularState(session.session_id, {
          rotation_order: ["codex", "claude"],
          consecutive_no_change_count: 0,
          last_revision_round: 1,
          next_cursor: 1,
        });
        const legacyText = "LEGACY DURABLE ARTIFACT MUST REMAIN\n";
        const legacyPeer = peerResult("NOT_READY", []);
        legacyPeer.text = legacyText;
        const legacyPromptFile = store.savePrompt(session.session_id, 1, "legacy circular prompt");
        const legacy = store.read(session.session_id);
        delete legacy.reviewed_artifact_custody_schema_version;
        delete legacy.reviewed_artifact_custody_start_round;
        delete legacy.provider_prompt_custody_schema_version;
        delete legacy.provider_prompt_custody_start_round;
        delete legacy.provider_prompt_files;
        const timestamp = new Date().toISOString();
        legacy.rounds.push({
          round: 1,
          started_at: timestamp,
          completed_at: timestamp,
          caller_status: "READY",
          prompt_file: legacyPromptFile,
          peers: [legacyPeer],
          rejected: [],
          convergence: convergence(false),
        });
        legacy.costs_per_round = [0];
        if (legacy.circular_state) delete legacy.circular_state.next_cursor;
        fs.writeFileSync(
          store.metaPath(session.session_id),
          `${JSON.stringify(legacy, null, 2)}\n`,
        );

        let roundZeroCalls = 0;
        class CountingLegacyAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            if (context.round === 0) roundZeroCalls += 1;
            return super.generate(prompt, context);
          }
        }
        const resumed = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new CountingLegacyAdapter(factoryConfig, peer),
          ),
        );
        const output = await resumed.runUntilUnanimous({
          session_id: session.session_id,
          task: "Resume a markerless legacy circular artifact.",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(roundZeroCalls, 0);
        assert.equal(output.final_text, legacyText);
        assert.equal(output.session.rounds.length, 1);
      }),
  },
  {
    name: "first-run circular promotion uses the canonical persisted redacted result",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("circular-canonical-redacted-result");
        const tokenShapedText = `sk-${"x".repeat(32)}`;
        class TokenShapedArtifactAdapter extends StubAdapter {
          override async generate(
            prompt: string,
            context: PeerCallContext,
          ): Promise<GenerationResult> {
            const result = await super.generate(prompt, context);
            const text = `Revised circular artifact.\n${tokenShapedText}\n`;
            return { ...result, text, raw: { fixture: true, text } };
          }
        }
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          circularAdapterFactory(
            (factoryConfig, peer) => new TokenShapedArtifactAdapter(factoryConfig, peer),
          ),
        );
        const output = await orchestrator.runUntilUnanimous({
          task: "Revise a circular artifact.",
          initial_draft: "Original circular artifact.\n",
          caller: "operator",
          peers: ["codex", "claude"],
          mode: "circular",
          max_rounds: 1,
        });
        assert.equal(output.session.rounds.length, 1);
        assert.equal(output.session.generation_in_flight, undefined);
        assert.match(output.session.rounds[0]?.peers[0]?.text ?? "", /\[REDACTED\]/);
        assert.doesNotMatch(output.session.rounds[0]?.peers[0]?.text ?? "", /sk-x/);
        assert.match(output.final_text ?? "", /\[REDACTED\]/);
        assert.doesNotMatch(output.final_text ?? "", /sk-x/);
        assert.doesNotMatch(
          fs.readFileSync(orchestrator.store.metaPath(output.session.session_id), "utf8"),
          /sk-x/,
        );
      }),
  },
  {
    name: "mutation after round append blocks finalize without creating final.md",
    run: async () => {
      const { store, session } = await fixture("finalize-mutation");
      const draft = "const finalizedCustody = true;\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const reviewed = store.readReviewedArtifact(session.session_id, 1, draft);
      const round = await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: reviewed,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
        peers: [],
        rejected: [],
        convergence: convergence(true),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      assert.equal(round.convergence.converged, true);
      fs.writeFileSync(path.join(store.sessionDir(session.session_id), draftFile), "tampered\n");
      await assert.rejects(
        () => store.finalize(session.session_id, "converged", "fixture"),
        /reviewed_artifact_integrity_mismatch/,
      );
      assert.equal(store.read(session.session_id).outcome, undefined);
      assert.equal(
        fs.existsSync(path.join(store.sessionDir(session.session_id), "final.md")),
        false,
      );
      const doctor = await store.sessionDoctor();
      assert.equal(doctor.totals.reviewed_artifact_custody_failure_sessions, 1);
      assert.equal(
        doctor.findings.reviewed_artifact_custody_failure_sessions[0]?.session_id,
        session.session_id,
      );
    },
  },
  {
    name: "finalization mirrors exact authenticated bytes and reports later tampering",
    run: async () => {
      const { store, session } = await fixture("terminal-report-tamper");
      const draft =
        "const terminalReportCustody = '🛡️';\nTOKEN=fixture-secret-value\nline endings stay exact\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const reviewed = store.readReviewedArtifact(session.session_id, 1, draft);
      await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: reviewed,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
        peers: [],
        rejected: [],
        convergence: convergence(true),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      const terminal = await store.finalize(session.session_id, "converged", "fixture");
      assert.equal(terminal.outcome, "converged");
      assert.deepEqual(
        fs.readFileSync(path.join(store.sessionDir(session.session_id), "final.md")),
        Buffer.from(reviewed.content, "utf8"),
      );
      assert.ok(!reviewed.content.includes("fixture-secret-value"));
      fs.writeFileSync(path.join(store.sessionDir(session.session_id), draftFile), "tampered\n");
      const report = store.renderSessionReport(
        store.read(session.session_id),
        store.readEvents(session.session_id),
      );
      assert.match(report, /Reviewed artifact custody: FAILED/);
      assert.match(report, /reviewed_artifact_integrity_mismatch/);
    },
  },
  {
    name: "terminal custody fails closed for mutated or missing final mirrors",
    run: async () => {
      const { store, session } = await fixture("terminal-final-mirror");
      const draft = "const terminalFinalMirror = true;\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const artifact = store.readReviewedArtifact(session.session_id, 1, draft);
      const round = await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: artifact,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
        peers: [],
        rejected: [],
        convergence: convergence(true),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      await store.finalize(session.session_id, "converged", "fixture");
      const finalPath = path.join(store.sessionDir(session.session_id), "final.md");

      fs.writeFileSync(finalPath, "mutated final mirror\n", "utf8");
      let status = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(status.status, "FAILED");
      assert.match(status.failures.join("\n"), /final_mirror_integrity_mismatch/);
      let doctor = await store.sessionDoctor();
      assert.equal(doctor.totals.reviewed_artifact_custody_failure_sessions, 1);
      const mismatchRecovery = await store.recoverInterruptedSessions(new Set());
      assert.equal(
        mismatchRecovery.some((candidate) => candidate.session_id === session.session_id),
        false,
      );
      assert.equal(fs.readFileSync(finalPath, "utf8"), "mutated final mirror\n");

      store.saveFinalFromReviewedRound(session.session_id, round);
      status = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(status.status, "verified");
      fs.unlinkSync(finalPath);
      status = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(status.status, "FAILED");
      assert.match(status.failures.join("\n"), /final_mirror_unavailable/);
      doctor = await store.sessionDoctor();
      assert.equal(doctor.totals.reviewed_artifact_custody_failure_sessions, 1);
      fs.mkdirSync(finalPath);
      const nonFileRecovery = await store.recoverInterruptedSessions(new Set());
      assert.equal(
        nonFileRecovery.some((candidate) => candidate.session_id === session.session_id),
        false,
      );
      assert.equal(fs.lstatSync(finalPath).isDirectory(), true);
      status = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.match(status.failures.join("\n"), /final_mirror_not_regular_file/);
    },
  },
  {
    name: "an atomic final-mirror write failure leaves no partial trusted artifact",
    run: async () => {
      const { store, session } = await fixture("terminal-final-atomic-failure");
      const draft = "const atomicFinalMirror = true;\n";
      const draftFile = store.saveDraft(session.session_id, 1, draft);
      const artifact = store.readReviewedArtifact(session.session_id, 1, draft);
      await store.appendRound(session.session_id, {
        caller_status: "READY",
        draft_file: draftFile,
        reviewed_artifact: artifact,
        prompt_file: store.savePrompt(session.session_id, 1, "fixture prompt"),
        peers: [],
        rejected: [],
        convergence: convergence(true),
        convergence_scope: convergenceScope(),
        started_at: new Date().toISOString(),
      });
      const originalRenameSync = fs.renameSync;
      Object.defineProperty(fs, "renameSync", {
        configurable: true,
        value: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (path.basename(String(newPath)) === "final.md") {
            throw Object.assign(new Error("fixture final rename failure"), { code: "EACCES" });
          }
          return originalRenameSync(oldPath, newPath);
        },
      });
      try {
        const terminal = await store.finalize(session.session_id, "converged", "fixture");
        assert.equal(terminal.outcome, "converged");
      } finally {
        Object.defineProperty(fs, "renameSync", {
          configurable: true,
          value: originalRenameSync,
        });
      }
      assert.equal(
        fs.existsSync(path.join(store.sessionDir(session.session_id), "final.md")),
        false,
      );
      const status = store.reviewedArtifactCustodyReportStatus(store.read(session.session_id));
      assert.equal(status.status, "FAILED");
      assert.match(status.failures.join("\n"), /final_mirror_unavailable/);
      const recovered = await store.recoverInterruptedSessions(new Set());
      assert.equal(
        recovered.some((candidate) => candidate.session_id === session.session_id),
        true,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(store.sessionDir(session.session_id), "final.md")),
        Buffer.from(artifact.content, "utf8"),
      );
      assert.equal(
        store
          .readEvents(session.session_id)
          .some((event) => event.message?.includes("missing final.md mirror")),
        true,
      );
    },
  },
  {
    name: "descriptor identity must match the originally inspected directory entry",
    run: async () => {
      const { store, session } = await fixture("identity");
      const draft = "const descriptorIdentity = 'stable';\n";
      store.saveDraft(session.session_id, 5, draft);
      const originalFstatSync = fs.fstatSync;
      Object.defineProperty(fs, "fstatSync", {
        configurable: true,
        writable: true,
        value: ((descriptor: number, options?: { bigint?: boolean }) => {
          const stat = originalFstatSync(descriptor, options as { bigint: true });
          if (options?.bigint) stat.ino += 1n;
          return stat;
        }) as typeof fs.fstatSync,
      });
      try {
        assert.throws(
          () => store.readReviewedArtifact(session.session_id, 5, draft),
          /reviewed_artifact_identity_mismatch: agent-runs\/round-5-draft\.md/,
        );
      } finally {
        Object.defineProperty(fs, "fstatSync", {
          configurable: true,
          writable: true,
          value: originalFstatSync,
        });
      }
    },
  },
  {
    name: "non-file round draft paths fail closed",
    run: async () => {
      const { store, session } = await fixture("directory");
      const draft = "const allow = true;\n";
      const relativePath = store.saveDraft(session.session_id, 3, draft);
      const absolutePath = path.join(store.sessionDir(session.session_id), relativePath);
      fs.rmSync(absolutePath);
      fs.mkdirSync(absolutePath);

      assert.throws(
        () => store.readReviewedArtifact(session.session_id, 3, draft),
        /reviewed_artifact_not_regular_file: agent-runs\/round-3-draft\.md/,
      );
    },
  },
  {
    name: "a redirected agent-runs directory cannot escape session custody",
    run: async () => {
      const { dataDir, store, session } = await fixture("escape");
      const sessionDir = store.sessionDir(session.session_id);
      const agentRuns = path.join(sessionDir, "agent-runs");
      const outside = path.join(dataDir, "outside-agent-runs");
      fs.rmSync(agentRuns, { recursive: true, force: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "round-4-draft.md"), "outside\n", "utf8");
      fs.symlinkSync(outside, agentRuns, process.platform === "win32" ? "junction" : "dir");

      assert.throws(
        () => store.readReviewedArtifact(session.session_id, 4, "outside\n"),
        /reviewed_artifact_path_not_contained: agent-runs\/round-4-draft\.md/,
      );
    },
  },
  {
    name: "invalid round identifiers cannot select another artifact path",
    run: async () => {
      const { store, session } = await fixture("round");
      for (const round of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
          () => store.readReviewedArtifact(session.session_id, round, "draft"),
          /reviewed_artifact_round_invalid/,
        );
      }
    },
  },
  {
    name: "prompt views never split a UTF-16 surrogate pair or CRLF boundary",
    run: () => {
      const artifact = persistedArtifact("abc😀def");
      const view = reviewedArtifactPromptView(artifact, 4);
      assert.equal(view.visible_content, "abc");
      assert.equal(view.truncated, true);
      assert.doesNotMatch(view.visible_content, /[\uD800-\uDFFF]$/);

      const crlfArtifact = persistedArtifact("complete\r\nnext");
      const crlfView = reviewedArtifactPromptView(crlfArtifact, "complete\r".length);
      assert.equal(crlfView.visible_content, "complete");
      assert.equal(crlfView.truncated, true);
      assert.doesNotMatch(crlfView.visible_content, /\r$/);
    },
  },
  {
    name: "attachment prompt views never split a UTF-16 surrogate pair or CRLF boundary",
    run: async () => {
      const assertSafePrefix = async (label: string, content: string) => {
        const { store, session } = await fixture(`attachment-boundary-${label}`);
        await store.attachEvidence(session.session_id, {
          label,
          content,
          extension: "txt",
          attached_by: "operator",
          origin: "session_attach_evidence",
        });
        const [attachment] = store.readEvidenceAttachments(session.session_id, 2_000);
        assert.ok(attachment);
        assert.equal(attachment.content, "x".repeat(1_999));
        assert.equal(attachment.truncated, true);
        assert.equal(attachment.total_utf16_units, content.length);
        assert.doesNotMatch(attachment.content, /[\uD800-\uDFFF]$|\r$/);

        const prompt = buildFormatRecoveryPrompt(
          session,
          "Previous response",
          loadConfig(),
          undefined,
          false,
          reviewedArtifactPromptView(persistedArtifact("reviewed\n"), 20_000),
          [attachment],
        );
        assert.match(
          prompt,
          new RegExp(
            `truncated to 1999 of ${content.length} UTF-16 code units; \\d+ persisted bytes`,
          ),
        );
        assert.doesNotMatch(prompt, /truncated to 1999 of \d+ bytes/);
      };

      await assertSafePrefix("astral", `${"x".repeat(1_999)}😀tail`);
      await assertSafePrefix("crlf", `${"x".repeat(1_999)}\r\nnext`);
    },
  },
  {
    name: "one current evidence artifact uses the complete 200000 UTF-16-unit channel",
    run: async () => {
      const jwt = `${"A".repeat(32)}.${"B".repeat(20)}.${"C".repeat(20)}`;
      assert.equal(redact(jwt), "[REDACTED]");
      for (const prefix of ["prefix ", "(", '"']) {
        assert.equal(redact(`${prefix}${jwt}`), `${prefix}[REDACTED]`);
      }
      assert.equal(redact(`${jwt},${jwt}`), "[REDACTED],[REDACTED]");
      const longerJwt = `x${jwt}y`;
      assert.equal(redact(longerJwt), "[REDACTED]");

      const assertCompleteSingleArtifact = async (label: string, content: string) => {
        assert.equal(content.length, 200_000);
        const { store, session } = await fixture(`single-artifact-${label}`);
        await store.attachEvidence(session.session_id, {
          label,
          content,
          extension: "txt",
          attached_by: "operator",
          origin: "session_attach_evidence",
        });

        const [attachment] = store.readEvidenceAttachments(session.session_id, 200_000);
        assert.ok(attachment);
        assert.equal(attachment.content.length, 200_000);
        assert.equal(attachment.content, content);
        assert.equal(attachment.total_utf16_units, 200_000);
        assert.equal(attachment.truncated, false);
      };

      await assertCompleteSingleArtifact("bmp", "x".repeat(200_000));
      await assertCompleteSingleArtifact("astral", `${"x".repeat(199_998)}😀`);
    },
  },
  {
    name: "unterminated private-key marker redaction is bounded at the public evidence limit",
    run: () => {
      const marker = "-----BEGIN RSA PRIVATE KEY-----";
      const input = `${marker.repeat(Math.floor(200_000 / marker.length))}${"x".repeat(
        200_000 % marker.length,
      )}`;
      assert.equal(input.length, 200_000);

      const started = process.hrtime.bigint();
      assert.equal(redact(input), "[REDACTED]");
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      assert.ok(elapsedMs < 1_000, `redaction took ${elapsedMs.toFixed(1)} ms`);
    },
  },
  {
    name: "decision retry renders canonical persisted reviewed-artifact custody",
    run: async () => {
      const { session } = await fixture("retry-prompt");
      const artifact = persistedArtifact("const persistedDecision = true;\n", 7);
      const prompt = buildDecisionRetryPrompt(
        session,
        "caller raw draft must not replace persisted bytes",
        "No prior decision.",
        loadConfig(),
        undefined,
        [],
        artifact,
      );
      const custodyStart = prompt.indexOf("## Reviewed Artifact Custody");
      const responseStart = prompt.indexOf("## Previous Non-Decision Response");
      const custody = prompt.slice(custodyStart, responseStart);
      assert.ok(custodyStart >= 0);
      assert.match(custody, new RegExp(`Attachment: ${artifact.relative_path}`));
      assert.match(custody, new RegExp(`sha256=${artifact.sha256}`));
      assert.match(custody, /UTF-16 code units/);
      assert.match(custody, /const persistedDecision = true;/);
      assert.doesNotMatch(custody, /caller raw draft must not replace persisted bytes/);
    },
  },
  {
    name: "canonical reviewed-artifact READY and visible-line NOT_READY are definitive",
    run: () => {
      const artifact = persistedArtifact(
        "const reviewedDecision = true;\nconst blockingCondition = false;\n",
      );
      const ready = groundReadyPeerEvidence(
        peerResult("READY", [canonicalSource(artifact, "const reviewedDecision = true;")]),
        groundingInput(artifact),
      );
      assert.equal(ready.grounded, true);
      assert.equal(ready.result.status, "READY");

      const location = `${artifact.relative_path}:2`;
      const notReady = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, "const blockingCondition = false;", location)],
          `BLOCKER: ${location}`,
        ),
        groundingInput(artifact),
      );
      assert.equal(notReady.grounded, true);
      assert.equal(notReady.result.status, "NOT_READY");
    },
  },
  {
    name: "a full validated patch supports draft-byte READY and logical post-image NOT_READY",
    run: () => {
      const header = "diff --git a/src/value.ts b/src/value.ts";
      const logicalLine = "const logicalPostImageBlocker = false;";
      const artifact = persistedArtifact(
        `${header}\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+${logicalLine}\n`,
      );
      const ready = groundReadyPeerEvidence(
        peerResult("READY", [canonicalSource(artifact, header)]),
        groundingInput(artifact),
      );
      assert.equal(ready.grounded, true);
      assert.equal(ready.result.status, "READY");

      const logicalLocation = "src/value.ts:1";
      const notReady = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, logicalLine, logicalLocation)],
          `BLOCKER: ${logicalLocation}`,
        ),
        groundingInput(artifact),
      );
      assert.equal(notReady.grounded, true);
      assert.equal(notReady.result.status, "NOT_READY");
    },
  },
  {
    name: "a truncated patch rejects logical locations but keeps complete physical lines",
    run: () => {
      const logicalLine = "const truncatedLogicalBlocker = false;";
      const artifact = persistedArtifact(
        `diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+${logicalLine}\nTRUNCATED_SUFFIX`,
      );
      const physicalQuotedLine = `+${logicalLine}`;
      const visibleLength =
        artifact.content.indexOf(`${physicalQuotedLine}\n`) + physicalQuotedLine.length + 1;
      const logicalLocation = "src/value.ts:1";
      const logical = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, logicalLine, logicalLocation)],
          `BLOCKER: ${logicalLocation}`,
        ),
        groundingInput(artifact, visibleLength),
      );
      assert.equal(logical.result.status, "NEEDS_EVIDENCE");

      const physicalLocation = `${artifact.relative_path}:6`;
      const physical = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, physicalQuotedLine, physicalLocation)],
          `BLOCKER: ${physicalLocation}`,
        ),
        groundingInput(artifact, visibleLength),
      );
      assert.equal(physical.result.status, "NOT_READY");
    },
  },
  {
    name: "wrong reviewed-artifact path digest line and quote fail closed",
    run: () => {
      const artifact = persistedArtifact("const exactGroundingLine = true;\n");
      const valid = canonicalSource(artifact, "const exactGroundingLine = true;");
      const invalidSources = [
        valid.replace(artifact.relative_path, "agent-runs/round-99-draft.md"),
        valid.replace(artifact.sha256, "f".repeat(64)),
        valid.replace("const exactGroundingLine = true;", "exactGroundingLine = true"),
      ];
      for (const source of invalidSources) {
        const grounded = groundReadyPeerEvidence(
          peerResult("READY", [source]),
          groundingInput(artifact),
        );
        assert.equal(grounded.result.status, "NEEDS_EVIDENCE");
      }

      const wrongLocation = `${artifact.relative_path}:2`;
      const grounded = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, "const exactGroundingLine = true;", wrongLocation)],
          `BLOCKER: ${wrongLocation}`,
        ),
        groundingInput(artifact),
      );
      assert.equal(grounded.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "task-only legacy quotes and lowercase custody labels are not canonical",
    run: () => {
      const artifact = persistedArtifact("const reviewedOnly = true;\n");
      const taskOnly = groundReadyPeerEvidence(
        peerResult("READY", ['Artifact quote: "task requirement is satisfied"']),
        {
          ...groundingInput(artifact),
          artifactText: "task requirement is satisfied",
        },
      );
      assert.equal(taskOnly.result.status, "NEEDS_EVIDENCE");

      const lowercase = canonicalSource(artifact, "const reviewedOnly = true;")
        .replace("Attachment:", "attachment:")
        .replace("Artifact quote:", "artifact quote:");
      const lowerGrounding = groundReadyPeerEvidence(
        peerResult("READY", [lowercase]),
        groundingInput(artifact),
      );
      assert.equal(lowerGrounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(lowerGrounding.unsupported_sources.includes(lowercase));
    },
  },
  {
    name: "READY fails on a truncated view while a fully visible NOT_READY line remains definitive",
    run: () => {
      const firstLine = "const visibleBlockingCondition = false;";
      const artifact = persistedArtifact(`${firstLine}\n${"x".repeat(200)}\n`);
      const maxLength = firstLine.length + 1;
      const ready = groundReadyPeerEvidence(
        peerResult("READY", [canonicalSource(artifact, firstLine)]),
        groundingInput(artifact, maxLength),
      );
      assert.equal(ready.result.status, "NEEDS_EVIDENCE");
      assert.ok(ready.failed_predicates.includes("reviewed_artifact_fully_visible_for_ready"));

      const location = `${artifact.relative_path}:1`;
      const notReady = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, firstLine, location)],
          `BLOCKER: ${location}`,
        ),
        groundingInput(artifact, maxLength),
      );
      assert.equal(notReady.result.status, "NOT_READY");
    },
  },
  {
    name: "omitted duplicate lines and partial final lines cannot ground NOT_READY",
    run: () => {
      const duplicate = "const duplicateBlockingLine = false;";
      const padding = "const paddingKeepsTailHidden = true;";
      const artifact = persistedArtifact(`${duplicate}\n${padding}\n${duplicate}\n`);
      const omittedLocation = `${artifact.relative_path}:3`;
      const omitted = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(artifact, duplicate, omittedLocation)],
          `BLOCKER: ${omittedLocation}`,
        ),
        groundingInput(artifact, duplicate.length + 1),
      );
      assert.equal(omitted.result.status, "NEEDS_EVIDENCE");

      const partialArtifact = persistedArtifact("const partialBlockingLine = false;\n");
      const partialLocation = `${partialArtifact.relative_path}:1`;
      const partial = groundReadyPeerEvidence(
        peerResult(
          "NOT_READY",
          [canonicalSource(partialArtifact, "const partialBlockingLine = false;", partialLocation)],
          `BLOCKER: ${partialLocation}`,
        ),
        groundingInput(partialArtifact, 20),
      );
      assert.equal(partial.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a visible blocker cannot smuggle a second hidden quote through NOT_READY",
    run: () => {
      const visibleLine = "const visibleBlockingTarget = false;";
      const hiddenLine = "const hiddenSuffixPayload = true;";
      const artifact = persistedArtifact(`${visibleLine}\n${hiddenLine}\n`);
      const location = `${artifact.relative_path}:1`;
      const source = [
        `Location: ${location}`,
        `Attachment: ${artifact.relative_path}`,
        `sha256=${artifact.sha256}`,
        `Artifact quote: "${visibleLine}"`,
        `quote: "${hiddenLine}"`,
      ].join("\n");
      const grounding = groundReadyPeerEvidence(
        peerResult("NOT_READY", [source], `BLOCKER: ${location}`),
        groundingInput(artifact, visibleLine.length + 1),
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a visible line plus hidden multiline suffix cannot ground NOT_READY",
    run: () => {
      const visibleLine = "const multilineVisibleTarget = false;";
      const hiddenLine = "const multilineHiddenSuffix = true;";
      const artifact = persistedArtifact(`${visibleLine}\n${hiddenLine}\n`);
      const location = `${artifact.relative_path}:1`;
      const source = canonicalSource(artifact, `${visibleLine}\n${hiddenLine}`, location);
      const grounding = groundReadyPeerEvidence(
        peerResult("NOT_READY", [source], `BLOCKER: ${location}`),
        groundingInput(artifact, visibleLine.length + 1),
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "the reviewed artifact cannot corroborate its own operational claims",
    run: () => {
      const claim = "npm test passed with 120 checks and zero failures.";
      const artifact = persistedArtifact(`${claim}\n`);
      const grounding = groundReadyPeerEvidence(
        peerResult("READY", [canonicalSource(artifact, claim)]),
        groundingInput(artifact),
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(
        grounding.failed_predicates.includes(
          "operational_claims_corroborated_by_visible_authoritative_evidence",
        ),
      );
    },
  },
  {
    name: "reviewed-artifact citations never satisfy caller-evidence corroboration",
    run: () => {
      const claim = "npm test passed with 120 checks and zero failures.";
      const artifact = persistedArtifact(`${claim}\n`);
      const callerContent = `${claim}\nEXIT_CODE: 0\n`;
      const callerAttachment = {
        relative_path: "evidence/caller-test-output.txt",
        sha256: crypto.createHash("sha256").update(callerContent, "utf8").digest("hex"),
        content: callerContent,
        bytes: Buffer.byteLength(callerContent, "utf8"),
        truncated: false,
      };
      const grounding = groundReadyPeerEvidence(
        peerResult("READY", [canonicalSource(artifact, claim)]),
        groundingInput(artifact, artifact.content.length, {
          callerSubmittedAttachments: [callerAttachment],
          attachmentRefs: [callerAttachment.relative_path],
          requirePeerSubmittedCorroboration: true,
        }),
      );
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.equal(grounding.peer_submitted_evidence_corroborated, false);
      assert.ok(grounding.failed_predicates.includes("caller_submitted_evidence_citation_present"));
    },
  },
  {
    name: "format recovery re-sends exactly the attachments visible to the original call",
    run: async () => {
      const { session } = await fixture("format-lineage");
      const artifact = persistedArtifact("const retainedArtifactView = true;\n");
      const view = reviewedArtifactPromptView(artifact, artifact.content.length);
      const content = "VISIBLE_RECOVERY_ATTACHMENT_LINE";
      const attachment: ResolvedEvidenceAttachment = {
        label: "visible-recovery",
        relative_path: "evidence/visible-recovery.txt",
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
        provenance_status: "verified",
        authority_status: "caller_submitted_unverified",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        attached_by: "codex",
      };
      const normalRecovery = buildFormatRecoveryPrompt(
        session,
        "Previous response",
        loadConfig(),
        undefined,
        false,
        view,
        [attachment],
      );
      assert.match(normalRecovery, /VISIBLE_RECOVERY_ATTACHMENT_LINE/);
      assert.match(normalRecovery, /Attachment: agent-runs\/round-1-draft\.md/);

      const moderationRecovery = buildFormatRecoveryPrompt(
        session,
        "Previous moderation response",
        loadConfig(),
        undefined,
        false,
        view,
        [],
      );
      assert.doesNotMatch(moderationRecovery, /VISIBLE_RECOVERY_ATTACHMENT_LINE/);
      assert.match(moderationRecovery, /Attachment: agent-runs\/round-1-draft\.md/);
    },
  },
  {
    name: "persisted peer custody records normal moderation fallback and recovery dispatches",
    run: async () =>
      withConfirmedStubs(async () => {
        const runCase = async (
          label: string,
          draft: string,
          configOverrides: Partial<AppConfig> = {},
          evidence = "const visibleAttachmentEvidence = true;\n",
        ) => {
          const base = stubConfig(label);
          const orchestrator = new CrossReviewOrchestrator({ ...base, ...configOverrides });
          return orchestrator.askPeers({
            task: `Dispatch lineage fixture ${label}`,
            draft,
            evidence,
            peers: ["claude", "codex"],
            caller: "operator",
          });
        };

        const normal = await runCase("normal-lineage", "const normalDispatch = true;\n");
        const normalCustody = normal.round.peers.find(
          (peer) => peer.peer === "claude",
        )?.review_custody;
        assert.equal(normalCustody?.dispatch_kind, "normal");
        assert.equal(normalCustody?.reviewed_artifact.truncated, false);
        assert.equal(normalCustody?.visible_attachments.length, 1);
        assert.match(normalCustody?.visible_attachments[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
        assert.match(normalCustody?.provider_prompt.sha256 ?? "", /^[a-f0-9]{64}$/);
        assert.equal(normalCustody?.provider_prompt.reconstructible, true);
        assert.equal(normalCustody?.provider_prompt.redacted, true);
        assert.ok((normal.session.provider_prompt_files?.length ?? 0) >= 2);

        const moderation = await runCase(
          "moderation-lineage",
          "FORCE_MODERATION_FAIL\nconst moderationDispatch = true;\n",
        );
        const moderationCustody = moderation.round.peers.find(
          (peer) => peer.peer === "claude",
        )?.review_custody;
        assert.equal(moderationCustody?.dispatch_kind, "moderation_safe");
        assert.deepEqual(moderationCustody?.visible_attachments, []);
        assert.match(moderationCustody?.provider_prompt.sha256 ?? "", /^[a-f0-9]{64}$/);

        const format = await runCase(
          "format-lineage-e2e",
          "FORCE_BAD_FORMAT\nconst formatDispatch = true;\n",
        );
        const formatCustody = format.round.peers.find(
          (peer) => peer.peer === "claude",
        )?.review_custody;
        assert.equal(formatCustody?.dispatch_kind, "format_recovery");
        assert.equal(formatCustody?.visible_attachments.length, 1);
        assert.match(formatCustody?.provider_prompt.sha256 ?? "", /^[a-f0-9]{64}$/);

        const decisionDraft = `FORCE_MODERATION_FAIL\nFORCE_EMPTY_REVIEW\n${"x".repeat(20_000)}\n`;
        const decision = await runCase("decision-lineage", decisionDraft);
        const decisionCustody = decision.round.peers.find(
          (peer) => peer.peer === "claude",
        )?.review_custody;
        assert.equal(decisionCustody?.dispatch_kind, "decision_retry");
        assert.equal(decisionCustody?.reviewed_artifact.visible_utf16_units, 16_000);
        assert.equal(decisionCustody?.reviewed_artifact.truncated, true);
        assert.deepEqual(decisionCustody?.visible_attachments, []);
        assert.match(decisionCustody?.provider_prompt.sha256 ?? "", /^[a-f0-9]{64}$/);

        const fallbackBase = stubConfig("fallback-lineage");
        const fallback = await runCase(
          "fallback-lineage-run",
          "FORCE_NETWORK_FAIL\nconst fallbackDispatch = true;\n",
          {
            data_dir: fallbackBase.data_dir,
            fallback_models: {
              ...fallbackBase.fallback_models,
              claude: ["claude-fallback"],
            },
            model_cost_rates: {
              ...fallbackBase.model_cost_rates,
              claude: {
                ...(fallbackBase.model_cost_rates?.claude ?? {}),
                "claude-fallback": fallbackBase.cost_rates.claude ?? {},
              },
            },
          },
        );
        const fallbackCustody = fallback.round.peers.find(
          (peer) => peer.peer === "claude",
        )?.review_custody;
        assert.equal(fallbackCustody?.dispatch_kind, "fallback_normal");
        assert.match(fallbackCustody?.provider_prompt.sha256 ?? "", /^[a-f0-9]{64}$/);
      }),
  },
  {
    name: "mutation during peer dispatch fails before round append and finalize",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("dispatch-mutation");
        let mutated = false;
        let sessionId = "";
        class MutatingStubAdapter extends StubAdapter {
          override async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
            if (!mutated) {
              mutated = true;
              sessionId = context.session_id;
              const draftPath = path.join(
                config.data_dir,
                "sessions",
                context.session_id,
                "agent-runs",
                `round-${context.round}-draft.md`,
              );
              fs.writeFileSync(draftPath, "tampered during provider dispatch\n", "utf8");
            }
            return super.call(prompt, context);
          }
        }
        const adapterFactory = (factoryConfig: AppConfig): Record<string, PeerAdapter> => ({
          codex: new StubAdapter(factoryConfig, "codex"),
          claude: new MutatingStubAdapter(factoryConfig, "claude"),
          gemini: new StubAdapter(factoryConfig, "gemini"),
          deepseek: new StubAdapter(factoryConfig, "deepseek"),
          grok: new StubAdapter(factoryConfig, "grok"),
          perplexity: new StubAdapter(factoryConfig, "perplexity"),
        });
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          adapterFactory as unknown as ConstructorParameters<typeof CrossReviewOrchestrator>[2],
        );
        await assert.rejects(
          () =>
            orchestrator.askPeers({
              task: "Mutation after prompt fixture",
              draft: "const originalReviewedBytes = true;\n",
              peers: ["claude", "codex"],
              caller: "operator",
            }),
          /reviewed_artifact_integrity_mismatch/,
        );
        assert.ok(sessionId);
        const persisted = orchestrator.store.read(sessionId);
        assert.equal(persisted.rounds.length, 0);
        assert.equal(persisted.outcome, undefined);
        assert.equal(
          fs.existsSync(path.join(orchestrator.store.sessionDir(sessionId), "final.md")),
          false,
        );
      }),
  },
  {
    name: "provider dispatch uses the exact persisted redacted prompt and detects later tampering",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("exact-provider-prompt");
        const received = new Map<string, string>();
        class CapturingStubAdapter extends StubAdapter {
          override async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
            received.set(this.id, prompt);
            return super.call(prompt, context);
          }
        }
        const adapterFactory = (factoryConfig: AppConfig): Record<string, PeerAdapter> => ({
          codex: new CapturingStubAdapter(factoryConfig, "codex"),
          claude: new CapturingStubAdapter(factoryConfig, "claude"),
          gemini: new CapturingStubAdapter(factoryConfig, "gemini"),
          deepseek: new CapturingStubAdapter(factoryConfig, "deepseek"),
          grok: new CapturingStubAdapter(factoryConfig, "grok"),
          perplexity: new CapturingStubAdapter(factoryConfig, "perplexity"),
        });
        const orchestrator = new CrossReviewOrchestrator(
          config,
          () => undefined,
          adapterFactory as unknown as ConstructorParameters<typeof CrossReviewOrchestrator>[2],
        );
        const rawSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
        const output = await orchestrator.askPeers({
          task: `Exact provider prompt fixture ${rawSecret}`,
          draft: `const exactPrompt = true;\n// ${rawSecret}\n`,
          peers: ["claude", "codex"],
          caller: "operator",
        });
        for (const peer of output.round.peers) {
          const custody = peer.review_custody?.provider_prompt;
          assert.ok(custody);
          const persisted = fs.readFileSync(
            path.join(
              orchestrator.store.sessionDir(output.session.session_id),
              custody.relative_path,
            ),
            "utf8",
          );
          assert.equal(received.get(peer.peer), persisted);
          assert.doesNotMatch(persisted, new RegExp(rawSecret));
          assert.match(persisted, /\[REDACTED\]/);
          assert.equal(Buffer.byteLength(persisted, "utf8"), custody.bytes);
          assert.equal(persisted.length, custody.utf16_units);
          assert.equal(
            crypto.createHash("sha256").update(persisted, "utf8").digest("hex"),
            custody.sha256,
          );
        }
        const firstPrompt = output.round.peers[0]?.review_custody?.provider_prompt;
        assert.ok(firstPrompt);
        fs.writeFileSync(
          path.join(
            orchestrator.store.sessionDir(output.session.session_id),
            firstPrompt.relative_path,
          ),
          "tampered provider prompt\n",
          "utf8",
        );
        const status = orchestrator.store.reviewedArtifactCustodyReportStatus(
          orchestrator.store.read(output.session.session_id),
        );
        assert.equal(status.status, "FAILED");
        assert.match(status.failures.join("\n"), /provider_prompt_integrity_mismatch/);
      }),
  },
  {
    name: "single and consensus evidence judges persist exact prompt custody on success and failure",
    run: async () =>
      withConfirmedStubs(async () => {
        const rawSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
        const seedJudgeItem = async (
          orchestrator: CrossReviewOrchestrator,
          owner: "claude" | "gemini",
          label: string,
        ) => {
          const session = await orchestrator.store.init(label, "operator", []);
          await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
            { peer: owner, ask: `Prove the exact fixture claim ${rawSecret}.` },
          ]);
          const item = orchestrator.store.read(session.session_id).evidence_checklist?.[0];
          assert.ok(item);
          return { sessionId: session.session_id, item };
        };
        const assertPromptArtifact = (
          orchestrator: CrossReviewOrchestrator,
          sessionId: string,
          expectedPeer: "codex" | "claude",
          received?: ReadonlyMap<PeerId, string>,
        ) => {
          const meta = orchestrator.store.read(sessionId);
          const prompts = (meta.provider_prompt_files ?? []).filter(
            (candidate) =>
              candidate.call_kind === "evidence_judge" && candidate.peer === expectedPeer,
          );
          assert.equal(prompts.length, 1);
          const prompt = prompts[0];
          assert.ok(prompt);
          const content = fs.readFileSync(
            path.join(orchestrator.store.sessionDir(sessionId), prompt.relative_path),
            "utf8",
          );
          assert.doesNotMatch(content, new RegExp(rawSecret));
          assert.match(content, /\[REDACTED\]/);
          assert.equal(
            crypto.createHash("sha256").update(content, "utf8").digest("hex"),
            prompt.sha256,
          );
          assert.equal(Buffer.byteLength(content, "utf8"), prompt.bytes);
          assert.equal(content.length, prompt.utf16_units);
          assert.equal(prompt.peer, expectedPeer);
          assert.equal(prompt.call_kind, "evidence_judge");
          assert.match(prompt.label, /^judge-/);
          if (received) assert.equal(received.get(expectedPeer), content);
          return prompt;
        };

        const success = new CrossReviewOrchestrator(stubConfig("judge-prompt-success"));
        const successFixture = await seedJudgeItem(success, "claude", "Judge prompt success");
        const successReceived = new Map<PeerId, string>();
        const successJudge = success.adapters.codex.judgeEvidenceAsk.bind(success.adapters.codex);
        success.adapters.codex.judgeEvidenceAsk = async (persistedPrompt, context) => {
          successReceived.set("codex", persistedPrompt);
          return successJudge(persistedPrompt, context);
        };
        await success.runEvidenceChecklistJudgePass({
          session_id: successFixture.sessionId,
          judge_peer: "codex",
          draft: `FORCE_JUDGE_SATISFIED\n${rawSecret}`,
        });
        const successPrompt = assertPromptArtifact(
          success,
          successFixture.sessionId,
          "codex",
          successReceived,
        );
        const successMeta = success.store.read(successFixture.sessionId);
        assert.equal(successMeta.pending_provider_call_reservations?.length ?? 0, 0);
        const successGeneration = successMeta.generation_files?.find(
          (artifact) => artifact.label === `judge-${successFixture.item.id}`,
        );
        assert.ok(successGeneration);
        const successPayload = JSON.parse(
          fs.readFileSync(
            path.join(success.store.sessionDir(successFixture.sessionId), successGeneration.path),
            "utf8",
          ),
        ) as { provider_prompt?: ProviderPromptCustody };
        assert.deepEqual(successPayload.provider_prompt, {
          relative_path: successPrompt.relative_path,
          sha256: successPrompt.sha256,
          bytes: successPrompt.bytes,
          utf16_units: successPrompt.utf16_units,
          reconstructible: true,
          redacted: true,
        });
        fs.writeFileSync(
          path.join(
            success.store.sessionDir(successFixture.sessionId),
            successPrompt.relative_path,
          ),
          "tampered evidence-judge provider prompt\n",
          "utf8",
        );
        const judgeTamperStatus = success.store.reviewedArtifactCustodyReportStatus(
          success.store.read(successFixture.sessionId),
        );
        assert.equal(judgeTamperStatus.status, "FAILED");
        assert.match(judgeTamperStatus.failures.join("\n"), /provider_prompt_integrity_mismatch/);

        const failure = new CrossReviewOrchestrator(stubConfig("judge-prompt-failure"));
        const failureFixture = await seedJudgeItem(failure, "claude", "Judge prompt failure");
        const failureReceived = new Map<PeerId, string>();
        failure.adapters.codex.judgeEvidenceAsk = async (persistedPrompt) => {
          failureReceived.set("codex", persistedPrompt);
          throw new Error("fixture judge provider failure");
        };
        await failure.runEvidenceChecklistJudgePass({
          session_id: failureFixture.sessionId,
          judge_peer: "codex",
          draft: `Judge failure draft ${rawSecret}`,
        });
        const failurePrompt = assertPromptArtifact(
          failure,
          failureFixture.sessionId,
          "codex",
          failureReceived,
        );
        const failureMeta = failure.store.read(failureFixture.sessionId);
        assert.equal(failureMeta.pending_provider_call_reservations?.length ?? 0, 0);
        const failureRecord = failureMeta.failed_attempts?.find(
          (candidate) => candidate.peer === "codex",
        );
        assert.deepEqual(failureRecord?.provider_prompt, {
          relative_path: failurePrompt.relative_path,
          sha256: failurePrompt.sha256,
          bytes: failurePrompt.bytes,
          utf16_units: failurePrompt.utf16_units,
          reconstructible: true,
          redacted: true,
        });

        const consensus = new CrossReviewOrchestrator(stubConfig("judge-prompt-consensus"));
        const consensusFixture = await seedJudgeItem(consensus, "gemini", "Judge prompt consensus");
        const consensusReceived = new Map<PeerId, string>();
        const consensusClaudeJudge = consensus.adapters.claude.judgeEvidenceAsk.bind(
          consensus.adapters.claude,
        );
        consensus.adapters.claude.judgeEvidenceAsk = async (persistedPrompt, context) => {
          consensusReceived.set("claude", persistedPrompt);
          return consensusClaudeJudge(persistedPrompt, context);
        };
        consensus.adapters.codex.judgeEvidenceAsk = async (persistedPrompt) => {
          consensusReceived.set("codex", persistedPrompt);
          throw new Error("fixture consensus judge provider failure");
        };
        await consensus.runEvidenceChecklistJudgeConsensusPass({
          session_id: consensusFixture.sessionId,
          judge_peers: ["claude", "codex"],
          draft: `FORCE_JUDGE_SATISFIED\n${rawSecret}`,
        });
        const consensusClaudePrompt = assertPromptArtifact(
          consensus,
          consensusFixture.sessionId,
          "claude",
          consensusReceived,
        );
        const consensusCodexPrompt = assertPromptArtifact(
          consensus,
          consensusFixture.sessionId,
          "codex",
          consensusReceived,
        );
        const consensusMeta = consensus.store.read(consensusFixture.sessionId);
        assert.equal(consensusMeta.pending_provider_call_reservations?.length ?? 0, 0);
        const consensusGeneration = consensusMeta.generation_files?.find(
          (artifact) =>
            artifact.peer === "claude" && artifact.label === `judge-${consensusFixture.item.id}`,
        );
        assert.ok(consensusGeneration);
        const consensusGenerationPayload = JSON.parse(
          fs.readFileSync(
            path.join(
              consensus.store.sessionDir(consensusFixture.sessionId),
              consensusGeneration.path,
            ),
            "utf8",
          ),
        ) as { provider_prompt?: ProviderPromptCustody };
        assert.deepEqual(consensusGenerationPayload.provider_prompt, {
          relative_path: consensusClaudePrompt.relative_path,
          sha256: consensusClaudePrompt.sha256,
          bytes: consensusClaudePrompt.bytes,
          utf16_units: consensusClaudePrompt.utf16_units,
          reconstructible: true,
          redacted: true,
        });
        const consensusFailure = consensusMeta.failed_attempts?.find(
          (candidate) => candidate.peer === "codex",
        );
        assert.deepEqual(consensusFailure?.provider_prompt, {
          relative_path: consensusCodexPrompt.relative_path,
          sha256: consensusCodexPrompt.sha256,
          bytes: consensusCodexPrompt.bytes,
          utf16_units: consensusCodexPrompt.utf16_units,
          reconstructible: true,
          redacted: true,
        });
      }),
  },
  {
    name: "tampered evidence-judge prompts cannot authorize single or consensus promotion",
    run: async () =>
      withConfirmedStubs(async () => {
        const seedJudgeItem = async (
          orchestrator: CrossReviewOrchestrator,
          owner: "claude" | "gemini",
          label: string,
        ) => {
          const session = await orchestrator.store.init(label, "operator", []);
          await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
            { peer: owner, ask: "Prove the exact prompt-tamper fixture claim." },
          ]);
          const item = orchestrator.store.read(session.session_id).evidence_checklist?.[0];
          assert.ok(item);
          return { sessionId: session.session_id, item };
        };
        const tamperJudgePrompt = (
          orchestrator: CrossReviewOrchestrator,
          sessionId: string,
          peer: "codex",
          label: string,
        ) => {
          const prompt = orchestrator.store
            .read(sessionId)
            .provider_prompt_files?.find(
              (artifact) =>
                artifact.call_kind === "evidence_judge" &&
                artifact.peer === peer &&
                artifact.label === label,
            );
          assert.ok(prompt);
          fs.writeFileSync(
            path.join(orchestrator.store.sessionDir(sessionId), prompt.relative_path),
            "tampered after provider dispatch but before return\n",
            "utf8",
          );
        };

        const single = new CrossReviewOrchestrator(stubConfig("judge-prompt-tamper-single"));
        const singleFixture = await seedJudgeItem(single, "claude", "Single judge tamper");
        const singleLabel = `judge-${singleFixture.item.id}`;
        const singleJudge = single.adapters.codex.judgeEvidenceAsk.bind(single.adapters.codex);
        let singleCompletedJudgment: EvidenceAskJudgment | undefined;
        single.adapters.codex.judgeEvidenceAsk = async (persistedPrompt, context) => {
          const judgment = await singleJudge(persistedPrompt, context);
          singleCompletedJudgment = judgment;
          tamperJudgePrompt(single, singleFixture.sessionId, "codex", singleLabel);
          return judgment;
        };
        await single.runEvidenceChecklistJudgePass({
          session_id: singleFixture.sessionId,
          judge_peer: "codex",
          draft: "FORCE_JUDGE_SATISFIED\nSingle judge prompt-tamper fixture",
        });
        const singleMeta = single.store.read(singleFixture.sessionId);
        const singleItem = singleMeta.evidence_checklist?.find(
          (candidate) => candidate.id === singleFixture.item.id,
        );
        const singleReport = single.store.reviewedArtifactCustodyReportStatus(singleMeta);

        const consensus = new CrossReviewOrchestrator(stubConfig("judge-prompt-tamper-consensus"));
        const consensusFixture = await seedJudgeItem(consensus, "gemini", "Consensus judge tamper");
        const consensusLabel = `judge-${consensusFixture.item.id}`;
        const consensusCodexJudge = consensus.adapters.codex.judgeEvidenceAsk.bind(
          consensus.adapters.codex,
        );
        let consensusCompletedJudgment: EvidenceAskJudgment | undefined;
        consensus.adapters.codex.judgeEvidenceAsk = async (persistedPrompt, context) => {
          const judgment = await consensusCodexJudge(persistedPrompt, context);
          consensusCompletedJudgment = judgment;
          tamperJudgePrompt(consensus, consensusFixture.sessionId, "codex", consensusLabel);
          return judgment;
        };
        await consensus.runEvidenceChecklistJudgeConsensusPass({
          session_id: consensusFixture.sessionId,
          judge_peers: ["claude", "codex"],
          draft: "FORCE_JUDGE_SATISFIED\nConsensus judge prompt-tamper fixture",
        });
        const consensusMeta = consensus.store.read(consensusFixture.sessionId);
        const consensusItem = consensusMeta.evidence_checklist?.find(
          (candidate) => candidate.id === consensusFixture.item.id,
        );
        const consensusReport = consensus.store.reviewedArtifactCustodyReportStatus(consensusMeta);

        assert.equal(singleReport.status, "FAILED");
        assert.equal(consensusReport.status, "FAILED");
        assert.ok(singleItem);
        assert.ok(consensusItem);
        assert.deepEqual(
          { single: singleItem.status ?? "open", consensus: consensusItem.status ?? "open" },
          { single: "open", consensus: "open" },
        );
        assert.ok(singleCompletedJudgment);
        assert.ok(consensusCompletedJudgment);
        const singleFailure = singleMeta.failed_attempts?.find(
          (candidate) => candidate.peer === "codex",
        );
        const consensusFailure = consensusMeta.failed_attempts?.find(
          (candidate) => candidate.peer === "codex",
        );
        assert.ok(singleFailure);
        assert.ok(consensusFailure);
        for (const [failure, judgment] of [
          [singleFailure, singleCompletedJudgment],
          [consensusFailure, consensusCompletedJudgment],
        ] as const) {
          assert.match(failure.message, /provider_prompt_integrity_mismatch/);
          assert.equal(failure.attempts, judgment.attempts);
          assert.equal(failure.latency_ms, judgment.latency_ms);
          assert.deepEqual(failure.usage, judgment.usage);
          assert.deepEqual(failure.cost, judgment.cost);
          assert.equal(failure.unpriced_attempts, judgment.unpriced_attempts);
          assert.equal(failure.indeterminate_spend_attempts, judgment.indeterminate_spend_attempts);
        }
        assert.equal(singleMeta.pending_provider_call_reservations?.length ?? 0, 0);
        assert.equal(consensusMeta.pending_provider_call_reservations?.length ?? 0, 0);
        assert.equal(
          singleMeta.generation_files?.some(
            (artifact) => artifact.peer === "codex" && artifact.label === singleLabel,
          ) ?? false,
          false,
        );
        assert.equal(
          consensusMeta.generation_files?.some(
            (artifact) => artifact.peer === "codex" && artifact.label === consensusLabel,
          ) ?? false,
          false,
        );
        assert.equal(
          consensusMeta.generation_files?.some(
            (artifact) => artifact.peer === "claude" && artifact.label === consensusLabel,
          ) ?? false,
          true,
        );
        assert.equal(
          singleMeta.evidence_status_history?.some(
            (entry) => entry.item_id === singleFixture.item.id && entry.to === "addressed",
          ) ?? false,
          false,
        );
        assert.equal(
          consensusMeta.evidence_status_history?.some(
            (entry) => entry.item_id === consensusFixture.item.id && entry.to === "addressed",
          ) ?? false,
          false,
        );

        const postSaveSingle = new CrossReviewOrchestrator(
          stubConfig("judge-prompt-post-save-tamper-single"),
        );
        const postSaveSingleFixture = await seedJudgeItem(
          postSaveSingle,
          "claude",
          "Single judge post-save tamper",
        );
        const postSaveSingleLabel = `judge-${postSaveSingleFixture.item.id}`;
        const singlePromotion = postSaveSingle.store.markEvidenceItemAddressedByJudge.bind(
          postSaveSingle.store,
        );
        postSaveSingle.store.markEvidenceItemAddressedByJudge = async (
          sessionId,
          itemId,
          params,
        ) => {
          tamperJudgePrompt(
            postSaveSingle,
            postSaveSingleFixture.sessionId,
            "codex",
            postSaveSingleLabel,
          );
          return singlePromotion(sessionId, itemId, params);
        };
        const postSaveSingleResult = await postSaveSingle.runEvidenceChecklistJudgePass({
          session_id: postSaveSingleFixture.sessionId,
          judge_peer: "codex",
          draft: "FORCE_JUDGE_SATISFIED\nSingle judge post-save tamper fixture",
        });
        const postSaveSingleMeta = postSaveSingle.store.read(postSaveSingleFixture.sessionId);
        const postSaveSingleItem = postSaveSingleMeta.evidence_checklist?.find(
          (candidate) => candidate.id === postSaveSingleFixture.item.id,
        );
        assert.ok(postSaveSingleItem);
        assert.equal(postSaveSingleItem.status ?? "open", "open");
        assert.equal(postSaveSingleResult.promoted.length, 0);
        assert.equal(postSaveSingleResult.skipped[0]?.reason, "judge_failed");
        assert.equal(
          postSaveSingleMeta.generation_files?.filter(
            (artifact) => artifact.label === postSaveSingleLabel,
          ).length,
          1,
        );
        assert.equal(postSaveSingleMeta.pending_provider_call_reservations?.length ?? 0, 0);
        assert.equal(
          postSaveSingle.store.reviewedArtifactCustodyReportStatus(postSaveSingleMeta).status,
          "FAILED",
        );

        const postSaveConsensus = new CrossReviewOrchestrator(
          stubConfig("judge-prompt-post-save-tamper-consensus"),
        );
        const postSaveConsensusFixture = await seedJudgeItem(
          postSaveConsensus,
          "gemini",
          "Consensus judge post-save tamper",
        );
        const postSaveConsensusLabel = `judge-${postSaveConsensusFixture.item.id}`;
        const consensusPromotion = postSaveConsensus.store.markEvidenceItemAddressedByJudge.bind(
          postSaveConsensus.store,
        );
        postSaveConsensus.store.markEvidenceItemAddressedByJudge = async (
          sessionId,
          itemId,
          params,
        ) => {
          tamperJudgePrompt(
            postSaveConsensus,
            postSaveConsensusFixture.sessionId,
            "codex",
            postSaveConsensusLabel,
          );
          return consensusPromotion(sessionId, itemId, params);
        };
        const postSaveConsensusResult =
          await postSaveConsensus.runEvidenceChecklistJudgeConsensusPass({
            session_id: postSaveConsensusFixture.sessionId,
            judge_peers: ["claude", "codex"],
            draft: "FORCE_JUDGE_SATISFIED\nConsensus judge post-save tamper fixture",
          });
        const postSaveConsensusMeta = postSaveConsensus.store.read(
          postSaveConsensusFixture.sessionId,
        );
        const postSaveConsensusItem = postSaveConsensusMeta.evidence_checklist?.find(
          (candidate) => candidate.id === postSaveConsensusFixture.item.id,
        );
        assert.ok(postSaveConsensusItem);
        assert.equal(postSaveConsensusItem.status ?? "open", "open");
        assert.equal(postSaveConsensusResult.promoted.length, 0);
        assert.equal(postSaveConsensusResult.skipped[0]?.reason, "judge_failed");
        assert.equal(
          postSaveConsensusResult.consensus_decisions[0]?.unanimous_verified_satisfied,
          false,
        );
        assert.equal(postSaveConsensusResult.consensus_decisions[0]?.reason, "judge_failed");
        assert.equal(
          postSaveConsensusMeta.generation_files?.filter(
            (artifact) => artifact.label === postSaveConsensusLabel,
          ).length,
          2,
        );
        assert.equal(postSaveConsensusMeta.pending_provider_call_reservations?.length ?? 0, 0);
        assert.equal(
          postSaveConsensus.store.reviewedArtifactCustodyReportStatus(postSaveConsensusMeta).status,
          "FAILED",
        );
      }),
  },
  {
    name: "evidence-judge prompt and pending reservation are atomic across cancellation and recovery",
    run: async () => {
      const cancelledStore = new SessionStore(stubConfig("judge-prompt-cancel-before-prepare"));
      const cancelledSession = await cancelledStore.init(
        "Cancellation wins before evidence-judge preparation",
        "operator",
        [],
      );
      await cancelledStore.requestCancellation(cancelledSession.session_id, "fixture cancel first");
      await assert.rejects(
        cancelledStore.preparePendingProviderPromptCall(
          cancelledSession.session_id,
          {
            peer: "codex",
            provider: "fixture",
            model: "fixture",
            round: 1,
            label: "judge-cancel-first",
            call_kind: "evidence_judge",
          },
          "This prompt must never enter the dispatch ledger",
        ),
        /provider_reservation_cancelled/,
      );
      const cancelledMeta = cancelledStore.read(cancelledSession.session_id);
      assert.equal(cancelledMeta.provider_prompt_files?.length ?? 0, 0);
      assert.equal(cancelledMeta.pending_provider_call_reservations?.length ?? 0, 0);
      assert.equal(
        fs
          .readdirSync(
            path.join(cancelledStore.sessionDir(cancelledSession.session_id), "agent-runs"),
          )
          .some((name) => name.includes("judge-cancel-first")),
        false,
      );

      const committedStore = new SessionStore(stubConfig("judge-prompt-cancel-after-prepare"));
      const committedSession = await committedStore.init(
        "Cancellation wins after evidence-judge preparation",
        "operator",
        [],
      );
      const committed = await committedStore.preparePendingProviderPromptCall(
        committedSession.session_id,
        {
          peer: "codex",
          provider: "fixture",
          model: "fixture",
          round: 1,
          label: "judge-cancel-after",
          call_kind: "evidence_judge",
        },
        "This prompt is durably reserved before cancellation",
      );
      const beforeCancellation = committedStore.read(committedSession.session_id);
      assert.equal(beforeCancellation.provider_prompt_files?.length, 1);
      assert.equal(beforeCancellation.pending_provider_call_reservations?.length, 1);
      assert.deepEqual(
        beforeCancellation.pending_provider_call_reservations?.[0]?.provider_prompt,
        committed.custody,
      );
      const strippedReservation = structuredClone(beforeCancellation);
      if (strippedReservation.pending_provider_call_reservations?.[0]) {
        delete strippedReservation.pending_provider_call_reservations[0].provider_prompt;
      }
      fs.writeFileSync(
        committedStore.metaPath(committedSession.session_id),
        `${JSON.stringify(strippedReservation, null, 2)}\n`,
        "utf8",
      );
      assert.throws(
        () => committedStore.read(committedSession.session_id),
        /pending_provider_call_reservations\[0\]\.provider_prompt is required/,
      );
      fs.writeFileSync(
        committedStore.metaPath(committedSession.session_id),
        `${JSON.stringify(beforeCancellation, null, 2)}\n`,
        "utf8",
      );
      await committedStore.requestCancellation(
        committedSession.session_id,
        "fixture cancel after commit",
      );
      await committedStore.markCancelled(committedSession.session_id, "fixture_cancelled");
      const afterCancellation = committedStore.read(committedSession.session_id);
      assert.equal(afterCancellation.pending_provider_call_reservations?.length ?? 0, 0);
      assert.deepEqual(afterCancellation.failed_attempts?.[0]?.provider_prompt, committed.custody);

      const recoveredStore = new SessionStore(stubConfig("judge-prompt-crash-recovery"));
      const recoveredSession = await recoveredStore.init(
        "Host crashes after evidence-judge preparation",
        "operator",
        [],
      );
      const preparedBeforeCrash = await recoveredStore.preparePendingProviderPromptCall(
        recoveredSession.session_id,
        {
          peer: "claude",
          provider: "fixture",
          model: "fixture",
          round: 1,
          label: "judge-crash",
          call_kind: "evidence_judge",
        },
        "This exact prompt must survive conservative recovery",
      );
      const crashMeta = recoveredStore.read(recoveredSession.session_id);
      assert.ok(crashMeta.pending_provider_call_reservations?.[0]);
      crashMeta.pending_provider_call_reservations[0].owner_pid = 2_147_483_647;
      fs.writeFileSync(
        recoveredStore.metaPath(recoveredSession.session_id),
        `${JSON.stringify(crashMeta, null, 2)}\n`,
        "utf8",
      );
      await recoveredStore.recoverInterruptedSessions(new Set());
      const afterRecovery = recoveredStore.read(recoveredSession.session_id);
      assert.equal(afterRecovery.pending_provider_call_reservations?.length ?? 0, 0);
      const recoveredFailure = afterRecovery.failed_attempts?.find(
        (candidate) => candidate.peer === "claude",
      );
      assert.deepEqual(recoveredFailure?.provider_prompt, preparedBeforeCrash.custody);
      assert.equal(
        recoveredStore.reviewedArtifactCustodyReportStatus(afterRecovery).status,
        "verified",
      );
    },
  },
  {
    name: "interrupted provider settlements retain the exact dispatch custody",
    run: async () =>
      withConfirmedStubs(async () => {
        const config = stubConfig("interrupted-lineage");
        const orchestrator = new CrossReviewOrchestrator(config);
        const originalAppendRound = orchestrator.store.appendRound.bind(orchestrator.store);
        Object.defineProperty(orchestrator.store, "appendRound", {
          configurable: true,
          writable: true,
          value: async () => {
            throw new Error("fixture_crash_before_round_append");
          },
        });
        let sessionId = "";
        try {
          await assert.rejects(async () => {
            try {
              await orchestrator.askPeers({
                task: "Interrupted dispatch lineage fixture",
                draft: "const interruptedDispatch = true;\n",
                peers: ["claude", "codex"],
                caller: "operator",
              });
            } finally {
              sessionId = orchestrator.store.list()[0]?.session_id ?? "";
            }
          }, /fixture_crash_before_round_append/);
        } finally {
          Object.defineProperty(orchestrator.store, "appendRound", {
            configurable: true,
            writable: true,
            value: originalAppendRound,
          });
        }
        assert.ok(sessionId);
        const interruptedMeta = orchestrator.store.read(sessionId);
        assert.ok(interruptedMeta.in_flight);
        assert.equal(interruptedMeta.in_flight?.provider_settlements?.length, 2);
        if (interruptedMeta.in_flight) interruptedMeta.in_flight.owner_pid = 2_147_483_647;
        fs.writeFileSync(
          orchestrator.store.metaPath(sessionId),
          `${JSON.stringify(interruptedMeta, null, 2)}\n`,
          "utf8",
        );

        const restartedStore = new SessionStore(config);
        await restartedStore.recoverInterruptedSessions(new Set());
        const recovered = restartedStore.read(sessionId);
        const settlements = recovered.interrupted_provider_settlements ?? [];
        assert.equal(settlements.length, 2);
        for (const settlement of settlements) {
          const artifact = JSON.parse(
            fs.readFileSync(
              path.join(restartedStore.sessionDir(sessionId), settlement.artifact_path),
              "utf8",
            ),
          ) as PeerResult;
          assert.equal(artifact.review_custody?.dispatch_kind, "normal");
          assert.equal(
            artifact.review_custody?.reviewed_artifact.relative_path,
            "agent-runs/round-1-draft.md",
          );
          assert.equal(artifact.review_custody?.reviewed_artifact.truncated, false);
        }
      }),
  },
  {
    name: "moderation recovery carries its compact artifact view and no hidden attachments",
    run: async () => {
      const dataDir = tempDataDir("moderation-view");
      const base = loadConfig();
      const config = {
        ...base,
        data_dir: dataDir,
        stub: true,
        evidence_preflight_enabled: false,
        truthfulness_preflight_enabled: false,
      } as AppConfig;
      const previousStubConfirmation = process.env.CROSS_REVIEW_STUB_CONFIRMED;
      process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
      const orchestrator = new CrossReviewOrchestrator(config);
      const session = await orchestrator.store.init(
        "Moderation visibility fixture",
        "operator",
        [],
      );
      const adapter = new StubAdapter(config, "claude");
      const artifact = persistedArtifact("FORCE_MODERATION_FAIL\nconst compactLine = true;\n");
      const normalView = reviewedArtifactPromptView(artifact, artifact.content.length);
      const moderationView = reviewedArtifactPromptView(artifact, 22);
      const hiddenAttachment = {
        label: "hidden",
        relative_path: "evidence/hidden.txt",
        sha256: "a".repeat(64),
        content: "hidden operational evidence",
        bytes: 27,
        truncated: false,
      } as unknown as ResolvedEvidenceAttachment;
      const context: PeerCallContext = {
        session_id: session.session_id,
        round: 1,
        task: session.task,
        emit: () => undefined,
      };
      const outcome = await (
        orchestrator as unknown as {
          callPeerForReview(
            selectedAdapter: StubAdapter,
            prompt: string,
            moderationPrompt: string,
            callContext: PeerCallContext,
            views: {
              normal: ReturnType<typeof reviewedArtifactPromptView>;
              moderation_safe: ReturnType<typeof reviewedArtifactPromptView>;
              normal_attachments: readonly ResolvedEvidenceAttachment[];
              moderation_safe_attachments: readonly ResolvedEvidenceAttachment[];
            },
          ): Promise<{
            result?: PeerResult;
            reviewed_artifact_view?: ReturnType<typeof reviewedArtifactPromptView>;
            visible_attachments?: readonly ResolvedEvidenceAttachment[];
          }>;
        }
      ).callPeerForReview(
        adapter,
        "FORCE_MODERATION_FAIL\nReview the full artifact.",
        "# Cross Review - Compact Moderation-Safe Review\nReview the compact artifact.",
        context,
        {
          normal: normalView,
          moderation_safe: moderationView,
          normal_attachments: [hiddenAttachment],
          moderation_safe_attachments: [],
        },
      );
      assert.ok(outcome.result);
      assert.deepEqual(outcome.reviewed_artifact_view, moderationView);
      assert.deepEqual(outcome.visible_attachments, []);
      if (previousStubConfirmation === undefined) {
        delete process.env.CROSS_REVIEW_STUB_CONFIRMED;
      } else {
        process.env.CROSS_REVIEW_STUB_CONFIRMED = previousStubConfirmation;
      }
    },
  },
];

let passed = 0;
try {
  for (const regression of regressions) {
    await regression.run();
    passed += 1;
    console.log(`PASS ${regression.name}`);
  }
  console.log(`reviewed-artifact-custody-regression: ${passed}/${regressions.length} GREEN`);
} finally {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
}
