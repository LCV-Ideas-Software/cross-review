// Module: cross-review/src/core/caller-tokens.ts
// Description: F1 caller capability tokens (v2.18.0). Generates and validates
// per-host secret tokens that complement the v2.17.0 clientInfo identity gate.
//
// Threat model: pre-v2.18.0 the v2.17.0 cross-check between declared `caller`
// and `clientInfo.name` only catches *inconsistent* self-reports — both
// fields are declared by the caller. An attacker that lies consistently in
// both fields passes the gate. F1 introduces a per-host secret bound to the
// operator's MCP host config (env var CROSS_REVIEW_CALLER_TOKEN),
// authoritative on match and rejected on mismatch.
//
// Operator decisions 2026-05-05:
//   1. Option C (Hybrid): token enforcement + best-effort parent-process
//      snapshot as forensics-only metadata.
//   2. Tokens file path: default `<data_dir>/host-tokens.json` AND
//      overridable via CROSS_REVIEW_TOKENS_FILE env var (note: same env
//      name as v1 for operator simplicity, but the v2 default location is
//      `<data_dir>/host-tokens.json` because v2 has its own data_dir
//      separate from v1's STATE_DIR).
//   3. regenerate_caller_tokens MCP tool ships in v2.18.0.
//   4. Ship permissive: CROSS_REVIEW_REQUIRE_TOKEN remains opt-in.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PeerId } from "./types.js";
import { PEERS } from "./types.js";

export const TOKEN_BYTES = 32;
export const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
export const TOKEN_FILE_MANUAL_RECOVERY = [
  "Manual recovery from a trusted human console only: stop the MCP host; resolve the configured token file locally without copying its path or contents into logs;",
  "run one PowerShell block that first requires the existing descriptor to be protected and empty, then builds, applies and verifies the complete protected descriptor:",
  "`$ErrorActionPreference = 'Stop'; $path = '<token-file>'; $currentUserSid = '<current-user-SID>'; $fileInfo = New-Object System.IO.FileInfo($path); if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) { $observedAcl = $fileInfo.GetAccessControl() } else { $observedAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo) }; if (-not $observedAcl.AreAccessRulesProtected) { throw 'caller-tokens: manual ACL recovery refused; expected protected empty DACL' }; $observedRules = @($observedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if ($observedRules.Count -ne 0) { throw 'caller-tokens: manual ACL recovery refused; expected protected empty DACL' }; $acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false); $allowed = New-Object 'System.Collections.Generic.HashSet[string]'; foreach ($sidText in @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544')) { $null = $allowed.Add($sidText) }; foreach ($sidText in $allowed) { $identity = New-Object System.Security.Principal.SecurityIdentifier($sidText); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow); $null = $acl.AddAccessRule($rule) }; if ($null -ne $fileInfo.PSObject.Methods['SetAccessControl']) { $fileInfo.SetAccessControl($acl) } else { [System.IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl) }; if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) { $verifiedAcl = $fileInfo.GetAccessControl() } else { $verifiedAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo) }; if (-not $verifiedAcl.AreAccessRulesProtected) { throw 'caller-tokens: manual ACL verification failed' }; $rules = @($verifiedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if ($rules.Count -ne $allowed.Count) { throw 'caller-tokens: manual ACL verification failed' }; $seen = New-Object 'System.Collections.Generic.HashSet[string]'; foreach ($rule in $rules) { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if (-not $allowed.Contains($sid)) { throw 'caller-tokens: manual ACL verification failed' }; if (-not $seen.Add($sid)) { throw 'caller-tokens: manual ACL verification failed' }; if ($rule.IsInherited) { throw 'caller-tokens: manual ACL verification failed' }; if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'caller-tokens: manual ACL verification failed' }; if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'caller-tokens: manual ACL verification failed' } }; foreach ($required in $allowed) { if (-not $seen.Contains($required)) { throw 'caller-tokens: manual ACL verification failed' } }`;",
  "restart the host and verify that server_info reports caller_tokens.loaded=true.",
  "Never paste resolved paths or token values into issues, prompts, or logs.",
].join(" ");

export type HostTokensLoadFailure =
  | "missing"
  | "permission_denied"
  | "permission_hardening_failed"
  | "invalid_content"
  | "unsafe_entry"
  | "io_error";

export interface HostTokensLoadDiagnostics {
  failure: HostTokensLoadFailure | null;
}

