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
// leaked into the reviewer pool would silently shrink the panel, which is
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

// Adapters whose GENERATION returns an artifact of a chosen size, so the
// artifact circulating in a rotation can be made to grow. `call` keeps the
// stub behaviour; only `generate` is controlled.
function expandingAdapters(sizeFor: (peer: PeerId) => number): {
  factory: (cfg: AppConfig) => Record<PeerId, PeerAdapter>;
  generated: PeerId[];
} {
  const generated: PeerId[] = [];
  const factory = (cfg: AppConfig): Record<PeerId, PeerAdapter> => {
    const adapters = {} as Record<PeerId, PeerAdapter>;
    for (const peer of ALL_PEERS) {
      const adapter = new StubAdapter(cfg, peer);
      adapters[peer] = new Proxy(adapter, {
        get(target, property, receiver) {
          if (property === "generate") {
            const original = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => Promise<{ text: string }>;
            // Delegate to the stub and override ONLY the text. Building the
            // result by hand loses fields the store settles on — `result.peer`
            // is what clears the in-flight generation marker, and omitting it
            // strands the marker until the next finalize throws
            // `cannot_finalize_generation_in_flight`. Found by this very case.
            return async (...args: unknown[]) => {
              generated.push(peer);
              const real = await original.apply(target, args);
              return { ...real, text: `${peer}:${"y".repeat(sizeFor(peer))}` };
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as PeerAdapter;
    }
    return adapters;
  };
  return { factory, generated };
}

// --- 11. the live screen measures the CURRENT artifact, not the first one --
// Round 1 of the PR #300 review added a screen that ran ONCE, against the
// caller's draft, and froze there. `draft` is replaced by every substantive
// rotation, so a rotator admitted at 20,000 characters could be handed a
// 34,000-character artifact one turn later and die on `max_output_tokens`
// with the earlier rotations already paid — the exact failure this file
// exists to prevent, moved one round later.
{
  const config = harnessConfig("relator-ceiling-circular-growth", MEASURED_CEILINGS);
  // codex (25,000) writes an artifact far past the 20,000 ceilings of the rest.
  const probe = expandingAdapters(() => 34_000);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    initial_draft: "x".repeat(19_000),
    mode: "circular",
    max_rounds: 6,
  });
  const skipped = events.filter(
    (event) => event.type === "session.circular_rotator_skipped_for_output_ceiling",
  );
  assert.ok(
    skipped.length > 0,
    `a rotator whose ceiling cannot hold the GROWN artifact must be skipped before dispatch; events=[${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}]`,
  );
  const skippedPeers = new Set(
    skipped.map((event) => (event as { peer?: PeerId }).peer).filter(Boolean),
  );
  for (const peer of skippedPeers) {
    assert.ok(
      MEASURED_CEILINGS[peer as PeerId] < 34_000,
      `only peers below the grown artifact may be skipped; ${String(peer)} was not`,
    );
  }
  console.log("[v7.0.0-relator-ceiling] circular_live_screen_follows_the_artifact: PASS");
}

// --- 12. no initial draft is not a licence to skip the screen -------------
// With no caller draft the selection-time fit is undefined, so nothing was
// screened at all — and the artifact the rotation circulates is then produced
// by the first rotator, AFTER that screen would have run. The live screen has
// to cover this, because it is the only screen there is.
{
  const config = harnessConfig("relator-ceiling-circular-nodraft", MEASURED_CEILINGS);
  const probe = expandingAdapters(() => 30_000);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Draft and revise the artifact.",
    caller: "claude",
    mode: "circular",
    max_rounds: 6,
  });
  const guarded = events.filter(
    (event) =>
      event.type === "session.circular_rotator_skipped_for_output_ceiling" ||
      event.type === "session.circular_rotation_output_ceiling",
  );
  assert.ok(
    guarded.length > 0,
    `a session with no initial draft must still screen its rotators against the generated artifact; events=[${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}]`,
  );
  console.log("[v7.0.0-relator-ceiling] circular_no_initial_draft_is_still_screened: PASS");
}

// Adapters whose generation always returns the SAME artifact, whatever peer is
// asked. That is what makes a rotation "unchanged": with a per-peer prefix the
// text differs every turn and convergence can never be reached, so this helper
// is what lets the no-change path be exercised at all.
function fixedArtifactAdapters(text: string): {
  factory: (cfg: AppConfig) => Record<PeerId, PeerAdapter>;
  dispatched: PeerId[];
} {
  const dispatched: PeerId[] = [];
  const factory = (cfg: AppConfig): Record<PeerId, PeerAdapter> => {
    const adapters = {} as Record<PeerId, PeerAdapter>;
    for (const peer of ALL_PEERS) {
      const adapter = new StubAdapter(cfg, peer);
      adapters[peer] = new Proxy(adapter, {
        get(target, property, receiver) {
          if (property === "generate") {
            const original = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => Promise<{ text: string }>;
            return async (...args: unknown[]) => {
              dispatched.push(peer);
              const real = await original.apply(target, args);
              return { ...real, text };
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as PeerAdapter;
    }
    return adapters;
  };
  return { factory, dispatched };
}

// --- 13. a skipped rotator must not be converged around -------------------
// The skip path added in review round 2 advanced the cursor without producing
// a counted turn, while convergence still tested a SCALAR of consecutive
// unchanged turns against `rotationOrder.length`. With one peer skipped every
// pass, the remaining peers reached that threshold by voting twice, and the
// session finalized `converged` — listing in `rotation_order`, `expected_peers`
// and `reviewer_peers` a peer that had never received the artifact. In a
// protocol whose entire claim is unanimity, that is the verdict lying about
// itself. Convergence now counts DISTINCT peers.
{
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 200, // the one that cannot re-emit the grown artifact
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };
  const config = harnessConfig("relator-ceiling-skip-convergence", ceilings);
  const probe = fixedArtifactAdapters("z".repeat(300));
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  const out = await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    // The seat is PINNED, and not for tidiness. Every peer clears the 190-char
    // initial draft, so the draw could seat gemini first — and the round-zero
    // producer is deliberately exempt from the live screen, because it has
    // demonstrably just emitted this exact artifact. With gemini as producer
    // the assertion below ("the low-ceiling peer must never be dispatched
    // against the grown artifact") is false of CORRECT behaviour, so the test
    // failed roughly one run in five. It passed twice standalone and then broke
    // in the suite. A test whose verdict depends on a lottery is not a test.
    lead_peer: "codex",
    initial_draft: "x".repeat(190),
    mode: "circular",
    max_rounds: 20,
  });

  const rotation = (
    events.find((event) => event.type === "session.circular_rotation_assigned") as {
      data?: { rotation_order?: PeerId[] };
    }
  )?.data?.rotation_order;
  assert.ok(rotation?.includes("gemini"), "gemini must be in the rotation to begin with");

  const sawArtifact = new Set(
    events
      .filter(
        (event) =>
          event.type === "session.circular_step_unchanged" ||
          event.type === "session.circular_step_revised",
      )
      .map((event) => (event as { peer?: PeerId }).peer)
      .filter(Boolean) as PeerId[],
  );
  assert.ok(
    !sawArtifact.has("gemini"),
    "the low-ceiling peer must never be dispatched against the grown artifact",
  );
  assert.equal(
    out.converged,
    false,
    `a rotation with a peer that never saw the artifact must not converge; rotation=[${rotation?.join(", ")}] saw=[${[...sawArtifact].join(", ")}]`,
  );
  assert.notEqual(
    out.session.outcome,
    "converged",
    "and the durable outcome must not say converged either",
  );
  const ceilingEvent = events.find(
    (event) => event.type === "session.circular_rotation_output_ceiling",
  );
  assert.ok(
    ceilingEvent,
    `an unreachable rotation must fail closed, not grind to max-rounds; events=[${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}]`,
  );
  console.log("[v7.0.0-relator-ceiling] skipped_rotator_blocks_convergence: PASS");
}

// --- 14. the round-zero generator is the producer -------------------------
// With no caller draft the artifact is generated by the first rotator AFTER
// the selection-time screen. Leaving `currentProducer` undefined meant the
// live screen measured that peer against its OWN output — and the screen is
// one ceiling token per character, roughly 4x pessimistic, so a peer
// legitimately emits more characters than its ceiling in tokens. It was
// skipped on its own text, and it also stayed inside the collapse guard's
// `others`, so the guard could never fire.
{
  const ceilings: Record<PeerId, number> = {
    claude: 250,
    codex: 250,
    gemini: 250,
    deepseek: 250,
    grok: 250,
    perplexity: 250,
  };
  const config = harnessConfig("relator-ceiling-roundzero-producer", ceilings);
  // Every peer emits 300 characters: above the 250 screen, but the
  // producer must still be exempt from being screened against its own output.
  const probe = fixedArtifactAdapters("w".repeat(300));
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Draft and revise the artifact.",
    caller: "claude",
    mode: "circular",
    max_rounds: 12,
  });
  const ceilingEvent = events.find(
    (event) => event.type === "session.circular_rotation_output_ceiling",
  );
  assert.ok(
    ceilingEvent,
    `the rotation must fail closed once nobody but the producer can re-emit; events=[${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}]`,
  );
  const producer = (ceilingEvent as { data?: { producer?: PeerId | null } }).data?.producer;
  assert.ok(
    producer,
    "the diagnosis must name the peer that produced the artifact, not null — the round-zero generator is the producer",
  );
  const skipped = events
    .filter((event) => event.type === "session.circular_rotator_skipped_for_output_ceiling")
    .map((event) => (event as { peer?: PeerId }).peer);
  assert.ok(
    !skipped.includes(producer as PeerId),
    `the producer must never be skipped against its own output; skipped=[${skipped.join(", ")}] producer=${String(producer)}`,
  );
  console.log("[v7.0.0-relator-ceiling] round_zero_generator_is_the_producer: PASS");
}

// --- 16. a skipped rotator does not consume the round budget ---------------
// The live screen advances the cursor without dispatching, and while that pass
// still incremented `round` a rotator excluded by its ceiling ate rounds that
// an eligible rotator needed. Near the cap the session was finalized before the
// peer that could have shrunk the artifact ever got its turn. Three peers,
// gemini unable to re-emit the grown artifact, max_rounds=3: three DISPATCHED
// turns must happen. Pre-fix the skip consumed one and only two did.
{
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 200, // holds the 190 initial draft, not the 300 rotation
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };
  const config = harnessConfig("relator-ceiling-skip-round-budget", ceilings);
  const probe = expandingAdapters(() => 300);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: ["codex", "gemini", "grok"],
    lead_peer: "codex",
    initial_draft: "x".repeat(190),
    mode: "circular",
    max_rounds: 3,
  });

  const skipped = events.filter(
    (event) => event.type === "session.circular_rotator_skipped_for_output_ceiling",
  );
  assert.ok(
    skipped.length > 0,
    "the case is only meaningful if a rotator was actually skipped for its ceiling",
  );
  const dispatchedTurns = events.filter(
    (event) =>
      event.type === "session.circular_step_revised" ||
      event.type === "session.circular_step_unchanged",
  );
  assert.equal(
    dispatchedTurns.length,
    3,
    `max_rounds=3 must buy 3 DISPATCHED turns; a ceiling skip costs nothing and must not consume one (got ${dispatchedTurns.length}, skips=${skipped.length})`,
  );
  console.log("[v7.0.0-relator-ceiling] skip_does_not_consume_the_round_budget: PASS");
}

