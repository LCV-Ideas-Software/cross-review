// v07.00.00 — the relator draw respects the output ceiling of the role
// (CROSREV-43, issue #295).
//
// The relator is the only role that must re-emit the whole artifact inside
// its own `max_output_tokens`. Measured twice over the same artifact, same
// peer drawn relator, runtime 5.0.0:
//
//   session 17e75f42 — draft 34 KB, gemini ceiling 20,000 tokens
//                    → `gemini_max_tokens_exhausted`, job dropped, US$ 2,20
//                      of votes already paid.
//   session a0efbf5e — draft  6 KB, same ceiling
//                    → no overflow; the relator fabricated instead and the
//                      anti-fraud gate aborted, US$ 2,49 already paid.
//
// Both deaths arrived AFTER the round's votes. These cases pin the two
// halves of the fix: the draw refuses a peer whose ceiling does not hold the
// draft (redrawing among those that do), and when nobody holds it the run
// fails before a single peer call — with the ceiling, the draft size and both
// operator levers named in the diagnosis.
//
// The fit rule is `ceiling_tokens >= draft_chars`. It is a SCREEN, not a proof
// of capacity: reasoning tokens are charged against the same ceiling in a share
// nobody can observe before dispatch, and a character is not always at most one
// token. It reproduces both measurements above and refuses the grossly
// mismatched seat; it does not promise the seated peer will fit.
//
// Cases 9 and 10 were added after the PR #300 review caught that `circular`
// mode screened only its first rotator. The remaining rotators are asked to
// re-emit the same artifact, so an unscreened low-ceiling peer re-entered
// through the rotation and reproduced the very failure this file exists to
// prevent — after the earlier rotations had been paid.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import {
  assignRelator,
  LeadPeerCannotFitDraftError,
  NoRelatorFitsOutputCeilingError,
  partitionRelatorPoolByOutputFit,
  type RelatorOutputFit,
  resolveLeadPeer,
} from "../src/core/relator-lottery.js";
import type { AppConfig, PeerAdapter, PeerId, RuntimeEvent } from "../src/core/types.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

// The ceilings in force when both sessions were measured (issue #295).
const MEASURED_CEILINGS: Record<PeerId, number> = {
  claude: 64_000,
  codex: 25_000,
  gemini: 20_000,
  deepseek: 20_000,
  grok: 20_000,
  perplexity: 20_000,
};

function fitFor(draftChars: number, ceilings: Record<PeerId, number>): RelatorOutputFit {
  return { draft_chars: draftChars, ceiling_tokens: (peer) => ceilings[peer] };
}

const ALL_PEERS: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok", "perplexity"];

// `assert.throws`/`assert.rejects` return nothing, so the thrown value is
// captured here — every case below asserts on the diagnosis text itself.
function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected_throw_did_not_happen");
}

async function capturedAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected_rejection_did_not_happen");
}

// --- 1. the 34 KB session: the peer that died is refused -------------------
{
  const { eligible, excluded } = partitionRelatorPoolByOutputFit(
    ["gemini"],
    fitFor(34_000, MEASURED_CEILINGS),
  );
  assert.deepEqual(eligible, [], "gemini@20,000 must not hold a 34,000-character draft");
  assert.deepEqual(excluded, [{ peer: "gemini", ceiling_tokens: 20_000, draft_chars: 34_000 }]);
  console.log("[v7.0.0-relator-ceiling] measured_34kb_draft_refuses_the_peer_that_died: PASS");
}

// --- 2. the 6 KB session: the same peer stays eligible ---------------------
// The second measurement is the one that keeps the rule honest: with the
// draft reduced the relator stopped overflowing, so a rule that refused
// gemini here would be refusing a seat it demonstrably could occupy.
{
  const { eligible, excluded } = partitionRelatorPoolByOutputFit(
    ["gemini"],
    fitFor(6_000, MEASURED_CEILINGS),
  );
  assert.deepEqual(eligible, ["gemini"], "gemini@20,000 holds a 6,000-character draft");
  assert.deepEqual(excluded, [], "nothing may be refused at this size");
  console.log("[v7.0.0-relator-ceiling] measured_6kb_draft_keeps_the_peer: PASS");
}

