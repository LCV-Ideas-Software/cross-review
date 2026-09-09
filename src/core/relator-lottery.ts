// v2.11.0: Relator lottery — automatic assignment of `lead_peer` excluding
// the caller. Modeled on judicial colegiados: the petitioner (caller) never
// serves as relator (lead_peer) on their own petition. Closes the
// self-review failure class that wasted ~$2 USD across 4 trilaterals during
// the v2.10.0 ship cycle (operator directive 2026-05-03).
//
// Two surfaces use this:
//   1. Automatic: when `lead_peer` is omitted on `runUntilUnanimous` /
//      `session_start_unanimous` AND `caller` is one of the four peer ids,
//      the orchestrator picks a relator at random from the non-caller
//      session peers (or the global PEERS \ {caller} when no session
//      subset is passed).
//   2. Defensive: when `lead_peer === caller` is supplied explicitly, the
//      orchestrator REJECTS at validation time with a clear error so the
//      caller never accidentally reviews itself. Same rejection when
//      `lead_peer` is supplied but is NOT in the session peers list.
//
// RNG: `crypto.randomInt` is used because `Math.random` is non-uniform and
// predictable. v4.6.0 (CROSREV-18): the draw is injectable through an
// optional `rng` parameter so the index→peer mapping is tested
// deterministically, while a chi-square smoke regression
// (`relator_lottery_uniform_distribution_test`) keeps the real
// `crypto.randomInt` draw under an explicitly controlled false-positive
// bound instead of an ad-hoc ±15% tolerance.
//
// v2.11.0 R-fix (deepseek catch session 38c6c076 R1): the lottery is now
// session-peers-aware. Pre-fix it filtered the global PEERS constant, so
// when the operator passed a peer subset (e.g. peers=["codex","gemini"])
// the lottery could assign a non-participating peer (e.g. deepseek) as
// lead_peer, and the orchestrator would later fail downstream when trying
// to use that adapter outside the session scope. The session-peers
// parameter is optional to preserve back-compat with callers that pass the
// caller alone.

// v07.00.00 (CROSREV-43, #295): the draw now respects the output ceiling of
// the relator ROLE. The relator is the only role that must re-emit the whole
// artifact inside its own `max_output_tokens`; reviewers only vote, so the
// constraint is specific to this seat and must not narrow the reviewer pool.
// Measured twice over the same artifact with the same peer drawn relator:
// a 34 KB draft against a 20,000-token ceiling died with `MAX_TOKENS`, and a
// 6 KB draft against the same ceiling stopped overflowing and started
// fabricating instead. Both deaths arrived AFTER the round's votes were paid.

import crypto from "node:crypto";
import type { PeerId } from "./types.js";
import { PEERS } from "./types.js";

// One ceiling token per draft character. This is a screen, NOT a proof of
// capacity, and it must not be described as one. Two mechanisms can each break
// the intuition that N tokens always carry N characters:
//
//   1. Reasoning tokens are charged against the SAME output ceiling. The share
//      left for visible output is therefore ceiling minus an amount that varies
//      by provider, by model and by prompt, and that the caller cannot observe
//      before dispatch.
//   2. A character is not always at most one token. Common Latin text runs
//      several characters per token, but an emoji or a CJK glyph can cost more
//      tokens than it does JavaScript code units.
//
// So the screen can still admit a peer that later dies on `max_output_tokens`.
// It is kept because it is cheap and it catches the measured failures that
// motivated it — a 34 KB draft against a 20,000-token ceiling is refused before
// a single vote is paid. What it buys is the removal of the grossly
// mismatched seat, not a guarantee that the seated peer will fit.
//
// The trade is deliberately asymmetric: refusing costs one redraw before
// anything is dispatched, while admitting a peer that cannot finish costs the
// whole round. Anything stronger than this screen needs a real token count
// from the provider's tokenizer plus explicit reasoning headroom, which is a
// separate change and is not claimed here.
export const RELATOR_CHARS_PER_CEILING_TOKEN = 1;

