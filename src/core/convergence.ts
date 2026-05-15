import type { ConvergenceResult, PeerFailure, PeerId, PeerResult, ReviewStatus } from "./types.js";

// v3.7.3 (operator no-fallback directive 2026-05-14): when a peer's pinned
// model is genuinely unavailable, the round SKIPS that peer and converges
// on the remaining peers, instead of letting the failure block
// convergence. This is the operator's "pular aquele peer e trabalhar
// apenas com os outros" path.
//
// v3.7.4 (Codex v3.7.3 parecer AUDIT-2): a peer reaches this skip through
// EITHER of two paths, not just "the user declared no fallback model" —
//   (a) the user declared NO fallback model for that peer, the pinned
//       model hit an infrastructure failure, and retrying the SAME model
//       was exhausted (`auth` / `rate_limit` / `provider_error` /
//       `network` / `timeout`); or
//   (b) the user DID declare a fallback model, it was tried, and the
//       declared fallback chain was itself drained (`fallback_exhausted`).
// Either way the peer's `failure_class` is in `SKIPPABLE_FAILURE_CLASSES`
// (classified at the round loop in `orchestrator.ts`); everything else —
// a peer that DID respond but badly (schema / unparseable /
// format-recovery-exhausted), the no-fallback-directive's own
// `silent_model_downgrade`, or a policy/budget/content stop — stays in
// `rejected` and blocks convergence exactly as before.
export const SKIP_QUORUM_FLOOR = 2;

// v3.7.3: failure classes that mean "the peer's model was genuinely
// UNAVAILABLE" — the call could not reach the provider or get a usable
// response at all, and the peer has no further model left to fall back
// to. v3.7.4 (Codex v3.7.3 parecer AUDIT-2): this state is reached two
// ways — (a) NO fallback model was declared and retrying the SAME pinned
// model was exhausted (`auth`, `rate_limit`, `provider_error`, `network`,
// `timeout`); or (b) a fallback model WAS declared, tried, and the
// declared chain was itself drained (`fallback_exhausted`). Either way
// these are SKIPPED (round continues on the remaining peers). Everything
// else stays in `rejected` and blocks convergence: a peer that DID respond
// but badly (`schema`, `unparseable_after_recovery`,
// `format_recovery_exhausted`, `stream_buffer_overflow`), the no-fallback
// directive's own `silent_model_downgrade` (a peer that answered on the
// WRONG model — must never be silently tolerated), a content stop
// (`prompt_flagged_by_moderation`), a budget stop (`budget_exceeded`,
// `budget_preflight`), an operator `cancelled`, or `unknown` (conservative
// — never skip on an unclassified failure). The round loop in
// `orchestrator.ts` classifies each `PeerFailure` against this set.
export const SKIPPABLE_FAILURE_CLASSES: ReadonlySet<PeerFailure["failure_class"]> = new Set([
  "auth",
  "rate_limit",
  "provider_error",
  "network",
  "timeout",
  "fallback_exhausted",
]);

export function isSkippableFailure(failure: PeerFailure): boolean {
  return SKIPPABLE_FAILURE_CLASSES.has(failure.failure_class);
}

