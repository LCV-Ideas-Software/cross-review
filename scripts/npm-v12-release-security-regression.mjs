import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  socketWorkflow,
  dependabotAutomergeWorkflow,
  scorecardWorkflow,
  zizmorWorkflow,
  pagesWorkflow,
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
  read(".github/workflows/socket.yml"),
  read(".github/workflows/dependabot-automerge.yml"),
  read(".github/workflows/scorecard.yml"),
  read(".github/workflows/zizmor.yml"),
  read(".github/workflows/pages.yml"),
  read("scripts/require-dependabot-release-evidence.sh"),
  read("scripts/require-release-push-workflows.sh"),
]);

const expectedAllowScripts = {
  "@google/genai": false,
  "esbuild@0.28.1": true,
  "fsevents@2.3.3": true,
  "protobufjs@7.6.5": true,
};
const expectedNpmCliVersion = "12.0.1";
const expectedNpmCliSha512 =
  "2f94fd8bf600416416a934bfc59c4991e8bff7372ef7d842784e2a8b8d48c81555ee645069ddea73625fb8e92dc261feab0188fd5dab6c22fefd46316f5f9140";
const expectedDependabotController =
  "LCV-Ideas-Software/.github/dependabot-automerge@c846bc77cbeb38dcf5fb4b8c798dc75227b65f04";

assert.equal(
  packageJson.packageManager,
  undefined,
  "packageManager must stay workflow-pinned: Dependabot's supported npm must not bootstrap through the private registry",
);

