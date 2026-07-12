import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
]);

const expectedAllowScripts = {
  "@google/genai@2.11.0": true,
  "esbuild@0.28.1": true,
  "fsevents@2.3.3": true,
  "protobufjs@7.6.4": true,
};
const expectedNpmCliVersion = "12.0.1";
const expectedNpmCliSha512 =
  "2f94fd8bf600416416a934bfc59c4991e8bff7372ef7d842784e2a8b8d48c81555ee645069ddea73625fb8e92dc261feab0188fd5dab6c22fefd46316f5f9140";

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
  "manual publishing must verify that the requested ref is a real tag",
);
assert.match(
  publishWorkflow,
  /TAG_SHA=.*refs\/tags\/\$PUBLISH_REF\^\{commit\}/,
  "publishing must verify that the tag commit equals the checked out commit",
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
assert.equal(
  (autoTagWorkflow.match(/if:\s*steps\.verified\.outputs\.matches == 'true'/g) ?? []).length,
  4,
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