export interface TokenFileRecoveryContext {
  failure?: HostTokensLoadFailure | null;
  platform?: NodeJS.Platform;
}

const TOKEN_FILE_POSIX_PERMISSION_RECOVERY = [
  "Manual recovery from a trusted human console only: stop the MCP host; verify that the configured entry is the intended regular, non-symlink token file owned by the service account;",
  "restore owner-only access with `chmod 600 '<token-file>'`; restart the host and verify that server_info reports caller_tokens.loaded=true.",
  "Never paste resolved paths or token values into issues, prompts, or logs.",
].join(" ");

const TOKEN_FILE_INVALID_CONTENT_RECOVERY = [
  "The caller-token record has invalid content; ACL replacement cannot repair it.",
  "From a trusted human console, stop the MCP host and restore a known-good protected backup, or move the invalid record aside locally, restart once without CROSS_REVIEW_CALLER_TOKEN to generate a new record, redistribute the rotated tokens to their matching hosts, then restart and verify caller_tokens.loaded=true with server_info.",
  "Never paste the record path, contents, or token values into issues, prompts, or logs.",
].join(" ");

function getTokenFileRecoveryGuidance(context: TokenFileRecoveryContext): string {
  const failure = context.failure ?? null;
  const platform = context.platform ?? process.platform;
  if (failure === "permission_denied" || failure === "permission_hardening_failed") {
    return platform === "win32" ? TOKEN_FILE_MANUAL_RECOVERY : TOKEN_FILE_POSIX_PERMISSION_RECOVERY;
  }
  if (failure === "invalid_content") return TOKEN_FILE_INVALID_CONTENT_RECOVERY;
  if (failure === "unsafe_entry") {
    return "The configured caller-token entry is a symlink, non-regular file, or could not be verified safely. Stop the MCP host and inspect the configured entry locally; replace it only with a known-good protected regular file or correct CROSS_REVIEW_TOKENS_FILE, then restart and verify caller_tokens.loaded=true with server_info. Never paste resolved paths or token values into issues, prompts, or logs.";
  }
  if (failure === "missing") {
    return "The caller-token record is missing. From a trusted human console, stop the MCP host and confirm the configured data directory or CROSS_REVIEW_TOKENS_FILE location. If the record was lost, keep the target absent, restart once without CROSS_REVIEW_CALLER_TOKEN to generate a new record, redistribute the rotated tokens, then restart and verify caller_tokens.loaded=true with server_info.";
  }
  return "The caller-token record failed for a non-permission I/O or unknown reason. Stop the MCP host and inspect the configured local storage without exposing its path or contents; restore a known-good protected regular file or correct the storage/configuration error, then restart and verify caller_tokens.loaded=true with server_info. Do not apply an ACL replacement unless the failure is confirmed as the documented permission-recovery case.";
}

export type CallerIdentity = PeerId | "operator";
export const CALLER_IDENTITIES: readonly CallerIdentity[] = [...PEERS, "operator"];
export type HostTokensMap = Record<CallerIdentity, string>;

export interface HostTokensRecord {
  filePath: string;
  map: HostTokensMap;
  generated_at: string | null;
}

export interface ParentProcessSnapshot {
  parent_pid: number | null;
  parent_exe_basename: string | null;
}

export interface TokensFileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface OpenedTokensFile {
  fd: number;
  permissionsHardened: boolean;
}

export interface TokensFilePermissionRecoveryOperations {
  platform?: NodeJS.Platform;
  openFile?: (filePath: string) => number;
  repairProtectedEmptyDacl?: (filePath: string) => boolean;
  captureSafeIdentity?: (filePath: string) => TokensFileIdentity | null;
  openedFileMatchesIdentity?: (
    filePath: string,
    fd: number,
    identity: TokensFileIdentity,
  ) => boolean;
  closeFile?: (fd: number) => void;
}

export interface EnsureHostTokensOperations {
  load?: (dataDir: string, diagnostics?: HostTokensLoadDiagnostics) => HostTokensRecord | null;
  generate?: (dataDir: string, options?: { overwrite?: boolean }) => HostTokensRecord | null;
  tokensFileEntryExists?: (filePath: string) => boolean;
  diagnostics?: HostTokensLoadDiagnostics;
}

export interface WindowsTokensFileAclCommand {
  executable: string;
  args: readonly string[];
  input: string;
}

