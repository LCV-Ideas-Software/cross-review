import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureHostTokens,
  executeWindowsTokensFileAclCommands,
  getTokenFileRecoveryGuidance,
  getWindowsCurrentUserSid,
  getWindowsTokensFileAclCommands,
  getWindowsTokensFileAclVerificationCommand,
  getWindowsTokensFileCreationCommand,
  getWindowsTokensFileProtectedEmptyDaclRecoveryCommand,
  type HostTokensLoadDiagnostics,
  loadHostTokens,
  openTokensFileWithPermissionRecovery,
  TOKEN_FILE_HARDENING_FAILED_MANUAL_RECOVERY,
  TOKEN_FILE_MANUAL_RECOVERY,
  verifyTokenForCaller,
  WINDOWS_CURRENT_USER_SID_SPAWN_TIMEOUT_MS,
  WINDOWS_TOKENS_FILE_ACL_SPAWN_TIMEOUT_MS,
  type WindowsTokensFileAclExecutionDiagnostics,
} from "../src/core/caller-tokens.js";

const ciWorkflow = fs.readFileSync(
  path.join(process.cwd(), ".github", "workflows", "ci.yml"),
  "utf8",
);
const windowsJobStart = ciWorkflow.indexOf("  caller-token-acl-windows:");
const windowsJobEnd = ciWorkflow.indexOf("\nconcurrency:", windowsJobStart);
assert.ok(windowsJobStart >= 0 && windowsJobEnd > windowsJobStart, "Windows ACL job must exist");
const windowsJob = ciWorkflow.slice(windowsJobStart, windowsJobEnd);
assert.match(
  windowsJob,
  /^ {4}permissions:\r?\n {6}contents: read\s*$/m,
  "the read-only Windows regression job must request only repository contents",
);
assert.doesNotMatch(
  windowsJob,
  /^ {4}permissions: write-all\s*$/m,
  "the new Windows regression job must not inherit the workflow-wide write token",
);

const portablePlan = getWindowsTokensFileAclCommands("<token-file>", "S-1-5-21-1000");
assert.equal(
  portablePlan.length,
  1,
  "production ACL replacement must have one external-process interruption boundary",
);
// Issue #209: the executable must be the absolute System32 engine — PATH
// resolution let GNU coreutils' whoami/other shadows (Git Bash parents) or a
// writable PATH entry substitute the security-critical tool.
assert.match(
  portablePlan[0]?.executable ?? "",
  /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i,
  "ACL commands must invoke the absolute System32 PowerShell engine",
);
const portableCreation = getWindowsTokensFileCreationCommand("<token-file>", "S-1-5-21-1000");
const portableCreationScript = portableCreation.args[4] ?? "";
assert.match(portableCreationScript, /FileMode\]::CreateNew/);
assert.match(portableCreationScript, /FileOptions\]::None, \$acl/);
assert.match(portableCreationScript, /FileShare\]::None/);
assert.match(portableCreationScript, /\$stream\.GetAccessControl/);
assert.doesNotMatch(JSON.stringify(portableCreation.args), /<token-file>|S-1-5-21-1000/);
assert.deepEqual(JSON.parse(portableCreation.input ?? "{}"), {
  Path: "<token-file>",
  CurrentUserSid: "S-1-5-21-1000",
});
const portableReplacementScript = portablePlan[0]?.args[4] ?? "";
const portableVerificationScript =
  getWindowsTokensFileAclVerificationCommand("<token-file>", "S-1-5-21-1000").args[4] ?? "";
const portableRecoveryCommand = getWindowsTokensFileProtectedEmptyDaclRecoveryCommand(
  "<token-file>",
  "S-1-5-21-1000",
);
const portableRecoveryScript = portableRecoveryCommand.args[4] ?? "";
assert.match(portableReplacementScript, /FileSecurity/);
assert.match(portableReplacementScript, /SetAccessRuleProtection\(\$true, \$false\)/);
assert.match(portableReplacementScript, /SetAccessControl/);
assert.match(
  portableReplacementScript,
  /HashSet\[string\]/,
  "ACL application must deduplicate required SIDs when the host identity is SYSTEM or Administrators",
);
assert.match(portableVerificationScript, /\$seen\.Add\(\$sid\)/);
assert.match(portableVerificationScript, /\$allowed\.Contains\(\$sid\)/);
assert.match(portableVerificationScript, /foreach \(\$required in \$allowed\)/);
assert.ok(
  portableRecoveryScript.indexOf("AreAccessRulesProtected") <
    portableRecoveryScript.indexOf("SetAccessControl"),
  "recovery must validate the protected descriptor before replacing it",
);
assert.ok(
  portableRecoveryScript.indexOf("$observedRules.Count -ne 0") <
    portableRecoveryScript.indexOf("SetAccessControl"),
  "recovery must reject every non-empty DACL before replacement",
);
assert.doesNotMatch(
  JSON.stringify(portableRecoveryCommand.args),
  /<token-file>|S-1-5-21-1000/,
  "recovery path and SID must never enter PowerShell's command text or argv parser",
);
assert.doesNotMatch(
  JSON.stringify(portablePlan[0]?.args),
  /<token-file>|S-1-5-21-1000/,
  "path and SID must never enter PowerShell's command text or argv parser",
);
assert.deepEqual(JSON.parse(portablePlan[0]?.input ?? "{}"), {
  Path: "<token-file>",
  CurrentUserSid: "S-1-5-21-1000",
});
assert.doesNotMatch(
  portableReplacementScript,
  /icacls|\/reset|\/inheritance:r/,
  "production replacement must not recreate a broad or empty intermediate DACL",
);

