import type { SessionEvent, SessionMeta } from "./types.js";

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

export function sessionCostBreakdown(session: SessionMeta): {
  currency: string;
  total: number | null;
  peer_total: number | null;
  generation_total: number | null;
} {
  const currency = session.totals.cost.currency ?? "USD";
  let peerTotal = 0;
  let peerSeen = false;
  for (const round of session.rounds) {
    for (const peer of round.peers) {
      const value = peer.cost?.total_cost;
      if (value == null || !Number.isFinite(value)) continue;
      peerSeen = true;
      peerTotal += value;
    }
  }

  let generationTotal = 0;
  let generationSeen = false;
  for (const generation of session.generation_files ?? []) {
    const value = generation.cost?.total_cost;
    if (value == null || !Number.isFinite(value)) continue;
    generationSeen = true;
    generationTotal += value;
  }

  const total = session.totals.cost.total_cost ?? null;
  return {
    currency,
    total,
    peer_total: peerSeen ? peerTotal : null,
    generation_total: generationSeen ? generationTotal : null,
  };
}

function costSummaryLines(session: SessionMeta): string[] {
  const breakdown = sessionCostBreakdown(session);
  const lines = [
    `- Cost: ${moneyText(breakdown.total, breakdown.currency)}`,
    `- Peer call cost: ${moneyText(breakdown.peer_total, breakdown.currency)}`,
    `- Generation cost: ${moneyText(breakdown.generation_total, breakdown.currency)}`,
  ];
  if (
    breakdown.total != null &&
    breakdown.peer_total != null &&
    breakdown.generation_total != null
  ) {
    lines.push(
      `- Cost reconciliation: ${moneyText(breakdown.total, breakdown.currency)} = ${moneyAmountText(
        breakdown.peer_total,
      )} peer + ${moneyAmountText(breakdown.generation_total)} generation`,
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

  lines.push(...evidenceChecklistLines(session));

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

  for (const round of session.rounds) {
    lines.push(`### Round ${round.round}`, "");
    for (const peer of round.peers) {
      lines.push(
        `- ${peer.peer}: ${peer.status ?? "NO_STATUS"} (${peer.decision_quality ?? "unknown"}) - ${
          peer.structured?.summary ?? "no summary"
        }`,
      );
      if (peer.parser_warnings.length) {
        lines.push(`  - Parser warnings: ${peer.parser_warnings.join("; ")}`);
      }
    }
    for (const failure of round.rejected) {
      lines.push(`- ${failure.peer}: FAILURE ${failure.failure_class} - ${failure.message}`);
    }
    lines.push("");
  }

  if (events.length) {
    lines.push("## Events", "");
    for (const event of events.slice(-100)) {
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
