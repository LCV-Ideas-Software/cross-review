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
import { parse as parseYaml } from "yaml";

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
  docsNpmignore,
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
  read("docs/.npmignore"),
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
// Every check that reads the repository, the release or the registry runs in
// the build job, where no publishing identity exists. The two writers only
// publish the artifact it produced.
//
// The workflow is parsed, never pattern-matched. YAML spells one key many
// ways -- `uses`, `"uses"`, `'uses'`, `"u\u0073es"`, a flow mapping -- so a
// literal-key regex can be walked past by valid syntax while the contract
// still reports green. Every reader below works on the parsed document.
const publishDocument = parseYaml(publishWorkflow);
assert.deepEqual(
  Object.keys(publishDocument.jobs ?? {}).sort(),
  ["build", "github-packages", "npmjs"],
  "the publish workflow must define exactly the build job and the two writers",
);
const buildJob = publishDocument.jobs.build;
const npmjsJob = publishDocument.jobs.npmjs;
const githubPackagesJob = publishDocument.jobs["github-packages"];

const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps : []);
const runScriptsOf = (job) =>
  stepsOf(job)
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run);
const actionsOf = (job) =>
  stepsOf(job)
    .filter((step) => typeof step.uses === "string")
    .map((step) => step.uses.split("@")[0]);
const inputsOf = (job, action) =>
  stepsOf(job).find((step) => typeof step.uses === "string" && step.uses.startsWith(`${action}@`))
    ?.with ?? {};
const publishStepOf = (job) => stepsOf(job).find((step) => typeof step.run === "string");

// Permissions are compared as a whole mapping. Asserting that one scope is
// absent, or that a required one is present, both accept an extra grant beside
// the credential; only equality refuses `packages: write` added to the build
// job or `contents: write` added to a writer.
function assertPermissions(job, expected, label) {
  assert.deepEqual(
    job.permissions,
    expected,
    `${label} must hold exactly ${JSON.stringify(expected)} and nothing else`,
  );
}
assert.deepEqual(
  publishDocument.permissions,
  {},
  "the workflow must grant no token scope of its own; each job declares what it needs",
);
const jobPermissions = [
  [buildJob, "the build job", { contents: "read" }, { packages: "write" }],
  [npmjsJob, "the npmjs job", { "id-token": "write" }, { contents: "write" }],
  [
    githubPackagesJob,
    "the GitHub Packages job",
    { packages: "write", "id-token": "write" },
    { actions: "write" },
  ],
];
for (const [job, label, expected, extra] of jobPermissions) {
  assertPermissions(job, expected, label);
  // Proven by injection: any further scope must fail, not just a known one.
  assert.throws(
    () => assertPermissions({ ...job, permissions: { ...expected, ...extra } }, expected, label),
    /nothing else/,
    `${label} must fail the contract when a further scope is granted`,
  );
}

// A GitHub Actions expression opens with the same `${` as a JavaScript
// placeholder, so it is written as an escaped template literal: in a plain
// string the linter reads it as an interpolation the author forgot to make.
const actionsExpression = (body) => `\${{ ${body} }}`;
assert.equal(
  buildJob.if,
  actionsExpression("!github.event.release.prerelease"),
  "a Release marked as a prerelease must stop the publication before anything is built",
);
const buildScript = runScriptsOf(buildJob).join("\n");
assert.match(
  buildScript,
  /npm ci --ignore-scripts/,
  "the build job must install dependencies without running their lifecycle scripts",
);
assert.match(buildScript, /npm pack --pack-destination/, "the build job must pack the tarball");
// The four properties neither GitHub nor npm enforces on its own.
for (const [pattern, contract] of [
  [
    /compare\/main\.\.\.\$GITHUB_SHA/,
    "prove the released commit is part of main, where the required checks ran",
  ],
  [/identical \| behind\) ;;/, "accept only a commit identical to or already merged into main"],
  [
    /RELEASE_TAG" != "\$manifest_tag/,
    "refuse a release tag that does not name the manifest version",
  ],
  [/contents\/package\.json\?ref=main/, "read the version main declares now"],
  [
    /is not the version main declares/,
    "refuse a superseded release, such as a tag that was never published",
  ],
  [
    /is a prerelease; this repository publishes only stable versions/,
    "refuse a prerelease manifest, which would otherwise take the latest dist-tag",
  ],
  [
    /published_latest="\$\(npm view "\$package_name" version/,
    "read the version the registry already serves",
  ],
  [/grep -q 'E404'/, "treat only npm's explicit not-found as an unpublished package"],
  [
    /Could not read the published version of \$package_name; refusing to publish/,
    "fail closed when the registry read fails, instead of skipping the downgrade guard",
  ],
  [
    /refusing to move the latest dist-tag backward/,
    "refuse a version older than the published latest",
  ],
]) {
  assert.match(buildScript, pattern, `the build job must ${contract}`);
}