export type WindowsTokensFileAclCommandExecutor = (command: WindowsTokensFileAclCommand) => {
  status: number | null;
  error?: unknown;
};

function getWindowsTokensFileAclInput(filePath: string, currentUserSid: string): string {
  return JSON.stringify({ Path: filePath, CurrentUserSid: currentUserSid });
}

/**
 * Absolute System32 path for the security-critical helper tools. PATH-based
 * resolution is wrong twice here: under an MSYS/Git Bash parent, GNU
 * coreutils' `whoami.exe` shadows the Windows one and rejects `/user`
 * (observed: boot fails with the ACL-rejection error); and a writable PATH
 * entry ahead of System32 could substitute the binary that sets the DACL.
 */
function getWindowsSystemToolPath(...segments: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(systemRoot, "System32", ...segments);
}

function getWindowsTokensFileAclBindingScript(): readonly string[] {
  return [
    "$binding = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$Path = [string]$binding.Path",
    "$CurrentUserSid = [string]$binding.CurrentUserSid",
    "if ([string]::IsNullOrEmpty($Path) -or [string]::IsNullOrEmpty($CurrentUserSid)) { throw 'caller-tokens: missing internal ACL binding' }",
  ];
}

export function parseWindowsTasklistImageName(output: unknown): string | null {
  const stdout = String(output ?? "").trim();
  if (!stdout.startsWith('"')) return null;
  const parentExeBasename = stdout.match(/^"([^"]+)"/)?.[1];
  return parentExeBasename && parentExeBasename.length < 128 ? parentExeBasename : null;
}

// prettier-ignore
export type TokenVerification =
  | { method: "token"; verified: true }
  | { method: "absent"; verified: false };

export function getTokensFilePath(dataDir: string): string {
  const override = process.env.CROSS_REVIEW_TOKENS_FILE;
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(dataDir, "host-tokens.json");
}

// One-shot boot spawns: the first powershell.exe of a process can exceed 10s
// on loaded hosted runners (observed on windows-latest, 20/08/2026), so these
// ceilings stay generous; every failure mode still fails closed.
export const WINDOWS_TOKENS_FILE_ACL_SPAWN_TIMEOUT_MS = 60_000;
export const WINDOWS_CURRENT_USER_SID_SPAWN_TIMEOUT_MS = 15_000;

export interface WindowsTokensFileAclExecutionDiagnostics {
  failure?: {
    kind: "timeout" | "spawn_error" | "exit_status";
    code?: string;
    status?: number | null;
  };
}

export interface TokensFileHardenDiagnostics {
  stage?: "sid" | "apply" | "verify" | "exception";
  detail?: string;
}

export function getWindowsTokensFileAclCommands(
  filePath: string,
  currentUserSid: string,
): readonly WindowsTokensFileAclCommand[] {
  const replaceAclScript = [
    "$ErrorActionPreference = 'Stop'",
    "& {",
    ...getWindowsTokensFileAclBindingScript(),
    "$acl = New-Object System.Security.AccessControl.FileSecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$allowed = New-Object 'System.Collections.Generic.HashSet[string]'",
    "foreach ($sidText in @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')) { $null = $allowed.Add($sidText) }",
    "foreach ($sidText in $allowed) {",
    "  $identity = New-Object System.Security.Principal.SecurityIdentifier($sidText)",
    "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  $null = $acl.AddAccessRule($rule)",
    "}",
    "$fileInfo = New-Object System.IO.FileInfo($Path)",
    "if ($null -ne $fileInfo.PSObject.Methods['SetAccessControl']) {",
    "  $fileInfo.SetAccessControl($acl)",
    "} else {",
    "  [System.IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl)",
    "}",
    "}",
  ].join("; ");
  return [
    {
      executable: getWindowsSystemToolPath("WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", replaceAclScript],
      input: getWindowsTokensFileAclInput(filePath, currentUserSid),
    },
  ];
}

