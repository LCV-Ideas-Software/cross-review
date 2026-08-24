import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

const [
  packageJson,
  packageLock,
  ciWorkflow,
  autoTagWorkflow,
  npmToolchainAction,
  publishWorkflow,
  npmrc,
  registryVerifier,
  securityBaseline,
  readme,
  presentation,
  presentationShort,
  thirdParty,
  changelog,
  codeqlWorkflow,
  serverSource,
  dependabotConfig,
  pythonVersion,
  dependencyReviewWorkflow,
  zizmorConfig,
  scorecardWorkflow,
  zizmorWorkflow,
  pagesWorkflow,
  releaseRecoveryWorkflow,
  releaseRecoveryScript,
  dependabotReleaseEvidence,
  releasePushWorkflowGate,
] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("package-lock.json").then(JSON.parse),
  read(".github/workflows/ci.yml"),
  read(".github/workflows/auto-tag.yml"),
  read(".github/actions/setup-npm-toolchain/action.yml"),
  read(".github/workflows/publish.yml"),
  read(".npmrc"),
  read("scripts/verify-registry-dist.mjs"),
  read("docs/github-security-baseline.md"),
  read("README.md"),
  read("docs/apresentacao-cross-review.md"),
  read("docs/apresentacao.md"),
  read("THIRDPARTY.md"),
  read("CHANGELOG.md"),
  read(".github/workflows/codeql.yml"),
  read("src/mcp/server.ts"),
  read(".github/dependabot.yml"),
  read(".python-version"),
  read(".github/workflows/dependency-review.yml"),
  read(".github/zizmor.yml"),
  read(".github/workflows/scorecard.yml"),
  read(".github/workflows/zizmor.yml"),
  read(".github/workflows/pages.yml"),
  read(".github/workflows/recover-v4.5.26-release.yml"),
  read("scripts/recover-v4.5.26-release.sh"),
  read("scripts/require-dependabot-release-evidence.sh"),
  read("scripts/require-release-push-workflows.sh"),
]);

const expectedAllowScripts = {
  "@google/genai": false,
  "esbuild@0.28.2": true,
  "fsevents@2.3.3": true,
  "protobufjs@7.6.5": true,
};
const expectedNpmCliVersion = "12.0.2";
const expectedNpmCliSha512 =
  "b885e890b9418fa1693544d05f53e64f9a73ec194837d4258b15fecdd692347b1dd2a517b1b0cbaf9d31cd8e92c3b70956bd2ecc72833a57b4b3098f5bfa7943";
const expectedZizmorAction = "zizmorcore/zizmor-action@3dc1ecc9bcb9e94e9b2c709687979e1298497054";
const expectedCodeqlSarifGateAction =
  "LCV-Ideas-Software/.github/codeql-sarif-gate@24b0bcc09a48b47f740b8a8bd972374f7289e48e";

assert.equal(
  packageJson.packageManager,
  undefined,
  "packageManager must stay workflow-pinned so Dependabot's supported npm remains decoupled from the verified release toolchain",
);

assert.deepEqual(
  packageJson.allowScripts,
  expectedAllowScripts,
  "package.json must retain the exact reviewed npm v12 install-script policy; @google/genai is explicitly denied so future Dependabot versions cannot gain install-time execution",
);
assert.equal(
  packageJson.overrides?.["express-rate-limit"]?.["ip-address"],
  "10.4.0",
  "the MCP SDK rate-limit chain must retain the scoped ip-address 10.4.0 security override",
);
assert.equal(
  packageLock.packages?.["node_modules/ip-address"]?.version,
  "10.4.0",
  "the lockfile must resolve the reviewed ip-address 10.4.0 security override",
);

for (const lifecycle of ["preinstall", "install", "postinstall"]) {
  assert.equal(
    packageJson.scripts?.[lifecycle],
    undefined,
    `the published package must not define an install-time ${lifecycle} script`,
  );
}

const foreignResolved = Object.entries(packageLock.packages ?? {})
  .map(([packagePath, metadata]) => ({ packagePath, resolved: metadata.resolved }))
  .filter(({ resolved }) => typeof resolved === "string")
  .filter(({ resolved }) => !resolved.startsWith("https://registry.npmjs.org/"));
assert.deepEqual(
  foreignResolved,
  [],
  "npm v12 blocks git and remote-URL dependencies; the lockfile must use approved registries only",
);

assert.doesNotMatch(
  dependabotConfig,
  /^registries:/m,
  "Dependabot must use the public npm registry without a private registry credential",
);
assert.match(
  npmrc,
  /^registry=https:\/\/registry\.npmjs\.org\/$/m,
  ".npmrc must use npmjs.org as the global npm dependency registry",
);
assert.doesNotMatch(
  npmrc,
  /^@lcv-ideas-software:registry=/m,
  ".npmrc must leave the organization scope unmapped so setup-node can select GitHub Packages for the mirror job",
);
for (const ecosystem of ["npm", "github-actions", "pip", "pre-commit"]) {
  assert.match(
    dependabotConfig,
    new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`),
    `Dependabot must cover the repository's ${ecosystem} ecosystem`,
  );
}
assert.ok(
  dependabotConfig.includes("python-tools:") &&
    dependabotConfig.includes('patterns:\n          - "*"'),
  "Dependabot must group Python tool updates instead of racing independent lockfile merges",
);
assert.doesNotMatch(
  securityBaseline,
  /Dependabot auto-merge workflow/i,
  "the current security baseline must not instruct operators to restore the retired controller",
);
assert.match(
  securityBaseline,
  /explicit human action in\s+GitHub's native merge queue/,
  "the current security baseline must preserve explicit native queue admission",
);
assert.doesNotMatch(
  presentation,
  /automerge de Dependabot/i,
  "the current presentation must not advertise the retired controller",
);
assert.match(
  presentation,
  /admissão humana pela merge queue nativa/,
  "the current presentation must describe explicit native queue admission",
);
function topLevelBody(workflow, key) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `${key} must be present`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^[A-Za-z0-9_-]+:/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join("\n");
}

function jobBody(workflow, jobName) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  assert.notEqual(start, -1, `${jobName} job must be present`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join("\n");
}

