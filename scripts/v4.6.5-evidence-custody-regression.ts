import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VERSION } from "../src/core/config.js";
import {
  CrossReviewOrchestrator,
  detectFabricatedEvidence,
  evidencePreflight,
  groundReadyPeerEvidence,
} from "../src/core/orchestrator.js";
import type { AppConfig, PeerId, PeerResult } from "../src/core/types.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

type EvidenceAttachment = {
  label: string;
  relative_path: string;
  sha256: string;
  content: string;
};

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const EVIDENCE_PATH = "evidence/caller-structured-evidence-fixture.txt";
const EVIDENCE_SHA = "c8550627741a8d1060984cdc2d4063c641e59e19db609a0608ff5c2c8f792b00";
const TEMP_DIR_PREFIX = "cross-review-crosrev32-";
const CHECK_URLS = Array.from(
  { length: 20 },
  (_, index) =>
    `https://github.com/example-org/example-repo/actions/runs/${10_000 + index}/job/${20_000 + index}`,
);
const CHECK_RECORDS = CHECK_URLS.map((detailsUrl, index) =>
  JSON.stringify({
    __typename: "CheckRun",
    conclusion: "SUCCESS",
    detailsUrl,
    name: `Check ${index + 1}`,
    status: "COMPLETED",
  }),
);
const EVIDENCE_CONTENT = [
  "diff --git a/package.json b/package.json",
  "index 1111111..2222222 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1 +1 @@",
  '-{"version":"1.0.0"}',
  '+{"version":"1.0.1"}',
  "diff --git a/THIRDPARTY.md b/THIRDPARTY.md",
  "index 3333333..4444444 100644",
  "--- a/THIRDPARTY.md",
  "+++ b/THIRDPARTY.md",
  "@@ -1 +1 @@",
  "-| example-dependency | 1.0.0 | MIT |",
  "+| example-dependency | 1.0.1 | MIT |",
  ...CHECK_RECORDS,
].join("\n");
const ATTACHMENT: EvidenceAttachment = {
  label: "caller-structured-evidence",
  relative_path: EVIDENCE_PATH,
  sha256: EVIDENCE_SHA,
  content: EVIDENCE_CONTENT,
};
const RELATOR_DRAFT = [
  "Verdict: READY.",
  "The same artifact confirms package.json and THIRDPARTY.md.",
].join("\n");

function escapedProviderCitation(attachment: EvidenceAttachment, literal: string): string {
  const escapedLiteral = literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `Attachment: ${attachment.relative_path}`,
    `sha256=${attachment.sha256}`,
    `Artifact quote: "${escapedLiteral}"`,
  ].join("\n");
}

function readyPeer(evidenceSources: string[], peer: PeerId = "claude"): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    status: "READY",
    raw_status: "READY",
    parsed_status: "READY",
    normalized_status: "READY",
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
  };
}

function groundingInput(attachments: EvidenceAttachment[]) {
  return {
    artifactText: "Review the correlated check sources.",
    attachedEvidenceText: "",
    attachmentRefs: attachments.map((attachment) => attachment.relative_path),
    evidenceAttachments: attachments.map(({ relative_path, sha256 }) => ({
      relative_path,
      sha256,
    })),
    callerSubmittedAttachments: attachments,
    runtimeFacts: {},
  } satisfies Parameters<typeof groundReadyPeerEvidence>[1];
}

function createRegressionDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
}

function removeRegressionDataDir(dataDir: string): void {
  const resolvedTempRoot = path.resolve(os.tmpdir());
  const resolvedDataDir = path.resolve(dataDir);
  assert.equal(
    path.dirname(resolvedDataDir),
    resolvedTempRoot,
    "cleanup target must be a direct child of the operating-system temp directory",
  );
  assert.ok(
    path.basename(resolvedDataDir).startsWith(TEMP_DIR_PREFIX),
    "cleanup target must retain the regression-specific mkdtemp prefix",
  );
  fs.rmSync(resolvedDataDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(resolvedDataDir), false, "regression data directory must be removed");
}

