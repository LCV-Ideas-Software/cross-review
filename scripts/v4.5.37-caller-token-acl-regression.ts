import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureHostTokens,
  executeWindowsTokensFileAclCommands,
  getWindowsTokensFileAclCommands,
  getWindowsTokensFileAclVerificationCommand,
  getWindowsTokensFileProtectedEmptyDaclRecoveryCommand,
  type HostTokensLoadDiagnostics,
  loadHostTokens,
  openTokensFileWithPermissionRecovery,
  TOKEN_FILE_MANUAL_RECOVERY,
  verifyTokenForCaller,
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
assert.equal(portablePlan[0]?.executable, "powershell.exe");
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

const fakeIdentity = { dev: 1n, ino: 2n };
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
assert.throws(
  () =>
    openTokensFileWithPermissionRecovery("fixture", {
      platform: "win32",
      openFile: () => {
        throw eacces();
      },
      repairProtectedEmptyDacl: () => {
        unsafePathHardenCalls += 1;
        return true;
      },
      captureSafeIdentity: () => null,
    }),
  /fixture access denied/,
  "symlink, reparse, non-file or uninspectable paths must not be repaired by pathname",
);
assert.equal(unsafePathHardenCalls, 0, "unsafe paths must fail before ACL mutation");

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

  const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const currentUserSid = identity.stdout?.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  assert.equal(identity.status, 0, "Windows identity fixture must succeed");
  assert.ok(currentUserSid, "Windows identity fixture must return a SID");
  if (!currentUserSid) throw new Error("Windows identity fixture did not return a SID");

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
  }

  const aclProbe = spawnSync(
    "powershell.exe",
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