// PR #208 review threads (routing, TOCTOU binding, exact-ACE comparison):
// hardening failures leave an indeterminate DACL, so they must never route to
// the protected-empty recovery recipe that refuses every such state; both
// manual recipes must bind the final descriptor to one exclusively held
// handle; and every rights check must compare the complete ACE value instead
// of a FullControl subset.
assert.equal(
  getTokenFileRecoveryGuidance({ failure: "permission_denied", platform: "win32" }),
  TOKEN_FILE_MANUAL_RECOVERY,
  "permission_denied must keep routing to the protected-empty recovery recipe",
);
assert.equal(
  getTokenFileRecoveryGuidance({ failure: "permission_hardening_failed", platform: "win32" }),
  TOKEN_FILE_HARDENING_FAILED_MANUAL_RECOVERY,
  "permission_hardening_failed must route to its dedicated recovery recipe",
);
assert.notEqual(
  TOKEN_FILE_HARDENING_FAILED_MANUAL_RECOVERY,
  TOKEN_FILE_MANUAL_RECOVERY,
  "the hardening-failure recipe must not reuse the protected-empty precondition",
);
const manualRecipeBlock = TOKEN_FILE_MANUAL_RECOVERY.match(/`([^`]+)`/)?.[1] ?? "";
const hardeningRecipeBlock =
  TOKEN_FILE_HARDENING_FAILED_MANUAL_RECOVERY.match(/`([^`]+)`/)?.[1] ?? "";
assert.ok(manualRecipeBlock, "manual recovery guidance must contain one PowerShell block");
assert.ok(hardeningRecipeBlock, "hardening recovery guidance must contain one PowerShell block");
assert.match(
  manualRecipeBlock,
  /expected protected empty DACL/,
  "permission_denied recovery must keep requiring the quarantined protected-empty state",
);
assert.doesNotMatch(
  hardeningRecipeBlock,
  /expected protected empty DACL/,
  "hardening failures leave an indeterminate DACL; requiring protected-empty always refuses",
);
for (const [recipeLabel, recipeBlock] of [
  ["permission_denied", manualRecipeBlock],
  ["permission_hardening_failed", hardeningRecipeBlock],
] as const) {
  assert.match(
    recipeBlock,
    /ReparsePoint/,
    `${recipeLabel} recovery must refuse reparse-point entries before touching the DACL`,
  );
  assert.match(
    recipeBlock,
    /'ReadData, ReadPermissions, ChangePermissions'/,
    `${recipeLabel} recovery must open one handle carrying WRITE_DAC (ChangePermissions)`,
  );
  assert.match(
    recipeBlock,
    /FileShare\]::None/,
    `${recipeLabel} recovery must hold the handle exclusively while verifying`,
  );
  assert.match(
    recipeBlock,
    /SetAccessControl\(\$stream, \$acl\)/,
    `${recipeLabel} recovery must re-apply the descriptor through the held handle`,
  );
  assert.match(
    recipeBlock,
    /\$rule\.FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/,
    `${recipeLabel} recovery must compare the complete ACE rights value`,
  );
  assert.doesNotMatch(
    recipeBlock,
    /-band \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/,
    `${recipeLabel} recovery must not accept a FullControl superset ACE`,
  );
}
assert.match(
  portableVerificationScript,
  /\$rule\.FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/,
  "production verification must compare the complete ACE rights value (exit 16)",
);
assert.doesNotMatch(
  portableVerificationScript,
  /-band \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/,
  "production verification must not accept a FullControl superset ACE",
);
let failedExecutionCalls = 0;
assert.equal(
  executeWindowsTokensFileAclCommands(portablePlan, () => {
    failedExecutionCalls += 1;
    return { status: 1 };
  }),
  false,
  "ACL replacement failure must fail closed",
);
assert.equal(failedExecutionCalls, 1, "failed ACL replacement must not be retried");
let spawnErrorCalls = 0;
assert.equal(
  executeWindowsTokensFileAclCommands(portablePlan, () => {
    spawnErrorCalls += 1;
    return { status: null, error: new Error("fixture interrupted") };
  }),
  false,
  "interrupted ACL replacement process must fail closed",
);
assert.equal(spawnErrorCalls, 1, "interrupted ACL replacement must not be retried");
assert.equal(
  executeWindowsTokensFileAclCommands(portablePlan, () => ({ status: 0 })),
  true,
  "the atomic ACL replacement must succeed only when its process succeeds",
);

// Issue #209: an executor timeout is an infrastructure failure and must be
// classified as such — never surfaced as a security policy rejection.
const timeoutDiagnostics: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  executeWindowsTokensFileAclCommands(
    portablePlan,
    () => ({
      status: null,
      error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
    }),
    timeoutDiagnostics,
  ),
  false,
  "an executor timeout must still fail closed",
);
assert.equal(
  timeoutDiagnostics.failure?.kind,
  "timeout",
  "an executor timeout must be classified as timeout, not policy rejection",
);
const exitDiagnostics: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  executeWindowsTokensFileAclCommands(portablePlan, () => ({ status: 12 }), exitDiagnostics),
  false,
  "a non-zero exit must still fail closed",
);
assert.equal(exitDiagnostics.failure?.kind, "exit_status");
assert.equal(exitDiagnostics.failure?.status, 12);
// Cold-start floor on hosted runners: the first powershell.exe spawn of a
// process can exceed 10s under load (observed twice on 20/08 runs), so the
// one-shot boot spawns must allow generous ceilings while staying fail-closed.
assert.ok(
  WINDOWS_TOKENS_FILE_ACL_SPAWN_TIMEOUT_MS >= 60_000,
  "ACL spawn timeout must absorb PowerShell cold start on loaded runners",
);
assert.ok(
  WINDOWS_CURRENT_USER_SID_SPAWN_TIMEOUT_MS >= 15_000,
  "whoami spawn timeout must absorb process cold start on loaded runners",
);