function regressionConfig(dataDir: string): AppConfig {
  return {
    version: VERSION,
    data_dir: dataDir,
    log_level: "error",
    stub: true,
    dashboard_port: 0,
    retry: {
      max_attempts: 1,
      base_delay_ms: 1,
      max_delay_ms: 1,
      timeout_ms: 5_000,
    },
    budget: {
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
      require_rates_for_budget: true,
      default_max_rounds: 1,
      circular_max_rotations: 1,
    },
    prompt: {
      max_task_chars: 8_000,
      max_review_focus_chars: 2_000,
      max_history_chars: 20_000,
      max_draft_chars: 40_000,
      max_prior_rounds: 1,
      max_peer_requests: 8,
      max_attached_evidence_chars: 200_000,
    },
    evidence_broker: {
      max_requests_per_peer_round: 8,
      max_requests_per_round: 24,
      max_items_per_session: 64,
      max_chars_per_session: 64_000,
    },
    max_output_tokens: 1_024,
    max_output_tokens_by_peer: {},
    evidence_preflight_enabled: true,
    truthfulness_preflight_enabled: true,
    streaming: { events: false, tokens: false, include_text: false },
    models: {
      codex: "fixture-codex",
      claude: "fixture-claude",
      gemini: "fixture-gemini",
      deepseek: "fixture-deepseek",
      grok: "fixture-grok",
      perplexity: "fixture/perplexity",
    },
    fallback_models: {},
    reasoning_effort: {},
    model_selection: {},
    api_keys: {
      codex: undefined,
      claude: undefined,
      gemini: undefined,
      deepseek: undefined,
      grok: undefined,
      perplexity: undefined,
    },
    peer_enabled: {
      codex: true,
      claude: true,
      gemini: true,
      deepseek: true,
      grok: true,
      perplexity: true,
    },
    cost_rates: {
      codex: { input_per_million: 0, output_per_million: 0 },
      claude: { input_per_million: 0, output_per_million: 0 },
      gemini: { input_per_million: 0, output_per_million: 0 },
      deepseek: { input_per_million: 0, output_per_million: 0 },
      grok: { input_per_million: 0, output_per_million: 0 },
      perplexity: {
        input_per_million: 0,
        output_per_million: 0,
        search_queries_per_1000: 0,
        request_fee_low_per_1000: 0,
        request_fee_medium_per_1000: 0,
        request_fee_high_per_1000: 0,
      },
    },
    model_cost_rates: {},
    evidence_judge_autowire: {
      mode: "off",
      peer: undefined,
      active: false,
      max_items_per_pass: 4,
      max_output_tokens: 512,
      configured_mode_raw: "off",
      configured_peer_raw: "",
      consensus_peers: [],
      configured_consensus_peers_raw: "",
    },
    cache: {
      schema_version: "fixture-v1",
      enabled: false,
      ttl: { anthropic: "5m", openai: "5m" },
      disable_per_peer: {
        codex: false,
        claude: false,
        gemini: false,
        deepseek: false,
        grok: false,
        perplexity: false,
      },
    },
    perplexity: {
      search_context_size: "low",
      disable_search: true,
      probe_mode: "auth_only",
      max_steps: 1,
      web_search_invocations_estimate: 1,
      search_preflight_policy: "estimate",
    },
  };
}

function assertUnifiedDiffCustody(
  claim: string,
  patchPath: string,
  attachedEvidenceText: string[],
  expectedPass: boolean,
): void {
  const preflight = evidencePreflight({
    task: "Review the attached dependency update.",
    initialDraft: `The attached evidence confirms ${claim}.`,
    caller: "perplexity",
    attachmentsPresent: true,
    attachedEvidenceRefs: [patchPath],
    attachedEvidenceText: `${attachedEvidenceText.join("\n")}\n`,
  });

  assert.equal(preflight.pass, expectedPass, preflight.reason);
  assert.deepEqual(preflight.unattached_evidence_references, expectedPass ? [] : [claim]);
}

