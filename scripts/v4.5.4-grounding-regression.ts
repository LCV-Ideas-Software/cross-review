import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";

import { checkConvergence } from "../src/core/convergence.js";
import {
  CrossReviewOrchestrator,
  evidencePreflight,
  groundReadyPeerEvidence,
  peerAuthoredEvidenceChecklistAsks,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import {
  decisionQualityFromStatus,
  parsePeerStatus,
  statusJsonSchema,
} from "../src/core/status.js";
import type { PeerAdapter, PeerId, PeerResult, RuntimeEvent } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

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
    name: "actual round commits a lossless grounded format replacement with two independent READY reviewers",
    run: async () => {
      process.env.CROSS_REVIEW_STUB = "1";
      process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "cross-review-grounded-format-recovery-"),
      );
      const base = loadConfig();
      const allPeers: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok", "perplexity"];
      const config = {
        ...base,
        data_dir: directory,
        stub: true,
        peer_enabled: {
          codex: true,
          claude: true,
          gemini: true,
          deepseek: false,
          grok: false,
          perplexity: false,
        },
        cost_rates: Object.fromEntries(
          allPeers.map((peer) => [
            peer,
            { input_per_million: 0, output_per_million: 0, search_queries_per_1000: 0 },
          ]),
        ),
        budget: {
          ...base.budget,
          max_session_cost_usd: 10_000,
          preflight_max_round_cost_usd: 10_000,
        },
      };
      const adapters = {} as Record<PeerId, PeerAdapter>;
      const calls = new Map<PeerId, number>();
      const events: RuntimeEvent[] = [];
      let sources: string[] = [];
      for (const peer of allPeers) {
        const adapter = new StubAdapter(config, peer);
        adapter.call = async (_prompt, context) => {
          const attempt = (calls.get(peer) ?? 0) + 1;
          calls.set(peer, attempt);
          context.emit({
            type: "peer.call.started",
            session_id: context.session_id,
            round: context.round,
            peer,
            message: "Synthetic native parser recovery fixture.",
          });
          const text = JSON.stringify({
            status: "READY",
            summary:
              peer === "claude" && attempt === 1
                ? "x".repeat(801)
                : "No blocking objections remain.",
            confidence: "verified",
            evidence_sources: sources,
            caller_requests: [],
            follow_ups: [],
          });
          const parsed = parsePeerStatus(text);
          if (peer === "claude" && attempt === 1) {
            assert.notEqual(parsed.status, "READY");
            assert.ok(parsed.parser_warnings.includes("ready_rejected_lossy_parse"));
          } else {
            assert.equal(parsed.status, "READY");
            assert.deepEqual(parsed.parser_warnings, []);
          }
          return {
            peer,
            provider: adapter.provider,
            model: adapter.model,
            model_reported: adapter.model,
            model_match: true,
            ...parsed,
            text,
            raw: { synthetic_only: true },
            attempts: 1,
            latency_ms: 1,
            decision_quality: decisionQualityFromStatus(parsed.status, parsed.parser_warnings),
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            cost: {
              currency: "USD",
              input_cost: 0,
              output_cost: 0,
              total_cost: 0,
              estimated: false,
              source: "stub",
            },
          };
        };
        adapters[peer] = adapter;
      }
      const orchestrator = new CrossReviewOrchestrator(
        config,
        (event) => events.push(event),
        () => adapters,
      );
      try {
        const task = "Review the completed implementation that reports npm test with 74 passed.";
        const session = await orchestrator.store.init(task, "codex", []);
        const attachment = await orchestrator.store.attachEvidence(session.session_id, {
          label: "verified-test-output",
          content: EVIDENCE_CONTENT,
          attached_by: "codex",
          origin: "session_attach_evidence",
        });
        const stored = orchestrator.store.readEvidenceAttachments(
          session.session_id,
          config.prompt.max_attached_evidence_chars,
        )[0];
        assert.ok(stored?.sha256);
        sources = [
          citation(
            { relative_path: attachment.path, sha256: stored.sha256, content: stored.content },
            EVIDENCE_CONTENT,
          ),
        ];
        const result = await orchestrator.askPeers({
          session_id: session.session_id,
          caller: "codex",
          caller_status: "READY",
          task,
          draft: "The completed implementation reports npm test with 74 passed.",
          peers: ["claude", "gemini"],
        });
        assert.equal(
          calls.get("claude"),
          2,
          "one lossy first attempt requires exactly one native recovery",
        );
        assert.equal(calls.get("gemini"), 1, "the independent clean reviewer requires no retry");
        assert.equal(
          events.filter((event) => event.type === "peer.format_recovery.started").length,
          1,
        );
        assert.equal(result.round.convergence.converged, true);
        assert.deepEqual(result.round.convergence.ready_peers.sort(), ["claude", "gemini"]);
        const recovered = result.round.peers.find((peer) => peer.peer === "claude");
        assert.ok(recovered);
        assert.equal(recovered.status, "READY");
        assert.equal(recovered.decision_quality, "recovered");
        assert.ok(recovered.parser_warnings.includes("original:summary_truncated_to_800"));
        assert.ok(recovered.parser_warnings.includes("original:ready_rejected_lossy_parse"));
        assert.ok(recovered.parser_warnings.includes("format_recovery_retry_succeeded"));
        assert.equal(recovered.parser_warnings.includes("summary_truncated_to_800"), false);
        assert.equal(recovered.attempts, 2);
        assert.equal(recovered.usage?.total_tokens, 60);
        assert.equal(recovered.cost?.total_cost, 0);
        const committed = orchestrator.store.read(session.session_id);
        assert.equal(committed.rounds.length, 1);
        assert.equal(committed.rounds[0]?.convergence.converged, true);
        assert.equal(committed.in_flight, undefined);
        const agentDirectory = path.join(
          orchestrator.store.sessionDir(session.session_id),
          "agent-runs",
        );
        const names = fs.readdirSync(agentDirectory);
        const originalName = names.find((name) => name.includes("claude-lossy-response"));
        const replacementName = names.find((name) =>
          name.includes("claude-format-recovery-response"),
        );
        assert.ok(
          originalName && replacementName,
          "both original and replacement raw records must remain durable",
        );
        const original = JSON.parse(
          fs.readFileSync(path.join(agentDirectory, originalName), "utf8"),
        ) as PeerResult;
        const replacement = JSON.parse(
          fs.readFileSync(path.join(agentDirectory, replacementName), "utf8"),
        ) as PeerResult;
        assert.equal(JSON.parse(original.text).summary.length, 801);
        assert.ok(original.parser_warnings.includes("ready_rejected_lossy_parse"));
        assert.equal(replacement.status, "READY");
        assert.deepEqual(replacement.parser_warnings, []);
      } finally {
        await orchestrator.store.flushPendingEvents();
        assert.equal(path.resolve(directory), directory);
        assert.ok(path.basename(directory).startsWith("cross-review-grounded-format-recovery-"));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: "model-authored warning prefixes and success markers cannot launder a lossy READY",
    run: () => {
      const smuggled = parsePeerStatus(
        JSON.stringify({
          status: "READY",
          summary: "x".repeat(801),
          confidence: "verified",
          evidence_sources: [citation(defaultAttachment, EVIDENCE_CONTENT)],
          caller_requests: [],
          follow_ups: [],
          parser_warnings: ["original:summary_truncated_to_800", "format_recovery_retry_succeeded"],
          decision_quality: "recovered",
        }),
      );
      assert.notEqual(smuggled.status, "READY");
      assert.ok(smuggled.parser_warnings.includes("ready_rejected_lossy_parse"));
      assert.equal(smuggled.parser_warnings.includes("format_recovery_retry_succeeded"), false);
      assert.equal(
        smuggled.parser_warnings.some((warning) => warning.startsWith("original:")),
        false,
      );
      assert.equal(Object.hasOwn(smuggled.structured ?? {}, "parser_warnings"), false);
    },
  },
  {
    name: "lossless recovered READY is not vetoed by retained original parse diagnostics",
    run: () => {
      const verdict = {
        status: "READY",
        summary: "No blocking objections remain.",
        confidence: "verified",
        evidence_sources: [citation(defaultAttachment, EVIDENCE_CONTENT)],
        caller_requests: [],
        follow_ups: [],
      };
      const original = parsePeerStatus(JSON.stringify({ ...verdict, summary: "x".repeat(801) }));
      assert.equal(original.parser_warnings.includes("ready_rejected_lossy_parse"), true);
      assert.notEqual(original.status, "READY");
      const recovered = parsePeerStatus(JSON.stringify(verdict));
      assert.equal(recovered.status, "READY");
      assert.deepEqual(recovered.parser_warnings, []);
      const warnings = [
        ...original.parser_warnings.map((warning) => `original:${warning}`),
        ...recovered.parser_warnings,
        "format_recovery_retry_succeeded",
      ];
      const grounded = groundReadyPeerEvidence(
        readyPeer(recovered.structured?.evidence_sources ?? [], "claude", {
          structured: recovered.structured,
          parser_warnings: warnings,
          decision_quality: "recovered",
        }),
        groundingInput("The completed implementation reports npm test with 74 passed."),
      );
      assert.equal(grounded.result.status, "READY");
      assert.equal(grounded.grounded, true);
      const convergence = checkConvergence(["claude"], "READY", [grounded.result], []);
      assert.equal(convergence.converged, true);
      assert.deepEqual(convergence.ready_peers, ["claude"]);
      assert.deepEqual(grounded.result.parser_warnings, warnings);

      const currentLossy = {
        ...grounded.result,
        parser_warnings: [...warnings, "summary_truncated_to_800"],
      };
      assert.equal(checkConvergence(["claude"], "READY", [currentLossy], []).converged, false);
      const noRecovery = {
        ...grounded.result,
        parser_warnings: warnings.filter(
          (warning) => warning !== "format_recovery_retry_succeeded",
        ),
      };
      assert.equal(checkConvergence(["claude"], "READY", [noRecovery], []).converged, false);
      const missingContract = { ...grounded.result, structured: null };
      assert.equal(checkConvergence(["claude"], "READY", [missingContract], []).converged, false);
      const currentFabrication = {
        ...grounded.result,
        parser_warnings: [...warnings, "ready_without_concrete_evidence_sources"],
      };
      assert.equal(
        checkConvergence(["claude"], "READY", [currentFabrication], []).converged,
        false,
      );
    },
  },
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
        "Cite evidence verbatim from the reviewed artifact, an authenticated caller submission, or a persisted attachment; invented or untraceable sources cannot support READY.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });

      assert.equal(preflight.pass, true);
      assert.equal(preflight.historical_state_claim_matched, false);
      assert.ok(!preflight.issue_classes.includes("unsupported_historical_claim"));

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the cross-review runtime at workflow start.",
        initialDraft: "When the workflow began, cross-review was at v4.5.2.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the cross-review runtime at workflow start.",
        initialDraft: "When the workflow began, cross-review version was v4.5.2.",
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(runtimeClaim.pass, false);
      assert.equal(runtimeClaim.historical_state_claim_matched, true);
      assert.ok(runtimeClaim.issue_classes.includes("unsupported_historical_claim"));
    },
  },
  // The pt-BR drafts below are not stray prose: they are the only coverage of
  // the Portuguese alternatives inside HISTORICAL_RUNTIME_TIMING_PATTERN
  // (src/core/orchestrator.ts), which matches
  // `quando (o) workflow|run|auditoria|sessao comecou`. Translating them would
  // leave that branch of the pattern untested while the tests still passed.
  {
    name: "a Portuguese product-version noun phrase stays outside runtime history",
    run: () => {
      const productClaim = truthfulnessPreflight({
        task: "Revise a evidência de release do astrologo-app.",
        initialDraft: "Quando o workflow começou, a versão do astrologo-app era v2.20.0.",
        structuredEvidence: 'package.json:3: "version": "2.20.0"',
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime do cross-review no início do workflow.",
        initialDraft: "Quando o workflow começou, a versão do cross-review era v4.5.2.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the local runtime.",
        initialDraft: "When the workflow began, the cross-review runtime version was v4.5.2.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audit the local runtime.",
        initialDraft: "At workflow start, the cross-review runtime was at version v4.5.2.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime local.",
        initialDraft:
          "Quando o workflow começou, a versão do runtime local do cross-review era v4.5.2.",
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
        attachmentsPresent: false,
        runtimeFacts: RUNTIME_FACTS,
      });
      assert.equal(productClaim.pass, true);
      assert.equal(productClaim.historical_state_claim_matched, false);

      const runtimeClaim = truthfulnessPreflight({
        task: "Audite o runtime local.",
        initialDraft: "No início do workflow, o runtime do cross-review estava na versão v4.5.2.",
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
