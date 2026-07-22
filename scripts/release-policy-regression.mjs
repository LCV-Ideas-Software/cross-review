import assert from "node:assert/strict";
import {
  assertCanonicalSha512Sri,
  assertExistingTagReleaseIdentity,
  assertGitHubLatest,
  assertRegistryLatest,
  assertSafeGitHubCliReleaseVerifierVersion,
  canonicalSha512Sri,
  compareSemVer,
  decideGitHubLatest,
  decideNpmPublishTag,
  displayTagFromSemVer,
  parseSemVer,
  semVerFromDisplayTag,
  verifySha512Sri,
} from "./release-policy.mjs";

const existingTagRelease = {
  id: 4242,
  tag_name: "v01.02.03",
  // This is the real API shape for an existing tag after main advances.
  // GitHub documents target_commitish as unused when the tag already exists.
  target_commitish: "main",
};
assert.equal(
  assertExistingTagReleaseIdentity(existingTagRelease, "4242", "v01.02.03"),
  existingTagRelease,
);
assert.throws(
  () => assertExistingTagReleaseIdentity(existingTagRelease, "4243", "v01.02.03"),
  /id changed/,
);
assert.throws(
  () => assertExistingTagReleaseIdentity(existingTagRelease, "4242", "v01.02.04"),
  /tag changed/,
);

assert.equal(assertSafeGitHubCliReleaseVerifierVersion("2.93.0"), "2.93.0");
assert.equal(assertSafeGitHubCliReleaseVerifierVersion("2.96.0"), "2.96.0");
assert.throws(() => assertSafeGitHubCliReleaseVerifierVersion("2.92.0"), /CVE-2026-48501/);
assert.throws(() => assertSafeGitHubCliReleaseVerifierVersion("unknown"), /Could not parse/);

assert.deepEqual(parseSemVer("1.2.3-rc.1+build.9").prerelease, ["rc", "1"]);
for (const invalid of ["01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2", ""]) {
  assert.throws(() => parseSemVer(invalid), /Invalid SemVer/);
}

const ordered = [
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-alpha.beta",
  "1.0.0-beta",
  "1.0.0-beta.2",
  "1.0.0-beta.11",
  "1.0.0-rc.1",
  "1.0.0",
  "1.0.1",
  "1.1.0",
  "2.0.0",
];
for (let index = 1; index < ordered.length; index += 1) {
  assert.ok(compareSemVer(ordered[index - 1], ordered[index]) < 0);
  assert.ok(compareSemVer(ordered[index], ordered[index - 1]) > 0);
}
assert.equal(compareSemVer("1.2.3+first", "1.2.3+second"), 0);

assert.equal(semVerFromDisplayTag("v01.02.03"), "1.2.3");
assert.equal(semVerFromDisplayTag("v01.02.03-rc.2"), "1.2.3-rc.2");
assert.equal(displayTagFromSemVer("1.2.3"), "v01.02.03");
assert.equal(
  displayTagFromSemVer("12345678901234567890.2.3-rc.2"),
  "v12345678901234567890.02.03-rc.2",
);
assert.throws(() => displayTagFromSemVer("1.2.3+build.1"), /build metadata/);
assert.throws(() => semVerFromDisplayTag("v01.02.03-01"), /Invalid SemVer/);

const integrity = canonicalSha512Sri(Buffer.from("immutable tarball"));
assert.equal(assertCanonicalSha512Sri(integrity).length, 64);
assert.throws(() => assertCanonicalSha512Sri("sha256-deadbeef"), /sha512/);
assert.throws(() => assertCanonicalSha512Sri("sha512-Zm9v"), /canonical/);
assert.throws(
  () => verifySha512Sri(integrity, canonicalSha512Sri(Buffer.from("different"))),
  /does not match/,
);
assert.doesNotThrow(() => verifySha512Sri(integrity, integrity));

assert.equal(decideNpmPublishTag("1.2.3", "latest", ""), "latest");
assert.equal(decideNpmPublishTag("1.2.3", "latest", "1.2.2"), "latest");
assert.equal(decideNpmPublishTag("1.2.3", "latest", "1.2.3"), "latest");
assert.equal(decideNpmPublishTag("1.2.2", "latest", "1.2.3"), "historical");
assert.equal(decideNpmPublishTag("1.3.0-rc.1", "rc", "1.2.3"), "rc");
assert.throws(() => decideNpmPublishTag("1.3.0-rc.1", "latest", "1.2.3"), /prerelease/);
assert.throws(
  () => decideNpmPublishTag("1.3.0", "latest", "1.4.0-rc.1"),
  /must never point to prerelease/,
);

assert.doesNotThrow(() =>
  assertRegistryLatest({
    candidateVersion: "1.3.0",
    priorLatest: "1.2.0",
    actualLatest: "1.4.0",
    publishTag: "latest",
  }),
);
assert.throws(
  () =>
    assertRegistryLatest({
      candidateVersion: "1.1.0",
      priorLatest: "1.2.0",
      actualLatest: "1.1.0",
      publishTag: "historical",
    }),
  /regressed/,
);
assert.throws(
  () =>
    assertRegistryLatest({
      candidateVersion: "1.3.0-rc.1",
      priorLatest: "1.2.0",
      actualLatest: "1.3.0-rc.1",
      publishTag: "rc",
    }),
  /must never point to prerelease/,
);

assert.equal(decideGitHubLatest("1.3.0", "v01.02.00"), true);
assert.equal(decideGitHubLatest("1.2.0", "v01.03.00"), false);
assert.equal(decideGitHubLatest("1.3.0-rc.1", "v01.02.00"), false);
assert.doesNotThrow(() =>
  assertGitHubLatest({
    candidateVersion: "1.3.0",
    priorLatestTag: "v01.02.00",
    actualLatestTag: "v01.04.00",
    promoteLatest: true,
  }),
);
assert.throws(
  () =>
    assertGitHubLatest({
      candidateVersion: "1.1.0",
      priorLatestTag: "v01.02.00",
      actualLatestTag: "v01.01.00",
      promoteLatest: false,
    }),
  /regressed/,
);

console.log("release-policy-regression: ok");
