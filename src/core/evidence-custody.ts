import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

// The public MCP evidence field is capped at 200,000 JavaScript characters.
// A UTF-16 code unit needs at most three UTF-8 bytes (astral characters use
// four bytes for two code units), so this byte ceiling admits every value the
// public field can carry without silently imposing an ASCII-only sub-limit.
const MAX_PATCH_CHARS = 200_000;
const MAX_PATCH_BYTES = MAX_PATCH_CHARS * 3;
const MAX_GIT_PATHS = 1_024;
// `git apply --numstat --summary` emits two authenticated reports that can
// each repeat repository-path bytes from the admitted patch. Node enforces
// `maxBuffer` in bytes for synchronous child-process output, so a fixed
// 512-KiB ceiling rejected valid 200,000-unit Unicode patches with ENOBUFS.
// Keep the child bounded, but derive its ceiling from the public input bound:
// two complete input-byte budgets plus fixed report-syntax headroom per path.
const MAX_GIT_OUTPUT_BYTES = MAX_PATCH_BYTES * 2 + MAX_GIT_PATHS * 128;
const GIT_TIMEOUT_MS = 5_000;
const INDEX_CACHE_LIMIT = 64;
const INDEX_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface EvidenceCustodyIndex {
  exactGitPaths: readonly string[];
}

interface EvidenceCustodyOptions {
  /** @internal Test seam. Production callers must omit this field. */
  gitExecutable?: string | null;
}

interface GitNumstatRecord {
  added: number | null;
  removed: number | null;
  path: string;
}

interface ParsedGitOutput {
  records: GitNumstatRecord[];
  deletedPaths: Set<string>;
  createdPaths: Set<string>;
}

interface ParsedHunks {
  added: number;
  removed: number;
  sawHunk: boolean;
}

interface ParsedEvidenceHunks {
  materializedPaths: Set<string>;
}

interface CachedEvidenceCustodyIndex {
  index: EvidenceCustodyIndex;
  weight: number;
}

const indexCache = new Map<string, CachedEvidenceCustodyIndex>();
let indexCacheBytes = 0;
let defaultGitExecutable: string | null | undefined;

function emptyIndex(): EvidenceCustodyIndex {
  return Object.freeze({
    exactGitPaths: Object.freeze([]),
  });
}

function looksLikePatch(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n");
  const hasOldHeader = /^--- .+$/m.test(normalized);
  const hasNewHeader = /^\+\+\+ .+$/m.test(normalized);
  const hasHunkHeader = /^@@(?:\s|$)/m.test(normalized);
  const hasGitHeader = /^diff --git\s+/m.test(normalized);
  const hasRenamePair = /^rename from .+$/m.test(normalized) && /^rename to .+$/m.test(normalized);
  const hasCopyPair = /^copy from .+$/m.test(normalized) && /^copy to .+$/m.test(normalized);
  const hasBinaryBody = /^(?:Binary files .+ differ|GIT binary patch)$/m.test(normalized);
  const hasModeOnlyBody =
    (/^old mode \d+$/m.test(normalized) && /^new mode \d+$/m.test(normalized)) ||
    /^(?:new|deleted) file mode \d+$/m.test(normalized);
  return (
    (hasOldHeader && hasNewHeader && (hasHunkHeader || hasGitHeader)) ||
    (hasGitHeader && (hasRenamePair || hasCopyPair || hasBinaryBody || hasModeOnlyBody))
  );
}

function windowsGitCandidates(): string[] {
  const candidates: string[] = [];
  for (const programDirectory of ["Program Files", "Program Files (x86)"]) {
    for (const gitDirectory of ["cmd", "bin"]) {
      candidates.push(path.win32.join("C:\\", programDirectory, "Git", gitDirectory, "git.exe"));
    }
  }
  return candidates;
}

function trustedGitCandidates(): string[] {
  if (process.platform === "win32") return windowsGitCandidates();
  return ["/usr/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git"];
}

function pathIsWithinTrustedGitRoot(realPath: string): boolean {
  if (process.platform !== "win32") {
    return ["/usr/", "/Library/Developer/CommandLineTools/"].some((root) =>
      realPath.startsWith(root),
    );
  }
  const normalized = realPath.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\program files(?: \(x86\))?\\git\\(?:cmd|bin)\\git\.exe$/.test(normalized);
}

