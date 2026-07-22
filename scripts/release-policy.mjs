import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
const NON_NUMERIC_IDENTIFIER = "[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const SEMVER_PATTERN = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$",
);
const DISPLAY_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const CANONICAL_SHA512_PAYLOAD = /^[A-Za-z0-9+/]{86}==$/;
const NPM_TAG_PATTERN = /^[A-Za-z][0-9A-Za-z._-]*$/;
const MINIMUM_SAFE_GH_RELEASE_VERIFIER_VERSION = "2.93.0";

export function parseSemVer(value) {
  if (typeof value !== "string") {
    throw new TypeError("SemVer must be a string");
  }

  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid SemVer: ${value || "<empty>"}`);
  }

  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? [],
    build: match[5]?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemVer(leftValue, rightValue) {
  const left = parseSemVer(leftValue);
  const right = parseSemVer(rightValue);

  for (const component of ["major", "minor", "patch"]) {
    if (left[component] < right[component]) return -1;
    if (left[component] > right[component]) return 1;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function assertSafeGitHubCliReleaseVerifierVersion(version) {
  try {
    parseSemVer(version);
  } catch {
    throw new Error(`Could not parse GitHub CLI version: ${version || "<empty>"}`);
  }
  if (compareSemVer(version, MINIMUM_SAFE_GH_RELEASE_VERIFIER_VERSION) < 0) {
    throw new Error(
      `GitHub CLI ${version} is unsafe for release attestation verification; ` +
        `CVE-2026-48501 requires ${MINIMUM_SAFE_GH_RELEASE_VERIFIER_VERSION} or newer`,
    );
  }
  return version;
}

export function assertExistingTagReleaseIdentity(snapshot, expectedReleaseId, expectedTag) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("GitHub Release snapshot must be an object");
  }
  if (String(snapshot.id ?? "") !== String(expectedReleaseId)) {
    throw new Error(
      `GitHub Release id changed from ${expectedReleaseId} to ${String(snapshot.id ?? "<missing>")}`,
    );
  }
  if (snapshot.tag_name !== expectedTag) {
    throw new Error(
      `GitHub Release tag changed from ${expectedTag} to ${String(snapshot.tag_name ?? "<missing>")}`,
    );
  }

  // GitHub documents target_commitish as unused when tag_name already exists.
  // The authenticated tag ref is the identity; callers validate that ref
  // independently and must not reinterpret a default-branch display value as
  // the historical release commit.
  return snapshot;
}

export function semVerFromDisplayTag(tag) {
  if (typeof tag !== "string") {
    throw new TypeError("Release tag must be a string");
  }
  const match = DISPLAY_TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`Invalid release tag: ${tag || "<empty>"}`);
  }

  const core = [match[1], match[2], match[3]]
    .map((component) => BigInt(component).toString())
    .join(".");
  const version = match[4] ? `${core}-${match[4]}` : core;
  parseSemVer(version);
  return version;
}

export function displayTagFromSemVer(version) {
  const parsed = parseSemVer(version);
  if (parsed.build.length > 0) {
    throw new Error("Release versions must not use SemVer build metadata");
  }
  const core = [parsed.major, parsed.minor, parsed.patch]
    .map((component) => component.toString().padStart(2, "0"))
    .join(".");
  const suffix = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : "";
  return `v${core}${suffix}`;
}

export function canonicalSha512Sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function assertCanonicalSha512Sri(value, label = "integrity") {
  if (typeof value !== "string" || !value.startsWith("sha512-")) {
    throw new Error(`${label} must be one canonical sha512 SRI token`);
  }
  const payload = value.slice("sha512-".length);
  if (!CANONICAL_SHA512_PAYLOAD.test(payload)) {
    throw new Error(`${label} is not canonical sha512 SRI`);
  }
  const digest = Buffer.from(payload, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== payload) {
    throw new Error(`${label} does not encode exactly one canonical SHA-512 digest`);
  }
  return digest;
}

export function verifySha512Sri(expected, actual, context = "published artifact") {
  const expectedDigest = assertCanonicalSha512Sri(expected, "expected integrity");
  const actualDigest = assertCanonicalSha512Sri(actual, `${context} integrity`);
  if (
    expectedDigest.length !== actualDigest.length ||
    !timingSafeEqual(expectedDigest, actualDigest)
  ) {
    throw new Error(`${context} SHA-512 SRI does not match the immutable artifact`);
  }
}

export function verifyFileSha512Sri(path, expected) {
  const actual = canonicalSha512Sri(readFileSync(path));
  verifySha512Sri(expected, actual, path);
}

function assertNpmTag(tag) {
  if (!NPM_TAG_PATTERN.test(tag) || /^v?\d+(?:\.\d+){0,2}(?:-|$)/i.test(tag)) {
    throw new Error(`Unsafe npm dist-tag: ${tag || "<empty>"}`);
  }
}

function parseStableLatest(version, label) {
  if (!version) return undefined;
  const parsed = parseSemVer(version);
  if (parsed.prerelease.length > 0) {
    throw new Error(`${label} must never point to prerelease ${version}`);
  }
  return parsed;
}

export function decideNpmPublishTag(candidateVersion, preferredTag, currentLatest = "") {
  const candidate = parseSemVer(candidateVersion);
  assertNpmTag(preferredTag);
  parseStableLatest(currentLatest, "Registry latest");

  if (candidate.prerelease.length > 0) {
    if (preferredTag === "latest") {
      throw new Error("A prerelease must never be published with the latest dist-tag");
    }
    return preferredTag;
  }

  if (preferredTag !== "latest") {
    throw new Error(
      `Stable release ${candidateVersion} must request latest before monotonic evaluation`,
    );
  }
  if (!currentLatest || compareSemVer(candidateVersion, currentLatest) >= 0) {
    return "latest";
  }
  return "historical";
}

export function assertRegistryLatest({
  candidateVersion,
  priorLatest = "",
  actualLatest = "",
  publishTag,
}) {
  const candidate = parseSemVer(candidateVersion);
  assertNpmTag(publishTag);
  parseStableLatest(priorLatest, "Prior registry latest");
  parseStableLatest(actualLatest, "Resulting registry latest");

  if (priorLatest) {
    if (!actualLatest || compareSemVer(actualLatest, priorLatest) < 0) {
      throw new Error(
        `Registry latest regressed from ${priorLatest} to ${actualLatest || "<missing>"}`,
      );
    }
  }

  if (candidate.prerelease.length > 0) {
    if (publishTag === "latest") {
      throw new Error("A prerelease was assigned the latest dist-tag");
    }
    return;
  }

  if (!actualLatest) {
    throw new Error(`Stable release ${candidateVersion} left registry latest unset`);
  }
  if (publishTag === "latest" && compareSemVer(actualLatest, candidateVersion) < 0) {
    throw new Error(
      `Registry latest ${actualLatest} did not reach stable release ${candidateVersion}`,
    );
  }
  if (publishTag !== "latest" && compareSemVer(candidateVersion, actualLatest) >= 0) {
    throw new Error(
      `Historical publish decision is inconsistent with registry latest ${actualLatest}`,
    );
  }
}

export function decideGitHubLatest(candidateVersion, currentLatestTag = "") {
  const candidate = parseSemVer(candidateVersion);
  if (candidate.prerelease.length > 0) return false;
  if (!currentLatestTag) return true;

  const currentLatest = semVerFromDisplayTag(currentLatestTag);
  parseStableLatest(currentLatest, "GitHub latest release");
  return compareSemVer(candidateVersion, currentLatest) >= 0;
}

export function assertGitHubLatest({
  candidateVersion,
  priorLatestTag = "",
  actualLatestTag = "",
  promoteLatest,
}) {
  const candidate = parseSemVer(candidateVersion);
  const priorLatest = priorLatestTag ? semVerFromDisplayTag(priorLatestTag) : "";
  const actualLatest = actualLatestTag ? semVerFromDisplayTag(actualLatestTag) : "";
  parseStableLatest(priorLatest, "Prior GitHub latest release");
  parseStableLatest(actualLatest, "Resulting GitHub latest release");

  if (priorLatest) {
    if (!actualLatest || compareSemVer(actualLatest, priorLatest) < 0) {
      throw new Error(
        `GitHub latest release regressed from ${priorLatestTag} to ${actualLatestTag || "<missing>"}`,
      );
    }
  }

  if (candidate.prerelease.length > 0) {
    if (promoteLatest) {
      throw new Error("A GitHub prerelease must never be promoted to latest");
    }
    return;
  }

  if (!actualLatest) {
    throw new Error(`Stable release ${candidateVersion} left GitHub latest unset`);
  }
  if (promoteLatest && compareSemVer(actualLatest, candidateVersion) < 0) {
    throw new Error(
      `GitHub latest ${actualLatestTag} did not reach stable release ${candidateVersion}`,
    );
  }
  if (!promoteLatest && compareSemVer(candidateVersion, actualLatest) >= 0) {
    throw new Error(
      `Non-latest release decision is inconsistent with GitHub latest ${actualLatestTag}`,
    );
  }
}

function requireArgument(args, index, name) {
  if (args[index] === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return args[index];
}

function runCli(args) {
  const command = requireArgument(args, 0, "command");
  if (command === "validate-semver") {
    parseSemVer(requireArgument(args, 1, "version"));
    return;
  }
  if (command === "display-tag") {
    console.log(displayTagFromSemVer(requireArgument(args, 1, "version")));
    return;
  }
  if (command === "verify-file-sri") {
    verifyFileSha512Sri(
      requireArgument(args, 1, "artifact path"),
      requireArgument(args, 2, "expected integrity"),
    );
    return;
  }
  if (command === "verify-sri") {
    verifySha512Sri(
      requireArgument(args, 1, "expected integrity"),
      requireArgument(args, 2, "actual integrity"),
      args[3] || "published artifact",
    );
    return;
  }
  if (command === "assert-safe-gh-release-verifier") {
    console.log(
      assertSafeGitHubCliReleaseVerifierVersion(requireArgument(args, 1, "GitHub CLI version")),
    );
    return;
  }
  if (command === "assert-existing-tag-release") {
    const snapshot = JSON.parse(
      readFileSync(resolve(requireArgument(args, 1, "release snapshot path")), "utf8"),
    );
    assertExistingTagReleaseIdentity(
      snapshot,
      requireArgument(args, 2, "release id"),
      requireArgument(args, 3, "release tag"),
    );
    return;
  }
  if (command === "npm-publish-tag") {
    console.log(
      decideNpmPublishTag(
        requireArgument(args, 1, "candidate version"),
        requireArgument(args, 2, "preferred dist-tag"),
        args[3] || "",
      ),
    );
    return;
  }
  if (command === "assert-registry-latest") {
    assertRegistryLatest({
      candidateVersion: requireArgument(args, 1, "candidate version"),
      priorLatest: args[2] || "",
      actualLatest: args[3] || "",
      publishTag: requireArgument(args, 4, "publish dist-tag"),
    });
    return;
  }
  if (command === "github-latest") {
    console.log(decideGitHubLatest(requireArgument(args, 1, "candidate version"), args[2] || ""));
    return;
  }
  if (command === "assert-github-latest") {
    assertGitHubLatest({
      candidateVersion: requireArgument(args, 1, "candidate version"),
      priorLatestTag: args[2] || "",
      actualLatestTag: args[3] || "",
      promoteLatest: requireArgument(args, 4, "latest decision") === "true",
    });
    return;
  }
  throw new Error(`Unknown release-policy command: ${command}`);
}

const directInvocation =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directInvocation) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