// --- 17. the preflight prices only what the session can dispatch ----------
// The financial preflight runs in `runUntilUnanimous`, BEFORE the circular
// rotation is derived, and it demands a complete rate card for every peer it is
// handed. While it was handed the unscreened peer list, a peer the ceiling
// screen had already removed from the rotation could finalize the session with
// `financial_controls_missing` — naming a peer that was never going to be
// called. The control is the second half: a peer INSIDE the rotation with no
// card must still block, or the narrowing would have disabled the preflight.
{
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 200, // excluded by the 300-character draft at selection time
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };
  const withoutRateCardFor = (prefix: string, peer: PeerId): AppConfig => {
    const config = harnessConfig(prefix, ceilings);
    const rates = { ...config.cost_rates };
    delete rates[peer];
    return { ...config, cost_rates: rates, model_cost_rates: {} };
  };

  const config = withoutRateCardFor("relator-ceiling-preflight-excluded", "gemini");
  const probe = countingAdapters(config);
  const events: RuntimeEvent[] = [];
  const orchestrator = new CrossReviewOrchestrator(
    config,
    (event) => events.push(event),
    probe.factory,
  );
  const excludedRun = await orchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: ["codex", "gemini", "grok"],
    lead_peer: "codex",
    initial_draft: "z".repeat(300),
    mode: "circular",
    max_rounds: 1,
  });
  const blocked = events.filter(
    (event) => event.type === "session.blocked.financial_controls_missing",
  );
  assert.deepEqual(
    blocked.map((event) => (event as { data?: { missing_variables?: string[] } }).data),
    [],
    "a peer the ceiling screen removed from the rotation can never be billed, so its missing rate card must not block the session",
  );
  assert.ok(
    probe.generated.length > 0,
    `and the session must actually run; generated=[${probe.generated.join(", ")}] events=[${[
      ...new Set(events.map((event) => event.type)),
    ].join(
      ", ",
    )}] outcome=${excludedRun.session.outcome}/${excludedRun.session.outcome_reason ?? "-"}`,
  );

  const controlConfig = withoutRateCardFor("relator-ceiling-preflight-control", "codex");
  const controlEvents: RuntimeEvent[] = [];
  const controlProbe = countingAdapters(controlConfig);
  const controlOrchestrator = new CrossReviewOrchestrator(
    controlConfig,
    (event) => controlEvents.push(event),
    controlProbe.factory,
  );
  await controlOrchestrator.runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: ["codex", "gemini", "grok"],
    lead_peer: "codex",
    initial_draft: "z".repeat(300),
    mode: "circular",
    max_rounds: 1,
  });
  assert.ok(
    controlEvents.some((event) => event.type === "session.blocked.financial_controls_missing"),
    "CONTROL: codex is IN the rotation, so its missing rate card must still block the session",
  );
  assert.deepEqual(
    controlProbe.generated,
    [],
    "CONTROL: and that block must still happen before any generation",
  );
  console.log("[v7.0.0-relator-ceiling] preflight_prices_only_dispatchable_peers: PASS");
}

