import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 30_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageName = globalThis.process.env.PACKAGE_NAME || pkg.name;
const packageVersion = globalThis.process.env.PACKAGE_VERSION || pkg.version;
const spec = `${packageName}@${packageVersion}`;

function registryPackagePath(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("PACKAGE_NAME must be a non-empty string");
  }
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