export function getWindowsTokensFileAclVerificationCommand(
  filePath: string,
  currentUserSid: string,
): WindowsTokensFileAclCommand {
  const verificationScript = [
    "$ErrorActionPreference = 'Stop'",
    "& {",
    ...getWindowsTokensFileAclBindingScript(),
    "$allowed = New-Object 'System.Collections.Generic.HashSet[string]'",
    "foreach ($sidText in @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')) { $null = $allowed.Add($sidText) }",
    "$fileInfo = New-Object System.IO.FileInfo($Path)",
    "if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) {",
    "  $acl = $fileInfo.GetAccessControl()",
    "} else {",
    "  $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo)",
    "}",
    "if (-not $acl.AreAccessRulesProtected) { exit 11 }",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "if ($rules.Count -ne $allowed.Count) { exit 12 }",
    "$seen = New-Object 'System.Collections.Generic.HashSet[string]'",
    "foreach ($rule in $rules) {",
    "  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  if (-not $allowed.Contains($sid)) { exit 13 }",
    "  if (-not $seen.Add($sid)) { exit 17 }",
    "  if ($rule.IsInherited) { exit 14 }",
    "  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 15 }",
    "  if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 16 }",
    "}",
    "foreach ($required in $allowed) { if (-not $seen.Contains($required)) { exit 18 } }",
    "}",
  ].join("; ");
  return {
    executable: getWindowsSystemToolPath("WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verificationScript],
    input: getWindowsTokensFileAclInput(filePath, currentUserSid),
  };
}

export function getWindowsTokensFileProtectedEmptyDaclRecoveryCommand(
  filePath: string,
  currentUserSid: string,
): WindowsTokensFileAclCommand {
  const recoveryScript = [
    "$ErrorActionPreference = 'Stop'",
    "& {",
    ...getWindowsTokensFileAclBindingScript(),
    "$fileInfo = New-Object System.IO.FileInfo($Path)",
    "if ($null -ne $fileInfo.PSObject.Methods['GetAccessControl']) {",
    "  $observedAcl = $fileInfo.GetAccessControl()",
    "} else {",
    "  $observedAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo)",
    "}",
    "if (-not $observedAcl.AreAccessRulesProtected) { exit 21 }",
    "$observedRules = @($observedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "if ($observedRules.Count -ne 0) { exit 22 }",
    "$acl = New-Object System.Security.AccessControl.FileSecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$allowed = New-Object 'System.Collections.Generic.HashSet[string]'",
    "foreach ($sidText in @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')) { $null = $allowed.Add($sidText) }",
    "foreach ($sidText in $allowed) {",
    "  $identity = New-Object System.Security.Principal.SecurityIdentifier($sidText)",
    "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  $null = $acl.AddAccessRule($rule)",
    "}",
    "if ($null -ne $fileInfo.PSObject.Methods['SetAccessControl']) {",
    "  $fileInfo.SetAccessControl($acl)",
    "} else {",
    "  [System.IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl)",
    "}",
    "}",
  ].join("; ");
  return {
    executable: getWindowsSystemToolPath("WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", recoveryScript],
    input: getWindowsTokensFileAclInput(filePath, currentUserSid),
  };
}

export function executeWindowsTokensFileAclCommands(
  commands: readonly WindowsTokensFileAclCommand[],
  execute: WindowsTokensFileAclCommandExecutor = (command) =>
    spawnSync(command.executable, [...command.args], {
      encoding: "utf8",
      input: command.input,
      windowsHide: true,
      timeout: WINDOWS_TOKENS_FILE_ACL_SPAWN_TIMEOUT_MS,
    }),
  diagnostics?: WindowsTokensFileAclExecutionDiagnostics,
): boolean {
  for (const command of commands) {
    const result = execute(command);
    if (result.error) {
      const code =
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? String((result.error as { code?: unknown }).code ?? "")
          : "";
      if (diagnostics) {
        diagnostics.failure =
          code === "ETIMEDOUT"
            ? { kind: "timeout", code }
            : code
              ? { kind: "spawn_error", code }
              : { kind: "spawn_error" };
      }
      return false;
    }
    if (result.status !== 0) {
      if (diagnostics) diagnostics.failure = { kind: "exit_status", status: result.status };
      return false;
    }
  }
  return true;
}

function getWindowsCurrentUserSid(): string | null {
  const identity = spawnSync(
    getWindowsSystemToolPath("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: WINDOWS_CURRENT_USER_SID_SPAWN_TIMEOUT_MS,
    },
  );
  const currentUserSid = identity.stdout?.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  return identity.status === 0 && currentUserSid ? currentUserSid : null;
}

function describeAclExecutionFailure(
  diagnostics: WindowsTokensFileAclExecutionDiagnostics,
): string {
  const failure = diagnostics.failure;
  if (!failure) return "unclassified";
  if (failure.kind === "timeout") return "spawn timeout (ETIMEDOUT)";
  if (failure.kind === "spawn_error")
    return `spawn error${failure.code ? ` (${failure.code})` : ""}`;
  return `exit status ${failure.status ?? "unknown"}`;
}

function verifyWindowsTokensFilePermissions(
  filePath: string,
  currentUserSid: string,
  diagnostics?: WindowsTokensFileAclExecutionDiagnostics,
): boolean {
  return executeWindowsTokensFileAclCommands(
    [getWindowsTokensFileAclVerificationCommand(filePath, currentUserSid)],
    undefined,
    diagnostics,
  );
}

function repairWindowsProtectedEmptyTokensFileDacl(filePath: string): boolean {
  try {
    const currentUserSid = getWindowsCurrentUserSid();
    if (!currentUserSid) return false;
    if (
      !executeWindowsTokensFileAclCommands([
        getWindowsTokensFileProtectedEmptyDaclRecoveryCommand(filePath, currentUserSid),
      ])
    ) {
      return false;
    }
    return verifyWindowsTokensFilePermissions(filePath, currentUserSid);
  } catch {
    return false;
  }
}

/**
 * Keep the plaintext capability map outside inherited model-sandbox ACLs.
 * POSIX mode bits are applied by Node. Windows needs an explicit protected
 * DACL because `mode: 0o600` does not override inherited NTFS access entries.
 */
export function hardenTokensFilePermissions(
  filePath: string,
  diagnostics?: TokensFileHardenDiagnostics,
): boolean {
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
      return (fs.statSync(filePath).mode & 0o077) === 0;
    }

    const currentUserSid = getWindowsCurrentUserSid();
    if (!currentUserSid) {
      if (diagnostics) diagnostics.stage = "sid";
      return false;
    }

    // Replace the complete protected DACL in one OS access-control update.
    // The PowerShell process performs one FileInfo/FileSystemAclExtensions
    // SetAccessControl call, so termination cannot persist the broad inherited
    // ACL window created by a separate `icacls /reset` process. The final
    // verifier remains authoritative and rejects every extra or missing ACE.
    const commands = getWindowsTokensFileAclCommands(filePath, currentUserSid);
    const applyDiagnostics: WindowsTokensFileAclExecutionDiagnostics = {};
    if (!executeWindowsTokensFileAclCommands(commands, undefined, applyDiagnostics)) {
      if (diagnostics) {
        diagnostics.stage = "apply";
        diagnostics.detail = describeAclExecutionFailure(applyDiagnostics);
      }
      return false;
    }

    const verifyDiagnostics: WindowsTokensFileAclExecutionDiagnostics = {};
    if (!verifyWindowsTokensFilePermissions(filePath, currentUserSid, verifyDiagnostics)) {
      if (diagnostics) {
        diagnostics.stage = "verify";
        diagnostics.detail = describeAclExecutionFailure(verifyDiagnostics);
      }
      return false;
    }
    return true;
  } catch {
    if (diagnostics) diagnostics.stage = "exception";
    return false;
  }
}