// Issue #209 (round 2): the SID lookup must classify its own failure causes so
// stage=sid carries the same failure-kind detail as apply/verify.
const sidTimeout: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  getWindowsCurrentUserSid(sidTimeout, () => ({
    status: null,
    error: Object.assign(new Error("spawnSync whoami.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
  })),
  null,
  "an identity lookup timeout must fail closed",
);
assert.equal(sidTimeout.failure?.kind, "timeout", "identity timeout must be classified");
const sidExit: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  getWindowsCurrentUserSid(sidExit, () => ({ status: 1, stdout: "" })),
  null,
);
assert.equal(sidExit.failure?.kind, "exit_status");
assert.equal(sidExit.failure?.status, 1);
const sidSpawnError: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  getWindowsCurrentUserSid(sidSpawnError, () => ({
    status: null,
    error: Object.assign(new Error("spawnSync whoami.exe EACCES"), { code: "EACCES" }),
  })),
  null,
  "a non-timeout spawn error must fail closed",
);
assert.equal(sidSpawnError.failure?.kind, "spawn_error");
assert.equal(sidSpawnError.failure?.code, "EACCES");
const sidCodelessError: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  getWindowsCurrentUserSid(sidCodelessError, () => ({
    status: null,
    error: new Error("fixture interrupted"),
  })),
  null,
  "a codeless spawn error must fail closed",
);
assert.equal(
  sidCodelessError.failure?.kind,
  "spawn_error",
  "a spawn error without a code must still be classified as spawn_error",
);
const sidGarbage: WindowsTokensFileAclExecutionDiagnostics = {};
assert.equal(
  getWindowsCurrentUserSid(sidGarbage, () => ({ status: 0, stdout: "no sid here" })),
  null,
);
assert.equal(
  sidGarbage.failure?.kind,
  "invalid_output",
  "unparseable identity output must be classified distinctly",
);
assert.equal(
  getWindowsCurrentUserSid(undefined, () => ({ status: 0, stdout: '"user","S-1-5-21-1000"' })),
  "S-1-5-21-1000",
  "a valid identity row must still parse",
);

const fakeIdentity = { dev: 1n, ino: 2n };
let normalOpenChecks = 0;
assert.deepEqual(
  openTokensFileWithPermissionRecovery("fixture", {
    platform: "win32",
    captureSafeIdentity: () => fakeIdentity,
    openFile: () => 70,
    openedFileMatchesIdentity: (_filePath, fd, expected) => {
      normalOpenChecks += 1;
      assert.equal(fd, 70);
      assert.equal(expected, fakeIdentity);
      return true;
    },
  }),
  { fd: 70, permissionsHardened: false },
  "an ordinary Windows open must return only the pre-bound regular identity",
);
assert.equal(normalOpenChecks, 1);
let normalMismatchCloseCalls = 0;
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      captureSafeIdentity: () => fakeIdentity,
      openFile: () => 70,
      openedFileMatchesIdentity: () => false,
      closeFile: () => {
        normalMismatchCloseCalls += 1;
      },
    }),
  /identity changed during open/,
);
assert.equal(normalMismatchCloseCalls, 1, "a replaced ordinary entry must close its descriptor");
const eacces = (): NodeJS.ErrnoException =>
  Object.assign(new Error("fixture access denied"), { code: "EACCES" });
let portableOpenCalls = 0;
let portableHardenCalls = 0;
const portableRecovered = openTokensFileWithPermissionRecovery("fixture", {
  platform: "win32",
  openFile: () => {
    portableOpenCalls += 1;
    if (portableOpenCalls === 1) throw eacces();
    return 71;
  },
  repairProtectedEmptyDacl: () => {
    portableHardenCalls += 1;
    return true;
  },
  captureSafeIdentity: () => fakeIdentity,
  openedFileMatchesIdentity: () => true,
});
assert.deepEqual(portableRecovered, { fd: 71, permissionsHardened: true });
assert.equal(portableOpenCalls, 2, "portable EACCES recovery must attempt exactly one reopen");
assert.equal(portableHardenCalls, 1, "portable EACCES recovery must harden exactly once");

let persistentOpenCalls = 0;
let persistentHardenCalls = 0;
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      openFile: () => {
        persistentOpenCalls += 1;
        throw eacces();
      },
      repairProtectedEmptyDacl: () => {
        persistentHardenCalls += 1;
        return true;
      },
      captureSafeIdentity: () => fakeIdentity,
      openedFileMatchesIdentity: () => true,
    }),
  /fixture access denied/,
  "persistent EACCES must remain fail-closed",
);
assert.equal(persistentOpenCalls, 2, "persistent EACCES must not loop beyond one reopen");
assert.equal(persistentHardenCalls, 1, "persistent EACCES must not reharden in a loop");

let unrelatedDenyRepairCalls = 0;
const unrelatedDenyOperations = {
  platform: "win32" as const,
  openFile: () => {
    throw eacces();
  },
  repairProtectedEmptyDacl: () => {
    unrelatedDenyRepairCalls += 1;
    return false;
  },
  captureSafeIdentity: () => fakeIdentity,
};
assert.throws(
  () => openTokensFileWithPermissionRecovery("fixture", unrelatedDenyOperations),
  /fixture access denied/,
  "an unrelated Windows denial must remain fail-closed",
);
assert.equal(
  unrelatedDenyRepairCalls,
  1,
  "Windows denial recovery must inspect and repair only the protected-empty-DACL state",
);

let ensureLoadCalls = 0;
let ensureGenerateCalls = 0;
assert.equal(
  ensureHostTokens("fixture", {
    load: () => {
      ensureLoadCalls += 1;
      return null;
    },
    generate: () => {
      ensureGenerateCalls += 1;
      return null;
    },
    tokensFileEntryExists: () => true,
  }),
  null,
  "an existing failed token entry must remain fail-closed",
);
assert.equal(ensureLoadCalls, 1, "one ensure boot must not repeat permission recovery");
assert.equal(ensureGenerateCalls, 0, "an existing failed token entry must never be overwritten");

