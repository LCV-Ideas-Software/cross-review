import type {
  DecisionTransformation,
  EvidenceChecklistItem,
  PeerResult,
  SessionEvent,
  SessionMeta,
} from "./types.js";

function valueOrDash(value: unknown): string {
  if (value == null || value === "") return "-";
  return String(value);
}

function moneyText(value: number | null | undefined, currency = "USD"): string {
  return value == null ? "unknown" : `$${value.toFixed(6)} ${currency}`;
}

function moneyAmountText(value: number): string {
  return `$${value.toFixed(6)}`;
}

function unsettledPrimaryPeerCallCount(session: SessionMeta): number {
  const inFlight = session.in_flight;
  if (!inFlight) return 0;
  const settledPrimaryPeers = new Set(
    (inFlight.provider_settlements ?? [])
      .filter((settlement) => settlement.reservation_id === undefined)
      .map((settlement) => settlement.peer),
  );
  return new Set(inFlight.peers.filter((peer) => !settledPrimaryPeers.has(peer))).size;
}

function providerAttemptRecorded(session: SessionMeta): boolean {
  if (
    session.rounds.some(
      (round) => round.peers.length > 0 || round.rejected.some((failure) => failure.attempts > 0),
    )
  ) {
    return true;
  }
  if ((session.in_flight?.provider_settlements?.length ?? 0) > 0) return true;
  if ((session.in_flight?.provider_call_reservations?.length ?? 0) > 0) return true;
  if ((session.pending_provider_call_reservations?.length ?? 0) > 0) return true;
  if ((session.interrupted_provider_settlements?.length ?? 0) > 0) return true;
  if (session.generation_in_flight) return true;
  if (unsettledPrimaryPeerCallCount(session) > 0) return true;
  if ((session.generation_files?.length ?? 0) > 0) return true;
  return (session.failed_attempts ?? []).some((failure) => failure.attempts > 0);
}

export function sessionCostBreakdown(session: SessionMeta): {
  currency: string;
  total: number | null;
  peer_total: number | null;
  generation_total: number | null;
  failed_attempt_total: number | null;
  unpriced_failed_attempts: number;
  reconciled: boolean;
  accounting_coverage: "v2" | "legacy_unknown";
} {
  const currency = session.totals.cost.currency ?? "USD";
  let unpricedFailedAttempts = 0;
  let peerTotal = 0;
  let peerSeen = false;
  for (const round of session.rounds) {
    for (const peer of round.peers) {
      unpricedFailedAttempts += peer.unpriced_attempts ?? 0;
      const value = peer.cost?.total_cost;
      if (value == null || !Number.isFinite(value)) continue;
      peerSeen = true;
      peerTotal += value;
    }
  }
  const providerSettlements = [
    ...(session.in_flight?.provider_settlements ?? []),
    ...(session.interrupted_provider_settlements ?? []),
  ];
  const pendingProviderReservations = [
    ...(session.in_flight?.provider_call_reservations ?? []),
    ...(session.pending_provider_call_reservations ?? []),
  ];
  // Reservations, the generation marker, and primary peers without a
  // settlement are written before dispatch and cleared atomically with
  // settlement. Until then each represents a paid provider attempt with no
  // durable billable result, so reports must fail closed rather than claim a
  // reconciled zero or partial total.
  const pendingProviderAttempts =
    pendingProviderReservations.length +
    (session.generation_in_flight ? 1 : 0) +
    unsettledPrimaryPeerCallCount(session);
  unpricedFailedAttempts += pendingProviderAttempts;
  for (const settlement of providerSettlements) {
    if (settlement.unpriced_attempts != null) {
      unpricedFailedAttempts += settlement.unpriced_attempts;
    } else if (settlement.billing_status === "unknown" && settlement.attempts > 0) {
      unpricedFailedAttempts += settlement.attempts;
    }
    const value = settlement.cost?.total_cost;
    if (value == null || !Number.isFinite(value)) continue;
    if (settlement.kind === "result") {
      peerSeen = true;
      peerTotal += value;
    }
  }

  let generationTotal = 0;
  let generationSeen = false;
  for (const generation of session.generation_files ?? []) {
    unpricedFailedAttempts += generation.unpriced_attempts ?? 0;
    const value = generation.cost?.total_cost;
    if (value == null || !Number.isFinite(value)) continue;
    generationSeen = true;
    generationTotal += value;
  }

  let failedAttemptTotal = 0;
  let failedAttemptSeen = false;
  for (const failure of session.failed_attempts ?? []) {
    if (failure.unpriced_attempts != null) {
      unpricedFailedAttempts += failure.unpriced_attempts;
    } else if (failure.billing_status === "unknown" && failure.attempts > 0) {
      unpricedFailedAttempts += failure.attempts;
    }
    const value = failure.cost?.total_cost;
    if (value != null && Number.isFinite(value)) {
      failedAttemptSeen = true;
      failedAttemptTotal += value;
    }
  }
  for (const settlement of providerSettlements) {
    if (settlement.kind !== "failure") continue;
    const value = settlement.cost?.total_cost;
    if (value != null && Number.isFinite(value)) {
      failedAttemptSeen = true;
      failedAttemptTotal += value;
    }
  }

  // Accounting-v2 explicitly covers every provider path. When it contains no
  // successful call, generation, or failed provider attempt, an absent stored
  // total is an exact zero rather than unknown legacy history.
  const total =
    pendingProviderAttempts > 0
      ? null
      : (session.totals.cost.total_cost ??
        (session.accounting_schema_version === 2 && !providerAttemptRecorded(session) ? 0 : null));
  const componentTotal = peerTotal + generationTotal + failedAttemptTotal;
  const reconciled =
    session.accounting_schema_version === 2 &&
    total != null &&
    unpricedFailedAttempts === 0 &&
    Math.abs(total - componentTotal) < 0.0000005;
  return {
    currency,
    total,
    peer_total: peerSeen || session.accounting_schema_version === 2 ? peerTotal : null,
    generation_total:
      generationSeen || session.accounting_schema_version === 2 ? generationTotal : null,
    failed_attempt_total: failedAttemptSeen ? failedAttemptTotal : 0,
    unpriced_failed_attempts: unpricedFailedAttempts,
    reconciled,
    accounting_coverage: session.accounting_schema_version === 2 ? "v2" : "legacy_unknown",
  };
}