function openTokensFile(filePath: string): number {
  let flags = fs.constants.O_RDWR;
  if (process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }
  return fs.openSync(filePath, flags);
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM"].includes(String((error as { code?: unknown }).code))
  );
}

function captureSafeTokensFileIdentity(filePath: string): TokensFileIdentity | null {
  try {
    const link = fs.lstatSync(filePath, { bigint: true });
    // lstat remains available for the observed protected-empty-DACL state;
    // stat/realpath would follow a link and also require the denied read path.
    if (link.isSymbolicLink() || !link.isFile()) {
      return null;
    }
    return { dev: link.dev, ino: link.ino };
  } catch {
    return null;
  }
}

function openedFileMatchesIdentity(
  filePath: string,
  fd: number,
  expected: TokensFileIdentity,
): boolean {
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(filePath, { bigint: true });
    return (
      opened.isFile() &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      opened.dev === expected.dev &&
      opened.ino === expected.ino &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    );
  } catch {
    return false;
  }
}

/**
 * Recover only the Windows protected-empty-DACL failure class. The repair is
 * attempted once, only after EACCES/EPERM, and the reopened handle must still
 * identify the same non-symlink file captured before the pathname ACL change.
 */
export function openTokensFileWithPermissionRecovery(
  filePath: string,
  operations: TokensFilePermissionRecoveryOperations = {},
): OpenedTokensFile {
  const platform = operations.platform ?? process.platform;
  const openFile = operations.openFile ?? openTokensFile;
  const repairProtectedEmptyDacl =
    operations.repairProtectedEmptyDacl ?? repairWindowsProtectedEmptyTokensFileDacl;
  const captureSafeIdentity = operations.captureSafeIdentity ?? captureSafeTokensFileIdentity;
  const matchesIdentity = operations.openedFileMatchesIdentity ?? openedFileMatchesIdentity;
  const closeFile = operations.closeFile ?? fs.closeSync;

  try {
    return { fd: openFile(filePath), permissionsHardened: false };
  } catch (initialError: unknown) {
    if (platform !== "win32" || !isPermissionDenied(initialError)) throw initialError;

    const identity = captureSafeIdentity(filePath);
    if (!identity || !repairProtectedEmptyDacl(filePath)) throw initialError;

    const fd = openFile(filePath);
    if (!matchesIdentity(filePath, fd, identity)) {
      try {
        closeFile(fd);
      } catch {
        /* the identity mismatch remains fail-closed */
      }
      throw new Error("caller-tokens: token file identity changed during permission recovery", {
        cause: initialError,
      });
    }
    return { fd, permissionsHardened: true };
  }
}

