import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { buildEvidenceCustodyIndex } from "../src/core/evidence-custody.js";
import {
  CrossReviewOrchestrator,
  detectFabricatedEvidence,
  evidencePreflight,
  groundReadyPeerEvidence,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import type { PeerAdapter, PeerId, PeerResult } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

type EvidenceAttachment = {
  label: string;
  relative_path: string;
  sha256: string;
  content: string;
  bytes?: number;
  truncated?: boolean;
};

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const EVIDENCE_PATH = "evidence/caller-structured-evidence-fixture.txt";
const EVIDENCE_SHA = "e4aa6f749e2bc8eb9a4c1c38fe316876e8eaa118f5ffaf2839c0b98bdb805b2d";
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
  "diff --git a/checks.ndjson b/checks.ndjson",
  "new file mode 100644",
  "index 0000000..4444444",
  "--- /dev/null",
  "+++ b/checks.ndjson",
  "@@ -0,0 +1,20 @@",
  ...CHECK_RECORDS.map((record) => `+${record}`),
  "",
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

function notReadyPeer(summary: string, evidenceSources: string[]): PeerResult {
  const result = readyPeer(evidenceSources);
  result.status = "NOT_READY";
  result.raw_status = "NOT_READY";
  result.parsed_status = "NOT_READY";
  result.normalized_status = "NOT_READY";
  result.structured = {
    ...result.structured!,
    status: "NOT_READY",
    summary,
  };
  return result;
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
    callerSubmittedAttachments: attachments.map((attachment) => ({
      ...attachment,
      bytes: attachment.bytes ?? Buffer.byteLength(attachment.content, "utf8"),
      truncated: attachment.truncated ?? false,
    })),
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

function regressionConfig(dataDir: string) {
  const base = loadConfig();
  return {
    ...base,
    data_dir: dataDir,
    evidence_preflight_enabled: true,
    truthfulness_preflight_enabled: true,
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
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

function assertUnifiedDiffCustody(
  claim: string,
  patchPath: string,
  attachedEvidenceText: string[],
  expectedPass: boolean,
): void {
  const patchText = `${attachedEvidenceText.join("\n")}\n`;
  const preflight = evidencePreflight({
    task: "Review the attached dependency update.",
    initialDraft: `The attached evidence confirms ${claim}.`,
    caller: "perplexity",
    attachmentsPresent: true,
    attachedEvidenceRefs: [patchPath],
    attachedEvidenceText: patchText,
  });

  const index = buildEvidenceCustodyIndex(patchText);
  assert.equal(
    preflight.pass,
    expectedPass,
    `${preflight.reason}; custody=${index.validation}; paths=${index.exactGitPaths.join(",")}`,
  );
  assert.deepEqual(preflight.unattached_evidence_references, expectedPass ? [] : [claim]);
}

const regressions: Regression[] = [
  {
    name: "the official Git capability validates and indexes the fixture once",
    run: () => {
      const index = buildEvidenceCustodyIndex(EVIDENCE_CONTENT);
      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, ["package.json", "THIRDPARTY.md", "checks.ndjson"]);
      assert.equal(index.postImageHunks.length, 3);
      assert.equal(index.removedHunks.length, 2);
      assert.equal(index.removedHunksWithMarkers.length, 2);
      assert.equal(
        index.removedHunksWithMarkers.some((hunk) => hunk.includes('-{"version":"1.0.0"}')),
        true,
        "removed custody must preserve raw '-' markers as well as markerless source text",
      );
    },
  },
  {
    name: "ordinary non-patch evidence cannot evict a reusable validated custody index",
    run: () => {
      const first = buildEvidenceCustodyIndex(EVIDENCE_CONTENT);
      for (let index = 0; index < 65; index += 1) {
        assert.equal(
          buildEvidenceCustodyIndex(`ordinary evidence log ${index}`).validation,
          "not_patch",
        );
      }
      const second = buildEvidenceCustodyIndex(EVIDENCE_CONTENT);

      assert.strictEqual(second, first);
    },
  },
  {
    name: "the official Git capability accepts a single-file traditional unified diff",
    run: () => {
      const content = [
        "--- a/plain.md",
        "+++ b/plain.md",
        "@@ -1 +1 @@",
        "-old-state",
        "+current-state",
        "",
      ].join("\n");
      const index = buildEvidenceCustodyIndex(content);

      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, ["plain.md"]);
      assert.deepEqual(index.postImageHunks, ["current-state"]);
      assertUnifiedDiffCustody(
        "plain.md",
        "evidence/traditional-single-file.patch",
        content.trimEnd().split("\n"),
        true,
      );
    },
  },
  {
    name: "a traditional mode-less deletion grants no post-image path custody",
    run: () => {
      const content = [
        "--- a/deleted.md",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed-state",
        "",
      ].join("\n");
      const index = buildEvidenceCustodyIndex(content);

      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageFiles, []);
      assert.deepEqual(index.removedHunks, ["removed-state"]);
    },
  },
  {
    name: "a traditional deleted filename that begins with mode bytes stays unambiguous",
    run: () => {
      const content = [
        "--- a/mode 100644 deleted.md",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed-state",
        "",
      ].join("\n");
      const index = buildEvidenceCustodyIndex(content);

      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageFiles, []);
    },
  },
  {
    name: "a bare carriage return inside a Git-authenticated hunk fails closed",
    run: () => {
      const content = [
        "diff --git a/hidden.txt b/hidden.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/hidden.txt",
        "@@ -0,0 +1 @@",
        "+visible\rHIDDEN",
        "",
      ].join("\n");
      const index = buildEvidenceCustodyIndex(content);

      assert.equal(index.validation, "invalid_patch");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageFiles, []);
    },
  },
  {
    name: "CRLF patch terminators preserve canonical post-image line content",
    run: () => {
      const content = [
        "diff --git a/windows.txt b/windows.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/windows.txt",
        "@@ -0,0 +1 @@",
        "+windows-line",
        "",
      ].join("\r\n");
      const index = buildEvidenceCustodyIndex(content);

      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, ["windows.txt"]);
      assert.deepEqual(index.postImageFiles, [
        { path: "windows.txt", startLine: 1, lines: ["windows-line"] },
      ]);
    },
  },
  {
    name: "coherent adjacent and zero-width Git hunks retain exact post-image custody",
    run: () => {
      const modificationPatch = (...hunkLines: string[]): string =>
        ["diff --git a/x.txt b/x.txt", "--- a/x.txt", "+++ b/x.txt", ...hunkLines, ""].join("\n");
      const cases = [
        {
          name: "split insertions at one old-image anchor",
          content: modificationPatch("@@ -1,0 +2 @@", "+first", "@@ -1,0 +3 @@", "+second"),
          paths: ["x.txt"],
          postImageFiles: [
            { path: "x.txt", startLine: 2, lines: ["first"] },
            { path: "x.txt", startLine: 3, lines: ["second"] },
          ],
        },
        {
          name: "split deletions at one new-image anchor",
          content: modificationPatch("@@ -2 +1,0 @@", "-two", "@@ -3 +1,0 @@", "-three"),
          paths: ["x.txt"],
          postImageFiles: [],
        },
        {
          name: "insertion immediately followed by modification of the next old line",
          content: modificationPatch("@@ -1,0 +2 @@", "+insert", "@@ -2 +3 @@", "-two", "+TWO"),
          paths: ["x.txt"],
          postImageFiles: [
            { path: "x.txt", startLine: 2, lines: ["insert"] },
            { path: "x.txt", startLine: 3, lines: ["TWO"] },
          ],
        },
        {
          name: "deletion immediately followed by modification at the same new boundary",
          content: modificationPatch("@@ -2 +1,0 @@", "-two", "@@ -3 +2 @@", "-three", "+THREE"),
          paths: ["x.txt"],
          postImageFiles: [{ path: "x.txt", startLine: 2, lines: ["THREE"] }],
        },
        {
          name: "adjacent ordinary hunks",
          content: modificationPatch("@@ -1 +1 @@", "-one", "+ONE", "@@ -2 +2 @@", "-two", "+TWO"),
          paths: ["x.txt"],
          postImageFiles: [
            { path: "x.txt", startLine: 1, lines: ["ONE"] },
            { path: "x.txt", startLine: 2, lines: ["TWO"] },
          ],
        },
        {
          name: "unequal hunk sizes with equal unchanged inter-hunk gaps",
          content: modificationPatch(
            "@@ -1 +1,2 @@",
            "-one",
            "+ONE",
            "+extra",
            "@@ -3 +4 @@",
            "-three",
            "+THREE",
          ),
          paths: ["x.txt"],
          postImageFiles: [
            { path: "x.txt", startLine: 1, lines: ["ONE", "extra"] },
            { path: "x.txt", startLine: 4, lines: ["THREE"] },
          ],
        },
      ] as const;

      for (const testCase of cases) {
        const index = buildEvidenceCustodyIndex(testCase.content);
        assert.equal(index.validation, "validated", testCase.name);
        assert.deepEqual(index.exactGitPaths, testCase.paths, testCase.name);
        assert.deepEqual(index.postImageFiles, testCase.postImageFiles, testCase.name);
      }
    },
  },
  {
    name: "contradictory hunk geometry and repeated destinations fail closed",
    run: () => {
      const modificationPatch = (...hunkLines: string[]): string =>
        ["diff --git a/x.txt b/x.txt", "--- a/x.txt", "+++ b/x.txt", ...hunkLines, ""].join("\n");
      const invalidCases = [
        {
          name: "both images reverse",
          content: modificationPatch(
            "@@ -10 +10 @@",
            "-ten",
            "+TEN",
            "@@ -1 +1 @@",
            "-one",
            "+ONE",
          ),
        },
        {
          name: "only the new image reverses",
          content: modificationPatch(
            "@@ -1 +10 @@",
            "-one",
            "+ONE",
            "@@ -3 +1 @@",
            "-three",
            "+THREE",
          ),
        },
        {
          name: "old-image ranges overlap",
          content: modificationPatch(
            "@@ -1,2 +1,2 @@",
            "-one",
            "-two",
            "+ONE",
            "+TWO",
            "@@ -2 +3 @@",
            "-two",
            "+again",
          ),
        },
        {
          name: "new-image ranges overlap",
          content: modificationPatch(
            "@@ -1,2 +1,2 @@",
            "-one",
            "-two",
            "+ONE",
            "+TWO",
            "@@ -3 +2 @@",
            "-three",
            "+again",
          ),
        },
        {
          name: "new-image unchanged gap is too large",
          content: modificationPatch(
            "@@ -1 +1 @@",
            "-one",
            "+ONE",
            "@@ -3 +4 @@",
            "-three",
            "+THREE",
          ),
        },
        {
          name: "new-image unchanged gap omits an insertion shift",
          content: modificationPatch(
            "@@ -1 +1,2 @@",
            "-one",
            "+ONE",
            "+extra",
            "@@ -3 +3 @@",
            "-three",
            "+THREE",
          ),
        },
        {
          name: "repeated old zero-width anchor has a new-image gap",
          content: modificationPatch("@@ -1,0 +2 @@", "+first", "@@ -1,0 +4 @@", "+second"),
        },
        {
          name: "repeated new zero-width anchor has an old-image gap",
          content: modificationPatch("@@ -2 +1,0 @@", "-two", "@@ -4 +1,0 @@", "-four"),
        },
        {
          name: "non-empty old range starts at zero",
          content: modificationPatch("@@ -0 +1 @@", "-old", "+new"),
        },
        {
          name: "non-empty new range starts at zero",
          content: modificationPatch("@@ -1 +0 @@", "-old", "+new"),
        },
        {
          name: "two modification sections target one destination",
          content: [
            modificationPatch("@@ -1 +1 @@", "-one", "+ONE").trimEnd(),
            modificationPatch("@@ -2 +2 @@", "-two", "+TWO"),
          ].join("\n"),
        },
        {
          name: "one path is created and then deleted",
          content: [
            "diff --git a/x.txt b/x.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/x.txt",
            "@@ -0,0 +1 @@",
            "+X",
            "diff --git a/x.txt b/x.txt",
            "deleted file mode 100644",
            "--- a/x.txt",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-X",
            "",
          ].join("\n"),
        },
        {
          name: "one path is deleted and then created",
          content: [
            "diff --git a/x.txt b/x.txt",
            "deleted file mode 100644",
            "--- a/x.txt",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-X",
            "diff --git a/x.txt b/x.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/x.txt",
            "@@ -0,0 +1 @@",
            "+Y",
            "",
          ].join("\n"),
        },
        {
          name: "one path is created and then modified",
          content: [
            "diff --git a/x.txt b/x.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/x.txt",
            "@@ -0,0 +1 @@",
            "+X",
            modificationPatch("@@ -1 +1 @@", "-X", "+Y"),
          ].join("\n"),
        },
        {
          name: "one path is modified and then deleted",
          content: [
            modificationPatch("@@ -1 +1 @@", "-X", "+Y").trimEnd(),
            "diff --git a/x.txt b/x.txt",
            "deleted file mode 100644",
            "--- a/x.txt",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-Y",
            "",
          ].join("\n"),
        },
      ];

      for (const testCase of invalidCases) {
        const index = buildEvidenceCustodyIndex(testCase.content);
        assert.equal(index.validation, "invalid_patch", testCase.name);
        assert.deepEqual(index.exactGitPaths, [], testCase.name);
        assert.deepEqual(index.postImageFiles, [], testCase.name);
      }
    },
  },
  {
    name: "create-delete permutations preserve only unambiguous final destinations",
    run: () => {
      const create = [
        "diff --git a/created.txt b/created.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/created.txt",
        "@@ -0,0 +1 @@",
        "+created",
      ];
      const remove = [
        "diff --git a/removed.txt b/removed.txt",
        "deleted file mode 100644",
        "--- a/removed.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed",
      ];

      for (const sections of [
        [...create, ...remove, ""],
        [...remove, ...create, ""],
      ]) {
        const index = buildEvidenceCustodyIndex(sections.join("\n"));
        assert.equal(index.validation, "validated");
        assert.deepEqual(index.exactGitPaths, ["created.txt"]);
        assert.deepEqual(index.postImageFiles, [
          { path: "created.txt", startLine: 1, lines: ["created"] },
        ]);
      }
    },
  },
  {
    name: "patch custody spans the exact 200000 UTF-16-code-unit evidence boundary",
    run: () => {
      const prefix = [
        "diff --git a/big.txt b/big.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/big.txt",
        "@@ -0,0 +1 @@",
      ].join("\n");
      const exactLengthPatch = (targetLength: number, token: string): string => {
        const opening = `${prefix}\n+`;
        const payloadLength = targetLength - opening.length - 1;
        assert.ok(payloadLength >= 0);
        const tokenCount = Math.floor(payloadLength / token.length);
        const content = `${opening}${token.repeat(tokenCount)}${"a".repeat(
          payloadLength - tokenCount * token.length,
        )}\n`;
        assert.equal(content.length, targetLength);
        return content;
      };

      for (const [name, content] of [
        ["three-byte BMP text below the boundary", exactLengthPatch(199_999, "漢")],
        ["three-byte BMP text at the boundary", exactLengthPatch(200_000, "漢")],
        ["astral text at the boundary", exactLengthPatch(200_000, "😀")],
      ] as const) {
        assert.ok(Buffer.byteLength(content, "utf8") > 200 * 1024, name);
        const index = buildEvidenceCustodyIndex(content);
        assert.equal(index.validation, "validated", name);
        assert.deepEqual(index.exactGitPaths, ["big.txt"], name);
      }

      for (const [name, content] of [
        ["three-byte BMP text above the boundary", exactLengthPatch(200_001, "漢")],
        ["astral text above the boundary", exactLengthPatch(200_001, "😀")],
      ] as const) {
        assert.equal(buildEvidenceCustodyIndex(content).validation, "input_too_large", name);
      }

      const validBoundary = exactLengthPatch(200_000, "漢");
      const unpairedSurrogate = `${validBoundary.slice(0, -2)}\ud800\n`;
      assert.equal(unpairedSurrogate.length, 200_000);
      assert.equal(buildEvidenceCustodyIndex(unpairedSurrogate).validation, "invalid_patch");
    },
  },
  {
    name: "Git reporting admits a Unicode mode-only patch at the public evidence boundary",
    run: () => {
      const sections = Array.from({ length: 100 }, (_, index) => {
        const suffix = String(index).padStart(4, "0");
        const unicodePath = `dir-${suffix}/${"漢".repeat(957 + (index === 0 ? 50 : 0))}-${suffix}.txt`;
        return [
          `diff --git a/${unicodePath} b/${unicodePath}`,
          "old mode 100644",
          "new mode 100755",
          "",
        ].join("\n");
      }).join("");

      assert.equal(sections.length, 200_000);
      assert.ok(Buffer.byteLength(sections, "utf8") > 512 * 1024);
      const index = buildEvidenceCustodyIndex(sections);
      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageFiles, []);
    },
  },
  {
    name: "the Git reporting operation never materializes a validated new file",
    run: () => {
      const fileName = `cross-review-custody-write-probe-${crypto.randomUUID()}.txt`;
      const target = path.join(os.tmpdir(), fileName);
      const content = [
        `diff --git a/${fileName} b/${fileName}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${fileName}`,
        "@@ -0,0 +1 @@",
        "+must-not-be-written",
        "",
      ].join("\n");

      try {
        assert.equal(fs.existsSync(target), false);
        assert.equal(buildEvidenceCustodyIndex(content).validation, "validated");
        assert.equal(fs.existsSync(target), false);
      } finally {
        fs.rmSync(target, { force: true });
      }
    },
  },
  {
    name: "an unavailable Git capability grants no patch-derived custody",
    run: () => {
      const index = buildEvidenceCustodyIndex(EVIDENCE_CONTENT, { gitExecutable: null });
      assert.equal(index.validation, "git_unavailable");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageHunks, []);
      assert.deepEqual(index.removedHunks, []);
    },
  },
  {
    name: "a rejected patch-like attachment cannot fall back to raw removed evidence",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "\\ No newline at end of file",
        "-removed-only-secret-value",
        "+new-value-that-is-safe",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "rejected-patch",
        relative_path: "evidence/rejected.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "removed-only-secret-value")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a deterministic invalid patch reuses one fail-closed custody result",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-truncated-before-new-line",
      ].join("\n");
      const first = buildEvidenceCustodyIndex(content);
      const second = buildEvidenceCustodyIndex(content);

      assert.equal(first.validation, "invalid_patch");
      assert.strictEqual(second, first);
    },
  },
  {
    name: "separate evidence sources cannot concatenate into a synthetic valid patch",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review evidence.",
        initialDraft: "The attached evidence confirms split.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        structuredEvidence:
          ["diff --git a/split.md b/split.md", "--- a/split.md", "+++ b/split.md"].join("\n") +
          "\n",
        attachedEvidenceText: ["@@ -1 +1 @@", "-old", "+new", ""].join("\n"),
        attachedEvidenceRefs: ["evidence/half.patch"],
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["split.md"]);
    },
  },
  {
    name: "two attachments cannot concatenate into a synthetic valid patch",
    run: () => {
      const header = [
        "diff --git a/split-attachments.md b/split-attachments.md",
        "--- a/split-attachments.md",
        "+++ b/split-attachments.md",
      ].join("\n");
      const hunk = ["@@ -1 +1 @@", "-old", "+new", ""].join("\n");
      const preflight = evidencePreflight({
        task: "Review evidence.",
        initialDraft: "The attached evidence confirms split-attachments.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceSources: [header, hunk],
        attachedEvidenceText: `${header}\n${hunk}`,
        attachedEvidenceRefs: ["evidence/header.patch", "evidence/hunk.patch"],
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["split-attachments.md"]);
    },
  },
  {
    name: "Git validates the exact attachment bytes without adding a final LF",
    run: () => {
      const noFinalLf = [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n");
      const index = buildEvidenceCustodyIndex(noFinalLf);

      assert.equal(index.validation, "invalid_patch");
      assert.deepEqual(index.exactGitPaths, []);
    },
  },
  {
    name: "an ordinary log containing an at-sign summary remains non-patch evidence",
    run: () => {
      const content = "build log\n@@ summary\nordinary-log-line-passed-20-tests";
      const attachment: EvidenceAttachment = {
        label: "ordinary-log",
        relative_path: "evidence/build.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "ordinary-log-line-passed-20-tests")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, true);
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "a large Unicode ordinary log is not subject to the patch byte limit",
    run: () => {
      const content = `${"é".repeat(102_500)}\nordinary-unicode-log-passed-all-checks`;
      assert.ok(Buffer.byteLength(content, "utf8") > 200 * 1024);
      assert.ok(content.length < 200 * 1024);
      const attachment: EvidenceAttachment = {
        label: "large-unicode-log",
        relative_path: "evidence/large-unicode.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "ordinary-unicode-log-passed-all-checks")]),
        groundingInput([attachment]),
      );

      assert.equal(buildEvidenceCustodyIndex(content).validation, "not_patch");
      assert.equal(grounding.grounded, true);
      assert.equal(grounding.result.status, "READY");
    },
  },
  {
    name: "metadata padding cannot make a removed line current evidence",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-removed-only-secret-value",
        "+new-value-that-is-safe",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "removed-padding",
        relative_path: "evidence/removed-padding.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const source = [
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "@@ -1 +1 @@',
        '-removed-only-secret-value"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer([source]), groundingInput([attachment]));

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a valid marked quote cannot hide an earlier quote under any supported delimiter",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-removed-only-secret-value",
        "+new-value-that-is-safe",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "prefixed-quote",
        relative_path: "evidence/prefixed-quote.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      for (const prefixedClaim of [
        'Claim: "removed-only-secret-value"',
        "Source: 'removed-only-secret-value'",
        "Evidence: ‘removed-only-secret-value’",
        "Claim: `removed-only-secret-value`",
        'Claim: "removed-only-secret-value\nsecond-removed-secret-value"',
        "Source: 'removed-only-secret-value\nsecond-removed-secret-value'",
        "Evidence: ‘removed-only-secret-value\nsecond-removed-secret-value’",
        "Claim: `removed-only-secret-value src/auth.ts:99`",
      ]) {
        const source = [
          `Attachment: ${attachment.relative_path}`,
          `sha256=${attachment.sha256}`,
          prefixedClaim,
          'Artifact quote: "new-value-that-is-safe"',
        ].join("\n");
        const grounding = groundReadyPeerEvidence(
          readyPeer([source]),
          groundingInput([attachment]),
        );

        assert.equal(grounding.grounded, false, prefixedClaim);
        assert.equal(grounding.result.status, "NEEDS_EVIDENCE", prefixedClaim);
      }
    },
  },
  {
    name: "an internal removed-line boundary cannot be cited as attachment bytes",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-removed-only-secret-value",
        "+new-value-that-is-safe",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "boundary-forgery",
        relative_path: "evidence/boundary-forgery.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "\0CROSS_REVIEW_REMOVED_LINE\0")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "arbitrary patch trailers cannot authenticate a removed phrase",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-shared-evidence-value",
        "+new-value-that-is-safe",
        "verification-log: shared-evidence-value",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "duplicate-occurrence",
        relative_path: "evidence/duplicate-occurrence.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "shared-evidence-value")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a truncated patch prefix cannot borrow the whole-file SHA-256",
    run: () => {
      const prefix = [
        "diff --git a/a.md b/a.md",
        "--- a/a.md",
        "+++ b/a.md",
        "@@ -1 +1 @@",
        "-old-a",
        "+new-a-current-value",
        "",
      ].join("\n");
      const wholeFile = `${prefix}diff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n-old-b`;
      const sha256 = crypto.createHash("sha256").update(wholeFile, "utf8").digest("hex");
      const attachment = {
        label: "truncated-patch",
        relative_path: "evidence/truncated-whole.patch",
        sha256,
        content: prefix,
        truncated: true,
        bytes: Buffer.byteLength(wholeFile, "utf8"),
      };
      const source = [
        `Attachment: ${attachment.relative_path}`,
        `sha256=${sha256}`,
        'Artifact quote: "new-a-current-value"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer([source]), {
        artifactText: "Review the truncated attachment.",
        attachedEvidenceText: "",
        attachmentRefs: [attachment.relative_path],
        evidenceAttachments: [{ relative_path: attachment.relative_path, sha256 }],
        callerSubmittedAttachments: [attachment],
        runtimeFacts: {},
      });

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a truncated log prefix cannot certify completed work with an omitted contradictory tail",
    run: () => {
      const prefix = "COMMAND: npm test\nexit_code=0\nTests 20 passed (20)";
      const wholeFile = `${prefix}\nRETRY: npm test\nexit_code=1\nTests 1 failed (20)`;
      const attachment = {
        label: "truncated-log",
        relative_path: "evidence/truncated.log",
        sha256: crypto.createHash("sha256").update(wholeFile, "utf8").digest("hex"),
        content: prefix,
        bytes: Buffer.byteLength(wholeFile, "utf8"),
        truncated: true,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "Tests 20 passed (20)")]),
        {
          artifactText: "The completed implementation reports npm test with 20 passed.",
          attachedEvidenceText: "",
          attachmentRefs: [attachment.relative_path],
          evidenceAttachments: [attachment],
          callerSubmittedAttachments: [attachment],
          requirePeerSubmittedCorroboration: true,
          runtimeFacts: {},
        },
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
      assert.equal(grounding.peer_submitted_evidence_corroborated, false);
    },
  },
  {
    name: "a complete attachment cannot borrow a digest from different bytes",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-old",
        "+current-complete-value",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "digest-mismatch",
        relative_path: "evidence/digest-mismatch.patch",
        sha256: crypto.createHash("sha256").update(`${content}different`, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "current-complete-value")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a complete attachment cannot borrow a byte count from different content",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-old",
        "+current-complete-value",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "byte-count-mismatch",
        relative_path: "evidence/byte-count-mismatch.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8") + 1,
        truncated: false,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "current-complete-value")]),
        groundingInput([attachment]),
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
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
      const trustedUrl =
        "https://github.com/example-org/example-repo/actions/runs/123/job/456?check=Alpha";
      for (const fabricatedUrl of [
        "https://github.com/example-org/example-repo/actions/Runs/123/job/456?check=Alpha",
        "https://github.com/example-org/example-repo/actions/runs/123/job/456?check=alpha",
      ]) {
        const detection = detectFabricatedEvidence(`The check URL is ${fabricatedUrl}`, {
          provenanceCorpus: trustedUrl,
          priorDraftCorpus: "",
          narrativeCorpus: "",
        });

        assert.equal(detection.fabricated, true, fabricatedUrl);
        assert.equal(detection.suspicious_assertion_count, 1, fabricatedUrl);
      }
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
    name: "an attachment path with an invented suffix cannot borrow exact custody",
    run: () => {
      const content = "COMMAND: npm test\nTests 20 passed (20)";
      const attachment: EvidenceAttachment = {
        label: "exact-path",
        relative_path: "evidence/exact.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const source = escapedProviderCitation(attachment, "Tests 20 passed (20)").replace(
        attachment.relative_path,
        `${attachment.relative_path}.bak`,
      );
      const grounding = groundReadyPeerEvidence(readyPeer([source]), groundingInput([attachment]));

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a digest token with extra bytes cannot borrow exact custody",
    run: () => {
      const content = "COMMAND: npm test\nTests 20 passed (20)";
      const attachment: EvidenceAttachment = {
        label: "exact-digest",
        relative_path: "evidence/exact-digest.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const source = escapedProviderCitation(attachment, "Tests 20 passed (20)").replace(
        attachment.sha256,
        `${attachment.sha256}ff`,
      );
      const grounding = groundReadyPeerEvidence(readyPeer([source]), groundingInput([attachment]));

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "an extra attachment declaration invalidates an otherwise exact custody envelope",
    run: () => {
      const content = "COMMAND: npm test\nTests 20 passed (20)";
      const attachment: EvidenceAttachment = {
        label: "single-envelope",
        relative_path: "evidence/single.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const source = [
        `Attachment: ${attachment.relative_path}`,
        "Attachment: evidence/invented.log",
        `sha256=${attachment.sha256}`,
        'Artifact quote: "Tests 20 passed (20)"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer([source]), groundingInput([attachment]));

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "every substantive quote in one source must match the same attachment",
    run: () => {
      const content = "COMMAND: npm test\nTests 20 passed (20)";
      const attachment: EvidenceAttachment = {
        label: "all-quotes",
        relative_path: "evidence/all-quotes.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const source = [
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Source: "Tests 20 passed (20)"',
        'Source: "invented critical failure 999"',
      ].join("\n");
      const grounding = groundReadyPeerEvidence(readyPeer([source]), groundingInput([attachment]));

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a caller attachment without a complete provenance envelope fails closed",
    run: () => {
      const content = "COMMAND: npm test\nTests 20 passed (20)";
      const attachment: EvidenceAttachment = {
        label: "missing-envelope",
        relative_path: "evidence/missing-envelope.log",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([escapedProviderCitation(attachment, "Tests 20 passed (20)")]),
        {
          artifactText: "Review the submitted evidence.",
          attachedEvidenceText: "",
          attachmentRefs: [attachment.relative_path],
          callerSubmittedAttachments: [attachment as never],
          runtimeFacts: {},
        },
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "sha256 text inside an artifact quote does not claim attachment custody",
    run: () => {
      const artifactText = "Hash contract says sha256=automatic remains supported.";
      const grounding = groundReadyPeerEvidence(readyPeer([`Artifact quote: "${artifactText}"`]), {
        artifactText,
        attachedEvidenceText: "",
        attachmentRefs: [],
        runtimeFacts: {},
      });

      assert.equal(grounding.grounded, true, JSON.stringify(grounding));
      assert.equal(grounding.result.status, "READY", JSON.stringify(grounding));
      assert.equal(grounding.source_diagnostics[0]?.attachment_custody_claimed, false);
    },
  },
  {
    name: "operator evidence boundaries cannot synthesize command or workflow authority",
    run: () => {
      const commandParts = ["COMMAND: npm run test", "EXIT_CODE: 0"].map((content, index) => ({
        label: `command-part-${index + 1}`,
        relative_path: `evidence/command-part-${index + 1}.log`,
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      }));
      const evidence = evidencePreflight({
        task: "I ran npm run test successfully.",
        caller: "operator",
        attachmentsPresent: true,
        reviewableAttachments: commandParts,
        operatorVerifiedAttachments: commandParts,
      });
      assert.equal(evidence.pass, false, JSON.stringify(evidence));
      assert.equal(evidence.operator_grounded, false, JSON.stringify(evidence));
      assert.deepEqual(evidence.uncorroborated_operational_claims, ["npm run test"]);

      const workflowParts = ["workflow dispatch", "workflow status=success"].map(
        (content, index) => ({
          label: `workflow-part-${index + 1}`,
          relative_path: `evidence/workflow-part-${index + 1}.log`,
          sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          truncated: false,
        }),
      );
      const truthfulness = truthfulnessPreflight({
        task: "I dispatched the workflow.",
        caller: "operator",
        attachmentsPresent: true,
        reviewableAttachments: workflowParts,
        operatorVerifiedAttachments: workflowParts,
      });
      assert.equal(truthfulness.pass, false, JSON.stringify(truthfulness));
      assert.equal(truthfulness.operator_grounded, false, JSON.stringify(truthfulness));
      assert.equal(truthfulness.independent_review_required, false, JSON.stringify(truthfulness));
    },
  },
  {
    name: "a validated patch retains typed git-diff corroboration without exposing headers",
    run: () => {
      const content = [
        "diff --git a/current.txt b/current.txt",
        "--- a/current.txt",
        "+++ b/current.txt",
        "@@ -1 +1 @@",
        "-old value",
        "+current value",
        "",
      ].join("\n");
      const attachment = {
        label: "validated-patch",
        relative_path: "evidence/current.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      };
      const preflight = evidencePreflight({
        task: "The attached git diff contains the completed change.",
        caller: "operator",
        attachmentsPresent: true,
        reviewableAttachments: [attachment],
        operatorVerifiedAttachments: [attachment],
      });

      assert.equal(buildEvidenceCustodyIndex(content).validation, "validated");
      assert.equal(preflight.pass, true, JSON.stringify(preflight));
      assert.equal(preflight.operator_grounded, true, JSON.stringify(preflight));
    },
  },
  {
    name: "a separate unidentified failure vetoes clean success and state corpora",
    run: () => {
      const testParts = ["Tests 20 passed (20)", "status=failed"].map((content, index) => ({
        label: `test-state-${index + 1}`,
        relative_path: `evidence/test-state-${index + 1}.log`,
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      }));
      const evidence = evidencePreflight({
        task: "Tests passed.",
        caller: "operator",
        attachmentsPresent: true,
        reviewableAttachments: testParts,
        operatorVerifiedAttachments: testParts,
      });
      assert.equal(evidence.pass, false, JSON.stringify(evidence));
      assert.equal(evidence.operator_grounded, false, JSON.stringify(evidence));

      const workflowParts = ["workflow status=success", "workflow status=failed"].map(
        (content, index) => ({
          label: `workflow-state-${index + 1}`,
          relative_path: `evidence/workflow-state-${index + 1}.log`,
          sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          truncated: false,
        }),
      );
      const truthfulness = truthfulnessPreflight({
        task: "Workflow status=success.",
        caller: "operator",
        attachmentsPresent: true,
        reviewableAttachments: workflowParts,
        operatorVerifiedAttachments: workflowParts,
      });
      assert.equal(truthfulness.pass, false, JSON.stringify(truthfulness));
      assert.equal(truthfulness.operator_grounded, false, JSON.stringify(truthfulness));
    },
  },
  {
    name: "trusted attachment boundaries cannot concatenate into a synthetic quote",
    run: () => {
      const firstContent = "operator-tail-A";
      const secondContent = "operator-head-B";
      const operatorVerifiedAttachments = [
        {
          label: "operator-a",
          relative_path: "evidence/operator-a.log",
          sha256: crypto.createHash("sha256").update(firstContent, "utf8").digest("hex"),
          content: firstContent,
          bytes: Buffer.byteLength(firstContent, "utf8"),
          truncated: false,
        },
        {
          label: "operator-b",
          relative_path: "evidence/operator-b.log",
          sha256: crypto.createHash("sha256").update(secondContent, "utf8").digest("hex"),
          content: secondContent,
          bytes: Buffer.byteLength(secondContent, "utf8"),
          truncated: false,
        },
      ];
      const input = {
        artifactText: "Review the operator evidence.",
        attachedEvidenceText: `${firstContent}\n${secondContent}`,
        operatorVerifiedAttachments,
        attachmentRefs: operatorVerifiedAttachments.map((attachment) => attachment.relative_path),
        runtimeFacts: {},
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer(['Artifact quote: "operator-tail-A\noperator-head-B"']),
        input,
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "trusted patch evidence cannot ground a removed-only quote",
    run: () => {
      const content = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1 +1 @@",
        "-operator-removed-only-value",
        "+operator-current-value",
        "",
      ].join("\n");
      const attachment = {
        label: "operator-patch",
        relative_path: "evidence/operator.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      };
      const input = {
        artifactText: "Review the operator patch.",
        attachedEvidenceText: content,
        operatorVerifiedAttachments: [attachment],
        attachmentRefs: [attachment.relative_path],
        runtimeFacts: {},
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer(['Artifact quote: "operator-removed-only-value"']),
        input,
      );

      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
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
        attachedEvidenceText:
          [
            "diff --git a/deleted.md b/deleted.md",
            "deleted file mode 100644",
            "--- a/deleted.md",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-deleted content",
          ].join("\n") + "\n",
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["deleted.md"]);
    },
  },
  {
    name: "an existing file emptied by a validated hunk retains post-image path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "emptied.md",
        "evidence/emptied.patch",
        [
          "diff --git a/emptied.md b/emptied.md",
          "--- a/emptied.md",
          "+++ b/emptied.md",
          "@@ -1 +0,0 @@",
          "-removed final line",
        ],
        true,
      );
    },
  },
  {
    name: "a validated empty new file retains post-image path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "empty-new.md",
        "evidence/empty-new.patch",
        [
          "diff --git a/empty-new.md b/empty-new.md",
          "new file mode 100644",
          "index 0000000..e69de29",
        ],
        true,
      );
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
        attachedEvidenceText:
          [
            "diff --git a/real.md b/real.md",
            "--- a/real.md",
            "+++ b/real.md",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "+++ b/fabricated.md",
          ].join("\n") + "\n",
      });

      assert.equal(preflight.pass, false);
      assert.deepEqual(preflight.unattached_evidence_references, ["fabricated.md"]);
    },
  },
  {
    name: "the effective post-image path reported by Git overrides the advisory diff header",
    run: () => {
      const preflight = evidencePreflight({
        task: "Review the attached dependency update.",
        initialDraft: "The attached evidence confirms fabricated.md.",
        caller: "perplexity",
        attachmentsPresent: true,
        attachedEvidenceRefs: ["evidence/path-mismatch.patch"],
        attachedEvidenceText:
          [
            "diff --git a/real.md b/real.md",
            "--- a/real.md",
            "+++ b/fabricated.md",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n") + "\n",
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
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
        attachedEvidenceText:
          [
            "diff --git a/header-shaped-content.md b/header-shaped-content.md",
            "--- a/header-shaped-content.md",
            "+++ b/header-shaped-content.md",
            "@@ -1 +1 @@",
            "--- old content",
            "+++ new content",
          ].join("\n") + "\n",
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
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
        attachedEvidenceText:
          [
            'diff --git "a/docs with space/package.json" "b/docs with space/package.json"',
            '--- "a/docs with space/package.json"',
            '+++ "b/docs with space/package.json"',
            "@@ -1 +1 @@",
            '-{"version":"1.0.0"}',
            '+{"version":"1.0.1"}',
          ].join("\n") + "\n",
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
    name: "an orphan no-newline marker cannot manufacture Git path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "orphan-marker.md",
        "evidence/orphan-marker.patch",
        [
          "diff --git a/orphan-marker.md b/orphan-marker.md",
          "--- a/orphan-marker.md",
          "+++ b/orphan-marker.md",
          "@@ -1 +1 @@",
          "\\ No newline at end of file",
          "-old",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "a duplicated no-newline marker cannot manufacture Git path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "duplicate-marker.md",
        "evidence/duplicate-marker.patch",
        [
          "diff --git a/duplicate-marker.md b/duplicate-marker.md",
          "--- a/duplicate-marker.md",
          "+++ b/duplicate-marker.md",
          "@@ -1 +1 @@",
          "-old",
          "\\ No newline at end of file",
          "\\ No newline at end of file",
          "+new",
        ],
        false,
      );
    },
  },
  {
    name: "valid old and new no-newline markers preserve exact Git path custody",
    run: () => {
      assertUnifiedDiffCustody(
        "valid-markers.md",
        "evidence/valid-markers.patch",
        [
          "diff --git a/valid-markers.md b/valid-markers.md",
          "--- a/valid-markers.md",
          "+++ b/valid-markers.md",
          "@@ -1 +1 @@",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "\\ No newline at end of file",
        ],
        true,
      );
    },
  },
  {
    name: "an official Git rename grants custody only to the destination",
    run: () => {
      const patch = [
        "diff --git a/old-name.md b/new-name.md",
        "similarity index 100%",
        "rename from old-name.md",
        "rename to new-name.md",
      ];
      assertUnifiedDiffCustody("new-name.md", "evidence/rename.patch", patch, true);
      assertUnifiedDiffCustody("old-name.md", "evidence/rename.patch", patch, false);
    },
  },
  {
    name: "an official Git copy grants custody only to the destination",
    run: () => {
      const patch = [
        "diff --git a/source-name.md b/copied-name.md",
        "similarity index 100%",
        "copy from source-name.md",
        "copy to copied-name.md",
      ];
      assertUnifiedDiffCustody("copied-name.md", "evidence/copy.patch", patch, true);
      assertUnifiedDiffCustody("source-name.md", "evidence/copy.patch", patch, false);
    },
  },
  {
    name: "an official pure rename preserves a C-quoted Unicode destination",
    run: () => {
      const index = buildEvidenceCustodyIndex(
        [
          'diff --git "a/ancien-\\303\\251.md" "b/nouveau-\\303\\251.md"',
          "similarity index 100%",
          'rename from "ancien-\\303\\251.md"',
          'rename to "nouveau-\\303\\251.md"',
          "",
        ].join("\n"),
      );
      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, ["nouveau-é.md"]);
    },
  },
  {
    name: "an official pure copy preserves a C-quoted Unicode destination",
    run: () => {
      const index = buildEvidenceCustodyIndex(
        [
          'diff --git "a/source-\\303\\251.md" "b/copied-\\303\\251.md"',
          "similarity index 100%",
          'copy from "source-\\303\\251.md"',
          'copy to "copied-\\303\\251.md"',
          "",
        ].join("\n"),
      );
      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, ["copied-é.md"]);
    },
  },
  {
    name: "a mode-only diff cannot manufacture post-image custody",
    run: () => {
      assertUnifiedDiffCustody(
        "mode-only.md",
        "evidence/mode-only.patch",
        ["diff --git a/mode-only.md b/mode-only.md", "old mode 100644", "new mode 100755"],
        false,
      );
    },
  },
  {
    name: "a binary diff cannot manufacture textual post-image custody",
    run: () => {
      const index = buildEvidenceCustodyIndex(
        [
          "diff --git a/image.bin b/image.bin",
          "index 1111111..2222222 100644",
          "Binary files a/image.bin and b/image.bin differ",
        ].join("\n"),
      );
      assert.equal(index.validation, "validated");
      assert.deepEqual(index.exactGitPaths, []);
      assert.deepEqual(index.postImageHunks, []);
    },
  },
  {
    name: "Git-validated binary patch metadata is not authenticated content evidence",
    run: () => {
      const content = [
        "diff --git a/image.bin b/image.bin",
        "index 1111111..2222222 100644",
        "Binary files a/image.bin and b/image.bin differ",
        "",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "binary-metadata",
        relative_path: "evidence/binary.patch",
        sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      };
      const grounding = groundReadyPeerEvidence(
        readyPeer([
          escapedProviderCitation(attachment, "Binary files a/image.bin and b/image.bin differ"),
        ]),
        groundingInput([attachment]),
      );

      assert.equal(buildEvidenceCustodyIndex(content).validation, "validated");
      assert.equal(grounding.grounded, false);
      assert.equal(grounding.result.status, "NEEDS_EVIDENCE");
    },
  },
  {
    name: "a .git control path cannot manufacture repository-file custody",
    run: () => {
      const index = buildEvidenceCustodyIndex(
        [
          "diff --git a/.git/config b/.git/config",
          "--- a/.git/config",
          "+++ b/.git/config",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      );
      assert.equal(index.validation, "invalid_patch");
      assert.deepEqual(index.exactGitPaths, []);
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
        attachedEvidenceText:
          [
            'diff --git "a/docs/\\303\\251/report.md" "b/docs/\\303\\251/report.md"',
            '--- "a/docs/\\303\\251/report.md"',
            '+++ "b/docs/\\303\\251/report.md"',
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n") + "\n",
      });

      assert.equal(preflight.pass, true, preflight.reason);
      assert.deepEqual(preflight.unattached_evidence_references, []);
    },
  },
  {
    name: "an operator patch cannot authenticate a removed operational state",
    run: () => {
      const patch = [
        "diff --git a/workflow.log b/workflow.log",
        "--- a/workflow.log",
        "+++ b/workflow.log",
        "@@ -1 +1 @@",
        "-workflow status=success",
        "+workflow status=queued",
        "",
      ].join("\n");
      const preflight = truthfulnessPreflight({
        task: "Workflow status=success.",
        caller: "operator",
        attachmentsPresent: true,
        attachedEvidenceText: patch,
        operatorVerifiedEvidenceText: patch,
      });

      assert.equal(preflight.pass, false, JSON.stringify(preflight));
      assert.equal(preflight.operator_grounded, false, JSON.stringify(preflight));
      assert.equal(preflight.independent_review_required, false, JSON.stringify(preflight));
    },
  },
  {
    name: "a Git hunk suffix cannot authenticate a removed operational state",
    run: () => {
      const patch = [
        "diff --git a/workflow.log b/workflow.log",
        "--- a/workflow.log",
        "+++ b/workflow.log",
        "@@ -1 +1 @@ workflow status=success",
        "-workflow status=success",
        "+workflow status=queued",
        "",
      ].join("\n");
      const preflight = truthfulnessPreflight({
        task: "Workflow status=success.",
        caller: "operator",
        attachmentsPresent: true,
        attachedEvidenceText: patch,
        operatorVerifiedEvidenceText: patch,
      });

      assert.equal(preflight.pass, false, JSON.stringify(preflight));
      assert.equal(preflight.operator_grounded, false, JSON.stringify(preflight));
      assert.equal(preflight.independent_review_required, false, JSON.stringify(preflight));
    },
  },
  {
    name: "an attachment label cannot impersonate another attachment path",
    run: () => {
      const maliciousContent = "malicious attachment content";
      const maliciousAttachment: EvidenceAttachment = {
        label: "evidence/benign.log",
        relative_path: "evidence/malicious.log",
        sha256: crypto.createHash("sha256").update(maliciousContent).digest("hex"),
        content: maliciousContent,
      };
      const benignContent = "benign attachment content";
      const benignAttachment: EvidenceAttachment = {
        label: "benign",
        relative_path: "evidence/benign.log",
        sha256: crypto.createHash("sha256").update(benignContent).digest("hex"),
        content: benignContent,
      };
      const source = [
        `Attachment: ${benignAttachment.relative_path}`,
        `sha256=${maliciousAttachment.sha256}`,
        `Artifact quote: "${maliciousContent}"`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        readyPeer([source]),
        groundingInput([maliciousAttachment, benignAttachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a blocking path cannot borrow an unrelated authenticated quote",
    run: () => {
      const content = "This harmless configuration line remains unchanged.";
      const attachment: EvidenceAttachment = {
        label: "auth-review",
        relative_path: "evidence/auth-review.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: "${content}"`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "blocking correlation uses only the canonical Location field",
    run: () => {
      const content = [
        "diagnostic preface",
        "auth.ts:99 authentication bypass diagnostic evidence",
      ].join("\n");
      const attachment: EvidenceAttachment = {
        label: "scanner-output",
        relative_path: "evidence/scanner.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const canonicalTail = [
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: "${content}"`,
      ];
      const invalidSources = [
        canonicalTail.join("\n"),
        ["Location: auth.ts:98", ...canonicalTail].join("\n"),
        ["Checklist-Item: auth.ts:99", ...canonicalTail].join("\n"),
      ];

      for (const source of invalidSources) {
        const result = groundReadyPeerEvidence(
          notReadyPeer("BLOCKER: auth.ts:99", [source]),
          groundingInput([attachment]),
        );
        assert.equal(result.grounded, false, source);
        assert.equal(result.result.status, "NEEDS_EVIDENCE", source);
      }
    },
  },
  {
    name: "a bare path and line cannot serve as its own blocking evidence",
    run: () => {
      const content = "src/auth.ts:99";
      const attachment: EvidenceAttachment = {
        label: "scanner-output",
        relative_path: "evidence/scanner.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: "${content}"`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a path and line plus a short status token is not blocking evidence",
    run: () => {
      const content = "src/auth.ts:99\tOK";
      const attachment: EvidenceAttachment = {
        label: "scanner-output",
        relative_path: "evidence/scanner.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: "${content}"`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a blocking path remains grounded when its exact file line is quoted",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "src/auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, true, JSON.stringify(result));
      assert.equal(result.result.status, "NOT_READY", JSON.stringify(result));
    },
  },
  {
    name: "an unquoted path suffix cannot impersonate a path containing spaces",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/my long auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a path line range cannot be corroborated by only its first line",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: auth.ts:99-120", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a parent-directory prefix cannot collapse to a shorter blocking path",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: ../auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a longer scanner path cannot satisfy a shorter blocking path by substring",
    run: () => {
      const content = "notauth.ts:99 authentication bypass diagnostic evidence";
      const attachment: EvidenceAttachment = {
        label: "scanner-output",
        relative_path: "evidence/scanner.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: "${content}"`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "an adjacent filler line cannot lend substance to a trivial blocking line",
    run: () => {
      const content = "src/auth.ts:99 OK\ncopyright notice unrelated filler bytes";
      const attachment: EvidenceAttachment = {
        label: "scanner-output",
        relative_path: "evidence/scanner.log",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        `Artifact quote: ${JSON.stringify(content)}`,
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "an evidenced blocker cannot authenticate an additional uncited clause",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "src/auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99\nBLOCKER: src/payments.ts:10", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "free-form connector prose cannot replace canonical blocker lines",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "src/auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: src/auth.ts:99",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:99 and payment settlement loses funds", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, false, JSON.stringify(result));
      assert.equal(result.result.status, "NEEDS_EVIDENCE", JSON.stringify(result));
    },
  },
  {
    name: "a backtick-delimited path containing spaces preserves exact blocking custody",
    run: () => {
      const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
      lines[98] = "if (bypass) allow();";
      const content = lines.join("\n");
      const attachment: EvidenceAttachment = {
        label: "auth-source",
        relative_path: "src/my auth.ts",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        content,
      };
      const source = [
        "Location: `src/my auth.ts:99`",
        `Attachment: ${attachment.relative_path}`,
        `sha256=${attachment.sha256}`,
        'Artifact quote: "if (bypass) allow();"',
      ].join("\n");
      const result = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: `src/my auth.ts:99`", [source]),
        groundingInput([attachment]),
      );

      assert.equal(result.grounded, true, JSON.stringify(result));
      assert.equal(result.result.status, "NOT_READY", JSON.stringify(result));
    },
  },
  {
    name: "canonical NOT_READY sources enforce checklist ordering and one-to-one locations",
    run: () => {
      const attachmentWithDiagnostic = (
        relativePath: string,
        line: number,
        diagnostic: string,
      ): EvidenceAttachment => {
        const lines = Array.from(
          { length: line },
          (_, index) => `context line ${index + 1} for ${relativePath}`,
        );
        lines[line - 1] = diagnostic;
        const content = lines.join("\n");
        return {
          label: `not-ready-${path.basename(relativePath)}`,
          relative_path: relativePath,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          content,
        };
      };
      const canonicalBlockingSource = (
        attachment: EvidenceAttachment,
        location: string,
        diagnostic: string,
        checklistItem?: string,
      ): string =>
        [
          ...(checklistItem ? [`Checklist-Item: ${checklistItem}`] : []),
          `Location: ${location}`,
          `Attachment: ${attachment.relative_path}`,
          `sha256=${attachment.sha256}`,
          `Artifact quote: ${JSON.stringify(diagnostic)}`,
        ].join("\n");

      const authDiagnostic = "if (bypass) allowUnauthenticatedRequest();";
      const paymentDiagnostic = "settlementTotal excludes the final captured payment;";
      const authAttachment = attachmentWithDiagnostic("src/auth.ts", 10, authDiagnostic);
      const paymentAttachment = attachmentWithDiagnostic("src/payments.ts", 20, paymentDiagnostic);
      const authSource = canonicalBlockingSource(authAttachment, "src/auth.ts:10", authDiagnostic);
      const paymentSource = canonicalBlockingSource(
        paymentAttachment,
        "src/payments.ts:20",
        paymentDiagnostic,
      );
      const checklistItem = "ev-auth-10";
      const checklistSource = canonicalBlockingSource(
        authAttachment,
        "src/auth.ts:10",
        authDiagnostic,
        checklistItem,
      );
      const checklistResult = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:10", [checklistSource]),
        {
          ...groundingInput([authAttachment]),
          evidenceChecklistItemIds: [checklistItem],
        },
      );
      assert.equal(checklistResult.grounded, true, JSON.stringify(checklistResult));
      assert.equal(checklistResult.result.status, "NOT_READY", JSON.stringify(checklistResult));

      const reversedSourcesResult = groundReadyPeerEvidence(
        notReadyPeer("BLOCKER: src/auth.ts:10\nBLOCKER: src/payments.ts:20", [
          paymentSource,
          authSource,
        ]),
        groundingInput([authAttachment, paymentAttachment]),
      );
      assert.equal(reversedSourcesResult.grounded, true, JSON.stringify(reversedSourcesResult));
      assert.equal(
        reversedSourcesResult.result.status,
        "NOT_READY",
        JSON.stringify(reversedSourcesResult),
      );

      const invalidCases = [
        {
          name: "duplicate blocker location",
          summary: "BLOCKER: src/auth.ts:10\nBLOCKER: src/auth.ts:10",
          sources: [authSource, paymentSource],
          unsupportedSources: 0,
        },
        {
          name: "duplicate source Location",
          summary: "BLOCKER: src/auth.ts:10\nBLOCKER: src/payments.ts:20",
          sources: [authSource, authSource],
          unsupportedSources: 0,
        },
        {
          name: "blocker/source count mismatch",
          summary: "BLOCKER: src/auth.ts:10",
          sources: [authSource, paymentSource],
          unsupportedSources: 0,
        },
        {
          name: "source prefix prose",
          summary: "BLOCKER: src/auth.ts:10",
          sources: [`Reviewer rationale must not precede Location.\n${authSource}`],
          unsupportedSources: 1,
        },
        {
          name: "source suffix prose",
          summary: "BLOCKER: src/auth.ts:10",
          sources: [`${authSource}\nReviewer rationale must not follow the terminal quote.`],
          unsupportedSources: 1,
        },
      ] as const;

      for (const testCase of invalidCases) {
        const result = groundReadyPeerEvidence(
          notReadyPeer(testCase.summary, [...testCase.sources]),
          groundingInput([authAttachment, paymentAttachment]),
        );
        assert.equal(result.grounded, false, `${testCase.name}: ${JSON.stringify(result)}`);
        assert.equal(
          result.result.status,
          "NEEDS_EVIDENCE",
          `${testCase.name}: ${JSON.stringify(result)}`,
        );
        assert.equal(
          result.unsupported_sources.length,
          testCase.unsupportedSources,
          `${testCase.name}: only malformed source envelopes are independently unsupported`,
        );
        assert.ok(
          result.failed_predicates.includes("blocking_claims_correlated_to_sources"),
          `${testCase.name}: blocking relevance predicate`,
        );
      }
    },
  },
  {
    name: "relator fabrication cannot resurrect a URL from a removed patch hunk",
    run: async () => {
      const removedUrl = "https://github.com/example-org/example-repo/actions/runs/123456";
      const patch = [
        "diff --git a/evidence.log b/evidence.log",
        "--- a/evidence.log",
        "+++ b/evidence.log",
        "@@ -1 +1 @@",
        `-Evidence record: ${removedUrl}`,
        "+No current evidence.",
        "",
      ].join("\n");
      assert.equal(buildEvidenceCustodyIndex(patch).validation, "validated");

      const dataDir = createRegressionDataDir();
      try {
        const config = {
          ...regressionConfig(dataDir),
          evidence_preflight_enabled: false,
          truthfulness_preflight_enabled: false,
        };
        const adapters = {} as Record<PeerId, PeerAdapter>;
        for (const peer of [
          "codex",
          "claude",
          "gemini",
          "deepseek",
          "grok",
          "perplexity",
        ] as const) {
          adapters[peer] = new StubAdapter(config, peer);
        }
        const lead = adapters.codex;
        const defaultGenerate = lead.generate.bind(lead);
        lead.generate = async (prompt, context) => ({
          ...(await defaultGenerate(prompt, context)),
          text: `Evidence record: ${removedUrl}`,
        });
        const events: string[] = [];
        const orchestrator = new CrossReviewOrchestrator(
          config,
          (event) => events.push(event.type),
          () => adapters,
        );
        const result = await orchestrator.runUntilUnanimous({
          task: "Summarize the current attached evidence.",
          evidence: patch,
          caller: "operator",
          lead_peer: "codex",
          peers: ["codex", "claude"],
          max_rounds: 1,
        });

        assert.equal(result.converged, false);
        assert.equal(result.rounds, 0);
        assert.ok(events.includes("session.lead_fabrication_detected"), events.join(", "));
      } finally {
        removeRegressionDataDir(dataDir);
      }
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
