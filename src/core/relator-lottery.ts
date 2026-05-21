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
// predictable; a smoke regression (`relator_lottery_uniform_distribution_test`)
// locks the uniform draw in.
//
// v2.11.0 R-fix (deepseek catch session 38c6c076 R1): the lottery is now
// session-peers-aware. Pre-fix it filtered the global PEERS constant, so
// when the operator passed a peer subset (e.g. peers=["codex","gemini"])
// the lottery could assign a non-participating peer (e.g. deepseek) as
// lead_peer, and the orchestrator would later fail downstream when trying
// to use that adapter outside the session scope. The session-peers
// parameter is optional to preserve back-compat with callers that pass the
// caller alone.

import crypto from "node:crypto";
import type { PeerId } from "./types.js";
import { PEERS } from "./types.js";

export interface RelatorAssignment {
  caller: PeerId | "operator";
  candidate_pool: PeerId[];
  assigned: PeerId;
  // "crypto.randomInt" when the assignment came from the lottery;
  // "explicit" when the caller supplied an explicit lead_peer that
  // passed validation. Dashboards/audit-trails can distinguish the two
  // paths without reading the wrapping kind discriminant.
  entropy_source: "crypto.randomInt" | "explicit";
}

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
// that only know the caller. When `caller === "operator"`, no exclusion
// applies — operator is human-in-the-loop, not a reviewer.
export function relatorCandidatePool(
  caller: PeerId | "operator",
  sessionPeers?: readonly PeerId[],
): PeerId[] {
  const source: readonly PeerId[] = sessionPeers ?? PEERS;
  if (caller === "operator") return [...source];
  return source.filter((peer) => peer !== caller);
}

// Picks a relator uniformly at random from the candidate pool. Throws if
// the pool is empty (e.g. session peers contains only the caller, or no
// peers at all). The empty-pool guard is upgraded from a theoretical
// concern in the original v2.11.0 draft to a real error path now that
// session-peers can be a strict subset.
export function assignRelator(
  caller: PeerId | "operator",
  sessionPeers?: readonly PeerId[],
): RelatorAssignment {
  const pool = relatorCandidatePool(caller, sessionPeers);
  if (pool.length === 0) {
    throw new Error(
      `no_eligible_relator: candidate pool is empty for caller=${caller}` +
        (sessionPeers ? ` with session peers=[${sessionPeers.join(", ")}]` : ""),
    );
  }
  // crypto.randomInt(0, pool.length) is half-open: returns [0, pool.length).
  const index = crypto.randomInt(0, pool.length);
  const assigned = pool[index];
  if (!assigned) {
    throw new Error(
      `relator_assignment_index_out_of_bounds: index=${index} pool_size=${pool.length}`,
    );
  }
  return {
    caller,
    candidate_pool: pool,
    assigned,
    entropy_source: "crypto.randomInt",
  };
}

// Validates an explicit lead_peer choice against the caller AND the
// session peers list. Throws `CallerCannotBeLeadPeerError` when caller ===
// leadPeer (self-review). Throws `LeadPeerNotInSessionError` when leadPeer
// is not a participating peer (avoids assigning a non-participating
// relator). When `sessionPeers` is omitted, only the self-review check
// runs (back-compat).
export function assertLeadPeerNotCaller(
  caller: PeerId | "operator",
  leadPeer: PeerId,
  sessionPeers?: readonly PeerId[],
): void {
  if (caller !== "operator" && leadPeer === caller) {
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
  caller: PeerId | "operator",
  leadPeer: PeerId | undefined,
  sessionPeers?: readonly PeerId[],
):
  | { kind: "explicit"; assignment: RelatorAssignment }
  | { kind: "lottery"; assignment: RelatorAssignment } {
  if (leadPeer !== undefined) {
    assertLeadPeerNotCaller(caller, leadPeer, sessionPeers);
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
  return { kind: "lottery", assignment: assignRelator(caller, sessionPeers) };
}
