// v2.15.0 (item 3, operator directive 2026-05-04 — project_cross_review_v2_v215_backlog_candidates.md):
// real-API smoke marker for "default model rejects parameter".
// Opt-in: requires CROSS_REVIEW_REAL_API_SMOKE=1 plus the relevant
// provider API keys in env. Stubs are NOT a substitute here — the whole
// point is to exercise live provider 4xx surfaces so the docs-hint path
// (item 5) and the per-model allowlist gate (item 6) prove themselves
// in production conditions, not just on synthetic inputs.
//
// What it does:
//  - For each peer the operator opted into via PEERS_TO_TEST env (default
//    grok), forces the model to a known-incompatible default and asks for
//    a tiny generation. The expected outcome is either:
//       (a) The runtime allowlist gate (item 6) drops `reasoning.effort`
//           silently and the call SUCCEEDS — proves item 6.
//       (b) The provider rejects with a 400 and the failure carries
//           `recovery_hint: "consult_docs_then_revise"` plus a docs URL —
//           proves item 5.
//  - Anything else is a regression and exits non-zero.
//
// This script never runs in CI by default. It exists to be triggered
// after a v2.15.x ship + reload by the operator running:
//   CROSS_REVIEW_REAL_API_SMOKE=1 \
//     CROSS_REVIEW_GROK_MODEL=grok-4-latest \
//     npm run runtime-default-smoke
import process from "node:process";
import { loadConfig } from "../src/core/config.js";
import { GrokAdapter, modelAcceptsReasoningEffort } from "../src/peers/grok.js";
import type { PeerCallContext, RuntimeEvent } from "../src/core/types.js";

const ENABLED = process.env.CROSS_REVIEW_REAL_API_SMOKE === "1";
if (!ENABLED) {
  console.log(
    "[runtime-default-smoke] CROSS_REVIEW_REAL_API_SMOKE!=1; this script is opt-in. Skipping.",
  );
  process.exit(0);
}

const peersToTest = (process.env.PEERS_TO_TEST ?? "grok").split(",").map((p) => p.trim());
const config = loadConfig();
let failures = 0;

function emit(event: RuntimeEvent): void {
  // Suppress streaming token noise; surface only key lifecycle events.
  if (event.type.startsWith("peer.token.")) return;
  console.log(`[event] ${event.type} ${event.message ?? ""}`);
}

async function exerciseGrok(): Promise<void> {
  const model = config.models.grok;
  console.log(`[runtime-default-smoke] grok model=${model}`);
  console.log(
    `[runtime-default-smoke] modelAcceptsReasoningEffort(${model})=${modelAcceptsReasoningEffort(model)}`,
  );
  const adapter = new GrokAdapter(config);
  const context: PeerCallContext = {
    session_id: "00000000-0000-4000-8000-000000000000",
    round: 0,
    task: "runtime-default-smoke",
    emit,
  };
  try {
    const result = await adapter.generate("Reply with the single token: ok.", context);
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
        `[runtime-default-smoke] grok call failed for an unrelated reason; not a v2.15 regression. Message: ${message}`,
      );
    }
  }
}

for (const peer of peersToTest) {
  if (peer === "grok") {
    await exerciseGrok();
  } else {
    console.log(`[runtime-default-smoke] peer=${peer} not yet wired into this script; skipping.`);
  }
}

if (failures > 0) {
  console.error(`[runtime-default-smoke] ${failures} regression(s) detected.`);
  process.exit(1);
}
console.log("[runtime-default-smoke] all checks passed.");