let raceLoadCalls = 0;
let raceGenerateCalls = 0;
assert.equal(
  ensureHostTokens("fixture", {
    load: () => {
      raceLoadCalls += 1;
      return null;
    },
    generate: () => {
      raceGenerateCalls += 1;
      return null;
    },
    tokensFileEntryExists: () => false,
  }),
  null,
  "a concurrent-create race may perform one final load",
);
assert.equal(raceLoadCalls, 2, "only the genuine concurrent-create path may load twice");
assert.equal(raceGenerateCalls, 1, "the concurrent-create path must attempt generation once");

let appearedLoadCalls = 0;
let appearedEntryChecks = 0;
let appearedGenerateCalls = 0;
const appearedRecord = {
  filePath: "fixture",
  map: {} as never,
  generated_at: null,
};
assert.deepEqual(
  ensureHostTokens("fixture", {
    load: () => {
      appearedLoadCalls += 1;
      return appearedLoadCalls === 1 ? null : appearedRecord;
    },
    generate: () => {
      appearedGenerateCalls += 1;
      throw new Error("generation must not run after a concurrently created entry is observed");
    },
    tokensFileEntryExists: () => {
      appearedEntryChecks += 1;
      return appearedEntryChecks >= 2;
    },
  }),
  appearedRecord,
  "a token file created between the initial load and the post-load existence check must be loaded",
);
assert.equal(appearedEntryChecks, 2, "the concurrent-appearance path must bracket the first load");
assert.equal(
  appearedLoadCalls,
  2,
  "the newly appeared valid entry must receive one bounded reload",
);
assert.equal(appearedGenerateCalls, 0, "a newly appeared entry must be loaded before generation");

for (const platform of ["linux", "darwin"] as const) {
  let hardenCalls = 0;
  assert.throws(
    () =>
      openTokensFileWithPermissionRecovery("fixture", {
        platform,
        openFile: () => {
          throw eacces();
        },
        repairProtectedEmptyDacl: () => {
          hardenCalls += 1;
          return true;
        },
      }),
    /fixture access denied/,
    `${platform} EACCES must not trigger pathname chmod recovery`,
  );
  assert.equal(hardenCalls, 0, `${platform} EACCES must fail before pathname hardening`);
}

let otherErrorHardenCalls = 0;
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      openFile: () => {
        throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      },
      captureSafeIdentity: () => fakeIdentity,
      repairProtectedEmptyDacl: () => {
        otherErrorHardenCalls += 1;
        return true;
      },
    }),
  /fixture missing/,
  "non-permission open errors must remain fail-closed",
);
assert.equal(otherErrorHardenCalls, 0, "non-permission errors must not alter ACLs");

let unsafePathHardenCalls = 0;
let unsafePathOpenCalls = 0;
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      openFile: () => {
        unsafePathOpenCalls += 1;
        throw eacces();
      },
      repairProtectedEmptyDacl: () => {
        unsafePathHardenCalls += 1;
        return true;
      },
      captureSafeIdentity: () => null,
    }),
  /unsafe token entry/,
  "symlink, reparse, non-file or uninspectable paths must not be opened or repaired",
);
assert.equal(unsafePathHardenCalls, 0, "unsafe paths must fail before ACL mutation");
assert.equal(unsafePathOpenCalls, 0, "unsafe paths must fail before any descriptor open");

let mismatchCloseCalls = 0;
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      openFile: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls === 1) throw eacces();
          return 72;
        };
      })(),
      repairProtectedEmptyDacl: () => true,
      captureSafeIdentity: () => fakeIdentity,
      openedFileMatchesIdentity: () => false,
      closeFile: () => {
        mismatchCloseCalls += 1;
      },
    }),
  /identity changed during permission recovery/,
  "a path identity swap during recovery must fail closed",
);
assert.equal(mismatchCloseCalls, 1, "identity mismatch must close the recovered descriptor");

const previousPortableToken = process.env.CROSS_REVIEW_CALLER_TOKEN;
const previousPortablePath = process.env.CROSS_REVIEW_TOKENS_FILE;
const sentinelToken = "sentinel-token-value-that-must-not-leak";
const sentinelPath = "C:\\private-sentinel\\token-file.json";
process.env.CROSS_REVIEW_CALLER_TOKEN = sentinelToken;
process.env.CROSS_REVIEW_TOKENS_FILE = sentinelPath;
let recoveryMessage = "";
try {
  verifyTokenForCaller("codex", null, {
    failure: "permission_denied",
    platform: "win32",
  });
} catch (error: unknown) {
  recoveryMessage = String((error as Error).message);
}
assert.doesNotMatch(recoveryMessage, /\/reset|\/grant:r|\/inheritance:r/);
assert.match(recoveryMessage, /FileSecurity/);
assert.match(recoveryMessage, /SetAccessControl/);
assert.match(recoveryMessage, /stop the MCP host/);
assert.match(recoveryMessage, /restart the host/);
assert.match(recoveryMessage, /server_info.*caller_tokens\.loaded=true/);
assert.doesNotMatch(recoveryMessage, new RegExp(sentinelToken));
assert.doesNotMatch(recoveryMessage, /private-sentinel/i);

let invalidContentMessage = "";
try {
  verifyTokenForCaller("codex", null, {
    failure: "invalid_content",
    platform: "win32",
  });
} catch (error: unknown) {
  invalidContentMessage = String((error as Error).message);
}
assert.match(invalidContentMessage, /invalid content/i);
assert.match(invalidContentMessage, /known-good|generate a new/i);
assert.doesNotMatch(
  invalidContentMessage,
  /FileSecurity|SetAccessControl/,
  "invalid JSON must not suggest Windows ACL replacement",
);

let posixPermissionMessage = "";
try {
  verifyTokenForCaller("codex", null, {
    failure: "permission_denied",
    platform: "linux",
  });
} catch (error: unknown) {
  posixPermissionMessage = String((error as Error).message);
}
assert.match(posixPermissionMessage, /chmod 600/);
assert.doesNotMatch(
  posixPermissionMessage,
  /FileSecurity|SetAccessControl/,
  "POSIX access denial must not suggest Windows ACL replacement",
);
if (previousPortableToken === undefined) delete process.env.CROSS_REVIEW_CALLER_TOKEN;
else process.env.CROSS_REVIEW_CALLER_TOKEN = previousPortableToken;
if (previousPortablePath === undefined) delete process.env.CROSS_REVIEW_TOKENS_FILE;
else process.env.CROSS_REVIEW_TOKENS_FILE = previousPortablePath;