// The material a candidate relator would have to reproduce, and the effective
// output ceiling of each candidate. `draft_chars` is what the relator will
// actually SEE (the revision prompt truncates the draft at
// `prompt.max_draft_chars`), not necessarily the caller's whole artifact.
export interface RelatorOutputFit {
  draft_chars: number;
  ceiling_tokens: (peer: PeerId) => number;
}

export interface RelatorCeilingExclusion {
  peer: PeerId;
  ceiling_tokens: number;
  draft_chars: number;
}

export function relatorFitsDraft(fit: RelatorOutputFit, peer: PeerId): boolean {
  return fit.ceiling_tokens(peer) * RELATOR_CHARS_PER_CEILING_TOKEN >= fit.draft_chars;
}

// Splits a candidate pool into the peers whose ceiling clears the screen above
// and the ones it does not. Clearing the screen is necessary, not sufficient:
// see the note on RELATOR_CHARS_PER_CEILING_TOKEN. Pure — the caller decides
// whether an empty `eligible` is an error (lottery) or a refusal of a named
// peer.
export function partitionRelatorPoolByOutputFit(
  pool: readonly PeerId[],
  fit: RelatorOutputFit,
): { eligible: PeerId[]; excluded: RelatorCeilingExclusion[] } {
  const eligible: PeerId[] = [];
  const excluded: RelatorCeilingExclusion[] = [];
  for (const peer of pool) {
    if (relatorFitsDraft(fit, peer)) {
      eligible.push(peer);
      continue;
    }
    excluded.push({
      peer,
      ceiling_tokens: fit.ceiling_tokens(peer),
      draft_chars: fit.draft_chars,
    });
  }
  return { eligible, excluded };
}

const OUTPUT_CEILING_LEVERS =
  "Two levers: shrink the artifact below the largest ceiling, or raise the peer's " +
  "output ceiling in the central configuration (max_output_tokens_by_peer / " +
  "CROSS_REVIEW_<PROVIDER>_MAX_OUTPUT_TOKENS).";

export class NoRelatorFitsOutputCeilingError extends Error {
  readonly excluded: readonly RelatorCeilingExclusion[];
  readonly draft_chars: number;
  constructor(excluded: readonly RelatorCeilingExclusion[], draftChars: number) {
    const roster = excluded
      .map((entry) => `${entry.peer}=${entry.ceiling_tokens} tokens`)
      .join(", ");
    super(
      `no_relator_fits_output_ceiling: the draft is ${draftChars} characters and no candidate ` +
        `relator has an output ceiling large enough to clear the screen (${roster}). The relator must ` +
        `re-emit the whole artifact inside its own ceiling, so dispatching this round would pay ` +
        `every vote and then die on the relator. ${OUTPUT_CEILING_LEVERS}`,
    );
    this.name = "NoRelatorFitsOutputCeilingError";
    this.excluded = excluded;
    this.draft_chars = draftChars;
  }
}

export class LeadPeerCannotFitDraftError extends Error {
  readonly peer: PeerId;
  readonly ceiling_tokens: number;
  readonly draft_chars: number;
  constructor(leadPeer: PeerId, ceilingTokens: number, draftChars: number) {
    super(
      `lead_peer_output_ceiling_too_small: relator ${leadPeer} has an output ceiling of ` +
        `${ceilingTokens} tokens and the draft is ${draftChars} characters, which does not clear ` +
        `the output screen. Omit lead_peer to let the relator lottery draw a peer that ` +
        `fits. ${OUTPUT_CEILING_LEVERS}`,
    );
    this.name = "LeadPeerCannotFitDraftError";
    this.peer = leadPeer;
    this.ceiling_tokens = ceilingTokens;
    this.draft_chars = draftChars;
  }
}

