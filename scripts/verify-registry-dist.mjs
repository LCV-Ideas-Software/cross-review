import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
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
  const response = await globalThis.fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
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