function costSummaryLines(session: SessionMeta): string[] {
  const breakdown = sessionCostBreakdown(session);
  const lines = [
    `- Cost: ${moneyText(breakdown.total, breakdown.currency)}`,
    `- Peer call cost: ${moneyText(breakdown.peer_total, breakdown.currency)}`,
    `- Generation cost: ${moneyText(breakdown.generation_total, breakdown.currency)}`,
    `- Failed-attempt cost: ${moneyText(breakdown.failed_attempt_total, breakdown.currency)}`,
    `- Unpriced provider attempts: ${breakdown.unpriced_failed_attempts}`,
  ];
  if (
    breakdown.total != null &&
    breakdown.peer_total != null &&
    breakdown.generation_total != null &&
    breakdown.failed_attempt_total != null &&
    breakdown.reconciled
  ) {
    lines.push(
      `- Cost reconciliation: ${moneyText(breakdown.total, breakdown.currency)} = ${moneyAmountText(
        breakdown.peer_total,
      )} peer + ${moneyAmountText(breakdown.generation_total)} generation + ${moneyAmountText(
        breakdown.failed_attempt_total,
      )} failed attempts`,
    );
  } else if (breakdown.total != null) {
    lines.push(
      breakdown.accounting_coverage === "legacy_unknown"
        ? "- Cost reconciliation: incomplete (legacy session predates accounting coverage v2; missing historical calls cannot be inferred)."
        : `- Cost reconciliation: incomplete (${breakdown.unpriced_failed_attempts} provider attempt(s) have no billable usage/cost record).`,
    );
  }
  return lines;
}