const regressions: Regression[] = [
  {
    name: "the fixture SHA-256 matches its exact UTF-8/LF attachment bytes",
    run: () => {
      const actualSha256 = crypto
        .createHash("sha256")
        .update(EVIDENCE_CONTENT, "utf8")
        .digest("hex");
      assert.equal(actualSha256, EVIDENCE_SHA);
    },
  },
  {
    name: "20 escaped GitHub URL citations correlated to one attachment preserve READY",
    run: () => {
      const citations = CHECK_RECORDS.map((record) => escapedProviderCitation(ATTACHMENT, record));
      const grounding = groundReadyPeerEvidence(readyPeer(citations), groundingInput([ATTACHMENT]));

      assert.equal(grounding.source_diagnostics.length, 20);
      assert.ok(
        grounding.source_diagnostics.every(
          (diagnostic) =>
            diagnostic.supported &&
            diagnostic.attachment_custody_claimed &&
            diagnostic.correlated_attachment === EVIDENCE_PATH,
        ),
        "all 20 path+digest+quote citations must remain correlated to the same attachment",
      );
      assert.equal(grounding.fabrication.fabricated, false);
      assert.equal(grounding.grounded, true);
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "an invented GitHub URL remains fail-closed",
    run: () => {
      const invented = escapedProviderCitation(
        ATTACHMENT,
        JSON.stringify({
          detailsUrl: "https://github.com/example-org/example-repo/actions/runs/99999/job/99999",
          status: "COMPLETED",
        }),
      );
      const grounding = groundReadyPeerEvidence(
        readyPeer([invented]),
        groundingInput([ATTACHMENT]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(
        grounding.unsupported_sources.includes(invented) || grounding.fabrication.fabricated,
      );
    },
  },
  {
    name: "a terminal backslash before an apostrophe remains a substantive fabricated URL byte",
    run: () => {
      const literalUrl = CHECK_URLS[0] ?? "";
      const detection = detectFabricatedEvidence(`The check URL is '${literalUrl}\\'`, {
        provenanceCorpus: literalUrl,
        priorDraftCorpus: "",
        narrativeCorpus: "",
      });

      assert.equal(detection.fabricated, true);
      assert.equal(detection.suspicious_assertion_count, 1);
    },
  },
  {
    name: "a terminal backslash before a double quote remains a substantive fabricated URL byte",
    run: () => {
      const literalUrl = CHECK_URLS[0] ?? "";
      const detection = detectFabricatedEvidence(`The check URL is "${literalUrl}\\"`, {
        provenanceCorpus: literalUrl,
        priorDraftCorpus: "",
        narrativeCorpus: "",
      });

      assert.equal(detection.fabricated, true);
      assert.equal(detection.suspicious_assertion_count, 1);
    },
  },
  {
    name: "a substantive backslash inside a serialized artifact URL remains fail-closed",
    run: () => {
      const literalUrl = CHECK_URLS[0] ?? "";
      const serializedRecord = JSON.stringify({ detailsUrl: `${literalUrl}\\` });
      const detection = detectFabricatedEvidence(
        `Artifact quote: ${JSON.stringify(serializedRecord)}`,
        {
          provenanceCorpus: literalUrl,
          priorDraftCorpus: "",
          narrativeCorpus: "",
        },
      );

      assert.equal(detection.fabricated, true);
      assert.equal(detection.suspicious_assertion_count, 1);
    },
  },
  {
    name: "GitHub URL path and query bytes remain case-sensitive",
    run: () => {
      const literalUrl =
        "https://github.com/example-org/example-repo/actions/runs/10000/job/20000?Token=AbC";
      const changedUrl =
        "https://github.com/example-org/example-repo/actions/runs/10000/job/20000?Token=abc";
      const detection = detectFabricatedEvidence(
        `Artifact quote: ${JSON.stringify(JSON.stringify({ detailsUrl: changedUrl }))}`,
        {
          provenanceCorpus: literalUrl,
          priorDraftCorpus: "",
          narrativeCorpus: "",
        },
      );

      assert.equal(detection.fabricated, true);
      assert.equal(detection.suspicious_assertion_count, 1);
    },
  },
  {
    name: "a quote cannot borrow path and digest custody from another attachment",
    run: () => {
      const attachmentA: EvidenceAttachment = {
        label: "run-a",
        relative_path: "evidence/run-a.txt",
        sha256: "a".repeat(64),
        content: "COMMAND: npm test\nTests 19 passed (19)",
      };
      const attachmentB: EvidenceAttachment = {
        label: "run-b",
        relative_path: "evidence/run-b.txt",
        sha256: "b".repeat(64),
        content: "COMMAND: npm test\nTests 20 passed (20)",
      };
      const borrowedQuote = escapedProviderCitation(attachmentA, "Tests 20 passed (20)");
      const grounding = groundReadyPeerEvidence(
        readyPeer([borrowedQuote]),
        groundingInput([attachmentA, attachmentB]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.ok(grounding.unsupported_sources.includes(borrowedQuote));
    },
  },
  {
    name: "relator file references resolve against files materialized in an attached unified diff",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: RELATOR_DRAFT,
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: [ATTACHMENT.relative_path],
        attachedEvidenceText: ATTACHMENT.content,
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "a genuinely absent file remains fail-closed beside a valid attached unified diff",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The same artifact confirms package.json and missing.log.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: [ATTACHMENT.relative_path],
        attachedEvidenceText: ATTACHMENT.content,
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["missing.log"]);
    },
  },
  {
    name: "a header-only patch cannot manufacture file custody",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms header-only.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/header-only.patch"],
        attachedEvidenceText:
          "diff --git a/header-only.md b/header-only.md\n--- a/header-only.md\n+++ b/header-only.md",
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["header-only.md"]);
    },
  },
  {
    name: "a deleted pre-image cannot manufacture post-image file custody",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms deleted.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/deleted.patch"],
        attachedEvidenceText: [
          "diff --git a/deleted.md b/deleted.md",
          "deleted file mode 100644",
          "--- a/deleted.md",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-deleted content",
        ].join("\n"),
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["deleted.md"]);
    },
  },
  {
    name: "a later post-image header cannot borrow an earlier file hunk",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms fabricated.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/header-confusion.patch"],
        attachedEvidenceText: [
          "diff --git a/real.md b/real.md",
          "--- a/real.md",
          "+++ b/real.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "+++ b/fabricated.md",
        ].join("\n"),
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["fabricated.md"]);
    },
  },
  {
    name: "a mismatched post-image path cannot contradict the diff header and manufacture custody",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms fabricated.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/path-mismatch.patch"],
        attachedEvidenceText: [
          "diff --git a/real.md b/real.md",
          "--- a/real.md",
          "+++ b/fabricated.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["fabricated.md"]);
    },
  },
  {
    name: "an invalid unified-diff hunk header cannot manufacture file custody",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms malformed.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/malformed-hunk.patch"],
        attachedEvidenceText: [
          "diff --git a/malformed.md b/malformed.md",
          "--- a/malformed.md",
          "+++ b/malformed.md",
          "@@ nonsense",
          "-old",
          "+new",
        ].join("\n"),
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["malformed.md"]);
    },
  },
  {
    name: "a truncated unified-diff hunk cannot satisfy its declared line counts",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms truncated.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/truncated-hunk.patch"],
        attachedEvidenceText: [
          "diff --git a/truncated.md b/truncated.md",
          "--- a/truncated.md",
          "+++ b/truncated.md",
          "@@ -1,10 +1,10 @@",
          "-old",
          "+new",
        ].join("\n"),
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["truncated.md"]);
    },
  },
  {
    name: "file-header-shaped hunk content remains literal post-image evidence",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms header-shaped-content.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/header-shaped-content.patch"],
        attachedEvidenceText: `${[
          "diff --git a/header-shaped-content.md b/header-shaped-content.md",
          "--- a/header-shaped-content.md",
          "+++ b/header-shaped-content.md",
          "@@ -1 +1 @@",
          "--- old content",
          "+++ new content",
        ].join("\n")}\n`,
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "separate invalid attachments cannot combine into one valid Git patch",
    run: () => {
      const attachedEvidenceSources = [
        [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
        ].join("\n"),
        ["@@ -1 +1 @@", '-{"version":"1.0.0"}', '+{"version":"1.0.1"}'].join("\n"),
      ];
      const preflightInput = {
        task: "Review the attached package.json evidence.",
        initialDraft: "The attached evidence confirms package.json.",
        caller: "perplexity" as const,
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/header.patch", "evidence/hunk.patch"],
        attachedEvidenceText: `${attachedEvidenceSources.join("\n")}\n`,
        attachedEvidenceSources,
      };
      const preflight = evidencePreflight(preflightInput);

      assert.equal(preflight.pass, false, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, ["package.json"]);
    },
  },
  {
    name: "extensionless Git paths cannot erase evidence-reference context",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached evidence.",
        initialDraft: "The attached evidence confirms missing.log.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/context-words.patch"],
        attachedEvidenceText: `${[
          "diff --git a/attached b/attached",
          "--- a/attached",
          "+++ b/attached",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "diff --git a/evidence b/evidence",
          "--- a/evidence",
          "+++ b/evidence",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n")}\n`,
      });

      assert.equal(preflight.pass, false, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, ["missing.log"]);
    },
  },
  {
    name: "a JSON-compatible quoted Git path with spaces preserves its exact path custody",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms docs with space/package.json.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/quoted-space.patch"],
        attachedEvidenceText: `${[
          'diff --git "a/docs with space/package.json" "b/docs with space/package.json"',
          '--- "a/docs with space/package.json"',
          '+++ "b/docs with space/package.json"',
          "@@ -1 +1 @@",
          '-{"version":"1.0.0"}',
          '+{"version":"1.0.1"}',
        ].join("\n")}\n`,
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "a case-distinct Git path cannot grant custody to a lowercase claim",
    run: () => {
      assertUnifiedDiffCustody(
        "report.md",
        "evidence/case-distinct-path.patch",
        [
          "diff --git a/REPORT.md b/REPORT.md",
          "--- a/REPORT.md",
          "+++ b/REPORT.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "a case-distinct Git path preserves custody for the exact claim",
    run: () => {
      assertUnifiedDiffCustody(
        "REPORT.md",
        "evidence/case-exact-path.patch",
        [
          "diff --git a/REPORT.md b/REPORT.md",
          "--- a/REPORT.md",
          "+++ b/REPORT.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        true,
      );
    },
  },
  {
    name: "a punctuation-distinct Git path cannot grant custody to a shorter claim",
    run: () => {
      assertUnifiedDiffCustody(
        "report.md",
        "evidence/punctuation-distinct-path.patch",
        [
          "diff --git a/report.md. b/report.md.",
          "--- a/report.md.",
          "+++ b/report.md.",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "a duplicated Git basename cannot grant ambiguous unqualified custody",
    run: () => {
      assertUnifiedDiffCustody(
        "config.json",
        "evidence/ambiguous-basename.patch",
        [
          "diff --git a/src/config.json b/src/config.json",
          "--- a/src/config.json",
          "+++ b/src/config.json",
          "@@ -1 +1 @@",
          "-old source config",
          "+new source config",
          "diff --git a/test/config.json b/test/config.json",
          "--- a/test/config.json",
          "+++ b/test/config.json",
          "@@ -1 +1 @@",
          "-old test config",
          "+new test config",
        ],
        false,
      );
    },
  },
  {
    name: "a completed hunk remains valid before a plus-prefixed raw trailer",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/plus-trailer.patch",
        [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
          "@@ -1 +1 @@",
          '-{"version":"1.0.0"}',
          '+{"version":"1.0.1"}',
          "+raw provider record",
        ],
        true,
      );
    },
  },
  {
    name: "a completed hunk remains valid before a minus-prefixed Markdown trailer",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/minus-trailer.patch",
        [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
          "@@ -1 +1 @@",
          '-{"version":"1.0.0"}',
          '+{"version":"1.0.1"}',
          "- Markdown bullet",
        ],
        true,
      );
    },
  },
  {
    name: "a completed hunk remains valid before a space-prefixed raw trailer",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/space-trailer.patch",
        [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
          "@@ -1 +1 @@",
          '-{"version":"1.0.0"}',
          '+{"version":"1.0.1"}',
          " indented record",
        ],
        true,
      );
    },
  },
  {
    name: "a completed hunk remains valid before a Markdown thematic-break trailer",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/thematic-break-trailer.patch",
        [
          "diff --git a/package.json b/package.json",
          "--- a/package.json",
          "+++ b/package.json",
          "@@ -1 +1 @@",
          '-{"version":"1.0.0"}',
          '+{"version":"1.0.1"}',
          "-- ",
        ],
        true,
      );
    },
  },
  {
    name: "a JSON-only Unicode escape cannot forge Git path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/unicode-escape-path.patch",
        [
          'diff --git "a/p\\u0061ckage.json" "b/p\\u0061ckage.json"',
          '--- "a/p\\u0061ckage.json"',
          '+++ "b/p\\u0061ckage.json"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "a JSON-only escaped slash cannot forge Git path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "package.json",
        "evidence/escaped-slash-path.patch",
        [
          'diff --git "a/docs\\/package.json" "b/docs\\/package.json"',
          '--- "a/docs\\/package.json"',
          '+++ "b/docs\\/package.json"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "a literal backslash in a Git-quoted path cannot alias a forward slash",
    run: () => {
      assertUnifiedDiffCustody(
        "foo/bar.md",
        "evidence/backslash-alias-path.patch",
        [
          'diff --git "a/foo\\\\bar.md" "b/foo\\\\bar.md"',
          '--- "a/foo\\\\bar.md"',
          '+++ "b/foo\\\\bar.md"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "the official Git decoder preserves a valid C-style octal path",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms report.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/octal-path.patch"],
        attachedEvidenceText: `${[
          'diff --git "a/docs/\\303\\251/report.md" "b/docs/\\303\\251/report.md"',
          '--- "a/docs/\\303\\251/report.md"',
          '+++ "b/docs/\\303\\251/report.md"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n")}\n`,
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "an internal relator continuation reaches all four reviewer adapters",
    run: async () => {
      const events: Array<{ type: string; peer?: PeerId }> = [];
      const dataDir = createRegressionDataDir();
      try {
        const config = regressionConfig(dataDir);
        assert.equal(config.evidence_preflight_enabled, true);
        const orchestrator = new CrossReviewOrchestrator(config, (event) => {
          events.push({
            type: event.type,
            ...(event.peer === undefined ? {} : { peer: event.peer }),
          });
        });
        const session = await orchestrator.initSession(
          "Review the attached dependency update.",
          "codex",
        );
        await orchestrator.store.attachCallerEvidenceSubmission(session.session_id, {
          submitted_by: "codex",
          artifact_text: "Caller-supplied dependency evidence.",
          items: [
            {
              label: ATTACHMENT.label,
              content: ATTACHMENT.content,
              content_type: "text/plain; charset=utf-8",
              extension: "txt",
            },
          ],
        });

        const result = await orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: RELATOR_DRAFT,
          petitioner: "codex",
          caller: "perplexity",
          lead_peer: "perplexity",
          caller_status: "READY",
          peers: ["claude", "gemini", "deepseek", "grok"],
        });
        const peerCallStarts = events.filter((event) => event.type === "peer.call.started");

        assert.deepEqual(peerCallStarts.map((event) => event.peer).sort(), [
          "claude",
          "deepseek",
          "gemini",
          "grok",
        ]);
        assert.equal(
          result.round.rejected.some((failure) => failure.failure_class === "evidence_preflight"),
          false,
        );
        assert.equal(
          events.some((event) => event.type === "session.evidence_preflight_failed"),
          false,
        );
      } finally {
        removeRegressionDataDir(dataDir);
      }
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
  `[v4.6.5-evidence-custody-regression] ${regressions.length - failures.length}/${regressions.length} GREEN; ${failures.length}/${regressions.length} RED`,
);
if (failures.length > 0) process.exitCode = 1;