assert.deepEqual(
  packageJson.allowScripts,
  expectedAllowScripts,
  "package.json must retain the exact reviewed npm v12 install-script policy; @google/genai is explicitly denied so future Dependabot versions cannot gain install-time execution",
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
  .filter(
    ({ resolved }) =>
      !resolved.startsWith("https://registry.npmjs.org/") &&
      !resolved.startsWith("https://registry.stepsecurity.io/"),
  );
assert.deepEqual(
  foreignResolved,
  [],
  "npm v12 blocks git and remote-URL dependencies; the lockfile must use approved registries only",
);

assert.ok(
  dependabotConfig.includes("stepsecurity-javascript:") &&
    dependabotConfig.includes("url: https://registry.stepsecurity.io/javascript"),
  "Dependabot npm updates must authenticate to the StepSecurity registry declared in .npmrc",
);
assert.doesNotMatch(
  dependabotConfig,
  /replaces-base:/,
  "a global registry already exists in .npmrc, so Dependabot must not redirect Corepack with replaces-base",
);
assert.match(
  npmrc,
  /^registry=https:\/\/registry\.stepsecurity\.io\/javascript$/m,
  ".npmrc must keep StepSecurity as the global npm dependency registry",
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
assert.match(
  dependabotAutomergeWorkflow,
  /workflow_run:/,
  "Dependabot automation must run in the privileged default-branch context only after untrusted PR checks complete",
);
assert.doesNotMatch(
  dependabotAutomergeWorkflow,
  /pull_request_target:/,
  "Dependabot automation must not execute directly in the pull_request_target event context",
);
assert.ok(
  dependabotAutomergeWorkflow.includes(expectedDependabotController),
  "Dependabot automation must pin the reviewed central controller to its immutable commit SHA",
);
assert.ok(
  dependabotAutomergeWorkflow.includes(
    ["automation_token: $", "{{ secrets.LCV_AUTOMATION_TOKEN }}"].join(""),
  ) &&
    dependabotAutomergeWorkflow.includes("Build, lint and smoke") &&
    dependabotAutomergeWorkflow.includes("cancel-in-progress: false"),
  "Dependabot automation must retain the guarded queue credential, repository gate, and serialization policy",
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
  [socketWorkflow, "Socket Security"],
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
  /pip install[^\n]*--require-hashes[^\n]*socketsecurity-requirements\.txt/,
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
for (const workflow of [ciWorkflow, socketWorkflow]) {
  assert.match(
    workflow,
    /python-version-file:\s*["']?\.python-version["']?/,
    "Python consumers must use the centrally pinned lock version",
  );
}
assert.doesNotMatch(
  dependabotConfig,
  /interval:\s*["']?daily["']?\s*\r?\n\s*day:/,
  "Dependabot daily schedules must not carry the weekly-only day option",
);

assert.match(
  publishWorkflow,
  /publish-npmjs:[\s\S]*?permissions:\s*write-all[\s\S]*?publish-gh-packages:/,
  "npmjs publishing must retain the organization-wide write-all policy, including OIDC",
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
  (
    publishWorkflow.match(
      /STEPSECURITY_NPM_TOKEN:\s*\$\{\{ secrets\.STEPSECURITY_NPM_TOKEN \}\}/g,
    ) ?? []
  ).length,
  4,
  "the StepSecurity read token must be scoped only to the four npm ci steps",
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
assert.match(
  publishWorkflow,
  /concurrency:\s*\r?\n(?:\s*#[^\n]*\r?\n)*\s+group:\s*release-publication\s*\r?\n\s+queue:\s*max\s*\r?\n\s+cancel-in-progress:\s*false/,
  "all tags must share one FIFO publication transaction so registry and GitHub latest cannot race",
);
assert.doesNotMatch(
  publishWorkflow.match(/concurrency:[\s\S]*?(?=\nenv:)/)?.[0] ?? "",
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
  /gate:[\s\S]*?permissions:\s*write-all/,
  "the publish gate must retain organization-wide authorization to verify Actions and CodeQL state",
);
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
  "auto-tag must not create a release identity before all six exact-SHA push workflows pass",
);
for (const workflowPath of [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/socket.yml",
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
    printf '%s\\n' '[{"workflows":[{"id":101,"path":".github/workflows/ci.yml","state":"active"},{"id":102,"path":".github/workflows/codeql.yml","state":"active"},{"id":103,"path":".github/workflows/socket.yml","state":"active"},{"id":104,"path":".github/workflows/zizmor.yml","state":"active"},{"id":105,"path":".github/workflows/scorecard.yml","state":"active"},{"id":106,"path":".github/workflows/pages.yml","state":"active"}]}]'
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
    for workflow_path in codeql socket zizmor scorecard pages; do
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
    /All six exact-path, exact-ID push workflows passed/,
    "the executable exact-workflow gate fixture must pass all six trusted identities",
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
  /npm --registry=https:\/\/registry\.npmjs\.org audit signatures/,
  "post-publish verification must cryptographically audit registry signatures and provenance",
);
assert.match(
  publishWorkflow,
  /npm --registry=https:\/\/registry\.npmjs\.org view "\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}" --json[\s\S]*?create-signature-audit-lock\.mjs[\s\S]*?npm --registry=https:\/\/registry\.npmjs\.org ci --omit=dev --ignore-scripts --no-audit --no-fund --allow-git=none --allow-remote=none[\s\S]*?verify-published-package-runtime-contract\.mjs[\s\S]*?npm --registry=https:\/\/registry\.npmjs\.org audit signatures/,
  "signature audit must install the exact published package through a validated lockfile and npm ci",
);
assert.match(
  publishWorkflow,
  /npm --registry=https:\/\/registry\.npmjs\.org view "\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}" version/,
  "public visibility must query the fixed npmjs.org registry without downloading executable content",
);
assert.doesNotMatch(
  publishWorkflow,
  /npm --registry=https:\/\/registry\.npmjs\.org install[^\n]*"\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}"/,
  "published-package signature verification must not use a mutable npm install command",
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
  (
    publishWorkflow.match(
      /npm --registry=https:\/\/registry\.npmjs\.org pack --pack-destination artifacts/g,
    ) ?? []
  ).length,
  1,
  "the release package must be packed exactly once in the trusted gate",
);
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
const githubTokenCopy = githubReleaseReconciliationBlock.indexOf('github_token="$GH_TOKEN"');
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
  (githubReleaseReconciliationBlock.match(/\$GH_TOKEN/g) ?? []).length,
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
  4,
  "all four release jobs must explicitly disable package-manager caching",
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

assert.match(
  publishWorkflow,
  /NPM_CLI_VERSION:\s*["']12\.0\.1["']/,
  "release jobs must pin the audited npm v12 toolchain",
);
assert.match(
  publishWorkflow,
  /NPM_CLI_SHA512:\s*["'][a-f0-9]{128}["']/,
  "release jobs must pin the npm v12 tarball by SHA-512",
);
assert.equal(
  (publishWorkflow.match(/uses:\s*\.\/\.github\/actions\/setup-npm-toolchain/g) ?? []).length,
  4,
  "every release job must activate the hash-verified npm v12 toolchain before npm ci",
);
assert.doesNotMatch(
  publishWorkflow,
  /npm[^\n]*install --global/,
  "release jobs must not bootstrap executable tooling through an unhashed npm install",
);
assert.equal(
  (publishWorkflow.match(/npm ci --strict-allow-scripts --no-audit --no-fund/g) ?? []).length,
  4,
  "every release install must fail closed when an unreviewed dependency script appears",
);
assert.doesNotMatch(
  publishWorkflow,
  /dangerously-allow-all-scripts/,
  "release automation must never bypass the npm install-script policy",
);

assert.match(
  ciWorkflow,
  /NPM_CLI_VERSION:\s*["']12\.0\.1["']/,
  "ordinary CI must pin the same audited npm v12 toolchain as release jobs",
);
assert.match(
  ciWorkflow,
  /NPM_CLI_SHA512:\s*["'][a-f0-9]{128}["']/,
  "ordinary CI must pin the npm v12 tarball by SHA-512",
);
assert.match(
  ciWorkflow,
  /package-manager-cache:\s*false/,
  "ordinary CI must explicitly disable package-manager caching",
);
assert.match(
  ciWorkflow,
  /uses:\s*\.\/\.github\/actions\/setup-npm-toolchain/,
  "ordinary CI must activate the hash-verified npm v12 toolchain",
);
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
  (ciWorkflow.match(/STEPSECURITY_NPM_TOKEN:\s*\$\{\{ secrets\.STEPSECURITY_NPM_TOKEN \}\}/g) ?? [])
    .length,
  1,
  "ordinary CI must expose the StepSecurity read token only to npm ci",
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
  /- name: Checkout CI-verified main commit with full history[\s\S]*?(?=\n\s+- name: Setup Node\.js 24 for release-policy validation)/,
)?.[0];
assert.ok(privilegedCheckoutBlock, "auto-tag must retain an explicit trusted checkout step");
assert.match(
  privilegedCheckoutBlock,
  /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/,
  "the serialized workflow_run must checkout the exact successful same-repository main SHA",
);
for (const codeScanningGate of [
  "permissions: write-all",
  "Wait for exact CodeQL analyses and require zero results",
  'gh run list --repo "$GITHUB_REPOSITORY" --workflow codeql.yml --commit "$TARGET_SHA"',
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
  ["actions", "javascript-typescript"],
  "the CodeQL release-category contract must exactly match the committed analysis matrix",
);
for (const [gate, label] of [
  [codeScanningGateBlock, "auto-tag"],
  [publishPrerequisiteGateBlock, "publish"],
]) {
  assert.ok(
    gate.includes(
      'required_codeql_categories=("/language:actions" "/language:javascript-typescript")',
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
assert.doesNotMatch(
  tagCheckBlock,
  /releases\/tags\//,
  "auto-tag must discover draft release identities through the paginated list endpoint",
);
const createTagBlock = autoTagWorkflow.match(
  /- name: Create tag through the GitHub API[\s\S]*?(?=\n\s+- name: Dispatch publish workflow)/,
)?.[0];
assert.ok(createTagBlock, "auto-tag must retain an explicit tag-creation step");
assert.ok(
  createTagBlock.indexOf("git/ref/heads/main") <
    createTagBlock.search(/gh api --method POST "repos\/\$GITHUB_REPOSITORY\/git\/refs"/),
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
assert.doesNotMatch(
  dispatchPublishBlock,
  /steps\.version-change\.outputs\.changed == 'true'/,
  "publish redispatch must recover a valid existing version tag after later non-bump main advances",
);
assert.doesNotMatch(
  dispatchPublishBlock,
  /steps\.check\.outputs\.exists/,
  "a valid existing canonical tag must redispatch publish.yml so partial publication can recover",
);
assert.match(
  autoTagWorkflow,
  /gh workflow run publish\.yml(?: --repo "\$GITHUB_REPOSITORY")? --ref "\$\{TAG\}"/,
  "auto-tag must dispatch publish.yml on the tag ref because GITHUB_TOKEN tag pushes do not trigger a second workflow",
);
assert.doesNotMatch(
  autoTagWorkflow,
  /gh workflow run publish\.yml[^\n]*\s-f\s+tag=/,
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
  globalThis.fetch = async (input, init) => {
    const url = String(input);
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

for (const [dependency, declaredVersion, scope] of [
  ["@anthropic-ai/sdk", packageJson.dependencies?.["@anthropic-ai/sdk"], "runtime"],
  ["@google/genai", packageJson.dependencies?.["@google/genai"], "runtime"],
  [
    "@modelcontextprotocol/sdk",
    packageJson.devDependencies?.["@modelcontextprotocol/sdk"],
    "bundled/dev",
  ],
]) {
  assert.ok(declaredVersion, `${dependency} must remain directly declared`);
  assert.ok(
    thirdParty.includes(dependency) &&
      thirdParty.includes(declaredVersion) &&
      thirdParty.includes(scope),
    `THIRDPARTY.md must identify ${dependency} ${declaredVersion} with ${scope} scope`,
  );
  for (const [document, label] of [
    [readme, "README"],
    [presentation, "full presentation"],
    [presentationShort, "short presentation"],
    [changelog, "changelog"],
  ]) {
    assert.ok(
      document.includes(dependency) && document.includes(declaredVersion),
      `${label} must identify the current ${dependency} ${declaredVersion} declaration`,
    );
  }
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
const npmjsUpgrade = `npm upgrade -g @lcv-ideas-software/cross-review --@lcv-ideas-software:registry=https://registry.npmjs.org ${globalInstallPolicy}`;
const githubUpgrade = `npm upgrade -g @lcv-ideas-software/cross-review --@lcv-ideas-software:registry=https://npm.pkg.github.com ${globalInstallPolicy}`;
for (const [document, label] of [
  [readme, "README"],
  [presentation, "full presentation"],
  [presentationShort, "short presentation"],
]) {
  const lines = document.split(/\r?\n/);
  assert.ok(
    lines.includes(npmjsUpgrade),
    `${label} must override the scoped registry explicitly for npmjs upgrades`,
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
  /queries:\s*security-extended/,
  "the committed Advanced CodeQL workflow must retain security-extended queries",
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