function openedFileMatchesPath(filePath: string, fd: number): boolean {
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(filePath, { bigint: true });
    return opened.isFile() && opened.dev === current.dev && opened.ino === current.ino;
  } catch {
    return false;
  }
}

function hardenOpenedTokensFilePermissions(
  filePath: string,
  fd: number,
  permissionsAlreadyHardened = false,
): boolean {
  try {
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
      return (fs.fstatSync(fd).mode & 0o077) === 0 && openedFileMatchesPath(filePath, fd);
    }
    const currentUserSid = permissionsAlreadyHardened ? getWindowsCurrentUserSid() : null;
    return (
      (permissionsAlreadyHardened
        ? currentUserSid !== null && verifyWindowsTokensFilePermissions(filePath, currentUserSid)
        : hardenTokensFilePermissions(filePath)) && openedFileMatchesPath(filePath, fd)
    );
  } catch {
    return false;
  }
}

function rewriteOpenedTokensFile(fd: number, payload: string): void {
  const encoded = Buffer.from(payload, "utf8");
  fs.ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < encoded.length) {
    const written = fs.writeSync(fd, encoded, offset, encoded.length - offset, offset);
    if (written <= 0) {
      throw new Error("caller-tokens: zero-byte write while migrating token file");
    }
    offset += written;
  }
  fs.fsyncSync(fd);
}

export function generateHostTokens(
  dataDir: string,
  options: { overwrite?: boolean } = {},
): HostTokensRecord | null {
  const filePath = getTokensFilePath(dataDir);
  const map = {} as HostTokensMap;
  for (const identity of CALLER_IDENTITIES) {
    map[identity] = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  }
  const seen = new Set<string>();
  for (const tok of Object.values(map)) {
    if (seen.has(tok)) {
      throw new Error("caller-tokens: generated tokens collide; refusing to write file");
    }
    seen.add(tok);
  }
  const payload = {
    version: 2 as const,
    generated_at: new Date().toISOString(),
    tokens: map,
  };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), {
      flag: options.overwrite ? "w" : "wx",
      mode: 0o600,
    });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "EEXIST" &&
      !options.overwrite
    ) {
      // Lost race to a concurrent boot; caller falls back to load.
      return null;
    }
    throw err;
  }
  const hardenDiagnostics: TokensFileHardenDiagnostics = {};
  if (!hardenTokensFilePermissions(filePath, hardenDiagnostics)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* the caller still fails closed below */
    }
    // Keep the original sentence stable for downstream matchers; append the
    // failing stage so an infrastructure timeout is distinguishable from a
    // genuine ACL policy rejection.
    const stage = hardenDiagnostics.stage ?? "unknown";
    const detail = hardenDiagnostics.detail ? `: ${hardenDiagnostics.detail}` : "";
    throw new Error(
      `caller-tokens: could not apply owner-only permissions; insecure token file was rejected (stage=${stage}${detail})`,
    );
  }
  return { filePath, map, generated_at: payload.generated_at };
}

