import fs from "node:fs";
import path from "node:path";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";

function fail(message) {
  throw new Error(`Cannot create published-package signature-audit lock: ${message}`);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(
      `could not read ${label} at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must contain a JSON object`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot create")) throw error;
    fail(`could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} is required`);
  return value;
}

function stringMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const entries = Object.entries(value);
  if (!entries.every(([key, entry]) => typeof key === "string" && typeof entry === "string")) {
    fail(`${label} must contain only string values`);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function sameStringMap(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function packagePath(name) {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length !== 2 || !parts[1])
      fail(`invalid scoped package name ${JSON.stringify(name)}`);
    return `node_modules/${parts[0]}/${parts[1]}`;
  }
  if (!name || name.includes("/")) fail(`invalid package name ${JSON.stringify(name)}`);
  return `node_modules/${name}`;
}

const sourcePackageJsonPath = path.resolve(requiredArgument("--source-package-json"));
const sourcePackageLockPath = path.resolve(requiredArgument("--source-package-lock"));
const registryMetadataPath = path.resolve(requiredArgument("--registry-metadata"));
const outputDirectory = path.resolve(requiredArgument("--output-directory"));
const packageName = requiredArgument("--package-name");
const packageVersion = requiredArgument("--package-version");

const sourcePackage = readJson(sourcePackageJsonPath, "source package.json");
const sourceLock = readJson(sourcePackageLockPath, "source package-lock.json");
const registryMetadata = readJson(registryMetadataPath, "npm registry metadata");

if (sourcePackage.name !== packageName || sourcePackage.version !== packageVersion) {
  fail("source package identity does not match the protected release identity");
}
if (registryMetadata.name !== packageName || registryMetadata.version !== packageVersion) {
  fail("npm registry metadata does not match the protected release identity");
}
if (
  sourceLock.lockfileVersion !== 3 ||
  !sourceLock.packages ||
  typeof sourceLock.packages !== "object"
) {
  fail("source package-lock.json must be a complete lockfileVersion 3 lock");
}

const sourceRoot = sourceLock.packages[""];
if (!sourceRoot || typeof sourceRoot !== "object" || Array.isArray(sourceRoot)) {
  fail("source package-lock.json is missing its root package descriptor");
}

const sourceDependencies = stringMap(
  sourcePackage.dependencies,
  "source package runtime dependencies",
);
const lockedDependencies = stringMap(sourceRoot.dependencies, "source lock runtime dependencies");
const registryDependencies = stringMap(
  registryMetadata.dependencies,
  "npm registry runtime dependencies",
);
if (!sameStringMap(sourceDependencies, lockedDependencies)) {
  fail("source package.json runtime dependencies do not match the committed lockfile");
}
if (!sameStringMap(sourceDependencies, registryDependencies)) {
  fail("npm registry runtime dependencies do not match the protected source package");
}

const runtimeManifestFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "engines",
  "bin",
];
for (const field of runtimeManifestFields) {
  if (!sameJson(sourcePackage[field], registryMetadata[field])) {
    fail(`npm registry ${field} does not match the protected source package`);
  }
}

const dist = registryMetadata.dist;
if (!dist || typeof dist !== "object" || Array.isArray(dist)) {
  fail("npm registry metadata is missing dist metadata");
}
if (typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
  fail("npm registry metadata is missing dist.tarball or dist.integrity");
}

let tarballUrl;
try {
  tarballUrl = new URL(dist.tarball);
} catch (error) {
  fail(
    `npm registry dist.tarball is not a valid URL: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (tarballUrl.origin !== REGISTRY_ORIGIN || tarballUrl.protocol !== "https:") {
  fail("npm registry dist.tarball escaped the fixed HTTPS npmjs.org origin");
}
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) {
  fail("npm registry dist.integrity must be a sha512 SRI value");
}
if (Buffer.from(dist.integrity.slice("sha512-".length), "base64").length !== 64) {
  fail("npm registry dist.integrity has an invalid sha512 digest length");
}

const publishedEntry = cloneJson(sourceRoot);
delete publishedEntry.name;
delete publishedEntry.version;
delete publishedEntry.devDependencies;
publishedEntry.version = packageVersion;
publishedEntry.resolved = tarballUrl.href;
publishedEntry.integrity = dist.integrity;

const auditPackage = {
  name: "cross-review-published-package-signature-audit",
  version: "0.0.0",
  private: true,
  dependencies: {
    [packageName]: packageVersion,
  },
};
if (sourcePackage.overrides !== undefined) {
  auditPackage.overrides = cloneJson(sourcePackage.overrides);
}
const auditLock = {
  name: auditPackage.name,
  version: auditPackage.version,
  lockfileVersion: 3,
  requires: true,
  packages: cloneJson(sourceLock.packages),
};
auditLock.packages[""] = auditPackage;
auditLock.packages[packagePath(packageName)] = publishedEntry;

const publishedPackageRuntimeContract = {
  name: packageName,
  version: packageVersion,
  ...Object.fromEntries(
    runtimeManifestFields
      .filter((field) => sourcePackage[field] !== undefined)
      .map((field) => [field, canonicalJson(sourcePackage[field])]),
  ),
};

let directoryStats;
try {
  directoryStats = fs.statSync(outputDirectory);
} catch (error) {
  fail(
    `output directory does not exist: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!directoryStats.isDirectory()) fail("output directory is not a directory");

fs.writeFileSync(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(auditPackage, null, 2)}\n`,
  {
    encoding: "utf8",
    mode: 0o600,
  },
);
fs.writeFileSync(
  path.join(outputDirectory, "package-lock.json"),
  `${JSON.stringify(auditLock, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
fs.writeFileSync(
  path.join(outputDirectory, "published-package-runtime-contract.json"),
  `${JSON.stringify(publishedPackageRuntimeContract, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
