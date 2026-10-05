// v2.15.0 (item 3, operator directive 2026-05-04 — project_cross_review_v2_v215_backlog_candidates.md):
// real-API smoke marker for "default model rejects parameter".
// Opt-in: requires CROSS_REVIEW_REAL_API_SMOKE=1 plus the relevant
// provider API keys in env. Stubs are NOT a substitute here — the whole
// point is to exercise live provider 4xx surfaces so the docs-hint path
// (item 5) and the per-model allowlist gate (item 6) prove themselves
// in production conditions, not just on synthetic inputs.
//
// What it does:
//  - For each selected supported peer, request a tiny live generation
//    using the configured model. A successful call proves that this live
//    request was accepted; offline SDK payload tests verify exact parameters.
//  - Missing credentials, unsupported peers, empty selection, and every
//    provider rejection leave the live contract unverified and exit non-zero.
//    Quota failures are reported as failed verification, not code defects.
//
// This internal agent/maintainer validation is opt-in and never runs in CI
// by default. Run it from an already authorized persistent secret session
// after release/reload, with CROSS_REVIEW_REAL_API_SMOKE=1 and the intended
// CROSS_REVIEW_GROK_MODEL configured, using npm run runtime-default-smoke.
import process from "node:process";
import { loadConfig } from "../src/core/config.js";
import type { PeerCallContext, RuntimeEvent } from "../src/core/types.js";
import { GrokAdapter, modelAcceptsReasoningEffort } from "../src/peers/grok.js";

const ENABLED = process.env.CROSS_REVIEW_REAL_API_SMOKE === "1";
if (!ENABLED) {
  console.log(
    "[runtime-default-smoke] CROSS_REVIEW_REAL_API_SMOKE!=1; this script is opt-in. Skipping.",
  );
  process.exit(0);
}

const peersToTest = (process.env.PEERS_TO_TEST ?? "grok")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const config = loadConfig();
let attempted = 0;
let completed = 0;
let skipped = 0;
let failures = 0;

function emit(event: RuntimeEvent): void {
  // Suppress streaming token noise; surface only key lifecycle events.
  if (event.type.startsWith("peer.token.")) return;
  console.log(`[event] ${event.type} ${event.message ?? ""}`);
}

async function exerciseGrok(): Promise<void> {
  attempted += 1;
  if (!config.api_keys.grok) {
    console.error(
      "[runtime-default-smoke] FAIL — Grok API key is missing; no contract was tested.",
    );
    failures += 1;
    return;
  }
  const model = config.models.grok;
  console.log(`[runtime-default-smoke] grok model=${model}`);
  console.log(
    `[runtime-default-smoke] modelAcceptsReasoningEffort(${model})=${modelAcceptsReasoningEffort(model)}`,
  );
  const context: PeerCallContext = {
    session_id: "00000000-0000-4000-8000-000000000000",
    round: 0,
    task: "runtime-default-smoke",
    emit,
  };
  try {
    const adapter = new GrokAdapter(config);
    const result = await adapter.generate("Reply with the single token: ok.", context);
    completed += 1;
    console.log(
      `[runtime-default-smoke] grok generation ok: ${result.text.slice(0, 40)} (${result.latency_ms}ms)`,
    );
    if (!modelAcceptsReasoningEffort(model)) {
      console.log(
        "[runtime-default-smoke] PASS — non-allowlist model omitted reasoning.effort and succeeded (item 6 verified).",
      );
    } else {
      console.log(
        "[runtime-default-smoke] PASS — allowlist model accepted reasoning.effort and succeeded.",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      /reasoning\.effort/i.test(message) &&
      /\b(?:not\s+supported|invalid|400|argument)\b/i.test(message)
    ) {
      console.log(
        `[runtime-default-smoke] FAIL — provider rejected reasoning.effort but the runtime should have gated it. Message: ${message}`,
      );
      failures += 1;
    } else {
      console.log(
        `[runtime-default-smoke] FAIL — Grok contract could not be verified. Message: ${message}`,
      );
      failures += 1;
    }
  }
}

for (const peer of peersToTest) {
  if (peer === "grok") {
    await exerciseGrok();
  } else {
    skipped += 1;
    failures += 1;
    console.error(
      `[runtime-default-smoke] FAIL — peer=${peer} is unsupported; no contract was tested.`,
    );
  }
}

if (attempted === 0 && failures === 0) {
  failures += 1;
  console.error("[runtime-default-smoke] FAIL — no peers were selected or tested.");
}
console.log(
  `[runtime-default-smoke] attempted=${attempted} completed=${completed} skipped=${skipped} failures=${failures}`,
);
if (failures > 0) process.exit(1);
console.log("[runtime-default-smoke] all attempted contracts passed.");