function evidenceChecklistLines(session: SessionMeta): string[] {
  const checklist = session.evidence_checklist ?? [];
  if (!checklist.length) return [];
  const counts = new Map<string, number>();
  for (const item of checklist) {
    const status = item.status ?? "open";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const lines = ["## Evidence Checklist", ""];
  for (const [status, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${status}: ${count}`);
  }
  const notResurfaced = checklist.filter((item) => item.status === "not_resurfaced");
  if (notResurfaced.length) {
    lines.push(
      "- not_resurfaced means the ask was not repeated; it is not proof that evidence was satisfied.",
    );
    for (const item of notResurfaced.slice(0, 10)) {
      lines.push(`  - ${item.peer}/${item.id}: ${item.ask}`);
    }
  }
  lines.push("");
  return lines;
}

function runtimeReclassificationLines(session: SessionMeta): string[] {
  const records = session.evidence_checklist_runtime_reclassifications ?? [];
  if (!records.length) return [];
  const lines = ["## Runtime Checklist Reclassifications", ""];
  lines.push(
    "- These entries were removed from the active checklist because durable peer output proved that the runtime, not the attributed peer, authored the request.",
  );
  for (const record of records.slice(-20)) {
    lines.push(
      `- ${record.peer}/${record.item_id}: round ${record.proof_round}, rule=${record.proof_rule}, previous_status=${record.previous_status}`,
    );
  }
  if (records.length > 20) {
    lines.push(`- ... ${records.length - 20} older reclassification(s) omitted.`);
  }
  lines.push("");
  return lines;
}

export function unresolvedEvidenceItems(session: SessionMeta): EvidenceChecklistItem[] {
  return (session.evidence_checklist ?? []).filter((item) => {
    const status = item.status ?? "open";
    return status === "open" || status === "not_resurfaced";
  });
}

function unresolvedEvidenceDispositionLines(session: SessionMeta): string[] {
  const unresolved = unresolvedEvidenceItems(session);
  if (!unresolved.length) return [];

  const lines = [
    "## Unresolved Evidence Disposition",
    "",
    "- These items are not terminally satisfied, deferred, or rejected.",
    "- `open` still requires a concrete response; `not_resurfaced` only means the peer did not repeat the ask in a later round.",
    "- To close them explicitly, the authenticated AI caller submits the requested bytes through the review starter's automatic `evidence` field; no human upload is required. The operator-only checklist update remains an optional administrative disposition.",
    "",
  ];
  for (const item of unresolved.slice(0, 20)) {
    const status = item.status ?? "open";
    const chronic = item.round_count >= 3 ? " chronic" : "";
    lines.push(`- ${status}${chronic} ${item.peer}/${item.id}: ${item.ask}`);
  }
  if (unresolved.length > 20) {
    lines.push(`- ... ${unresolved.length - 20} additional unresolved item(s) omitted.`);
  }
  lines.push("");
  return lines;
}

function transformationRules(transformation: DecisionTransformation): string[] {
  const rules = transformation.reasons?.filter((reason) => reason.trim().length > 0) ?? [];
  if (transformation.rule && !rules.includes(transformation.rule))
    rules.unshift(transformation.rule);
  return rules;
}

function peerDecisionTraceLines(peer: PeerResult): string[] {
  const rawStatus = peer.raw_status ?? "-";
  const parsedStatus = peer.parsed_status ?? peer.status ?? "-";
  const normalizedStatus = peer.normalized_status ?? peer.status ?? "-";
  const effectiveStatus = peer.status ?? "NO_STATUS";
  const lines = [
    `  - Status chain: raw_status=${rawStatus}; parsed_status=${parsedStatus}; normalized_status=${normalizedStatus}; effective_status=${effectiveStatus}`,
  ];
  const transformations = peer.decision_transformations ?? peer.status_transformations ?? [];
  for (const transformation of transformations) {
    const rules = transformationRules(transformation);
    const details = transformation.details
      ? `; details=${JSON.stringify(transformation.details)}`
      : "";
    lines.push(
      `  - Decision transformation [${transformation.stage}]: ${transformation.from ?? "NO_STATUS"} -> ${transformation.to ?? "NO_STATUS"}; rules=${rules.join(", ") || "-"}${details}`,
    );
  }
  return lines;
}

function peerRequestLines(peer: PeerResult): string[] {
  const callerRequests = peer.structured?.caller_requests ?? [];
  const followUps = peer.structured?.follow_ups ?? [];
  const lines: string[] = [];
  for (const request of callerRequests.slice(0, 20)) {
    lines.push(`  - Caller request: ${request.replace(/\s+/g, " ").trim()}`);
  }
  if (callerRequests.length > 20) {
    lines.push(`  - ... ${callerRequests.length - 20} additional caller request(s) omitted.`);
  }
  for (const followUp of followUps.slice(0, 20)) {
    lines.push(`  - Follow-up: ${followUp.replace(/\s+/g, " ").trim()}`);
  }
  if (followUps.length > 20) {
    lines.push(`  - ... ${followUps.length - 20} additional follow-up(s) omitted.`);
  }
  return lines;
}

export function sessionReportMarkdown(session: SessionMeta, events: SessionEvent[] = []): string {
  const latestRound = session.rounds.at(-1);
  const lines = [
    `# Cross Review Session ${session.session_id}`,
    "",
    "## Summary",
    "",
    `- Version: ${session.version}`,
    `- Created: ${session.created_at}`,
    `- Updated: ${session.updated_at}`,
    `- Caller: ${session.caller}`,
    `- Outcome: ${valueOrDash(session.outcome)}`,
    `- Outcome reason: ${valueOrDash(session.outcome_reason)}`,
    `- Health: ${valueOrDash(session.convergence_health?.state)} - ${valueOrDash(
      session.convergence_health?.detail,
    )}`,
    `- Last activity: ${valueOrDash(
      session.convergence_health?.last_activity_at ?? session.convergence_health?.last_event_at,
    )}`,
    `- Last state transition: ${valueOrDash(
      session.convergence_health?.last_state_transition_at ??
        session.convergence_health?.last_event_at,
    )}`,
    `- Rounds: ${session.rounds.length}`,
    ...costSummaryLines(session),
    `- Total tokens: ${valueOrDash(session.totals.usage.total_tokens)}`,
    "",
    "## Task",
    "",
    session.task,
    "",
    "## Latest Convergence",
    "",
    latestRound
      ? [
          `- Converged: ${latestRound.convergence.converged}`,
          `- Reason: ${latestRound.convergence.reason}`,
          `- Ready: ${latestRound.convergence.ready_peers.join(", ") || "-"}`,
          `- Not ready: ${latestRound.convergence.not_ready_peers.join(", ") || "-"}`,
          `- Needs evidence: ${latestRound.convergence.needs_evidence_peers.join(", ") || "-"}`,
          `- Rejected: ${latestRound.convergence.rejected_peers.join(", ") || "-"}`,
          `- Blocking details: ${latestRound.convergence.blocking_details.join("; ") || "-"}`,
        ].join("\n")
      : "- No round completed yet.",
    "",
    "## Peer Decisions",
    "",
  ];

  for (const round of session.rounds) {
    lines.push(`### Round ${round.round}`, "");
    for (const peer of round.peers) {
      lines.push(
        `- ${peer.peer}: ${peer.status ?? "NO_STATUS"} (${peer.decision_quality ?? "unknown"}) - ${
          peer.structured?.summary ?? "no summary"
        }`,
      );
      lines.push(...peerDecisionTraceLines(peer));
      if (peer.parser_warnings.length) {
        lines.push(`  - Parser warnings: ${peer.parser_warnings.join("; ")}`);
      }
      lines.push(...peerRequestLines(peer));
    }
    for (const failure of round.rejected) {
      lines.push(`- ${failure.peer}: FAILURE ${failure.failure_class} - ${failure.message}`);
    }
    lines.push("");
  }

  lines.push(...evidenceChecklistLines(session));
  lines.push(...runtimeReclassificationLines(session));
  lines.push(...unresolvedEvidenceDispositionLines(session));

  if (session.interrupted_provider_settlements?.length) {
    lines.push("## Recovered Provider Settlements", "");
    for (const settlement of session.interrupted_provider_settlements) {
      const totalTokens = settlement.usage?.total_tokens ?? "-";
      const totalCost =
        settlement.cost?.total_cost == null
          ? "unknown"
          : `$${settlement.cost.total_cost.toFixed(6)} ${settlement.cost.currency}`;
      lines.push(
        `- interrupted round ${settlement.round} ${settlement.peer}/${settlement.kind}: ${settlement.artifact_path} (${totalTokens} tokens, ${totalCost})`,
      );
    }
    lines.push("");
  }

  if (session.generation_files?.length) {
    lines.push("## Generations", "");
    for (const generation of session.generation_files) {
      const totalTokens = generation.usage?.total_tokens ?? "-";
      const totalCost =
        generation.cost?.total_cost == null
          ? "unknown"
          : `$${generation.cost.total_cost.toFixed(6)} ${generation.cost.currency}`;
      lines.push(
        `- round ${generation.round} ${generation.peer}/${generation.label}: ${generation.path} (${totalTokens} tokens, ${totalCost})`,
      );
    }
    lines.push("");
  }

  if (events.length) {
    const streamingEventCount = events.filter((event) => event.type === "peer.token.delta").length;
    const timelineEvents = events.filter((event) => event.type !== "peer.token.delta");
    const displayedEvents = timelineEvents.slice(-100);
    const omittedTimelineEvents = timelineEvents.length - displayedEvents.length;
    lines.push("## Events", "");
    if (streamingEventCount > 0) {
      lines.push(
        `- ${streamingEventCount} streaming token event(s) suppressed from the default timeline.`,
      );
    }
    if (omittedTimelineEvents > 0) {
      lines.push(
        `- Timeline truncated: showing latest ${displayedEvents.length} of ${timelineEvents.length} non-streaming event(s); ${omittedTimelineEvents} older event(s) omitted.`,
      );
    }
    for (const event of displayedEvents) {
      lines.push(
        `- ${event.seq}. ${event.ts ?? ""} ${event.type}${
          event.peer ? `/${event.peer}` : ""
        }: ${event.message ?? ""}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