// A job that holds a publishing credential runs one command and only the two
// GitHub-authored actions that configuring the registry and fetching the
// artifact require.
const publishCommand =
  'npm publish "$RUNNER_TEMP/release/$TARBALL" --provenance --access public --ignore-scripts';
const allowedWriterActions = ["actions/setup-node", "actions/download-artifact"];
function validateWriterJob(job, label) {
  assert.deepEqual(
    runScriptsOf(job),
    [publishCommand],
    `${label} must run that publish command, complete and alone, beside the credential`,
  );
  // The complete ordered list, not a deduplicated set: collapsing duplicates
  // would accept a second `download-artifact` step, which is one more action
  // running beside the credential.
  assert.deepEqual(
    actionsOf(job),
    allowedWriterActions,
    `${label} must run only the two GitHub-authored actions publishing requires, once each`,
  );
}
for (const [job, label] of [
  [npmjsJob, "the npmjs job"],
  [githubPackagesJob, "the GitHub Packages job"],
]) {
  // The command contract comes first: an injected step would otherwise be the
  // one inspected below, and the failure would name the wrong problem.
  validateWriterJob(job, label);
  const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
  assert.ok(needs.includes("build"), `${label} must publish the artifact the build job packed`);
  assert.equal(
    publishStepOf(job).env?.TARBALL,
    actionsExpression("needs.build.outputs.tarball"),
    `${label} must take the artifact name through the environment, never interpolated into the shell`,
  );
}
// Proven by injection: the YAML spellings a literal-key reader walks past, and
// a duplicate of an action the allowlist already admits.
const withExtraStep = (step) => ({ ...npmjsJob, steps: [...stepsOf(npmjsJob), step] });
for (const [mutated, description] of [
  [withExtraStep(parseYaml('- "run": npm install attacker')[0]), "a double-quoted run key"],
  [withExtraStep(parseYaml("- { run: npm install attacker }")[0]), "a flow-style run mapping"],
  [
    withExtraStep(
      parseYaml('- "u\\u0073es": third-party/action@0000000000000000000000000000000000000000')[0],
    ),
    "an escaped uses key",
  ],
  [
    withExtraStep(
      stepsOf(npmjsJob).find((step) => step.uses?.startsWith("actions/download-artifact")),
    ),
    "a second copy of an action the allowlist admits",
  ],
]) {
  assert.throws(
    () => validateWriterJob(mutated, "the npmjs job"),
    /must run/,
    `${description} beside the publishing credential must fail the contract`,
  );
}