function namedStepBody(job, stepName) {
  const lines = job.split(/\r?\n/);
  const start = lines.indexOf(`      - name: ${stepName}`);
  assert.notEqual(start, -1, `${stepName} step must be present`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^ {6}- name:\s+/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function shouldPublishZizmorSarif({ eventName, headRepository, repository, actor }) {
  return (
    eventName !== "pull_request" || (headRepository === repository && actor !== "dependabot[bot]")
  );
}

await assert.rejects(
  access(path.join(root, ".github/workflows/native-auto-merge.yml")),
  { code: "ENOENT" },
  "the retired Native Auto-merge controller must stay absent",
);

const dependencyReviewJob = jobBody(dependencyReviewWorkflow, "dependency_review");
assert.match(
  topLevelBody(dependencyReviewWorkflow, "on"),
  /pull_request:[\s\S]*merge_group:[\s\S]*checks_requested/,
  "Dependency Review must validate both pull requests and merge groups",
);
assert.match(dependencyReviewWorkflow, /^permissions: \{\}$/m);
assert.match(dependencyReviewJob, /^ {4}name: Dependency Review$/m);
assert.match(dependencyReviewJob, /permissions:[\s\S]*contents: read/);
assert.match(
  dependencyReviewJob,
  /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1[\s\S]*persist-credentials: false/,
);
assert.equal(
  (
    dependencyReviewJob.match(
      /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/g,
    ) ?? []
  ).length,
  2,
  "Dependency Review must pin the official action for PR and merge-group paths",
);
assert.match(dependencyReviewJob, /base-ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
assert.match(dependencyReviewJob, /head-ref: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
assert.match(
  topLevelBody(dependencyReviewWorkflow, "concurrency"),
  /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  "merge-group evidence must never be cancelled by PR concurrency",
);
assert.doesNotMatch(
  dependencyReviewWorkflow,
  /native-auto-merge|merge-group-feedback-gate|write-all|Dependency Review candidate|Native auto-merge workflow boundaries|secrets\./,
  "Dependency Review must not retain the privileged custom controller or its legacy contexts",
);

const zizmorJob = jobBody(zizmorWorkflow, "zizmor");
const zizmorEnforcement = namedStepBody(zizmorJob, "Enforce Zizmor findings");
const zizmorSarif = namedStepBody(zizmorJob, "Publish the complete Zizmor SARIF result");
const zizmorFailClosed = namedStepBody(zizmorJob, "Preserve the fail-closed Zizmor result");
assert.equal(
  (zizmorWorkflow.match(new RegExp(expectedZizmorAction, "g")) ?? []).length,
  2,
  "Zizmor enforcement and SARIF publication must use the exact official Action pin",
);
assert.match(zizmorWorkflow, /permissions:\s*\{\}/);
assert.match(zizmorWorkflow, /contents: read/);
assert.match(zizmorWorkflow, /security-events: write/);
assert.match(zizmorEnforcement, /id: enforce[\s\S]*continue-on-error: true/);
assert.match(zizmorEnforcement, /advanced-security: false/);
assert.match(zizmorEnforcement, /annotations: false/);
assert.doesNotMatch(zizmorEnforcement, /head\.repo\.full_name|dependabot\[bot\]/);
assert.match(zizmorSarif, /always\(\)/);
assert.match(zizmorSarif, /github\.event_name != 'pull_request'/);
assert.match(
  zizmorSarif,
  /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
);
assert.match(zizmorSarif, /github\.event\.pull_request\.user\.login != 'dependabot\[bot\]'/);
assert.match(zizmorFailClosed, /always\(\) && steps\.enforce\.outcome != 'success'/);
assert.match(zizmorFailClosed, /run: exit 1/);
assert.match(zizmorWorkflow, /collect: all/);
assert.match(zizmorWorkflow, /persona: auditor/);
assert.equal((zizmorWorkflow.match(/advanced-security: false/g) ?? []).length, 1);
assert.doesNotMatch(
  zizmorWorkflow,
  /write-all|LCV-Ideas-Software\/\.github\/\.github\/workflows\/zizmor\.yml/,
);
assert.doesNotMatch(
  zizmorConfig,
  /native-auto-merge\.yml/,
  "Zizmor must not waive the retired privileged trigger",
);
assert.match(zizmorConfig, /- auto-tag\.yml/);

const repository = "example-owner/example-repository";
for (const [input, expected] of [
  [{ eventName: "push", headRepository: repository, repository, actor: "dependabot[bot]" }, true],
  [
    { eventName: "pull_request", headRepository: repository, repository, actor: "example-user" },
    true,
  ],
  [
    {
      eventName: "pull_request",
      headRepository: "contributor/example-repository",
      repository,
      actor: "contributor",
    },
    false,
  ],
  [
    {
      eventName: "pull_request",
      headRepository: repository,
      repository,
      actor: "dependabot[bot]",
    },
    false,
  ],
]) {
  assert.equal(
    shouldPublishZizmorSarif(input),
    expected,
    "Zizmor SARIF publication must skip only PR origins with read-only tokens",
  );
}
function assertCodeqlReadyForReviewTrigger(workflow) {
  const lines = workflow.split(/\r?\n/);
  const pullRequestStart = lines.indexOf("  pull_request:");
  assert.notEqual(pullRequestStart, -1, "CodeQL must retain a block-form pull_request trigger");
  const nextEventOffset = lines
    .slice(pullRequestStart + 1)
    .findIndex((line) => /^ {2}[A-Za-z0-9_-]+:/.test(line));
  const pullRequestEnd =
    nextEventOffset === -1 ? lines.length : pullRequestStart + 1 + nextEventOffset;
  const pullRequestBlock = lines.slice(pullRequestStart + 1, pullRequestEnd);
  const typesStart = pullRequestBlock.indexOf("    types:");
  assert.notEqual(typesStart, -1, "CodeQL pull_request must retain a block-form types filter");
  const nextFieldOffset = pullRequestBlock
    .slice(typesStart + 1)
    .findIndex((line) => /^ {4}[A-Za-z0-9_-]+:/.test(line));
  const typesEnd =
    nextFieldOffset === -1 ? pullRequestBlock.length : typesStart + 1 + nextFieldOffset;
  assert.equal(
    pullRequestBlock
      .slice(typesStart + 1, typesEnd)
      .filter((line) => line.trim() === "- ready_for_review").length,
    1,
    "CodeQL pull_request.types must include ready_for_review exactly once",
  );
}
assertCodeqlReadyForReviewTrigger(codeqlWorkflow);
const codeqlWithoutReadyForReview = codeqlWorkflow.replace(/^ {6}- ready_for_review\r?\n/m, "");
const codeqlWithReadyForReviewMoved = codeqlWithoutReadyForReview.replace(
  /^ {6}- checks_requested$/m,
  "$&\n      - ready_for_review",
);
for (const mutation of [codeqlWithoutReadyForReview, codeqlWithReadyForReviewMoved]) {
  assert.throws(
    () => assertCodeqlReadyForReviewTrigger(mutation),
    /CodeQL pull_request\.types must include ready_for_review exactly once/,
    "CodeQL trigger regression guard must reject ready_for_review when absent or outside pull_request.types",
  );
}
function assertStrictCodeqlSarifGate(workflow) {
  const lines = workflow.split(/\r?\n/);
  const gateName = "      - name: Enforce zero CodeQL findings";
  assert.equal(
    lines.filter((line) => line === gateName).length,
    1,
    "CodeQL must contain exactly one named strict SARIF gate step",
  );
  const gateStart = lines.indexOf(gateName);
  const nextStepOffset = lines.slice(gateStart + 1).findIndex((line) => /^ {6}- /.test(line));
  const gateEnd = nextStepOffset === -1 ? lines.length : gateStart + 1 + nextStepOffset;
  const gateLines = lines.slice(gateStart + 1, gateEnd);
  const expectedUsesLine = `        uses: ${expectedCodeqlSarifGateAction} # codeql-sarif-gate/v1.0.0`;
  assert.deepEqual(
    gateLines.filter((line) => /^ {8}uses\s*:/.test(line)),
    [expectedUsesLine],
    "CodeQL strict SARIF gate must have exactly one active uses entry pinned to the immutable release commit",
  );
  const expectedWithLine = "        with:";
  const expectedSarifDirectoryLine = "          sarif-directory: ${{ runner.temp }}/codeql-results";
  assert.deepEqual(
    gateLines.filter((line) => /^ {8}with\s*:/.test(line)),
    [expectedWithLine],
    "CodeQL strict SARIF gate must contain exactly one active with mapping",
  );
  assert.deepEqual(
    gateLines.filter((line) => /^ {10}sarif-directory\s*:/.test(line)),
    [expectedSarifDirectoryLine],
    "CodeQL strict SARIF gate must pass the analyzer's exact SARIF output directory once",
  );
  assert.equal(
    gateLines.indexOf(expectedWithLine),
    gateLines.indexOf(expectedUsesLine) + 1,
    "CodeQL strict SARIF gate must bind with directly to the pinned action",
  );
  assert.equal(
    gateLines.indexOf(expectedSarifDirectoryLine),
    gateLines.indexOf(expectedWithLine) + 1,
    "CodeQL strict SARIF gate must bind sarif-directory directly under with",
  );
  assert.doesNotMatch(
    gateLines.join("\n"),
    /^ {8}(?:env|run|shell)\s*:/m,
    "CodeQL strict SARIF gate must delegate enforcement without an inline command",
  );
  assert.doesNotMatch(
    workflow,
    /mapfile\s+-d|find\s+"\$CODEQL_RESULTS"|jq\s+-s\s+'\[\.\[\]\.runs|CODEQL_RESULTS:/,
    "CodeQL must not retain a weaker inline SARIF gate beside the central policy action",
  );
}
assertStrictCodeqlSarifGate(codeqlWorkflow);
const codeqlWithCommentedPinDecoy = codeqlWorkflow.replace(
  /^ {8}uses: LCV-Ideas-Software\/\.github\/codeql-sarif-gate@24b0bcc09a48b47f740b8a8bd972374f7289e48e # codeql-sarif-gate\/v1\.0\.0$/m,
  `        uses: LCV-Ideas-Software/.github/codeql-sarif-gate@main
        # uses: ${expectedCodeqlSarifGateAction} # codeql-sarif-gate/v1.0.0`,
);
assert.throws(
  () => assertStrictCodeqlSarifGate(codeqlWithCommentedPinDecoy),
  /immutable release commit/,
  "CodeQL regression guard must reject an unpinned active action even when a comment contains the expected pin",
);
const codeqlWithPinOutsideGate =
  codeqlWorkflow.replace(
    /^ {8}uses: LCV-Ideas-Software\/\.github\/codeql-sarif-gate@24b0bcc09a48b47f740b8a8bd972374f7289e48e # codeql-sarif-gate\/v1\.0\.0$/m,
    "        uses: LCV-Ideas-Software/.github/codeql-sarif-gate@main",
  ) +
  `
      - name: Decoy SARIF step
        uses: ${expectedCodeqlSarifGateAction} # codeql-sarif-gate/v1.0.0
        with:
          sarif-directory: \${{ runner.temp }}/codeql-results`;
assert.throws(
  () => assertStrictCodeqlSarifGate(codeqlWithPinOutsideGate),
  /immutable release commit/,
  "CodeQL regression guard must reject the expected pin when it exists only outside the named gate step",
);
const codeqlWithInlineFallback = `${codeqlWorkflow}
      - name: Inline SARIF fallback
        env:
          CODEQL_RESULTS: \${{ runner.temp }}/codeql-results
        run: find "$CODEQL_RESULTS" -type f -name '*.sarif'`;
assert.throws(
  () => assertStrictCodeqlSarifGate(codeqlWithInlineFallback),
  /weaker inline SARIF gate/,
  "CodeQL regression guard must reject a weaker inline fallback outside the named central gate step",
);
assert.ok(
  autoTagWorkflow.includes("Require triggered Dependabot updates to pass") &&
    autoTagWorkflow.includes("require-dependabot-release-evidence.sh require") &&
    autoTagWorkflow.includes("VERSION_BOUNDARY_SHA"),
  "auto-tag must gate a Dependabot configuration change across the complete version epoch",
);
for (const [workflow, label] of [
  [ciWorkflow, "CI"],
  [codeqlWorkflow, "CodeQL"],
  [scorecardWorkflow, "OpenSSF Scorecard"],
  [zizmorWorkflow, "Zizmor"],
  [pagesWorkflow, "Pages"],
]) {
  assert.match(
    workflow,
    /concurrency:\s*\r?\n\s+group:[^\n]+\r?\n\s+queue:\s*max\r?\n\s+cancel-in-progress:\s*false/,
    `${label} must preserve every immutable main validation instead of cancelling historical release evidence`,
  );
}
for (const [workflow, label] of [
  [scorecardWorkflow, "OpenSSF Scorecard"],
  [pagesWorkflow, "Pages"],
]) {
  assert.doesNotMatch(
    workflow.match(/push:[\s\S]*?(?=\n\s+(?:schedule|workflow_dispatch):)/)?.[0] ?? "",
    /\n\s+paths(?:-ignore)?:/,
    `${label} must create exact-SHA evidence on every main push, including same-version recovery commits`,
  );
}
assert.match(
  ciWorkflow,
  /pip install[^\n]*--require-hashes[^\n]*python-tools-requirements\.txt/,
  "CI must install the Dependabot-managed Python lock with hash verification",
);
assert.match(
  ciWorkflow,
  /python -m pre_commit run --all-files --show-diff-on-failure/,
  "CI must execute every Dependabot-managed pre-commit hook update",
);
assert.match(
  ciWorkflow,
  /python scripts\/validate-dependabot-config\.py/,
  "CI must parse and semantically validate dependabot.yml",
);
assert.equal(pythonVersion.trim(), "3.12", "the Python security-tool lock is resolved for 3.12");
assert.match(
  ciWorkflow,
  /python-version-file:\s*["']?\.python-version["']?/,
  "Python consumers must use the centrally pinned lock version",
);
assert.doesNotMatch(
  dependabotConfig,
  /interval:\s*["']?daily["']?\s*\r?\n\s*day:/,
  "Dependabot daily schedules must not carry the weekly-only day option",
);

const npmBoundaryJobBlock = publishWorkflow.match(
  /\n {2}assert-npm-environment-boundary:[\s\S]*?(?=\n {2}assert-npm-production-boundary:)/,
)?.[0];
assert.ok(
  npmBoundaryJobBlock,
  "publication must start with a fail-closed npm Trusted Publisher boundary probe",
);
assert.match(
  npmBoundaryJobBlock,
  new RegExp(`PACKAGE_NAME:\\s*["']${packageJson.name.replace("/", "\\/")}["']`),
  "the pre-checkout boundary probe package must match package.json",
);
assert.doesNotMatch(
  npmBoundaryJobBlock,
  /\n\s+(?:uses:|environment:)/,
  "the boundary probe must not checkout code, invoke an action, or enter an environment",
);
assert.match(
  npmBoundaryJobBlock,
  /oidc\/token\/exchange\/package\/\$encoded_package/,
  "the boundary probe must call npm's documented OIDC exchange endpoint",
);
assert.match(
  npmBoundaryJobBlock,
  /\.workflow_ref == \$workflow/,
  "the boundary probe must bind the standard workflow_ref claim for a non-reusable workflow",
);
assert.doesNotMatch(
  npmBoundaryJobBlock,
  /job_workflow_ref/,
  "job_workflow_ref is reserved for reusable workflows and would fail closed incorrectly here",
);
assert.match(
  npmBoundaryJobBlock,
  /401\|404\)[\s\S]*?correctly rejected or concealed[\s\S]*?201\)[\s\S]*?refusing/,
  "only npm's documented identity rejection or concealment may pass; issuance outside npm-production must fail",
);
assert.match(
  npmBoundaryJobBlock,
  /encoded_package="\$\{PACKAGE_NAME\/\\\/\/%2f\}"/,
  "the boundary probe must match npm-package-arg escapedName semantics for scoped packages",
);
for (const transientStatus of ["000", "408", "425", "429"]) {
  assert.ok(
    npmBoundaryJobBlock.includes(`[ "$http_code" = "${transientStatus}" ]`),
    `the boundary probe must retry transient status ${transientStatus} before failing closed`,
  );
}

const npmProductionBoundaryJobBlock = publishWorkflow.match(
  /\n {2}assert-npm-production-boundary:[\s\S]*?(?=\n {2}gate:)/,
)?.[0];
assert.ok(
  npmProductionBoundaryJobBlock,
  "publication must prove the exact authorized npm-production context before executing project code",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /\n {4}needs: assert-npm-environment-boundary/,
  "the authorized-context probe must run only after npm rejects the no-environment context",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /\n {4}environment: npm-production/,
  "the authorized-context probe must enter exactly npm-production",
);
assert.match(
  npmProductionBoundaryJobBlock,
  new RegExp(`PACKAGE_NAME:\\s*["']${packageJson.name.replace("/", "\\/")}["']`),
  "the authorized-context probe package must match package.json",
);
assert.doesNotMatch(
  npmProductionBoundaryJobBlock,
  /\n\s+uses:/,
  "the authorized-context probe must not checkout code or invoke any action",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /oidc\/token\/exchange\/package\/\$encoded_package/,
  "the authorized-context probe must call npm's documented OIDC exchange endpoint",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /encoded_package="\$\{PACKAGE_NAME\/\\\/\/%2f\}"/,
  "the authorized-context probe must match npm-package-arg escapedName semantics for scoped packages",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /\.workflow_ref == \$workflow/,
  "the authorized-context probe must bind the standard workflow_ref claim",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /\.environment == "npm-production"/,
  "the authorized-context probe must bind the exact environment claim",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /\.sub \| endswith\(":environment:npm-production"\)/,
  "the authorized-context probe must bind the exact environment subject suffix",
);
assert.match(
  npmProductionBoundaryJobBlock,
  /201\)[\s\S]*?authorized the exact[\s\S]*?401\)[\s\S]*?refusing/,
  "only credential issuance in npm-production may pass; rejection must fail closed",
);
for (const transientStatus of ["000", "408", "425", "429"]) {
  assert.ok(
    npmProductionBoundaryJobBlock.includes(`[ "$http_code" = "${transientStatus}" ]`),
    `the authorized-context probe must retry transient status ${transientStatus} before failing closed`,
  );
}
assert.match(
  publishWorkflow,
  /\n {2}gate:[\s\S]*?\n {4}needs: assert-npm-production-boundary[\s\S]*?(?=\n {2}publish-npmjs:)/,
  "no project checkout or dependency execution may precede both npm environment-boundary proofs",
);
const npmGateJobBlock = publishWorkflow.match(/\n {2}gate:[\s\S]*?(?=\n {2}publish-npmjs:)/)?.[0];
assert.ok(npmGateJobBlock, "the npm publication gate must remain a distinct job");
assert.match(
  npmGateJobBlock,
  /\n {4}environment:\n {6}name: github-administration\n {6}deployment: false/,
  "the project-code gate must obtain its administrative token from the protected non-deployment environment",
);

assert.match(
  publishWorkflow,
  /publish-npmjs:[\s\S]*?permissions:\s*\n\s+contents: read[^\n]*\n\s+id-token: write[^\n]*[\s\S]*?publish-gh-packages:/,
  "npmjs publishing must run with the minimal OIDC grant (contents:read + id-token:write) and nothing more",
);
assert.doesNotMatch(
  publishWorkflow,
  /secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/,
  "npmjs publishing must not depend on a long-lived npm publish token",
);
assert.match(
  publishWorkflow,
  /environment:\s*npm-production/,
  "npmjs publishing must use the protected npm-production environment",
);
const npmPublishJobBlock = publishWorkflow.match(
  /\n {2}publish-npmjs:[\s\S]*?(?=\n {2}verify-npmjs:)/,
)?.[0];
assert.ok(npmPublishJobBlock, "npmjs publishing must remain a distinct privileged job");
assert.doesNotMatch(
  npmPublishJobBlock,
  /\bnpm\s+(?:ci|install|run)\b/,
  "the npm-production job must not install dependencies or execute project lifecycle scripts",
);
assert.match(
  publishWorkflow,
  /\n {2}verify-npmjs:[\s\S]*?\n {4}needs: \[gate, publish-npmjs\][\s\S]*?(?=\n {2}publish-gh-packages:)/,
  "post-publication npm verification must run in a separate unprivileged-environment job",
);
const npmVerificationJobBlock = publishWorkflow.match(
  /\n {2}verify-npmjs:[\s\S]*?(?=\n {2}publish-gh-packages:)/,
)?.[0];
assert.ok(npmVerificationJobBlock, "npmjs verification job must be present");
assert.doesNotMatch(
  npmVerificationJobBlock,
  /\n {4}environment:/,
  "post-publication verification must not enter the npm-production environment",
);
assert.match(
  publishWorkflow,
  /npm[^\n]*publish[^\n]*--provenance/,
  "npmjs publishing must request provenance explicitly",
);
assert.doesNotMatch(
  publishWorkflow,
  /\bcache:\s*npm\b/,
  "release jobs must not reuse a package-manager cache",
);

assert.equal(
  (publishWorkflow.match(/STEPSECURITY_NPM_TOKEN/g) ?? []).length,
  0,
  "the removed private-registry credential must not remain in publishing",
);
assert.match(
  publishWorkflow,
  /git show-ref --verify --quiet "refs\/tags\/\$PUBLISH_REF"/,
  "tag-triggered publishing must verify that the requested ref is a real tag",
);
assert.match(
  publishWorkflow,
  /workflow_dispatch:/,
  "auto-tag needs GitHub's documented workflow_dispatch exception because a GITHUB_TOKEN tag push does not start a second workflow",
);
assert.doesNotMatch(
  publishWorkflow,
  /github\.event\.inputs\.tag/,
  "publication must never let an input tag replace the dispatch event's actual ref",
);
assert.doesNotMatch(
  publishWorkflow,
  /workflow_dispatch:\s*\r?\n\s+inputs:/,
  "publication dispatch must not accept any ref-like input; github.ref is the sole release identity",
);
const publishWorkflowLines = publishWorkflow.split(/\r?\n/);
const publishConcurrencyStart = publishWorkflowLines.indexOf("concurrency:");
const publishEnvStart = publishWorkflowLines.indexOf("env:", publishConcurrencyStart + 1);
assert.ok(
  publishConcurrencyStart >= 0 && publishEnvStart > publishConcurrencyStart,
  "publish must retain one top-level concurrency block before its environment",
);
const publishConcurrencyBlock = publishWorkflowLines
  .slice(publishConcurrencyStart, publishEnvStart)
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n")
  .trimEnd();
assert.equal(
  publishConcurrencyBlock,
  [
    "concurrency:",
    "  group: release-publication",
    "  queue: max",
    "  cancel-in-progress: false",
  ].join("\n"),
  "all tags must share one FIFO publication transaction so registry and GitHub latest cannot race",
);
assert.doesNotMatch(
  publishConcurrencyBlock,
  /github\.(?:ref|sha)|\$\{\{/,
  "the publication concurrency group must not partition transactions by tag, ref, or commit",
);
for (const triggerIdentityContract of [
  "PUBLISH_REF: $" + "{{ github.ref_name }}",
  "PUBLISH_REF_TYPE: $" + "{{ github.ref_type }}",
  "PUBLISH_REF_PROTECTED: $" + "{{ github.ref_protected }}",
  'if [ "$PUBLISH_REF_TYPE" != "tag" ]',
  'if [ "$PUBLISH_EVENT_REF" != "refs/tags/$PUBLISH_REF" ]',
  'if [ "$PUBLISH_REF_PROTECTED" != "true" ]',
]) {
  assert.ok(
    publishWorkflow.includes(triggerIdentityContract),
    `publish workflow must bind its trigger and protected tag identity: ${triggerIdentityContract}`,
  );
}
assert.match(
  publishWorkflow,
  /TAG_SHA=.*refs\/tags\/\$PUBLISH_REF\^\{commit\}/,
  "publishing must verify that the tag commit equals the checked out commit",
);
assert.match(
  publishWorkflow,
  /gate:[\s\S]*?permissions:\s*\n\s+actions: read[^\n]*\n\s+contents: read[^\n]*\n\s+security-events: read/,
  "the publish gate must hold read-only Actions, contents and code-scanning authorization - nothing more",
);
assert.doesNotMatch(
  zizmorConfig,
  /excessive-permissions:[\s\S]{0,60}?disable/,
  "the stale write-all-era exemption must stay deleted so zizmor guards permission regressions",
);
assert.match(
  publishWorkflow,
  /uses: \$\/\.github\/actions\/validate-action-pins/,
  "the release gate must revalidate action pinning through the immutable $/ composite action, not code from the tag checkout",
);
{
  const validatorPath = "../.github/actions/validate-action-pins/validate-action-pins.mjs";
  const { collectUsesFromYaml, validateRef, validateFile, collectTargets } = await import(
    validatorPath
  );
  const flowStyle = "jobs:\n  x:\n    steps:\n      - { uses: third/party@main }\n";
  assert.equal(
    validateFile("fixture.yml", flowStyle).length,
    1,
    "flow-style mappings must be parsed and their unpinned refs rejected",
  );
  const spellings = [
    'jobs:\n  x:\n    steps:\n      - "uses": third/party@main\n',
    "jobs:\n  x:\n    steps:\n      - uses : third/party@main\n",
    "jobs:\n  x:\n    steps:\n      - uses: >-\n          third/party@main\n",
  ];
  for (const doc of spellings) {
    assert.equal(
      validateFile("fixture.yml", doc).length,
      1,
      "every YAML spelling of the uses key must reach the pin check",
    );
  }
  assert.equal(validateRef("./.github/actions/setup-npm-toolchain"), null);
  assert.equal(validateRef("$/.github/actions/setup-npm-toolchain"), null);
  assert.equal(validateRef("owner/action@" + "a".repeat(40)), null);
  assert.ok(validateRef("owner/action@v4"), "tag references must be rejected");
  assert.ok(validateRef("owner/action@abcdef1"), "short SHAs must be rejected");
  assert.equal(
    collectUsesFromYaml("fixture.yml", "uses: [not, a, string]").problems.length,
    1,
    "non-string uses values must fail closed",
  );
  assert.equal(
    collectUsesFromYaml("fixture.yml", "jobs: {").problems.length,
    1,
    "unparseable YAML must fail closed",
  );
  {
    const nestedRoot = await mkdtemp(path.join(os.tmpdir(), "pin-validator-nested-"));
    try {
      await mkdir(path.join(nestedRoot, ".github", "workflows"), { recursive: true });
      await mkdir(path.join(nestedRoot, ".github", "actions", "group", "inner"), {
        recursive: true,
      });
      await writeFile(path.join(nestedRoot, ".github", "workflows", "w.yml"), "jobs: {}\n");
      await writeFile(
        path.join(nestedRoot, ".github", "actions", "group", "inner", "action.yml"),
        "runs:\n  using: composite\n  steps:\n    - uses: third/party@main\n",
      );
      const targets = collectTargets(nestedRoot).map((t) => t.replace(/\\/g, "/"));
      assert.equal(
        targets.filter((t) => t.endsWith("action.yml")).length,
        1,
        "nested local action manifests must be discovered recursively",
      );
      const { validateTree } = await import(validatorPath);
      assert.equal(
        validateTree(nestedRoot).length,
        1,
        "an unpinned third-party uses inside a nested local action must fail the gate",
      );
    } finally {
      await rm(nestedRoot, { recursive: true, force: true });
    }
  }
}
const publicationGateBlock = publishWorkflow.match(
  /\n {2}gate:[\s\S]*?(?=\n {2}publish-npmjs:)/,
)?.[0];
assert.ok(
  publicationGateBlock,
  "publication must retain one blocking gate for every external writer",
);
assert.match(
  publicationGateBlock,
  /timeout-minutes:\s*90/,
  "the publish gate's outer timeout must exceed the exact-workflow helper's 60-minute queue budget",
);
assert.match(
  publicationGateBlock,
  /Require owner-enforced immutable GitHub Releases[\s\S]*?LCV_AUTOMATION_TOKEN[\s\S]*?repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases[\s\S]*?enforced_by_owner/,
  "owner-enforced immutable releases must be proven in the gate before registry jobs become eligible",
);
const immutableReleasePreflightBlock = publicationGateBlock.match(
  /- name: Require owner-enforced immutable GitHub Releases[\s\S]*?(?=\n\s+- name: Checkout)/,
)?.[0];
assert.ok(
  immutableReleasePreflightBlock,
  "the owner-enforced immutable-release preflight must remain independently auditable",
);
const preflightAdminTokenCopy = immutableReleasePreflightBlock.indexOf(
  'immutability_token="$' + '{ADMIN_GH_TOKEN:-}"',
);
const preflightAdminTokenUnset = immutableReleasePreflightBlock.indexOf("unset ADMIN_GH_TOKEN");
const preflightFirstSubprocess = immutableReleasePreflightBlock.indexOf(
  'policy_json="$(GH_TOKEN="$immutability_token" gh api',
);
assert.ok(
  preflightAdminTokenCopy >= 0 &&
    preflightAdminTokenUnset > preflightAdminTokenCopy &&
    preflightFirstSubprocess > preflightAdminTokenUnset,
  "the initial administrative token must become a non-exported shell variable before any subprocess starts",
);
assert.equal(
  (immutableReleasePreflightBlock.match(/\$\{?ADMIN_GH_TOKEN/g) ?? []).length,
  1,
  "the initial exported administrative token may only be read once before it is unset",
);
assert.match(
  immutableReleasePreflightBlock,
  /GH_TOKEN="\$immutability_token" gh api --method GET[\s\S]*?immutable-releases/,
  "the initial administrative token must be injected only into the immutable-policy gh api subprocess",
);
assert.doesNotMatch(
  immutableReleasePreflightBlock,
  /export\s+immutability_token/,
  "the copied initial administrative token must never be exported",
);
const immutablePreflightFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-immutable-preflight-"),
);
try {
  const mockBin = path.join(immutablePreflightFixtureRoot, "mock-bin");
  const fixtureScript = path.join(immutablePreflightFixtureRoot, "immutable-preflight.sh");
  const traceFile = path.join(immutablePreflightFixtureRoot, "environment.trace");
  await mkdir(mockBin, { recursive: true });
  const preflightRunBody = immutableReleasePreflightBlock
    .match(/run: \|\r?\n([\s\S]*)/)?.[1]
    ?.split(/\r?\n/)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  assert.ok(preflightRunBody, "the immutable-policy preflight must retain an executable run body");
  await writeFile(fixtureScript, `#!/usr/bin/env bash\n${preflightRunBody}\n`, "utf8");
  await writeFile(
    path.join(mockBin, "gh"),
    `#!/usr/bin/env bash
printf 'gh ADMIN=%s GH=%s COPY=%s\n' \
  "\${ADMIN_GH_TOKEN-unset}" "\${GH_TOKEN-unset}" "\${immutability_token-unset}" >> "$TRACE_FILE"
printf '%s\n' '{"enabled":true,"enforced_by_owner":true}'
`,
    "utf8",
  );
  await writeFile(
    path.join(mockBin, "jq"),
    `#!/usr/bin/env bash
printf 'jq ADMIN=%s GH=%s COPY=%s\n' \
  "\${ADMIN_GH_TOKEN-unset}" "\${GH_TOKEN-unset}" "\${immutability_token-unset}" >> "$TRACE_FILE"
case "$*" in
  *enforced_by_owner*) printf '%s\n' true ;;
  *enabled*) printf '%s\n' true ;;
  *) exit 64 ;;
esac
`,
    "utf8",
  );
  await Promise.all([
    chmod(fixtureScript, 0o755),
    chmod(path.join(mockBin, "gh"), 0o755),
    chmod(path.join(mockBin, "jq"), 0o755),
  ]);
  const preflightOutput = execFileSync("bash", [fixtureScript], {
    cwd: immutablePreflightFixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ADMIN_GH_TOKEN: "administrative-sentinel",
      GITHUB_REPOSITORY: "LCV-Ideas-Software/cross-review-fixture",
      GITHUB_RUN_ID: "1",
      PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: immutablePreflightFixtureRoot,
      TRACE_FILE: traceFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(
    preflightOutput,
    /Owner-enforced immutable releases proven before any registry or release write/,
    "the isolated administrative preflight fixture must still authorize the policy read",
  );
  const preflightTrace = await readFile(traceFile, "utf8");
  assert.equal(
    preflightTrace,
    [
      "gh ADMIN=unset GH=administrative-sentinel COPY=unset",
      "jq ADMIN=unset GH=unset COPY=unset",
      "jq ADMIN=unset GH=unset COPY=unset",
      "",
    ].join("\n"),
    "only gh api may inherit the administrative token; jq and every unrelated child must receive none",
  );
} finally {
  await rm(immutablePreflightFixtureRoot, { recursive: true, force: true });
}
const workflowStepBlocks = (workflow) => workflow.split(/\r?\n(?= {6}- name: )/);
const exportedGithubTokenSteps = [
  ...workflowStepBlocks(autoTagWorkflow),
  ...workflowStepBlocks(publishWorkflow),
].filter((step) => step.includes(["GH_TOKEN: $", "{{ secrets.GITHUB_TOKEN }}"].join("")));
assert.equal(
  exportedGithubTokenSteps.length,
  12,
  "the secret-scope regression must audit every minimal-permission GITHUB_TOKEN shell step",
);
for (const step of exportedGithubTokenSteps) {
  const stepName = step.match(/- name:\s*([^\r\n]+)/)?.[1] ?? "unnamed GITHUB_TOKEN step";
  const runBody = step.match(/run: \|\r?\n([\s\S]*)/)?.[1] ?? "";
  const tokenCopy = runBody.indexOf('github_token="$' + '{GH_TOKEN:-}"');
  const tokenUnset = runBody.indexOf("unset GH_TOKEN");
  assert.ok(
    tokenCopy >= 0 && tokenUnset > tokenCopy,
    `${stepName} must copy then unset the exported GITHUB_TOKEN before invoking any child`,
  );
  assert.equal(
    (runBody.match(/\$\{?GH_TOKEN/g) ?? []).length,
    1,
    `${stepName} may read the exported GITHUB_TOKEN name only once`,
  );
  assert.doesNotMatch(
    runBody,
    /export\s+github_token|^\s*gh\s+(?:api|run|workflow|release)\b/m,
    `${stepName} must not export the copy or invoke an authenticated gh command without a scoped wrapper`,
  );
}

const githubPackagesJobBlock = publishWorkflow.match(
  /\n {2}publish-gh-packages:[\s\S]*?(?=\n {2}create-github-release:)/,
)?.[0];
assert.ok(githubPackagesJobBlock, "the GitHub Packages job must remain independently auditable");
assert.equal(
  (githubPackagesJobBlock.match(/NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? [])
    .length,
  1,
  "the GitHub Packages write token must enter only the credential-file setup step",
);
const githubPackagesCredentialBlock = githubPackagesJobBlock.match(
  /- name: Select GitHub Packages registry for publish[\s\S]*?(?=\n\s+# Keep both command-line GitHub Packages overrides)/,
)?.[0];
assert.ok(
  githubPackagesCredentialBlock,
  "GitHub Packages must retain an explicit credential-file setup step",
);
assert.match(
  githubPackagesCredentialBlock,
  /github_packages_token="\$\{NODE_AUTH_TOKEN:-\}"\s+unset NODE_AUTH_TOKEN[\s\S]*?_authToken=\$\{github_packages_token\}/,
  "the GitHub Packages token must become a non-exported shell variable before the credential file is written",
);
assert.equal(
  (githubPackagesCredentialBlock.match(/\$\{?NODE_AUTH_TOKEN/g) ?? []).length,
  1,
  "the exported GitHub Packages token name may only be read once before it is unset",
);
assert.match(
  githubPackagesJobBlock,
  /- name: Remove GitHub Packages credential file\s+if: always\(\)[\s\S]*?rm -f -- "\$\{RUNNER_TEMP\}\/npm-github-packages\.npmrc"/,
  "the temporary GitHub Packages credential file must be removed even after a failed publication step",
);
for (const externalWriter of ["publish-npmjs", "publish-gh-packages"]) {
  assert.match(
    publishWorkflow,
    new RegExp(`\\n  ${externalWriter}:[\\s\\S]*?\\n    needs: gate\\r?\\n`),
    `${externalWriter} must remain blocked on the immutable-release policy gate`,
  );
}
assert.match(
  publishWorkflow,
  /Revalidate immutable tag target against live main history and all required workflows/,
  "publish.yml must independently reject a valid-looking tag that bypassed auto-tag",
);
assert.match(
  publishWorkflow,
  /sha:\s*\$\{\{\s*steps\.hardgate\.outputs\.sha\s*\}\}/,
  "the verified release commit must be exported as an immutable gate output",
);
assert.ok(
  (publishWorkflow.match(/ref:\s*\$\{\{\s*needs\.gate\.outputs\.sha\s*\}\}/g) ?? []).length >= 3,
  "every downstream publish/release checkout must use the verified commit SHA, not a mutable tag name",
);
assert.match(
  publishWorkflow,
  /Revalidate release tag identity/,
  "release jobs must revalidate that the public tag still names the verified commit",
);
assert.equal(
  (publishWorkflow.match(/- name: Revalidate release tag identity before/g) ?? []).length,
  3,
  "both package publications and GitHub Release creation must revalidate the mutable tag immediately before their external write",
);
const downstreamRevalidationBlocks = [
  ...publishWorkflow.matchAll(
    /- name: Revalidate release tag identity before[^\n]*\n[\s\S]*?(?=\n\s+- name: (?:Publish|Create)|\n\s+timeout-minutes:)/g,
  ),
].map((match) => match[0]);
assert.equal(
  downstreamRevalidationBlocks.length,
  3,
  "every external-write job must retain one bounded tag/main revalidation block",
);
for (const block of downstreamRevalidationBlocks) {
  assert.match(
    block,
    /git\/ref\/heads\/main/,
    "a downstream release write must resolve live main through the authenticated API",
  );
  assert.match(
    block,
    /compare\/\$\{VERIFIED_SHA\}\.\.\.\$\{MAIN_SHA\}/,
    "a downstream release write must prove the gate SHA remains in live main history",
  );
  assert.match(
    block,
    /git\/ref\/tags\/\$PUBLISH_REF|git\/ref\/tags\/\$TAG/,
    "a downstream release write must re-resolve the mutable tag through the authenticated API",
  );
}
assert.match(
  publishWorkflow,
  /Revalidate protected release identity after local validation[\s\S]*?echo "sha=\$TAG_SHA"/,
  "the gate must revalidate protected tag/main identity after its own check and test steps",
);
for (const releasePrerequisite of [
  "git/ref/heads/main",
  `compare/\${TAG_SHA}...\${LIVE_MAIN_SHA}`,
  "code-scanning/analyses?per_page=100",
  "Accept: application/sarif+json",
  '.commit_sha == $sha and .tool.name == "CodeQL"',
  "supply-chain/local",
  "supply-chain/online-scm",
  "supply-chain/branch-protection",
]) {
  assert.ok(
    publishWorkflow.includes(releasePrerequisite),
    `publish.yml must independently enforce release prerequisite: ${releasePrerequisite}`,
  );
}
assert.match(
  publishWorkflow,
  /All three exact OpenSSF Scorecard SARIF categories are processed for \$TAG_SHA[\s\S]*?non-allowlisted result/,
  "all three always-on exact-SHA Scorecard SARIF categories must be evaluated fail-closed",
);
assert.doesNotMatch(
  publishWorkflow,
  /code-scanning\/alerts\?state=open&ref=refs\/heads\/main/,
  "current-main alert state must never substitute for exact historical release-SHA evidence",
);
assert.match(
  publishWorkflow,
  /require-release-push-workflows\.sh "\$TAG_SHA"/,
  "the publish gate must always invoke the exact-identity main-push workflow gate",
);
assert.match(
  autoTagWorkflow,
  /Require every exact-SHA push workflow to pass[\s\S]*?require-release-push-workflows\.sh "\$TARGET_SHA"/,
  "auto-tag must not create a release identity before all five exact-SHA push workflows pass",
);
for (const workflowPath of [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/zizmor.yml",
  ".github/workflows/scorecard.yml",
  ".github/workflows/pages.yml",
]) {
  assert.ok(
    releasePushWorkflowGate.includes(`"${workflowPath}"`),
    `the release gate must bind the required workflow path exactly: ${workflowPath}`,
  );
}
for (const workflowIdentityContract of [
  'select(.path == $path and .state == "active")',
  ".workflow_id == $workflow_id",
  ".path == $path",
  '.event == "push"',
  ".head_sha == $sha",
  '.head_branch == "main"',
  ".head_repository.full_name == $repo",
  "for attempt in {1..360}",
]) {
  assert.ok(
    releasePushWorkflowGate.includes(workflowIdentityContract),
    `the release gate must retain exact workflow identity/polling contract: ${workflowIdentityContract}`,
  );
}
assert.doesNotMatch(
  releasePushWorkflowGate,
  /workflowName|workflow_name|select\(\.name\s*==/,
  "display names are not unique and must never select release-gating workflow runs",
);
for (const helperPath of [
  "scripts/require-dependabot-release-evidence.sh",
  "scripts/require-release-push-workflows.sh",
]) {
  execFileSync("bash", ["-n", path.join(root, helperPath)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
assert.match(
  autoTagWorkflow,
  /Require every exact-SHA push workflow to pass[\s\S]*?timeout-minutes:\s*90/,
  "auto-tag's outer timeout must exceed the exact-workflow gate's 60-minute queue budget",
);
for (const workflow of [autoTagWorkflow, publishWorkflow]) {
  assert.match(
    workflow,
    /require-dependabot-release-evidence\.sh require "\$(?:TARGET|TAG)_SHA" "\$VERSION_BOUNDARY_SHA"/,
    "both tag creation and publication must independently require version-epoch Dependabot evidence",
  );
  assert.doesNotMatch(
    workflow,
    /git diff-tree[^\n]*dependabot\.yml|workflowName == "Dependabot Updates"/,
    "single-commit path inspection and untyped Dependabot run counts must never satisfy the release gate",
  );
}
for (const provenanceContract of [
  "dynamic/dependabot/dependabot-updates",
  '.actor.login == "dependabot[bot]"',
  '.triggering_actor.login == "dependabot[bot]"',
  'startswith("npm_and_yarn in /',
  '"github_actions"',
  '"pip"',
  '"pre_commit"',
  "sort_by(.ecosystem, .id)",
  "group_by(.ecosystem)",
  "map(last)",
]) {
  assert.ok(
    dependabotReleaseEvidence.includes(provenanceContract),
    `Dependabot release evidence must retain provenance/cardinality contract: ${provenanceContract}`,
  );
}

// Exercise the exact workflow selector as a program, not just as source text.
// The adversarial fixture presents a newer successful run named "CI" with the
// wrong workflow identity/path beside the failed exact CI run. Display names
// and unrelated paths must not be able to satisfy the release gate.
const pushWorkflowFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-push-workflows-"),
);
try {
  const fixtureScript = path.join(pushWorkflowFixtureRoot, "require-release-push-workflows.sh");
  const mockBin = path.join(pushWorkflowFixtureRoot, "mock-bin");
  const mockGh = path.join(mockBin, "gh");
  await mkdir(mockBin, { recursive: true });
  await writeFile(fixtureScript, releasePushWorkflowGate.replace(/\r\n/g, "\n"), "utf8");
  await writeFile(
    mockGh,
    `#!/usr/bin/env bash
set -euo pipefail

arguments="$*"
case "$arguments" in
  *"/actions/workflows?per_page=100"*)
    printf '%s\\n' '[{"workflows":[{"id":101,"path":".github/workflows/ci.yml","state":"active"},{"id":102,"path":".github/workflows/codeql.yml","state":"active"},{"id":103,"path":".github/workflows/zizmor.yml","state":"active"},{"id":104,"path":".github/workflows/scorecard.yml","state":"active"},{"id":105,"path":".github/workflows/pages.yml","state":"active"}]}]'
    ;;
  *"/git/ref/heads/main"*)
    printf '%s\\n' "$MOCK_SHA"
    ;;
  *"/compare/$MOCK_SHA...$MOCK_SHA"*)
    printf '%s\\n' 'identical'
    ;;
  *"/actions/runs"*)
    [[ "$arguments" == *"head_sha=$MOCK_SHA"* ]]
    [[ "$arguments" == *"event=push"* ]]
    ci_conclusion='success'
    if [ "$MOCK_MODE" = 'spoof-failure' ]; then
      ci_conclusion='failure'
    fi
    printf '[{"workflow_runs":['
    printf '{"id":201,"workflow_id":101,"name":"CI","path":".github/workflows/ci.yml","event":"push","status":"completed","conclusion":"%s","head_sha":"%s","head_branch":"main","head_repository":{"full_name":"%s"}}' "$ci_conclusion" "$MOCK_SHA" "$MOCK_REPO"
    printf ',{"id":999,"workflow_id":999,"name":"CI","path":".github/workflows/not-ci.yml","event":"push","status":"completed","conclusion":"success","head_sha":"%s","head_branch":"main","head_repository":{"full_name":"%s"}}' "$MOCK_SHA" "$MOCK_REPO"
    workflow_id=102
    for workflow_path in codeql zizmor scorecard pages; do
      printf ',{"id":%s,"workflow_id":%s,"name":"fixture","path":".github/workflows/%s.yml","event":"push","status":"completed","conclusion":"success","head_sha":"%s","head_branch":"main","head_repository":{"full_name":"%s"}}' "$((workflow_id + 100))" "$workflow_id" "$workflow_path" "$MOCK_SHA" "$MOCK_REPO"
      workflow_id="$((workflow_id + 1))"
    done
    printf ']}]\\n'
    ;;
  *)
    printf 'unexpected gh invocation: %s\\n' "$arguments" >&2
    exit 64
    ;;
esac
`,
    "utf8",
  );
  await chmod(mockGh, 0o755);

  const fixtureGit = (args) =>
    execFileSync("git", args, {
      cwd: pushWorkflowFixtureRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  fixtureGit(["init", "-b", "main"]);
  fixtureGit(["config", "user.name", "Release Regression"]);
  fixtureGit(["config", "user.email", "release-regression@example.invalid"]);
  await writeFile(
    path.join(pushWorkflowFixtureRoot, "README.md"),
    "exact workflow identity fixture\n",
    "utf8",
  );
  fixtureGit(["add", "README.md"]);
  fixtureGit(["commit", "-m", "fixture"]);
  const fixtureSha = fixtureGit(["rev-parse", "HEAD"]);
  const fixtureRepo = "LCV-Ideas-Software/cross-review-fixture";
  const fixtureEnv = {
    ...process.env,
    PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
    GH_TOKEN: "fixture-token",
    GITHUB_REPOSITORY: fixtureRepo,
    MOCK_MODE: "success",
    MOCK_REPO: fixtureRepo,
    MOCK_SHA: fixtureSha,
  };
  const happyOutput = execFileSync("bash", [fixtureScript, fixtureSha], {
    cwd: pushWorkflowFixtureRoot,
    encoding: "utf8",
    env: fixtureEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(
    happyOutput,
    /All five exact-path, exact-ID push workflows passed/,
    "the executable exact-workflow gate fixture must pass all five trusted identities",
  );

  let spoofFailure;
  try {
    execFileSync("bash", [fixtureScript, fixtureSha], {
      cwd: pushWorkflowFixtureRoot,
      encoding: "utf8",
      env: { ...fixtureEnv, MOCK_MODE: "spoof-failure" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spoofFailure = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  assert.match(
    spoofFailure ?? "",
    /CI \(\.github\/workflows\/ci\.yml, id=101\) finished as completed:failure/,
    "a newer successful display-name spoof must not hide the failed exact CI workflow",
  );
} finally {
  await rm(pushWorkflowFixtureRoot, { recursive: true, force: true });
}

// Reproduce the recovery bypass that motivated the epoch gate: commit A bumps
// the version and changes dependabot.yml, then same-version commit B changes an
// unrelated file. A single diff-tree(B) misses the security-relevant change;
// blob provenance must retain A as eligible evidence for B. The same fixture
// exercises root and first-parent merge handling.
const dependabotEpochFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-dependabot-epoch-"),
);
try {
  const fixtureScript = path.join(
    dependabotEpochFixtureRoot,
    "require-dependabot-release-evidence.sh",
  );
  await mkdir(path.join(dependabotEpochFixtureRoot, ".github"), { recursive: true });
  await writeFile(fixtureScript, dependabotReleaseEvidence.replace(/\r\n/g, "\n"), "utf8");
  const runGit = (args) =>
    execFileSync("git", args, {
      cwd: dependabotEpochFixtureRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const resolveFixture = (targetSha, boundarySha) =>
    JSON.parse(
      execFileSync("bash", [fixtureScript, "resolve-provenance", targetSha, boundarySha], {
        cwd: dependabotEpochFixtureRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Release Regression"]);
  runGit(["config", "user.email", "release-regression@example.invalid"]);
  await Promise.all([
    writeFile(
      path.join(dependabotEpochFixtureRoot, "package.json"),
      `${JSON.stringify({ name: "epoch-fixture", version: "1.0.0" })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(dependabotEpochFixtureRoot, ".github", "dependabot.yml"),
      "version: 2\nupdates: []\n",
      "utf8",
    ),
  ]);
  runGit(["add", "."]);
  runGit(["commit", "-m", "initial"]);
  const rootSha = runGit(["rev-parse", "HEAD"]);

  await Promise.all([
    writeFile(
      path.join(dependabotEpochFixtureRoot, "package.json"),
      `${JSON.stringify({ name: "epoch-fixture", version: "1.0.1" })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(dependabotEpochFixtureRoot, ".github", "dependabot.yml"),
      'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n',
      "utf8",
    ),
  ]);
  runGit(["add", "."]);
  runGit(["commit", "-m", "version and Dependabot policy"]);
  const versionBoundarySha = runGit(["rev-parse", "HEAD"]);

  await writeFile(
    path.join(dependabotEpochFixtureRoot, "README.md"),
    "same-version recovery candidate\n",
    "utf8",
  );
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "unrelated recovery commit"]);
  const recoverySha = runGit(["rev-parse", "HEAD"]);
  const unsafeSingleCommitDiff = runGit([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    recoverySha,
  ]);
  assert.doesNotMatch(
    unsafeSingleCommitDiff,
    /^\.github\/dependabot\.yml$/m,
    "fixture must reproduce the old single-commit path-filter bypass",
  );
  const recoveryProvenance = resolveFixture(recoverySha, versionBoundarySha);
  assert.equal(recoveryProvenance.changed_in_epoch, true);
  assert.equal(recoveryProvenance.config_boundary_sha, versionBoundarySha);
  assert.deepEqual(recoveryProvenance.eligible_head_shas, [recoverySha, versionBoundarySha]);

  const rootProvenance = resolveFixture(rootSha, rootSha);
  assert.equal(rootProvenance.changed_in_epoch, true);
  assert.equal(rootProvenance.config_boundary_sha, rootSha);
  assert.deepEqual(rootProvenance.eligible_head_shas, [rootSha]);

  runGit(["checkout", "-b", "dependabot-policy-v2"]);
  await writeFile(
    path.join(dependabotEpochFixtureRoot, ".github", "dependabot.yml"),
    'version: 2\nupdates:\n  - package-ecosystem: "github-actions"\n    directory: "/"\n',
    "utf8",
  );
  runGit(["add", ".github/dependabot.yml"]);
  runGit(["commit", "-m", "replace Dependabot policy on side branch"]);
  runGit(["checkout", "main"]);
  runGit(["merge", "--no-ff", "dependabot-policy-v2", "-m", "merge Dependabot policy"]);
  const mergeSha = runGit(["rev-parse", "HEAD"]);
  const mergeProvenance = resolveFixture(mergeSha, versionBoundarySha);
  assert.equal(mergeProvenance.changed_in_epoch, true);
  assert.equal(mergeProvenance.config_boundary_sha, mergeSha);
  assert.deepEqual(mergeProvenance.eligible_head_shas, [mergeSha]);
} finally {
  await rm(dependabotEpochFixtureRoot, { recursive: true, force: true });
}
const publishPrerequisiteGateBlock = publishWorkflow.match(
  /- name: Revalidate immutable tag target against live main history and all required workflows[\s\S]*?(?=\n\s+- name: Setup Node\.js 24)/,
)?.[0];
assert.ok(publishPrerequisiteGateBlock, "publish must retain its immutable prerequisite gate");
assert.doesNotMatch(
  publishPrerequisiteGateBlock,
  /actions\/runs\/[^\s"']+\/rerun|rerun-failed-jobs/,
  "cancelled historical checks must block instead of reusing their original concurrency context",
);
assert.match(
  publishWorkflow,
  /npm audit signatures/,
  "post-publish verification must cryptographically audit registry signatures and provenance",
);
assert.match(
  publishWorkflow,
  /npm view "\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}" --json[\s\S]*?create-signature-audit-lock\.mjs[\s\S]*?npm ci --omit=dev --ignore-scripts --no-audit --no-fund --allow-git=none --allow-remote=none[\s\S]*?verify-published-package-runtime-contract\.mjs[\s\S]*?npm audit signatures/,
  "signature audit must install the exact published package through a validated lockfile and npm ci",
);
assert.match(
  publishWorkflow,
  /npm view "\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}" version/,
  "public visibility must query the configured npmjs.org registry without downloading executable content",
);
assert.doesNotMatch(
  publishWorkflow,
  /npm install[^\n]*"\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}"/,
  "published-package signature verification must not use a mutable npm install command",
);
assert.doesNotMatch(
  publishWorkflow,
  /--(?:@lcv-ideas-software:)?registry=https:\/\/registry\.npmjs\.org\/?/,
  "npmjs.org must come from the reviewed project/setup-node configuration instead of command-line overrides",
);
assert.doesNotMatch(
  publishWorkflow,
  /curl -fsS "\$URL" \| node -e/,
  "npmjs visibility must not pipe downloaded data into an interpreter",
);

for (const immutableOutput of [
  "package_tarball: $" + "{{ steps.pack.outputs.tarball }}",
  "package_sha256: $" + "{{ steps.pack.outputs.sha256 }}",
  "package_integrity: $" + "{{ steps.pack.outputs.integrity }}",
]) {
  assert.ok(
    publishWorkflow.includes(immutableOutput),
    `the release gate must export immutable artifact evidence: ${immutableOutput}`,
  );
}
assert.equal(
  (publishWorkflow.match(/npm pack --pack-destination artifacts/g) ?? []).length,
  1,
  "the release package must be packed exactly once in the trusted gate",
);
assert.match(
  publishWorkflow,
  /TARBALL_CONTENTS="\$RUNNER_TEMP\/package-contents-\$\{GITHUB_RUN_ID\}\.txt"[\s\S]*?tar -tzf "\$TARBALL" > "\$TARBALL_CONTENTS"[\s\S]*?grep -q '\^package\/docs\/reports\/' "\$TARBALL_CONTENTS"/,
  "the release gate must materialize the complete tar listing before rejecting internal field reports",
);
assert.doesNotMatch(
  publishWorkflow,
  /tar -tzf "\$TARBALL"\s*\|\s*grep/,
  "the release gate must not combine tar, grep -q and pipefail because an early match can turn tar's SIGPIPE into a false negative",
);

const forbiddenPackageFixture = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-package-policy-"),
);
try {
  const forbiddenReportDirectory = path.join(forbiddenPackageFixture, "package", "docs", "reports");
  await mkdir(forbiddenReportDirectory, { recursive: true });
  await writeFile(path.join(forbiddenReportDirectory, "internal.md"), "fixture only\n", "utf8");
  const forbiddenTarball = path.join(forbiddenPackageFixture, "forbidden-package.tgz");
  execFileSync("tar", ["-czf", forbiddenTarball, "-C", forbiddenPackageFixture, "package"], {
    stdio: "pipe",
  });
  const forbiddenListing = execFileSync("tar", ["-tzf", forbiddenTarball], {
    encoding: "utf8",
  });
  assert.equal(
    forbiddenListing.split(/\r?\n/).some((entry) => entry.startsWith("package/docs/reports/")),
    true,
    "a package containing docs/reports must be detected by the materialized tar listing",
  );
} finally {
  await rm(forbiddenPackageFixture, { recursive: true, force: true });
}
assert.equal(
  (publishWorkflow.match(/actions\/upload-artifact@[a-f0-9]{40}/g) ?? []).length,
  1,
  "the gate must upload exactly one immutable package artifact with a commit-pinned action",
);
assert.equal(
  (publishWorkflow.match(/actions\/download-artifact@[a-f0-9]{40}/g) ?? []).length,
  3,
  "both registries and GitHub Releases must download the same gate artifact",
);
assert.equal(
  (
    publishWorkflow.match(
      /node scripts\/release-policy\.mjs verify-file-sri "artifacts\/\$PACKAGE_TARBALL"/g,
    ) ?? []
  ).length,
  3,
  "every external-write job must verify the downloaded tarball SRI before use",
);
const packagePublishLines = publishWorkflow
  .split(/\r?\n/)
  .filter((line) => line.trimStart().startsWith("run: npm ") && /\bpublish\b/.test(line));
assert.equal(
  packagePublishLines.length,
  2,
  "exactly the two package registries may run npm publish",
);
for (const line of packagePublishLines) {
  assert.match(
    line,
    /publish "\.\/artifacts\/\$PACKAGE_TARBALL"/,
    "each registry must publish an explicit local path to the exact gate-produced tarball",
  );
  assert.match(
    line,
    /--ignore-scripts/,
    "publishing the immutable tarball must not run lifecycle scripts",
  );
}
assert.doesNotMatch(
  publishWorkflow,
  /\bpublish "artifacts\/\$PACKAGE_TARBALL"/,
  "npm must not reinterpret an unprefixed tarball path as a GitHub shorthand package spec",
);
assert.ok(
  (publishWorkflow.match(/version dist\.integrity --json/g) ?? []).length >= 4,
  "existing and newly visible versions in both registries must match the immutable tarball SRI",
);
assert.equal(
  (
    publishWorkflow.match(
      /Could not safely determine (?:npmjs\.com package|GitHub Packages) state/g,
    ) ?? []
  ).length,
  2,
  "registry existence checks must fail closed on every error except an explicit 404",
);
assert.equal(
  (publishWorkflow.match(/Could not safely read (?:npmjs\.com|GitHub Packages) dist-tags/g) ?? [])
    .length,
  2,
  "dist-tag reads must fail closed on every error except an explicit 404",
);
for (const monotonicPolicy of [
  "npm-publish-tag",
  "assert-registry-latest",
  "github-latest",
  "assert-github-latest",
]) {
  assert.ok(
    publishWorkflow.includes(`node scripts/release-policy.mjs ${monotonicPolicy}`),
    `publication must enforce the executable monotonic release policy: ${monotonicPolicy}`,
  );
}
for (const releaseReconciliationContract of [
  "releases?per_page=100",
  "[.[][] | select(.tag_name == $tag)]",
  "assert-existing-tag-release",
  'github_api --method GET "repos/$GITHUB_REPOSITORY/git/ref/$ref_path"',
  'github_api --method GET "repos/$GITHUB_REPOSITORY/git/tags/$object_sha"',
  "Published release $TAG is missing immutable asset $PACKAGE_TARBALL",
  "Release asset digest mismatch",
  "must contain exactly one $PACKAGE_TARBALL asset",
  "prepublish-release-asset",
  "prepatch-release-asset",
  "final-release-asset",
  "Release asset id changed",
  "Published release $TAG did not become immutable",
  ["IMMUTABILITY_TOKEN: $", "{{ secrets.LCV_AUTOMATION_TOKEN }}"].join(""),
  'assert_immutable_release_policy "release-reconciliation"',
  'assert_immutable_release_policy "release-patch"',
  "immutable-releases",
  "enforced_by_owner",
  'release_immutable="$(jq -er',
  'github_release verify "$TAG" --repo "$GITHUB_REPOSITORY"',
  'github_release verify-asset "$TAG" "artifacts/$PACKAGE_TARBALL"',
  'GH_CLI_VERSION="$(gh --version',
  'assert-safe-gh-release-verifier "$GH_CLI_VERSION"',
  "CVE-2026-48501",
]) {
  assert.ok(
    publishWorkflow.includes(releaseReconciliationContract),
    `GitHub Release reconciliation must fail closed on partial or conflicting state: ${releaseReconciliationContract}`,
  );
}
const loadedReleaseIdentityBlock = publishWorkflow.match(
  /assert_loaded_release_identity\(\) \{[\s\S]*?(?=\n {10}\})/,
)?.[0];
assert.ok(loadedReleaseIdentityBlock, "release reconciliation must retain an identity validator");
assert.match(
  loadedReleaseIdentityBlock,
  /assert-existing-tag-release[\s\S]*?"\$release_json" "\$expected_id" "\$TAG"/,
  "an existing release must bind identity to its id and authenticated tag ref",
);
assert.doesNotMatch(
  loadedReleaseIdentityBlock,
  /target_commitish|resolve_target_sha/,
  "target_commitish is unused when the Git tag exists and must not impersonate release identity",
);
for (const field of ["draft", "prerelease"]) {
  assert.match(
    loadedReleaseIdentityBlock,
    new RegExp(
      `current_${field}="\\$\\(jq -er '[\\s\\S]*?\\.${field} \\| type[\\s\\S]*?` +
        `\\.${field} \\| tostring[\\s\\S]*?release ${field} must be boolean[\\s\\S]*?` +
        `"\\$release_json"\\)"`,
    ),
    `release ${field}=false must remain a valid boolean string instead of becoming jq exit 1`,
  );
}
assert.doesNotMatch(
  loadedReleaseIdentityBlock,
  /jq -er '\.(?:draft|prerelease)'/,
  "jq -e must not treat the valid boolean false as a failed release identity read",
);
assert.doesNotMatch(
  publishWorkflow,
  /jq -er '\.(?:draft|prerelease)'/,
  "no release path may use jq -e directly on a boolean that is validly false",
);

const frozenTagRecoverySkip = autoTagWorkflow.match(
  /# v04\.05\.26 contains the pre-fix publish workflow[\s\S]*?(?=\n\s+for attempt in \{1\.\.10\}; do)/,
)?.[0];
assert.ok(
  frozenTagRecoverySkip,
  "auto-tag must retain a separately auditable exception for the immutable workflow frozen at v04.05.26",
);
assert.match(
  frozenTagRecoverySkip,
  /TAG" = "v04\.05\.26"[\s\S]*?TARGET_SHA" = "2b8b9b086b4ca48544e42334e7ae625f006c88ae"[\s\S]*?recover-v4\.5\.26-release\.yml[\s\S]*?exit 0/,
  "only the exact broken tag and commit may bypass redispatch of its known-failing workflow",
);
assert.ok(
  frozenTagRecoverySkip.indexOf("exit 0") <
    autoTagWorkflow.indexOf("github_workflow run publish.yml"),
  "the frozen-tag exception must stop before publish.yml can be redispatched",
);

assert.match(
  releaseRecoveryWorkflow,
  /^name: Recover v04\.05\.26 GitHub Release[\s\S]*?workflow_dispatch:[\s\S]*?confirmation:[\s\S]*?required: true/m,
  "the historical recovery must require an explicit typed confirmation",
);
assert.equal(
  (releaseRecoveryWorkflow.match(/permissions:\s*write-all/g) ?? []).length,
  0,
  "the abolished write-all grant must never return to the recovery workflow",
);
assert.match(
  releaseRecoveryWorkflow,
  /permissions:\s*\n\s+actions: read[^\n]*\n\s+contents: write[^\n]*\n\s+packages: read/,
  "the recovery job must hold the minimal grant: contents:write for the Release, read-only Actions and Packages",
);
assert.match(
  releaseRecoveryWorkflow,
  /concurrency:\s*\r?\n\s+group: release-publication\s*\r?\n\s+queue: max\s*\r?\n\s+cancel-in-progress: false/,
  "historical recovery must share the non-cancelling publication FIFO with every tag",
);
assert.match(
  releaseRecoveryWorkflow,
  /environment:\s*github-release-recovery/,
  "the exact recovery must use its main-only protected environment",
);
assert.match(
  releaseRecoveryWorkflow,
  /Checkout trusted main recovery implementation[\s\S]*?persist-credentials: false[\s\S]*?ref: \$\{\{ github\.sha \}\}[\s\S]*?fetch-depth: 0/,
  "recovery must execute only the immutable workflow SHA with no persisted Git credentials",
);
assert.doesNotMatch(
  releaseRecoveryWorkflow,
  /pull_request(?:_target)?:|push:|schedule:/,
  "the privileged recovery must be manual-only and unreachable from untrusted PR events",
);
assert.match(
  releaseRecoveryWorkflow,
  /Remove GitHub Packages recovery credential file\s+if: always\(\)[\s\S]*?rm -f -- "\$\{RUNNER_TEMP\}\/cross-review-release-recovery\.npmrc"/,
  "the temporary package-read credential must be removed even on failure",
);

const recoveryGithubCopy = releaseRecoveryScript.indexOf('github_token="$' + '{GH_TOKEN:-}"');
const recoveryAdminCopy = releaseRecoveryScript.indexOf(
  'immutability_token="$' + '{IMMUTABILITY_TOKEN:-}"',
);
const recoveryGithubUnset = releaseRecoveryScript.indexOf("unset GH_TOKEN");
const recoveryAdminUnset = releaseRecoveryScript.indexOf("unset IMMUTABILITY_TOKEN");
const recoveryFirstSubprocess = releaseRecoveryScript.indexOf('work_dir="$(mktemp -d');
assert.ok(
  recoveryGithubCopy >= 0 &&
    recoveryAdminCopy > recoveryGithubCopy &&
    recoveryGithubUnset > recoveryAdminCopy &&
    recoveryAdminUnset > recoveryGithubUnset &&
    recoveryFirstSubprocess > recoveryAdminUnset,
  "both exported recovery tokens must become non-exported shell variables before any subprocess starts",
);
assert.equal(
  (releaseRecoveryScript.match(/\$\{?GH_TOKEN/g) ?? []).length,
  1,
  "the exported GITHUB_TOKEN name may be read only once by the recovery script",
);
assert.equal(
  (releaseRecoveryScript.match(/\$\{?IMMUTABILITY_TOKEN/g) ?? []).length,
  1,
  "the exported administrative token name may be read only once by the recovery script",
);

for (const exactRecoveryIdentity of [
  'readonly operator_login="lcv-leo"',
  'readonly operator_id="268063598"',
  'readonly tag="v04.05.26"',
  'readonly target_sha="2b8b9b086b4ca48544e42334e7ae625f006c88ae"',
  'readonly release_id="358385263"',
  'readonly source_run_id="29967505793"',
  'readonly source_artifact_id="8548431216"',
  'readonly source_artifact_archive_sha256="b0746ff47cdea0fea65ff32b6817a05551963336e983ab2b4ae5d333392fd51e"',
  'readonly package_sha256="97ce84603d5d98654840b7ee6cf2c27e906cee883de6010e18351842869c9301"',
  'readonly package_sri="sha512-i11a4PTnpmEk+30E1B/kziZlBgnVGHbUz/eY1kAspIEume+37KqNnW8dgIHOBOD+1g6XhOPTG3TjqgZBFHy/sg=="',
  'readonly release_body_sha256="94c32cae66c26566ec0577d22a88229b7fd721ff9416490fb04e4df8dfd7c932"',
  'readonly confirmation_phrase="RECOVER v04.05.26 RELEASE 358385263 FROM RUN 29967505793 ARTIFACT 8548431216"',
]) {
  assert.ok(
    releaseRecoveryScript.includes(exactRecoveryIdentity),
    `recovery must remain bound to exact reviewed evidence: ${exactRecoveryIdentity}`,
  );
}

const recoveryJsonHelper = releaseRecoveryScript.match(/github_json_api\(\) \{[\s\S]*?^\}/m)?.[0];
const recoveryBinaryHelper = releaseRecoveryScript.match(
  /github_binary_api\(\) \{[\s\S]*?^\}/m,
)?.[0];
assert.ok(
  recoveryJsonHelper && recoveryBinaryHelper,
  "recovery must keep distinct JSON and binary API helpers",
);
assert.match(recoveryJsonHelper, /Accept: application\/vnd\.github\+json/);
assert.doesNotMatch(recoveryJsonHelper, /application\/octet-stream/);
assert.match(recoveryBinaryHelper, /Accept: application\/octet-stream/);
assert.doesNotMatch(recoveryBinaryHelper, /application\/vnd\.github\+json/);
assert.equal(
  (releaseRecoveryScript.match(/github_binary_api --method GET/g) ?? []).length,
  1,
  "only release-asset byte downloads may use the octet-stream helper",
);
assert.match(
  releaseRecoveryScript,
  /github_json_api --method GET "repos\/\$repository\/actions\/artifacts\/\$source_artifact_id\/zip"/,
  "the Actions artifact archive endpoint must retain its documented JSON media type",
);

for (const recoveryGate of [
  "validate_commits initial-evidence",
  "validate_immutable_policy initial-evidence",
  "validate_source_evidence initial-evidence",
  "verify_registry_integrity initial-evidence",
  "validate_commits final-upload-boundary",
  "validate_immutable_policy final-upload-boundary",
  "validate_source_evidence final-upload-boundary",
  "verify_registry_integrity final-upload-boundary",
  "validate_commits final-publish-boundary",
  "validate_immutable_policy final-publish-boundary",
  "validate_source_evidence final-publish-boundary",
  "verify_registry_integrity final-publish-boundary",
  "validate_commits final-immutable",
  "validate_immutable_policy final-immutable",
  "validate_source_evidence final-immutable",
  "verify_registry_integrity final-immutable",
]) {
  assert.ok(
    releaseRecoveryScript.includes(recoveryGate),
    `recovery must close every identity and registry TOCTOU boundary: ${recoveryGate}`,
  );
}
for (const safetyContract of [
  ".commit.verification.verified == true",
  '.commit.verification.reason == "valid"',
  "git status --porcelain=v1 --untracked-files=all",
  "trusted recovery checkout is not byte-clean",
  '.conclusion == "failure"',
  "Publish to npmjs.com",
  "Publish to GitHub Packages",
  ".expired == false",
  "sha256sum --check --strict",
  "verify-file-sri",
  "Package tarball contains unsafe path",
  "LCV_AUTOMATION_TOKEN is required",
  "enforced_by_owner",
  "Release changed before upload; refusing overwrite or duplication",
  "Release changed before publication PATCH",
  'make_latest: "true"',
  "assert-safe-gh-release-verifier",
  "CVE-2026-48501",
  'github_release verify "$tag"',
  'github_release verify-asset "$tag"',
]) {
  assert.ok(
    releaseRecoveryScript.includes(safetyContract),
    `recovery must retain fail-closed contract: ${safetyContract}`,
  );
}
assert.match(
  releaseRecoveryScript,
  /-H "Authorization: Bearer \$github_token"/,
  "the one-time recovery upload must use GitHub's Bearer authorization scheme",
);
assert.match(
  releaseRecoveryScript,
  /github_release verify-asset "\$tag" "\$artifact_tarball"/,
  "immutable asset attestation must verify the exact downloaded local asset path",
);
assert.equal(
  (releaseRecoveryScript.match(/--request POST/g) ?? []).length,
  1,
  "recovery may contain exactly one guarded asset-creation operation",
);
assert.equal(
  (releaseRecoveryScript.match(/--method PATCH/g) ?? []).length,
  1,
  "recovery may contain exactly one guarded draft-publication operation",
);
assert.match(
  releaseRecoveryScript,
  /immutability_json_api --method PATCH "repos\/\$repository\/releases\/\$release_id"/,
  "the exact draft-publication transition must use the administrative token after GITHUB_TOKEN integration access is refused",
);
assert.doesNotMatch(
  releaseRecoveryScript,
  /--method DELETE|--request DELETE|gh release delete|gh release upload|--clobber|npm\s+publish|git\s+push|git\s+tag|git\s+reset/,
  "recovery must never delete, overwrite, publish a package, or mutate Git identity/history",
);
assert.equal(
  (publishWorkflow.match(/verify_asset_bytes "\$asset_id"/g) ?? []).length,
  3,
  "the exact asset id must be byte-verified after discovery, immediately before PATCH, and after publication",
);
assert.ok(
  (publishWorkflow.match(/sha256sum --check --strict/g) ?? []).length >= 4,
  "all immutable artifact handoffs, including release-asset API reads, must verify SHA-256",
);
const publicationTransitionBlock = publishWorkflow.match(
  /# Close the discovery\/upload TOCTOU window[\s\S]*?(?=\n\s+timeout-minutes:)/,
)?.[0];
assert.ok(
  publicationTransitionBlock,
  "GitHub Release reconciliation must retain one auditable pre-PATCH through attestation transition",
);
const prePatchRevalidationPattern =
  /^\s*load_release\s*\r?\n\s*assert_loaded_release_identity "\$release_id" false\s*\r?\n\s*require_single_asset\s*\r?\n[\s\S]*?if \[ "\$LOADED_ASSET_ID" != "\$asset_id" \][\s\S]*?verify_asset_bytes "\$asset_id" "prepatch-release-asset"\s*\r?\n\s*assert_live_release_ref\s*\r?\n[\s\S]*?LATEST_DECISION_BASE="\$\(read_latest_release_tag\)"[\s\S]*?assert_immutable_release_policy "release-patch"[\s\S]*?github_api --method PATCH[\s\S]*?releases\/\$\{release_id\}/m;
assert.match(
  publicationTransitionBlock,
  prePatchRevalidationPattern,
  "publication must close release, asset, ref, and latest TOCTOU windows before PATCHing the exact release id",
);
const transitionWithoutPrePatchReload = publicationTransitionBlock.replace(
  /^\s*load_release\s*\r?\n/m,
  "",
);
assert.doesNotMatch(
  transitionWithoutPrePatchReload,
  prePatchRevalidationPattern,
  "the regression must fail if the immediate pre-PATCH release reload is removed",
);
const draftPublicationBlock = publicationTransitionBlock.match(
  /if \[ "\$LOADED_RELEASE_DRAFT" = "true" \]; then[\s\S]*?(?=\n {10}else\n {12}# GitHub documents)/,
)?.[0];
const publishedReconciliationBlock = publicationTransitionBlock.match(
  /# GitHub documents only title and release notes[\s\S]*?(?=\n {10}fi\n\n {10}# Publishing)/,
)?.[0];
assert.ok(
  draftPublicationBlock,
  "draft publication must retain a separately auditable mutation path",
);
assert.ok(
  publishedReconciliationBlock,
  "published immutable reconciliation must retain a separately auditable mutation path",
);
assert.match(
  draftPublicationBlock,
  /tag_name:[\s\S]*?target_commitish:[\s\S]*?draft: false[\s\S]*?prerelease:[\s\S]*?make_latest:/,
  "only the draft path may send the complete protected-field publication payload",
);
assert.doesNotMatch(
  publishedReconciliationBlock,
  /\b(?:tag_name|target_commitish|draft|prerelease|make_latest)\s*:/,
  "an immutable published release must never receive protected fields in a PATCH payload",
);
assert.match(
  publishedReconciliationBlock,
  /published_immutable[\s\S]*?!= "true"[\s\S]*?\{name: \$name, body: \$body\}/,
  "published reconciliation must require immutable state and limit repair to documented title/notes fields",
);
const completePatchIsDraftGuarded = (block) => {
  const guard = block.indexOf('if [ "$LOADED_RELEASE_DRAFT" = "true" ]; then');
  const completePayload = block.indexOf("{tag_name: $tag");
  const publishedBranch = block.indexOf("# GitHub documents only title and release notes");
  return guard >= 0 && completePayload > guard && publishedBranch > completePayload;
};
assert.equal(
  completePatchIsDraftGuarded(publicationTransitionBlock),
  true,
  "the protected-field PATCH must be structurally guarded by the loaded draft state",
);
assert.equal(
  completePatchIsDraftGuarded(
    publicationTransitionBlock.replace(
      'if [ "$LOADED_RELEASE_DRAFT" = "true" ]; then',
      "if true; then",
    ),
  ),
  false,
  "the release regression must fail when the draft-state mutation guard is removed",
);
const githubReleaseReconciliationBlock = publishWorkflow.match(
  /- name: Revalidate release tag identity before reconciling GitHub Release[\s\S]*?(?=\n\s+timeout-minutes:)/,
)?.[0];
assert.ok(
  githubReleaseReconciliationBlock,
  "the GitHub Release reconciliation step must remain independently auditable",
);
const githubTokenCopy = githubReleaseReconciliationBlock.indexOf(
  'github_token="$' + '{GH_TOKEN:-}"',
);
const githubTokenUnset = githubReleaseReconciliationBlock.indexOf("unset GH_TOKEN");
const firstGithubReconciliationSubprocess =
  githubReleaseReconciliationBlock.indexOf('ref_json="$(github_api');
assert.ok(
  githubTokenCopy >= 0 &&
    githubTokenUnset > githubTokenCopy &&
    firstGithubReconciliationSubprocess > githubTokenUnset,
  "GITHUB_TOKEN must become a non-exported shell variable before any release-reconciliation subprocess starts",
);
assert.equal(
  (githubReleaseReconciliationBlock.match(/\$\{?GH_TOKEN/g) ?? []).length,
  1,
  "the exported GITHUB_TOKEN name may only be read once before it is unset",
);
assert.match(
  githubReleaseReconciliationBlock,
  /github_api\(\) \{\s+GH_TOKEN="\$github_token" gh api "\$@"\s+\}/,
  "GitHub API authentication must be injected only into the gh api subprocess wrapper",
);
assert.match(
  githubReleaseReconciliationBlock,
  /github_release\(\) \{\s+GH_TOKEN="\$github_token" gh release "\$@"\s+\}/,
  "GitHub Release authentication must be injected only into the gh release subprocess wrapper",
);
assert.match(
  githubReleaseReconciliationBlock,
  /-H "Authorization: Bearer \$github_token"/,
  "the asset-upload token must be injected only into curl's authorization header",
);
assert.doesNotMatch(
  githubReleaseReconciliationBlock,
  /(?:export\s+github_token|GH_TOKEN="\$github_token"\s+(?!gh\s+(?:api|release)\b))/,
  "the copied GitHub token must never be exported or injected into a non-gh subprocess",
);
const adminTokenCopy = githubReleaseReconciliationBlock.indexOf(
  'immutability_token="$IMMUTABILITY_TOKEN"',
);
const adminTokenUnset = githubReleaseReconciliationBlock.indexOf("unset IMMUTABILITY_TOKEN");
const firstReconciliationSubprocess =
  githubReleaseReconciliationBlock.indexOf('ref_json="$(github_api');
assert.ok(
  adminTokenCopy >= 0 &&
    adminTokenUnset > adminTokenCopy &&
    firstReconciliationSubprocess > adminTokenUnset,
  "the administrative token must become a non-exported shell variable before any reconciliation subprocess starts",
);
assert.equal(
  (githubReleaseReconciliationBlock.match(/\$IMMUTABILITY_TOKEN/g) ?? []).length,
  1,
  "the exported administrative environment name may only be read once before it is unset",
);
assert.match(
  githubReleaseReconciliationBlock,
  /GH_TOKEN="\$immutability_token" gh api --method GET[\s\S]*?immutable-releases/,
  "the administrative token must be scoped inline only to the policy-read API process",
);
const waitForCreatedReleaseFunction = githubReleaseReconciliationBlock.match(
  /^ {10}wait_for_created_release\(\) \{\r?\n[\s\S]*?^ {10}\}\r?$/m,
)?.[0];
assert.ok(
  waitForCreatedReleaseFunction,
  "a newly created draft release must have bounded eventual-consistency discovery",
);
const createDraftReleaseBlock = githubReleaseReconciliationBlock.match(
  /if \[ "\$load_status" -eq 1 \]; then[\s\S]*?(?=\n {10}elif \[ "\$load_status" -ne 0 \])/,
)?.[0];
assert.ok(createDraftReleaseBlock, "draft release creation must remain independently auditable");
assert.equal(
  (createDraftReleaseBlock.match(/github_api --method POST/g) ?? []).length,
  1,
  "draft recovery must issue exactly one release-creation POST",
);
assert.match(
  createDraftReleaseBlock,
  /created_release_id="\$\(jq -er '\.id' "\$created_release"\)"\s+wait_for_created_release "\$created_release_id"/,
  "draft recovery must wait for the exact server-issued release id before asset upload",
);
assert.doesNotMatch(
  createDraftReleaseBlock,
  /created_release_id="\$\(jq -er '\.id' "\$created_release"\)"\s+load_release/,
  "one immediate list read is not a safe substitute for bounded release visibility polling",
);

const releaseVisibilityFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-release-visibility-"),
);
try {
  const fixtureScript = path.join(releaseVisibilityFixtureRoot, "release-visibility.sh");
  const fixtureFunction = waitForCreatedReleaseFunction
    .split(/\r?\n/)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  await writeFile(
    fixtureScript,
    `#!/usr/bin/env bash
set -uo pipefail
${fixtureFunction}
release_json="$RUNNER_TEMP/release.json"
load_calls=0
sleep_calls=0
sleep() {
  sleep_calls=$((sleep_calls + 1))
}
load_release() {
  load_calls=$((load_calls + 1))
  case "$MOCK_MODE" in
    delayed)
      if [ "$load_calls" -lt 4 ]; then
        return 1
      fi
      printf '{"id":42}\n' > "$release_json"
      ;;
    mismatch)
      printf '{"id":99}\n' > "$release_json"
      ;;
    api-error)
      return 3
      ;;
    never)
      return 1
      ;;
    *)
      return 64
      ;;
  esac
}
fixture_status=0
wait_for_created_release 42 || fixture_status=$?
printf 'status=%s load_calls=%s sleep_calls=%s\n' \
  "$fixture_status" "$load_calls" "$sleep_calls"
`,
    "utf8",
  );
  await chmod(fixtureScript, 0o755);
  const runVisibilityFixture = (mode) =>
    execFileSync("bash", [fixtureScript], {
      cwd: releaseVisibilityFixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_MODE: mode,
        RUNNER_TEMP: releaseVisibilityFixtureRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.match(
    runVisibilityFixture("delayed"),
    /status=0 load_calls=4 sleep_calls=3/,
    "a newly created exact release id that appears after transient misses must converge by retry",
  );
  assert.match(
    runVisibilityFixture("mismatch"),
    /status=2 load_calls=1 sleep_calls=0/,
    "a different listed release id must fail immediately before any asset mutation",
  );
  assert.match(
    runVisibilityFixture("api-error"),
    /status=3 load_calls=1 sleep_calls=0/,
    "a release-list API or parse error must fail immediately without being retried as absence",
  );
  assert.match(
    runVisibilityFixture("never"),
    /status=1 load_calls=12 sleep_calls=11/,
    "release visibility that never converges must fail after a bounded number of reads",
  );
} finally {
  await rm(releaseVisibilityFixtureRoot, { recursive: true, force: true });
}
const firstReleaseMutation = githubReleaseReconciliationBlock.search(
  /github_api --method (?:POST|PATCH)|--request POST/,
);
const initialPolicyPreflight = githubReleaseReconciliationBlock.indexOf(
  'assert_immutable_release_policy "release-reconciliation"',
);
assert.ok(
  initialPolicyPreflight > -1 &&
    firstReleaseMutation > -1 &&
    initialPolicyPreflight < firstReleaseMutation,
  "owner-enforced immutable releases must be proven before any release or asset mutation",
);
assert.match(
  publicationTransitionBlock,
  /assert-safe-gh-release-verifier "\$GH_CLI_VERSION"[\s\S]*?github_release verify "\$TAG"[\s\S]*?github_release verify-asset/,
  "a CVE-2026-48501-safe GitHub CLI must be proven before either attestation command receives a token",
);
assert.match(
  publicationTransitionBlock,
  /github_api --method PATCH[\s\S]*?for immutability_attempt in \{1\.\.12\}[\s\S]*?load_release[\s\S]*?assert_loaded_release_identity "\$release_id" true[\s\S]*?\.immutable \| type[\s\S]*?verify_asset_bytes "\$asset_id" "final-release-asset"[\s\S]*?assert_live_release_ref[\s\S]*?github_release verify "\$TAG"[\s\S]*?github_release verify-asset "\$TAG" "artifacts\/\$PACKAGE_TARBALL"/,
  "the published release must be rediscovered, immutable, byte-verified by the same ids, and cryptographically attested",
);
assert.match(
  publishWorkflow,
  /uploads\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}\/assets\?name=\$\{encoded_asset_name\}/,
  "draft recovery must upload to the discovered release id",
);
assert.match(
  publishWorkflow,
  /repos\/\$\{GITHUB_REPOSITORY\}\/releases\/assets\/\$\{asset_id\}/,
  "release verification must download by immutable asset id",
);
assert.equal(
  (publishWorkflow.match(/node scripts\/release-policy\.mjs assert-github-latest/g) ?? []).length,
  2,
  "latest must remain monotonic against both the run-start and immediate pre-PATCH observations",
);
for (const forbiddenReleaseMutation of [
  /repos\/[^\n"']+\/releases\/tags\//,
  /gh release (?:create|upload|edit|download|delete)/,
  /--clobber/,
  /gh api --method DELETE/,
]) {
  assert.doesNotMatch(
    publishWorkflow,
    forbiddenReleaseMutation,
    "release recovery must use exact list/release/asset ids and never overwrite or delete existing data",
  );
}
assert.match(
  registryVerifier,
  /const NPM_REGISTRY_URL = "https:\/\/registry\.npmjs\.org"/,
  "registry verifier must keep its fixed npmjs.org origin",
);
const signatureAuditLockGenerator = await read("scripts/create-signature-audit-lock.mjs");
assert.match(
  signatureAuditLockGenerator,
  /source package identity does not match the protected release identity/,
  "signature-audit lock generator must bind source identity to the protected release identity",
);
assert.match(
  signatureAuditLockGenerator,
  /npm registry runtime dependencies do not match the protected source package/,
  "signature-audit lock generator must reject registry dependency substitution",
);
assert.match(
  signatureAuditLockGenerator,
  /dist\.integrity must be a sha512 SRI value/,
  "signature-audit lock generator must require the registry sha512 integrity value",
);
assert.match(
  signatureAuditLockGenerator,
  /dist\.tarball escaped the fixed HTTPS npmjs\.org origin/,
  "signature-audit lock generator must reject tarballs outside the fixed npmjs.org origin",
);
assert.match(
  signatureAuditLockGenerator,
  /published-package-runtime-contract\.json/,
  "signature-audit lock generator must emit the expected published runtime contract",
);

// npm v12 changed `npm view --json` to always return an array. The publish
// workflow asks for one exact package version, so its registry metadata must
// accept exactly one item and reject every other array shape.
const signatureAuditFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-signature-audit-lock-"),
);
try {
  const packageName = "@lcv-ideas-software/signature-audit-fixture";
  const packageVersion = "1.0.0";
  const sourcePackage = {
    name: packageName,
    version: packageVersion,
    dependencies: {},
  };
  const sourceLock = {
    name: packageName,
    version: packageVersion,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": sourcePackage,
    },
  };
  const registryMetadata = {
    name: packageName,
    version: packageVersion,
    dependencies: {},
    dist: {
      tarball:
        "https://registry.npmjs.org/@lcv-ideas-software/signature-audit-fixture/-/signature-audit-fixture-1.0.0.tgz",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    },
  };
  const sourcePackagePath = path.join(signatureAuditFixtureRoot, "package.json");
  const sourceLockPath = path.join(signatureAuditFixtureRoot, "package-lock.json");
  const registryMetadataPath = path.join(signatureAuditFixtureRoot, "registry-metadata.json");
  await Promise.all([
    writeFile(sourcePackagePath, `${JSON.stringify(sourcePackage)}\n`, "utf8"),
    writeFile(sourceLockPath, `${JSON.stringify(sourceLock)}\n`, "utf8"),
    writeFile(registryMetadataPath, `${JSON.stringify([registryMetadata])}\n`, "utf8"),
  ]);
  // mkdtemp guarantees a private directory; use its result as the generator
  // output so the fixture never writes into the repository.
  const generatedOutputDirectory = await mkdtemp(path.join(signatureAuditFixtureRoot, "out-"));
  const generatorArgs = [
    path.join(root, "scripts", "create-signature-audit-lock.mjs"),
    "--source-package-json",
    sourcePackagePath,
    "--source-package-lock",
    sourceLockPath,
    "--registry-metadata",
    registryMetadataPath,
    "--output-directory",
    generatedOutputDirectory,
    "--package-name",
    packageName,
    "--package-version",
    packageVersion,
  ];
  assert.doesNotThrow(
    () => execFileSync(process.execPath, generatorArgs, { stdio: "pipe" }),
    "signature-audit lock generation must accept npm v12's one-item JSON array",
  );
  const generatedLock = JSON.parse(
    await readFile(path.join(generatedOutputDirectory, "package-lock.json"), "utf8"),
  );
  assert.equal(
    generatedLock.packages[`node_modules/${packageName}`]?.version,
    packageVersion,
    "the lock generated from npm v12 metadata must pin the requested package version",
  );
  assert.equal(
    generatedLock.packages[`node_modules/${packageName}`]?.integrity,
    registryMetadata.dist.integrity,
    "the lock generated from npm v12 metadata must preserve the registry integrity pin",
  );
  for (const invalidNpmViewResponse of [
    [],
    [registryMetadata, registryMetadata],
    [null],
    [[registryMetadata]],
  ]) {
    await writeFile(registryMetadataPath, `${JSON.stringify(invalidNpmViewResponse)}\n`, "utf8");
    assert.throws(
      () => execFileSync(process.execPath, generatorArgs, { stdio: "pipe" }),
      (error) => {
        assert.match(String(error.stderr), /exactly one metadata object/);
        return true;
      },
      "signature-audit lock generation must reject every ambiguous npm view JSON array",
    );
  }
} finally {
  await rm(signatureAuditFixtureRoot, { recursive: true, force: true });
}
const publishedPackageRuntimeContractVerifier = await read(
  "scripts/verify-published-package-runtime-contract.mjs",
);
assert.match(
  publishedPackageRuntimeContractVerifier,
  /installed package identity does not match the protected release identity/,
  "published-package verifier must bind the installed artifact to the protected release identity",
);
assert.match(
  publishedPackageRuntimeContractVerifier,
  /installed package \$\{field\} does not match the protected source package/,
  "published-package verifier must reject a tarball whose runtime dependencies differ from source",
);
assert.match(
  publishWorkflow,
  /umask 077[\s\S]*chmod 600 "\$npmrc"/,
  "the temporary GitHub Packages credential file must be owner-readable only",
);

const cacheDisabledCount = (publishWorkflow.match(/package-manager-cache:\s*false/g) ?? []).length;
assert.equal(
  cacheDisabledCount,
  5,
  "all five release-pipeline jobs that use Node must explicitly disable package-manager caching",
);

for (const [workflow, label] of [
  [ciWorkflow, "ordinary CI"],
  [publishWorkflow, "release jobs"],
]) {
  assert.ok(
    workflow.includes(`NPM_CLI_VERSION: "${expectedNpmCliVersion}"`),
    `${label} must pin the audited npm CLI version exactly`,
  );
  assert.ok(
    workflow.includes(`NPM_CLI_SHA512: "${expectedNpmCliSha512}"`),
    `${label} must pin the audited npm tarball digest exactly`,
  );
}

assert.match(
  npmToolchainAction,
  /registry_url="https:\/\/registry\.npmjs\.org\/npm\/-\/npm-\$NPM_CLI_VERSION\.tgz"/,
  "the npm bootstrap must fetch only the exact-version official registry tarball",
);
assert.match(
  npmToolchainAction,
  /sha512sum --check --strict/,
  "the npm bootstrap must verify SHA-512 before extracting or executing the CLI",
);
assert.match(
  npmToolchainAction,
  /actual_version="\$\(node "\$npm_cli" --version\)"/,
  "the npm bootstrap must verify the extracted CLI version",
);
assert.doesNotMatch(
  npmToolchainAction,
  /npm[^\n]*install/,
  "the hash-verified npm bootstrap must not recursively invoke npm install",
);

const sameRepositoryToolchainAction = "$/.github/actions/setup-npm-toolchain";
const legacyWorkspaceToolchainAction = "./.github/actions/setup-npm-toolchain";
const maxWorkflowAliasCount = 100;

function workflowDiagnostic(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${code}${error?.message ?? String(error)}`;
}

function assertNoYamlMergeKeys(value, label, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (value instanceof Map) {
    assert.equal(value.has("<<"), false, `${label} must not use YAML merge keys`);
    for (const child of value.values()) assertNoYamlMergeKeys(child, label, seen);
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) assertNoYamlMergeKeys(child, label, seen);
  }
}

function parseWorkflowForToolchainAudit(workflow, label) {
  let document;
  try {
    document = parseDocument(workflow, {
      version: "1.2",
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      resolveKnownTags: false,
    });
  } catch (error) {
    assert.fail(`${label} must be valid YAML: ${workflowDiagnostic(error)}`);
  }

  const diagnostics = [...document.errors, ...document.warnings];
  assert.equal(
    diagnostics.length,
    0,
    `${label} must be valid, unambiguous YAML: ${diagnostics.map(workflowDiagnostic).join("; ")}`,
  );

  let parsed;
  try {
    parsed = document.toJS({ mapAsMap: true, maxAliasCount: maxWorkflowAliasCount });
  } catch (error) {
    assert.fail(`${label} must have bounded YAML aliases: ${workflowDiagnostic(error)}`);
  }

  assert.ok(parsed instanceof Map, `${label} must define a YAML mapping`);
  assertNoYamlMergeKeys(parsed, label);
  return parsed;
}

function inspectWorkflowToolchainSteps(workflow, label) {
  const parsed = parseWorkflowForToolchainAudit(workflow, label);
  const jobs = parsed.get("jobs");
  assert.ok(jobs instanceof Map, `${label} must define a jobs mapping`);

  const toolchainStepsByJob = new Map();
  for (const [jobId, job] of jobs) {
    assert.equal(typeof jobId, "string", `${label} job identifiers must be strings`);
    assert.ok(job instanceof Map, `${label} job ${jobId} must be a mapping`);

    const steps = job.get("steps");
    if (steps === undefined) {
      toolchainStepsByJob.set(jobId, []);
      continue;
    }
    assert.ok(Array.isArray(steps), `${label} job ${jobId} steps must be a sequence`);

    const toolchainSteps = [];
    for (const [index, step] of steps.entries()) {
      assert.ok(step instanceof Map, `${label} job ${jobId} step ${index} must be a mapping`);
      if (!step.has("uses")) continue;
      const uses = step.get("uses");
      assert.equal(
        typeof uses,
        "string",
        `${label} job ${jobId} step ${index} uses must be a string`,
      );
      assert.notEqual(
        uses,
        legacyWorkspaceToolchainAction,
        `${label} job ${jobId} step ${index} must not use the legacy workspace-relative toolchain action`,
      );
      if (uses === sameRepositoryToolchainAction) toolchainSteps.push(step);
    }
    toolchainStepsByJob.set(jobId, toolchainSteps);
  }
  return { parsed, jobs, toolchainStepsByJob };
}

function toolchainUseCountsByJob(workflow, label) {
  const { toolchainStepsByJob } = inspectWorkflowToolchainSteps(workflow, label);
  return new Map([...toolchainStepsByJob].map(([jobId, steps]) => [jobId, steps.length]));
}

function assertNoToolchainPinShadow(mapping, label) {
  if (mapping === undefined) return;
  assert.ok(mapping instanceof Map, `${label} env must be a mapping`);
  for (const pin of ["NPM_CLI_VERSION", "NPM_CLI_SHA512"]) {
    assert.equal(mapping.has(pin), false, `${label} must not shadow ${pin}`);
  }
}

function assertExactToolchainJobs(workflow, manifest, label) {
  const { parsed, jobs, toolchainStepsByJob } = inspectWorkflowToolchainSteps(workflow, label);
  const requiredJobIds = [...manifest.required];
  const exemptJobIds = [...manifest.exempt];
  const classifiedJobIds = [...requiredJobIds, ...exemptJobIds];
  assert.equal(
    new Set(classifiedJobIds).size,
    classifiedJobIds.length,
    `${label} job manifest must not contain duplicates or overlap`,
  );
  assert.deepEqual(
    [...jobs.keys()].sort(),
    classifiedJobIds.sort(),
    `${label} job manifest must classify every job as required or exempt`,
  );

  const workflowEnv = parsed.get("env");
  assert.ok(workflowEnv instanceof Map, `${label} must define a workflow env mapping`);
  assert.equal(
    workflowEnv.get("NPM_CLI_VERSION"),
    expectedNpmCliVersion,
    `${label} must pin the audited npm CLI version semantically`,
  );
  assert.equal(
    workflowEnv.get("NPM_CLI_SHA512"),
    expectedNpmCliSha512,
    `${label} must pin the audited npm CLI SHA-512 semantically`,
  );

  for (const jobId of requiredJobIds) {
    const job = jobs.get(jobId);
    const toolchainSteps = toolchainStepsByJob.get(jobId);
    assert.equal(
      toolchainSteps.length,
      1,
      `${label} job ${jobId} must activate the hash-verified npm v12 toolchain exactly once`,
    );
    assert.equal(job.has("if"), false, `${label} job ${jobId} must not be conditionally disabled`);
    assert.equal(
      job.has("continue-on-error"),
      false,
      `${label} job ${jobId} must not declare continue-on-error`,
    );
    assertNoToolchainPinShadow(job.get("env"), `${label} job ${jobId}`);

    const [toolchainStep] = toolchainSteps;
    assert.equal(
      toolchainStep.has("if"),
      false,
      `${label} job ${jobId} toolchain step must not be conditionally disabled`,
    );
    assert.equal(
      toolchainStep.has("continue-on-error"),
      false,
      `${label} job ${jobId} toolchain step must not declare continue-on-error`,
    );
    assertNoToolchainPinShadow(toolchainStep.get("env"), `${label} job ${jobId} toolchain step`);

    const inputs = toolchainStep.get("with");
    assert.ok(inputs instanceof Map, `${label} job ${jobId} toolchain step must define inputs`);
    assert.deepEqual(
      [...inputs.keys()].sort(),
      ["sha512", "version"],
      `${label} job ${jobId} toolchain step must define only the audited inputs`,
    );
    assert.equal(
      inputs.get("version"),
      "${{ env.NPM_CLI_VERSION }}",
      `${label} job ${jobId} toolchain version input must reference the workflow pin`,
    );
    assert.equal(
      inputs.get("sha512"),
      "${{ env.NPM_CLI_SHA512 }}",
      `${label} job ${jobId} toolchain SHA-512 input must reference the workflow pin`,
    );
  }

  for (const jobId of exemptJobIds) {
    assert.equal(
      toolchainStepsByJob.get(jobId).length,
      0,
      `${label} exempt job ${jobId} must not activate the npm toolchain`,
    );
  }
}

const semanticToolchainFixture = `jobs:
  block:
    steps:
      - uses: $/.github/actions/setup-npm-toolchain
  flow: { steps: [{ uses: "$/.github/actions/setup-npm-toolchain" }] }
  anchor-source:
    steps:
      - &toolchain-step
        uses: $/.github/actions/setup-npm-toolchain
  anchor-copy:
    steps:
      - *toolchain-step
  scalar-source:
    steps:
      - uses: &toolchain-ref $/.github/actions/setup-npm-toolchain
  scalar-copy:
    steps:
      - uses: *toolchain-ref
`;
assert.deepEqual(
  [...toolchainUseCountsByJob(semanticToolchainFixture, "semantic toolchain fixture")],
  [
    ["block", 1],
    ["flow", 1],
    ["anchor-source", 1],
    ["anchor-copy", 1],
    ["scalar-source", 1],
    ["scalar-copy", 1],
  ],
  "semantic YAML forms must resolve to the same exact toolchain step",
);

const nonStepToolchainFixture = `jobs:
  only:
    env:
      TOOLCHAIN: $/.github/actions/setup-npm-toolchain
    steps:
      - run: |
          uses: $/.github/actions/setup-npm-toolchain
      - uses: actions/example@0123456789abcdef0123456789abcdef01234567
        with:
          uses: $/.github/actions/setup-npm-toolchain
  reusable-like:
    uses: $/.github/actions/setup-npm-toolchain
`;
assert.deepEqual(
  [...toolchainUseCountsByJob(nonStepToolchainFixture, "non-step toolchain fixture")],
  [
    ["only", 0],
    ["reusable-like", 0],
  ],
  "toolchain-like values outside steps[*].uses must not count as action execution",
);

const redistributedToolchainFixture = `env:
  NPM_CLI_VERSION: "12.0.2"
  NPM_CLI_SHA512: "b885e890b9418fa1693544d05f53e64f9a73ec194837d4258b15fecdd692347b1dd2a517b1b0cbaf9d31cd8e92c3b70956bd2ecc72833a57b4b3098f5bfa7943"
jobs:
  first:
    steps:
      - uses: $/.github/actions/setup-npm-toolchain
        with:
          version: \${{ env.NPM_CLI_VERSION }}
          sha512: \${{ env.NPM_CLI_SHA512 }}
      - uses: $/.github/actions/setup-npm-toolchain
        with:
          version: \${{ env.NPM_CLI_VERSION }}
          sha512: \${{ env.NPM_CLI_SHA512 }}
  second:
    steps:
      - run: npm --version
`;
assert.throws(
  () =>
    assertExactToolchainJobs(
      redistributedToolchainFixture,
      { required: ["first", "second"], exempt: [] },
      "redistributed toolchain fixture",
    ),
  /job first must activate the hash-verified npm v12 toolchain exactly once/,
  "duplicating the toolchain in one job must not compensate for omitting it from another",
);

const invalidToolchainWorkflowFixtures = [
  {
    label: "duplicate uses key",
    workflow: `jobs:
  only:
    steps:
      - uses: $/.github/actions/setup-npm-toolchain
        uses: actions/example@0123456789abcdef0123456789abcdef01234567
`,
    expected: /DUPLICATE_KEY/,
  },
  {
    label: "custom YAML tag",
    workflow: `jobs: !unsupported
  only:
    steps: []
`,
    expected: /TAG_RESOLVE_FAILED/,
  },
  {
    label: "YAML merge key",
    workflow: `base: &base
  steps: []
jobs:
  only:
    <<: *base
`,
    expected: /must not use YAML merge keys/,
  },
  {
    label: "multiple YAML documents",
    workflow: `jobs: {}
---
jobs: {}
`,
    expected: /MULTIPLE_DOCS/,
  },
  {
    label: "non-mapping jobs",
    workflow: `jobs: []
`,
    expected: /must define a jobs mapping/,
  },
  {
    label: "non-sequence steps",
    workflow: `jobs:
  only:
    steps: {}
`,
    expected: /steps must be a sequence/,
  },
  {
    label: "non-mapping step",
    workflow: `jobs:
  only:
    steps:
      - not-a-step
`,
    expected: /step 0 must be a mapping/,
  },
  {
    label: "non-string step uses",
    workflow: `jobs:
  only:
    steps:
      - uses: 42
`,
    expected: /step 0 uses must be a string/,
  },
  {
    label: "excessive alias expansion",
    workflow: `base: &base [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
level1: &level1 [*base, *base, *base, *base, *base, *base, *base, *base, *base, *base]
level2: [*level1, *level1, *level1, *level1, *level1, *level1, *level1, *level1, *level1, *level1]
jobs: {}
`,
    expected: /Excessive alias count/,
  },
];
for (const { label, workflow, expected } of invalidToolchainWorkflowFixtures) {
  assert.throws(
    () => toolchainUseCountsByJob(workflow, `${label} fixture`),
    expected,
    `${label} must fail closed`,
  );
}

const publishToolchainManifest = {
  required: [
    "gate",
    "publish-npmjs",
    "verify-npmjs",
    "publish-gh-packages",
    "create-github-release",
  ],
  exempt: ["assert-npm-environment-boundary", "assert-npm-production-boundary"],
};
assertExactToolchainJobs(publishWorkflow, publishToolchainManifest, "release workflow");
assert.doesNotMatch(
  publishWorkflow,
  /npm[^\n]*install --global/,
  "release jobs must not bootstrap executable tooling through an unhashed npm install",
);
assert.equal(
  (publishWorkflow.match(/npm ci --strict-allow-scripts --no-audit --no-fund/g) ?? []).length,
  1,
  "release automation must install dependencies exactly once, inside the unprivileged source gate",
);
assert.match(
  npmGateJobBlock,
  /npm ci --strict-allow-scripts --no-audit --no-fund/,
  "the sole release dependency install must remain in the unprivileged source gate",
);
assert.doesNotMatch(
  publishWorkflow,
  /dangerously-allow-all-scripts/,
  "release automation must never bypass the npm install-script policy",
);

assert.match(
  ciWorkflow,
  /package-manager-cache:\s*false/,
  "ordinary CI must explicitly disable package-manager caching",
);
const ciToolchainManifest = {
  required: ["verify", "caller-token-acl-windows"],
  exempt: [],
};
assertExactToolchainJobs(ciWorkflow, ciToolchainManifest, "CI workflow");

function mutateWorkflowOnce(workflow, search, replacement, label) {
  assert.ok(workflow.includes(search), `${label} mutation must match its source fixture`);
  return workflow.replace(search, replacement);
}

const ciToolchainContractMutations = [
  {
    label: "unclassified job",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "jobs:\n  verify:",
      "jobs:\n  unclassified:\n    runs-on: ubuntu-latest\n    steps: []\n  verify:",
      "unclassified job",
    ),
    expected: /job manifest must classify every job/,
  },
  {
    label: "conditional toolchain step",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "      - name: Setup hash-verified npm v12 toolchain\n        uses:",
      "      - name: Setup hash-verified npm v12 toolchain\n        if: false\n        uses:",
      "conditional toolchain step",
    ),
    expected: /toolchain step must not be conditionally disabled/,
  },
  {
    label: "conditional required job",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "jobs:\n  verify:",
      "jobs:\n  verify:\n    if: false",
      "conditional required job",
    ),
    expected: /job verify must not be conditionally disabled/,
  },
  {
    label: "ignored toolchain failure",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "      - name: Setup hash-verified npm v12 toolchain\n        uses:",
      "      - name: Setup hash-verified npm v12 toolchain\n        continue-on-error: ${{ true }}\n        uses:",
      "ignored toolchain failure",
    ),
    expected: /toolchain step must not declare continue-on-error/,
  },
  {
    label: "shadowed toolchain pin",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "        uses: $/.github/actions/setup-npm-toolchain\n        with:",
      "        uses: $/.github/actions/setup-npm-toolchain\n        env:\n          NPM_CLI_VERSION: 11.0.0\n        with:",
      "shadowed toolchain pin",
    ),
    expected: /must not shadow NPM_CLI_VERSION/,
  },
  {
    label: "unbound toolchain input",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "          version: ${{ env.NPM_CLI_VERSION }}",
      '          version: "11.0.0"',
      "unbound toolchain input",
    ),
    expected: /version input must reference the workflow pin/,
  },
  {
    label: "quoted legacy toolchain action",
    workflow: mutateWorkflowOnce(
      ciWorkflow,
      "          sha512: ${{ env.NPM_CLI_SHA512 }}\n      - name: Verify npm v12 toolchain",
      '          sha512: ${{ env.NPM_CLI_SHA512 }}\n      - uses: "./.github/actions/setup-npm-toolchain"\n      - name: Verify npm v12 toolchain',
      "quoted legacy toolchain action",
    ),
    expected: /must not use the legacy workspace-relative toolchain action/,
  },
];
for (const { label, workflow, expected } of ciToolchainContractMutations) {
  assert.throws(
    () => assertExactToolchainJobs(workflow, ciToolchainManifest, `${label} fixture`),
    expected,
    `${label} must fail closed`,
  );
}
assert.doesNotMatch(
  ciWorkflow,
  /npm[^\n]*install --global/,
  "ordinary CI must not bootstrap executable tooling through an unhashed npm install",
);
assert.match(
  ciWorkflow,
  /Verify npm v12 toolchain[\s\S]*?ACTUAL_NPM_VERSION=.*npm[^\n]*--version[\s\S]*?ACTUAL_NPM_VERSION.*NPM_CLI_VERSION/,
  "ordinary CI must verify the npm executable version before dependency installation",
);
assert.match(
  ciWorkflow,
  /npm ci --strict-allow-scripts --no-audit --no-fund/,
  "ordinary CI must fail closed when an unreviewed dependency script appears",
);
assert.equal(
  (ciWorkflow.match(/STEPSECURITY_NPM_TOKEN/g) ?? []).length,
  0,
  "ordinary CI must not expose the removed private-registry credential",
);
assert.doesNotMatch(
  ciWorkflow,
  /dangerously-allow-all-scripts/,
  "ordinary CI must never bypass the npm install-script policy",
);
assert.match(
  ciWorkflow,
  /run npm-v12-release-security-regression/,
  "ordinary CI must run the workflow-policy regression before broader checks",
);

assert.match(
  autoTagWorkflow,
  /workflow_run:\s*[\s\S]*?workflows:\s*\[CI\][\s\S]*?types:\s*\[completed\][\s\S]*?branches:\s*\[main\]/,
  "auto-tag must wait for the CI workflow to complete on main",
);
assert.doesNotMatch(
  autoTagWorkflow,
  /^ {2}push:/m,
  "auto-tag must not race CI by triggering directly on a main push",
);
for (const prerequisite of [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  "github.event.workflow_run.head_repository.full_name == github.repository",
  `VERIFIED_SHA: \${{ github.event.workflow_run.head_sha }}`,
  'CHECKED_OUT_SHA="$(git rev-parse HEAD)"',
  "queue: max",
]) {
  assert.ok(
    autoTagWorkflow.includes(prerequisite),
    `auto-tag must enforce the verified workflow_run prerequisite: ${prerequisite}`,
  );
}
const privilegedCheckoutBlock = autoTagWorkflow.match(
  /- name: Checkout trusted main with full history[\s\S]*?(?=\n\s+- name: Setup Node\.js 24 for release-policy validation)/,
)?.[0];
assert.ok(privilegedCheckoutBlock, "auto-tag must retain an explicit trusted checkout step");
assert.match(
  privilegedCheckoutBlock,
  /ref:\s*refs\/heads\/main/,
  "the privileged workflow_run must checkout only the constant trusted main ref",
);
assert.doesNotMatch(
  privilegedCheckoutBlock,
  /github\.event\.workflow_run/,
  "the privileged checkout must never consume a workflow_run-controlled ref expression",
);
assert.match(
  autoTagWorkflow,
  /git cat-file -e "\$VERIFIED_SHA\^\{commit\}"[\s\S]*?git merge-base --is-ancestor "\$VERIFIED_SHA" "\$CHECKED_OUT_SHA"[\s\S]*?compare\/\$\{VERIFIED_SHA\}\.\.\.\$\{LIVE_MAIN_SHA\}[\s\S]*?git switch --detach "\$VERIFIED_SHA"/,
  "the exact successful workflow_run SHA must be validated as a trusted main ancestor before the working tree detaches to it",
);
const verifiedMainStep = workflowStepBlocks(autoTagWorkflow).find((step) =>
  step.includes(
    "- name: Verify checked out commit is the successful CI commit on live main history",
  ),
);
const detectVersionStep = workflowStepBlocks(autoTagWorkflow).find((step) =>
  step.includes("- name: Detect an actual package version change"),
);
const resolveReleaseTargetStep = workflowStepBlocks(autoTagWorkflow).find((step) =>
  step.includes("- name: Resolve immutable release target"),
);
const dispatchPublishStep = workflowStepBlocks(autoTagWorkflow).find((step) =>
  step.includes("- name: Dispatch publish workflow"),
);
const reconcileGitHubReleaseStep = workflowStepBlocks(publishWorkflow).find((step) =>
  step.includes("- name: Revalidate release tag identity before reconciling GitHub Release"),
);
assert.ok(verifiedMainStep, "auto-tag must retain its trusted-main verification step");
assert.ok(detectVersionStep, "auto-tag must retain its exact version-change detection step");
assert.ok(
  resolveReleaseTargetStep,
  "auto-tag must retain its immutable release-target reconciliation step",
);
assert.ok(dispatchPublishStep, "auto-tag must retain its protected-tag dispatch step");
assert.ok(reconcileGitHubReleaseStep, "publish must retain its GitHub Release reconciliation step");
const extractRunBody = (step) =>
  step
    .match(/run: \|\r?\n([\s\S]*)/)?.[1]
    ?.split(/\r?\n/)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
const verifiedMainRunBody = extractRunBody(verifiedMainStep);
const detectVersionRunBody = extractRunBody(detectVersionStep);
const resolveReleaseTargetRunBody = extractRunBody(resolveReleaseTargetStep);
const dispatchPublishRunBody = extractRunBody(dispatchPublishStep);
const reconcileGitHubReleaseRunBody = extractRunBody(reconcileGitHubReleaseStep);
assert.ok(verifiedMainRunBody, "trusted-main verification must retain executable shell");
assert.ok(detectVersionRunBody, "version-change detection must retain executable shell");
assert.ok(
  resolveReleaseTargetRunBody,
  "release-target reconciliation must retain executable shell",
);
assert.ok(dispatchPublishRunBody, "protected-tag dispatch must retain executable shell");
assert.ok(
  reconcileGitHubReleaseRunBody,
  "GitHub Release reconciliation must retain executable shell",
);
const extractTopLevelShellFunction = (runBody, functionName) => {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const functionSource = runBody.match(
    new RegExp(`^${escapedName}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"),
  )?.[0];
  assert.ok(functionSource, `workflow shell must retain ${functionName}()`);
  return functionSource;
};
const publishHttpStatusHelper = extractTopLevelShellFunction(
  reconcileGitHubReleaseRunBody,
  "github_api_error_is_exact_status",
);
const resolveApiRefToCommitFunction = extractTopLevelShellFunction(
  reconcileGitHubReleaseRunBody,
  "resolve_api_ref_to_commit",
);

// Two rapid version bumps are the adversarial workflow_run case: by the time
// CI for 4.5.26 is handled, trusted main may already contain 4.5.27. The
// checkout action must stay on a constant trusted ref, but every versioned read
// after ancestry validation must execute at the exact event SHA.
const rapidVersionFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-rapid-version-bumps-"),
);
try {
  const mockBin = path.join(rapidVersionFixtureRoot, "mock-bin");
  const scriptsDir = path.join(rapidVersionFixtureRoot, "scripts");
  const verificationScript = path.join(rapidVersionFixtureRoot, "verify-main.sh");
  const detectionScript = path.join(rapidVersionFixtureRoot, "detect-version.sh");
  const verificationOutput = path.join(rapidVersionFixtureRoot, "verified.out");
  const versionOutput = path.join(rapidVersionFixtureRoot, "version.out");
  await Promise.all([mkdir(mockBin, { recursive: true }), mkdir(scriptsDir, { recursive: true })]);
  await Promise.all([
    writeFile(verificationScript, `#!/usr/bin/env bash\n${verifiedMainRunBody}\n`, "utf8"),
    writeFile(detectionScript, `#!/usr/bin/env bash\n${detectVersionRunBody}\n`, "utf8"),
    writeFile(
      path.join(scriptsDir, "release-policy.mjs"),
      await read("scripts/release-policy.mjs"),
      "utf8",
    ),
    writeFile(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash
if [ "\${GH_TOKEN:-}" != "event-token" ] || [ -n "\${github_token:-}" ]; then
  printf '%s\n' 'unexpected token scope in gh fixture' >&2
  exit 65
fi
case "$*" in
  *git/ref/heads/main*) printf '%s\n' "$MOCK_LIVE_MAIN_SHA" ;;
  *compare/*...*) printf '%s\n' ahead ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 64 ;;
esac
`,
      "utf8",
    ),
  ]);
  await Promise.all([
    chmod(verificationScript, 0o755),
    chmod(detectionScript, 0o755),
    chmod(path.join(mockBin, "gh"), 0o755),
  ]);
  const rapidGit = (args) =>
    execFileSync("git", args, {
      cwd: rapidVersionFixtureRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  rapidGit(["init", "-b", "main"]);
  rapidGit(["config", "user.name", "Release Regression"]);
  rapidGit(["config", "user.email", "release-regression@example.invalid"]);
  const commitVersion = async (version) => {
    await writeFile(
      path.join(rapidVersionFixtureRoot, "package.json"),
      `${JSON.stringify({ name: "rapid-version-fixture", version }, null, 2)}\n`,
      "utf8",
    );
    rapidGit(["add", "package.json", "scripts/release-policy.mjs"]);
    rapidGit(["commit", "-m", `version ${version}`]);
    return rapidGit(["rev-parse", "HEAD"]);
  };
  await commitVersion("4.5.25");
  const eventSha = await commitVersion("4.5.26");
  const liveMainSha = await commitVersion("4.5.27");
  execFileSync("bash", [verificationScript], {
    cwd: rapidVersionFixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: "event-token",
      GITHUB_OUTPUT: verificationOutput,
      GITHUB_REPOSITORY: "LCV-Ideas-Software/cross-review-fixture",
      MOCK_LIVE_MAIN_SHA: liveMainSha,
      PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
      VERIFIED_SHA: eventSha,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    rapidGit(["rev-parse", "HEAD"]),
    eventSha,
    "after trust validation, auto-tag must detach to the exact workflow_run SHA",
  );
  execFileSync("bash", [detectionScript], {
    cwd: rapidVersionFixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: versionOutput,
      VERIFIED_SHA: eventSha,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rapidVersionOutput = await readFile(versionOutput, "utf8");
  for (const exactEventOutput of [
    "version=4.5.26",
    "tag=v04.05.26",
    `version_boundary_sha=${eventSha}`,
    `release_candidate_sha=${eventSha}`,
    "changed=true",
  ]) {
    assert.ok(
      rapidVersionOutput.split(/\r?\n/).includes(exactEventOutput),
      `two rapid bumps must still process the event commit exactly: ${exactEventOutput}`,
    );
  }
} finally {
  await rm(rapidVersionFixtureRoot, { recursive: true, force: true });
}

// A canonical tag is immutable, so later successful main runs must not keep
// dispatching the same already-published tag forever. Only a completed,
// successful Publish run with the exact workflow path, tag/ref, head SHA, and
// repository is sufficient evidence to suppress recovery. Near-miss successes
// must not count, and an exact failed run must remain recoverable.
const canonicalPublishFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-canonical-publish-"),
);
try {
  const mockBin = path.join(canonicalPublishFixtureRoot, "mock-bin");
  const reconciliationScript = path.join(canonicalPublishFixtureRoot, "resolve-release.sh");
  const targetSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const otherSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const repository = "LCV-Ideas-Software/cross-review-fixture";
  const tag = "v09.08.07";
  const legacyTag = "v9.8.7";
  const packageName = "@lcv-ideas-software/cross-review-fixture";
  const packageVersion = "9.8.7";
  const expectedAssetName = "lcv-ideas-software-cross-review-fixture-9.8.7.tgz";
  const validAssetDigest = `sha256:${"c".repeat(64)}`;
  const exactRun = {
    id: 101,
    path: ".github/workflows/publish.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: tag,
    head_sha: targetSha,
    head_repository: { full_name: repository },
    repository: { full_name: repository },
  };
  const exactDurableRelease = {
    tag_name: tag,
    target_commitish: targetSha,
    draft: false,
    immutable: true,
    assets: [
      {
        name: expectedAssetName,
        state: "uploaded",
        digest: validAssetDigest,
      },
    ],
  };
  const nearMissSuccesses = [
    { ...exactRun, id: 102, path: ".github/workflows/not-publish.yml" },
    { ...exactRun, id: 103, head_branch: "v09.08.06" },
    { ...exactRun, id: 104, head_sha: otherSha },
    {
      ...exactRun,
      id: 105,
      head_repository: { full_name: "LCV-Ideas-Software/not-cross-review" },
    },
    {
      ...exactRun,
      id: 107,
      repository: { full_name: "LCV-Ideas-Software/not-cross-review" },
    },
  ];
  await mkdir(mockBin, { recursive: true });
  await Promise.all([
    writeFile(
      reconciliationScript,
      `#!/usr/bin/env bash\n${resolveReleaseTargetRunBody}\n`,
      "utf8",
    ),
    writeFile(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash
if [ "\${GH_TOKEN:-}" != "fixture-token" ]; then
  printf '%s\n' 'unexpected token scope in canonical Publish fixture' >&2
  exit 65
fi
arguments="$*"
if [[ "$arguments" == *"git/ref/tags/$MOCK_TAG"* ]]; then
  printf '{"object":{"type":"commit","sha":"%s"}}\n' "$MOCK_TARGET_SHA"
elif [[ "$arguments" == *"git/ref/tags/$MOCK_LEGACY_TAG"* ]]; then
  case "$MOCK_LEGACY_STATUS" in
    404) printf '%s\n' 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
    503-with-404)
      printf '%s\n' 'gh: Service Unavailable; upstream diagnostic mentioned HTTP 404 (HTTP 503)' >&2
      exit 1
      ;;
    *) printf 'gh: fixture API failure (HTTP %s)\n' "$MOCK_LEGACY_STATUS" >&2; exit 1 ;;
  esac
elif [[ "$arguments" == *"/compare/"* ]]; then
  printf '%s\n' identical
elif [[ "$arguments" == *"/contents/package.json"* ]]; then
  printf '%s\n' "$MOCK_PACKAGE_BASE64"
elif [[ "$arguments" == *"/actions/runs"* ]]; then
  if [[ "$arguments" != *"--paginate"* ]] || [[ "$arguments" != *"--slurp"* ]]; then
    printf '%s\n' 'Publish evidence query must be paginated and slurped' >&2
    exit 66
  fi
  printf '%s\n' "$MOCK_RUN_PAGES"
elif [[ "$arguments" == *"/releases/tags/$MOCK_TAG"* ]]; then
  case "$MOCK_RELEASE_STATUS" in
    200) printf '%s\n' "$MOCK_RELEASE_JSON" ;;
    404) printf '%s\n' 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
    503-with-404)
      printf '%s\n' 'gh: Service Unavailable; upstream diagnostic mentioned HTTP 404 (HTTP 503)' >&2
      exit 1
      ;;
    *) printf 'gh: fixture API failure (HTTP %s)\n' "$MOCK_RELEASE_STATUS" >&2; exit 1 ;;
  esac
else
  printf 'unexpected gh invocation: %s\n' "$arguments" >&2
  exit 64
fi
`,
      "utf8",
    ),
  ]);
  await Promise.all([chmod(reconciliationScript, 0o755), chmod(path.join(mockBin, "gh"), 0o755)]);
  const executeReconciliation = async (
    name,
    workflowRuns,
    { legacyStatus = 404, release = null, releaseStatus = 500 } = {},
  ) => {
    const output = path.join(canonicalPublishFixtureRoot, `${name}.out`);
    execFileSync("bash", [reconciliationScript], {
      cwd: canonicalPublishFixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: "fixture-token",
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: name,
        LEGACY_TAG: legacyTag,
        MOCK_LEGACY_TAG: legacyTag,
        MOCK_LEGACY_STATUS: String(legacyStatus),
        MOCK_PACKAGE_BASE64: Buffer.from(
          `${JSON.stringify({ name: packageName, version: packageVersion })}\n`,
        ).toString("base64"),
        MOCK_RELEASE_JSON: JSON.stringify(release),
        MOCK_RELEASE_STATUS: String(releaseStatus),
        MOCK_RUN_PAGES: JSON.stringify([{ workflow_runs: workflowRuns }]),
        MOCK_TAG: tag,
        MOCK_TARGET_SHA: targetSha,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RELEASE_CANDIDATE_SHA: targetSha,
        RUNNER_TEMP: ".",
        TAG: tag,
        VERSION: packageVersion,
        VERSION_BOUNDARY_SHA: targetSha,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (await readFile(output, "utf8")).split(/\r?\n/).filter(Boolean);
  };
  const alreadyPublishedOutput = await executeReconciliation("success", [
    ...nearMissSuccesses,
    exactRun,
  ]);
  const unpublishedRuns = [...nearMissSuccesses, { ...exactRun, id: 106, conclusion: "failure" }];
  const recoveryOutput = await executeReconciliation("absence", unpublishedRuns, {
    releaseStatus: 404,
  });
  const durableReleaseOutput = await executeReconciliation(
    "expired-run-durable-release",
    nearMissSuccesses,
    {
      release: exactDurableRelease,
      releaseStatus: 200,
    },
  );
  const releaseNearMisses = {
    tag: { ...exactDurableRelease, tag_name: "v09.08.06" },
    target: { ...exactDurableRelease, target_commitish: otherSha },
    asset: {
      ...exactDurableRelease,
      assets: [{ ...exactDurableRelease.assets[0], name: "wrong-package-9.8.7.tgz" }],
    },
    digest: {
      ...exactDurableRelease,
      assets: [{ ...exactDurableRelease.assets[0], digest: "sha256:not-a-valid-digest" }],
    },
    state: {
      ...exactDurableRelease,
      assets: [{ ...exactDurableRelease.assets[0], state: "new" }],
    },
    "zero-assets": { ...exactDurableRelease, assets: [] },
    "extra-asset": {
      ...exactDurableRelease,
      assets: [
        exactDurableRelease.assets[0],
        {
          name: "unexpected-provenance.json",
          state: "uploaded",
          digest: `sha256:${"d".repeat(64)}`,
        },
      ],
    },
    mutable: { ...exactDurableRelease, immutable: false },
    draft: { ...exactDurableRelease, draft: true },
  };
  const nearMissOutputs = await Promise.all(
    Object.entries(releaseNearMisses).map(async ([name, release]) => [
      name,
      await executeReconciliation(`release-near-miss-${name}`, unpublishedRuns, {
        release,
        releaseStatus: 200,
      }),
    ]),
  );
  await assert.rejects(
    executeReconciliation("tag-api-error-mentions-404", unpublishedRuns, {
      legacyStatus: "503-with-404",
    }),
    /Command failed/,
    "a non-404 tag-ref API failure must remain blocking when its diagnostics mention HTTP 404",
  );
  await assert.rejects(
    executeReconciliation("release-api-error", unpublishedRuns, {
      releaseStatus: 503,
    }),
    /Command failed/,
    "a non-404 GitHub Release API failure must fail closed instead of redispatching blindly",
  );
  await assert.rejects(
    executeReconciliation("release-api-error-mentions-404", unpublishedRuns, {
      releaseStatus: "503-with-404",
    }),
    /Command failed/,
    "a non-404 API failure must remain blocking even when its diagnostics mention HTTP 404",
  );
  assert.ok(
    alreadyPublishedOutput.includes("should_dispatch=false"),
    "an exact successful historical Publish run must suppress another dispatch of the immutable tag",
  );
  assert.ok(
    recoveryOutput.includes("should_dispatch=true"),
    "without an exact successful historical Publish run, recovery must remain enabled",
  );
  assert.ok(
    durableReleaseOutput.includes("should_dispatch=false"),
    "an exact durable immutable GitHub Release must suppress redispatch after workflow runs expire",
  );
  for (const [name, output] of nearMissOutputs) {
    assert.ok(
      output.includes("should_dispatch=true"),
      `a ${name} GitHub Release near miss must keep publication recovery enabled`,
    );
  }
} finally {
  await rm(canonicalPublishFixtureRoot, { recursive: true, force: true });
}

// GitHub API absence checks must use the terminal status emitted by `gh api`,
// never a free-text `HTTP 404` substring that may appear inside a 5xx
// diagnostic. Exercise every call site that tolerates a real 404.
const githubHttpStatusFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "cross-review-github-http-status-"),
);
try {
  const mockBin = path.join(githubHttpStatusFixtureRoot, "mock-bin");
  const dispatchScript = path.join(githubHttpStatusFixtureRoot, "dispatch-publish.sh");
  const reconcileReleaseScript = path.join(
    githubHttpStatusFixtureRoot,
    "reconcile-github-release.sh",
  );
  const resolveRefScript = path.join(githubHttpStatusFixtureRoot, "resolve-api-ref.sh");
  const sleepLog = path.join(githubHttpStatusFixtureRoot, "sleep.log");
  const workflowLog = path.join(githubHttpStatusFixtureRoot, "workflow.log");
  const refStatusFile = path.join(githubHttpStatusFixtureRoot, "ref-status.txt");
  const targetSha = "dddddddddddddddddddddddddddddddddddddddd";
  const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const repository = "LCV-Ideas-Software/cross-review-fixture";
  const tag = "v09.08.07";
  await mkdir(mockBin, { recursive: true });
  await Promise.all([
    writeFile(dispatchScript, `#!/usr/bin/env bash\n${dispatchPublishRunBody}\n`, "utf8"),
    writeFile(
      reconcileReleaseScript,
      `#!/usr/bin/env bash\n${reconcileGitHubReleaseRunBody}\n`,
      "utf8",
    ),
    writeFile(
      resolveRefScript,
      `#!/usr/bin/env bash
set -u
github_api() {
  printf '%s\n' 'gh: Service Unavailable; upstream diagnostic mentioned HTTP 404 (HTTP 503)' >&2
  return 1
}
${publishHttpStatusHelper}
${resolveApiRefToCommitFunction}
set +e
resolve_api_ref_to_commit "tags/$MOCK_TAG" >/dev/null
ref_status=$?
set -e
printf '%s\n' "$ref_status" >"$MOCK_REF_STATUS_FILE"
`,
      "utf8",
    ),
    writeFile(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash
arguments="$*"
case "$MOCK_GH_MODE" in
  dispatch)
    if [ "$1" = "api" ]; then
      printf '%s\n' 'gh: Service Unavailable; upstream diagnostic mentioned HTTP 404 (HTTP 503)' >&2
      exit 1
    fi
    if [ "$1" = "workflow" ]; then
      printf '%s\n' "$arguments" >>"$MOCK_WORKFLOW_LOG"
      exit 0
    fi
    ;;
  latest)
    if [[ "$arguments" == *"git/ref/tags/$MOCK_TAG"* ]]; then
      printf '{"object":{"type":"commit","sha":"%s"}}\n' "$MOCK_TARGET_SHA"
      exit 0
    fi
    if [[ "$arguments" == *"git/ref/heads/main"* ]]; then
      printf '{"object":{"type":"commit","sha":"%s"}}\n' "$MOCK_TARGET_SHA"
      exit 0
    fi
    if [[ "$arguments" == *"/compare/"* ]]; then
      printf '%s\n' identical
      exit 0
    fi
    if [[ "$arguments" == *"/releases/latest"* ]]; then
      printf '%s\n' 'gh: Service Unavailable; upstream diagnostic mentioned HTTP 404 (HTTP 503)' >&2
      exit 1
    fi
    ;;
esac
printf 'gh: unexpected fixture invocation: %s (HTTP 500)\n' "$arguments" >&2
exit 1
`,
      "utf8",
    ),
    writeFile(
      path.join(mockBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  printf '%s\n' "$MOCK_TARGET_SHA"
  exit 0
fi
printf '%s\n' 'unexpected git fixture invocation' >&2
exit 1
`,
      "utf8",
    ),
    writeFile(
      path.join(mockBin, "sleep"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_SLEEP_LOG"
`,
      "utf8",
    ),
    writeFile(sleepLog, "", "utf8"),
    writeFile(workflowLog, "", "utf8"),
  ]);
  await Promise.all(
    [
      dispatchScript,
      reconcileReleaseScript,
      resolveRefScript,
      path.join(mockBin, "gh"),
      path.join(mockBin, "git"),
      path.join(mockBin, "sleep"),
    ].map((file) => chmod(file, 0o755)),
  );

  const expectShellFailure = (
    script,
    env,
    { cwd = githubHttpStatusFixtureRoot, runnerTemp = "." } = {},
  ) => {
    let failure;
    try {
      execFileSync("bash", [script], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
          RUNNER_TEMP: runnerTemp,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${path.basename(script)} must fail closed`);
    return `${String(failure.stdout ?? "")}${String(failure.stderr ?? "")}`;
  };

  const dispatchError = expectShellFailure(dispatchScript, {
    GH_TOKEN: "fixture-token",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: "dispatch-503-with-404",
    MOCK_GH_MODE: "dispatch",
    MOCK_SLEEP_LOG: "sleep.log",
    MOCK_WORKFLOW_LOG: "workflow.log",
    TAG: tag,
    TARGET_SHA: targetSha,
  });
  assert.match(
    dispatchError,
    /Could not safely resolve tag .* before dispatch/,
    "tag visibility must reject a 503 whose diagnostic mentions HTTP 404",
  );
  assert.equal(
    await readFile(sleepLog, "utf8"),
    "",
    "a non-404 tag-visibility failure must not be retried as eventual 404 propagation",
  );
  assert.equal(
    await readFile(workflowLog, "utf8"),
    "",
    "a non-404 tag-visibility failure must never dispatch Publish",
  );

  const latestError = expectShellFailure(
    reconcileReleaseScript,
    {
      GH_TOKEN: "fixture-token",
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "latest-503-with-404",
      IMMUTABILITY_TOKEN: "fixture-immutability-token",
      MOCK_GH_MODE: "latest",
      MOCK_TAG: tag,
      MOCK_TARGET_SHA: checkedOutSha,
      PACKAGE_SHA256: "e".repeat(64),
      PACKAGE_TARBALL: "cross-review-fixture-9.8.7.tgz",
      PACKAGE_VERSION: "9.8.7",
      PRERELEASE: "false",
      PUBLISH_EVENT_REF: `refs/tags/${tag}`,
      PUBLISH_REF_PROTECTED: "true",
      PUBLISH_REF_TYPE: "tag",
      TAG: tag,
      VERIFIED_SHA: checkedOutSha,
    },
    {
      cwd: root,
      runnerTemp: githubHttpStatusFixtureRoot.replaceAll("\\", "/"),
    },
  );
  assert.match(
    latestError,
    /Could not determine the current GitHub latest release/,
    "latest-release discovery must reject a 503 whose diagnostic mentions HTTP 404",
  );

  execFileSync("bash", [resolveRefScript], {
    cwd: githubHttpStatusFixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "ref-503-with-404",
      MOCK_REF_STATUS_FILE: "ref-status.txt",
      MOCK_TAG: tag,
      RUNNER_TEMP: ".",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    await readFile(refStatusFile, "utf8"),
    "1\n",
    "ref resolution must classify a 503 mentioning HTTP 404 as a blocking API failure, not absence",
  );
} finally {
  await rm(githubHttpStatusFixtureRoot, { recursive: true, force: true });
}

for (const codeScanningGate of [
  "security-events: read",
  "Wait for exact CodeQL analyses and require zero results",
  'github_run list --repo "$GITHUB_REPOSITORY" --workflow codeql.yml --commit "$TARGET_SHA"',
  "code-scanning/analyses?per_page=100",
  "--paginate --slurp",
  "Accept: application/sarif+json",
  'result_count="$(jq \'[.runs[]?.results[]?] | length\' "$sarif_file")"',
]) {
  assert.ok(
    autoTagWorkflow.includes(codeScanningGate),
    `auto-tag must block publication until exact historical CodeQL SARIF is clean: ${codeScanningGate}`,
  );
}
assert.doesNotMatch(
  autoTagWorkflow,
  /git ls-remote|git fetch --no-tags origin/,
  "auto-tag must not depend on unauthenticated Git transport after persist-credentials is disabled",
);
const codeScanningGateBlock = autoTagWorkflow.match(
  /- name: Wait for exact CodeQL analyses and require zero results[\s\S]*?(?=\n\s+- name: Require triggered Dependabot updates to pass)/,
)?.[0];
assert.ok(codeScanningGateBlock, "auto-tag must retain an explicit code-scanning gate step");
const configuredCodeqlLanguages = [
  ...codeqlWorkflow.matchAll(/^\s+- language:\s*([^\s]+)\s*$/gm),
].map((match) => match[1]);
assert.deepEqual(
  configuredCodeqlLanguages,
  ["actions", "javascript-typescript", "python"],
  "the CodeQL release-category contract must exactly match the committed analysis matrix",
);
for (const [gate, label] of [
  [codeScanningGateBlock, "auto-tag"],
  [publishPrerequisiteGateBlock, "publish"],
]) {
  assert.ok(
    gate.includes(
      'required_codeql_categories=("/language:actions" "/language:javascript-typescript" "/language:python")',
    ),
    `${label} must require every category configured by the CodeQL matrix`,
  );
  assert.match(
    gate,
    /done < <\(jq -r '\[\.\[\] \| \.category\] \| unique\[\]'[^\n]*\)/,
    `${label} must inspect SARIF for every exact-SHA CodeQL category, including future additions`,
  );
  assert.match(
    gate,
    /select\(\(\.category \/\/ ""\) == ""\)/,
    `${label} must fail closed when an exact-SHA CodeQL analysis omits its category`,
  );
}
assert.match(
  codeScanningGateBlock,
  /\.commit_sha == \$sha and \.tool\.name == "CodeQL"/,
  "auto-tag must filter immutable analysis objects by exact target SHA and tool",
);
assert.doesNotMatch(
  codeScanningGateBlock,
  /code-scanning\/alerts\?state=open/,
  "auto-tag must not use current-main alert state as historical target evidence",
);
assert.doesNotMatch(
  `${autoTagWorkflow}\n${publishWorkflow}`,
  /actions\/runs\/[^\s"']+\/rerun|rerun-failed-jobs/,
  "failed or cancelled historical checks must remain blocking rather than cross-cancelling current gates",
);
const dependabotGateBlock = autoTagWorkflow.match(
  /- name: Require triggered Dependabot updates to pass[\s\S]*?(?=\n\s+- name: Create tag through the GitHub API)/,
)?.[0];
assert.ok(dependabotGateBlock, "auto-tag must retain an explicit Dependabot update gate step");
assert.match(
  dependabotGateBlock,
  /require-dependabot-release-evidence\.sh require "\$TARGET_SHA" "\$VERSION_BOUNDARY_SHA"/,
  "the Dependabot gate must bind managed evidence to the immutable target and its version boundary",
);
assert.match(
  autoTagWorkflow,
  /- name: Detect an actual package version change[\s\S]*?VERSION_BOUNDARY_SHA[\s\S]*?release_candidate_sha=\$VERIFIED_SHA[\s\S]*?changed=false/,
  "auto-tag must retain both actual-bump evidence and a recoverable immutable version-epoch boundary",
);
const tagCheckBlock = autoTagWorkflow.match(
  /- name: Resolve immutable release target[\s\S]*?(?=\n\s+- name: Wait for exact CodeQL analyses)/,
)?.[0];
assert.ok(tagCheckBlock, "auto-tag must retain an explicit existing-tag reconciliation step");
for (const targetRecoveryContract of [
  "git/ref/tags/$tag",
  "git/tags/$object_sha",
  `compare/\${ancestor}...\${descendant}`,
  'target_sha="$RELEASE_CANDIDATE_SHA"',
  "releases?per_page=100",
  "[.[][] | select(.tag_name == $tag)] | length",
  "contents/package.json",
  "VERSION_BOUNDARY_SHA",
]) {
  assert.ok(
    tagCheckBlock.includes(targetRecoveryContract),
    `release target recovery must remain authenticated, immutable, and fail closed: ${targetRecoveryContract}`,
  );
}
for (const publishEvidenceContract of [
  'publish_workflow_path=".github/workflows/publish.yml"',
  "actions/runs?head_sha=$target_sha&event=workflow_dispatch&per_page=100",
  "--paginate --slurp",
  ".path == $workflow_path",
  ".head_branch == $tag",
  ".head_sha == $sha",
  ".head_repository.full_name == $repo",
  ".repository.full_name == $repo",
  '.event == "workflow_dispatch"',
  '.status == "completed"',
  '.conclusion == "success"',
  "should_dispatch=false",
]) {
  assert.ok(
    tagCheckBlock.includes(publishEvidenceContract),
    `canonical-tag reconciliation must use exact successful Publish evidence: ${publishEvidenceContract}`,
  );
}
assert.match(
  tagCheckBlock,
  /if \[ -n "\$canonical_sha" \]; then[\s\S]*?actions\/runs\?head_sha=\$target_sha[\s\S]*?if \[ "\$successful_publish_count" -gt 0 \]; then[\s\S]*?should_dispatch=false[\s\S]*?else[\s\S]*?should_dispatch=true/,
  "only a canonical tag with exact successful Publish evidence may suppress redispatch",
);
assert.match(
  tagCheckBlock,
  /if \[ -z "\$target_sha" \]; then[\s\S]*?--paginate --slurp[\s\S]*?releases\?per_page=100[\s\S]*?release_count/,
  "auto-tag must still discover tagless draft release identities through the paginated list endpoint",
);
for (const durableReleaseContract of [
  "releases/tags/$TAG",
  "expected_asset_name",
  ".tag_name == $tag",
  ".target_commitish == $sha",
  ".draft == false",
  ".immutable == true",
  '(.assets | type) == "array"',
  "(.assets | length) == 1",
  ".assets[0].name == $asset",
  '.assets[0].state == "uploaded"',
  'test("^sha256:[0-9a-f]{64}$")',
  "durable_release_evidence",
  'github_api_error_is_exact_status "$release_error" 404',
]) {
  assert.ok(
    tagCheckBlock.includes(durableReleaseContract),
    `expired workflow runs require exact durable GitHub Release evidence: ${durableReleaseContract}`,
  );
}
assert.match(
  tagCheckBlock,
  /if \[ "\$successful_publish_count" -eq 0 \]; then[\s\S]*?releases\/tags\/\$TAG[\s\S]*?elif \[ "\$durable_release_evidence" = "true" \]; then[\s\S]*?should_dispatch=false/,
  "durable release evidence may suppress recovery only when no exact successful Publish run remains",
);
assert.match(
  tagCheckBlock,
  /if github_api_error_is_exact_status "\$release_error" 404; then[\s\S]*?else[\s\S]*?cat "\$release_error" >&2[\s\S]*?exit "\$release_status"/,
  "only a 404 may represent an absent Release; other API failures must fail closed",
);
assert.doesNotMatch(
  tagCheckBlock,
  /grep[^\n]*HTTP 404/,
  "release-target GitHub API errors must never use free-text HTTP 404 matching",
);
assert.match(
  tagCheckBlock,
  /if github_api_error_is_exact_status "\$ref_error" 404; then[\s\S]*?return 2/,
  "remote-tag discovery must use exact terminal HTTP status classification",
);
assert.match(
  reconcileGitHubReleaseRunBody,
  /if github_api_error_is_exact_status "\$latest_error" 404; then/,
  "GitHub latest discovery must use exact terminal HTTP status classification",
);
assert.match(
  reconcileGitHubReleaseRunBody,
  /if github_api_error_is_exact_status "\$ref_error" 404; then/,
  "Git reference discovery must use exact terminal HTTP status classification",
);
assert.doesNotMatch(
  reconcileGitHubReleaseRunBody,
  /grep[^\n]*HTTP 404/,
  "GitHub Release reconciliation must never use free-text HTTP 404 matching",
);
const createTagBlock = autoTagWorkflow.match(
  /- name: Create tag through the GitHub API[\s\S]*?(?=\n\s+- name: Dispatch publish workflow)/,
)?.[0];
assert.ok(createTagBlock, "auto-tag must retain an explicit tag-creation step");
assert.ok(
  createTagBlock.indexOf("git/ref/heads/main") <
    createTagBlock.search(/github_api --method POST "repos\/\$GITHUB_REPOSITORY\/git\/refs"/),
  "auto-tag must revalidate authenticated live-main ancestry immediately before creating the tag",
);
assert.match(
  createTagBlock,
  /-f ref="refs\/tags\/\$\{TAG\}"[\s\S]*?-f sha="\$TARGET_SHA"/,
  "auto-tag must atomically create the tag ref at the fully verified target through GitHub's API",
);
assert.match(
  createTagBlock,
  /Tag creation failed and \$\{TAG\} resolves to \$\{existing_sha:-missing\}, not \$TARGET_SHA/,
  "a concurrent tag creation may be accepted only when it resolves to the exact target SHA",
);
const dispatchPublishBlock = autoTagWorkflow.match(
  /- name: Dispatch publish workflow[\s\S]*?(?=\n\s+timeout-minutes:)/,
)?.[0];
assert.ok(dispatchPublishBlock, "auto-tag must retain explicit publish redispatch");
assert.match(
  dispatchPublishBlock,
  /elif ! github_api_error_is_exact_status "\$ref_error" 404; then/,
  "tag visibility must use exact terminal HTTP status classification",
);
assert.doesNotMatch(
  dispatchPublishBlock,
  /grep[^\n]*HTTP 404/,
  "tag visibility must never use free-text HTTP 404 matching",
);
assert.doesNotMatch(
  dispatchPublishBlock,
  /steps\.version-change\.outputs\.changed == 'true'/,
  "publish redispatch must recover a valid existing version tag after later non-bump main advances",
);
assert.doesNotMatch(
  dispatchPublishBlock,
  /steps\.check\.outputs\.exists/,
  "a valid existing canonical tag without exact success evidence must remain eligible for recovery",
);
assert.match(
  autoTagWorkflow,
  /github_workflow run publish\.yml(?: --repo "\$GITHUB_REPOSITORY")? --ref "\$\{TAG\}"/,
  "auto-tag must dispatch publish.yml on the tag ref because GITHUB_TOKEN tag pushes do not trigger a second workflow",
);
assert.doesNotMatch(
  autoTagWorkflow,
  /github_workflow run publish\.yml[^\n]*\s-f\s+tag=/,
  "auto-tag must not supply a second tag input that could diverge from the dispatch ref",
);
assert.ok(
  (autoTagWorkflow.match(/steps\.check\.outputs\.should_dispatch == 'true'/g) ?? []).length >= 4,
  "all security, tag, and dispatch work must require a resolved immutable target",
);

for (const policy of ["strict-allow-scripts=true", "allow-git=none", "allow-remote=none"]) {
  assert.match(npmrc, new RegExp(`^${policy}$`, "m"), `.npmrc must enforce ${policy}`);
}
assert.doesNotMatch(
  npmrc,
  /dangerously-allow-all-scripts\s*=\s*true/,
  ".npmrc must never bypass dependency-script review",
);

assert.match(
  registryVerifier,
  /dist\.attestations/,
  "post-publish verification must inspect registry attestation metadata",
);
assert.match(
  registryVerifier,
  /https:\/\/slsa\.dev\/provenance\/v1/,
  "post-publish verification must require SLSA provenance v1",
);
for (const provenanceContract of [
  "EXPECTED_GIT_SHA",
  "EXPECTED_GIT_TAG",
  "EXPECTED_GIT_REPOSITORY",
  "EXPECTED_GITHUB_WORKFLOW_PATH",
  "predicate?.buildDefinition?.externalParameters?.workflow",
  "resolvedDependencies?.some",
  "dependency?.digest?.gitCommit === expectedGitSha",
]) {
  assert.ok(
    registryVerifier.includes(provenanceContract),
    `registry verifier must bind provenance to the expected release identity: ${provenanceContract}`,
  );
}
for (const workflowProvenanceEnv of [
  "EXPECTED_GIT_SHA: $" + "{{ needs.gate.outputs.sha }}",
  "EXPECTED_GIT_TAG: refs/tags/$" + "{{ needs.gate.outputs.tag }}",
  "EXPECTED_GIT_REPOSITORY: https://github.com/LCV-Ideas-Software/cross-review",
  "EXPECTED_GITHUB_WORKFLOW_PATH: .github/workflows/publish.yml",
]) {
  assert.ok(
    publishWorkflow.includes(workflowProvenanceEnv),
    `publish workflow must provide registry provenance verifier input: ${workflowProvenanceEnv}`,
  );
}

// npm publishes package metadata and its provenance document through separate
// registry surfaces. A newly visible version can therefore advertise an
// attestation URL briefly returning 404. The verifier must retry that bounded
// propagation window without weakening any provenance assertion.
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalPackageName = globalThis.process.env.PACKAGE_NAME;
const originalPackageVersion = globalThis.process.env.PACKAGE_VERSION;
const originalExpectedGitSha = globalThis.process.env.EXPECTED_GIT_SHA;
const originalExpectedGitTag = globalThis.process.env.EXPECTED_GIT_TAG;
const originalExpectedGitRepository = globalThis.process.env.EXPECTED_GIT_REPOSITORY;
const originalExpectedGithubWorkflowPath = globalThis.process.env.EXPECTED_GITHUB_WORKFLOW_PATH;
const regressionPackageName = "@lcv-ideas-software/registry-verifier-regression";
const regressionPackageVersion = "0.0.0-test";
const regressionGitSha = "0123456789abcdef0123456789abcdef01234567";
const regressionGitTag = "refs/tags/v00.00.00-test";
const regressionGitRepository = "https://github.com/LCV-Ideas-Software/cross-review";
const regressionGithubWorkflowPath = ".github/workflows/publish.yml";
const regressionAttestationUrl =
  "https://registry.npmjs.org//attacker.invalid/attestations/registry-verifier-regression@0.0.0-test";
const advertisedAttestationUrl =
  "https://metadata-redirect.invalid//attacker.invalid/attestations/registry-verifier-regression@0.0.0-test";

globalThis.process.env.PACKAGE_NAME = regressionPackageName;
globalThis.process.env.PACKAGE_VERSION = regressionPackageVersion;
globalThis.process.env.EXPECTED_GIT_SHA = regressionGitSha;
globalThis.process.env.EXPECTED_GIT_TAG = regressionGitTag;
globalThis.process.env.EXPECTED_GIT_REPOSITORY = regressionGitRepository;
globalThis.process.env.EXPECTED_GITHUB_WORKFLOW_PATH = regressionGithubWorkflowPath;
globalThis.setTimeout = (callback, _delay, ...args) => {
  globalThis.queueMicrotask(() => callback(...args));
  return 0;
};

const slsaAttestationResponse = ({
  gitSha = regressionGitSha,
  statementType = "https://in-toto.io/Statement/v1",
} = {}) => {
  // npm's published attestation endpoint returns a Sigstore bundle whose
  // in-toto statement is stored in the base64-encoded DSSE envelope payload.
  // Keep this fixture congruent with that public registry contract instead of
  // modeling a pre-decoded predicate object that the endpoint never returns.
  const payload = Buffer.from(
    JSON.stringify({
      _type: statementType,
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: regressionGitTag,
              repository: regressionGitRepository,
              path: regressionGithubWorkflowPath,
            },
          },
          resolvedDependencies: [
            {
              uri: `git+${regressionGitRepository}@${regressionGitTag}`,
              digest: { gitCommit: gitSha },
            },
          ],
        },
      },
    }),
    "utf8",
  ).toString("base64");
  return globalThis.Response.json({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload,
            signatures: [],
          },
        },
      },
    ],
  });
};

async function runRegistryVerifierScenario(scenario, attestationResponseFactories) {
  let attestationLookupCount = 0;
  let metadataLookupCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const parsedUrl = new URL(url);
    assert.equal(
      parsedUrl.origin,
      "https://registry.npmjs.org",
      "every registry-verifier request must use the exact parsed npm registry origin",
    );
    if (url === regressionAttestationUrl) {
      assert.equal(
        init?.redirect,
        "error",
        "attestation lookup must reject redirects instead of following them cross-origin",
      );
      const responseFactory =
        attestationResponseFactories[
          Math.min(attestationLookupCount, attestationResponseFactories.length - 1)
        ];
      attestationLookupCount += 1;
      return responseFactory();
    }
    assert.equal(
      url,
      "https://registry.npmjs.org/@lcv-ideas-software%2Fregistry-verifier-regression/0.0.0-test",
      "the metadata lookup must encode the complete package identity under the pinned registry origin",
    );
    metadataLookupCount += 1;
    return globalThis.Response.json({
      dist: {
        shasum: "0000000000000000000000000000000000000000",
        integrity: "sha512-regression",
        tarball:
          "https://registry.npmjs.org/@lcv-ideas-software/registry-verifier-regression/-/registry-verifier-regression-0.0.0-test.tgz",
        attestations: {
          url: advertisedAttestationUrl,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    });
  };
  await import(`./verify-registry-dist.mjs?eventual-consistency=${scenario}`);
  assert.equal(
    metadataLookupCount,
    1,
    "each verifier run must perform one exact-origin metadata lookup",
  );
  return attestationLookupCount;
}

try {
  assert.equal(
    await runRegistryVerifierScenario("http-404", [
      () => new globalThis.Response(null, { status: 404, statusText: "Not Found" }),
      slsaAttestationResponse,
    ]),
    2,
    "post-publish verification must retry a transient 404 from the advertised attestation URL",
  );
  assert.equal(
    await runRegistryVerifierScenario("http-599", [
      () => new globalThis.Response(null, { status: 599, statusText: "Transient Failure" }),
      slsaAttestationResponse,
    ]),
    2,
    "post-publish verification must retry the complete transient 5xx status range",
  );
  assert.equal(
    await runRegistryVerifierScenario("predicate-propagation", [
      () =>
        globalThis.Response.json({
          attestations: [{ predicateType: "https://npmjs.com/package/v1" }],
        }),
      slsaAttestationResponse,
    ]),
    2,
    "post-publish verification must retry a document whose SLSA predicate is still propagating",
  );
  assert.equal(
    await runRegistryVerifierScenario("json-propagation", [
      () =>
        new globalThis.Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      slsaAttestationResponse,
    ]),
    2,
    "post-publish verification must retry a transient incomplete attestation document",
  );
  await assert.rejects(
    () =>
      runRegistryVerifierScenario("wrong-git-sha", [
        () => slsaAttestationResponse({ gitSha: "fedcba9876543210fedcba9876543210fedcba98" }),
      ]),
    /expected git commit 0123456789abcdef0123456789abcdef01234567/,
    "post-publish verification must reject provenance for a different source commit",
  );
  await assert.rejects(
    () =>
      runRegistryVerifierScenario("wrong-in-toto-statement", [
        () => slsaAttestationResponse({ statementType: "https://in-toto.io/Statement/v0.1" }),
      ]),
    /unexpected in-toto statement type/,
    "post-publish verification must reject a provenance payload that is not an in-toto Statement v1",
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (originalPackageName === undefined) delete globalThis.process.env.PACKAGE_NAME;
  else globalThis.process.env.PACKAGE_NAME = originalPackageName;
  if (originalPackageVersion === undefined) delete globalThis.process.env.PACKAGE_VERSION;
  else globalThis.process.env.PACKAGE_VERSION = originalPackageVersion;
  if (originalExpectedGitSha === undefined) delete globalThis.process.env.EXPECTED_GIT_SHA;
  else globalThis.process.env.EXPECTED_GIT_SHA = originalExpectedGitSha;
  if (originalExpectedGitTag === undefined) delete globalThis.process.env.EXPECTED_GIT_TAG;
  else globalThis.process.env.EXPECTED_GIT_TAG = originalExpectedGitTag;
  if (originalExpectedGitRepository === undefined)
    delete globalThis.process.env.EXPECTED_GIT_REPOSITORY;
  else globalThis.process.env.EXPECTED_GIT_REPOSITORY = originalExpectedGitRepository;
  if (originalExpectedGithubWorkflowPath === undefined) {
    delete globalThis.process.env.EXPECTED_GITHUB_WORKFLOW_PATH;
  } else {
    globalThis.process.env.EXPECTED_GITHUB_WORKFLOW_PATH = originalExpectedGithubWorkflowPath;
  }
}
assert.doesNotMatch(
  securityBaseline,
  /Package publishing requires the `NPM_TOKEN` secret/,
  "security documentation must not prescribe a deprecated long-lived npm publish token",
);

assert.match(
  packageJson.repository?.url ?? "",
  /^git\+https:\/\/github\.com\/LCV-Ideas-Software\/cross-review\.git$/,
  "package repository.url must exactly identify the OIDC trusted-publisher repository",
);

assert.equal(
  packageLock.version,
  packageJson.version,
  "the lockfile version must match the release manifest",
);
assert.equal(
  packageLock.packages?.[""]?.version,
  packageJson.version,
  "the lockfile root package version must match the release manifest",
);
const displayVersion = `v${packageJson.version
  .split(".")
  .map((part) => part.padStart(2, "0"))
  .join(".")}`;
for (const [document, label] of [
  [readme, "README"],
  [presentation, "full presentation"],
  [presentationShort, "short presentation"],
  [changelog, "changelog"],
]) {
  assert.ok(
    document.includes(displayVersion),
    `${label} must describe the current ${displayVersion} source/release target`,
  );
}

const directDependencies = new Map([
  ...Object.keys(packageJson.dependencies ?? {}).map((dependency) => [dependency, "runtime"]),
  ...Object.keys(packageJson.devDependencies ?? {}).map((dependency) => [
    dependency,
    dependency === "@modelcontextprotocol/sdk" ? "bundled/dev" : "development",
  ]),
]);
function validateThirdPartyInventory(markdown) {
  const rows = markdown
    .split(/\r?\n/)
    .filter((line) => /^\|\s*[^-|\s][^|]*\|/.test(line))
    .slice(1)
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  assert.equal(
    rows.length,
    directDependencies.size,
    "THIRDPARTY.md must contain exactly one row per direct dependency",
  );
  const seenDependencies = new Set();
  for (const [dependency, license, scope, source] of rows) {
    assert.ok(
      directDependencies.has(dependency),
      `THIRDPARTY.md must not contain undeclared dependency ${dependency}`,
    );
    assert.ok(
      !seenDependencies.has(dependency),
      `THIRDPARTY.md must contain ${dependency} exactly once`,
    );
    seenDependencies.add(dependency);
    assert.equal(
      scope,
      directDependencies.get(dependency),
      `THIRDPARTY.md must identify the exact scope for ${dependency}`,
    );
    assert.equal(
      license,
      packageLock.packages?.[`node_modules/${dependency}`]?.license,
      `THIRDPARTY.md must match the resolved license for ${dependency}`,
    );
    assert.equal(
      source,
      `https://www.npmjs.com/package/${dependency}`,
      `THIRDPARTY.md must identify the canonical npm source for ${dependency}`,
    );
  }
  assert.deepEqual(
    [...seenDependencies].sort(),
    [...directDependencies.keys()].sort(),
    "THIRDPARTY.md must inventory every direct dependency",
  );
}
validateThirdPartyInventory(thirdParty);
const anthropicRow = thirdParty
  .split(/\r?\n/)
  .find((line) => line.includes("| @anthropic-ai/sdk "));
assert.ok(anthropicRow, "THIRDPARTY.md must include the Anthropic SDK row");
for (const [mutation, expectedFailure] of [
  [thirdParty.replace(anthropicRow, ""), /exactly one row/],
  [thirdParty.replace(anthropicRow, `${anthropicRow}\n${anthropicRow}`), /exactly one row/],
  [thirdParty.replace("| runtime     |", "| development |"), /exact scope/],
  [thirdParty.replace("| MIT               |", "| UNKNOWN           |"), /resolved license/],
]) {
  assert.throws(
    () => validateThirdPartyInventory(mutation),
    expectedFailure,
    "THIRDPARTY.md regression guard must reject incomplete or inaccurate inventory",
  );
}

for (const dependency of ["@anthropic-ai/sdk", "@google/genai", "@modelcontextprotocol/sdk"]) {
  assert.ok(directDependencies.has(dependency), `${dependency} must remain directly declared`);
  for (const [document, label] of [
    [readme, "README"],
    [presentation, "full presentation"],
    [presentationShort, "short presentation"],
  ]) {
    assert.ok(
      document.includes(dependency),
      `${label} must identify the current ${dependency} declaration`,
    );
  }
}
for (const [document, label] of [
  [thirdParty, "THIRDPARTY.md"],
  [readme, "README"],
  [presentation, "full presentation"],
  [presentationShort, "short presentation"],
]) {
  assert.ok(
    document.includes("package.json") && document.includes("package-lock.json"),
    `${label} must point version readers to the manifest and lockfile sources of truth`,
  );
}
for (const [document, label] of [
  [readme, "README"],
  [presentation, "full presentation"],
  [presentationShort, "short presentation"],
  [changelog, "changelog"],
]) {
  assert.ok(
    document.includes("bundled/dev"),
    `${label} must identify the MCP SDK as a bundled/dev dependency`,
  );
}

const globalInstallPolicy = "--ignore-scripts --allow-git=none --allow-remote=none";
const npmjsUpgrade = `npm upgrade -g @lcv-ideas-software/cross-review ${globalInstallPolicy}`;
const githubUpgrade = `npm upgrade -g @lcv-ideas-software/cross-review --@lcv-ideas-software:registry=https://npm.pkg.github.com ${globalInstallPolicy}`;
for (const [document, label] of [
  [readme, "README"],
  [presentation, "full presentation"],
  [presentationShort, "short presentation"],
]) {
  const lines = document.split(/\r?\n/);
  assert.ok(
    lines.includes(npmjsUpgrade),
    `${label} must use the configured public registry for npmjs upgrades`,
  );
  assert.ok(
    lines.includes(githubUpgrade),
    `${label} must override the scoped registry explicitly for GitHub Packages upgrades`,
  );
  assert.doesNotMatch(
    document,
    /npm upgrade -g @lcv-ideas-software\/cross-review@latest/,
    `${label} must not pass @latest to npm upgrade (npm v12 rejects it with EUPDATEARGS)`,
  );
  assert.doesNotMatch(
    document,
    /npm upgrade[^\n]*dangerously-allow-all-scripts/,
    `${label} must never recommend bypassing npm v12 dependency-script review`,
  );
  assert.doesNotMatch(
    document,
    /npm upgrade[^\n]*(?:--strict-allow-scripts|--allow-scripts=)/,
    `${label} must not apply project-scoped script approvals to the entire global tree`,
  );
}

assert.match(
  codeqlWorkflow,
  /queries:\s*security-and-quality/,
  "the committed Advanced CodeQL workflow must retain security-and-quality queries",
);
assert.doesNotMatch(
  securityBaseline,
  /Advanced Setup is intentionally not committed/,
  "security documentation must not claim the committed CodeQL workflow is absent",
);
assert.match(
  serverSource,
  /codeql_policy:\s*"Repository policy: committed Advanced CodeQL workflow/,
  "server_info must report the repository's actual Advanced CodeQL policy",
);

console.log("npm v12 release security regression: PASS");
