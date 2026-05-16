const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 30_000;

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

globalThis.console.log(
  JSON.stringify(
    {
      spec,
      shasum: dist.shasum,
      integrity: dist.integrity,
      tarball: dist.tarball,
    },
    null,
    2,
  ),
);
