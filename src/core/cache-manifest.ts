// v2.21.0 (caching): per-session cache manifest persistence.
//
// Path: ${data_dir}/sessions/${session_id}/cache_manifest.json
//
// Atomic write pattern mirrors session-store.ts writeJson: tmp file via
// `flag: "wx"` + crypto-random nonce + retry-on-Windows-EPERM. The
// manifest is APPEND-ONLY at the entry level — every peer call adds one
// row. Readers (dashboard, reports, FinOps) snapshot the file; the
// runtime never deletes rows from it.
//
// Concurrency: appends within the same process are serialized via a
// short re-read + write cycle. Cross-process appends on the same
// session are NOT supported (same as the rest of session-store.ts —
// SECURITY.md documents single-process-per-data-dir).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CacheManifest, CacheManifestEntry } from "./types.js";

export const CACHE_SCHEMA_VERSION_DEFAULT = "v1";
const MANIFEST_FILENAME = "cache_manifest.json";
const ATOMIC_WRITE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
const TMP_NONCE_BYTES = 2;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function manifestPath(dataDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid session_id for cache manifest: ${sessionId}`);
  }
  return path.resolve(dataDir, "sessions", sessionId, MANIFEST_FILENAME);
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(TMP_NONCE_BYTES).toString("hex");
  const tmp = `${file}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ATOMIC_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !ATOMIC_WRITE_RETRY_CODES.has(code)) break;
      // v4.1.0 hardening (Codex R1 catch on the broader F3 grep): this
      // second atomic-write helper had the SAME CPU-burning busy-wait
      // as session-store.ts writeJson (now fixed). The single Node
      // event loop was being blocked for up to 310 ms (10+20+40+80+160)
      // per cache_manifest append under Windows-AV-induced
      // EPERM/EBUSY contention. Promise + setTimeout: event loop
      // remains fully responsive.
      const wait = 10 * 2 ** attempt;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/**
 * Read the manifest from disk. Returns null when the file is absent
 * (most sessions never emit cache telemetry, so the manifest is
 * lazily created on first append).
 */
export function readCacheManifest(dataDir: string, sessionId: string): CacheManifest | null {
  const file = manifestPath(dataDir, sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as CacheManifest;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write a complete manifest, replacing any existing file. Mostly used
 * by tests; production callers should append entries via
 * appendCacheManifestEntry.
 */
export async function writeCacheManifest(
  dataDir: string,
  sessionId: string,
  manifest: CacheManifest,
): Promise<void> {
  await writeJsonAtomic(manifestPath(dataDir, sessionId), manifest);
}

/**
 * Append a single entry to the session manifest. Lazily creates the
 * manifest if it does not exist. Each call performs (a) read-current,
 * (b) push entry, (c) atomic-write. This is sequential within a
 * process; concurrent calls in the same process must be awaited in
 * order by the caller.
 */
export async function appendCacheManifestEntry(
  dataDir: string,
  sessionId: string,
  entry: CacheManifestEntry,
  cacheSchemaVersion: string = CACHE_SCHEMA_VERSION_DEFAULT,
): Promise<void> {
  const file = manifestPath(dataDir, sessionId);
  const nowIso = new Date().toISOString();
  let current: CacheManifest;
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      current = JSON.parse(raw) as CacheManifest;
    } catch {
      // Corrupted manifest: rebuild from scratch with this entry as
      // the sole row. Old contents are best-effort backed up next to
      // the file with a `.corrupt-<ts>` suffix so an operator can
      // forensically inspect.
      const corrupt = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, corrupt);
      } catch {
        /* ignore */
      }
      current = {
        session_id: sessionId,
        cache_schema_version: cacheSchemaVersion,
        created_at: nowIso,
        updated_at: nowIso,
        entries: [],
      };
    }
  } else {
    current = {
      session_id: sessionId,
      cache_schema_version: cacheSchemaVersion,
      created_at: nowIso,
      updated_at: nowIso,
      entries: [],
    };
  }
  current.entries.push(entry);
  current.updated_at = nowIso;
  await writeJsonAtomic(file, current);
}
