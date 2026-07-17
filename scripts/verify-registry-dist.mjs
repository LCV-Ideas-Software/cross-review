const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 30_000;
const ATTESTATION_MAX_ATTEMPTS = 12;
const ATTESTATION_RETRY_DELAY_MS = 10_000;
const RETRYABLE_ATTESTATION_STATUSES = new Set([404, 408, 425, 429]);
const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

// v4.0.8: package name + version are mandatory inputs supplied by the
// caller via PACKAGE_NAME and PACKAGE_VERSION env vars. This script no
// longer touches the local filesystem — npm itself populates
// `npm_package_name` and `npm_package_version` when invoked as
// `npm run release:verify-registry`, and the publish workflow passes
// the gate-resolved name/version explicitly. Eliminating the local
// file-data flow into outbound fetch removes the recurring
// `js/file-access-to-http` CodeQL false positive at the source.
const packageName = globalThis.process.env.PACKAGE_NAME || globalThis.process.env.npm_package_name;
const packageVersion =
  globalThis.process.env.PACKAGE_VERSION || globalThis.process.env.npm_package_version;

function requiredEnv(name) {
  const value = globalThis.process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} env var is required for fail-closed provenance verification.`);
  }
  return value;
}

// The registry's summary metadata proves only that an attestation was
// advertised. Bind the full SLSA statement to the immutable release identity
// that the publish gate approved before accepting it.
const expectedGitSha = requiredEnv("EXPECTED_GIT_SHA");
const expectedGitTag = requiredEnv("EXPECTED_GIT_TAG");
const expectedGitRepository = requiredEnv("EXPECTED_GIT_REPOSITORY");
const expectedGithubWorkflowPath = requiredEnv("EXPECTED_GITHUB_WORKFLOW_PATH");

if (!/^[a-f0-9]{40}$/i.test(expectedGitSha)) {
  throw new Error("EXPECTED_GIT_SHA must be a 40-character Git commit SHA.");
}
if (!expectedGitTag.startsWith("refs/tags/")) {
  throw new Error("EXPECTED_GIT_TAG must be a fully qualified Git tag ref.");
}
if (!expectedGitRepository.startsWith("https://github.com/")) {
  throw new Error("EXPECTED_GIT_REPOSITORY must be an HTTPS GitHub repository URL.");
}
if (!expectedGithubWorkflowPath.startsWith(".github/workflows/")) {
  throw new Error("EXPECTED_GITHUB_WORKFLOW_PATH must name a repository workflow file.");
}
const expectedGitDependencyUri = `git+${expectedGitRepository}@${expectedGitTag}`;

if (!packageName || typeof packageName !== "string") {
  throw new Error(
    "PACKAGE_NAME env var is required (or invoke via `npm run release:verify-registry` so npm injects npm_package_name).",
  );
}
if (!packageVersion || typeof packageVersion !== "string") {
  throw new Error(
    "PACKAGE_VERSION env var is required (or invoke via `npm run release:verify-registry` so npm injects npm_package_version).",
  );
}

const spec = `${packageName}@${packageVersion}`;

function registryPackagePath(name) {
  if (name.startsWith("@")) {
    return `@${encodeURIComponent(name.slice(1))}`;
  }
  return encodeURIComponent(name);
}

async function fetchVersionMetadata(name, version) {
  const url = `${NPM_REGISTRY_URL}/${registryPackagePath(name)}/${encodeURIComponent(version)}`;
  // v4.0.7: bound the npm registry lookup with an explicit 30 s timeout
  // so a slow/unreachable registry surfaces as a deterministic abort
  // instead of hanging the post-publish verifier until the workflow
  // timeout (`timeout-minutes: 60`).
  let response;
  try {
    response = await globalThis.fetch(url, {
      headers: {
        accept: "application/json",
      },
      signal: globalThis.AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (wrapped.name === "TimeoutError" || wrapped.name === "AbortError") {
      throw new Error(`npm registry lookup for ${spec} timed out after ${FETCH_TIMEOUT_MS} ms`, {
        cause: error,
      });
    }
    throw new Error(`npm registry lookup for ${spec} failed: ${wrapped.message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `npm registry lookup failed for ${spec}: HTTP ${response.status} ${response.statusText} ${body.slice(0, 240)}`,
    );
  }
  return response.json();
}

const metadata = await fetchVersionMetadata(packageName, packageVersion);
const dist = metadata.dist;

if (!dist || typeof dist !== "object") {
  throw new Error(`npm registry dist metadata for ${spec} is missing dist`);
}

for (const key of ["shasum", "integrity", "tarball"]) {
  if (!dist[key] || typeof dist[key] !== "string") {
    throw new Error(`npm registry dist metadata for ${spec} is missing dist.${key}`);
  }
}