// Refuses a NAMED relator whose ceiling does not hold the draft. Used on the
// one path that does not draw — an explicit `lead_peer` — where there is
// nothing to redraw and the honest outcome is a refusal that names the peer,
// its ceiling and the two levers.
export function assertLeadPeerFitsDraft(leadPeer: PeerId, fit: RelatorOutputFit | undefined): void {
  if (!fit || relatorFitsDraft(fit, leadPeer)) return;
  throw new LeadPeerCannotFitDraftError(leadPeer, fit.ceiling_tokens(leadPeer), fit.draft_chars);
}

export interface RelatorAssignment {
  caller: PeerId;
  candidate_pool: PeerId[];
  assigned: PeerId;
  // Peers dropped from the draw because their output ceiling did not clear
  // the size screen. Present only when the ceiling filter ran and
  // actually excluded someone, so the event records WHY the pool shrank.
  excluded_for_output_ceiling?: RelatorCeilingExclusion[] | undefined;
  // "crypto.randomInt" when the assignment came from the lottery;
  // "explicit" when the caller supplied an explicit lead_peer that
  // passed validation; "injected" when a test supplied its own `rng`
  // (never produced by the orchestrator). Dashboards/audit-trails can
  // distinguish the paths without reading the wrapping kind discriminant.
  entropy_source: "crypto.randomInt" | "explicit" | "injected";
}

// Draw one index in the half-open range [0, exclusiveMax). The default
// delegates to `crypto.randomInt`; tests inject a deterministic function.
export type RelatorRng = (exclusiveMax: number) => number;

export const defaultRelatorRng: RelatorRng = (exclusiveMax) => crypto.randomInt(0, exclusiveMax);

export class CallerCannotBeLeadPeerError extends Error {
  constructor(caller: PeerId) {
    super(
      `caller_cannot_be_lead_peer: ${caller} cannot review own submission. ` +
        `Submit without lead_peer to trigger automatic relator lottery, ` +
        `or pick a different non-caller peer (codex|claude|gemini|deepseek|grok).`,
    );
    this.name = "CallerCannotBeLeadPeerError";
  }
}

export class LeadPeerNotInSessionError extends Error {
  constructor(leadPeer: PeerId, sessionPeers: readonly PeerId[]) {
    super(
      `lead_peer_not_in_session_peers: ${leadPeer} is not in the session peers list ` +
        `[${sessionPeers.join(", ")}]. Pick a lead_peer that is participating in the session.`,
    );
    this.name = "LeadPeerNotInSessionError";
  }
}

// Returns the candidate pool for the lottery. When `sessionPeers` is
// supplied, the pool is `sessionPeers \ {caller}` (so the lottery only
// considers peers actually participating in the session). When omitted,
// falls back to the global `PEERS \ {caller}` for back-compat with callers
// that only know the caller.
//
// v07.00.00: a branch here used to return the pool UNFILTERED when the caller
// was "operator" — leaving the petitioner eligible to be drawn as relator on
// its own petition, which is the exact failure the lottery exists to prevent.
// It was reachable while the orchestrator still defaulted a missing caller to
// that identity. Every caller is a peer now, so the recusal is unconditional.
export function relatorCandidatePool(caller: PeerId, sessionPeers?: readonly PeerId[]): PeerId[] {
  const source: readonly PeerId[] = sessionPeers ?? PEERS;
  return source.filter((peer) => peer !== caller);
}

