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

/**
 * Keep the plaintext capability map outside inherited model-sandbox ACLs.
 * POSIX mode bits are applied by Node. Windows needs an explicit protected
 * DACL because `mode: 0o600` does not override inherited NTFS access entries.
 */
export function hardenTokensFilePermissions(filePath: string): boolean {
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
      return (fs.statSync(filePath).mode & 0o077) === 0;
    }

    const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    const currentUserSid = identity.stdout?.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
    if (identity.status !== 0 || !currentUserSid) return false;

    // Reset first so every pre-existing explicit ACE is discarded, then
    // remove inherited ACEs and rebuild the complete allow-list. `/grant:r`
    // alone only replaces ACEs for the named identities and would preserve a
    // hostile explicit Everyone/Users/model-sandbox grant.
    const commands = [
      [filePath, "/reset"],
      [filePath, "/inheritance:r"],
      [filePath, "/grant:r", `*${currentUserSid}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"],
    ];
    for (const args of commands) {
      const result = spawnSync("icacls.exe", args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.status !== 0 || result.error) return false;
    }

    const verification = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "& { param([string]$Path, [string]$CurrentUserSid)",
          "$allowed = @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')",
          "$acl = Get-Acl -LiteralPath $Path",
          "if (-not $acl.AreAccessRulesProtected) { exit 11 }",
          "$rules = @($acl.Access)",
          "if ($rules.Count -ne $allowed.Count) { exit 12 }",
          "foreach ($rule in $rules) {",
          "  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
          "  if ($sid -notin $allowed) { exit 13 }",
          "  if ($rule.IsInherited) { exit 14 }",
          "  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 15 }",
          "  if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 16 }",
          "}",
          "}",
        ].join("; "),
        "-Path",
        filePath,
        "-CurrentUserSid",
        currentUserSid,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    return verification.status === 0 && !verification.error;
  } catch {
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

function openedFileMatchesPath(filePath: string, fd: number): boolean {
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(filePath, { bigint: true });
    return opened.isFile() && opened.dev === current.dev && opened.ino === current.ino;
  } catch {
    return false;
  }
}

function hardenOpenedTokensFilePermissions(filePath: string, fd: number): boolean {
  try {
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
      return (fs.fstatSync(fd).mode & 0o077) === 0 && openedFileMatchesPath(filePath, fd);
    }
    return hardenTokensFilePermissions(filePath) && openedFileMatchesPath(filePath, fd);
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
  if (!hardenTokensFilePermissions(filePath)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* the caller still fails closed below */
    }
    throw new Error(
      "caller-tokens: could not apply owner-only permissions; insecure token file was rejected",
    );
  }
  return { filePath, map, generated_at: payload.generated_at };
}

export function loadHostTokens(dataDir: string): HostTokensRecord | null {
  const filePath = getTokensFilePath(dataDir);
  let fd: number | null = null;
  try {
    fd = openTokensFile(filePath);
    if (!hardenOpenedTokensFilePermissions(filePath, fd)) return null;

    const raw = fs.readFileSync(fd, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      ![1, 2].includes((parsed as { version?: number }).version ?? 0) ||
      typeof (parsed as { tokens?: unknown }).tokens !== "object" ||
      (parsed as { tokens?: unknown }).tokens === null
    ) {
      return null;
    }
    const tokensIn = (parsed as { tokens: Record<string, unknown> }).tokens;
    const map = {} as HostTokensMap;
    const seen = new Set<string>();
    for (const identity of PEERS) {
      const tok = tokensIn[identity];
      if (typeof tok !== "string" || tok.length !== TOKEN_HEX_LENGTH || !/^[0-9a-f]+$/i.test(tok)) {
        return null;
      }
      const normalizedToken = tok.toLowerCase();
      if (seen.has(normalizedToken)) {
        return null;
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
    if (seen.has(operatorToken)) return null;
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
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    return null;
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

export function ensureHostTokens(dataDir: string): HostTokensRecord | null {
  const existing = loadHostTokens(dataDir);
  if (existing) return existing;
  const generated = generateHostTokens(dataDir);
  if (generated) return generated;
  return loadHostTokens(dataDir);
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
): TokenVerification {
  const presented = getEnvToken();
  if (!presented) return { method: "absent", verified: false };
  if (!tokensRecord?.map) {
    throw new Error(
      "identity_forgery_blocked: CROSS_REVIEW_CALLER_TOKEN is set but the host-tokens.json file could not be loaded; either remove the env var, regenerate the tokens file via the regenerate_caller_tokens tool, or repair the file (default path: <data_dir>/host-tokens.json; override via CROSS_REVIEW_TOKENS_FILE).",
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
      const stdout = String(r.stdout || "").trim();
      if (stdout.startsWith('"')) {
        const m = stdout.match(/^"([^"]+)"/);
        const parentExeBasename = m?.[1];
        if (parentExeBasename && parentExeBasename.length < 128) {
          snapshot.parent_exe_basename = parentExeBasename;
        }
      }
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