// --- 3. the draw redraws to the peer that fits -----------------------------
{
  const assignment = assignRelator(
    "codex",
    ALL_PEERS.filter((peer) => peer !== "codex"),
    undefined,
    fitFor(34_000, MEASURED_CEILINGS),
  );
  assert.equal(assignment.assigned, "claude", "only claude@64,000 holds a 34,000-character draft");
  assert.deepEqual(assignment.candidate_pool, ["claude"], "the draw runs among those that fit");
  assert.deepEqual(
    (assignment.excluded_for_output_ceiling ?? []).map((entry) => entry.peer),
    ["gemini", "deepseek", "grok", "perplexity"],
    "the refused peers are recorded so the event can say why the pool shrank",
  );
  console.log("[v7.0.0-relator-ceiling] draw_redraws_to_the_peer_that_fits: PASS");
}

// --- 4. nobody fits: refuse, naming ceiling, size and BOTH levers ----------
// Caller `claude` is the caller of both measured sessions, which is exactly
// what removes the only peer whose ceiling would have held the artifact.
{
  const error = captured(() =>
    assignRelator(
      "claude",
      ALL_PEERS.filter((peer) => peer !== "claude"),
      undefined,
      fitFor(34_000, MEASURED_CEILINGS),
    ),
  ) as NoRelatorFitsOutputCeilingError;
  assert.ok(
    error instanceof NoRelatorFitsOutputCeilingError,
    "an empty pool by CEILING is its own error, not the generic no_eligible_relator",
  );
  assert.match(error.message, /34000 characters/, "the diagnosis must name the draft size");
  assert.match(error.message, /codex=25000 tokens/, "it must name each refused ceiling");
  assert.match(error.message, /grok=20000 tokens/, "including the four at the lower ceiling");
  assert.match(error.message, /shrink the artifact/, "lever 1: shrink the artifact");
  assert.match(
    error.message,
    /max_output_tokens_by_peer/,
    "lever 2: the operator's central ceiling — the lever issue #295 names as his",
  );
  console.log("[v7.0.0-relator-ceiling] nobody_fits_names_size_ceilings_and_both_levers: PASS");
}

// --- 5. an explicit relator is refused, not silently replaced --------------
{
  const error = captured(() =>
    resolveLeadPeer("claude", "gemini", ["gemini", "grok"], fitFor(34_000, MEASURED_CEILINGS)),
  ) as LeadPeerCannotFitDraftError;
  assert.ok(error instanceof LeadPeerCannotFitDraftError);
  assert.equal(error.peer, "gemini");
  assert.equal(error.ceiling_tokens, 20_000);
  assert.match(error.message, /Omit lead_peer/, "the redraw path must be pointed at");
  console.log("[v7.0.0-relator-ceiling] explicit_relator_is_refused_not_replaced: PASS");
}

// --- 6. no draft, no constraint -------------------------------------------
// With no `initial_draft` the lead GENERATES the first one, so there is no
// size to measure. The seat must stay open to every peer.
{
  const assignment = assignRelator("claude", ["gemini"], undefined, undefined);
  assert.equal(assignment.assigned, "gemini");
  assert.equal(assignment.excluded_for_output_ceiling, undefined);
  console.log("[v7.0.0-relator-ceiling] no_draft_means_no_constraint: PASS");
}