function failHostTokensLoad(
  diagnostics: HostTokensLoadDiagnostics | undefined,
  failure: HostTokensLoadFailure,
): null {
  if (diagnostics) diagnostics.failure = failure;
  return null;
}

export function loadHostTokens(
  dataDir: string,
  diagnostics?: HostTokensLoadDiagnostics,
): HostTokensRecord | null {
  const filePath = getTokensFilePath(dataDir);
  let fd: number | null = null;
  if (diagnostics) diagnostics.failure = null;
  try {
    const opened = openTokensFileWithPermissionRecovery(filePath);
    fd = opened.fd;
    if (!hardenOpenedTokensFilePermissions(filePath, fd, opened.permissionsHardened)) {
      return failHostTokensLoad(diagnostics, "permission_hardening_failed");
    }

    const raw = fs.readFileSync(fd, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failHostTokensLoad(diagnostics, "invalid_content");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      ![1, 2].includes((parsed as { version?: number }).version ?? 0) ||
      typeof (parsed as { tokens?: unknown }).tokens !== "object" ||
      (parsed as { tokens?: unknown }).tokens === null
    ) {
      return failHostTokensLoad(diagnostics, "invalid_content");
    }
    const tokensIn = (parsed as { tokens: Record<string, unknown> }).tokens;
    const map = {} as HostTokensMap;
    const seen = new Set<string>();
    for (const identity of PEERS) {
      const tok = tokensIn[identity];
      if (typeof tok !== "string" || tok.length !== TOKEN_HEX_LENGTH || !/^[0-9a-f]+$/i.test(tok)) {
        return failHostTokensLoad(diagnostics, "invalid_content");
      }
      const normalizedToken = tok.toLowerCase();
      if (seen.has(normalizedToken)) {
        return failHostTokensLoad(diagnostics, "invalid_content");
      }
      seen.add(normalizedToken);
      map[identity] = normalizedToken;
    }
    const storedOperatorToken = tokensIn.operator;
    const operatorToken =
      typeof storedOperatorToken === "string" &&
      storedOperatorToken.length === TOKEN_HEX_LENGTH &&
      /^[0-9a-f]+$/i.test(storedOperatorToken) &&
      !seen.has(storedOperatorToken.toLowerCase())
        ? storedOperatorToken.toLowerCase()
        : crypto.randomBytes(TOKEN_BYTES).toString("hex");
    if (seen.has(operatorToken)) return failHostTokensLoad(diagnostics, "invalid_content");
    seen.add(operatorToken);
    map.operator = operatorToken;

    if ((parsed as { version?: number }).version !== 2 || storedOperatorToken !== operatorToken) {
      rewriteOpenedTokensFile(
        fd,
        JSON.stringify(
          {
            version: 2,
            generated_at:
              typeof (parsed as { generated_at?: unknown }).generated_at === "string"
                ? (parsed as { generated_at: string }).generated_at
                : new Date().toISOString(),
            operator_token_added_at: new Date().toISOString(),
            tokens: map,
          },
          null,
          2,
        ),
      );
    }
    const generated_at = (parsed as { generated_at?: unknown }).generated_at;
    return {
      filePath,
      map,
      generated_at: typeof generated_at === "string" ? generated_at : null,
    };
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") return failHostTokensLoad(diagnostics, "missing");
    if (["EACCES", "EPERM"].includes(code)) {
      return failHostTokensLoad(diagnostics, "permission_denied");
    }
    if (["ELOOP", "ENOTDIR", "EISDIR"].includes(code)) {
      return failHostTokensLoad(diagnostics, "unsafe_entry");
    }
    return failHostTokensLoad(diagnostics, "io_error");
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* load already fails closed on every operation above */
      }
    }
  }
}

function tokensFileEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }
}