// --- 18. a collapsed rotation is refused for its size, not for money ------
// The ceiling screen can leave a circular rotation holding nobody but its
// first rotator, and `runCircularLoop` refuses that at its `length < 2` guard
// without dispatching anyone. Pricing that set FIRST meant a missing rate card
// for the lone lead answered `financial_controls_missing` — a diagnosis about
// money for a session that was going to be refused for size, with no provider
// call possible either way. The size refusal is the true cause and now runs
// first. The control is the second half: with the rate card present the
// refusal must still be the size one, so this cannot pass by having quietly
// stopped pricing anything.
{
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 200, // excluded by the 300-character draft, collapsing the rotation
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };
  const runCollapsed = async (prefix: string, dropRateCardFor: PeerId | null) => {
    const base = harnessConfig(prefix, ceilings);
    const rates = { ...base.cost_rates };
    if (dropRateCardFor) delete rates[dropRateCardFor];
    const config: AppConfig = dropRateCardFor
      ? { ...base, cost_rates: rates, model_cost_rates: {} }
      : base;
    const probe = countingAdapters(config);
    const events: RuntimeEvent[] = [];
    const orchestrator = new CrossReviewOrchestrator(
      config,
      (event) => events.push(event),
      probe.factory,
    );
    const out = await orchestrator.runUntilUnanimous({
      task: "Revise the artifact.",
      caller: "claude",
      peers: ["codex", "gemini"],
      lead_peer: "codex",
      initial_draft: "z".repeat(300),
      mode: "circular",
      max_rounds: 1,
    });
    return { out, events, probe };
  };

  const withoutCard = await runCollapsed("relator-ceiling-collapsed-unpriced", "codex");
  assert.equal(
    withoutCard.out.session.outcome_reason,
    "circular_rotation_output_ceiling",
    `a rotation the screen collapsed must be refused for SIZE even when the lone lead has no rate card; got ${String(withoutCard.out.session.outcome_reason)}`,
  );
  assert.ok(
    withoutCard.events.some((event) => event.type === "session.circular_rotation_output_ceiling"),
    "and the diagnosis must be the deterministic output-ceiling one",
  );
  assert.deepEqual(
    withoutCard.probe.generated,
    [],
    "no peer may be dispatched before that refusal",
  );

  const withCard = await runCollapsed("relator-ceiling-collapsed-priced", null);
  assert.equal(
    withCard.out.session.outcome_reason,
    "circular_rotation_output_ceiling",
    "CONTROL: with every rate card present the refusal must still be the size one",
  );
  console.log("[v7.0.0-relator-ceiling] collapsed_rotation_is_refused_for_size: PASS");
}