function resolveDefaultGitExecutable(): string | null {
  if (defaultGitExecutable !== undefined) return defaultGitExecutable;
  for (const candidate of trustedGitCandidates()) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      const resolved = fs.realpathSync.native(candidate);
      if (!path.isAbsolute(resolved) || !pathIsWithinTrustedGitRoot(resolved)) continue;
      if (process.platform !== "win32") {
        const resolvedStat = fs.statSync(resolved);
        if (resolvedStat.uid !== 0 || (resolvedStat.mode & 0o022) !== 0) continue;
      }
      defaultGitExecutable = resolved;
      return resolved;
    } catch {
      // Try the next fixed, platform-standard installation path.
    }
  }
  defaultGitExecutable = null;
  return null;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function safeRepositoryPath(repositoryPath: string): boolean {
  if (!repositoryPath || Buffer.byteLength(repositoryPath, "utf8") > 4_096) return false;
  for (const character of repositoryPath) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  if (
    repositoryPath.includes("\\") ||
    /^(?:\/|[A-Za-z]:|\/\/)/.test(repositoryPath) ||
    repositoryPath.endsWith("/")
  ) {
    return false;
  }
  const segments = repositoryPath.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git",
  );
}

function decodeGitSummaryPath(rawPath: string): string | undefined {
  if (!rawPath.startsWith('"')) return rawPath;
  if (!rawPath.endsWith('"')) return undefined;
  try {
    const decoded = JSON.parse(rawPath) as unknown;
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseGitOutput(output: Buffer): ParsedGitOutput | undefined {
  const records: GitNumstatRecord[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const firstTab = output.indexOf(0x09, cursor);
    const secondTab = firstTab < 0 ? -1 : output.indexOf(0x09, firstTab + 1);
    const nul = secondTab < 0 ? -1 : output.indexOf(0x00, secondTab + 1);
    if (firstTab < 0 || secondTab < 0 || nul < 0) break;
    const addedRaw = output.subarray(cursor, firstTab).toString("ascii");
    const removedRaw = output.subarray(firstTab + 1, secondTab).toString("ascii");
    if (!/^(?:\d+|-)$/.test(addedRaw) || !/^(?:\d+|-)$/.test(removedRaw)) break;
    const repositoryPath = decodeUtf8(output.subarray(secondTab + 1, nul));
    if (!repositoryPath || !safeRepositoryPath(repositoryPath)) return undefined;
    const added = addedRaw === "-" ? null : Number(addedRaw);
    const removed = removedRaw === "-" ? null : Number(removedRaw);
    if (
      (added !== null && (!Number.isSafeInteger(added) || added < 0)) ||
      (removed !== null && (!Number.isSafeInteger(removed) || removed < 0))
    ) {
      return undefined;
    }
    records.push({ added, removed, path: repositoryPath });
    if (records.length > MAX_GIT_PATHS) return undefined;
    cursor = nul + 1;
  }
  if (records.length === 0) return undefined;

  const summary = decodeUtf8(output.subarray(cursor));
  if (summary === undefined) return undefined;
  const deletedPaths = new Set<string>();
  const createdPaths = new Set<string>();
  const recordPaths = new Set(records.map((record) => record.path));
  for (const line of summary.replace(/\r\n/g, "\n").split("\n")) {
    const change = /^ (delete|create) (.+)$/.exec(line);
    if (!change) continue;
    const rawPath = change[2] ?? "";
    // Git includes `mode <mode> ` for extended Git-format summaries, but a
    // traditional file may itself begin with those bytes. Resolve both shapes
    // against the NUL-delimited numstat record; ambiguity fails closed.
    const rawCandidates = [rawPath];
    const withMode = /^mode \d+ (.+)$/.exec(rawPath);
    if (withMode?.[1]) rawCandidates.push(withMode[1]);
    const matchingPaths = [
      ...new Set(
        rawCandidates
          .map((candidate) => decodeGitSummaryPath(candidate))
          .filter(
            (candidate): candidate is string =>
              candidate !== undefined &&
              safeRepositoryPath(candidate) &&
              recordPaths.has(candidate),
          ),
      ),
    ];
    if (matchingPaths.length !== 1) return undefined;
    const repositoryPath = matchingPaths[0];
    if (!repositoryPath) return undefined;
    if (change[1] === "delete") deletedPaths.add(repositoryPath);
    else createdPaths.add(repositoryPath);
  }
  return { records, deletedPaths, createdPaths };
}

function parseValidatedSectionHunks(section: string): ParsedHunks | undefined {
  let oldRemaining: number | undefined;
  let newRemaining: number | undefined;
  let added = 0;
  let removed = 0;
  let sawHunk = false;
  let previousOldStart: number | undefined;
  let previousOldEnd: number | undefined;
  let previousNewStart: number | undefined;
  let previousNewEnd: number | undefined;

  const endCurrentHunk = (): void => {
    oldRemaining = undefined;
    newRemaining = undefined;
  };

  const lines = section.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (oldRemaining !== undefined && newRemaining !== undefined) {
      if (oldRemaining === 0 && newRemaining === 0) {
        if (line === "\\ No newline at end of file") continue;
        endCurrentHunk();
      } else if (line.startsWith("+")) {
        if (newRemaining <= 0) return undefined;
        newRemaining -= 1;
        added += 1;
        continue;
      } else if (line.startsWith("-")) {
        if (oldRemaining <= 0) return undefined;
        oldRemaining -= 1;
        removed += 1;
        continue;
      } else if (line.startsWith(" ")) {
        if (oldRemaining <= 0 || newRemaining <= 0) return undefined;
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      } else if (line === "\\ No newline at end of file") {
        // The official Git validation already proves adjacency and uniqueness.
        continue;
      } else {
        return undefined;
      }
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (!hunk) continue;
    const oldStart = Number(hunk[1] ?? "0");
    const oldCount = Number(hunk[2] ?? "1");
    const newStart = Number(hunk[3] ?? "0");
    const newCount = Number(hunk[4] ?? "1");
    if (
      !Number.isSafeInteger(oldStart) ||
      oldStart < 0 ||
      !Number.isSafeInteger(oldCount) ||
      oldCount < 0 ||
      !Number.isSafeInteger(newStart) ||
      newStart < 0 ||
      !Number.isSafeInteger(newCount) ||
      newCount < 0
    ) {
      return undefined;
    }
    const oldRangeStart = oldCount === 0 ? oldStart + 1 : oldStart;
    const newRangeStart = newCount === 0 ? newStart + 1 : newStart;
    const oldRangeEnd = oldRangeStart + oldCount;
    const newRangeEnd = newRangeStart + newCount;
    // `git apply --numstat --summary` authenticates Git's report syntax but
    // does not prove that multiple hunks form one coherent image. Fail closed
    // on non-monotonic, overlapping, or unequal-gap ranges so mutually
    // exclusive post-images cannot both acquire custody.
    // Unified-diff zero-count starts name the line before the insertion or
    // deletion boundary, hence the +1 normalization above.
    if (
      (oldCount > 0 && oldStart === 0) ||
      (newCount > 0 && newStart === 0) ||
      (previousOldStart !== undefined && oldRangeStart < previousOldStart) ||
      (previousNewStart !== undefined && newRangeStart < previousNewStart) ||
      (previousOldEnd !== undefined && oldRangeStart < previousOldEnd) ||
      (previousNewEnd !== undefined && newRangeStart < previousNewEnd) ||
      (previousOldEnd !== undefined &&
        previousNewEnd !== undefined &&
        oldRangeStart - previousOldEnd !== newRangeStart - previousNewEnd)
    ) {
      return undefined;
    }
    previousOldStart = oldRangeStart;
    previousOldEnd = oldRangeEnd;
    previousNewStart = newRangeStart;
    previousNewEnd = newRangeEnd;
    sawHunk = true;
    oldRemaining = oldCount;
    newRemaining = newCount;
  }
  if (oldRemaining !== undefined || newRemaining !== undefined) {
    if (oldRemaining !== 0 || newRemaining !== 0) return undefined;
    endCurrentHunk();
  }
  return {
    added,
    removed,
    sawHunk,
  };
}

function sectionMaterializesDestinationWithoutHunk(section: string): boolean {
  const normalized = section.replace(/\r\n/g, "\n");
  return (
    (/^rename from .+$/m.test(normalized) && /^rename to .+$/m.test(normalized)) ||
    (/^copy from .+$/m.test(normalized) && /^copy to .+$/m.test(normalized))
  );
}

function parseValidatedHunks(
  content: string,
  records: GitNumstatRecord[],
  createdPaths: ReadonlySet<string>,
): ParsedEvidenceHunks | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  const starts = [...normalized.matchAll(/^diff --git\s+/gm)].map((match) => match.index ?? -1);
  if (starts.some((start) => start < 0)) return undefined;
  // `git apply` officially accepts both Git-format patches and traditional
  // unified diffs. Git-format input has one authenticated `diff --git`
  // section per numstat record. Without those section delimiters, retain
  // support only for a single-file traditional diff; multi-file input cannot
  // be mapped to records without guessing and therefore fails closed.
  if (starts.length > 0 && starts.length !== records.length) return undefined;
  if (starts.length === 0 && records.length !== 1) return undefined;
  // Multiple sections for one effective destination describe intermediate
  // states, not one exact post-image. The reporting command accepts them, so
  // reject the ambiguity here rather than making superseded bytes citeable.
  const recordPaths = records.map((record) => record.path);
  if (new Set(recordPaths).size !== recordPaths.length) return undefined;
  const sectionStarts = starts.length > 0 ? starts : [0];
  const materializedPaths = new Set<string>();
  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index] ?? 0;
    const end = sectionStarts[index + 1] ?? normalized.length;
    const parsed = parseValidatedSectionHunks(normalized.slice(start, end));
    const record = records[index];
    if (!parsed || !record) return undefined;
    if (record.added === null || record.removed === null) {
      if (parsed.added !== 0 || parsed.removed !== 0) return undefined;
      continue;
    }
    if (parsed.added !== record.added || parsed.removed !== record.removed) return undefined;
    if (
      parsed.sawHunk ||
      createdPaths.has(record.path) ||
      sectionMaterializesDestinationWithoutHunk(normalized.slice(start, end))
    ) {
      materializedPaths.add(record.path);
    }
  }
  return { materializedPaths };
}

