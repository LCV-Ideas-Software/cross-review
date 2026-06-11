#!/usr/bin/env node
// v4.1.0 / F1 empirical demo: spawn N child processes, all racing to mutate
// the SAME session's meta.json under withSessionLock. The pre-v4.1.0 lock
// had a multi-process TOCTOU window (empty-file between openSync(wx) and
// writeFileSync); under contention, multiple processes could enter the
// critical section in parallel and last-writer-wins would corrupt the
// rounds[] array. v4.1.0 uses proper-lockfile's mkdir-atomic lock; no race
// possible. This reproducer asserts the post-race meta.rounds.length equals
// the total number of appendRound calls across all processes (no losses).
//
// Run: PRPL_PROCS=4 PRPL_ROUNDS_PER_PROC=5 node scripts/race-reproducer.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const storeModuleUrl = pathToFileURL(
  path.join(root, "dist", "src", "core", "session-store.js"),
).href;

const PROCS = Number.parseInt(process.env.PRPL_PROCS ?? "4", 10);
const ROUNDS = Number.parseInt(process.env.PRPL_ROUNDS_PER_PROC ?? "5", 10);
const EXPECTED_ROUNDS = PROCS * ROUNDS;

// Worker mode: spawned children run this branch and bang on the same session.
// Branch on PRPL_WORKER BEFORE allocating any orchestrator-only resources
// (e.g. mkdtempSync) — otherwise every worker would leak an orphan tmpdir
// when this module is re-imported in the child process.
if (process.env.PRPL_WORKER === "1") {
  const { SessionStore } = await import(storeModuleUrl);
  const cfg = {
    data_dir: process.env.PRPL_DATA_DIR,
    version: "4.1.0-race",
    budget: { max_session_cost_usd: 10 },
  };
  const sessionId = process.env.PRPL_SESSION_ID;
  const store = new SessionStore(cfg);
  const rounds = Number.parseInt(process.env.PRPL_ROUNDS_PER_PROC ?? "5", 10);
  let written = 0;
  for (let i = 0; i < rounds; i++) {
    try {
      await store.appendRound(sessionId, {
        caller_status: "READY",
        prompt_file: `pid${process.pid}-round${i}-prompt.md`,
        peers: [],
        rejected: [],
        convergence: { converged: true, reason: `pid${process.pid}_round${i}`, ready_peers: [] },
        convergence_scope: { petitioner: "operator", caller: "operator" },
        started_at: new Date().toISOString(),
      });
      written += 1;
    } catch (err) {
      console.error(`[worker pid=${process.pid}] round ${i} threw: ${err?.message ?? err}`);
    }
  }
  console.log(`[worker pid=${process.pid}] wrote ${written}/${rounds} rounds`);
  process.exit(0);
}

// Orchestrator mode: init the session, fork children, wait, validate.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-race-"));
console.log(`[race] data_dir=${dataDir} procs=${PROCS} rounds_per_proc=${ROUNDS}`);

const { SessionStore } = await import(storeModuleUrl);
const cfg = { data_dir: dataDir, version: "4.1.0-race", budget: { max_session_cost_usd: 10 } };
const store = new SessionStore(cfg);
const meta = await store.init("race reproducer", "operator", []);
console.log(`[race] init session=${meta.session_id}`);

const workers = [];
const t0 = Date.now();
for (let p = 0; p < PROCS; p++) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.env.PRPL_WORKER='1';process.env.PRPL_SESSION_ID=${JSON.stringify(meta.session_id)};process.env.PRPL_DATA_DIR=${JSON.stringify(dataDir)};process.env.PRPL_ROUNDS_PER_PROC=${JSON.stringify(String(ROUNDS))};await import(${JSON.stringify(pathToFileURL(__filename).href)});`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  workers.push(
    new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    }),
  );
}
const codes = await Promise.all(workers);
const elapsed = Date.now() - t0;
console.log(`[race] all ${PROCS} workers exited in ${elapsed}ms; codes=${codes.join(",")}`);
const anyNonZero = codes.some((c) => c !== 0);

// Read meta from disk (no cache); count rounds.
const metaPath = path.join(store.sessionDir(meta.session_id), "meta.json");
const raw = fs.readFileSync(metaPath, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`[race] FAIL meta.json failed to parse: ${err?.message}`);
  process.exit(1);
}
const actualRounds = parsed.rounds?.length ?? 0;
console.log(`[race] disk meta.rounds.length=${actualRounds} expected=${EXPECTED_ROUNDS}`);
if (actualRounds !== EXPECTED_ROUNDS) {
  console.error(
    `[race] FAIL race detected: ${EXPECTED_ROUNDS - actualRounds} rounds lost (last-writer-wins corruption under multi-process contention).`,
  );
  process.exit(1);
}
if (anyNonZero) {
  console.error(`[race] FAIL one or more worker processes exited non-zero`);
  process.exit(1);
}
console.log(
  `[race] PASS withSessionLock held — all ${EXPECTED_ROUNDS} rounds persisted across ${PROCS} processes with no losses.`,
);
process.exit(0);
