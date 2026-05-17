#!/usr/bin/env node
// v4.1.0 / F1 codex R3+R4 catches (session 059b0093): the
// inspect+remove window during legacy `.lock` migration is a TOCTOU
// race that cannot be closed under live cross-version concurrent
// operation. Even with a v4.1↔v4.1 mutex, a v4.0.x process doing its
// OWN stale-removal-and-recreate (the pre-v4.1.0 broken lock
// primitive) can swap the file between v4.1's inspect and v4.1's
// `rmSync` — v4.1 then deletes a NEW LIVE legacy lock created by
// v4.0.x and enters its critical section in parallel = split-brain.
//
// R4 resolution: FAIL CLOSED. v4.1.0 NEVER auto-removes a legacy
// regular `.lock` file. Surface a clear remediation error and require
// the operator to remove the file manually after stopping all
// cross-review processes.
//
// This regression exercises the codex interleaving and asserts that:
//   - Neither v4.1.0 migrator enters the critical section,
//   - Neither v4.1.0 migrator removes the legacy lockfile,
//   - The legacy holder's lockfile is present at end-of-CS and still
//     names its own PID (no v4.1.0 stole the path under it),
//   - Every v4.1.0 attempt against the legacy file returned the
//     fail-closed remediation error.
//
// 3-process orchestration:
//   - V41_A: starts immediately, races for the stale lock.
//   - LEGACY (v4.0 simulator): on start signal, acquires legacy lock
//     via `fs.openSync(.lock, "wx") + write {pid, ts}`, holds 8 s,
//     snapshots, unlinks.
//   - V41_B: starts after LEGACY has entered its CS — runs INTO a
//     live legacy lock and must fail-closed.
//
// Run: node scripts/race-migration-toctou.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const storeModuleUrl = pathToFileURL(
  path.join(cwd, "dist", "src", "core", "session-store.js"),
).href;

if (process.env.PRPL_LEGACY_SIMULATOR === "1") {
  const lockfilePath = process.env.PRPL_LOCKFILE_PATH;
  const startSignal = process.env.PRPL_START_SIGNAL;
  const v41aDoneSignal = `${startSignal}.v41a-done`;
  const enteredSignal = `${startSignal}.legacy-entered`;
  const exitSignal = `${startSignal}.legacy-exit`;
  // LEGACY waits for V41_A to finish (so V41_A sees the planted
  // stale file). Then LEGACY does v4.0.x's stale-removal-and-reclaim.
  while (!fs.existsSync(v41aDoneSignal)) {
    await new Promise((r) => setTimeout(r, 30));
  }
  // v4.0.x-style acquire: fs.openSync wx then write {pid, ts}. If the
  // path is currently a stale dead-pid file v4.0.x would have its own
  // stale-removal logic; here we simulate the post-removal state by
  // looping until openSync wx succeeds (i.e. file is gone).
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockfilePath, "wx");
    } catch (err) {
      if (err.code === "EEXIST") {
        // Pre-v4.1.0 would stale-detect + remove + retry. To exercise
        // that path safely from the simulator, unlink first then
        // openSync — but a real v4.0.x would only do this if the
        // existing file's pid is dead. Our planted file is dead-pid
        // 999999, so v4.0.x's stale-detection WOULD remove it.
        try {
          fs.unlinkSync(lockfilePath);
        } catch {
          /* race with v4.1 — fine */
        }
        await new Promise((r) => setTimeout(r, 30));
        continue;
      }
      throw err;
    }
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  fs.closeSync(fd);
  fs.writeFileSync(enteredSignal, "");
  // Hold inside CS for 8 s — long enough for both v4.1 migrators to
  // attempt and observe the live legacy file.
  await new Promise((r) => setTimeout(r, 8000));
  // Snapshot file state at end-of-CS so the parent can verify no v4.1
  // migrator touched it during the CS.
  let endStat = null;
  let endContent = null;
  try {
    endStat = fs.statSync(lockfilePath);
    endContent = fs.readFileSync(lockfilePath, "utf8");
  } catch {
    /* file gone — would be the bug */
  }
  fs.writeFileSync(
    exitSignal,
    JSON.stringify({
      end_of_cs_file_exists: endStat !== null,
      end_of_cs_isFile: endStat?.isFile() ?? null,
      end_of_cs_content_pid_matches: (() => {
        try {
          return JSON.parse(endContent).pid === process.pid;
        } catch {
          return false;
        }
      })(),
    }),
  );
  try {
    fs.unlinkSync(lockfilePath);
  } catch {
    /* already unlinked */
  }
  process.exit(0);
}