export function checkConvergence(
  expectedPeers: PeerId[],
  callerStatus: ReviewStatus,
  peers: PeerResult[],
  rejected: PeerFailure[],
  // v3.7.3: peers skipped for genuine model-unavailability. Defaults to []
  // so any call site that does not pass it keeps the exact pre-v3.7.3
  // convergence DECISION — on the zero-skip path every branch below
  // reduces to its original form (`effectiveExpected` === `expectedPeers`,
  // the skip-gated floor is not entered, the converged reason string is
  // unchanged). The only output delta is the additive `skipped_peers`
  // field, `[]` when nothing was skipped — a backward-compatible schema
  // addition, not a behavioral change.
  skipped: PeerFailure[] = [],
): ConvergenceResult {
  const ready = peers.filter((p) => p.status === "READY").map((p) => p.peer);
  const notReady = peers.filter((p) => p.status === "NOT_READY").map((p) => p.peer);
  // v2.4.0 / audit closure (P3.15): strict equality. Pre-v2.4.0 used
  // `p.status == null` (loose), which would also accept the empty string
  // and the literal `0` if a future code path produced them. ReviewStatus
  // only accepts the three sentinel strings or undefined/null in practice,
  // so anchoring to those values eliminates a class of edge-case false
  // positives.
  const needsEvidence = peers
    .filter((p) => p.status === "NEEDS_EVIDENCE" || p.status === null || p.status === undefined)
    .map((p) => p.peer);
  const rejectedPeers = rejected.map((f) => f.peer);
  const skippedPeers = skipped.map((f) => f.peer);
  // v3.7.3: a skipped peer is removed from the convergence quorum entirely
  // — it neither blocks (the way `rejected` does) nor counts toward the
  // all-peers-READY tally. When `skipped` is empty, `effectiveExpected` ===
  // `expectedPeers`, so every branch below reduces to its pre-v3.7.3 form.
  const effectiveExpected = expectedPeers.filter((p) => !skippedPeers.includes(p));
  const responded = new Set(peers.map((p) => p.peer));
  const missing = expectedPeers.filter(
    (p) => !responded.has(p) && !rejectedPeers.includes(p) && !skippedPeers.includes(p),
  );
  const decisionQuality = Object.fromEntries(
    peers.map((peer) => [peer.peer, peer.decision_quality]),
  ) as ConvergenceResult["decision_quality"];
  const blockingDetails = [
    ...notReady.map((peer) => `${peer}: NOT_READY`),
    ...needsEvidence.map((peer) => `${peer}: NEEDS_EVIDENCE`),
    ...rejected.map((failure) => `${failure.peer}: ${failure.failure_class}`),
    ...missing.map((peer) => `${peer}: missing response`),
  ];

  if (callerStatus !== "READY") {
    return {
      converged: false,
      reason: `caller_status=${callerStatus}; caller must be READY`,
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [...rejectedPeers, ...missing],
      skipped_peers: skippedPeers,
      decision_quality: decisionQuality,
      blocking_details: [`caller_status=${callerStatus}`, ...blockingDetails],
    };
  }
  if (rejectedPeers.length || missing.length) {
    // v2.5.0 fix (Codex audit, 2026-05-03): replace the generic
    // "one or more peers failed or did not respond" reason — observed 47
    // times in the 253-session corpus, every occurrence equally
    // unhelpful — with a structured per-peer summary. The reason field
    // remains a single string so downstream report consumers don't need
    // a schema migration; the granularity comes from listing peer +
    // failure_class (or `missing`) for every contributor.
    const detail = [
      ...rejected.map((failure) => `${failure.peer}:${failure.failure_class}`),
      ...missing.map((peer) => `${peer}:missing`),
    ].join(", ");
    return {
      converged: false,
      reason: `peers failed or did not respond: ${detail}`,
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [...rejectedPeers, ...missing],
      skipped_peers: skippedPeers,
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  if (notReady.length || needsEvidence.length) {
    return {
      converged: false,
      reason: "at least one peer did not declare READY",
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [],
      skipped_peers: skippedPeers,
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  // v3.7.3: skip-gated quorum floor. A 0- or 1-peer "unanimous" review is
  // meaningless — skipping must never silently degrade the colegiado below
  // a real cross-check. The floor is GUARDED by `skipped.length > 0`: a
  // zero-skip session keeps its pre-v3.7.3 behavior exactly, including a
  // legitimate single-reviewer-peer session that converges on 1 READY.
  if (skipped.length > 0 && effectiveExpected.length < SKIP_QUORUM_FLOOR) {
    return {
      converged: false,
      reason: `quorum_floor_not_met_after_skips: ${effectiveExpected.length} non-skipped reviewer peer(s) remain after skipping [${skippedPeers.join(", ")}]; at least ${SKIP_QUORUM_FLOOR} are required for a meaningful cross-review`,
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [],
      skipped_peers: skippedPeers,
      decision_quality: decisionQuality,
      blocking_details: [
        ...blockingDetails,
        `quorum_floor_not_met: ${effectiveExpected.length} < ${SKIP_QUORUM_FLOOR} after skips`,
      ],
    };
  }
  if (ready.length !== effectiveExpected.length) {
    return {
      converged: false,
      reason: "not all expected peers responded READY",
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: missing,
      skipped_peers: skippedPeers,
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  return {
    converged: true,
    reason:
      skipped.length > 0
        ? `caller and all ${effectiveExpected.length} non-skipped peer(s) declared READY; skipped for model-unavailability: ${skippedPeers.join(", ")}`
        : "caller and all peers declared READY with no rejected peers",
    ready_peers: ready,
    not_ready_peers: [],
    needs_evidence_peers: [],
    rejected_peers: [],
    skipped_peers: skippedPeers,
    decision_quality: decisionQuality,
    blocking_details: [],
  };
}