assert.equal(
  npmjsJob.environment,
  "npm-production",
  "npmjs publishing must run in the protected npm-production environment npm authorizes",
);
// Compared for equality, not matched: a pattern would also accept a lookalike
// host such as `registry.npmjs.org.example.invalid`.
assert.equal(
  inputsOf(npmjsJob, "actions/setup-node")["registry-url"],
  "https://registry.npmjs.org",
  "the npmjs job must select exactly the public registry through setup-node",
);
assert.equal(
  inputsOf(githubPackagesJob, "actions/setup-node")["registry-url"],
  "https://npm.pkg.github.com",
  "the mirror job must select exactly GitHub Packages through setup-node",
);
assert.equal(
  publishStepOf(githubPackagesJob).env?.NODE_AUTH_TOKEN,
  actionsExpression("secrets.GITHUB_TOKEN"),
  "the mirror job must authenticate with the workflow's own token, never a stored credential",
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

// --- packaging policy --------------------------------------------------------
//
// SECURITY.md states that the public artifact carries no internal field
// report. `package.json` ships `docs/`, so the exclusion lives in
// `docs/.npmignore` and nothing else enforces it.

assert.ok(
  (packageJson.files ?? []).includes("docs/"),
  "the package must keep shipping docs/, which is what makes the report exclusion necessary",
);
assert.match(
  docsNpmignore,
  /^reports\/$/m,
  "docs/.npmignore must keep internal field reports out of the published tarball",
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
const pinnedAction = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;

// The same structural reading as the publish workflow above, for the same
// reason: a literal-key regex accepts only one of YAML's spellings of `uses`.
function collectUsesFromDocument(document) {
  const references = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.uses === "string") references.push(node.uses);
    for (const value of Object.values(node)) visit(value);
  };
  visit(document);
  return references;
}
// A local reference is followed to its own manifest: a composite action can
// pull an external action of its own, which would otherwise never reach the
// inventory. `seen` stops a local action that references itself or a sibling
// loop from spinning.
function localTargetOf(reference) {
  const relative = reference.replace(/^[.$]\//, "");
  return /\.ya?ml$/.test(relative)
    ? path.join(root, relative)
    : path.join(root, relative, "action.yml");
}
async function collectExternalActions(file, label, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    assert.fail(`${label} references a local target that cannot be read: ${file}`);
  }
  let document;
  try {
    document = parseYaml(text);
  } catch (error) {
    assert.fail(`${label} is not parseable YAML, so its actions cannot be inventoried: ${error}`);
  }
  for (const reference of collectUsesFromDocument(document)) {
    if (/^[.$]\//.test(reference)) {
      await collectExternalActions(localTargetOf(reference), reference, seen);
      continue;
    }
    const pinned = pinnedAction.exec(reference);
    assert.ok(
      pinned,
      `${label} must pin every external action by full-length SHA; found ${reference}`,
    );
    workflowActions.add(pinned[1]);
  }
}
for (const entry of await readdir(workflowDirectory)) {
  if (!/\.ya?ml$/.test(entry)) continue;
  await collectExternalActions(path.join(workflowDirectory, entry), entry, new Set());
}
// Proven against the spellings a literal-key reader walks past.
const probeSha = "0".repeat(40);
for (const [source, description] of [
  [`steps:\n  - "u\\u0073es": a/b@${probeSha}`, "a double-quoted, escaped key"],
  [`steps:\n  - 'uses': a/b@${probeSha}`, "a single-quoted key"],
  [`steps:\n  - { uses: a/b@${probeSha} }`, "a flow-style mapping"],
]) {
  assert.deepEqual(
    collectUsesFromDocument(parseYaml(source)),
    [`a/b@${probeSha}`],
    `the inventory reader must see ${description}`,
  );
}
assert.ok(
  workflowActions.size > 0,
  "the workflows must pin at least one external Action by full-length SHA",
);
const actionSection = thirdParty.split("GitHub Actions used by the workflows")[1] ?? "";
// The inventory is checked in both directions and column by column: a missing
// row hides a component, a stale row claims one the workflows no longer use,
// and a name-only check would accept any license or source text.
function validateActionInventory(section) {
  const rows = [
    ...section.matchAll(
      /^\|\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm,
    ),
  ];
  const listed = new Set();
  for (const [, action, license, source] of rows) {
    assert.ok(!listed.has(action), `THIRDPARTY.md must contain ${action} exactly once`);
    listed.add(action);
    assert.match(
      license,
      /^[A-Za-z0-9][A-Za-z0-9.+-]*$/,
      `THIRDPARTY.md must name a license identifier for ${action}, not free text`,
    );
    assert.equal(
      source,
      `https://github.com/${action}`,
      `THIRDPARTY.md must identify the canonical source for ${action}`,
    );
  }
  assert.deepEqual(
    [...listed].sort(),
    [...workflowActions].sort(),
    "THIRDPARTY.md must list exactly the GitHub Actions the workflows use",
  );
}
validateActionInventory(actionSection);
// The guard is proven by mutation, like the npm inventory above it.
for (const [mutation, expectedFailure] of [
  [actionSection.replace(/^\| actions\/checkout .*$/m, ""), /exactly the GitHub Actions/],
  [
    actionSection.replace(
      "https://github.com/actions/checkout",
      "https://example.invalid/actions/checkout",
    ),
    /canonical source/,
  ],
  [
    actionSection.replace(
      "| MIT        | https://github.com/actions/checkout",
      "| see the repo | https://github.com/actions/checkout",
    ),
    /license identifier/,
  ],
]) {
  assert.throws(
    () => validateActionInventory(mutation),
    expectedFailure,
    "the Actions inventory guard must reject a wrong name, license or source",
  );
}
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
