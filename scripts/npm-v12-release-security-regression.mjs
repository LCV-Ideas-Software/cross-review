import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  codeqlWorkflow,
  serverSource,
  dependabotConfig,
  pythonVersion,
  socketWorkflow,
  dependabotAutomergeWorkflow,
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
  read(".github/workflows/codeql.yml"),
  read("src/mcp/server.ts"),
  read(".github/dependabot.yml"),
  read(".python-version"),
  read(".github/workflows/socket.yml"),
  read(".github/workflows/dependabot-automerge.yml"),
]);

const expectedAllowScripts = {
  "@google/genai@2.12.0": true,
  "esbuild@0.28.1": true,
  "fsevents@2.3.3": true,
  "protobufjs@7.6.5": true,
};
const expectedNpmCliVersion = "12.0.1";
const expectedNpmCliSha512 =
  "2f94fd8bf600416416a934bfc59c4991e8bff7372ef7d842784e2a8b8d48c81555ee645069ddea73625fb8e92dc261feab0188fd5dab6c22fefd46316f5f9140";

assert.equal(
  packageJson.packageManager,
  undefined,
  "packageManager must stay workflow-pinned: Dependabot's supported npm must not bootstrap through the private registry",
);

assert.deepEqual(
  packageJson.allowScripts,
  expectedAllowScripts,
  "package.json must pin every reviewed dependency install script for npm v12",
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
assert.ok(
  dependabotAutomergeWorkflow.includes("Base branch was modified") &&
    dependabotAutomergeWorkflow.includes("for attempt in {1..6}"),
  "Dependabot automerge must retry GitHub's transient concurrent base-update race",
);
assert.ok(
  autoTagWorkflow.includes("Require triggered Dependabot updates to pass") &&
    autoTagWorkflow.includes('select(.workflowName == "Dependabot Updates")') &&
    autoTagWorkflow.includes('grep -Fxq ".github/dependabot.yml"'),
  "auto-tag must gate a Dependabot configuration change on all triggered ecosystem update jobs",
);
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
  /publish-npmjs:[\s\S]*?permissions:[\s\S]*?id-token:\s*write[\s\S]*?publish-gh-packages:/,
  "npmjs publishing must authenticate with GitHub Actions OIDC",
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
  /gate:[\s\S]*?permissions:[\s\S]*?actions:\s*read[\s\S]*?security-events:\s*read/,
  "the publish gate must be authorized to independently verify Actions and CodeQL state",
);
assert.match(
  publishWorkflow,
  /Revalidate tag SHA against current main and all required workflows/,
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
    /MAIN_SHA="\$\(git ls-remote --heads origin "refs\/heads\/main" \| awk '\{print \$1\}'\)"/,
    "a downstream release write must reject a main advancement after the gate",
  );
  assert.match(
    block,
    /\[ "\$MAIN_SHA" != "\$VERIFIED_SHA" \]/,
    "a downstream release write must compare current main to the gate SHA",
  );
}
assert.match(
  publishWorkflow,
  /Revalidate protected release identity after local validation[\s\S]*?echo "sha=\$TAG_SHA"/,
  "the gate must revalidate protected tag/main identity after its own check and test steps",
);
for (const releasePrerequisite of [
  'MAIN_SHA="$(git rev-parse refs/remotes/origin/main)"',
  'if [ "$TAG_SHA" != "$MAIN_SHA" ]',
  '"CI"',
  '"CodeQL"',
  '"Socket Security"',
  '"OpenSSF Scorecard"',
  '"Pages"',
  "code-scanning/analyses?ref=refs/heads/main&per_page=100",
  "code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100",
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
  /scorecard_required=true[\s\S]*?All three OpenSSF Scorecard SARIF categories are processed for \$TAG_SHA[\s\S]*?code-scanning\/alerts/,
  "when Scorecard applies, all three of its processed SARIF categories must precede the alert query",
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
  `VERIFIED_SHA: \${{ github.event.workflow_run.head_sha }}`,
  'CHECKED_OUT_SHA="$(git rev-parse HEAD)"',
]) {
  assert.ok(
    autoTagWorkflow.includes(prerequisite),
    `auto-tag must enforce the verified workflow_run prerequisite: ${prerequisite}`,
  );
}
const privilegedCheckoutBlock = autoTagWorkflow.match(
  /- name: Checkout CI-verified main commit with full history[\s\S]*?(?=\n\s+- name: Verify checked out main still matches successful CI)/,
)?.[0];
assert.ok(privilegedCheckoutBlock, "auto-tag must retain an explicit trusted checkout step");
assert.doesNotMatch(
  privilegedCheckoutBlock,
  /^\s*ref:/m,
  "workflow_run checkout must use GitHub's trusted default-branch event ref, not an event-controlled ref",
);
assert.doesNotMatch(
  autoTagWorkflow,
  /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/,
  "privileged workflow_run jobs must never checkout a dynamic event SHA",
);
for (const codeScanningGate of [
  "security-events: read",
  "Wait for CodeQL and require zero open alerts",
  'gh run list --repo "$GITHUB_REPOSITORY" --workflow codeql.yml --commit "$VERIFIED_SHA"',
  "code-scanning/analyses?ref=refs/heads/main&per_page=100",
  "code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100",
]) {
  assert.ok(
    autoTagWorkflow.includes(codeScanningGate),
    `auto-tag must block publication until CodeQL completes with zero open alerts: ${codeScanningGate}`,
  );
}
assert.equal(
  (autoTagWorkflow.match(/git ls-remote --heads origin "refs\/heads\/main"/g) ?? []).length,
  5,
  "auto-tag must revalidate main during CodeQL and Dependabot gates, bracket the alert query, and check freshness before tagging",
);
const codeScanningGateBlock = autoTagWorkflow.match(
  /- name: Wait for CodeQL and require zero open alerts[\s\S]*?(?=\n\s+- name: Require triggered Dependabot updates to pass)/,
)?.[0];
assert.ok(codeScanningGateBlock, "auto-tag must retain an explicit code-scanning gate step");
assert.match(
  codeScanningGateBlock,
  /--jq '\.\[\] \| \.commit_sha \+ " " \+ \.category' \| grep -F "\$VERIFIED_SHA "/,
  "auto-tag must project each analysis object before filtering categories by the exact SHA",
);
assert.equal(
  (codeScanningGateBlock.match(/!= "\$VERIFIED_SHA"/g) ?? []).length,
  3,
  "auto-tag must compare the processed-analysis ref and both sides of the alert query with VERIFIED_SHA",
);
assert.ok(
  codeScanningGateBlock.indexOf('alert_main_before="$(git ls-remote --heads origin') <
    codeScanningGateBlock.indexOf("code-scanning/alerts?state=open") &&
    codeScanningGateBlock.indexOf('alert_main_after="$(git ls-remote --heads origin') >
      codeScanningGateBlock.indexOf("code-scanning/alerts?state=open"),
  "auto-tag must bracket the moving-main alert query with the exact verified SHA",
);
const dependabotGateBlock = autoTagWorkflow.match(
  /- name: Require triggered Dependabot updates to pass[\s\S]*?(?=\n\s+- name: Read package\.json version)/,
)?.[0];
assert.ok(dependabotGateBlock, "auto-tag must retain an explicit Dependabot update gate step");
assert.equal(
  (dependabotGateBlock.match(/!= "\$VERIFIED_SHA"/g) ?? []).length,
  1,
  "the Dependabot gate must stop if main advances away from the verified SHA",
);
const createTagBlock = autoTagWorkflow.match(/- name: Create and push tag[\s\S]*?$/)?.[0];
assert.ok(createTagBlock, "auto-tag must retain an explicit tag-creation step");
assert.ok(
  createTagBlock.indexOf('git ls-remote --heads origin "refs/heads/main"') <
    createTagBlock.search(/git tag "\$\{TAG\}" "\$\{VERIFIED_SHA\}"/),
  "auto-tag must revalidate remote main immediately before creating the tag",
);
assert.match(
  createTagBlock,
  /git push origin "refs\/tags\/\$\{TAG\}:refs\/tags\/\$\{TAG\}"/,
  "auto-tag must publish the tag that explicitly names the fully verified SHA",
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
assert.equal(
  (autoTagWorkflow.match(/if:\s*steps\.verified\.outputs\.matches == 'true'/g) ?? []).length,
  6,
  "every step that reads, tags or publishes repository content must require the verified main SHA",
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