// --- 19. circular mode is priced with NO reviewer role at all -------------
// The financial preflight demands Perplexity's `web_search` fee only when the
// peer can review, because the reviewer role is the only one that declares the
// tool. Circular mode has no reviewer role: every rotator is dispatched through
// `adapter.generate()`. Handing the preflight `chargeablePeers` minus the lead
// counted the tail rotators as reviewers, so a rotation containing Perplexity
// was refused with `financial_controls_missing` over a fee the session could
// not incur — the run died before a single call, for a charge that does not
// exist on that path.
//
// The control is the second half, and it is the half that makes this a test:
// the SAME unpriced config in `review` mode, where Perplexity really is a
// reviewer, must still block. Without it, narrowing the reviewer set to nothing
// everywhere would satisfy the first assertion and disable the gate.
{
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 640,
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };
  // A complete input/output card with the search dimension REMOVED. Everything
  // else is pinned so the only variable is whether the fee is demanded:
  // an Agent-API model id (a retired Sonar id short-circuits with the migration
  // marker instead), search enabled, and the `estimate` policy so the unbounded
  // residual does not add a second missing variable.
  const searchFeeUnpriced = (prefix: string): AppConfig => {
    const config = harnessConfig(prefix, ceilings);
    return {
      ...config,
      models: { ...config.models, perplexity: "perplexity/kimi-k3" },
      fallback_models: { ...config.fallback_models, perplexity: [] },
      model_cost_rates: {},
      cost_rates: {
        ...config.cost_rates,
        perplexity: { input_per_million: 0, output_per_million: 0 },
      },
      perplexity: {
        ...config.perplexity,
        disable_search: false,
        search_preflight_policy: "estimate",
      },
    };
  };
  const SEARCH_FEE_VAR = "CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS";
  const rotation: PeerId[] = ["codex", "perplexity", "grok"];

  const circularConfig = searchFeeUnpriced("relator-ceiling-circular-search-fee");
  const circularProbe = countingAdapters(circularConfig);
  const circularEvents: RuntimeEvent[] = [];
  const circularRun = await new CrossReviewOrchestrator(
    circularConfig,
    (event) => circularEvents.push(event),
    circularProbe.factory,
  ).runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: rotation,
    lead_peer: "codex",
    initial_draft: "z".repeat(300),
    mode: "circular",
    max_rounds: 1,
  });
  assert.deepEqual(
    circularEvents
      .filter((event) => event.type === "session.blocked.financial_controls_missing")
      .map(
        (event) => (event as { data?: { missing_variables?: string[] } }).data?.missing_variables,
      ),
    [],
    "circular mode dispatches no reviewer, so an unpriced web_search fee must not block it",
  );
  assert.ok(
    circularProbe.generated.length > 0,
    `and the rotation must actually run; generated=[${circularProbe.generated.join(", ")}] outcome=${circularRun.session.outcome}/${circularRun.session.outcome_reason ?? "-"}`,
  );

  const reviewConfig = searchFeeUnpriced("relator-ceiling-review-search-fee");
  const reviewProbe = countingAdapters(reviewConfig);
  const reviewEvents: RuntimeEvent[] = [];
  await new CrossReviewOrchestrator(
    reviewConfig,
    (event) => reviewEvents.push(event),
    reviewProbe.factory,
  ).runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: rotation,
    lead_peer: "codex",
    initial_draft: "z".repeat(300),
    mode: "review",
    max_rounds: 1,
  });
  const reviewBlocked = reviewEvents
    .filter((event) => event.type === "session.blocked.financial_controls_missing")
    .flatMap(
      (event) =>
        (event as { data?: { missing_variables?: string[] } }).data?.missing_variables ?? [],
    );
  assert.ok(
    reviewBlocked.includes(SEARCH_FEE_VAR),
    `CONTROL: in review mode Perplexity IS a reviewer, so the same unpriced fee must still block; got [${reviewBlocked.join(", ")}]`,
  );
  assert.deepEqual(
    reviewProbe.generated,
    [],
    "CONTROL: and that block must still happen before any generation",
  );
  console.log("[v7.0.0-relator-ceiling] circular_mode_is_priced_without_a_reviewer_role: PASS");
}