const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v4537-invalid-token-"));
const invalidPath = path.join(invalidRoot, "host-tokens.json");
const previousInvalidPath = process.env.CROSS_REVIEW_TOKENS_FILE;
try {
  process.env.CROSS_REVIEW_TOKENS_FILE = invalidPath;
  assert.ok(
    ensureHostTokens(invalidRoot),
    "invalid-content fixture must begin with the production-hardened ACL",
  );
  fs.writeFileSync(invalidPath, "{invalid-json", "utf8");
  const diagnostics: HostTokensLoadDiagnostics = { failure: null };
  assert.equal(loadHostTokens(invalidRoot, diagnostics), null);
  assert.equal(
    diagnostics.failure,
    "invalid_content",
    "invalid JSON must be classified independently from permission failures",
  );
} finally {
  if (previousInvalidPath === undefined) delete process.env.CROSS_REVIEW_TOKENS_FILE;
  else process.env.CROSS_REVIEW_TOKENS_FILE = previousInvalidPath;
  fs.rmSync(invalidRoot, { recursive: true, force: true });
}

if (process.platform !== "win32") {
  console.log(
    "[v4.5.37-caller-token-acl-regression] PASS: portable planner/retry/redaction contracts; SKIP: live Windows ACL contract",
  );
  process.exit(0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v4537-token-acl-"));
const tokenPath = path.join(tmpRoot, "host;tokens.json");
const previousTokensFile = process.env.CROSS_REVIEW_TOKENS_FILE;
process.env.CROSS_REVIEW_TOKENS_FILE = tokenPath;

const runIcacls = (args: readonly string[]): void => {
  const result = spawnSync("icacls.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, "ACL fixture command must succeed");
  assert.equal(result.error, undefined, "ACL fixture command must not report a spawn error");
};

try {
  const pwshProbe = spawnSync(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    },
  );
  assert.equal(
    pwshProbe.status,
    0,
    "PowerShell 7 must be available for the supported-engine regression",
  );
  assert.ok(
    Number.parseInt(pwshProbe.stdout.trim(), 10) >= 7,
    "pwsh.exe must resolve to PowerShell 7+",
  );

  const windowsPowerShell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : null;
  assert.ok(
    windowsPowerShell && fs.existsSync(windowsPowerShell),
    "Windows PowerShell 5.1 must be available for the supported-engine regression",
  );
  if (!windowsPowerShell) throw new Error("Windows PowerShell 5.1 path is unavailable");
  const windowsPowerShellProbe = spawnSync(
    windowsPowerShell,
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  assert.equal(windowsPowerShellProbe.status, 0, "Windows PowerShell version probe must succeed");
  assert.match(
    windowsPowerShellProbe.stdout.trim(),
    /^5\.1(?:\.|$)/,
    "the legacy engine must be 5.1",
  );

  assert.ok(ensureHostTokens(tmpRoot), "fixture token file must be generated");

  const systemWhoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  const identity = spawnSync(systemWhoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const currentUserSid = identity.stdout?.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  assert.equal(identity.status, 0, "Windows identity fixture must succeed");
  assert.ok(currentUserSid, "Windows identity fixture must return a SID");
  if (!currentUserSid) throw new Error("Windows identity fixture did not return a SID");

  const writeOrderRoot = path.join(tmpRoot, "write-order");
  fs.mkdirSync(writeOrderRoot);
  runIcacls([writeOrderRoot, "/grant", "*S-1-1-0:(OI)(CI)(RX)"]);
  const writeOrderPath = path.join(writeOrderRoot, "host-tokens.json");
  const originalWriteFile = fs.writeFileSync;
  const originalWrite = fs.writeSync;
  const originalOpen = fs.openSync;
  let writePhase: "generation" | "migration" = "generation";
  let failPayloadWrite = false;
  const inspectedWrites: string[] = [];
  const inspectedCreations: string[] = [];
  const inspectFirstPayloadWrite = (fd: number): void => {
    if (inspectedWrites.includes(writePhase)) return;
    const opened = fs.fstatSync(fd, { bigint: true });
    const entry = fs.readdirSync(writeOrderRoot).find((name) => {
      const stat = fs.lstatSync(path.join(writeOrderRoot, name), { bigint: true });
      return stat.isFile() && stat.dev === opened.dev && stat.ino === opened.ino;
    });
    if (!entry) return;
    const writingPath = path.join(writeOrderRoot, entry);
    assert.equal(
      fs.statSync(writingPath).size,
      0,
      "the first payload write must follow empty creation",
    );
    const descriptor = spawnSync(
      windowsPowerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$Path = [string](([Console]::In.ReadToEnd() | ConvertFrom-Json).Path); $fileInfo = New-Object System.IO.FileInfo($Path); $acl = $fileInfo.GetAccessControl(); $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); $everyoneReads = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) }).Count -gt 0; [pscustomobject]@{ Protected = $acl.AreAccessRulesProtected; EveryoneReads = $everyoneReads } | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ Path: writingPath }),
        windowsHide: true,
        timeout: 10_000,
      },
    );
    assert.equal(descriptor.status, 0, "the first-write native descriptor probe must succeed");
    const observed = JSON.parse(descriptor.stdout) as {
      Protected: boolean;
      EveryoneReads: boolean;
    };
    assert.equal(observed.Protected, true, `${writePhase} must protect its DACL before plaintext`);
    assert.equal(
      observed.EveryoneReads,
      false,
      `${writePhase} must remove inherited Everyone reads`,
    );
    inspectedWrites.push(writePhase);
  };
  try {
    process.env.CROSS_REVIEW_TOKENS_FILE = writeOrderPath;
    fs.openSync = ((file: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, [file, ...args]) as number;
      const target = String(file);
      if (
        target.startsWith(`${writeOrderRoot}${path.sep}`) &&
        (writePhase === "generation" || target.endsWith(".tmp")) &&
        !inspectedCreations.includes(writePhase)
      ) {
        // At the first Node open the native CreateNew has already supplied
        // the protected DACL. Later hardening cannot repair an earlier handle.
        inspectFirstPayloadWrite(fd);
        inspectedCreations.push(writePhase);
      }
      return fd;
    }) as typeof fs.openSync;
    fs.writeFileSync = ((file: Parameters<typeof fs.writeFileSync>[0], ...args: unknown[]) => {
      if (typeof file === "number") {
        inspectFirstPayloadWrite(file);
        if (failPayloadWrite) {
          throw Object.assign(new Error("fixture plaintext write failed"), { code: "EIO" });
        }
      }
      return Reflect.apply(originalWriteFile, fs, [file, ...args]);
    }) as typeof fs.writeFileSync;
    fs.writeSync = ((fd: number, ...args: unknown[]) => {
      inspectFirstPayloadWrite(fd);
      if (failPayloadWrite) {
        throw Object.assign(new Error("fixture plaintext write failed"), { code: "EIO" });
      }
      return Reflect.apply(originalWrite, fs, [fd, ...args]);
    }) as typeof fs.writeSync;
    assert.ok(ensureHostTokens(writeOrderRoot), "protected first creation must succeed");
    writePhase = "migration";
    const legacy = JSON.parse(fs.readFileSync(writeOrderPath, "utf8")) as {
      version: number;
    };
    legacy.version = 1;
    originalWriteFile(writeOrderPath, JSON.stringify(legacy));
    assert.ok(loadHostTokens(writeOrderRoot), "protected legacy replacement must succeed");
    assert.deepEqual(inspectedCreations, ["generation", "migration"]);
    assert.deepEqual(inspectedWrites, ["generation", "migration"]);
    assert.equal(JSON.parse(fs.readFileSync(writeOrderPath, "utf8")).version, 2);
    const failedGenerationPath = path.join(writeOrderRoot, "failed-generation.json");
    process.env.CROSS_REVIEW_TOKENS_FILE = failedGenerationPath;
    writePhase = "generation";
    failPayloadWrite = true;
    assert.throws(() => ensureHostTokens(writeOrderRoot), /fixture plaintext write failed/);
    assert.equal(
      fs.existsSync(failedGenerationPath),
      false,
      "a failed new write must remove its own empty entry",
    );
    process.env.CROSS_REVIEW_TOKENS_FILE = writeOrderPath;
    writePhase = "migration";
    originalWriteFile(writeOrderPath, JSON.stringify(legacy));
    const originalLegacyBytes = fs.readFileSync(writeOrderPath);
    const failedMigration: HostTokensLoadDiagnostics = { failure: null };
    assert.equal(loadHostTokens(writeOrderRoot, failedMigration), null);
    assert.equal(failedMigration.failure, "io_error");
    assert.deepEqual(fs.readFileSync(writeOrderPath), originalLegacyBytes);
    assert.equal(
      fs.readdirSync(writeOrderRoot).some((entry) => entry.endsWith(".tmp")),
      false,
    );
    failPayloadWrite = false;
    assert.ok(
      loadHostTokens(writeOrderRoot),
      "a corrected retry must migrate the preserved original",
    );
  } finally {
    fs.writeFileSync = originalWriteFile;
    fs.writeSync = originalWrite;
    fs.openSync = originalOpen;
    process.env.CROSS_REVIEW_TOKENS_FILE = tokenPath;
  }

  // Begin from the broad inherited state that `/reset` used to persist when
  // the old multi-process plan was interrupted.
  runIcacls([tokenPath, "/reset"]);
  const plannedCommands = getWindowsTokensFileAclCommands(tokenPath, currentUserSid);
  const verificationCommand = getWindowsTokensFileAclVerificationCommand(tokenPath, currentUserSid);
  const protectedEmptyRecoveryCommand = getWindowsTokensFileProtectedEmptyDaclRecoveryCommand(
    tokenPath,
    currentUserSid,
  );
  const manualRecipeTemplate = TOKEN_FILE_MANUAL_RECOVERY.match(/`([^`]+)`/)?.[1];
  assert.ok(manualRecipeTemplate, "manual recovery guidance must contain one PowerShell block");
  if (!manualRecipeTemplate) throw new Error("manual recovery PowerShell block is unavailable");
  const manualRecipe = manualRecipeTemplate
    .replace("'<token-file>'", `'${tokenPath.replaceAll("'", "''")}'`)
    .replace("'<current-user-SID>'", `'${currentUserSid}'`);
  const hardeningRecipeTemplate =
    TOKEN_FILE_HARDENING_FAILED_MANUAL_RECOVERY.match(/`([^`]+)`/)?.[1];
  assert.ok(
    hardeningRecipeTemplate,
    "hardening recovery guidance must contain one PowerShell block",
  );
  if (!hardeningRecipeTemplate)
    throw new Error("hardening recovery PowerShell block is unavailable");
  const hardeningRecipe = hardeningRecipeTemplate
    .replace("'<token-file>'", `'${tokenPath.replaceAll("'", "''")}'`)
    .replace("'<current-user-SID>'", `'${currentUserSid}'`);
  assert.equal(
    plannedCommands.length,
    1,
    "production ACL replacement must use exactly one external process",
  );
  assert.ok(
    executeWindowsTokensFileAclCommands(plannedCommands),
    "production ACL replacement must tighten a broad inherited DACL",
  );
  assert.doesNotThrow(
    () => fs.readFileSync(tokenPath, "utf8"),
    "atomic ACL replacement must leave the token file readable",
  );

  for (const [engineName, enginePath] of [
    ["PowerShell 7", "pwsh.exe"],
    ["Windows PowerShell 5.1", windowsPowerShell],
  ] as const) {
    const executeWithEngine = (command: (typeof plannedCommands)[number]) =>
      spawnSync(enginePath, [...command.args], {
        encoding: "utf8",
        input: command.input,
        windowsHide: true,
        timeout: 10_000,
      });
    const secureEmptyPath = path.join(
      tmpRoot,
      `native-create-${engineName.replaceAll(" ", "-")}.json`,
    );
    const secureCreation = getWindowsTokensFileCreationCommand(secureEmptyPath, currentUserSid);
    const creationResult = executeWithEngine(secureCreation);
    assert.equal(
      creationResult.status,
      0,
      `${engineName} must protect its exclusive empty creation`,
    );
    assert.equal(fs.statSync(secureEmptyPath).size, 0);
    assert.equal(
      executeWithEngine(getWindowsTokensFileAclVerificationCommand(secureEmptyPath, currentUserSid))
        .status,
      0,
      `${engineName} must create the exact protected DACL before any payload exists`,
    );
    const emptyBytes = fs.readFileSync(secureEmptyPath);
    assert.equal(
      executeWithEngine(secureCreation).status,
      80,
      "CreateNew must preserve EEXIST semantics",
    );
    assert.deepEqual(fs.readFileSync(secureEmptyPath), emptyBytes);
    fs.rmSync(secureEmptyPath);
    runIcacls([tokenPath, "/reset"]);
    assert.ok(
      executeWindowsTokensFileAclCommands(plannedCommands, executeWithEngine),
      `atomic ACL replacement must support ${engineName} with a metacharacter path`,
    );
    const verificationResult = executeWithEngine(verificationCommand);
    assert.equal(
      verificationResult.status,
      0,
      `${engineName} must verify the exact ACL through the same metacharacter-safe binding (stdout=${verificationResult.stdout}; stderr=${verificationResult.stderr})`,
    );
    assert.doesNotThrow(
      () => fs.readFileSync(tokenPath, "utf8"),
      `${engineName} ACL replacement must leave the token file readable`,
    );
    const unrelatedAclRecoveryResult = executeWithEngine(protectedEmptyRecoveryCommand);
    assert.notEqual(
      unrelatedAclRecoveryResult.status,
      0,
      `${engineName} must refuse recovery when the protected DACL is non-empty`,
    );
    assert.equal(
      executeWithEngine(verificationCommand).status,
      0,
      `${engineName} refusal must leave the existing exact DACL unchanged`,
    );
    const unrelatedManualRecoveryResult = spawnSync(
      enginePath,
      ["-NoLogo", "-NoProfile", "-Command", manualRecipe],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    assert.notEqual(
      unrelatedManualRecoveryResult.status,
      0,
      `manual recovery must refuse a non-empty protected DACL in ${engineName}`,
    );
    assert.equal(
      executeWithEngine(verificationCommand).status,
      0,
      `${engineName} manual refusal must leave the existing exact DACL unchanged`,
    );
    runIcacls([tokenPath, "/reset"]);
    runIcacls([tokenPath, "/inheritance:r"]);
    const manualRecoveryResult = spawnSync(
      enginePath,
      ["-NoLogo", "-NoProfile", "-Command", manualRecipe],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    assert.equal(
      manualRecoveryResult.status,
      0,
      `manual recovery block must support ${engineName} (stdout=${manualRecoveryResult.stdout}; stderr=${manualRecoveryResult.stderr})`,
    );
    const manualVerificationResult = executeWithEngine(verificationCommand);
    assert.equal(
      manualVerificationResult.status,
      0,
      `${engineName} must verify the exact ACL after manual recovery (stdout=${manualVerificationResult.stdout}; stderr=${manualVerificationResult.stderr})`,
    );

    // PR #208 thread (routing): the hardening-failure recipe must converge on
    // the exact descriptor from every state hardening can leave behind —
    // broad inherited, quarantined protected-empty, and already-exact.
    const hardeningStates: ReadonlyArray<[string, () => void]> = [
      ["broad inherited DACL", () => runIcacls([tokenPath, "/reset"])],
      [
        "quarantined protected-empty DACL",
        () => {
          runIcacls([tokenPath, "/reset"]);
          runIcacls([tokenPath, "/inheritance:r"]);
        },
      ],
      ["already-exact descriptor", () => {}],
    ];
    for (const [stateLabel, arrange] of hardeningStates) {
      arrange();
      const hardeningRecoveryResult = spawnSync(
        enginePath,
        ["-NoLogo", "-NoProfile", "-Command", hardeningRecipe],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      assert.equal(
        hardeningRecoveryResult.status,
        0,
        `hardening recovery must repair a ${stateLabel} in ${engineName} (stdout=${hardeningRecoveryResult.stdout}; stderr=${hardeningRecoveryResult.stderr})`,
      );
      assert.equal(
        executeWithEngine(verificationCommand).status,
        0,
        `${engineName} must verify the exact ACL after hardening recovery from a ${stateLabel}`,
      );
    }

    // PR #208 thread (TOCTOU): a pathname redirected to another file must be
    // refused before any descriptor is touched. Symlink creation needs a
    // privilege the local console may not hold; the CI runner has it.
    const victimPath = path.join(tmpRoot, "victim-file.json");
    const linkPath = path.join(tmpRoot, "redirected-entry.json");
    fs.rmSync(victimPath, { force: true });
    fs.rmSync(linkPath, { force: true });
    fs.writeFileSync(victimPath, "{}");
    let symlinkAvailable = false;
    try {
      fs.symlinkSync(victimPath, linkPath, "file");
      symlinkAvailable = true;
    } catch {
      console.log(
        `[v4.5.37-caller-token-acl-regression] SKIP: ${engineName} symlink-refusal scenario (symlink creation unavailable)`,
      );
    }
    if (symlinkAvailable) {
      const readDacl = (entryPath: string): string => {
        const aclRead = spawnSync(
          enginePath,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$Path = [string](([Console]::In.ReadToEnd() | ConvertFrom-Json).Path); $fileInfo = New-Object System.IO.FileInfo($Path); if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) { $acl = $fileInfo.GetAccessControl() } else { $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo) }; $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
          ],
          {
            encoding: "utf8",
            input: JSON.stringify({ Path: entryPath }),
            windowsHide: true,
            timeout: 10_000,
          },
        );
        assert.equal(aclRead.status, 0, "native DACL readback must succeed");
        return aclRead.stdout.trim();
      };
      // Use a complete synthetic record so adopting the linked target would
      // succeed, rather than being hidden by invalid JSON. Keep its inherited
      // DACL broad to prove refusal occurs before pathname hardening.
      fs.writeFileSync(victimPath, fs.readFileSync(tokenPath));
      const victimBytesBefore = fs.readFileSync(victimPath);
      const victimDaclBefore = readDacl(victimPath);
      const linkDiagnostics: HostTokensLoadDiagnostics = { failure: null };
      process.env.CROSS_REVIEW_TOKENS_FILE = linkPath;
      try {
        assert.equal(loadHostTokens(tmpRoot, linkDiagnostics), null);
        assert.equal(linkDiagnostics.failure, "unsafe_entry");
        assert.equal(ensureHostTokens(tmpRoot), null);
      } finally {
        process.env.CROSS_REVIEW_TOKENS_FILE = tokenPath;
      }
      assert.deepEqual(fs.readFileSync(victimPath), victimBytesBefore);
      assert.equal(
        readDacl(victimPath),
        victimDaclBefore,
        `automatic symlink refusal must leave target DACL unchanged in ${engineName}`,
      );
      assert.ok(
        loadHostTokens(tmpRoot),
        "the regular protected entry must remain loadable after refusing the link",
      );
      const victimAclBefore = fs.statSync(victimPath).mode;
      for (const [recipeLabel, recipeText] of [
        ["manual", manualRecipe],
        ["hardening", hardeningRecipe],
      ] as const) {
        const redirectedRecipe = recipeText.replace(
          `'${tokenPath.replaceAll("'", "''")}'`,
          `'${linkPath.replaceAll("'", "''")}'`,
        );
        const redirectedResult = spawnSync(
          enginePath,
          ["-NoLogo", "-NoProfile", "-Command", redirectedRecipe],
          { encoding: "utf8", windowsHide: true, timeout: 10_000 },
        );
        assert.notEqual(
          redirectedResult.status,
          0,
          `${recipeLabel} recovery must refuse a symlinked entry in ${engineName}`,
        );
        assert.match(
          `${redirectedResult.stdout}\n${redirectedResult.stderr}`,
          /regular non-reparse token file/,
          `${recipeLabel} recovery refusal must name the reparse precondition in ${engineName}`,
        );
      }
      assert.equal(
        fs.statSync(victimPath).mode,
        victimAclBefore,
        `symlink refusal must leave the redirect target untouched in ${engineName}`,
      );
      fs.rmSync(linkPath, { force: true });
    }
    fs.rmSync(victimPath, { force: true });
  }

  const aclProbe = spawnSync(
    windowsPowerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$Path = [string](([Console]::In.ReadToEnd() | ConvertFrom-Json).Path); $fileInfo = New-Object System.IO.FileInfo($Path); if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) { $acl = $fileInfo.GetAccessControl() } else { $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo) }; $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); [pscustomobject]@{ Protected = $acl.AreAccessRulesProtected; Rules = @($rules | ForEach-Object { [pscustomobject]@{ Sid = $_.IdentityReference.Value; Type = [string]$_.AccessControlType; Rights = [int]$_.FileSystemRights; IsInherited = $_.IsInherited } }) } | ConvertTo-Json -Depth 4 -Compress",
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ Path: tokenPath }),
      windowsHide: true,
      timeout: 10_000,
    },
  );
  assert.equal(aclProbe.status, 0, "final ACL probe must succeed");
  const parsedAcl = JSON.parse(aclProbe.stdout) as {
    Protected: boolean;
    Rules: Array<{ Sid: string; Type: string; Rights: number; IsInherited: boolean }>;
  };
  assert.equal(parsedAcl.Protected, true, "final token DACL must be protected");
  assert.equal(parsedAcl.Rules.length, 3, "final token DACL must contain exactly three ACEs");
  assert.deepEqual(
    new Set(parsedAcl.Rules.map((rule) => rule.Sid)),
    new Set([currentUserSid, "S-1-5-18", "S-1-5-32-544"]),
    "final token DACL must contain only current user, SYSTEM and Administrators",
  );
  assert.ok(
    parsedAcl.Rules.every(
      (rule) =>
        rule.Type === "Allow" && rule.IsInherited === false && (rule.Rights & 2032127) === 2032127,
    ),
    "final token DACL must contain only explicit FullControl allow ACEs",
  );

  // Mutant of the vulnerable production prefix. A crash after the second
  // command leaves a protected empty DACL and makes the token file unreadable.
  runIcacls([tokenPath, "/reset"]);
  runIcacls([tokenPath, "/inheritance:r"]);
  assert.throws(
    () => fs.readFileSync(tokenPath, "utf8"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["EACCES", "EPERM"].includes(String((error as { code?: unknown }).code)),
    "the old command prefix must reproduce an unreadable protected DACL",
  );

  assert.ok(
    loadHostTokens(tmpRoot),
    "loadHostTokens must repair one EACCES/EPERM denial and reopen the token file once",
  );

  console.log("[v4.5.37-caller-token-acl-regression] PASS");
} finally {
  try {
    runIcacls([tokenPath, "/reset"]);
  } catch {
    // Cleanup is best-effort; the fixture never points at the operator token.
  }
  if (previousTokensFile === undefined) {
    delete process.env.CROSS_REVIEW_TOKENS_FILE;
  } else {
    process.env.CROSS_REVIEW_TOKENS_FILE = previousTokensFile;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