// --- orchestrator harness --------------------------------------------------
function harnessConfig(prefix: string, ceilings: Record<PeerId, number>): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    data_dir: fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-${prefix}-`)),
    max_output_tokens_by_peer: { ...ceilings },
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

// Counts every peer call and every generation, so "fails before dispatching
// the votes" is measured rather than asserted from the source layout.
function countingAdapters(config: AppConfig): {
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
  void config;
  return { factory, called, generated };
}

// --- 7. the refusal costs nothing: zero peer calls -------------------------
// This is the whole point of issue #295. Pre-fix both sessions paid every
// vote and then died on the relator.
{
  const config = harnessConfig("relator-ceiling-refusal", MEASURED_CEILINGS);
  const probe = countingAdapters(config);
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  const error = await capturedAsync(() =>
    orchestrator.runUntilUnanimous({
      task: "Revise the artifact.",
      caller: "claude",
      initial_draft: "x".repeat(34_000),
      max_rounds: 1,
    }),
  );
  assert.ok(
    error instanceof NoRelatorFitsOutputCeilingError,
    `the run must refuse with the ceiling diagnosis, got: ${String(error)}`,
  );
  assert.deepEqual(probe.called, [], "no reviewer vote may be dispatched before the refusal");
  assert.deepEqual(probe.generated, [], "and no relator generation either");
  console.log("[v7.0.0-relator-ceiling] refusal_costs_zero_peer_calls: PASS");
}

// --- 8. only the relator SEAT is constrained, never the reviewer pool ------
// Reviewers vote; they never re-emit the artifact. A ceiling filter that
// leaked into the reviewer pool would silently shrink the colegiado, which is
// a different and worse defect than the one being fixed.
{
  const config = harnessConfig("relator-ceiling-reviewers", MEASURED_CEILINGS);
  const probe = countingAdapters(config);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "codex",
    initial_draft: "x".repeat(34_000),
    max_rounds: 1,
  });
  const assigned = events.find((event) => event.type === "session.relator_assigned");
  assert.ok(assigned, "the draw must be recorded");
  const data = (assigned as { data?: Record<string, unknown> }).data ?? {};
  assert.equal(data.assigned, "claude", "the seat goes to the only peer whose ceiling holds it");
  assert.deepEqual(
    (data.excluded_for_output_ceiling as Array<{ peer: PeerId }>).map((entry) => entry.peer),
    ["gemini", "deepseek", "grok", "perplexity"],
    "the event records who was refused and why",
  );
  const smallCeilingVoters = probe.called.filter((peer) => MEASURED_CEILINGS[peer] < 34_000);
  assert.ok(
    smallCeilingVoters.length > 0,
    `peers below the draft size must still vote as reviewers; called=[${probe.called.join(", ")}]`,
  );
  console.log("[v7.0.0-relator-ceiling] reviewer_pool_is_not_narrowed_by_the_ceiling: PASS");
}

// --- 9. circular mode screens EVERY rotator, not only the first -----------
// Pre-fix this session ran: the draw picked codex (the only tail peer whose
// ceiling clears a 22,000-character draft), and then gemini, deepseek, grok
// and perplexity — all at 20,000 — entered the rotation unscreened and were
// asked to re-emit the artifact. The refusal below costs zero peer calls.
{
  const config = harnessConfig("relator-ceiling-circular-refusal", MEASURED_CEILINGS);
  const probe = countingAdapters(config);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    initial_draft: "x".repeat(22_000),
    mode: "circular",
    max_rounds: 1,
  });
  const refused = events.find((event) => event.type === "session.circular_rotation_output_ceiling");
  assert.ok(
    refused,
    `circular must refuse before dispatch; events=[${events.map((e) => e.type).join(", ")}]`,
  );
  const data = (refused as { data?: Record<string, unknown> }).data ?? {};
  assert.equal(data.draft_chars, 22_000, "the diagnosis names the draft size");
  assert.deepEqual(
    (data.excluded_for_output_ceiling as Array<{ peer: PeerId }>).map((entry) => entry.peer),
    ["gemini", "deepseek", "grok", "perplexity"],
    "and every rotator refused for its ceiling",
  );
  assert.deepEqual(probe.called, [], "no rotator turn may be dispatched before the refusal");
  assert.deepEqual(probe.generated, [], "and no generation either");
  console.log("[v7.0.0-relator-ceiling] circular_rotation_screens_every_rotator: PASS");
}

// --- 10. a partially eligible rotation keeps the peers that clear it ------
// The screen must not collapse the rotation to the drawn peer alone when
// others genuinely fit. With gemini raised to 30,000 the rotation keeps both
// peers above the draft and drops only the three below it.
{
  const mixedCeilings: Record<PeerId, number> = {
    ...MEASURED_CEILINGS,
    gemini: 30_000,
  };
  const config = harnessConfig("relator-ceiling-circular-partial", mixedCeilings);
  const probe = countingAdapters(config);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    initial_draft: "x".repeat(22_000),
    mode: "circular",
    max_rounds: 1,
  });
  const assigned = events.find((event) => event.type === "session.circular_rotation_assigned");
  assert.ok(
    assigned,
    `the rotation must be recorded; events=[${events.map((e) => e.type).join(", ")}]`,
  );
  const data = (assigned as { data?: Record<string, unknown> }).data ?? {};
  const order = data.rotation_order as PeerId[];
  assert.deepEqual(
    [...order].sort(),
    ["codex", "gemini"],
    `the rotation keeps only peers whose ceiling clears 22,000; got [${order.join(", ")}]`,
  );
  assert.deepEqual(
    (data.excluded_for_output_ceiling as Array<{ peer: PeerId }>).map((entry) => entry.peer),
    ["deepseek", "grok", "perplexity"],
    "and records the three it dropped",
  );
  console.log("[v7.0.0-relator-ceiling] circular_rotation_keeps_eligible_peers: PASS");
}

console.log("[v7.0.0-relator-ceiling] ALL CASES PASS");