// --- 20. a terminal refusal keeps the artifact it refused -----------------
// The main path already carried the rule in a comment — "a preflight failure is
// itself an auditable terminal outcome, not a reason to discard the material
// that triggered it" — but two refusal branches sit ABOVE that line and
// returned without it. The session they persisted was finalized `aborted` with
// no draft and no caller submission on disk, so nothing afterwards could show
// the artifact the terminal decision was about.
//
// Both branches are covered, because only one of them was reported. The second
// is the financial refusal, which had the identical defect and was found by
// asking which OTHER paths finalize before the artifact is kept.
{
  const draftFiles = (dir: string): string[] => {
    const found: string[] = [];
    const walk = (at: string): void => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/^round-\d+-draft\.md$/.test(entry.name)) found.push(full);
      }
    };
    walk(dir);
    return found;
  };

  const ARTIFACT = "z".repeat(300);
  const ceilings: Record<PeerId, number> = {
    claude: 640,
    codex: 640,
    gemini: 200, // collapses the rotation against the 300-character draft
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  };

  // (a) the output-ceiling refusal
  const sizeConfig = harnessConfig("relator-ceiling-refusal-keeps-artifact", ceilings);
  const sizeProbe = countingAdapters(sizeConfig);
  const sizeRun = await new CrossReviewOrchestrator(
    sizeConfig,
    () => {},
    sizeProbe.factory,
  ).runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: ["codex", "gemini"],
    lead_peer: "codex",
    initial_draft: ARTIFACT,
    mode: "circular",
    max_rounds: 1,
  });
  assert.equal(
    sizeRun.session.outcome_reason,
    "circular_rotation_output_ceiling",
    `the size refusal must still be the outcome; got ${String(sizeRun.session.outcome_reason)}`,
  );
  const sizeDrafts = draftFiles(sizeConfig.data_dir);
  assert.equal(
    sizeDrafts.length,
    1,
    `the refused session must persist exactly one draft; found ${sizeDrafts.length}`,
  );
  assert.equal(
    fs.readFileSync(sizeDrafts[0] as string, "utf8"),
    ARTIFACT,
    "and it must be the artifact the caller submitted, byte for byte",
  );
  assert.deepEqual(
    sizeProbe.generated,
    [],
    "CONTROL: preserving the artifact must not cost a provider call — the refusal is still free",
  );

  // (b) the financial refusal, which the round-11 finding did not name
  const moneyBase = harnessConfig("relator-ceiling-money-keeps-artifact", {
    ...ceilings,
    gemini: 640, // everyone fits, so the refusal below is about money, not size
  });
  const moneyRates = { ...moneyBase.cost_rates };
  delete moneyRates.codex;
  const moneyConfig: AppConfig = { ...moneyBase, cost_rates: moneyRates, model_cost_rates: {} };
  const moneyProbe = countingAdapters(moneyConfig);
  const moneyEvents: RuntimeEvent[] = [];
  await new CrossReviewOrchestrator(
    moneyConfig,
    (event) => moneyEvents.push(event),
    moneyProbe.factory,
  ).runUntilUnanimous({
    task: "Revise the artifact.",
    caller: "claude",
    peers: ["codex", "gemini"],
    lead_peer: "codex",
    initial_draft: ARTIFACT,
    mode: "circular",
    max_rounds: 1,
  });
  assert.ok(
    moneyEvents.some((event) => event.type === "session.blocked.financial_controls_missing"),
    "the money refusal must still fire, or this half proves nothing",
  );
  const moneyDrafts = draftFiles(moneyConfig.data_dir);
  assert.equal(
    moneyDrafts.length,
    1,
    `the financially blocked session must persist its draft too; found ${moneyDrafts.length}`,
  );
  assert.deepEqual(moneyProbe.generated, [], "CONTROL: and that refusal stays free as well");
  console.log("[v7.0.0-relator-ceiling] terminal_refusal_keeps_the_artifact: PASS");
}

