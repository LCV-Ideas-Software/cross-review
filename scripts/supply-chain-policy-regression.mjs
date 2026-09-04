// Supply-chain and packaging policy contracts for this repository.
//
// Scope: the package manifest and lockfile, the npm client policy, the CI
// toolchain, the published legal inventory, and the shape of the native
// publishing workflow. Governance itself is enforced by GitHub: Enterprise
// rulesets, CodeQL default setup, Code Quality, license compliance and the
// repository's required-checks ruleset. Nothing here re-implements a platform
// guarantee.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

const [
  packageJson,
  packageLock,
  ciWorkflow,
  publishWorkflow,
  npmToolchainAction,
  npmrc,
  securityBaseline,
  readme,
  presentation,
  presentationShort,
  thirdParty,
  changelog,
  serverSource,
  dependabotConfig,
  pythonVersion,
] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("package-lock.json").then(JSON.parse),
  read(".github/workflows/ci.yml"),
  read(".github/workflows/publish.yml"),
  read(".github/actions/setup-npm-toolchain/action.yml"),
  read(".npmrc"),
  read("docs/github-security-baseline.md"),
  read("README.md"),
  read("docs/apresentacao-cross-review.md"),
  read("docs/apresentacao.md"),
  read("THIRDPARTY.md"),
  read("CHANGELOG.md"),
  read("src/mcp/server.ts"),
  read(".github/dependabot.yml"),
  read(".python-version"),
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

// --- package manifest and lockfile -----------------------------------------