// Picks a relator uniformly at random from the candidate pool. Throws if
// the pool is empty (e.g. session peers contains only the caller, or no
// peers at all). The empty-pool guard is upgraded from a theoretical
// concern in the original v2.11.0 draft to a real error path now that
// session-peers can be a strict subset.
// v07.00.00 (CROSREV-43): `fit` narrows the pool to the peers whose output
// ceiling clears the size screen. A peer that does not clear it is refused and
// the draw runs among the rest; when the ceiling empties an otherwise
// non-empty pool the error is `NoRelatorFitsOutputCeilingError`, distinct
// from `no_eligible_relator` (which means there was nobody to draw from at
// all). Both throw before any peer call, so a refusal costs nothing.
export function assignRelator(
  caller: PeerId,
  sessionPeers?: readonly PeerId[],
  rng?: RelatorRng,
  fit?: RelatorOutputFit,
): RelatorAssignment {
  const recused = relatorCandidatePool(caller, sessionPeers);
  const { eligible: pool, excluded } = fit
    ? partitionRelatorPoolByOutputFit(recused, fit)
    : { eligible: recused, excluded: [] as RelatorCeilingExclusion[] };
  if (fit && pool.length === 0 && excluded.length > 0) {
    throw new NoRelatorFitsOutputCeilingError(excluded, fit.draft_chars);
  }
  if (pool.length === 0) {
    throw new Error(
      `no_eligible_relator: candidate pool is empty for caller=${caller}` +
        (sessionPeers ? ` with session peers=[${sessionPeers.join(", ")}]` : ""),
    );
  }
  // The draw is half-open: a valid rng returns an integer in [0, pool.length).
  const index = (rng ?? defaultRelatorRng)(pool.length);
  const assigned = Number.isInteger(index) ? pool[index] : undefined;
  if (!assigned) {
    throw new Error(
      `relator_assignment_index_out_of_bounds: index=${index} pool_size=${pool.length}`,
    );
  }
  return {
    caller,
    candidate_pool: pool,
    assigned,
    entropy_source: rng ? "injected" : "crypto.randomInt",
    excluded_for_output_ceiling: excluded.length ? excluded : undefined,
  };
}

// Validates an explicit lead_peer choice against the caller AND the
// session peers list. Throws `CallerCannotBeLeadPeerError` when caller ===
// leadPeer (self-review). Throws `LeadPeerNotInSessionError` when leadPeer
// is not a participating peer (avoids assigning a non-participating
// relator). When `sessionPeers` is omitted, only the self-review check
// runs (back-compat).
export function assertLeadPeerNotCaller(
  caller: PeerId,
  leadPeer: PeerId,
  sessionPeers?: readonly PeerId[],
): void {
  // v07.00.00: this used to read `caller !== "operator" && leadPeer === caller`,
  // so an operator caller could name ANY lead_peer, including itself. The
  // no-self-review gate now has no exemption to skip.
  if (leadPeer === caller) {
    throw new CallerCannotBeLeadPeerError(caller);
  }
  if (sessionPeers && sessionPeers.length > 0 && !sessionPeers.includes(leadPeer)) {
    throw new LeadPeerNotInSessionError(leadPeer, sessionPeers);
  }
}

// Resolves the effective lead_peer for a session. When `leadPeer` is
// supplied, validates it does not equal caller AND is a session peer (when
// session peers are known) and returns it tagged `entropy_source: "explicit"`.
// When omitted, runs the lottery against the (caller, sessionPeers) pair.
export function resolveLeadPeer(
  caller: PeerId,
  leadPeer: PeerId | undefined,
  sessionPeers?: readonly PeerId[],
  fit?: RelatorOutputFit,
):
  | { kind: "explicit"; assignment: RelatorAssignment }
  | { kind: "lottery"; assignment: RelatorAssignment } {
  if (leadPeer !== undefined) {
    assertLeadPeerNotCaller(caller, leadPeer, sessionPeers);
    // An explicit relator carries the same exposure as a drawn one: it will
    // rewrite the artifact inside its own ceiling. It is refused rather than
    // replaced, because the caller named this peer on purpose.
    assertLeadPeerFitsDraft(leadPeer, fit);
    return {
      kind: "explicit",
      assignment: {
        caller,
        candidate_pool: [leadPeer],
        assigned: leadPeer,
        entropy_source: "explicit",
      },
    };
  }
  return { kind: "lottery", assignment: assignRelator(caller, sessionPeers, undefined, fit) };
}