// --- 21. an impossible panel is refused before a session exists -----------
// With the caller and one other peer enabled, auto-recusal leaves a single
// session peer, the lottery seats it as relator, and no independent reviewer is
// left. That was discovered AFTER `initSession` — which awaits `probeAll()` —
// so a request that never ran persisted a session with no outcome, reachable
// afterwards only by recovery or by the 24-hour sweep. `askPeers` already
// refuses this way one function up; this path did not.
{
  const base = harnessConfig("relator-ceiling-impossible-panel", {
    claude: 640,
    codex: 640,
    gemini: 640,
    deepseek: 640,
    grok: 640,
    perplexity: 640,
  });
  const config: AppConfig = {
    ...base,
    peer_enabled: {
      ...base.peer_enabled,
      claude: true,
      codex: true,
      gemini: false,
      deepseek: false,
      grok: false,
      perplexity: false,
    },
  };
  const probe = countingAdapters(config);
  const orchestrator = new CrossReviewOrchestrator(config, () => {}, probe.factory);
  const before = orchestrator.store.list().length;
  const error = await capturedAsync(() =>
    orchestrator.runUntilUnanimous({
      task: "Revise the artifact.",
      caller: "claude",
      initial_draft: "z".repeat(100),
      max_rounds: 1,
    }),
  );
  assert.match(
    String(error),
    /no_eligible_reviewer_peers/,
    `an impossible panel must be refused; got ${String(error)}`,
  );
  assert.equal(
    orchestrator.store.list().length,
    before,
    "and it must leave no session behind, because the request never ran",
  );
  assert.deepEqual(probe.generated, [], "CONTROL: nor may it dispatch anyone");
  console.log("[v7.0.0-relator-ceiling] impossible_panel_creates_no_session: PASS");
}

console.log("[v7.0.0-relator-ceiling] ALL CASES PASS");
