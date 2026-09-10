// v07.00.00 (CROSREV-46, issue #301) — `review` evaluates a FIXED artifact.
//
// Three surfaces described the relator's job in `review` and they disagreed.
// `src/core/types.ts` and the MCP tool schema promised the lead "may emit a
// structured response". `leadShipModeDirective()` — the block that forbids one
// — was ship-only, consistent with that promise. But `buildRevisionPrompt`
// split circular-vs-everything-else, so a review lead was handed "Rewrite the
// solution considering every blocking issue" and "Return only the complete
// revised version, without meeting notes or external commentary."
//
// Both readings caused harm, in opposite directions:
//
//   - Obeying the prompt: a seat holding a 34,000-character artifact against a
//     20,000-token ceiling dies on max_output_tokens AFTER the round's votes
//     are paid. Measured session 17e75f42 — the failure issue #295 exists to
//     prevent — reachable in review mode because the output-ceiling screen was
//     the only thing refusing that seat.
//   - Obeying the contract: the short structured verdict replaced `draft`
//     unguarded, because drift detection is ship-only. The assessment silently
//     became the artifact the next round voted on and the `final_text`
//     returned, destroying the object of the review.
//
// The resolution (operator decision, 09/09/2026): the lead does not revise in
// review mode at all. It generates a first version only when the caller
// supplied none, and from then on the peers vote on that fixed artifact while
// the caller drives the next cycle. With no re-emission obligation, the
// output-ceiling screen does not apply to this mode either.
//
// Cases 1 and 2 fail against the previous behaviour. Cases 3 and 4 are the
// controls: `ship` must still revise between rounds, and the screen must still
// refuse a seat that cannot re-emit where the obligation does exist. Without
// them, disabling the relator or the screen outright would read as success.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { NoRelatorFitsOutputCeilingError } from "../src/core/relator-lottery.js";
import type { AppConfig, PeerAdapter, PeerId } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const ALL_PEERS: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok", "perplexity"];

function harnessConfig(prefix: string, ceiling: number): AppConfig {
  const base = loadConfig();
  const ceilings = Object.fromEntries(ALL_PEERS.map((peer) => [peer, ceiling])) as Record<
    PeerId,
    number
  >;
  return {
    ...base,
    data_dir: fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-${prefix}-`)),
    max_output_tokens_by_peer: ceilings,
    cost_rates: {
      codex: { input_per_million: 0, output_per_million: 0 },
      claude: { input_per_million: 0, output_per_million: 0 },
      gemini: { input_per_million: 0, output_per_million: 0 },
      deepseek: { input_per_million: 0, output_per_million: 0 },
      grok: { input_per_million: 0, output_per_million: 0 },
      perplexity: { input_per_million: 0, output_per_million: 0, search_queries_per_1000: 0 },
    },
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
}

// `call` is a reviewer vote; `generate` is the relator producing artifact text.
// The distinction is the whole measurement here: review mode must keep voting
// and must stop generating.
function countingAdapters(): {
  factory: (cfg: AppConfig) => Record<PeerId, PeerAdapter>;
  called: PeerId[];
  generated: PeerId[];
} {
  const called: PeerId[] = [];
  const generated: PeerId[] = [];
  const factory = (cfg: AppConfig): Record<PeerId, PeerAdapter> => {
    const adapters = {} as Record<PeerId, PeerAdapter>;
    for (const peer of ALL_PEERS) {
      const adapter = new StubAdapter(cfg, peer);
      adapters[peer] = new Proxy(adapter, {
        get(target, property, receiver) {
          if (property === "call" || property === "generate") {
            const original = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => unknown;
            return (...args: unknown[]) => {
              (property === "call" ? called : generated).push(peer);
              return original.apply(target, args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as PeerAdapter;
    }
    return adapters;
  };
  return { factory, called, generated };
}

// FORCE_NOT_READY keeps the peers from converging, so the session runs its
// rounds out. Without it the first round is unanimous and the between-rounds
// relator step is never reached, which would make cases 2 and 3 vacuous.
const NON_CONVERGING = "Evaluate the artifact. FORCE_NOT_READY";

async function capturedAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected_rejection_did_not_happen");
}

// --- 1. an artifact larger than every ceiling still reaches the reviewers --
{
  const config = harnessConfig("review-oversized", 250);
  const probe = countingAdapters();
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  const artifact = "q".repeat(300);
  const out = await orchestrator.runUntilUnanimous({
    task: NON_CONVERGING,
    caller: "claude",
    initial_draft: artifact,
    mode: "review",
    max_rounds: 1,
  });
  assert.ok(
    probe.called.length > 0,
    `a review session must reach its reviewers even when the artifact exceeds every ceiling: the lead never re-emits it; called=[${probe.called.join(", ")}]`,
  );
  assert.equal(
    out.final_text,
    artifact,
    "and the artifact under evaluation must come back byte-identical",
  );
  console.log("[v7.0.0-review-mode] oversized_artifact_still_reaches_reviewers: PASS");
}

// --- 2. the lead is never asked to revise in review mode ------------------
{
  const config = harnessConfig("review-no-revision", 64_000);
  const probe = countingAdapters();
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  const artifact = "The artifact under evaluation, submitted by the caller.";
  const out = await orchestrator.runUntilUnanimous({
    task: NON_CONVERGING,
    caller: "claude",
    initial_draft: artifact,
    mode: "review",
    max_rounds: 3,
  });
  assert.deepEqual(
    probe.generated,
    [],
    `review mode must not ask the lead to produce artifact text when the caller supplied one; generated=[${probe.generated.join(", ")}]`,
  );
  assert.ok(probe.called.length > 0, "the peers must still have voted, or the case proves nothing");
  assert.equal(
    out.final_text,
    artifact,
    "the object of the review must survive every round unchanged — a lead verdict must never become the artifact",
  );
  console.log("[v7.0.0-review-mode] lead_never_revises_the_artifact_under_review: PASS");
}

// --- 3. CONTROL: ship still revises between rounds ------------------------
{
  const config = harnessConfig("ship-still-revises", 64_000);
  const probe = countingAdapters();
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  await orchestrator.runUntilUnanimous({
    task: "Take the artifact to its final version. FORCE_NOT_READY",
    caller: "claude",
    initial_draft: "The artifact under refinement, submitted by the caller.",
    mode: "ship",
    max_rounds: 3,
  });
  assert.ok(
    probe.generated.length > 0,
    `CONTROL: ship mode must still ask the relator for a revision between rounds; generated=[${probe.generated.join(", ")}]`,
  );
  console.log("[v7.0.0-review-mode] control_ship_still_revises: PASS");
}

// --- 4. CONTROL: the ceiling screen still refuses where it must -----------
{
  const config = harnessConfig("ship-screen-holds", 250);
  const probe = countingAdapters();
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  const error = await capturedAsync(() =>
    orchestrator.runUntilUnanimous({
      task: "Take the artifact to its final version.",
      caller: "claude",
      initial_draft: "q".repeat(300),
      mode: "ship",
      max_rounds: 1,
    }),
  );
  assert.ok(
    error instanceof NoRelatorFitsOutputCeilingError,
    `CONTROL: ship obliges the relator to re-emit the artifact, so a seat that cannot must still be refused; got ${String(error)}`,
  );
  assert.deepEqual(probe.called, [], "CONTROL: and that refusal must still cost nothing");
  console.log("[v7.0.0-review-mode] control_screen_still_refuses_in_ship: PASS");
}

console.log("[v7.0.0-review-mode] ALL CASES PASS");