assert.equal(
  packageJson.packageManager,
  undefined,
  "packageManager must stay workflow-pinned so Dependabot's supported npm remains decoupled from the verified CI toolchain",
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

// --- npm client policy ------------------------------------------------------

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
for (const policy of ["strict-allow-scripts=true", "allow-git=none", "allow-remote=none"]) {
  assert.match(npmrc, new RegExp(`^${policy}$`, "m"), `.npmrc must enforce ${policy}`);
}
assert.doesNotMatch(
  npmrc,
  /dangerously-allow-all-scripts\s*=\s*true/,
  ".npmrc must never bypass dependency-script review",
);
assert.doesNotMatch(
  dependabotConfig,
  /^registries:/m,
  "Dependabot must use the public npm registry without a private registry credential",
);
for (const ecosystem of ["npm", "github-actions", "pip", "pre-commit"]) {
  assert.match(
    dependabotConfig,
    new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`),
    `Dependabot must cover the repository's ${ecosystem} ecosystem`,
  );
}

// --- continuous integration toolchain ---------------------------------------

assert.ok(
  ciWorkflow.includes(`NPM_CLI_VERSION: "${expectedNpmCliVersion}"`),
  "CI must pin the audited npm CLI version exactly",
);
assert.ok(
  ciWorkflow.includes(`NPM_CLI_SHA512: "${expectedNpmCliSha512}"`),
  "CI must pin the audited npm tarball digest exactly",
);
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
  ciWorkflow,
  /package-manager-cache:\s*false/,
  "ordinary CI must explicitly disable package-manager caching",
);
assert.doesNotMatch(
  ciWorkflow,
  /dangerously-allow-all-scripts/,
  "ordinary CI must never bypass the npm install-script policy",
);
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
assert.equal(pythonVersion.trim(), "3.12", "the Python security-tool lock is resolved for 3.12");
assert.match(
  ciWorkflow,
  /python-version-file:\s*["']?\.python-version["']?/,
  "Python consumers must use the centrally pinned lock version",
);

// --- native publishing workflow ---------------------------------------------
//
// Publication follows GitHub's documented model: the operator publishes a
// Release and npm authorizes the run through Trusted Publishing (OIDC). The
// repository owns no tagging, dispatch or policy machinery.

assert.match(
  publishWorkflow,
  /on:\s*\r?\n\s+release:\s*\r?\n\s+types:\s*\[published\]/,
  "publishing must be triggered by a published GitHub Release, not by repository-owned tagging",
);
// A queued publication is never replaced: a `release: published` event happens
// once, so a cancelled pending run would lose that release for good.
assert.match(
  publishWorkflow,
  /concurrency:\s*\r?\n\s+group:[^\n]*\r?\n\s+queue:\s*max\r?\n\s+cancel-in-progress:\s*false/,
  "publication must queue every pending release instead of replacing it",
);
// The tarball is built where no publishing identity exists, and the two
// registry writers never install dependencies: they publish that artifact with
// lifecycle scripts disabled. Each job is audited on its own.
const [, buildJob, npmjsJob, githubPackagesJob] = publishWorkflow.split(
  /\n {2}(?=build:|npmjs:|github-packages:)/,
);
assert.ok(buildJob && npmjsJob && githubPackagesJob, "every publishing job must be auditable");
assert.doesNotMatch(
  buildJob,
  /id-token:\s*write/,
  "the build job must not hold the publishing identity while dependency build tools run",
);
assert.match(
  buildJob,
  /npm ci --ignore-scripts/,
  "the build job must install dependencies without running their lifecycle scripts",
);
assert.match(
  buildJob,
  /npm pack --pack-destination/,
  "the build job must pack the release tarball",
);
assert.match(
  buildJob,
  /if:\s*\$\{\{\s*!github\.event\.release\.prerelease\s*\}\}/,
  "a prerelease Release must stop the whole publication, which every writer depends on",
);
for (const [job, label] of [
  [npmjsJob, "the npmjs job"],
  [githubPackagesJob, "the GitHub Packages job"],
]) {
  assert.match(job, /id-token:\s*write/, `${label} must request the OIDC credential`);
  assert.match(job, /needs:[^\n]*build/, `${label} must publish the artifact the build job packed`);
  assert.doesNotMatch(
    job,
    /npm ci/,
    `${label} must not install dependencies while it holds a publishing identity`,
  );
  // npm refuses to generate provenance for a package it treats as new or
  // private, so both registries need the explicit public access.
  assert.match(
    job,
    /TARBALL: \$\{\{ needs\.build\.outputs\.tarball \}\}/,
    `${label} must take the artifact name through the environment, never interpolated into the shell`,
  );
  assert.match(
    job,
    /npm publish "\$RUNNER_TEMP\/release\/\$TARBALL" --provenance --access public --ignore-scripts/,
    `${label} must publish exactly that tarball, publicly, with provenance and without lifecycle scripts`,
  );
}
assert.match(
  npmjsJob,
  /environment:\s*npm-production/,
  "npmjs publishing must run in the protected npm-production environment npm authorizes",
);
// Anchored to the end of the value: an unanchored host would also accept a
// lookalike suffix such as `registry.npmjs.org.example.invalid`.
assert.match(
  npmjsJob,
  /^\s+registry-url:\s*https:\/\/registry\.npmjs\.org\/?\s*$/m,
  "the npmjs job must select exactly the public registry through setup-node",
);
assert.match(
  githubPackagesJob,
  /^\s+registry-url:\s*https:\/\/npm\.pkg\.github\.com\/?\s*$/m,
  "the mirror job must select exactly GitHub Packages through setup-node",
);
// GitHub has no native rule binding a Release to the default branch.
assert.match(
  npmjsJob,
  /compare\/main\.\.\.\$GITHUB_SHA/,
  "publishing must prove the released commit is part of main, where the required checks ran",
);
assert.match(
  npmjsJob,
  /identical \| behind\) ;;/,
  "only a commit identical to or already merged into main may be published",
);
assert.match(
  npmjsJob,
  /RELEASE_TAG" != "\$manifest_tag/,
  "publishing must refuse a release tag that does not name the manifest version",
);
// `npm publish` moves `latest` to whatever it publishes, in any order.
assert.match(
  npmjsJob,
  /published_latest="\$\(npm view "\$package_name" version/,
  "publishing must read the version the registry already serves",
);
assert.match(
  npmjsJob,
  /grep -q 'E404'/,
  "only npm's explicit not-found may mean the package was never published",
);
assert.match(
  npmjsJob,
  /Could not read the published version of \$package_name; refusing to publish/,
  "a registry read failure must fail closed instead of skipping the downgrade guard",
);
assert.match(
  npmjsJob,
  /is a prerelease; this repository publishes only stable versions/,
  "publishing must refuse a prerelease manifest, which would otherwise take the latest dist-tag",
);
assert.match(
  npmjsJob,
  /refusing to move the latest dist-tag backward/,
  "publishing must refuse a version older than the published latest",
);
for (const forbidden of [
  ["NPM_TOKEN", "a long-lived npm publish token"],
  ["LCV_AUTOMATION_TOKEN", "a personal access token"],
]) {
  assert.doesNotMatch(
    publishWorkflow,
    new RegExp(forbidden[0]),
    `publishing must not depend on ${forbidden[1]}`,
  );
}
assert.doesNotMatch(
  securityBaseline,
  /Package publishing requires the `NPM_TOKEN` secret/,
  "security documentation must not prescribe a deprecated long-lived npm publish token",
);

// --- code scanning ----------------------------------------------------------