if (process.env.PRPL_V41_MIGRATOR === "1") {
  const sessionId = process.env.PRPL_SESSION_ID;
  const dataDir = process.env.PRPL_DATA_DIR;
  const startSignal = process.env.PRPL_START_SIGNAL;
  const v41aDoneSignal = `${startSignal}.v41a-done`;
  const role = process.env.PRPL_V41_ROLE; // "A" or "B"
  const enteredSignal = `${startSignal}.legacy-entered`;
  while (!fs.existsSync(startSignal)) {
    await new Promise((r) => setTimeout(r, 30));
  }
  if (role === "B") {
    while (!fs.existsSync(enteredSignal)) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const { SessionStore } = await import(storeModuleUrl);
  const cfg = { data_dir: dataDir, version: "4.1.0-mig", budget: { max_session_cost_usd: 10 } };
  const store = new SessionStore(cfg);
  const lockPathForCheck = path.join(store.sessionDir(sessionId), ".lock");
  let preStat;
  try {
    const s = fs.statSync(lockPathForCheck);
    preStat = { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  } catch (err) {
    preStat = { error: err.code };
  }
  const t0 = Date.now();
  let didEnter = false;
  let errMsg = null;
  try {
    await store.markInFlight(sessionId, {
      round: 99,
      started_at: new Date().toISOString(),
      enabled_peers: [],
    });
    didEnter = true;
  } catch (err) {
    errMsg = err?.message ?? String(err);
  }
  const elapsed = Date.now() - t0;
  console.log(
    JSON.stringify({
      role: `v41-migrator-${role}`,
      pid: process.pid,
      elapsed_ms: elapsed,
      did_enter_critical_section: didEnter,
      error_excerpt: errMsg ? errMsg.slice(0, 100) : null,
      pre_attempt_lockfile_stat: preStat,
    }),
  );
  // V41_A signals completion so LEGACY can proceed (modeling the
  // codex interleaving where v4.1 runs first, decides not to remove,
  // then v4.0.x comes along and acquires the lock).
  if (role === "A") {
    fs.writeFileSync(v41aDoneSignal, "");
  }
  process.exit(didEnter ? 99 : 0);
}

// Orchestrator mode
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-toctou-"));
const cfg = { data_dir: dataDir, version: "4.1.0-mig", budget: { max_session_cost_usd: 10 } };
const { SessionStore } = await import(storeModuleUrl);
const store = new SessionStore(cfg);
const meta = await store.init("R4 toctou regression (fail-closed)", "operator", []);
const sessionDir = store.sessionDir(meta.session_id);
const lockfilePath = path.join(sessionDir, ".lock");

try {
  fs.rmSync(lockfilePath, { recursive: true, force: true });
} catch {
  /* ignore */
}
// Plant stale dead-pid legacy `.lock`.
fs.writeFileSync(lockfilePath, JSON.stringify({ pid: 999999, ts: Date.now() }));
const past = new Date(Date.now() - 5 * 60 * 1000);
fs.utimesSync(lockfilePath, past, past);

const startSignal = path.join(dataDir, "start.signal");
const exitSignal = `${startSignal}.legacy-exit`;

const childArgs = [
  "--input-type=module",
  "-e",
  `await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/race-migration-toctou.mjs")).href)});`,
];

const v41a = spawn(process.execPath, childArgs, {
  env: {
    ...process.env,
    PRPL_V41_MIGRATOR: "1",
    PRPL_V41_ROLE: "A",
    PRPL_SESSION_ID: meta.session_id,
    PRPL_DATA_DIR: dataDir,
    PRPL_START_SIGNAL: startSignal,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let v41a_stdout = "";
v41a.stdout.on("data", (d) => (v41a_stdout += d.toString()));
v41a.stderr.on("data", () => {});

const legacy = spawn(process.execPath, childArgs, {
  env: {
    ...process.env,
    PRPL_LEGACY_SIMULATOR: "1",
    PRPL_LOCKFILE_PATH: lockfilePath,
    PRPL_START_SIGNAL: startSignal,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const v41b = spawn(process.execPath, childArgs, {
  env: {
    ...process.env,
    PRPL_V41_MIGRATOR: "1",
    PRPL_V41_ROLE: "B",
    PRPL_SESSION_ID: meta.session_id,
    PRPL_DATA_DIR: dataDir,
    PRPL_START_SIGNAL: startSignal,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let v41b_stdout = "";
v41b.stdout.on("data", (d) => (v41b_stdout += d.toString()));
v41b.stderr.on("data", () => {});

await new Promise((r) => setTimeout(r, 200));
fs.writeFileSync(startSignal, "");

const codes = await Promise.all(
  [v41a, legacy, v41b].map((c) => new Promise((res) => c.on("exit", (code) => res(code ?? -1)))),
);

const exitInfo = JSON.parse(fs.readFileSync(exitSignal, "utf8"));
console.log(
  JSON.stringify({
    role: "orchestrator",
    v41a_exit: codes[0],
    legacy_exit: codes[1],
    v41b_exit: codes[2],
    v41a_stdout: v41a_stdout.trim(),
    v41b_stdout: v41b_stdout.trim(),
    legacy_cs_end: exitInfo,
  }),
);

let ok = true;
// Both v4.1 migrators must fail-closed (exit 0, did_enter=false,
// error includes "detected a pre-v4.1.0 lock file").
function parseMigratorReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
const v41a_report = parseMigratorReport(v41a_stdout);
const v41b_report = parseMigratorReport(v41b_stdout);

if (codes[0] !== 0) {
  console.error(`[toctou] FAIL v41a exited ${codes[0]} (expected 0 — fail-closed)`);
  ok = false;
}
if (codes[2] !== 0) {
  console.error(`[toctou] FAIL v41b exited ${codes[2]} (expected 0 — fail-closed)`);
  ok = false;
}
if (codes[1] !== 0) {
  console.error(`[toctou] FAIL legacy simulator exited ${codes[1]} (expected 0)`);
  ok = false;
}
if (v41a_report?.did_enter_critical_section) {
  console.error("[toctou] FAIL v41a entered critical section despite legacy lock present");
  ok = false;
}
if (v41b_report?.did_enter_critical_section) {
  console.error("[toctou] FAIL v41b entered critical section despite legacy lock present");
  ok = false;
}
if (!v41a_report?.error_excerpt?.includes("detected a pre-v4.1.0 lock file")) {
  console.error(
    `[toctou] FAIL v41a expected fail-closed remediation error, got: ${v41a_report?.error_excerpt}`,
  );
  ok = false;
}
if (!v41b_report?.error_excerpt?.includes("detected a pre-v4.1.0 lock file")) {
  console.error(
    `[toctou] FAIL v41b expected fail-closed remediation error, got: ${v41b_report?.error_excerpt}`,
  );
  ok = false;
}
if (!exitInfo.end_of_cs_file_exists) {
  console.error(
    "[toctou] FAIL legacy holder's lockfile was DELETED while it was inside its critical section",
  );
  ok = false;
}
if (!exitInfo.end_of_cs_content_pid_matches) {
  console.error(
    "[toctou] FAIL legacy holder's lockfile content was REPLACED during its critical section",
  );
  ok = false;
}
if (!ok) process.exit(1);

console.log(
  "[toctou] PASS fail-closed: both v4.1 migrators returned the remediation error without entering CS or touching the legacy lockfile; legacy holder's lockfile preserved throughout its critical section.",
);
process.exit(0);
