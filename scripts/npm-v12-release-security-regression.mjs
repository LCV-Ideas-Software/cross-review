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
  "@google/genai@2.11.0": true,
  "esbuild@0.28.1": true,
  "fsevents@2.3.3": true,
  "protobufjs@7.6.4": true,
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
const createTagBlock = autoTagWorkflow.match(
  /- name: Create and push tag[\s\S]*?(?=\n\s+- name: Dispatch publish workflow)/,
)?.[0];
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

// npm publishes package metadata and its provenance document through separate
// registry surfaces. A newly visible version can therefore advertise an
// attestation URL briefly returning 404. The verifier must retry that bounded
// propagation window without weakening any provenance assertion.
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalPackageName = globalThis.process.env.PACKAGE_NAME;
const originalPackageVersion = globalThis.process.env.PACKAGE_VERSION;
const regressionPackageName = "@lcv-ideas-software/registry-verifier-regression";
const regressionPackageVersion = "0.0.0-test";
const regressionAttestationUrl =
  "https://registry.npmjs.org//attacker.invalid/attestations/registry-verifier-regression@0.0.0-test";
const advertisedAttestationUrl =
  "https://metadata-redirect.invalid//attacker.invalid/attestations/registry-verifier-regression@0.0.0-test";

globalThis.process.env.PACKAGE_NAME = regressionPackageName;
globalThis.process.env.PACKAGE_VERSION = regressionPackageVersion;
globalThis.setTimeout = (callback, _delay, ...args) => {
  globalThis.queueMicrotask(() => callback(...args));
  return 0;
};

const slsaAttestationResponse = () =>
  globalThis.Response.json({
    attestations: [{ predicateType: "https://slsa.dev/provenance/v1" }],
  });

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
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (originalPackageName === undefined) delete globalThis.process.env.PACKAGE_NAME;
  else globalThis.process.env.PACKAGE_NAME = originalPackageName;
  if (originalPackageVersion === undefined) delete globalThis.process.env.PACKAGE_VERSION;
  else globalThis.process.env.PACKAGE_VERSION = originalPackageVersion;
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