const attestations = dist.attestations;
if (!attestations || typeof attestations !== "object") {
  throw new Error(`npm registry dist metadata for ${spec} is missing dist.attestations`);
}
if (typeof attestations.url !== "string") {
  throw new Error(`npm registry dist metadata for ${spec} has an invalid attestation URL`);
}
let attestationUrl;
try {
  // Follow npm/pacote's registry-provided-pathname contract, but assign the
  // pathname onto an already pinned registry URL. Passing a `//host/path`
  // pathname to the URL constructor would otherwise reinterpret it as a
  // protocol-relative cross-origin URL.
  const attestationPath = new URL(attestations.url).pathname;
  const pinnedAttestationUrl = new URL(`${NPM_REGISTRY_URL}/`);
  pinnedAttestationUrl.pathname = attestationPath;
  if (pinnedAttestationUrl.origin !== new URL(NPM_REGISTRY_URL).origin) {
    throw new Error("attestation URL escaped the configured registry origin");
  }
  attestationUrl = pinnedAttestationUrl.href;
} catch (error) {
  throw new Error(`npm registry dist metadata for ${spec} has an invalid attestation URL`, {
    cause: error,
  });
}
if (attestations.provenance?.predicateType !== SLSA_PROVENANCE_PREDICATE) {
  throw new Error(`npm registry dist metadata for ${spec} is missing SLSA provenance v1`);
}

const sleep = (delayMs) =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });

function expectedSlsaProvenance(document) {
  if (!Array.isArray(document?.attestations)) {
    throw new Error(`npm attestation document for ${spec} is missing an attestations array`);
  }

  const slsaAttestations = document.attestations.filter(
    (attestation) => attestation?.predicateType === SLSA_PROVENANCE_PREDICATE,
  );
  if (slsaAttestations.length === 0) {
    throw new Error(`npm attestation document for ${spec} is missing SLSA provenance v1`);
  }

  const workflowMatched = slsaAttestations.filter((attestation) => {
    const workflow = attestation?.predicate?.buildDefinition?.externalParameters?.workflow;
    return (
      workflow?.ref === expectedGitTag &&
      workflow?.repository === expectedGitRepository &&
      workflow?.path === expectedGithubWorkflowPath
    );
  });
  if (workflowMatched.length === 0) {
    throw new Error(
      `npm attestation document for ${spec} has no SLSA provenance from ${expectedGitRepository}/${expectedGithubWorkflowPath}@${expectedGitTag}`,
    );
  }

  const expectedAttestation = workflowMatched.find((attestation) =>
    attestation.predicate.buildDefinition.resolvedDependencies?.some(
      (dependency) =>
        dependency?.uri === expectedGitDependencyUri &&
        dependency?.digest?.gitCommit === expectedGitSha,
    ),
  );
  if (!expectedAttestation) {
    throw new Error(
      `npm attestation document for ${spec} has no SLSA provenance dependency ${expectedGitDependencyUri} at expected git commit ${expectedGitSha}`,
    );
  }
  return expectedAttestation;
}

async function fetchAttestationDocument(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTESTATION_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await globalThis.fetch(url, {
        headers: {
          accept: "application/json",
        },
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      lastError = new Error(`npm attestation lookup for ${spec} failed: ${wrapped.message}`, {
        cause: error,
      });
    }

    if (response?.ok) {
      try {
        const document = await response.json();
        return { document, provenance: expectedSlsaProvenance(document) };
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        lastError = new Error(
          `npm attestation document for ${spec} could not be parsed: ${wrapped.message}`,
          { cause: error },
        );
      }
    }

    const retryableHttpStatus =
      response &&
      (RETRYABLE_ATTESTATION_STATUSES.has(response.status) ||
        (response.status >= 500 && response.status <= 599));
    if (response && !response.ok && !retryableHttpStatus) {
      throw new Error(
        `npm attestation lookup failed for ${spec}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    if (response && !response.ok) {
      lastError = new Error(
        `npm attestation lookup failed for ${spec}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    if (attempt < ATTESTATION_MAX_ATTEMPTS) {
      globalThis.console.warn(
        `npm attestation lookup attempt ${attempt}/${ATTESTATION_MAX_ATTEMPTS} failed; retrying in ${ATTESTATION_RETRY_DELAY_MS} ms.`,
      );
      await sleep(ATTESTATION_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `npm attestation lookup for ${spec} failed after ${ATTESTATION_MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
    { cause: lastError },
  );
}

const { provenance } = await fetchAttestationDocument(attestationUrl);
const provenanceWorkflow = provenance.predicate.buildDefinition.externalParameters.workflow;

globalThis.console.log(
  JSON.stringify(
    {
      spec,
      shasum: dist.shasum,
      integrity: dist.integrity,
      tarball: dist.tarball,
      attestationUrl,
      provenancePredicateType: attestations.provenance.predicateType,
      provenanceGitCommit: expectedGitSha,
      provenanceWorkflow,
    },
    null,
    2,
  ),
);