export function ensureHostTokens(
  dataDir: string,
  operations: EnsureHostTokensOperations = {},
): HostTokensRecord | null {
  const diagnostics = operations.diagnostics ?? { failure: null };
  const load = operations.load ?? loadHostTokens;
  const generate = operations.generate ?? generateHostTokens;
  const entryExists = operations.tokensFileEntryExists ?? tokensFileEntryExists;
  const filePath = getTokensFilePath(dataDir);
  const entryExistedBeforeLoad = entryExists(filePath);

  const existing = load(dataDir, diagnostics);
  if (existing) return existing;
  const firstLoadFailure = diagnostics?.failure ?? null;
  // Only ENOENT authorizes create/reload after a failed first load. Every
  // permission, content, path-safety or I/O failure remains fail-closed and
  // must not repeat the bounded recovery path in the same boot.
  if (firstLoadFailure !== null && firstLoadFailure !== "missing") return null;
  // An existing but unreadable/invalid/symlinked entry must remain fail-closed.
  // If the prechecked entry instead disappeared before load, exclusive create
  // is safe; a concurrent recreation still falls through to the final load.
  if (entryExistedBeforeLoad && firstLoadFailure !== "missing") return null;
  // Another host may have created a complete record after the first absence
  // probe or while the first load observed ENOENT. Load that newly appeared
  // entry once before attempting our own exclusive create.
  if (!entryExistedBeforeLoad && entryExists(filePath)) return load(dataDir, diagnostics);

  const generated = generate(dataDir);
  if (generated) {
    if (diagnostics) diagnostics.failure = null;
    return generated;
  }
  return load(dataDir, diagnostics);
}

export function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function resolveAgentForToken(
  presented: string | null,
  tokensMap: HostTokensMap | undefined,
): CallerIdentity | null {
  if (!presented || !tokensMap) return null;
  let matched: CallerIdentity | null = null;
  for (const identity of CALLER_IDENTITIES) {
    const stored = tokensMap[identity];
    if (tokensMatch(presented, stored) && matched === null) {
      matched = identity;
    }
  }
  return matched;
}

export function getEnvToken(): string | null {
  const raw = process.env.CROSS_REVIEW_CALLER_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isHardEnforceMode(): boolean {
  return process.env.CROSS_REVIEW_REQUIRE_TOKEN === "true";
}

export function verifyTokenForCaller(
  declaredCaller: CallerIdentity,
  tokensRecord: HostTokensRecord | null,
  recoveryContext: TokenFileRecoveryContext = {},
): TokenVerification {
  const presented = getEnvToken();
  if (!presented) return { method: "absent", verified: false };
  if (!tokensRecord?.map) {
    throw new Error(
      `identity_forgery_blocked: CROSS_REVIEW_CALLER_TOKEN is set but the local caller-token record could not be loaded. ${getTokenFileRecoveryGuidance(recoveryContext)}`,
    );
  }
  const identity = resolveAgentForToken(presented, tokensRecord.map);
  if (!identity) {
    throw new Error(
      "identity_forgery_blocked: CROSS_REVIEW_CALLER_TOKEN does not match any known agent's secret in host-tokens.json. Either the token is stale (regenerate via regenerate_caller_tokens) or the host-tokens.json file has been rotated without re-distributing the new value.",
    );
  }
  if (identity !== declaredCaller) {
    throw new Error(
      `identity_forgery_blocked: CROSS_REVIEW_CALLER_TOKEN resolves to identity='${identity}' but caller declared='${declaredCaller}'. The token is bound to a specific MCP host identity; declaring a different caller is identity forgery.`,
    );
  }
  return { method: "token", verified: true };
}

export function getParentProcessSnapshot(): ParentProcessSnapshot {
  const snapshot: ParentProcessSnapshot = {
    parent_pid: typeof process.ppid === "number" ? process.ppid : null,
    parent_exe_basename: null,
  };
  if (!snapshot.parent_pid) return snapshot;
  if (process.platform === "win32") {
    // Windows path (added v2.18.2 / Tier 5): shell out to `tasklist` and
    // parse the leading quoted CSV field. Best-effort, time-bounded 500ms,
    // never throws. "PID not found" output starts with INFO/INFORMAÇÕES
    // (no leading quote) so we use that as a discriminator.
    try {
      const r = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${snapshot.parent_pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", timeout: 500, windowsHide: true },
      );
      snapshot.parent_exe_basename = parseWindowsTasklistImageName(r.stdout);
    } catch {
      /* best-effort */
    }
  } else {
    try {
      const comm = fs.readFileSync(`/proc/${snapshot.parent_pid}/comm`, "utf8").trim();
      if (comm.length > 0 && comm.length < 128) {
        snapshot.parent_exe_basename = comm;
      }
    } catch {
      /* best-effort */
    }
  }
  return snapshot;
}
