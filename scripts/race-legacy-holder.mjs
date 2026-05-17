#!/usr/bin/env node
// v4.1.0 / F1 codex catches (session 059b0093 R1..R4): a v4.1.0
// process MUST NOT auto-remove a pre-v4.1.0 legacy `.lock` regular
// file. Across four iterations Codex demonstrated that no auto-clean
// is safe under live cross-version v4.0/v4.1 concurrency, because
// v4.0.x's own stale-removal path doesn't honor any v4.1 mutex.
// v4.1.0's final policy: FAIL CLOSED — throw a remediation error
// when a legacy regular `.lock` is observed.
//
// This regression plants `.lock` as a regular file in several
// shapes and asserts that:
//   1. v4.1.0 does NOT enter the critical section.
//   2. v4.1.0 does NOT remove the legacy file.
//   3. v4.1.0 surfaces the "detected a pre-v4.1.0 lock file" error
//      to the caller (clear remediation guidance).
//
// Run: node scripts/race-legacy-holder.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const storeModuleUrl = pathToFileURL(
  path.join(cwd, "dist", "src", "core", "session-store.js"),
).href;
const { SessionStore } = await import(storeModuleUrl);

async function runScenario(label, plant) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cr-legacy-${label}-`));
  const cfg = {
    data_dir: dataDir,
    version: "4.1.0-legacy",
    budget: { max_session_cost_usd: 10 },
  };
  const store = new SessionStore(cfg);
  const meta = await store.init(`legacy holder ${label}`, "operator", []);
  const sessionId = meta.session_id;
  const dir = store.sessionDir(sessionId);
  const lockfilePath = path.join(dir, ".lock");
  try {
    fs.rmSync(lockfilePath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  plant(lockfilePath);
  const planted = fs.statSync(lockfilePath);
  console.log(
    JSON.stringify({
      stage: `${label}.planted`,
      lockfile_isFile: planted.isFile(),
      size: planted.size,
    }),
  );
  let didEnterCriticalSection = false;
  let errMsg = null;
  try {
    await store.markInFlight(sessionId, {
      round: 42,
      started_at: new Date().toISOString(),
      enabled_peers: [],
    });
    didEnterCriticalSection = true;
  } catch (err) {
    errMsg = err?.message ?? String(err);
  }
  const afterExists = fs.existsSync(lockfilePath);
  const afterStat = afterExists ? fs.statSync(lockfilePath) : null;
  console.log(
    JSON.stringify({
      stage: `${label}.post-attempt`,
      did_enter_critical_section: didEnterCriticalSection,
      error_excerpt: errMsg ? errMsg.slice(0, 100) : null,
      legacy_lockfile_still_present: afterExists,
      legacy_lockfile_isFile: afterStat?.isFile() ?? null,
    }),
  );

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  if (didEnterCriticalSection) {
    console.error(
      `[legacy/${label}] FAIL v4.1.0 entered critical section with legacy lock present`,
    );
    process.exit(1);
  }
  if (!afterExists) {
    console.error(
      `[legacy/${label}] FAIL v4.1.0 removed the legacy lockfile (fail-closed policy: NEVER remove)`,
    );
    process.exit(1);
  }
  if (persisted.in_flight?.round === 42) {
    console.error(`[legacy/${label}] FAIL meta.json was mutated despite the migration error`);
    process.exit(1);
  }
  if (!errMsg?.includes("detected a pre-v4.1.0 lock file")) {
    console.error(
      `[legacy/${label}] FAIL expected "detected a pre-v4.1.0 lock file" error, got: ${errMsg}`,
    );
    process.exit(1);
  }
  console.log(
    `[legacy/${label}] PASS fail-closed: legacy lock preserved, v4.1.0 did not enter CS, clear remediation surfaced.`,
  );
}

// Scenario 1: parseable JSON, live pid, fresh mtime.
await runScenario("live-pid-fresh-mtime", (lockfilePath) => {
  fs.writeFileSync(lockfilePath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
});

// Scenario 2: parseable JSON, live pid, STALE mtime.
await runScenario("live-pid-stale-mtime", (lockfilePath) => {
  fs.writeFileSync(lockfilePath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const past = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lockfilePath, past, past);
});

// Scenario 3: parseable JSON, dead pid (R1-R3 would have auto-cleaned;
// R4 fails closed because auto-clean is unsafe under mixed-version).
await runScenario("dead-pid", (lockfilePath) => {
  fs.writeFileSync(lockfilePath, JSON.stringify({ pid: 999999, ts: Date.now() }));
});

// Scenario 4: 0-byte file (TOCTOU pre-metadata-write window) — still
// fail-closed.
await runScenario("empty-fresh-mtime", (lockfilePath) => {
  fs.writeFileSync(lockfilePath, "");
});

// Scenario 5: empty file with stale mtime — still fail-closed.
await runScenario("empty-stale-mtime", (lockfilePath) => {
  fs.writeFileSync(lockfilePath, "");
  const past = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lockfilePath, past, past);
});

console.log(
  "[legacy] ALL PASS: every legacy regular `.lock` file (5 shapes) preserved; v4.1.0 fail-closed across the matrix.",
);
process.exit(0);
