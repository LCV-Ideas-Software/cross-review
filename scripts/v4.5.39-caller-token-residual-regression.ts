import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureHostTokens,
  type HostTokensLoadDiagnostics,
  type HostTokensRecord,
  TOKEN_FILE_MANUAL_RECOVERY,
} from "../src/core/caller-tokens.js";

const fixtureRecord: HostTokensRecord = {
  filePath: "fixture",
  map: {} as HostTokensRecord["map"],
  generated_at: null,
};

test("a failed first load is never retried after a late existence probe", () => {
  let entryChecks = 0;
  let loadCalls = 0;
  let generateCalls = 0;

  const result = ensureHostTokens("fixture", {
    tokensFileEntryExists: () => {
      entryChecks += 1;
      return entryChecks > 1;
    },
    load: (_dataDir, diagnostics?: HostTokensLoadDiagnostics) => {
      loadCalls += 1;
      if (diagnostics) diagnostics.failure = "permission_denied";
      return null;
    },
    generate: () => {
      generateCalls += 1;
      return fixtureRecord;
    },
  });

  assert.equal(result, null);
  assert.equal(loadCalls, 1, "a failed permission recovery must not be repeated in one boot");
  assert.equal(generateCalls, 0, "a denied token entry must never be overwritten");
});

test("an entry that disappears between the precheck and load is regenerated safely", () => {
  let loadCalls = 0;
  let generateCalls = 0;

  const result = ensureHostTokens("fixture", {
    tokensFileEntryExists: () => true,
    load: (_dataDir, diagnostics?: HostTokensLoadDiagnostics) => {
      loadCalls += 1;
      if (diagnostics) diagnostics.failure = "missing";
      return null;
    },
    generate: () => {
      generateCalls += 1;
      return fixtureRecord;
    },
  });

  assert.equal(result, fixtureRecord);
  assert.equal(loadCalls, 1);
  assert.equal(generateCalls, 1, "a vanished entry must reach the exclusive-create path");
});

test("the manual Windows recovery block verifies the exact DACL before restart", () => {
  const setAccessControlIndex = TOKEN_FILE_MANUAL_RECOVERY.indexOf("SetAccessControl($acl)");
  const observedAclReadIndex = TOKEN_FILE_MANUAL_RECOVERY.indexOf("$observedAcl =");
  const observedProtectedCheckIndex = TOKEN_FILE_MANUAL_RECOVERY.indexOf(
    "$observedAcl.AreAccessRulesProtected",
  );
  const observedEmptyCheckIndex = TOKEN_FILE_MANUAL_RECOVERY.indexOf("$observedRules.Count -ne 0");
  const protectedAclCheckIndex = TOKEN_FILE_MANUAL_RECOVERY.indexOf(
    "AreAccessRulesProtected",
    setAccessControlIndex,
  );

  assert.ok(setAccessControlIndex >= 0, "the manual recipe must apply the replacement DACL");
  assert.ok(
    observedAclReadIndex >= 0 && observedAclReadIndex < setAccessControlIndex,
    "the manual recipe must inspect the existing descriptor before replacing it",
  );
  assert.ok(
    observedProtectedCheckIndex > observedAclReadIndex &&
      observedProtectedCheckIndex < setAccessControlIndex,
    "the manual recipe must require the observed descriptor to be protected",
  );
  assert.ok(
    observedEmptyCheckIndex > observedAclReadIndex &&
      observedEmptyCheckIndex < setAccessControlIndex,
    "the manual recipe must replace only the observed protected-empty interrupted state",
  );
  assert.ok(
    protectedAclCheckIndex > setAccessControlIndex,
    "the manual recipe must verify protection after applying the replacement DACL",
  );
  assert.ok(TOKEN_FILE_MANUAL_RECOVERY.includes("$rules.Count -ne $allowed.Count"));
  assert.ok(TOKEN_FILE_MANUAL_RECOVERY.includes("$seen.Add($sid)"));
  assert.ok(TOKEN_FILE_MANUAL_RECOVERY.includes("foreach ($required in $allowed)"));
  assert.ok(
    TOKEN_FILE_MANUAL_RECOVERY.indexOf("caller_tokens.loaded=true") > protectedAclCheckIndex,
    "restart guidance must follow successful descriptor verification",
  );
});