function evidenceCustodyIndexWeight(cacheKey: string, index: EvidenceCustodyIndex): number {
  const strings = [cacheKey, ...index.exactGitPaths];
  return 256 + strings.reduce((weight, value) => weight + value.length * 2 + 64, 0);
}

function rememberIndex(cacheKey: string, index: EvidenceCustodyIndex): EvidenceCustodyIndex {
  const existing = indexCache.get(cacheKey);
  if (existing) indexCacheBytes -= existing.weight;
  const weight = evidenceCustodyIndexWeight(cacheKey, index);
  if (weight > INDEX_CACHE_MAX_BYTES) return index;
  indexCache.set(cacheKey, { index, weight });
  indexCacheBytes += weight;
  while (indexCache.size > INDEX_CACHE_LIMIT || indexCacheBytes > INDEX_CACHE_MAX_BYTES) {
    const oldestKey = indexCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = indexCache.get(oldestKey);
    if (oldest) indexCacheBytes -= oldest.weight;
    indexCache.delete(oldestKey);
  }
  return index;
}

export function buildEvidenceCustodyIndex(
  content: string,
  options: EvidenceCustodyOptions = {},
): EvidenceCustodyIndex {
  const input = Buffer.from(content, "utf8");
  const sourceSha256 = crypto.createHash("sha256").update(input).digest("hex");
  if (input.toString("utf8") !== content) {
    return emptyIndex();
  }
  if (!looksLikePatch(content)) {
    return emptyIndex();
  }
  if (content.length > MAX_PATCH_CHARS || input.length > MAX_PATCH_BYTES) {
    return emptyIndex();
  }
  // CRLF and LF are accepted line terminators. Git treats a bare CR inside a
  // hunk line as content, so normalizing it would truncate authenticated bytes.
  // Reject that ambiguous patch form rather than certify a divergent post-image.
  if (/\r(?!\n)/.test(content)) {
    return emptyIndex();
  }

  const gitExecutable =
    options.gitExecutable === undefined ? resolveDefaultGitExecutable() : options.gitExecutable;
  const cacheKey = `${gitExecutable ?? "unavailable"}:${sourceSha256}`;
  if (options.gitExecutable === undefined) {
    const cached = indexCache.get(cacheKey);
    if (cached) {
      indexCache.delete(cacheKey);
      indexCache.set(cacheKey, cached);
      return cached.index;
    }
  }
  if (!gitExecutable) return emptyIndex();

  const result = spawnSync(
    gitExecutable,
    [
      "-c",
      "core.quotePath=false",
      "apply",
      // Per the official Git contract, both reporting options turn off patch
      // application unless `--apply` is also present. `--check` is deliberately
      // absent because it would test applicability against the unrelated TEMP
      // working tree and reject legitimate modification/deletion evidence.
      "--numstat",
      "--summary",
      "-z",
      "--whitespace=nowarn",
      "-p1",
      "-",
    ],
    {
      cwd: os.tmpdir(),
      encoding: null,
      env: gitEnvironment(),
      input,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const parsedOutput =
    !result.error && result.status === 0 && Buffer.isBuffer(result.stdout)
      ? parseGitOutput(result.stdout)
      : undefined;
  const parsedHunks = parsedOutput
    ? parseValidatedHunks(content, parsedOutput.records, parsedOutput.createdPaths)
    : undefined;
  if (!parsedOutput || !parsedHunks) {
    const invalidIndex = emptyIndex();
    const deterministicFailure = !result.error && typeof result.status === "number";
    return options.gitExecutable === undefined && deterministicFailure
      ? rememberIndex(cacheKey, invalidIndex)
      : invalidIndex;
  }

  const exactGitPaths = parsedOutput.records
    .filter(
      (record) =>
        record.added !== null &&
        record.removed !== null &&
        parsedHunks.materializedPaths.has(record.path) &&
        !parsedOutput.deletedPaths.has(record.path),
    )
    .map((record) => record.path);
  const index: EvidenceCustodyIndex = Object.freeze({
    exactGitPaths: Object.freeze([...new Set(exactGitPaths)]),
  });
  return options.gitExecutable === undefined ? rememberIndex(cacheKey, index) : index;
}