const configuredCodeqlLanguages = ["actions", "javascript-typescript", "python"];
// A configured language with no source in the tree fails default setup with
// "CodeQL could not process any code", which reddens the required check.
if (configuredCodeqlLanguages.includes("python")) {
  const pythonProbe = await read("quality/code-quality-probe.py").catch(() => "");
  assert.ok(
    pythonProbe.trim().length > 0,
    "quality/code-quality-probe.py must keep analyzable Python source while CodeQL default setup analyzes python",
  );
  // The marker is active documentation: it must explain the reason that still
  // holds, not a release gate this repository no longer has.
  assert.match(
    pythonProbe,
    /required code-scanning\s+check on every pull request into `main`/,
    "the Python marker must explain that it keeps the required code-scanning check green",
  );
  assert.doesNotMatch(
    pythonProbe,
    /auto-tag|release gates|release SHA/,
    "the Python marker must not describe release machinery this repository removed",
  );
}
// Asserted in full: a prefix match would keep reporting a policy the
// repository no longer follows.
const expectedCodeqlPolicy =
  "Repository policy: CodeQL default setup applied by the Enterprise security configuration " +
  "(actions, javascript-typescript, python; extended query suite); no repository CodeQL workflow. " +
  "The Enterprise ruleset and the repository's required checks gate every pull request into main " +
  "on those analyses, so a released commit already carries them.";
assert.ok(
  serverSource.includes(`codeql_policy:\n            "${expectedCodeqlPolicy}",`),
  "server_info must report the repository's actual CodeQL policy, in full",
);

// --- published version documents --------------------------------------------

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

// --- legal inventory ---------------------------------------------------------

const directDependencies = new Map([
  ...Object.keys(packageJson.dependencies ?? {}).map((dependency) => [dependency, "runtime"]),
  ...Object.keys(packageJson.devDependencies ?? {}).map((dependency) => [
    dependency,
    dependency === "@modelcontextprotocol/sdk" ? "bundled/dev" : "development",
  ]),
]);
function validateThirdPartyInventory(markdown) {
  const npmSection = markdown.split("GitHub Actions used by the workflows")[0];
  const rows = npmSection
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

const workflowDirectory = path.join(root, ".github/workflows");
const workflowActions = new Set();
// Every external `uses:` must be accounted for. An entry this reader cannot
// parse fails here instead of quietly escaping the legal inventory.
const externalUses =
  /^\s+(?:-\s+)?(?:"uses"|'uses'|uses)\s*:\s*(?!["']?[.$]\/)(\S.*?)\s*(?:#.*)?$/gm;
const pinnedAction =
  /^["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}["']?$/;
// Any `uses` key this reader does not recognize fails the contract instead of
// escaping the inventory: no YAML parser is hand-rolled here.
const anyUsesKey = /(?:^|[\s{,])(?:"uses"|'uses'|uses)\s*:/g;
for (const entry of await readdir(workflowDirectory)) {
  if (!/\.ya?ml$/.test(entry)) continue;
  const workflow = await readFile(path.join(workflowDirectory, entry), "utf8");
  const recognized = [...workflow.matchAll(externalUses)];
  const localUses = [
    ...workflow.matchAll(/^\s+(?:-\s+)?(?:"uses"|'uses'|uses)\s*:\s*["']?[.$]\//gm),
  ];
  const declared = [...workflow.matchAll(anyUsesKey)];
  assert.equal(
    declared.length,
    recognized.length + localUses.length,
    `${entry} contains a uses form this inventory reader does not recognize; extend the reader instead of letting the action escape THIRDPARTY.md`,
  );
  for (const match of recognized) {
    const reference = match[1];
    const pinned = pinnedAction.exec(reference);
    assert.ok(
      pinned,
      `${entry} must pin every external action by full-length SHA; found ${reference}`,
    );
    workflowActions.add(pinned[1]);
  }
}
assert.ok(
  workflowActions.size > 0,
  "the workflows must pin at least one external Action by full-length SHA",
);
const actionSection = thirdParty.split("GitHub Actions used by the workflows")[1] ?? "";
// The inventory is checked in both directions: a missing row hides a component,
// and a stale row claims one the workflows no longer use.
const inventoriedActions = new Set(
  [...actionSection.matchAll(/^\|\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s*\|/gm)].map(
    (match) => match[1],
  ),
);
assert.deepEqual(
  [...inventoriedActions].sort(),
  [...workflowActions].sort(),
  "THIRDPARTY.md must list exactly the GitHub Actions the workflows use, by name, license and source",
);
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

// --- documented consumer commands --------------------------------------------

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

console.log("supply-chain policy regression: PASS");
