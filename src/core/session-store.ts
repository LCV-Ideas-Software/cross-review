import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { redact, redactJsonValue, safeErrorMessage } from "../security/redact.js";
import { blockConvergenceForUnresolvedEvidence } from "./convergence.js";
import { mergeCost, mergeUsage } from "./cost.js";
import {
  type ReviewedArtifactCustodyReportStatus,
  sessionCostBreakdown,
  sessionReportMarkdown,
} from "./reports.js";
import type {
  AppConfig,
  BackgroundGenerationInFlight,
  BackgroundJobStatus,
  CallerEvidenceSubmission,
  ConvergenceHealth,
  ConvergenceResult,
  ConvergenceScope,
  EvidenceAttachment,
  EvidenceAttachmentOrigin,
  EvidenceBrokerLimits,
  EvidenceChecklistAliasCollapse,
  EvidenceChecklistItem,
  EvidenceChecklistRuntimeReclassification,
  EvidenceChecklistStatus,
  EvidenceStatusHistoryEntry,
  GenerationArtifact,
  GenerationResult,
  JudgmentPrecisionPeerStats,
  JudgmentPrecisionReport,
  PeerFailure,
  PeerHealthSummary,
  PeerId,
  PeerProbeResult,
  PeerReliabilityReport,
  PeerReliabilityStats,
  PeerResult,
  PendingProviderCallReservation,
  PreflightCheckRecord,
  ProviderCallReservation,
  ProviderCallSettlement,
  ProviderPromptArtifact,
  ProviderPromptCustody,
  ProviderResultCustody,
  ResolvedEvidenceAttachment,
  ReviewedArtifactCustody,
  ReviewRound,
  ReviewRoundKind,
  ReviewStatus,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeMetrics,
  SessionDoctorEntry,
  SessionDoctorReport,
  SessionEvent,
  SessionMeta,
  SessionMode,
  ShadowJudgmentPeerStats,
  ShadowJudgmentRollup,
} from "./types.js";
import { PEERS, POSSIBLE_INTERRUPTED_ATTEMPT_MESSAGE_PREFIX } from "./types.js";

export const SWEEP_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Exact persisted bytes of the draft currently under review.
 *
 * This is intentionally not an EvidenceAttachment: the reviewed artifact is
 * the object of the review, not caller-submitted or operator-verified proof of
 * its own factual claims.
 */
export interface PersistedReviewedArtifact extends ReviewedArtifactCustody {
  readonly artifact_kind: "reviewed_artifact";
  readonly round: number;
  readonly relative_path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
}

type CircularGenerationLabel = "initial-draft" | "rotation";

interface CircularGenerationExpectation {
  readonly round: number;
  readonly peer: PeerId;
  readonly label: CircularGenerationLabel;
}

type CircularGenerationDisposition =
  | { readonly kind: "accept_initial" }
  | { readonly kind: "reject_continue" }
  | {
      readonly kind: "reject_terminal";
      readonly outcome: "aborted" | "max-rounds";
      readonly reason: string;
    };

function now(): string {
  return new Date().toISOString();
}

function utf16PrefixAtSafeBoundary(text: string, maxUnits: number): string {
  let end = Math.min(Math.max(0, Math.floor(maxUnits)), text.length);
  if (
    end > 0 &&
    end < text.length &&
    ((/[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) ||
      (text[end - 1] === "\r" && text[end] === "\n"))
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

function dispatchVisibilityIsValid(
  visibleUtf16Units: number,
  totalUtf16Units: number,
  truncated: boolean,
): boolean {
  return (
    Number.isSafeInteger(visibleUtf16Units) &&
    visibleUtf16Units >= 0 &&
    (truncated ? visibleUtf16Units < totalUtf16Units : visibleUtf16Units === totalUtf16Units)
  );
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function effectiveConfigSnapshot(config: AppConfig): Record<string, unknown> {
  return redactJsonValue({
    models: config.models,
    fallback_models: config.fallback_models,
    model_selection: config.model_selection,
    peer_enabled: config.peer_enabled,
    reasoning_effort: config.reasoning_effort,
    retry: config.retry,
    budget: config.budget,
    prompt: config.prompt,
    evidence_broker: config.evidence_broker,
    max_output_tokens: config.max_output_tokens,
    max_output_tokens_by_peer: config.max_output_tokens_by_peer,
    truthfulness_preflight_enabled: config.truthfulness_preflight_enabled,
    evidence_preflight_enabled: config.evidence_preflight_enabled,
    streaming: config.streaming,
    evidence_judge_autowire: config.evidence_judge_autowire,
    cache: config.cache,
    perplexity: config.perplexity,
    cost_rates: config.cost_rates,
    model_cost_rates: config.model_cost_rates,
  }) as Record<string, unknown>;
}

interface EvidenceBrokerRollback {
  round: number;
  restored_item_ids: string[];
  discarded_history_entries: number;
}

function restoreInterruptedEvidenceBrokerSnapshot(
  meta: SessionMeta,
): EvidenceBrokerRollback | undefined {
  const snapshot = meta.in_flight?.evidence_broker_snapshot;
  if (!snapshot || !meta.in_flight) return undefined;
  const currentHistoryLength = meta.evidence_status_history?.length ?? 0;
  const baselineHistoryLength = snapshot.evidence_status_history?.length ?? 0;
  const rollback: EvidenceBrokerRollback = {
    round: meta.in_flight.round,
    restored_item_ids: (snapshot.evidence_checklist ?? []).map((item) => item.id),
    discarded_history_entries: Math.max(0, currentHistoryLength - baselineHistoryLength),
  };
  if (snapshot.evidence_checklist === null) {
    delete meta.evidence_checklist;
  } else {
    meta.evidence_checklist = structuredClone(snapshot.evidence_checklist);
  }
  if (snapshot.evidence_status_history === null) {
    delete meta.evidence_status_history;
  } else {
    meta.evidence_status_history = structuredClone(snapshot.evidence_status_history);
  }
  return rollback;
}

function inFlightRoundAlreadyAppended(meta: SessionMeta): boolean {
  const inFlight = meta.in_flight;
  const latestRound = meta.rounds.at(-1);
  return (
    inFlight !== undefined &&
    inFlight.evidence_broker_snapshot === undefined &&
    latestRound?.round === inFlight.round
  );
}

function latestTimestamp(...values: Array<string | undefined>): string {
  let latest: string | undefined;
  let latestMs = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= latestMs) {
      latest = value;
      latestMs = parsed;
    } else if (!latest && !Number.isFinite(parsed)) {
      latest = value;
    }
  }
  return latest ?? now();
}

function transitionHealth(
  meta: Pick<SessionMeta, "convergence_health">,
  state: ConvergenceHealth["state"],
  detail: string,
  ts = now(),
  extra: Pick<ConvergenceHealth, "idle_ms"> = {},
): ConvergenceHealth {
  const previousActivity =
    meta.convergence_health?.last_activity_at ?? meta.convergence_health?.last_event_at;
  const lastActivityAt = latestTimestamp(previousActivity, ts);
  return {
    state,
    last_event_at: lastActivityAt,
    last_activity_at: lastActivityAt,
    last_state_transition_at: ts,
    detail,
    ...extra,
  };
}

const CHECKLIST_NON_EXECUTION_PATTERN =
  /\b(?:(?:was|were|is|are|has|have|had)\s+(?:not|never)\s+(?:been\s+)?(?:attempted|started|executed|run|performed|completed)|(?:could|can)\s+not\s+(?:be\s+)?(?:attempted|started|executed|run|performed|completed)|(?:cannot|unable\s+to)\s+(?:attempt|start|execute|run|perform|complete)|(?:was|were|is|are|been)?\s*(?:aborted(?:\s+before\s+(?:execution|running|start))?|cancelled|canceled|skipped|omitted|deferred|blocked|pending|not[- ]run)|(?:n[aã]o|nunca)\s+(?:(?:foi|foram|p[oô]de)\s+)?(?:tentad[oa]s?|iniciad[oa]s?|executad[oa]s?|rodad[oa]s?|realizad[oa]s?|conclu[ií]d[oa]s?)|(?:foi|foram)\s+(?:abortad[oa]s?|cancelad[oa]s?|ignorado?s?|pulad[oa]s?|adiad[oa]s?|bloquead[oa]s?)|sem\s+(?:tentar|iniciar|executar|rodar|realizar|concluir))\b/i;

function checklistEvidenceHasExecutionRecord(corpus: string): boolean {
  if (CHECKLIST_NON_EXECUTION_PATTERN.test(corpus)) return false;
  const exitCodes = [...corpus.matchAll(/\bexit[_ ]?code\s*[:=]\s*(\d+)\b/gi)].map((match) =>
    Number(match[1]),
  );
  if (exitCodes.some((code) => code !== 0)) return false;
  return (
    (exitCodes.length > 0 && exitCodes.every((code) => code === 0)) ||
    /\b(?:tests?|test files)\s+\d+\s+passed\b|\b\d+\s+(?:tests?\s+)?passed\b|\btest result:\s*ok\b|\b(?:status|conclusion|result)\s*[:=]\s*(?:success|successful|passed)\b/i.test(
      corpus,
    )
  );
}

function checklistEvidenceHasOperationalRecord(corpus: string): boolean {
  return /\b(?:run|task|workflow|deployment|rollback|session)[_-]?id\s*[:=#]\s*[a-z0-9._-]+|\b(?:status|conclusion|result)\s*[:=]\s*[a-z0-9._-]+/i.test(
    corpus,
  );
}

function checklistEvidenceHasDiffRecord(corpus: string): boolean {
  return /(?:^|\n)\s*diff --git\b|(?:^|\n)\s*@@\s*[-+]|\b\d+\s+files? changed\b/i.test(corpus);
}

export function extractChecklistCommands(ask: string): string[] {
  return (
    ask.match(
      /\b(?:npm\s+(?:run\s+)?[a-z0-9:_-]+|cargo\s+[a-z0-9:_-]+|git\s+[a-z0-9:_-]+(?:\s+(?:--[a-z0-9_:][a-z0-9:_-]*|-[a-z0-9_:][a-z0-9:_-]*))*)\b/gi,
    ) ?? []
  );
}

const CHECKLIST_FALSE_FILE_ANCHORS = new Set(["e.g", "i.e"]);

function checklistEvidenceHasFileLineRecord(corpus: string): boolean {
  return /\b[\w./-]+\.[a-z0-9]+:\d+(?:(?:,|-)\d+)*\b/i.test(corpus);
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiWordCode(code: number): boolean {
  return isAsciiLetterCode(code) || (code >= 48 && code <= 57) || code === 95;
}

export function extractChecklistCodeSymbols(ask: string): string[] {
  const symbols: string[] = [];
  let start = 0;
  while (start < ask.length) {
    const firstCode = ask.charCodeAt(start);
    if (!isAsciiWordCode(firstCode)) {
      start += 1;
      continue;
    }

    let end = start + 1;
    let firstUnderscore = firstCode === 95 ? 0 : -1;
    let hasUppercaseAfterFirst = false;
    while (end < ask.length) {
      const code = ask.charCodeAt(end);
      if (!isAsciiWordCode(code)) break;
      if (code === 95 && firstUnderscore === -1) firstUnderscore = end - start;
      if (code >= 65 && code <= 90) hasUppercaseAfterFirst = true;
      end += 1;
    }

    const tokenLength = end - start;
    const isCamelCase =
      firstCode >= 97 && firstCode <= 122 && firstUnderscore === -1 && hasUppercaseAfterFirst;
    const isSnakeCase =
      isAsciiLetterCode(firstCode) && firstUnderscore > 0 && firstUnderscore < tokenLength - 1;
    if (isCamelCase || isSnakeCase) {
      symbols.push(ask.slice(start, end).normalize("NFKC").toLowerCase());
    }
    start = end;
  }
  return symbols;
}

const CHECKLIST_SEMANTIC_CONCEPTS: ReadonlyArray<{
  ask: RegExp;
  evidence: RegExp;
}> = [
  {
    ask: /\b(?:identity|identidade)\b/i,
    evidence: /\b(?:identity|identidade|schemaid|fragmentid|inputhash)\b/i,
  },
  {
    ask: /\b(?:inject(?:ion|ed|s)?|inje[cç][aã]o)\b/i,
    evidence: /\b(?:inject(?:ion|ed|s)?|inje[cç][aã]o)\b/i,
  },
  { ask: /\bcan[oô]nic(?:al|a|o)?\b/i, evidence: /\bcan[oô]nic(?:al|a|o)?\b/i },
  {
    ask: /\b(?:redact(?:ion|ed|s)?|reda[cç][aã]o)\b/i,
    evidence: /\b(?:redact(?:ion|ed|s)?|reda[cç][aã]o)\b/i,
  },
  {
    ask: /\b(?:secrets?|segredos?)\b/i,
    evidence: /\b(?:secrets?|segredos?|credentials?|api[_-]?keys?|authorization)\b/i,
  },
  {
    ask: /\b(?:assertions?|asser[cç][oõ]es)\b/i,
    evidence: /\b(?:assertions?|asser[cç][oõ]es|tests?)\b/i,
  },
  { ask: /\breadme(?:\.md)?\b/i, evidence: /\breadme(?:\.md)?\b/i },
  { ask: /\bsecurity(?:\.md)?\b/i, evidence: /\bsecurity(?:\.md)?\b/i },
  { ask: /\bchangelog(?:\.md)?\b/i, evidence: /\bchangelog(?:\.md)?\b/i },
  {
    ask: /methodolog(?:y|ical)|metodologia/i,
    evidence: /methodolog(?:y|ical)|metodologia/i,
  },
];

function checklistEvidenceSourcesForItem(
  item: EvidenceChecklistItem,
  evidenceSources: readonly string[],
  knownItemIds: readonly string[],
): { sources: string[]; explicitly_routed: boolean } {
  const sources = evidenceSources.map((source) => source.trim()).filter(Boolean);
  const sourceMentionsId = (source: string, id: string): boolean =>
    new RegExp(`(?:^|[^a-f0-9])${id}(?:[^a-f0-9]|$)`, "i").test(source);
  const routed = sources.filter((source) => sourceMentionsId(source, item.id));
  const generic = sources.filter(
    (source) => !knownItemIds.some((id) => sourceMentionsId(source, id)),
  );
  return {
    // An ID scopes only the source that contains it. A separate generic
    // source remains eligible for semantic/value correlation with other
    // asks; otherwise one routed citation poisons every unrelated source in
    // the same READY envelope (field regression 39cb..., round 5).
    sources: [...routed, ...generic],
    explicitly_routed: routed.length > 0,
  };
}

function checklistAskCorroborated(
  item: EvidenceChecklistItem,
  evidenceSources: readonly string[],
  knownItemIds: readonly string[],
): boolean {
  const scopedEvidence = checklistEvidenceSourcesForItem(item, evidenceSources, knownItemIds);
  const corpus = scopedEvidence.sources.join("\n").normalize("NFKC").toLowerCase();
  if (!corpus.trim()) return false;
  const ask = item.ask.normalize("NFKC").toLowerCase();
  // Ordered-list markers describe the request structure, not values that the
  // evidence must repeat. Keep substantive numbers such as 281, 422 or 80s.
  const anchorAsk = ask.replace(/(^|\n)\s*\d+[.)]\s*/g, "$1");
  const valueAnchors = [
    ...(anchorAsk.match(/https?:\/\/[^\s)\]}>'"]+/gi) ?? []),
    ...(anchorAsk.match(/\b[a-f0-9]{12,64}\b/gi) ?? []),
    ...(anchorAsk.match(/\b[a-z][a-z0-9_-]*_id\s*[:=#]\s*[a-z0-9._-]+\b/gi) ?? []),
    ...(anchorAsk.match(/\b\d+(?:\.\d+)*\b/g) ?? []),
    ...(anchorAsk.match(/\b[\w./-]+\.\w+(?::\d+)?\b/gi) ?? []).filter(
      (value) => !CHECKLIST_FALSE_FILE_ANCHORS.has(value.toLowerCase()),
    ),
  ].map((value) => value.replace(/\s+/g, " ").trim());
  const commands = extractChecklistCommands(anchorAsk);
  const codeSymbols = extractChecklistCodeSymbols(item.ask);
  const requestedConcepts = CHECKLIST_SEMANTIC_CONCEPTS.filter(({ ask: pattern }) =>
    pattern.test(ask),
  );
  const requestsLineEvidence =
    /\b(?:line numbers?|file\s*:\s*line|linhas?(?:\s+de\s+c[oó]digo)?|arquivo\s*:\s*linha)\b/i.test(
      ask,
    );
  const requestsGrepEvidence = /\bgrep(?:\s+lines?|\s+output|\s+sa[ií]da)?\b/i.test(ask);
  const requestsDiffEvidence = /\b(?:git\s+diff|diff|patch)\b/i.test(ask);
  const lineOrDiffAlternative =
    (requestsLineEvidence || requestsGrepEvidence) &&
    requestsDiffEvidence &&
    (/\b(?:or|ou)\b/i.test(ask) ||
      /\b(?:diff|patch)\s*\/\s*grep\b|\bgrep\s*\/\s*(?:diff|patch)\b/i.test(ask));
  const hasLineEvidence = checklistEvidenceHasFileLineRecord(corpus);
  const hasDiffEvidence = checklistEvidenceHasDiffRecord(corpus);
  const satisfiedByLineAlternative = lineOrDiffAlternative && hasLineEvidence;
  const requiredCommands = satisfiedByLineAlternative
    ? commands.filter((command) => !/^git diff(?:\s|$)/i.test(command.replace(/\s+/g, " ")))
    : commands;
  const semanticAnchors = [
    [/(?:exit[_ ]code)/i, /exit[_ ]code/i],
    [/\btests?\b/i, /\btests?\b/i],
    [/\b(?:deploy|deployment|rollback)\b/i, /\b(?:deploy|deployment|rollback)\b/i],
    [/\b(?:workflow|pipeline|github actions?)\b/i, /\b(?:workflow|pipeline|github actions?)\b/i],
    [/\b(?:diff|patch)\b/i, /\b(?:diff|patch)\b/i],
  ] as const;
  const requestedSemantics = semanticAnchors.filter(
    ([askPattern]) =>
      askPattern.test(ask) && !(satisfiedByLineAlternative && askPattern.source.includes("diff")),
  );
  const requestsExecutionRecord =
    requiredCommands.length > 0 ||
    /(?:exit[_ ]code)/i.test(ask) ||
    /\btests?\b/i.test(ask) ||
    (/\b(?:execut(?:e|ed|ion)|run|ran|output|resultado|sa[ií]da|executad[oa])\b/i.test(ask) &&
      !requestsGrepEvidence);
  const requestsImplementationRecord =
    /\b(?:code|implementation|implementa[cç][aã]o|arquivo|file|assertions?|asser[cç][oõ]es|schema|contract|validation|valida[cç][aã]o|identity|identidade|injection|inje[cç][aã]o|redact|reda[cç][aã]o)\b/i.test(
      ask,
    );
  const routedConcreteRecord =
    scopedEvidence.explicitly_routed &&
    (!requestsExecutionRecord || checklistEvidenceHasExecutionRecord(corpus)) &&
    (!requestsImplementationRecord || hasLineEvidence || hasDiffEvidence) &&
    (hasLineEvidence ||
      hasDiffEvidence ||
      checklistEvidenceHasExecutionRecord(corpus) ||
      checklistEvidenceHasOperationalRecord(corpus));
  // A Checklist-Item id routes a recheck to the right ask; it is not proof
  // that the cited material answers that ask. Auto-close only when the ask
  // itself supplied a concrete value, command, or verifiable semantic anchor.
  const hasAskDerivedAnchor =
    valueAnchors.length > 0 ||
    requiredCommands.length > 0 ||
    requestedSemantics.length > 0 ||
    codeSymbols.length > 0 ||
    requestsLineEvidence ||
    requestsGrepEvidence;
  if (!hasAskDerivedAnchor && !routedConcreteRecord) return false;
  if (!valueAnchors.every((value) => corpus.includes(value))) return false;
  if (
    !requiredCommands.every((command) =>
      corpus.includes(command.replace(/\s+/g, " ").toLowerCase()),
    )
  ) {
    return false;
  }
  if (!requestedSemantics.every(([, evidencePattern]) => evidencePattern.test(corpus)))
    return false;
  if (!requestedConcepts.every(({ evidence }) => evidence.test(corpus))) return false;
  if (codeSymbols.length > 0) {
    const everySymbolRequired = /\b(?:all|every|each|todos?|todas?|cada)\b/i.test(ask);
    const symbolsMatch = everySymbolRequired
      ? codeSymbols.every((symbol) => corpus.includes(symbol))
      : codeSymbols.some((symbol) => corpus.includes(symbol));
    if (!symbolsMatch) return false;
  }
  if (lineOrDiffAlternative && !hasLineEvidence && !hasDiffEvidence) return false;
  if (requestsLineEvidence && !lineOrDiffAlternative && !hasLineEvidence) return false;
  if (requestsGrepEvidence && !lineOrDiffAlternative && !hasLineEvidence && !hasDiffEvidence)
    return false;
  if (requestsExecutionRecord && !checklistEvidenceHasExecutionRecord(corpus)) return false;
  if (
    /\b(?:deploy|deployment|rollback|workflow|pipeline|github actions?)\b/i.test(ask) &&
    !checklistEvidenceHasOperationalRecord(corpus)
  ) {
    return false;
  }
  if (requestsDiffEvidence && !lineOrDiffAlternative && !hasDiffEvidence) return false;
  return true;
}

function strictChecklistAliasTarget(
  ask: string,
  peer: PeerId,
  candidates: readonly EvidenceChecklistItem[],
  beforeRound: number,
): EvidenceChecklistItem | undefined {
  for (const candidate of candidates) {
    if (candidate.peer !== peer || candidate.first_round >= beforeRound) continue;
    const marker = new RegExp(
      `^\\s*Checklist-Item\\s*:\\s*${candidate.id}\\b(?:\\s*\\([^)]*\\))?\\s*(?:[—:;-]\\s*)?`,
      "i",
    );
    const remainder = ask.replace(marker, "").trim();
    if (remainder === ask.trim()) continue;
    if (
      /^(?:(?:(?:the|this)\s+)?same(?:\s+(?:request|item|evidence|proof|transcript|output|hunks?))?\s+(?:remains?|is|are)\s+(?:required|needed|outstanding)|idem|as\s+above)\.?$/i.test(
        remainder,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

export type EvidenceChecklistContractLimit =
  | "max_requests_per_peer_round"
  | "max_requests_per_round"
  | "max_items_per_session"
  | "max_chars_per_session"
  | "identifier_collision";

export interface EvidenceChecklistContractViolation {
  limit: EvidenceChecklistContractLimit;
  observed: number;
  maximum: number;
  peer?: PeerId | undefined;
}

export interface EvidenceChecklistAdmission {
  accepted: boolean;
  round: number;
  incoming_total: number;
  incoming_unique: number;
  incoming_duplicates: number;
  requests_by_peer: Partial<Record<PeerId, number>>;
  existing_items: number;
  existing_chars: number;
  existing_matches: number;
  strict_aliases: number;
  new_items: number;
  projected_items: number;
  projected_chars: number;
  limits: EvidenceBrokerLimits;
  violations: EvidenceChecklistContractViolation[];
}

export class EvidenceChecklistContractViolationError extends Error {
  readonly code = "evidence_checklist_contract_violation";

  constructor(readonly admission: EvidenceChecklistAdmission) {
    const summary = admission.violations
      .map(
        (violation) =>
          `${violation.limit}${violation.peer ? `(${violation.peer})` : ""}=${violation.observed}>${violation.maximum}`,
      )
      .join(",");
    super(`evidence_checklist_contract_violation: ${summary}`);
    this.name = "EvidenceChecklistContractViolationError";
  }
}

function checklistItemId(peer: PeerId, ask: string): string {
  return crypto.createHash("sha256").update(`${peer}:${ask}`).digest("hex").slice(0, 16);
}

/**
 * Preview one atomic Evidence Broker append. Exact duplicates are collapsed
 * only within the same peer identity; cross-peer asks remain independent so
 * one reviewer can never erase another reviewer's blocker. Strict references
 * to an older same-owner Checklist-Item are aliases, not new entries.
 */
export function evaluateEvidenceChecklistAdmission(
  checklist: readonly EvidenceChecklistItem[],
  round: number,
  incoming: readonly { peer: PeerId; ask: string }[],
  limits: EvidenceBrokerLimits,
): EvidenceChecklistAdmission {
  const uniqueIncoming: Array<{ peer: PeerId; ask: string }> = [];
  const incomingIdentities = new Set<string>();
  for (const { peer, ask } of incoming) {
    const trimmed = ask.trim();
    if (!trimmed) continue;
    const identity = `${peer}\u0000${trimmed}`;
    if (incomingIdentities.has(identity)) continue;
    incomingIdentities.add(identity);
    uniqueIncoming.push({ peer, ask: trimmed });
  }

  const requestsByPeer: Partial<Record<PeerId, number>> = {};
  for (const { peer } of uniqueIncoming) {
    requestsByPeer[peer] = (requestsByPeer[peer] ?? 0) + 1;
  }

  const existingById = new Map(checklist.map((item) => [item.id, item]));
  const newById = new Map<string, { peer: PeerId; ask: string }>();
  let existingMatches = 0;
  let strictAliases = 0;
  let identifierCollisions = 0;
  for (const candidate of uniqueIncoming) {
    if (strictChecklistAliasTarget(candidate.ask, candidate.peer, checklist, round)) {
      strictAliases += 1;
      continue;
    }
    const id = checklistItemId(candidate.peer, candidate.ask);
    const existing = existingById.get(id);
    if (existing) {
      if (existing.peer === candidate.peer && existing.ask === candidate.ask) {
        existingMatches += 1;
      } else {
        identifierCollisions += 1;
      }
      continue;
    }
    const pending = newById.get(id);
    if (pending) {
      if (pending.peer !== candidate.peer || pending.ask !== candidate.ask) {
        identifierCollisions += 1;
      }
      continue;
    }
    newById.set(id, candidate);
  }

  const existingChars = checklist.reduce((sum, item) => sum + item.ask.length, 0);
  const newChars = [...newById.values()].reduce((sum, item) => sum + item.ask.length, 0);
  const projectedItems = checklist.length + newById.size;
  const projectedChars = existingChars + newChars;
  const violations: EvidenceChecklistContractViolation[] = [];
  for (const [peer, observed] of Object.entries(requestsByPeer) as Array<[PeerId, number]>) {
    if (observed > limits.max_requests_per_peer_round) {
      violations.push({
        limit: "max_requests_per_peer_round",
        peer,
        observed,
        maximum: limits.max_requests_per_peer_round,
      });
    }
  }
  if (uniqueIncoming.length > limits.max_requests_per_round) {
    violations.push({
      limit: "max_requests_per_round",
      observed: uniqueIncoming.length,
      maximum: limits.max_requests_per_round,
    });
  }
  if (projectedItems > limits.max_items_per_session) {
    violations.push({
      limit: "max_items_per_session",
      observed: projectedItems,
      maximum: limits.max_items_per_session,
    });
  }
  if (projectedChars > limits.max_chars_per_session) {
    violations.push({
      limit: "max_chars_per_session",
      observed: projectedChars,
      maximum: limits.max_chars_per_session,
    });
  }
  if (identifierCollisions > 0) {
    violations.push({
      limit: "identifier_collision",
      observed: identifierCollisions,
      maximum: 0,
    });
  }

  return {
    accepted: violations.length === 0,
    round,
    incoming_total: incoming.filter((item) => item.ask.trim().length > 0).length,
    incoming_unique: uniqueIncoming.length,
    incoming_duplicates:
      incoming.filter((item) => item.ask.trim().length > 0).length - uniqueIncoming.length,
    requests_by_peer: requestsByPeer,
    existing_items: checklist.length,
    existing_chars: existingChars,
    existing_matches: existingMatches,
    strict_aliases: strictAliases,
    new_items: newById.size,
    projected_items: projectedItems,
    projected_chars: projectedChars,
    limits: { ...limits },
    violations,
  };
}

const PEER_REVIEW_DISPATCH_KINDS = new Set([
  "normal",
  "fallback_normal",
  "moderation_safe",
  "format_recovery",
  "decision_retry",
]);

function reviewedArtifactCustodyShapeError(meta: Record<string, unknown>): string | undefined {
  const rounds = meta.rounds as unknown[];
  const marker = meta.reviewed_artifact_custody_schema_version;
  const startRound = meta.reviewed_artifact_custody_start_round;
  const containsCustody = rounds.some((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const round = value as Record<string, unknown>;
    if (
      round.review_kind !== undefined ||
      round.reviewed_artifact !== undefined ||
      round.provider_result !== undefined
    ) {
      return true;
    }
    return (
      Array.isArray(round.peers) &&
      round.peers.some(
        (peer) =>
          peer !== null &&
          typeof peer === "object" &&
          !Array.isArray(peer) &&
          (peer as Record<string, unknown>).review_custody !== undefined,
      )
    );
  });

  if (marker === undefined) {
    if (startRound !== undefined || containsCustody) {
      return "reviewed_artifact_custody_schema_version 1 is required for custody-marked session metadata";
    }
  } else {
    if (marker !== 1) return "reviewed_artifact_custody_schema_version must be 1";
    if (!Number.isSafeInteger(startRound) || (startRound as number) < 1) {
      return "reviewed_artifact_custody_start_round must be a positive safe integer";
    }
    if ((startRound as number) > rounds.length + 1) {
      return "reviewed_artifact_custody_start_round cannot skip unallocated rounds";
    }
  }

  const evidenceFiles = Array.isArray(meta.evidence_files) ? meta.evidence_files : [];
  const providerPromptMarker = meta.provider_prompt_custody_schema_version;
  const providerPromptStartRound = meta.provider_prompt_custody_start_round;
  const providerPromptFiles = Array.isArray(meta.provider_prompt_files)
    ? meta.provider_prompt_files
    : [];
  if (providerPromptMarker === undefined) {
    if (
      marker === 1 ||
      providerPromptStartRound !== undefined ||
      meta.provider_prompt_files !== undefined
    ) {
      return "provider_prompt_custody_schema_version 1 is required for custody-marked session metadata";
    }
  } else {
    if (providerPromptMarker !== 1) return "provider_prompt_custody_schema_version must be 1";
    if (
      !Number.isSafeInteger(providerPromptStartRound) ||
      (providerPromptStartRound as number) < 1 ||
      (providerPromptStartRound as number) > rounds.length + 1
    ) {
      return "provider_prompt_custody_start_round must identify an allocated or next round";
    }
  }
  for (let promptIndex = 0; promptIndex < providerPromptFiles.length; promptIndex += 1) {
    const promptValue = providerPromptFiles[promptIndex];
    if (promptValue === null || typeof promptValue !== "object" || Array.isArray(promptValue)) {
      return `provider_prompt_files[${promptIndex}] must be an object`;
    }
    const prompt = promptValue as Record<string, unknown>;
    if (
      typeof prompt.relative_path !== "string" ||
      prompt.relative_path.length === 0 ||
      path.isAbsolute(prompt.relative_path) ||
      prompt.relative_path.split(/[\\/]/).includes("..") ||
      typeof prompt.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(prompt.sha256) ||
      !Number.isSafeInteger(prompt.bytes) ||
      (prompt.bytes as number) < 0 ||
      !Number.isSafeInteger(prompt.utf16_units) ||
      (prompt.utf16_units as number) < 0 ||
      prompt.reconstructible !== true ||
      prompt.redacted !== true ||
      !Number.isSafeInteger(prompt.round) ||
      (prompt.round as number) < 0 ||
      !PEERS.includes(prompt.peer as PeerId) ||
      typeof prompt.provider !== "string" ||
      typeof prompt.model !== "string" ||
      (prompt.call_kind !== "peer_review" &&
        prompt.call_kind !== "generation" &&
        prompt.call_kind !== "evidence_judge") ||
      typeof prompt.label !== "string"
    ) {
      return `provider_prompt_files[${promptIndex}] is invalid`;
    }
  }
  const pendingProviderCalls = Array.isArray(meta.pending_provider_call_reservations)
    ? meta.pending_provider_call_reservations
    : [];
  for (let index = 0; index < pendingProviderCalls.length; index += 1) {
    const reservationValue = pendingProviderCalls[index];
    if (
      reservationValue === null ||
      typeof reservationValue !== "object" ||
      Array.isArray(reservationValue)
    ) {
      return `pending_provider_call_reservations[${index}] must be an object`;
    }
    const reservation = reservationValue as Record<string, unknown>;
    const reservationRequiresPromptCustody =
      providerPromptMarker === 1 &&
      Number.isSafeInteger(reservation.round) &&
      (reservation.round as number) >= (providerPromptStartRound as number);
    if (reservation.provider_prompt === undefined) {
      if (reservationRequiresPromptCustody) {
        return `pending_provider_call_reservations[${index}].provider_prompt is required`;
      }
      continue;
    }
    const promptValue = reservation.provider_prompt;
    if (promptValue === null || typeof promptValue !== "object" || Array.isArray(promptValue)) {
      return `pending_provider_call_reservations[${index}].provider_prompt must be an object`;
    }
    const prompt = promptValue as Record<string, unknown>;
    const ledger = providerPromptFiles.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).relative_path === prompt.relative_path,
    ) as Record<string, unknown> | undefined;
    if (
      !ledger ||
      ledger.round !== reservation.round ||
      ledger.peer !== reservation.peer ||
      ledger.provider !== reservation.provider ||
      ledger.model !== reservation.model ||
      ledger.call_kind !== reservation.call_kind ||
      ledger.label !== reservation.label ||
      prompt.sha256 !== ledger.sha256 ||
      prompt.bytes !== ledger.bytes ||
      prompt.utf16_units !== ledger.utf16_units ||
      prompt.reconstructible !== true ||
      prompt.redacted !== true
    ) {
      return `pending_provider_call_reservations[${index}].provider_prompt does not match the dispatch ledger`;
    }
  }
  // A marker-less record with no custody fields is a legitimate legacy
  // session even when its package version is 4.6.5: that version was already
  // published before this schema landed. Provider-prompt custody is validated
  // independently above so a judge-only continuation can upgrade atomically.
  if (marker === undefined) return undefined;
  for (let index = 0; index < rounds.length; index += 1) {
    const value = rounds[index];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `rounds[${index}] must be an object`;
    }
    const round = value as Record<string, unknown>;
    const roundNumber = round.round;
    if (!Number.isSafeInteger(roundNumber) || (roundNumber as number) !== index + 1) {
      return `rounds[${index}].round must equal ${index + 1}`;
    }
    if ((roundNumber as number) < (startRound as number)) continue;

    const reviewKind = round.review_kind;
    if (
      reviewKind !== "reviewed_artifact" &&
      reviewKind !== "circular_revision" &&
      reviewKind !== "pre_dispatch_block"
    ) {
      return `round ${roundNumber} review_kind is required and must be canonical`;
    }
    const draftFile = round.draft_file;
    if (reviewKind !== "reviewed_artifact") {
      if (draftFile !== undefined || round.reviewed_artifact !== undefined) {
        return `round ${roundNumber} ${reviewKind} must not claim reviewed-artifact custody`;
      }
      if (!Array.isArray(round.peers)) return `round ${roundNumber} peers must be an array`;
      if (reviewKind === "circular_revision") {
        if (
          (meta.session_mode_schema_version === 1 && meta.mode !== "circular") ||
          meta.circular_state === null ||
          typeof meta.circular_state !== "object" ||
          Array.isArray(meta.circular_state) ||
          round.peers.length !== 1
        ) {
          return `round ${roundNumber} circular_revision requires circular state and one rotator`;
        }
        const providerResultValue = round.provider_result;
        if (
          providerResultValue === null ||
          typeof providerResultValue !== "object" ||
          Array.isArray(providerResultValue)
        ) {
          return `round ${roundNumber} circular_revision requires provider-result custody`;
        }
        const providerResult = providerResultValue as Record<string, unknown>;
        if (
          providerResult.artifact_kind !== "provider_result" ||
          typeof providerResult.relative_path !== "string" ||
          providerResult.relative_path.length === 0 ||
          path.isAbsolute(providerResult.relative_path) ||
          providerResult.relative_path.split(/[\\/]/).includes("..") ||
          typeof providerResult.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(providerResult.sha256) ||
          !Number.isSafeInteger(providerResult.bytes) ||
          (providerResult.bytes as number) < 0
        ) {
          return `round ${roundNumber} circular_revision provider-result custody is invalid`;
        }
      } else if (
        round.provider_result !== undefined ||
        round.peers.length !== 0 ||
        !Array.isArray(round.rejected) ||
        round.rejected.length === 0
      ) {
        return `round ${roundNumber} pre_dispatch_block requires zero peers and at least one rejection`;
      }
      if (
        round.peers.some(
          (peer) =>
            peer !== null &&
            typeof peer === "object" &&
            !Array.isArray(peer) &&
            (peer as Record<string, unknown>).review_custody !== undefined,
        )
      ) {
        return `round ${roundNumber} ${reviewKind} must not contain reviewed-artifact peer custody`;
      }
      continue;
    }
    if (draftFile === undefined || round.reviewed_artifact === undefined) {
      return `round ${roundNumber} reviewed_artifact round requires draft_file and custody`;
    }
    if (round.provider_result !== undefined) {
      return `round ${roundNumber} reviewed_artifact round must not claim provider-result custody`;
    }
    const expectedPath = `agent-runs/round-${roundNumber}-draft.md`;
    if (draftFile !== expectedPath) {
      return `round ${roundNumber} draft_file must equal ${expectedPath}`;
    }
    const custody = round.reviewed_artifact;
    if (custody === null || typeof custody !== "object" || Array.isArray(custody)) {
      return `round ${roundNumber} reviewed_artifact custody is required`;
    }
    const reviewed = custody as Record<string, unknown>;
    if (
      reviewed.artifact_kind !== "reviewed_artifact" ||
      reviewed.relative_path !== expectedPath ||
      typeof reviewed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(reviewed.sha256) ||
      !Number.isSafeInteger(reviewed.bytes) ||
      (reviewed.bytes as number) < 0
    ) {
      return `round ${roundNumber} reviewed_artifact custody is invalid`;
    }
    if (!Array.isArray(round.peers)) return `round ${roundNumber} peers must be an array`;

    for (let peerIndex = 0; peerIndex < round.peers.length; peerIndex += 1) {
      const peerValue = round.peers[peerIndex];
      if (peerValue === null || typeof peerValue !== "object" || Array.isArray(peerValue)) {
        return `round ${roundNumber} peers[${peerIndex}] must be an object`;
      }
      const peer = peerValue as Record<string, unknown>;
      const peerCustodyValue = peer.review_custody;
      if (
        peerCustodyValue === null ||
        typeof peerCustodyValue !== "object" ||
        Array.isArray(peerCustodyValue)
      ) {
        return `round ${roundNumber} peers[${peerIndex}].review_custody is required`;
      }
      const peerCustody = peerCustodyValue as Record<string, unknown>;
      if (!PEER_REVIEW_DISPATCH_KINDS.has(String(peerCustody.dispatch_kind))) {
        return `round ${roundNumber} peers[${peerIndex}].review_custody.dispatch_kind is invalid`;
      }
      const peerArtifactValue = peerCustody.reviewed_artifact;
      if (
        peerArtifactValue === null ||
        typeof peerArtifactValue !== "object" ||
        Array.isArray(peerArtifactValue)
      ) {
        return `round ${roundNumber} peers[${peerIndex}].review_custody.reviewed_artifact is required`;
      }
      const peerArtifact = peerArtifactValue as Record<string, unknown>;
      if (
        peerArtifact.relative_path !== reviewed.relative_path ||
        peerArtifact.sha256 !== reviewed.sha256 ||
        !Number.isSafeInteger(peerArtifact.visible_utf16_units) ||
        (peerArtifact.visible_utf16_units as number) < 0 ||
        typeof peerArtifact.truncated !== "boolean"
      ) {
        return `round ${roundNumber} peers[${peerIndex}].review_custody reviewed artifact does not match the round`;
      }
      if (!Array.isArray(peerCustody.visible_attachments)) {
        return `round ${roundNumber} peers[${peerIndex}].review_custody.visible_attachments must be an array`;
      }
      if (
        providerPromptMarker === 1 &&
        (roundNumber as number) >= (providerPromptStartRound as number)
      ) {
        const promptValue = peerCustody.provider_prompt;
        if (promptValue === null || typeof promptValue !== "object" || Array.isArray(promptValue)) {
          return `round ${roundNumber} peers[${peerIndex}].review_custody.provider_prompt is required`;
        }
        const prompt = promptValue as Record<string, unknown>;
        const ledger = providerPromptFiles.find(
          (candidate) =>
            candidate !== null &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).relative_path === prompt.relative_path,
        ) as Record<string, unknown> | undefined;
        if (
          !ledger ||
          ledger.call_kind !== "peer_review" ||
          ledger.round !== roundNumber ||
          ledger.peer !== peer.peer ||
          prompt.sha256 !== ledger.sha256 ||
          prompt.bytes !== ledger.bytes ||
          prompt.utf16_units !== ledger.utf16_units ||
          prompt.reconstructible !== true ||
          prompt.redacted !== true
        ) {
          return `round ${roundNumber} peers[${peerIndex}].review_custody.provider_prompt does not match the dispatch ledger`;
        }
      }
      for (
        let attachmentIndex = 0;
        attachmentIndex < peerCustody.visible_attachments.length;
        attachmentIndex += 1
      ) {
        const attachmentValue = peerCustody.visible_attachments[attachmentIndex];
        if (
          attachmentValue === null ||
          typeof attachmentValue !== "object" ||
          Array.isArray(attachmentValue)
        ) {
          return `round ${roundNumber} peer attachment custody ${attachmentIndex} must be an object`;
        }
        const attachment = attachmentValue as Record<string, unknown>;
        if (
          typeof attachment.relative_path !== "string" ||
          attachment.relative_path.length === 0 ||
          path.isAbsolute(attachment.relative_path) ||
          attachment.relative_path.split(/[\\/]/).includes("..") ||
          typeof attachment.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(attachment.sha256) ||
          !Number.isSafeInteger(attachment.visible_utf16_units) ||
          (attachment.visible_utf16_units as number) < 0 ||
          typeof attachment.truncated !== "boolean"
        ) {
          return `round ${roundNumber} peer attachment custody ${attachmentIndex} is invalid`;
        }
        const evidence = evidenceFiles.find(
          (candidate) =>
            candidate !== null &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).path === attachment.relative_path,
        ) as Record<string, unknown> | undefined;
        if (!evidence) {
          return `round ${roundNumber} peer attachment custody ${attachmentIndex} is not a persisted evidence file`;
        }
        if (typeof evidence.sha256 === "string" && evidence.sha256 !== attachment.sha256) {
          return `round ${roundNumber} peer attachment custody ${attachmentIndex} does not match persisted evidence`;
        }
      }
    }
  }
  return undefined;
}

function sessionMetaShapeError(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "root must be an object";
  }
  const meta = value as Record<string, unknown>;
  for (const field of ["session_id", "version", "created_at", "updated_at", "task"] as const) {
    if (typeof meta[field] !== "string" || meta[field].length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (meta.caller !== "operator" && !PEERS.includes(meta.caller as PeerId)) {
    return "caller must be operator or a known peer";
  }
  if (meta.session_mode_schema_version !== undefined) {
    if (meta.session_mode_schema_version !== 1) return "session_mode_schema_version must be 1";
    if (meta.mode !== "ship" && meta.mode !== "review" && meta.mode !== "circular") {
      return "mode is required and must be ship, review, or circular";
    }
  } else if (
    meta.mode !== undefined &&
    meta.mode !== "ship" &&
    meta.mode !== "review" &&
    meta.mode !== "circular"
  ) {
    return "mode must be ship, review, or circular";
  }
  if (meta.convergence_scope !== undefined) {
    if (
      meta.convergence_scope === null ||
      typeof meta.convergence_scope !== "object" ||
      Array.isArray(meta.convergence_scope)
    ) {
      return "convergence_scope must be an object";
    }
    const scope = meta.convergence_scope as Record<string, unknown>;
    const validActor = (actor: unknown): actor is PeerId | "operator" =>
      actor === "operator" || PEERS.includes(actor as PeerId);
    if (!validActor(scope.caller)) return "convergence_scope.caller must be a known actor";
    if (scope.petitioner !== undefined && !validActor(scope.petitioner)) {
      return "convergence_scope.petitioner must be a known actor";
    }
    if (scope.acting_peer !== undefined && !validActor(scope.acting_peer)) {
      return "convergence_scope.acting_peer must be a known actor";
    }
    const versionMatch = String(meta.version).match(/^v?(\d+)\.(\d+)\.(\d+)/);
    const major = Number(versionMatch?.[1] ?? -1);
    const minor = Number(versionMatch?.[2] ?? -1);
    const durablePetitioner = major > 2 || (major === 2 && minor >= 16);
    if (
      durablePetitioner &&
      (scope.caller !== meta.caller ||
        (scope.petitioner !== undefined && scope.petitioner !== meta.caller))
    ) {
      return "convergence_scope petitioner and caller must match the persisted session owner";
    }
  }
  if (meta.caller_evidence_submissions !== undefined) {
    if (!Array.isArray(meta.caller_evidence_submissions)) {
      return "caller_evidence_submissions must be an array";
    }
    for (const value of meta.caller_evidence_submissions) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return "caller_evidence_submissions entries must be objects";
      }
      const submission = value as Record<string, unknown>;
      if (
        typeof submission.submission_id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          submission.submission_id,
        )
      ) {
        return "caller evidence submission_id must be a UUID";
      }
      if (
        typeof submission.submitted_at !== "string" ||
        Number.isNaN(Date.parse(submission.submitted_at))
      ) {
        return "caller evidence submitted_at must be an ISO timestamp";
      }
      const submittedBy = submission.submitted_by;
      if (submittedBy !== "operator" && !PEERS.includes(submittedBy as PeerId)) {
        return "caller evidence submitted_by must be a known actor";
      }
      if (
        typeof submission.artifact_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(submission.artifact_sha256)
      ) {
        return "caller evidence artifact_sha256 must be a lowercase SHA-256";
      }
      if (
        !Array.isArray(submission.attachment_paths) ||
        !submission.attachment_paths.every((entry) => typeof entry === "string" && entry.length > 0)
      ) {
        return "caller evidence attachment_paths must contain only non-empty path strings";
      }
    }
  }
  if (meta.active_caller_evidence_submission_id !== undefined) {
    if (typeof meta.active_caller_evidence_submission_id !== "string") {
      return "active_caller_evidence_submission_id must be a string";
    }
    const manifests = (meta.caller_evidence_submissions ?? []) as Array<Record<string, unknown>>;
    if (
      !manifests.some(
        (submission) => submission.submission_id === meta.active_caller_evidence_submission_id,
      )
    ) {
      return "active caller evidence submission must reference a persisted manifest";
    }
  }
  if (!Array.isArray(meta.capability_snapshot)) return "capability_snapshot must be an array";
  if (!Array.isArray(meta.rounds)) return "rounds must be an array";
  const reviewedArtifactError = reviewedArtifactCustodyShapeError(meta);
  if (reviewedArtifactError) return reviewedArtifactError;
  if (meta.in_flight !== undefined) {
    if (
      meta.in_flight === null ||
      typeof meta.in_flight !== "object" ||
      Array.isArray(meta.in_flight)
    ) {
      return "in_flight must be an object";
    }
    const settlements = (meta.in_flight as Record<string, unknown>).provider_settlements;
    if (settlements !== undefined && !Array.isArray(settlements)) {
      return "in_flight.provider_settlements must be an array";
    }
    const reservations = (meta.in_flight as Record<string, unknown>).provider_call_reservations;
    if (reservations !== undefined && !Array.isArray(reservations)) {
      return "in_flight.provider_call_reservations must be an array";
    }
  }
  if (
    meta.interrupted_provider_settlements !== undefined &&
    !Array.isArray(meta.interrupted_provider_settlements)
  ) {
    return "interrupted_provider_settlements must be an array";
  }
  if (
    meta.pending_provider_call_reservations !== undefined &&
    !Array.isArray(meta.pending_provider_call_reservations)
  ) {
    return "pending_provider_call_reservations must be an array";
  }
  if (meta.totals === null || typeof meta.totals !== "object" || Array.isArray(meta.totals)) {
    return "totals must be an object";
  }
  return undefined;
}

function isStubSession(session: SessionMeta): boolean {
  const peerCosts = session.rounds.flatMap((round) => round.peers.map((peer) => peer.cost));
  const interruptedSettlementCosts = (session.interrupted_provider_settlements ?? []).map(
    (settlement) => settlement.cost,
  );
  const generationCosts = (session.generation_files ?? []).map((generation) => generation.cost);
  const failureCosts = (session.failed_attempts ?? []).map((failure) => failure.cost);
  const costs = [
    ...peerCosts,
    ...interruptedSettlementCosts,
    ...generationCosts,
    ...failureCosts,
  ].filter(Boolean);
  if (costs.length > 0) return costs.every((cost) => cost?.source === "stub");
  return session.capability_snapshot.some(
    (probe) => probe.provider.startsWith("stub-") || probe.model.startsWith("stub-"),
  );
}

function addNullableCost(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function shadowDecisionData(
  event: SessionEvent,
): RuntimeEventData<"session.evidence_judge_pass.shadow_decision"> | undefined {
  if (event.type !== "session.evidence_judge_pass.shadow_decision") return undefined;
  return event.data as RuntimeEventData<"session.evidence_judge_pass.shadow_decision"> | undefined;
}

// v2.4.0 / audit closure (P1.3): atomicWriteFile retry on Windows.
// `fs.renameSync` in Win32 fails with EPERM/EACCES/EBUSY when the
// destination is briefly held by another handle (AV scan, indexing,
// concurrent reader). Pre-v2.4.0 the rename threw and left the .tmp
// orphaned in the session directory. Now we (a) try rename, (b) on
// transient EPERM/EACCES/EBUSY/EEXIST retry up to 5 times with short
// backoff, (c) on terminal failure clean up the tmp file ourselves so
// the session directory does not accumulate `*.tmp` artifacts, (d)
// re-throw the last error so the caller still observes the failure.
// Mirrors the v1.6.7 P1.2 fix.
const ATOMIC_WRITE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
const TMP_NONCE_BYTES = 2;

function atomicTempPath(file: string): string {
  const nonce = crypto.randomBytes(TMP_NONCE_BYTES).toString("hex");
  return `${file}.${process.pid}.${Date.now()}.${nonce}.tmp`;
}

function writeTextAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = atomicTempPath(file);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best-effort temporary-file cleanup */
    }
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = atomicTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(redactJsonValue(data), null, 2)}\n`, "utf8");
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ATOMIC_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !ATOMIC_WRITE_RETRY_CODES.has(code)) break;
      // v4.1.0 hardening: pre-v4.1.0 used `while (Date.now() - start <
      // wait) {}` busy-wait which blocked the single Node.js event loop
      // thread for up to 310 ms (10+20+40+80+160) under repeated
      // Windows-AV-induced EPERM/EBUSY contention. The CPU-burning
      // busy-wait starved SSE streaming + concurrent sessions + MCP
      // stdio reads. Now the backoff awaits a Promise-based timer:
      // event loop remains fully responsive between attempts.
      const wait = 10 * 2 ** attempt; // 10, 20, 40, 80, 160 ms
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
    }
  }
  // Terminal failure path: best-effort tmp cleanup so callers don't see
  // the orphan accumulate even when the write itself failed.
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

// v2.4.0 / audit closure (P1.3 companion): boot sweep of orphan .tmp files.
// Crashes inside writeJson (between writeFileSync and renameSync) leave
// files matching `<basename>.<pid>.<ts>.<nonce>.tmp` in the session
// directory. They are never read but should not accumulate. Walk every
// session dir at boot, drop files matching the .tmp pattern whose holder
// pid is dead OR whose timestamp is older than 1h. Idempotent +
// best-effort.
const TMP_FILE_PATTERN = /\.(\d+)\.(\d+)\.[0-9a-f]+\.tmp$/;
const TMP_STALE_AFTER_MS = 60 * 60 * 1000; // 1h

function readJson<T>(file: string): T {
  // v2.4.0 / audit closure: contextualize JSON.parse failures so callers see
  // which file is malformed rather than a bare SyntaxError. Read errors
  // still propagate naturally (ENOENT, EACCES) so caller can branch.
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse JSON at ${file}: ${message}`, { cause: err });
  }
}

function safeFilePart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "evidence";
}

function timestampFilePart(): string {
  return now().replace(/[:.]/g, "-");
}

const EVIDENCE_ATTACHMENT_ORIGINS = new Set<EvidenceAttachmentOrigin>([
  "session_attach_evidence",
  "caller_submitted",
  "runtime_generated",
]);

function currentEvidenceAttachment(
  value: NonNullable<SessionMeta["evidence_files"]>[number],
): EvidenceAttachment | undefined {
  const record = value as unknown as Record<string, unknown>;
  const custodyFields = [
    "integrity_version",
    "sha256",
    "bytes",
    "attached_by",
    "attached_at",
    "origin",
  ];
  if (!custodyFields.some((field) => field in record)) return undefined;

  const validCaller =
    record.attached_by === "operator" || PEERS.includes(record.attached_by as PeerId);
  const validOrigin = EVIDENCE_ATTACHMENT_ORIGINS.has(record.origin as EvidenceAttachmentOrigin);
  const valid =
    record.integrity_version === 1 &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    typeof record.bytes === "number" &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes >= 0 &&
    validCaller &&
    typeof record.attached_at === "string" &&
    !Number.isNaN(Date.parse(record.attached_at)) &&
    record.ts === record.attached_at &&
    validOrigin;
  if (!valid) {
    throw new Error(`evidence_custody_metadata_invalid: ${value.path}`);
  }
  return value as EvidenceAttachment;
}

export class SessionStore {
  // v2.4.0 / audit closure (P3.13): in-memory monotonic seq counter per
  // session. Pre-v2.4.0 appendEvent recomputed seq by reading the events
  // file, splitting on newlines and counting non-empty lines — that race
  // remained even inside withSessionLock because two emit calls within
  // the same process could compute identical seqs if the OS write returned
  // before the next read. The cache below is initialized on first use
  // (lazy) by reading the existing file ONCE and is incremented strictly
  // monotonically thereafter. Restart re-initializes from disk, so seq
  // remains correct across process boundaries.
  private readonly seqCache = new Map<string, number>();
  // v4.1.0: track in-flight fire-and-forget appendEvent promises so
  // callers that need synchronous read-after-write semantics (smoke
  // tests, post-round aggregation) can call `flushPendingEvents()` to
  // wait for all pending event writes to settle before reading.
  // appendEvent is async because withSessionLock is async (proper-
  // lockfile); the emit pipeline must stay sync, so it uses
  // `void store.appendEvent(event)` and the store remembers the
  // promise here. Promises resolve/reject within appendEvent's own
  // try/catch — flush() therefore always settles, never rejects.
  private readonly pendingEventWrites = new Set<Promise<void>>();
  // Preserve emission order per session.  The durable lock prevents byte
  // interleaving across processes, but it does not by itself guarantee that
  // independently scheduled promises acquire the lock in call order.
  private readonly eventWriteChains = new Map<string, Promise<void>>();
  private readonly processStartTimeCache = new Map<
    number,
    { checked_at_ms: number; started_at_ms: number | undefined }
  >();
  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(this.sessionsDir(), { recursive: true });
  }

  sessionsDir(): string {
    return path.join(this.config.data_dir, "sessions");
  }

  sessionDir(sessionId: string): string {
    this.assertSessionId(sessionId);
    const sessionsRoot = fs.realpathSync(this.sessionsDir());
    const candidate = path.resolve(sessionsRoot, sessionId);
    const containedCandidate = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    if (!this.isPathContained(sessionsRoot, containedCandidate)) {
      throw new Error(`session path escapes data directory: ${sessionId}`);
    }
    return containedCandidate;
  }

  metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "meta.json");
  }

  eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.ndjson");
  }

  backgroundJobsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "background-jobs");
  }

  private backgroundJobPath(sessionId: string, jobId: string): string {
    this.assertSessionId(jobId);
    return path.join(this.backgroundJobsDir(sessionId), `${jobId.toLowerCase()}.json`);
  }

  async writeBackgroundJobStatus(job: BackgroundJobStatus): Promise<void> {
    this.assertSessionId(job.session_id);
    await writeJson(this.backgroundJobPath(job.session_id, job.job_id), job);
  }

  readBackgroundJobStatus(sessionId: string, jobId: string): BackgroundJobStatus | undefined {
    const file = this.backgroundJobPath(sessionId, jobId);
    if (!fs.existsSync(file)) return undefined;
    const job = this.readBackgroundJobStatusFile(file, sessionId);
    return job?.job_id === jobId ? job : undefined;
  }

  private readBackgroundJobStatusFile(
    file: string,
    sessionId: string,
  ): BackgroundJobStatus | undefined {
    try {
      const value = readJson<unknown>(file);
      if (!value || typeof value !== "object") return undefined;
      const job = value as Partial<BackgroundJobStatus>;
      if (
        typeof job.job_id !== "string" ||
        typeof job.session_id !== "string" ||
        job.session_id !== sessionId ||
        !["ask_peers", "run_until_unanimous", "durable_session_round"].includes(job.kind ?? "") ||
        !["running", "completed", "failed", "cancelled"].includes(job.status ?? "") ||
        typeof job.started_at !== "string"
      ) {
        return undefined;
      }
      return job as BackgroundJobStatus;
    } catch {
      // Operational job history is advisory. A corrupt entry must not make
      // the authoritative session unreadable; session_doctor/logs retain the
      // durable meta and event-chain diagnostics.
      return undefined;
    }
  }

  readBackgroundJobStatuses(sessionId: string): BackgroundJobStatus[] {
    const dir = this.backgroundJobsDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    const statuses: BackgroundJobStatus[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name)) continue;
      const job = this.readBackgroundJobStatusFile(path.join(dir, entry.name), sessionId);
      if (job) statuses.push(job);
    }
    return statuses.sort((a, b) =>
      (a.completed_at ?? a.started_at).localeCompare(b.completed_at ?? b.started_at),
    );
  }

  private async settleOrphanedBackgroundJobStatuses(
    session: SessionMeta,
    activeSessionIds: ReadonlySet<string>,
  ): Promise<number> {
    if (activeSessionIds.has(session.session_id)) return 0;
    const controlActive =
      session.control?.status === "running" || session.control?.status === "cancel_requested";
    const durableExecutionActive =
      !session.outcome &&
      (Boolean(session.in_flight) ||
        Boolean(session.generation_in_flight) ||
        (session.pending_provider_call_reservations?.length ?? 0) > 0 ||
        controlActive);
    if (durableExecutionActive) return 0;

    const runningJobs = this.readBackgroundJobStatuses(session.session_id).filter(
      (job) => job.status === "running",
    );
    if (runningJobs.length === 0) return 0;
    const settledAt = session.outcome ? session.updated_at : now();
    const error = session.outcome
      ? `background_job_settled_after_terminal_session: outcome=${session.outcome}, reason=${session.outcome_reason ?? "unspecified"}`
      : "background_job_interrupted_or_settled_without_terminal_status";
    for (const job of runningJobs) {
      await this.writeBackgroundJobStatus({
        ...job,
        status: "failed",
        completed_at: settledAt,
        error,
      });
    }
    return runningJobs.length;
  }

  assertSessionId(sessionId: string): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)) {
      throw new Error(`invalid session_id: ${sessionId}`);
    }
  }

  private isPathContained(parent: string, target: string): boolean {
    const relative = path.relative(parent, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private resolveContainedExistingPath(parent: string, candidate: string): string | undefined {
    const resolvedCandidate = path.resolve(parent, candidate);
    if (!this.isPathContained(parent, resolvedCandidate)) return undefined;
    try {
      const realCandidate = fs.realpathSync(resolvedCandidate);
      return this.isPathContained(parent, realCandidate) ? realCandidate : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolvedCandidate;
      throw error;
    }
  }

  private safeResolveContainedExistingPath(parent: string, candidate: string): string | undefined {
    try {
      return this.resolveContainedExistingPath(parent, candidate);
    } catch {
      return undefined;
    }
  }

  private readContainedRegularFile(
    sessionId: string,
    relativePath: string,
    errorPrefix: "reviewed_artifact" | "evidence_integrity" | "provider_prompt" | "provider_result",
  ): { bytes: number; sha256: string; content: string; persisted: Buffer } {
    const sessionDir = this.sessionDir(sessionId);
    if (
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`${errorPrefix}_path_not_contained: ${relativePath}`);
    }
    const candidate = path.join(sessionDir, ...relativePath.split("/"));
    let candidateStat: fs.BigIntStats;
    try {
      candidateStat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw new Error(`${errorPrefix}_unavailable: ${relativePath}`, { cause: error });
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new Error(`${errorPrefix}_not_regular_file: ${relativePath}`);
    }
    const absolutePath = this.safeResolveContainedExistingPath(sessionDir, relativePath);
    if (!absolutePath) {
      throw new Error(`${errorPrefix}_path_not_contained: ${relativePath}`);
    }

    let persisted: Buffer;
    try {
      const descriptor = fs.openSync(absolutePath, "r");
      try {
        const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
        if (!descriptorStat.isFile()) {
          throw new Error(`${errorPrefix}_not_regular_file: ${relativePath}`);
        }
        if (candidateStat.dev !== descriptorStat.dev || candidateStat.ino !== descriptorStat.ino) {
          throw new Error(`${errorPrefix}_identity_mismatch: ${relativePath}`);
        }
        persisted = fs.readFileSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === `${errorPrefix}_not_regular_file: ${relativePath}` ||
          error.message === `${errorPrefix}_identity_mismatch: ${relativePath}`)
      ) {
        throw error;
      }
      throw new Error(`${errorPrefix}_unavailable: ${relativePath}`, { cause: error });
    }
    return {
      bytes: persisted.byteLength,
      sha256: crypto.createHash("sha256").update(persisted).digest("hex"),
      content: persisted.toString("utf8"),
      persisted,
    };
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private totalsFor(meta: SessionMeta): SessionMeta["totals"] {
    const peerResults = meta.rounds.flatMap((round) => round.peers);
    const providerSettlements = [
      ...(meta.in_flight?.provider_settlements ?? []),
      ...(meta.interrupted_provider_settlements ?? []),
    ];
    const generations = meta.generation_files ?? [];
    const failedAttempts = meta.failed_attempts ?? [];
    return {
      usage: mergeUsage([
        ...peerResults.map((peer) => peer.usage),
        ...providerSettlements.map((settlement) => settlement.usage),
        ...generations.map((generation) => generation.usage),
        ...failedAttempts.map((failure) => failure.usage),
        meta.generation_in_flight?.settled_result_usage,
      ]),
      cost: mergeCost([
        ...peerResults.map((peer) => peer.cost),
        ...providerSettlements.map((settlement) => settlement.cost),
        ...generations.map((generation) => generation.cost),
        ...failedAttempts.map((failure) => failure.cost),
        meta.generation_in_flight?.settled_result_cost,
      ]),
    };
  }

  private accountInterruptedInFlight(meta: SessionMeta, reason: string): void {
    const inFlight = meta.in_flight;
    if (!inFlight) return;
    const settlements = inFlight.provider_settlements ?? [];
    const reservations = inFlight.provider_call_reservations ?? [];
    const settledPeers = new Set(
      settlements
        .filter((settlement) => settlement.reservation_id === undefined)
        .map((settlement) => settlement.peer),
    );
    if (settlements.length > 0) {
      const existingArtifacts = new Set(
        (meta.interrupted_provider_settlements ?? []).map((settlement) => settlement.artifact_path),
      );
      meta.interrupted_provider_settlements = [
        ...(meta.interrupted_provider_settlements ?? []),
        ...settlements.filter((settlement) => !existingArtifacts.has(settlement.artifact_path)),
      ];
    }
    const elapsed = Math.max(0, Date.now() - Date.parse(inFlight.started_at));
    const unresolvedPeers = inFlight.peers.filter((peer) => !settledPeers.has(peer));
    const unknownInitialAttempts = unresolvedPeers.map((peer) => {
      const snapshot = meta.capability_snapshot.find((entry) => entry.peer === peer);
      return {
        peer,
        provider: snapshot?.provider ?? peer,
        model: snapshot?.model ?? this.config.models[peer],
        failure_class: "provider_error" as const,
        message:
          `${POSSIBLE_INTERRUPTED_ATTEMPT_MESSAGE_PREFIX}: ${reason}; ` +
          `round ${inFlight.round} ended without a durable provider result. ` +
          "At least one attempt is conservatively marked unpriced; exact billing requires provider reconciliation.",
        retryable: false,
        attempts: 1,
        latency_ms: Number.isFinite(elapsed) ? elapsed : 0,
        billing_status: "unknown" as const,
        unpriced_attempts: 1,
        indeterminate_spend_attempts: 1,
        round: inFlight.round,
      };
    });
    const unknownReservedAttempts = reservations.map((reservation) => ({
      peer: reservation.peer,
      provider: reservation.provider,
      model: reservation.model,
      failure_class: "provider_error" as const,
      message:
        `${POSSIBLE_INTERRUPTED_ATTEMPT_MESSAGE_PREFIX}: ${reason}; ` +
        `round ${inFlight.round} ${reservation.label} call ${reservation.id} ended without a durable provider result. ` +
        "At least one attempt is conservatively marked unpriced; exact billing requires provider reconciliation.",
      retryable: false,
      attempts: 1,
      latency_ms: Number.isFinite(elapsed) ? elapsed : 0,
      billing_status: "unknown" as const,
      unpriced_attempts: 1,
      indeterminate_spend_attempts: 1,
      round: inFlight.round,
    }));
    meta.failed_attempts = [
      ...(meta.failed_attempts ?? []),
      ...unknownInitialAttempts,
      ...unknownReservedAttempts,
    ];
    // Moving settlements and consuming unresolved peer reservations is
    // idempotent. A second recovery path cannot count either category twice.
    inFlight.provider_settlements = [];
    inFlight.provider_call_reservations = [];
    inFlight.peers = [];
    meta.totals = this.totalsFor(meta);
  }

  private accountInterruptedBackgroundGeneration(meta: SessionMeta, reason: string): void {
    // Only a provider-dispatch marker is accounting evidence. `control=running`
    // alone also covers the zero-dispatch interval before run() starts and the
    // already-settled interval after a round, so inferring spend from it would
    // create false unpriced attempts.
    if (meta.in_flight) return;
    const pending = meta.generation_in_flight;
    if (!pending) return;
    const elapsed = Math.max(0, Date.now() - Date.parse(pending.started_at));
    const unknownAttempt: PeerFailure & { round: number } = {
      peer: pending.peer,
      provider: pending.provider,
      model: pending.model,
      failure_class: "provider_error",
      message:
        `possible initial/background generation attempt interrupted (${pending.label}): ${reason}; ` +
        "the durable owner ended before a generation result or review-round in_flight marker was persisted. " +
        "One attempt is conservatively marked unpriced; exact billing requires provider reconciliation.",
      retryable: false,
      attempts: 1,
      latency_ms: Number.isFinite(elapsed) ? elapsed : 0,
      billing_status: "unknown",
      unpriced_attempts: 1,
      indeterminate_spend_attempts: 1,
      round: pending.round,
    };
    meta.failed_attempts = [...(meta.failed_attempts ?? []), unknownAttempt];
    meta.totals = this.totalsFor(meta);
  }

  private processStartTimeMs(pid: number): number | undefined {
    if (pid === process.pid) {
      return Date.now() - process.uptime() * 1_000;
    }
    const cached = this.processStartTimeCache.get(pid);
    if (cached && Date.now() - cached.checked_at_ms <= 1_000) {
      return cached.started_at_ms;
    }
    let startedAtMs: number | undefined;
    try {
      const output =
        process.platform === "win32"
          ? execFileSync(
              "powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                '& { param([int]$TargetPid) $p = Get-Process -Id $TargetPid -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString("o") }',
                "-TargetPid",
                String(pid),
              ],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 10_000,
                windowsHide: true,
              },
            )
          : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 10_000,
              windowsHide: true,
            });
      const parsed = Date.parse(output.trim());
      startedAtMs = Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      // Start-time introspection is a hardening signal. Platforms that do not
      // expose it retain the prior conservative PID-liveness behavior.
      startedAtMs = undefined;
    }
    this.processStartTimeCache.set(pid, {
      checked_at_ms: Date.now(),
      started_at_ms: startedAtMs,
    });
    return startedAtMs;
  }

  private ownerPidIsAlive(ownerPid: number | undefined, markerStartedAt?: string): boolean {
    if (
      typeof ownerPid !== "number" ||
      !Number.isInteger(ownerPid) ||
      ownerPid <= 0 ||
      !this.processAlive(ownerPid)
    ) {
      return false;
    }
    const markerStartedMs = markerStartedAt ? Date.parse(markerStartedAt) : Number.NaN;
    if (!Number.isFinite(markerStartedMs)) return true;
    const processStartedMs = this.processStartTimeMs(ownerPid);
    // A live process that started after the durable dispatch marker cannot be
    // its owner: the OS recycled the PID. Treat that marker as orphaned.
    return processStartedMs === undefined || processStartedMs <= markerStartedMs + 1_000;
  }

  private pendingProviderCallOwnerIsAlive(reservation: PendingProviderCallReservation): boolean {
    return this.ownerPidIsAlive(reservation.owner_pid, reservation.started_at);
  }

  private inFlightOwnerIsAlive(session: SessionMeta): boolean {
    const owners = [
      {
        pid: session.in_flight?.owner_pid,
        marker_started_at: session.in_flight?.started_at,
      },
      {
        pid: session.generation_in_flight?.owner_pid,
        marker_started_at: session.generation_in_flight?.started_at,
      },
      {
        pid: session.control?.owner_pid,
        marker_started_at: session.control?.requested_at ?? session.control?.updated_at,
      },
      ...(session.in_flight?.provider_call_reservations ?? []).map((reservation) => ({
        pid: reservation.owner_pid,
        marker_started_at: reservation.started_at,
      })),
    ];
    return owners.some(({ pid, marker_started_at }) =>
      this.ownerPidIsAlive(pid, marker_started_at),
    );
  }

  private accountInterruptedPendingProviderCalls(
    meta: SessionMeta,
    reason: string,
    shouldAccount: (reservation: PendingProviderCallReservation) => boolean = () => true,
  ): number {
    const reservations = meta.pending_provider_call_reservations ?? [];
    const interruptedReservations = reservations.filter(shouldAccount);
    if (!interruptedReservations.length) return 0;
    const unknownAttempts = interruptedReservations.map((reservation) => {
      const elapsed = Math.max(0, Date.now() - Date.parse(reservation.started_at));
      return {
        peer: reservation.peer,
        provider: reservation.provider,
        model: reservation.model,
        failure_class: "provider_error" as const,
        message:
          `${POSSIBLE_INTERRUPTED_ATTEMPT_MESSAGE_PREFIX}: ${reason}; ` +
          `${reservation.call_kind}/${reservation.label} call ${reservation.id} ended without a durable result. ` +
          "At least one attempt is conservatively marked unpriced; exact billing requires provider reconciliation.",
        retryable: false,
        attempts: 1,
        latency_ms: Number.isFinite(elapsed) ? elapsed : 0,
        billing_status: "unknown" as const,
        unpriced_attempts: 1,
        indeterminate_spend_attempts: 1,
        round: reservation.round,
        ...(reservation.provider_prompt ? { provider_prompt: reservation.provider_prompt } : {}),
      };
    });
    meta.failed_attempts = [...(meta.failed_attempts ?? []), ...unknownAttempts];
    meta.pending_provider_call_reservations = reservations.filter(
      (reservation) => !interruptedReservations.includes(reservation),
    );
    meta.totals = this.totalsFor(meta);
    return interruptedReservations.length;
  }

  private sealRecoveredAppendedConvergence(meta: SessionMeta): ReviewRound | undefined {
    const latestRound = meta.rounds.at(-1);
    const appendedCircularConvergence =
      meta.mode === "circular" &&
      latestRound?.review_kind === "circular_revision" &&
      latestRound.convergence.converged === true &&
      !meta.in_flight &&
      !meta.generation_in_flight &&
      meta.control?.status === "running";
    if (
      (!inFlightRoundAlreadyAppended(meta) && !appendedCircularConvergence) ||
      latestRound?.convergence.converged !== true ||
      meta.control?.status === "cancel_requested" ||
      (meta.pending_provider_call_reservations?.length ?? 0) > 0
    ) {
      return undefined;
    }
    if (
      this.roundRequiresReviewedArtifactCustody(meta, latestRound) ||
      latestRound.reviewed_artifact
    ) {
      try {
        this.readRoundReviewedArtifact(meta.session_id, latestRound);
      } catch {
        // A converged vote cannot be auto-sealed when the reviewed bytes no
        // longer match the durable round custody. Leave the reservation open
        // so ordinary restart recovery marks the session stale/blocked.
        return undefined;
      }
    }
    if (latestRound.review_kind === "circular_revision") {
      try {
        this.readRoundProviderResult(meta.session_id, meta, latestRound);
      } catch {
        // Circular convergence is authorized by the exact accepted provider
        // result. Recovery must never terminalize a missing or changed result.
        return undefined;
      }
    }
    delete meta.in_flight;
    delete meta.generation_in_flight;
    delete meta.control;
    meta.outcome = "converged";
    meta.outcome_reason =
      latestRound.review_kind === "circular_revision"
        ? "circular_full_rotation_no_change"
        : latestRound.convergence.recovery_converged
          ? "recovered_unanimity"
          : "unanimous_ready";
    const transitionedAt = now();
    meta.convergence_health = transitionHealth(
      meta,
      "converged",
      meta.outcome_reason,
      transitionedAt,
    );
    meta.updated_at = transitionedAt;
    return latestRound;
  }

  private restoreFinalArtifactFromRound(meta: SessionMeta, round: ReviewRound): boolean {
    const finalPath = path.join(this.sessionDir(meta.session_id), "final.md");
    try {
      fs.lstatSync(finalPath);
      // An existing mirror is evidence. Recovery must never overwrite it,
      // including when it is mismatched, redirected or not a regular file.
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    try {
      const reviewed = this.readRoundReviewedArtifact(meta.session_id, round);
      const tmp = atomicTempPath(finalPath);
      try {
        fs.writeFileSync(tmp, reviewed.content, "utf8");
        // Hard-link creation is atomic and refuses EEXIST, so a concurrent
        // artifact can never be replaced between the missing check and commit.
        fs.linkSync(tmp, finalPath);
      } finally {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* best-effort temporary-file cleanup */
        }
      }
      this.assertFinalMirrorMatches(meta.session_id, reviewed);
      return true;
    } catch {
      // Never recreate final.md from unauthenticated or mutated bytes. The
      // round metadata remains forensic evidence, while the missing mirror
      // makes the custody failure visible to session diagnostics.
      return false;
    }
  }

  private settleBackgroundGenerationMarker(meta: SessionMeta, peer: PeerId, round: number): void {
    const pending = meta.generation_in_flight;
    if (pending?.peer === peer && pending.round === round) {
      delete meta.generation_in_flight;
    }
  }

  // v4.1.0 hardening: pre-v4.1.0 acquired the lock via an exclusive
  // file-create syscall followed by a separate JSON metadata write,
  // which had a multi-process TOCTOU race window. Process A's create
  // returned an empty inode + fd; before A's metadata write executed,
  // process B could observe the empty file, fail to JSON-parse it,
  // remove the lock path, create its own valid lock, and enter the
  // critical section. Process A would then write into the now-orphan
  // inode via the still-open fd and ALSO enter the critical section,
  // corrupting meta.json. proper-lockfile uses `fs.mkdir` (atomic
  // across NTFS and POSIX) so the lock comes into existence as a
  // directory in a single syscall — no empty-window race possible.
  // The mkdir-based lock also fixes the lock-holder freshness signal:
  // proper-lockfile's `update` interval touches the lockfile's mtime
  // every 5 s, and any other process treats the lock as stale once the
  // mtime is older than `stale` ms (120 s). This is more robust than
  // the pre-v4.1.0 PID-aliveness check, which had collision risk after
  // process restart.
  private async withSessionLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
    const dir = this.sessionDir(sessionId);
    const target = this.metaPath(sessionId);
    const lockfilePath = path.join(dir, ".lock");
    fs.mkdirSync(dir, { recursive: true });
    // proper-lockfile requires the target path to exist (it uses it for
    // realpath resolution). Init creates the session dir then immediately
    // calls withSessionLock-protected writes; pre-create an empty meta
    // placeholder so the first init() can acquire the lock. Existing
    // session reuses preserve their meta.
    try {
      fs.writeFileSync(target, "{}\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      /* existing or concurrently-created meta; fine */
    }
    // Pre-v4.1.0 legacy `.lock` regular file detection — FAIL CLOSED.
    //
    // Pre-v4.1.0 created `.lock` as a regular file containing
    // `{pid, ts}` JSON. proper-lockfile claims `.lock` as a DIRECTORY
    // via mkdir, so a leftover regular file blocks every subsequent
    // lockfile.lock() with EEXIST. The original v4.1.0 design tried
    // to auto-clean stale legacy files. Codex (session 059b0093 R1
    // through R4) progressively demonstrated that NO auto-clean is
    // safe under live cross-version operation:
    //
    //   • R1: unconditional removal split-brained with a live legacy
    //     holder.
    //   • R2: removal-when-pid-alive-but-mtime-stale split-brained
    //     because legacy locks do not heartbeat (mtime is frozen at
    //     acquisition).
    //   • R3: per-process atomic decisions still raced two v4.1
    //     migrators.
    //   • R4: serializing v4.1 migrators via a separate mutex still
    //     left the cross-version race: v4.0.x's own stale-removal
    //     path does not honor any v4.1 mutex, so a concurrent v4.0.x
    //     could remove a stale `.lock` and create its own live one
    //     between v4.1's read and v4.1's path-based rmSync —
    //     v4.1 then deletes the new live legacy lock → split-brain.
    //
    // Resolution: v4.1.0 NEVER auto-removes a legacy regular `.lock`
    // file. If one is observed, withSessionLock throws a clear
    // remediation error to the caller, instructing the operator to
    // stop all cross-review processes and remove the file manually.
    // This is a ONE-TIME operator step at v4.0.x → v4.1.0 upgrade.
    // After all hosts are on v4.1.0 the locks are mkdir-atomic and
    // the issue cannot recur.
    try {
      const stat = fs.statSync(lockfilePath);
      if (stat.isFile()) {
        throw new Error(
          `cross-review v4.1.0 detected a pre-v4.1.0 lock file at ${lockfilePath}. ` +
            `Live cross-version migration is not supported (would split-brain with any ` +
            `concurrent v4.0.x process). To migrate safely: (1) stop all cross-review ` +
            `processes / close all MCP hosts that loaded the server, (2) remove the ` +
            `legacy lock file, (3) restart. POSIX one-liner for full cleanup: ` +
            `\`find ${this.config.data_dir}/sessions -name .lock -type f -delete\`. ` +
            `See CHANGELOG v04.01.00 migration notes for the rationale.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("detected a pre-v4.1.0 lock file")) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        /* ignore other stat errors; lockfile.lock will surface them */
      }
    }
    const release = await lockfile.lock(target, {
      stale: 120_000,
      update: 5_000,
      retries: { retries: 30, factor: 1.5, minTimeout: 100, maxTimeout: 1_000 },
      realpath: false,
      lockfilePath,
    });
    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch {
        /* lock was already released by stale-detection or sibling process */
      }
    }
  }

  async init(
    task: string,
    caller: PeerId | "operator",
    snapshot: PeerProbeResult[],
    reviewFocus?: string,
    mode: SessionMode = "ship",
  ): Promise<SessionMeta> {
    const session_id = crypto.randomUUID();
    const initializedAt = now();
    const configSnapshot = effectiveConfigSnapshot(this.config);
    const configSnapshotSha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(canonicalJsonValue(configSnapshot)))
      .digest("hex");
    // v2.22.0 (B.P3): snapshot the cost ceiling at session_init time so
    // budget pressure analysis is decoupled from later env-var mutation.
    // null when the operator runs without a session-level cost cap.
    const ceiling = this.config.budget.max_session_cost_usd;
    const meta: SessionMeta = {
      session_id,
      version: this.config.version,
      accounting_schema_version: 2,
      reviewed_artifact_custody_schema_version: 1,
      reviewed_artifact_custody_start_round: 1,
      provider_prompt_custody_schema_version: 1,
      provider_prompt_custody_start_round: 1,
      session_mode_schema_version: 1,
      mode,
      effective_config_snapshot: configSnapshot,
      effective_config_sha256: configSnapshotSha256,
      created_at: initializedAt,
      updated_at: initializedAt,
      task,
      ...(reviewFocus ? { review_focus: reviewFocus } : {}),
      caller,
      capability_snapshot: snapshot,
      convergence_health: {
        state: "idle",
        last_event_at: initializedAt,
        last_activity_at: initializedAt,
        last_state_transition_at: initializedAt,
        detail: "Session initialized.",
      },
      rounds: [],
      totals: {
        usage: {},
        cost: { currency: "USD", estimated: false, source: "unknown-rate" },
      },
      cost_ceiling_usd: typeof ceiling === "number" && ceiling > 0 ? ceiling : null,
      costs_per_round: [],
      budget_warning_emitted: false,
    };
    fs.mkdirSync(path.join(this.sessionDir(session_id), "agent-runs"), { recursive: true });
    fs.mkdirSync(this.backgroundJobsDir(session_id), { recursive: true });
    await writeJson(this.metaPath(session_id), meta);
    fs.writeFileSync(path.join(this.sessionDir(session_id), "task.md"), redact(task), "utf8");
    if (reviewFocus) {
      fs.writeFileSync(
        path.join(this.sessionDir(session_id), "review-focus.md"),
        redact(reviewFocus),
        "utf8",
      );
    }
    return meta;
  }

  // v2.4.0 / cross-review R5 (codex blocker): refuse to overwrite an
  // existing in_flight when starting a new round. Pre-R5 markInFlight
  // unconditionally clobbered `meta.in_flight`, so a second concurrent
  // ask_peers on the same session would silently steamroll the first
  // round's state — and the format-recovery quota counter would race
  // because both calls could read the same `recoveriesAlready` baseline.
  // R5 throws when in_flight is already populated; the boot-time
  // `clearStaleInFlight` sweep clears any orphan in_flight from a
  // crashed prior host so legitimate operators are not blocked.
  async markInFlight(
    sessionId: string,
    params: {
      round: number;
      peers: PeerId[];
      started_at: string;
      scope: ConvergenceScope;
    },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const err = new Error(
          `session_already_finalized: session ${sessionId} is finalized with outcome="${meta.outcome}"; cannot mark a round in flight`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      if (meta.in_flight) {
        throw new Error(
          `session ${sessionId} already has an in-flight round (round=${meta.in_flight.round}, started_at=${meta.in_flight.started_at}); refusing to start a concurrent round. Wait for the round to complete, cancel it via session_cancel_job, or recover it via session_recover_interrupted.`,
        );
      }
      meta.in_flight = {
        round: params.round,
        peers: params.peers,
        started_at: params.started_at,
        status: "running",
        owner_pid: process.pid,
        evidence_broker_snapshot: {
          evidence_checklist:
            meta.evidence_checklist === undefined ? null : structuredClone(meta.evidence_checklist),
          evidence_status_history:
            meta.evidence_status_history === undefined
              ? null
              : structuredClone(meta.evidence_status_history),
        },
      };
      meta.convergence_scope = params.scope;
      const transitionedAt = now();
      meta.convergence_health = transitionHealth(
        meta,
        "running",
        `Round ${params.round} is running.`,
        transitionedAt,
      );
      meta.updated_at = transitionedAt;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  read(sessionId: string): SessionMeta {
    const meta = readJson<unknown>(this.metaPath(sessionId));
    const shapeError = sessionMetaShapeError(meta);
    if (shapeError) throw new Error(`schema_validation_failed: ${shapeError}`);
    return meta as SessionMeta;
  }

  readTextArtifact(sessionId: string, relativePath: string, maxChars: number): string {
    const sessionDir = this.sessionDir(sessionId);
    const absolutePath = this.resolveContainedExistingPath(sessionDir, relativePath);
    if (!absolutePath) {
      throw new Error(`artifact path escapes session directory: ${relativePath}`);
    }
    const raw = fs.readFileSync(absolutePath, "utf8");
    return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  }

  // v2.4.0 / audit closure (P3.13) — refined after cross-review R2 (codex
  // caught a durability gap in the initial implementation).
  //
  // Pre-R2: the cache was incremented BEFORE appendFileSync. If the
  // append failed (ENOSPC, EACCES, write-error mid-call) the cache held
  // an already-handed-out seq number that nothing on disk consumed —
  // and a subsequent successful append would reuse the same disk byte
  // for a different event, while the cache produced seq+1. After
  // process restart the cache rebuild re-counted lines and produced a
  // duplicate seq.
  //
  // R2 (codex): the cache is updated ONLY after the appendFileSync
  // returns. If append throws, the cache is unchanged so the next call
  // reuses the same intended seq (no gap, no duplicate). On restart
  // the cache rebuild reflects on-disk reality. The lazy load uses
  // line count of the existing file as a reasonable approximation of
  // the durable max-seq.
  private peekNextSeq(sessionId: string, file: string): number {
    let durable = 0;
    try {
      durable = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const cached = this.seqCache.get(sessionId) ?? 0;
    const baseline = Math.max(cached, durable);
    this.seqCache.set(sessionId, baseline);
    return baseline + 1;
  }

  private commitSeq(sessionId: string, committed: number): void {
    this.seqCache.set(sessionId, committed);
  }

  private async appendEventRecord(event: RuntimeEvent): Promise<void> {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const file = this.eventsPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const meta = this.read(sessionId);
    const terminalRecoveryEvent =
      event.type === "session.recovered_after_restart" &&
      event.data !== undefined &&
      (event.data as Record<string, unknown>).final_artifact_recovered === true &&
      (event.data as Record<string, unknown>).source === "terminal_missing_final_mirror";
    const terminalEvent =
      event.type === "session.finalized" ||
      event.type === "session.cancelled" ||
      event.type === "session.evidence_broker_transaction_rolled_back" ||
      terminalRecoveryEvent;
    if (meta.outcome && !terminalEvent) {
      const error = new Error(
        `post_terminal_event_rejected: ${event.type} cannot be appended after outcome=${meta.outcome}`,
      );
      (error as Error & { code?: string }).code = "post_terminal_event_rejected";
      throw error;
    }
    const seq = this.peekNextSeq(sessionId, file);
    const eventTs = event.ts ?? now();
    fs.appendFileSync(
      file,
      `${JSON.stringify(redactJsonValue({ ...event, seq, ts: eventTs }))}\n`,
      "utf8",
    );
    this.commitSeq(sessionId, seq);

    // An event is activity, not necessarily a convergence-state transition.
    // Keep the old last_event_at field as an activity alias while preserving
    // the independently meaningful state-transition timestamp.
    if (meta.convergence_health && !terminalRecoveryEvent) {
      const previousLastEvent = meta.convergence_health.last_event_at;
      const activityAt = latestTimestamp(
        meta.convergence_health.last_activity_at ?? previousLastEvent,
        eventTs,
      );
      meta.convergence_health.last_activity_at = activityAt;
      meta.convergence_health.last_event_at = activityAt;
      meta.convergence_health.last_state_transition_at ??= previousLastEvent;
      meta.updated_at = latestTimestamp(meta.updated_at, activityAt);
      await writeJson(this.metaPath(sessionId), meta);
    }
  }

  // v4.1.0: durable event persistence. withSessionLock became async
  // with the proper-lockfile refactor; appendEvent awaits the lock so
  // callers that read events after persisting get the expected
  // synchronous-write semantics (e.g. the session_doctor sweep + smoke
  // fixtures that read events.ndjson immediately after appendEvent).
  // Fire-and-forget callers wrap with `void store.appendEvent(...)`.
  async appendEvent(event: RuntimeEvent): Promise<void> {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const previous = this.eventWriteChains.get(sessionId) ?? Promise.resolve();
    const write = previous.then(async () => {
      try {
        await this.withSessionLock(sessionId, async () => {
          // Only commit the cache AFTER the durable append succeeded.
          // If appendFileSync threw inside appendEventRecord, the cache
          // still reflects the last persisted seq and the next call
          // reuses this seq number.
          await this.appendEventRecord(event);
        });
      } catch (error) {
        // Terminal session chains are immutable. Authentication/authority
        // audit events emitted while serving an idempotent post-terminal MCP
        // request still belong in the global runtime log, so their local
        // append is an expected no-op. Do not suppress any other event type:
        // a late peer/round/provider event is a real ordering defect.
        const expectedPostTerminalAuditEvents = new Set([
          "session.identity_verified",
          "session.identity_forgery_blocked",
          "session.session_authority_blocked",
          "session.operator_authority_blocked",
        ]);
        if (
          (error as Error & { code?: string }).code === "post_terminal_event_rejected" &&
          expectedPostTerminalAuditEvents.has(event.type)
        ) {
          return;
        }
        // Event persistence must never break provider calls or MCP responses.
        console.error(
          JSON.stringify({
            type: "append_event_persist_failed",
            session_id: event.session_id,
            event_type: event.type,
            message: safeErrorMessage(error),
          }),
        );
      }
    });
    this.eventWriteChains.set(sessionId, write);
    this.pendingEventWrites.add(write);
    void write.finally(() => {
      this.pendingEventWrites.delete(write);
      if (this.eventWriteChains.get(sessionId) === write) {
        this.eventWriteChains.delete(sessionId);
      }
    });
    return write;
  }

  // v4.1.0: wait for all in-flight fire-and-forget event writes to
  // settle. Used by tests/sweeps that need synchronous read-after-write
  // semantics for events.ndjson when the emit pipeline used
  // `void store.appendEvent(...)`. Always resolves (never rejects);
  // appendEvent swallows its own errors.
  async flushPendingEvents(): Promise<void> {
    while (this.pendingEventWrites.size > 0) {
      const snapshot = Array.from(this.pendingEventWrites);
      await Promise.allSettled(snapshot);
    }
  }

  readEvents(sessionId: string, sinceSeq = 0): SessionEvent[] {
    const file = this.eventsPath(sessionId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => ({ seq: index + 1, ...JSON.parse(line) }) as SessionEvent)
      .filter((event) => event.seq > sinceSeq);
  }

  // v2.27.0/v4.5.0: parse-corrupt or structurally invalid meta.json files are
  // skipped + quarantined to `<session_dir>/meta.json.bad` so listing and
  // startup sweeps cannot be crashed by valid JSON with an invalid shape.
  // Empirically demonstrated by 3 sessions corrupted by the v2.25.1 redact
  // escape-boundary bug (77c47284, be47a5b0, 7edf63e3) that caused parse
  // errors on every Claude Code reload until manually deleted 2026-05-12.
  list(): SessionMeta[] {
    if (!fs.existsSync(this.sessionsDir())) return [];
    const entries = fs.readdirSync(this.sessionsDir(), { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(this.sessionsDir(), entry.name);
      const file = path.join(sessionDir, "meta.json");
      if (!fs.existsSync(file)) continue;
      try {
        const meta = readJson<unknown>(file);
        const shapeError = sessionMetaShapeError(meta);
        if (shapeError) throw new Error(`schema_validation_failed: ${shapeError}`);
        metas.push(meta as SessionMeta);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const quarantine = path.join(sessionDir, "meta.json.bad");
        try {
          if (!fs.existsSync(quarantine)) {
            fs.renameSync(file, quarantine);
            console.error(
              `[cross-review] quarantined corrupted meta.json at ${file} -> ${quarantine} (${message})`,
            );
          }
        } catch {
          /* best-effort */
        }
      }
    }
    return metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  // v2.27.0: prune finalized sessions older than `maxAgeDays` days. Default
  // 60 days (configurable via CROSS_REVIEW_PRUNE_AFTER_DAYS env var or
  // explicit arg). Only removes sessions whose outcome is terminal (converged
  // | aborted | max-rounds) AND whose updated_at is older than the cutoff.
  // In-flight or untyped-outcome sessions are never pruned. Idempotent +
  // best-effort. Empirically motivated by 534 sessions accumulated on disk
  // by 2026-05-12 inflating cold-start sweep cost.
  pruneOldSessions(maxAgeDays?: number): { scanned: number; pruned: number } {
    const envDays = Number.parseFloat(process.env.CROSS_REVIEW_PRUNE_AFTER_DAYS ?? "");
    const days =
      maxAgeDays != null && maxAgeDays > 0
        ? maxAgeDays
        : Number.isFinite(envDays) && envDays > 0
          ? envDays
          : 60;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    let scanned = 0;
    let pruned = 0;
    for (const session of this.list()) {
      scanned += 1;
      if (!session.outcome) continue;
      const lastTouched = Date.parse(session.updated_at);
      if (!Number.isFinite(lastTouched) || lastTouched >= cutoffMs) continue;
      const dir = this.sessionDir(session.session_id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned += 1;
      } catch {
        /* best-effort */
      }
    }
    return { scanned, pruned };
  }

  savePrompt(sessionId: string, round: number, prompt: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-prompt.md`);
    fs.writeFileSync(file, redact(prompt), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  private prepareProviderPromptFile(
    sessionId: string,
    round: number,
    peer: PeerId,
    label: string,
    prompt: string,
  ): {
    readonly file: string;
    readonly content: string;
    readonly custody: ProviderPromptCustody;
  } {
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new Error(`provider_prompt_round_invalid: ${String(round)}`);
    }
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "call";
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${peer}-${safeLabel}-prompt-${crypto.randomUUID()}.md`,
    );
    const redactedPrompt = redact(prompt);
    writeTextAtomically(file, redactedPrompt);
    const relativePath = path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
    const authenticated = this.readContainedRegularFile(sessionId, relativePath, "provider_prompt");
    if (authenticated.content !== redactedPrompt) {
      throw new Error(`provider_prompt_readback_mismatch: ${relativePath}`);
    }
    const custody: ProviderPromptCustody = {
      relative_path: relativePath,
      sha256: authenticated.sha256,
      bytes: authenticated.bytes,
      utf16_units: authenticated.content.length,
      reconstructible: true,
      redacted: true,
    };
    return { file, content: authenticated.content, custody };
  }

  private appendProviderPromptArtifact(meta: SessionMeta, artifact: ProviderPromptArtifact): void {
    if (meta.provider_prompt_custody_schema_version !== 1) {
      // Marker-less sessions are legacy regardless of their package version.
      // Upgrade the schema marker and first governed round in the same
      // meta.json replacement as the first prompt ledger entry so a crash
      // cannot persist a half-upgraded record.
      meta.provider_prompt_custody_schema_version = 1;
      meta.provider_prompt_custody_start_round = Math.max(
        1,
        Math.min(artifact.round, meta.rounds.length + 1),
      );
    }
    meta.provider_prompt_files = [...(meta.provider_prompt_files ?? []), artifact];
  }

  private removeUnledgeredProviderPrompt(
    sessionId: string,
    prepared: { readonly file: string; readonly custody: ProviderPromptCustody },
  ): void {
    try {
      const meta = this.read(sessionId);
      if (
        (meta.provider_prompt_files ?? []).some(
          (artifact) => artifact.relative_path === prepared.custody.relative_path,
        )
      ) {
        return;
      }
      fs.unlinkSync(prepared.file);
    } catch {
      // Fail closed: if metadata cannot prove the file is unledgered, retain it
      // for recovery/forensics rather than deleting a possibly committed prompt.
    }
  }

  /**
   * Persist, descriptor-authenticate and ledger the exact redacted prompt that
   * a provider will receive. Callers must dispatch the returned content rather
   * than their pre-redaction input.
   */
  async saveProviderPrompt(
    sessionId: string,
    round: number,
    peer: PeerId,
    provider: string,
    model: string,
    callKind: ProviderPromptArtifact["call_kind"],
    label: string,
    prompt: string,
  ): Promise<{ readonly content: string; readonly custody: ProviderPromptCustody }> {
    const prepared = this.prepareProviderPromptFile(sessionId, round, peer, label, prompt);
    try {
      await this.withSessionLock(sessionId, async () => {
        const meta = this.read(sessionId);
        if (meta.outcome) {
          throw new Error(
            `session_already_finalized: cannot dispatch provider prompt for ${sessionId} with outcome=${meta.outcome}`,
          );
        }
        this.appendProviderPromptArtifact(meta, {
          ...prepared.custody,
          ts: now(),
          round,
          peer,
          provider,
          model,
          call_kind: callKind,
          label,
        });
        meta.updated_at = now();
        await writeJson(this.metaPath(sessionId), meta);
      });
      return { content: prepared.content, custody: prepared.custody };
    } catch (error) {
      this.removeUnledgeredProviderPrompt(sessionId, prepared);
      throw error;
    }
  }

  /**
   * Prepare an exact provider prompt and its non-review dispatch reservation as
   * one durable metadata transition. A crash can never commit an unreserved
   * prompt ledger entry: metadata contains neither entry or both.
   */
  async preparePendingProviderPromptCall(
    sessionId: string,
    params: Omit<
      PendingProviderCallReservation,
      "id" | "started_at" | "owner_pid" | "provider_prompt"
    >,
    prompt: string,
  ): Promise<{
    readonly reservation_id: string;
    readonly content: string;
    readonly custody: ProviderPromptCustody;
  }> {
    const prepared = this.prepareProviderPromptFile(
      sessionId,
      params.round,
      params.peer,
      params.label,
      prompt,
    );
    try {
      const reservationId = await this.withSessionLock(sessionId, async () => {
        const meta = this.read(sessionId);
        if (meta.outcome) {
          const error = new Error(
            `post_terminal_provider_reservation: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
          );
          (error as Error & { code?: string }).code = "post_terminal_provider_reservation";
          throw error;
        }
        if (meta.control?.status === "cancel_requested") {
          const error = new Error(
            `provider_reservation_cancelled: refusing to dispatch ${params.call_kind}/${params.label} after cancellation was requested`,
          );
          (error as Error & { code?: string }).code = "provider_reservation_cancelled";
          throw error;
        }
        const transactionAt = now();
        const artifact: ProviderPromptArtifact = {
          ...prepared.custody,
          ts: transactionAt,
          round: params.round,
          peer: params.peer,
          provider: params.provider,
          model: params.model,
          call_kind: params.call_kind,
          label: params.label,
        };
        const reservation: PendingProviderCallReservation = {
          id: crypto.randomUUID(),
          ...params,
          provider_prompt: prepared.custody,
          started_at: transactionAt,
          owner_pid: process.pid,
        };
        this.appendProviderPromptArtifact(meta, artifact);
        meta.pending_provider_call_reservations = [
          ...(meta.pending_provider_call_reservations ?? []),
          reservation,
        ];
        meta.updated_at = transactionAt;
        await writeJson(this.metaPath(sessionId), meta);
        return reservation.id;
      });
      return {
        reservation_id: reservationId,
        content: prepared.content,
        custody: prepared.custody,
      };
    } catch (error) {
      this.removeUnledgeredProviderPrompt(sessionId, prepared);
      throw error;
    }
  }

  saveDraft(sessionId: string, round: number, draft: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-draft.md`);
    fs.writeFileSync(file, redact(draft), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  private readReviewedArtifactFile(sessionId: string, round: number): PersistedReviewedArtifact {
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new Error(`reviewed_artifact_round_invalid: ${String(round)}`);
    }

    const relativePath = `agent-runs/round-${round}-draft.md`;
    // The shared contained-file reader authenticates the opened descriptor
    // against the original directory entry. This closes path-swap/reparse
    // races without relying on O_NOFOLLOW, which is not portable on Windows.
    const persisted = this.readContainedRegularFile(sessionId, relativePath, "reviewed_artifact");
    return {
      artifact_kind: "reviewed_artifact",
      round,
      relative_path: relativePath,
      sha256: persisted.sha256,
      bytes: persisted.bytes,
      content: persisted.content,
    };
  }

  private assertReviewedArtifactMatches(
    actual: PersistedReviewedArtifact,
    expected: ReviewedArtifactCustody & { readonly content?: string | undefined },
  ): void {
    const expectedPath = `agent-runs/round-${actual.round}-draft.md`;
    const contentMatches = expected.content === undefined || actual.content === expected.content;
    if (
      expected.relative_path !== expectedPath ||
      actual.relative_path !== expectedPath ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      !contentMatches
    ) {
      throw new Error(
        `reviewed_artifact_integrity_mismatch: ${expectedPath} expected sha256=${expected.sha256} bytes=${expected.bytes}, got sha256=${actual.sha256} bytes=${actual.bytes}`,
      );
    }
  }

  /**
   * Read back and authenticate the exact redacted bytes written by saveDraft.
   *
   * The expected draft is mandatory so this first read-back can detect a file
   * replacement or content mutation without trusting a model-supplied digest.
   * The path is derived from the validated round number; callers cannot use
   * this primitive as an arbitrary session-file reader.
   */
  readReviewedArtifact(
    sessionId: string,
    round: number,
    expectedDraft: string,
  ): PersistedReviewedArtifact {
    const expectedContent = redact(expectedDraft);
    const expected = {
      artifact_kind: "reviewed_artifact" as const,
      relative_path: `agent-runs/round-${round}-draft.md`,
      sha256: crypto.createHash("sha256").update(expectedContent, "utf8").digest("hex"),
      bytes: Buffer.byteLength(expectedContent, "utf8"),
      content: expectedContent,
    };
    const actual = this.readReviewedArtifactFile(sessionId, round);
    this.assertReviewedArtifactMatches(actual, expected);
    return actual;
  }

  /** Re-authenticate a previously read reviewed artifact after provider work. */
  revalidateReviewedArtifact(
    sessionId: string,
    expected: PersistedReviewedArtifact,
  ): PersistedReviewedArtifact {
    const actual = this.readReviewedArtifactFile(sessionId, expected.round);
    this.assertReviewedArtifactMatches(actual, expected);
    return actual;
  }

  /**
   * Read a round draft only through its durable custody metadata. Legacy
   * rounds remain parseable but are not silently promoted to authenticated
   * reviewed-artifact custody.
   */
  readRoundReviewedArtifact(sessionId: string, round: ReviewRound): PersistedReviewedArtifact {
    const expectedPath = `agent-runs/round-${round.round}-draft.md`;
    if (
      !round.reviewed_artifact ||
      round.draft_file !== expectedPath ||
      round.reviewed_artifact.relative_path !== expectedPath
    ) {
      throw new Error(`reviewed_artifact_custody_missing_or_invalid: ${expectedPath}`);
    }
    const actual = this.readReviewedArtifactFile(sessionId, round.round);
    this.assertReviewedArtifactMatches(actual, round.reviewed_artifact);
    return actual;
  }

  private roundRequiresReviewedArtifactCustody(meta: SessionMeta, round: ReviewRound): boolean {
    return (
      meta.reviewed_artifact_custody_schema_version === 1 &&
      round.round >= (meta.reviewed_artifact_custody_start_round ?? 1) &&
      (round.review_kind === "reviewed_artifact" ||
        // Tightly scoped compatibility for pre-kind governed records: only a
        // physical draft/custody marker can opt the legacy round into review
        // artifact validation. Explicit circular/pre-dispatch rounds never do.
        (round.review_kind === undefined &&
          (round.draft_file !== undefined || round.reviewed_artifact !== undefined)))
    );
  }

  assertPeerReviewDispatchVisibility(
    sessionId: string,
    meta: SessionMeta,
    peers: readonly PeerResult[],
    reviewedArtifact: PersistedReviewedArtifact,
    validateAttachments: boolean,
  ): void {
    for (const peer of peers) {
      const custody = peer.review_custody;
      if (!custody) {
        throw new Error(`peer_review_custody_required: peer=${peer.peer}`);
      }
      if (
        custody.reviewed_artifact.relative_path !== reviewedArtifact.relative_path ||
        custody.reviewed_artifact.sha256 !== reviewedArtifact.sha256
      ) {
        throw new Error(
          `review_custody reviewed artifact does not match the round: peer=${peer.peer}`,
        );
      }
      if (
        !dispatchVisibilityIsValid(
          custody.reviewed_artifact.visible_utf16_units,
          reviewedArtifact.content.length,
          custody.reviewed_artifact.truncated,
        )
      ) {
        throw new Error(
          `review_custody reviewed artifact visibility is invalid: peer=${peer.peer}`,
        );
      }
      if (
        meta.provider_prompt_custody_schema_version === 1 &&
        reviewedArtifact.round >= (meta.provider_prompt_custody_start_round ?? 1)
      ) {
        const prompt = custody.provider_prompt;
        if (!prompt) {
          throw new Error(`provider_prompt_custody_required: peer=${peer.peer}`);
        }
        const ledger = (meta.provider_prompt_files ?? []).find(
          (candidate) =>
            candidate.relative_path === prompt.relative_path &&
            candidate.call_kind === "peer_review" &&
            candidate.round === reviewedArtifact.round &&
            candidate.peer === peer.peer,
        );
        if (
          !ledger ||
          ledger.sha256 !== prompt.sha256 ||
          ledger.bytes !== prompt.bytes ||
          ledger.utf16_units !== prompt.utf16_units ||
          prompt.reconstructible !== true ||
          prompt.redacted !== true
        ) {
          throw new Error(`provider_prompt_custody_ledger_mismatch: peer=${peer.peer}`);
        }
        const authenticatedPrompt = this.readContainedRegularFile(
          sessionId,
          prompt.relative_path,
          "provider_prompt",
        );
        if (
          authenticatedPrompt.sha256 !== prompt.sha256 ||
          authenticatedPrompt.bytes !== prompt.bytes ||
          authenticatedPrompt.content.length !== prompt.utf16_units
        ) {
          throw new Error(`provider_prompt_integrity_mismatch: ${prompt.relative_path}`);
        }
      }
      if (!validateAttachments) continue;

      for (let index = 0; index < custody.visible_attachments.length; index += 1) {
        const attachment = custody.visible_attachments[index];
        if (!attachment) continue;
        const evidence = (meta.evidence_files ?? []).find(
          (candidate) => candidate.path === attachment.relative_path,
        );
        if (!evidence) {
          throw new Error(
            `peer attachment custody ${index} is not a persisted evidence file: peer=${peer.peer}`,
          );
        }
        const authenticated = this.readContainedRegularFile(
          sessionId,
          attachment.relative_path,
          "evidence_integrity",
        );
        const expected = currentEvidenceAttachment(evidence);
        if (
          attachment.sha256 !== authenticated.sha256 ||
          (expected !== undefined &&
            (expected.sha256 !== authenticated.sha256 || expected.bytes !== authenticated.bytes))
        ) {
          throw new Error(
            `peer attachment custody ${index} does not match persisted evidence: peer=${peer.peer}`,
          );
        }
        if (
          !dispatchVisibilityIsValid(
            attachment.visible_utf16_units,
            authenticated.content.length,
            attachment.truncated,
          )
        ) {
          throw new Error(
            `peer attachment custody ${index} visibility is invalid: peer=${peer.peer}`,
          );
        }
      }
    }
  }

  async saveGeneration(
    sessionId: string,
    round: number,
    result: GenerationResult,
    label = "generation",
    pendingReservationId?: string,
    options: { defer_circular_promotion?: boolean } = {},
  ): Promise<string> {
    const baseFile = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    const file = fs.existsSync(baseFile)
      ? baseFile.replace(/\.json$/, `-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
      : baseFile;
    await writeJson(file, { ...result, text: redact(result.text) });
    const relativePath = path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
    const authenticatedArtifact = this.readContainedRegularFile(
      sessionId,
      relativePath,
      "provider_result",
    );
    await this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // Cancellation may settle while the provider call is returning. The
      // terminal meta/report already contain the conservative unknown attempt;
      // keep them immutable and leave this raw artifact orphaned for forensics.
      if (meta.outcome) {
        const err = new Error(
          `post_terminal_generation_settlement: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
        );
        (err as Error & { code?: string }).code = "post_terminal_generation_settlement";
        throw err;
      }
      // A provider result is not authorized merely because its JSON bytes are
      // durable. Reauthenticate the exact redacted prompt descriptor against
      // the session ledger while holding the same lock that settles the paid
      // call. This applies to generation round zero as well as later rounds;
      // provider_prompt_custody_start_round governs peer-review rounds, not
      // whether a generation dispatch may omit its prompt.
      const pendingReservation = pendingReservationId
        ? (meta.pending_provider_call_reservations ?? []).find(
            (candidate) => candidate.id === pendingReservationId,
          )
        : undefined;
      this.assertGenerationProviderPromptIntegrity(
        sessionId,
        meta,
        result,
        round,
        pendingReservation?.label ?? label,
        pendingReservation?.call_kind ?? "generation",
      );
      this.assertPendingProviderPromptIntegrity(
        sessionId,
        meta,
        pendingReservationId,
        result.peer,
        round,
      );
      if (options.defer_circular_promotion) {
        const marker = meta.generation_in_flight;
        if (
          meta.mode !== "circular" ||
          !marker ||
          marker.peer !== result.peer ||
          marker.round !== round ||
          marker.label !== label
        ) {
          throw new Error(
            `circular_generation_promotion_marker_mismatch: ${result.peer}/round-${round}/${label}`,
          );
        }
        marker.settled_result_path = relativePath;
        marker.settled_result_sha256 = authenticatedArtifact.sha256;
        marker.settled_result_bytes = authenticatedArtifact.bytes;
        marker.settled_result_usage = result.usage;
        marker.settled_result_cost = result.cost;
        marker.settled_result_latency_ms = result.latency_ms;
        marker.settled_result_attempts = result.attempts;
        marker.settled_result_unpriced_attempts = result.unpriced_attempts;
        marker.settled_result_indeterminate_spend_attempts = result.indeterminate_spend_attempts;
        this.consumePendingProviderCallReservation(meta, pendingReservationId, result.peer, round);
        meta.totals = this.totalsFor(meta);
        meta.updated_at = now();
        await writeJson(this.metaPath(sessionId), meta);
        return;
      }
      // The exact provider prompt remains authorization material until the
      // paid result settles. Reauthenticate it while holding the same session
      // lock that will ledger the result and consume its dispatch reservation;
      // otherwise a prompt changed after dispatch could still authorize a
      // judge result and a later checklist promotion.
      const artifact: GenerationArtifact = {
        ts: now(),
        round,
        label,
        peer: result.peer,
        path: relativePath,
        sha256: authenticatedArtifact.sha256,
        bytes: authenticatedArtifact.bytes,
        usage: result.usage,
        cost: result.cost,
        latency_ms: result.latency_ms,
        unpriced_attempts: result.unpriced_attempts,
        indeterminate_spend_attempts: result.indeterminate_spend_attempts,
      };
      meta.generation_files = [...(meta.generation_files ?? []), artifact];
      this.consumePendingProviderCallReservation(meta, pendingReservationId, result.peer, round);
      // The result and marker settlement share one meta.json replacement: a
      // crash can leave the marker (fail closed) or the accounted result, but
      // never clear the marker while losing the result.
      this.settleBackgroundGenerationMarker(meta, result.peer, round);
      meta.totals = this.totalsFor(meta);
      if (round > 0 && round <= (meta.costs_per_round?.length ?? 0)) {
        const costs = [...(meta.costs_per_round ?? [])];
        costs[round - 1] = (costs[round - 1] ?? 0) + (result.cost?.total_cost ?? 0);
        meta.costs_per_round = costs;
      }
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
    });
    return relativePath;
  }

  readStagedCircularGeneration(
    sessionId: string,
    round: number,
    peer: PeerId,
    label?: CircularGenerationLabel,
  ): GenerationResult | undefined {
    const meta = this.read(sessionId);
    const marker = meta.generation_in_flight;
    if (
      meta.mode !== "circular" ||
      !marker?.settled_result_path ||
      marker.peer !== peer ||
      marker.round !== round ||
      (label !== undefined && marker.label !== label)
    ) {
      return undefined;
    }
    return this.authenticateStagedCircularGeneration(sessionId, meta, {
      round,
      peer,
      label: label ?? (marker.label as CircularGenerationLabel),
    }).parsed;
  }

  private authenticateStagedCircularGeneration(
    sessionId: string,
    meta: SessionMeta,
    expected: CircularGenerationExpectation,
  ): {
    marker: BackgroundGenerationInFlight;
    authenticated: ReturnType<SessionStore["readContainedRegularFile"]>;
    parsed: GenerationResult;
  } {
    const marker = meta.generation_in_flight;
    if (
      meta.mode !== "circular" ||
      !marker?.settled_result_path ||
      marker.peer !== expected.peer ||
      marker.round !== expected.round ||
      marker.label !== expected.label
    ) {
      throw new Error(
        `circular_generation_staged_result_required: ${expected.peer}/round-${expected.round}/${expected.label}`,
      );
    }
    const authenticated = this.readContainedRegularFile(
      sessionId,
      marker.settled_result_path,
      "provider_result",
    );
    if (
      authenticated.sha256 !== marker.settled_result_sha256 ||
      authenticated.bytes !== marker.settled_result_bytes
    ) {
      throw new Error(
        `provider_result_integrity_mismatch: ${marker.settled_result_path} expected sha256=${marker.settled_result_sha256} bytes=${marker.settled_result_bytes}, got sha256=${authenticated.sha256} bytes=${authenticated.bytes}`,
      );
    }
    let parsed: GenerationResult;
    try {
      parsed = JSON.parse(authenticated.content) as GenerationResult;
    } catch (error) {
      throw new Error(`provider_result_invalid_json: ${marker.settled_result_path}`, {
        cause: error,
      });
    }
    if (
      parsed.peer !== expected.peer ||
      parsed.provider !== marker.provider ||
      parsed.model !== marker.model
    ) {
      throw new Error(`provider_result_identity_mismatch: ${marker.settled_result_path}`);
    }
    this.assertGenerationProviderPromptIntegrity(
      sessionId,
      meta,
      parsed,
      expected.round,
      expected.label,
      "generation",
    );
    return { marker, authenticated, parsed };
  }

  /**
   * Move one already-settled circular result from the transient marker into
   * the exact generation ledger without writing meta.json. The caller owns the
   * session lock and commits this mutation together with its state transition.
   */
  private promoteSettledCircularGenerationForAccounting(
    sessionId: string,
    meta: SessionMeta,
    expected?: CircularGenerationExpectation,
  ):
    | {
        marker: BackgroundGenerationInFlight;
        authenticated: ReturnType<SessionStore["readContainedRegularFile"]>;
        parsed: GenerationResult;
      }
    | undefined {
    const pending = meta.generation_in_flight;
    if (meta.mode !== "circular" || !pending?.settled_result_path) return undefined;
    if (pending.label !== "initial-draft" && pending.label !== "rotation") {
      throw new Error(`circular_generation_label_invalid: ${pending.label}`);
    }
    const authenticatedStage = this.authenticateStagedCircularGeneration(
      sessionId,
      meta,
      expected ?? {
        round: pending.round,
        peer: pending.peer,
        label: pending.label,
      },
    );
    const { marker, authenticated } = authenticatedStage;
    const settledResultPath = marker.settled_result_path;
    if (!settledResultPath) {
      throw new Error("circular_generation_staged_result_required");
    }
    if ((meta.generation_files ?? []).some((artifact) => artifact.path === settledResultPath)) {
      throw new Error(`circular_generation_artifact_already_promoted: ${settledResultPath}`);
    }
    const artifact: GenerationArtifact = {
      ts: now(),
      round: marker.round,
      label: marker.label,
      peer: marker.peer,
      path: settledResultPath,
      sha256: authenticated.sha256,
      bytes: authenticated.bytes,
      usage: marker.settled_result_usage,
      cost: marker.settled_result_cost,
      latency_ms: marker.settled_result_latency_ms,
      unpriced_attempts: marker.settled_result_unpriced_attempts,
      indeterminate_spend_attempts: marker.settled_result_indeterminate_spend_attempts,
    };
    meta.generation_files = [...(meta.generation_files ?? []), artifact];
    delete meta.generation_in_flight;
    meta.totals = this.totalsFor(meta);
    return authenticatedStage;
  }

  /** Reauthenticate the exact provider-result bytes owned by an accepted
   * circular round. The round peer remains the sole usage/cost ledger entry. */
  private readRoundProviderResult(
    sessionId: string,
    meta: SessionMeta,
    round: ReviewRound,
  ): GenerationResult {
    const custody = round.provider_result;
    const peer = round.peers[0];
    if (round.review_kind !== "circular_revision" || !custody || !peer) {
      throw new Error(`circular_round_provider_result_required: round-${round.round}`);
    }
    const authenticated = this.readContainedRegularFile(
      sessionId,
      custody.relative_path,
      "provider_result",
    );
    if (authenticated.sha256 !== custody.sha256 || authenticated.bytes !== custody.bytes) {
      throw new Error(
        `provider_result_integrity_mismatch: ${custody.relative_path} expected sha256=${custody.sha256} bytes=${custody.bytes}, got sha256=${authenticated.sha256} bytes=${authenticated.bytes}`,
      );
    }
    let parsed: GenerationResult;
    try {
      parsed = JSON.parse(authenticated.content) as GenerationResult;
    } catch (error) {
      throw new Error(`provider_result_invalid_json: ${custody.relative_path}`, { cause: error });
    }
    if (
      parsed.peer !== peer.peer ||
      parsed.provider !== peer.provider ||
      parsed.model !== peer.model ||
      parsed.text !== peer.text
    ) {
      throw new Error(`provider_result_identity_mismatch: ${custody.relative_path}`);
    }
    this.assertGenerationProviderPromptIntegrity(
      sessionId,
      meta,
      parsed,
      round.round,
      "rotation",
      "generation",
    );
    return parsed;
  }

  /**
   * Authenticate and return the exact canonical redacted round-zero result
   * accepted by the circular state machine. The generation ledger and the
   * state descriptor must independently identify the same persisted bytes.
   */
  readAcceptedCircularInitialDraft(sessionId: string): GenerationResult | undefined {
    const meta = this.read(sessionId);
    const custody = meta.circular_state?.initial_draft_custody;
    if (!custody) return undefined;
    if (meta.mode !== "circular") {
      throw new Error("circular_initial_draft_custody_requires_circular_mode");
    }
    const matchingArtifacts = (meta.generation_files ?? []).filter(
      (artifact) =>
        artifact.round === 0 &&
        artifact.label === "initial-draft" &&
        artifact.peer === custody.peer &&
        artifact.path === custody.relative_path &&
        artifact.sha256 === custody.sha256 &&
        artifact.bytes === custody.bytes,
    );
    if (matchingArtifacts.length !== 1) {
      throw new Error(
        `circular_initial_draft_ledger_mismatch: ${custody.relative_path} has ${matchingArtifacts.length} authenticated ledger entries`,
      );
    }
    const authenticated = this.readContainedRegularFile(
      sessionId,
      custody.relative_path,
      "provider_result",
    );
    if (authenticated.sha256 !== custody.sha256 || authenticated.bytes !== custody.bytes) {
      throw new Error(
        `provider_result_integrity_mismatch: ${custody.relative_path} expected sha256=${custody.sha256} bytes=${custody.bytes}, got sha256=${authenticated.sha256} bytes=${authenticated.bytes}`,
      );
    }
    let parsed: GenerationResult;
    try {
      parsed = JSON.parse(authenticated.content) as GenerationResult;
    } catch (error) {
      throw new Error(`provider_result_invalid_json: ${custody.relative_path}`, { cause: error });
    }
    if (
      parsed.peer !== custody.peer ||
      parsed.provider !== custody.provider ||
      parsed.model !== custody.model
    ) {
      throw new Error(`provider_result_identity_mismatch: ${custody.relative_path}`);
    }
    return parsed;
  }

  /**
   * Commit the one durable disposition of a settled circular generation.
   *
   * The provider-result descriptor, financial ledger, circular cursor, marker
   * removal and (when requested) terminal outcome share one locked meta.json
   * replacement. Therefore a crash can expose the staged marker or the complete
   * disposition, never an unaccounted result or a terminal session that still
   * owns a settled provider marker.
   */
  async commitCircularGenerationDisposition(
    sessionId: string,
    params: {
      expected: CircularGenerationExpectation;
      circular_state: NonNullable<SessionMeta["circular_state"]>;
      disposition: CircularGenerationDisposition;
    },
  ): Promise<SessionMeta> {
    // A terminal disposition must follow all events that preceded its durable
    // outcome. Flush unconditionally because a cancellation request may win the
    // same lock even when the caller proposed a non-terminal disposition.
    await this.flushPendingEvents();
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        if (
          params.disposition.kind === "reject_terminal" &&
          meta.outcome === params.disposition.outcome &&
          meta.outcome_reason === params.disposition.reason
        ) {
          return meta;
        }
        throw new Error(
          `session_already_finalized: cannot dispose circular generation for ${sessionId} with outcome=${meta.outcome}`,
        );
      }
      const promotedGeneration = this.promoteSettledCircularGenerationForAccounting(
        sessionId,
        meta,
        params.expected,
      );
      if (!promotedGeneration) {
        throw new Error("circular_generation_staged_result_required");
      }
      const { marker, authenticated } = promotedGeneration;
      const settledResultPath = marker.settled_result_path;
      if (!settledResultPath) {
        throw new Error("circular_generation_staged_result_required");
      }
      const state = params.circular_state;
      if (
        state.rotation_order.length < 2 ||
        !Number.isSafeInteger(state.next_cursor) ||
        (state.next_cursor as number) < 0 ||
        (state.next_cursor as number) >= state.rotation_order.length
      ) {
        throw new Error("circular_generation_disposition_next_cursor_invalid");
      }
      if (
        meta.circular_state &&
        (meta.circular_state.rotation_order.length !== state.rotation_order.length ||
          !meta.circular_state.rotation_order.every(
            (peer, index) => peer === state.rotation_order[index],
          ))
      ) {
        throw new Error("circular_generation_disposition_rotation_mismatch");
      }
      if (
        (params.expected.label === "initial-draft" && params.expected.round !== 0) ||
        (params.expected.label === "rotation" && params.expected.round !== meta.rounds.length + 1)
      ) {
        throw new Error("circular_generation_disposition_round_mismatch");
      }
      const initialDraftCustody =
        params.disposition.kind === "accept_initial"
          ? {
              relative_path: settledResultPath,
              sha256: authenticated.sha256,
              bytes: authenticated.bytes,
              peer: marker.peer,
              provider: marker.provider,
              model: marker.model,
            }
          : meta.circular_state?.initial_draft_custody;
      meta.circular_state = {
        ...state,
        ...(initialDraftCustody ? { initial_draft_custody: initialDraftCustody } : {}),
      };
      // Cancellation is authoritative and shares this same metadata commit.
      // The settled result was promoted above, so cancellation must not invent
      // an unknown provider attempt for it.
      if (meta.control?.status === "cancel_requested") {
        return this.persistCancelledTerminal(meta, "session_cancelled");
      }

      const transitionedAt = now();
      if (params.disposition.kind === "reject_terminal") {
        delete meta.control;
        meta.outcome = params.disposition.outcome;
        meta.outcome_reason = params.disposition.reason;
        meta.convergence_health = transitionHealth(
          meta,
          params.disposition.outcome === "max-rounds" ? "blocked" : "aborted",
          params.disposition.reason,
          transitionedAt,
        );
      }
      meta.updated_at = transitionedAt;
      if (meta.control) meta.control.updated_at = transitionedAt;
      const shapeError = sessionMetaShapeError(meta);
      if (shapeError) throw new Error(`schema_validation_failed: ${shapeError}`);
      await writeJson(this.metaPath(sessionId), meta);

      if (params.disposition.kind === "reject_terminal") {
        try {
          await this.appendEventRecord({
            type: "session.finalized",
            session_id: sessionId,
            ts: transitionedAt,
            message: `Session finalized as ${params.disposition.outcome}: ${params.disposition.reason}`,
            data: {
              outcome: params.disposition.outcome,
              reason: params.disposition.reason,
            },
          });
        } catch {
          /* event persistence is best-effort; session_doctor will flag gaps */
        }
        try {
          this.saveReport(sessionId, this.renderSessionReport(meta, this.readEvents(sessionId)));
        } catch {
          /* report regeneration is best-effort; meta.json remains authoritative */
        }
      }
      return meta;
    });
  }

  /**
   * Atomically accounts for a settled circular provider result that the
   * orchestrator rejected before it could become a review round. The raw
   * provider artifact remains in the financial/forensic ledger, while the
   * accepted draft and rounds stay unchanged and custody advances to the next
   * rotator in the same meta.json replacement.
   */
  async promoteRejectedCircularGeneration(
    sessionId: string,
    circularState: NonNullable<SessionMeta["circular_state"]>,
  ): Promise<SessionMeta> {
    const meta = this.read(sessionId);
    const marker = meta.generation_in_flight;
    if (
      meta.mode !== "circular" ||
      !marker?.settled_result_path ||
      marker.label !== "rotation" ||
      marker.round !== meta.rounds.length + 1
    ) {
      throw new Error("circular_rejected_generation_staged_result_required");
    }
    return this.commitCircularGenerationDisposition(sessionId, {
      expected: { round: marker.round, peer: marker.peer, label: "rotation" },
      circular_state: circularState,
      disposition: { kind: "reject_continue" },
    });
  }

  saveFinal(sessionId: string, text: string): string {
    return this.saveAuthenticatedFinal(sessionId, redact(text));
  }

  private saveAuthenticatedFinal(sessionId: string, content: string): string {
    const file = path.join(this.sessionDir(sessionId), "final.md");
    writeTextAtomically(file, content);
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveFinalFromReviewedRound(sessionId: string, round: ReviewRound): string {
    const reviewedArtifact = this.readRoundReviewedArtifact(sessionId, round);
    return this.saveAuthenticatedFinal(sessionId, reviewedArtifact.content);
  }

  private assertFinalMirrorMatches(
    sessionId: string,
    reviewedArtifact: PersistedReviewedArtifact,
  ): void {
    const relativePath = "final.md";
    const sessionDir = this.sessionDir(sessionId);
    const candidate = path.join(sessionDir, relativePath);
    let candidateStat: fs.BigIntStats;
    try {
      candidateStat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw new Error("reviewed_artifact_final_mirror_unavailable: final.md", { cause: error });
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new Error("reviewed_artifact_final_mirror_not_regular_file: final.md");
    }
    const absolutePath = this.safeResolveContainedExistingPath(sessionDir, relativePath);
    if (!absolutePath) {
      throw new Error("reviewed_artifact_final_mirror_not_contained: final.md");
    }

    let persisted: Buffer;
    const descriptor = fs.openSync(absolutePath, "r");
    try {
      const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
      if (
        !descriptorStat.isFile() ||
        descriptorStat.dev !== candidateStat.dev ||
        descriptorStat.ino !== candidateStat.ino
      ) {
        throw new Error("reviewed_artifact_final_mirror_identity_mismatch: final.md");
      }
      persisted = fs.readFileSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const expected = Buffer.from(reviewedArtifact.content, "utf8");
    if (!persisted.equals(expected)) {
      throw new Error(
        `reviewed_artifact_final_mirror_integrity_mismatch: final.md expected sha256=${reviewedArtifact.sha256} bytes=${reviewedArtifact.bytes}`,
      );
    }
  }

  saveReport(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "session-report.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  reviewedArtifactCustodyReportStatus(session: SessionMeta): ReviewedArtifactCustodyReportStatus {
    const failures: string[] = [];
    for (const prompt of session.provider_prompt_files ?? []) {
      try {
        const authenticated = this.readContainedRegularFile(
          session.session_id,
          prompt.relative_path,
          "provider_prompt",
        );
        if (
          authenticated.sha256 !== prompt.sha256 ||
          authenticated.bytes !== prompt.bytes ||
          authenticated.content.length !== prompt.utf16_units
        ) {
          throw new Error(`provider_prompt_integrity_mismatch: ${prompt.relative_path}`);
        }
      } catch (error) {
        failures.push(`provider prompt ${prompt.relative_path}: ${safeErrorMessage(error)}`);
      }
    }
    const providerResultRounds = session.rounds.filter(
      (round) => round.review_kind === "circular_revision",
    );
    for (const round of providerResultRounds) {
      try {
        this.readRoundProviderResult(session.session_id, session, round);
      } catch (error) {
        failures.push(`round ${round.round} provider result: ${safeErrorMessage(error)}`);
      }
    }
    const governedRounds = session.rounds.filter(
      (round) =>
        (round.review_kind === "reviewed_artifact" ||
          (round.review_kind === undefined && round.draft_file !== undefined)) &&
        round.draft_file !== undefined &&
        (this.roundRequiresReviewedArtifactCustody(session, round) || round.reviewed_artifact),
    );
    if (governedRounds.length === 0) {
      return {
        status:
          failures.length > 0
            ? "FAILED"
            : (session.provider_prompt_files?.length ?? 0) > 0
              ? "verified"
              : providerResultRounds.length > 0
                ? "verified"
                : session.reviewed_artifact_custody_schema_version === 1
                  ? "not_checked"
                  : "legacy_unset",
        failures,
      };
    }
    const authenticatedRounds = new Map<number, PersistedReviewedArtifact>();
    for (const round of governedRounds) {
      try {
        const authenticated = this.readRoundReviewedArtifact(session.session_id, round);
        this.assertPeerReviewDispatchVisibility(
          session.session_id,
          session,
          round.peers,
          authenticated,
          true,
        );
        authenticatedRounds.set(round.round, authenticated);
      } catch (error) {
        failures.push(`round ${round.round}: ${safeErrorMessage(error)}`);
      }
    }
    if (session.outcome === "converged") {
      const latestRound = session.rounds.at(-1);
      const authenticated = latestRound ? authenticatedRounds.get(latestRound.round) : undefined;
      if (authenticated) {
        try {
          this.assertFinalMirrorMatches(session.session_id, authenticated);
        } catch (error) {
          failures.push(`final mirror: ${safeErrorMessage(error)}`);
        }
      }
    }
    return { status: failures.length > 0 ? "FAILED" : "verified", failures };
  }

  renderSessionReport(session: SessionMeta, events: SessionEvent[] = []): string {
    return sessionReportMarkdown(
      session,
      events,
      this.reviewedArtifactCustodyReportStatus(session),
    );
  }

  async savePeerResult(
    sessionId: string,
    round: number,
    result: PeerResult,
    label = "response",
  ): Promise<string> {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    await writeJson(file, { ...result, text: redact(result.text) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async savePeerFailure(
    sessionId: string,
    round: number,
    failure: PeerFailure,
    label = "failure",
  ): Promise<string> {
    const baseFile = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${failure.peer}-${label}.json`,
    );
    const file = fs.existsSync(baseFile)
      ? baseFile.replace(/\.json$/, `-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
      : baseFile;
    await writeJson(file, { ...failure, message: redact(failure.message) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async reserveInFlightProviderCall(
    sessionId: string,
    round: number,
    params: Omit<ProviderCallReservation, "id" | "started_at" | "owner_pid">,
  ): Promise<string> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const error = new Error(
          `post_terminal_provider_reservation: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
        );
        (error as Error & { code?: string }).code = "post_terminal_provider_reservation";
        throw error;
      }
      const inFlight = meta.in_flight;
      if (!inFlight || inFlight.round !== round || !inFlight.peers.includes(params.peer)) {
        const error = new Error(
          `provider_reservation_without_matching_in_flight: ${params.peer}/round-${round}`,
        );
        (error as Error & { code?: string }).code =
          "provider_reservation_without_matching_in_flight";
        throw error;
      }
      const reservation: ProviderCallReservation = {
        id: crypto.randomUUID(),
        ...params,
        started_at: now(),
        owner_pid: process.pid,
      };
      inFlight.provider_call_reservations = [
        ...(inFlight.provider_call_reservations ?? []),
        reservation,
      ];
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return reservation.id;
    });
  }

  async reservePendingProviderCall(
    sessionId: string,
    params: Omit<PendingProviderCallReservation, "id" | "started_at" | "owner_pid">,
  ): Promise<string> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const error = new Error(
          `post_terminal_provider_reservation: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
        );
        (error as Error & { code?: string }).code = "post_terminal_provider_reservation";
        throw error;
      }
      if (meta.control?.status === "cancel_requested") {
        const error = new Error(
          `provider_reservation_cancelled: refusing to dispatch ${params.call_kind}/${params.label} after cancellation was requested`,
        );
        (error as Error & { code?: string }).code = "provider_reservation_cancelled";
        throw error;
      }
      if (
        meta.provider_prompt_custody_schema_version === 1 &&
        params.round >= (meta.provider_prompt_custody_start_round ?? 1)
      ) {
        const error = new Error(
          `provider_prompt_custody_required: use preparePendingProviderPromptCall for ${params.call_kind}/${params.label}`,
        );
        (error as Error & { code?: string }).code = "provider_prompt_custody_required";
        throw error;
      }
      const reservation: PendingProviderCallReservation = {
        id: crypto.randomUUID(),
        ...params,
        started_at: now(),
        owner_pid: process.pid,
      };
      meta.pending_provider_call_reservations = [
        ...(meta.pending_provider_call_reservations ?? []),
        reservation,
      ];
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return reservation.id;
    });
  }

  private assertPendingProviderPromptIntegrity(
    sessionId: string,
    meta: SessionMeta,
    reservationId: string | undefined,
    peer: PeerId,
    round: number,
  ): void {
    if (reservationId === undefined) return;
    const reservation = (meta.pending_provider_call_reservations ?? []).find(
      (candidate) => candidate.id === reservationId,
    );
    if (!reservation || reservation.peer !== peer || reservation.round !== round) {
      const error = new Error(
        `provider_settlement_without_matching_pending_reservation: ${peer}/round-${round}/${reservationId}`,
      );
      (error as Error & { code?: string }).code =
        "provider_settlement_without_matching_pending_reservation";
      throw error;
    }

    const prompt = reservation.provider_prompt;
    const custodyRequired =
      meta.provider_prompt_custody_schema_version === 1 &&
      round >= (meta.provider_prompt_custody_start_round ?? 1);
    if (!prompt) {
      if (custodyRequired) {
        const error = new Error(
          `provider_prompt_custody_required: ${reservation.call_kind}/${reservation.label}`,
        );
        (error as Error & { code?: string }).code = "provider_prompt_custody_required";
        throw error;
      }
      return;
    }

    this.assertProviderPromptCustodyIntegrity(sessionId, meta, prompt, {
      round: reservation.round,
      peer: reservation.peer,
      provider: reservation.provider,
      model: reservation.model,
      call_kind: reservation.call_kind,
      label: reservation.label,
    });
  }

  private assertGenerationProviderPromptIntegrity(
    sessionId: string,
    meta: SessionMeta,
    result: GenerationResult,
    round: number,
    label: string,
    callKind: ProviderPromptArtifact["call_kind"],
  ): void {
    const prompt = result.provider_prompt;
    if (!prompt) {
      if (meta.provider_prompt_custody_schema_version === 1) {
        const error = new Error(`provider_prompt_custody_required: ${callKind}/${label}`);
        (error as Error & { code?: string }).code = "provider_prompt_custody_required";
        throw error;
      }
      return;
    }
    this.assertProviderPromptCustodyIntegrity(sessionId, meta, prompt, {
      round,
      peer: result.peer,
      provider: result.provider,
      model: result.model,
      call_kind: callKind,
      label,
    });
  }

  private assertProviderPromptCustodyIntegrity(
    sessionId: string,
    meta: SessionMeta,
    prompt: ProviderPromptCustody,
    expected: Pick<
      ProviderPromptArtifact,
      "round" | "peer" | "provider" | "model" | "call_kind" | "label"
    >,
  ): void {
    const ledger = (meta.provider_prompt_files ?? []).find(
      (candidate) =>
        candidate.relative_path === prompt.relative_path &&
        candidate.round === expected.round &&
        candidate.peer === expected.peer &&
        candidate.provider === expected.provider &&
        candidate.model === expected.model &&
        candidate.call_kind === expected.call_kind &&
        candidate.label === expected.label,
    );
    if (
      !ledger ||
      ledger.sha256 !== prompt.sha256 ||
      ledger.bytes !== prompt.bytes ||
      ledger.utf16_units !== prompt.utf16_units ||
      prompt.reconstructible !== true ||
      prompt.redacted !== true
    ) {
      const error = new Error(
        `provider_prompt_custody_ledger_mismatch: ${expected.call_kind}/${expected.label}`,
      );
      (error as Error & { code?: string }).code = "provider_prompt_custody_ledger_mismatch";
      throw error;
    }

    const authenticated = this.readContainedRegularFile(
      sessionId,
      prompt.relative_path,
      "provider_prompt",
    );
    if (
      authenticated.sha256 !== prompt.sha256 ||
      authenticated.bytes !== prompt.bytes ||
      authenticated.content.length !== prompt.utf16_units
    ) {
      const error = new Error(`provider_prompt_integrity_mismatch: ${prompt.relative_path}`);
      (error as Error & { code?: string }).code = "provider_prompt_integrity_mismatch";
      throw error;
    }
  }

  private consumePendingProviderCallReservation(
    meta: SessionMeta,
    reservationId: string | undefined,
    peer: PeerId,
    round: number,
  ): void {
    if (reservationId === undefined) return;
    const reservation = (meta.pending_provider_call_reservations ?? []).find(
      (candidate) => candidate.id === reservationId,
    );
    if (!reservation || reservation.peer !== peer || reservation.round !== round) {
      const error = new Error(
        `provider_settlement_without_matching_pending_reservation: ${peer}/round-${round}/${reservationId}`,
      );
      (error as Error & { code?: string }).code =
        "provider_settlement_without_matching_pending_reservation";
      throw error;
    }
    meta.pending_provider_call_reservations = (
      meta.pending_provider_call_reservations ?? []
    ).filter((candidate) => candidate.id !== reservationId);
  }

  private async recordInFlightProviderSettlement(
    sessionId: string,
    settlement: ProviderCallSettlement,
    reservationId?: string,
  ): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const error = new Error(
          `post_terminal_provider_settlement: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
        );
        (error as Error & { code?: string }).code = "post_terminal_provider_settlement";
        throw error;
      }
      const inFlight = meta.in_flight;
      if (
        !inFlight ||
        inFlight.round !== settlement.round ||
        !inFlight.peers.includes(settlement.peer)
      ) {
        const error = new Error(
          `provider_settlement_without_matching_in_flight: ${settlement.peer}/round-${settlement.round}`,
        );
        (error as Error & { code?: string }).code =
          "provider_settlement_without_matching_in_flight";
        throw error;
      }
      if (reservationId !== undefined) {
        const reservation = (inFlight.provider_call_reservations ?? []).find(
          (candidate) => candidate.id === reservationId,
        );
        if (!reservation || reservation.peer !== settlement.peer) {
          const error = new Error(
            `provider_settlement_without_matching_reservation: ${settlement.peer}/round-${settlement.round}/${reservationId}`,
          );
          (error as Error & { code?: string }).code =
            "provider_settlement_without_matching_reservation";
          throw error;
        }
        settlement.reservation_id = reservationId;
        inFlight.provider_call_reservations = (inFlight.provider_call_reservations ?? []).filter(
          (candidate) => candidate.id !== reservationId,
        );
      }
      inFlight.provider_settlements = [
        ...(inFlight.provider_settlements ?? []).filter(
          (existing) => existing.artifact_path !== settlement.artifact_path,
        ),
        settlement,
      ];
      meta.totals = this.totalsFor(meta);
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
    });
  }

  async saveInFlightPeerResult(
    sessionId: string,
    round: number,
    result: PeerResult,
    label = "provider-response",
    reservationId?: string,
  ): Promise<string> {
    const artifactPath = await this.savePeerResult(sessionId, round, result, label);
    await this.recordInFlightProviderSettlement(
      sessionId,
      {
        round,
        peer: result.peer,
        provider: result.provider,
        model: result.model,
        kind: "result",
        artifact_path: artifactPath,
        settled_at: now(),
        status: result.status,
        usage: result.usage,
        cost: result.cost,
        attempts: result.attempts,
        latency_ms: result.latency_ms,
        billing_status:
          (result.unpriced_attempts ?? 0) > 0
            ? "unknown"
            : result.cost?.total_cost != null
              ? "reported"
              : result.attempts > 0
                ? "unknown"
                : undefined,
        unpriced_attempts: result.unpriced_attempts,
        indeterminate_spend_attempts: result.indeterminate_spend_attempts,
      },
      reservationId,
    );
    return artifactPath;
  }

  async saveInFlightPeerFailure(
    sessionId: string,
    round: number,
    failure: PeerFailure,
    label = "provider-failure",
    reservationId?: string,
  ): Promise<string> {
    const artifactPath = await this.savePeerFailure(sessionId, round, failure, label);
    await this.recordInFlightProviderSettlement(
      sessionId,
      {
        round,
        peer: failure.peer,
        provider: failure.provider,
        model: failure.model ?? this.config.models[failure.peer],
        kind: "failure",
        artifact_path: artifactPath,
        settled_at: now(),
        usage: failure.usage,
        cost: failure.cost,
        attempts: failure.attempts,
        latency_ms: failure.latency_ms,
        billing_status:
          (failure.unpriced_attempts ?? 0) > 0
            ? "unknown"
            : (failure.billing_status ??
              (failure.cost?.total_cost != null
                ? "reported"
                : failure.attempts > 0
                  ? "unknown"
                  : undefined)),
        unpriced_attempts: failure.unpriced_attempts,
        indeterminate_spend_attempts: failure.indeterminate_spend_attempts,
      },
      reservationId,
    );
    return artifactPath;
  }

  async recordPeerFailureAccounting(
    sessionId: string,
    round: number,
    failure: PeerFailure,
    label = "failure",
    pendingReservationId?: string,
  ): Promise<string> {
    const artifact = await this.savePeerFailure(sessionId, round, failure, label);
    await this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // Same late-settlement rule as saveGeneration: terminal accounting is
      // sealed and must not be rewritten by a provider result that lost the
      // cancellation race.
      if (meta.outcome) {
        const err = new Error(
          `post_terminal_failure_settlement: refusing to mutate ${sessionId} after outcome=${meta.outcome}`,
        );
        (err as Error & { code?: string }).code = "post_terminal_failure_settlement";
        throw err;
      }
      meta.failed_attempts = [...(meta.failed_attempts ?? []), { ...failure, round }];
      this.consumePendingProviderCallReservation(meta, pendingReservationId, failure.peer, round);
      // Provider failure accounting and dispatch-marker settlement are one
      // durable transition for the same reason as successful generations.
      this.settleBackgroundGenerationMarker(meta, failure.peer, round);
      meta.totals = this.totalsFor(meta);
      if (round > 0 && round <= (meta.costs_per_round?.length ?? 0)) {
        const costs = [...(meta.costs_per_round ?? [])];
        costs[round - 1] = (costs[round - 1] ?? 0) + (failure.cost?.total_cost ?? 0);
        meta.costs_per_round = costs;
      }
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
    });
    return artifact;
  }

  async appendRound(
    sessionId: string,
    params: {
      caller_status: ReviewStatus;
      review_kind?: ReviewRoundKind | undefined;
      draft_file?: string | undefined;
      reviewed_artifact?: PersistedReviewedArtifact | undefined;
      prompt_file: string;
      peers: PeerResult[];
      rejected: PeerFailure[];
      // Provider-unavailability failures can be excluded from convergence
      // (`skipped`) without disappearing from the financial ledger. They
      // remain absent from ReviewRound.rejected but are persisted atomically
      // with the round in failed_attempts and costs_per_round.
      accounting_only_failures?: PeerFailure[] | undefined;
      convergence: ConvergenceResult;
      convergence_scope: ConvergenceScope;
      started_at: string;
      hold_in_flight_for_finalize?: boolean | undefined;
      circular_state?: NonNullable<SessionMeta["circular_state"]> | undefined;
      promote_staged_generation?: boolean | undefined;
    },
  ): Promise<ReviewRound> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // v3.2.0 (Codex bug report 2026-05-12): refuse to append a round
      // to a finalized session. Otherwise the per-round
      // `convergence_health` write below would clobber the converged
      // health set by `finalize()`, producing the contradictory
      // `outcome=converged / health=blocked` state observed in session
      // 41244a1c (R6 ran after a `session_finalize` call corrupted the
      // meta — but the orchestrator path can also produce this if any
      // post-finalize round mutator slips through).
      if (meta.outcome) {
        const err = new Error(
          `session_already_finalized: cannot append round to session ${sessionId} (outcome="${meta.outcome}")`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      let reviewedArtifactCustody: ReviewedArtifactCustody | undefined;
      let authenticatedReviewedArtifact: PersistedReviewedArtifact | undefined;
      let providerResultCustody: ProviderResultCustody | undefined;
      if (params.draft_file) {
        if (!params.reviewed_artifact) {
          if (meta.reviewed_artifact_custody_schema_version !== 1) {
            // A pre-custody session remains appendable by legacy tooling. Any
            // current runtime continuation supplies reviewed_artifact below
            // and upgrades the session marker permanently.
          } else {
            throw new Error(
              `reviewed_artifact_custody_required: ${params.draft_file} must include its authenticated path, sha256 and byte count`,
            );
          }
        } else if (params.draft_file !== params.reviewed_artifact.relative_path) {
          throw new Error(
            `reviewed_artifact_custody_required: ${params.draft_file} must include its authenticated path, sha256 and byte count`,
          );
        } else {
          const authenticated = this.revalidateReviewedArtifact(
            sessionId,
            params.reviewed_artifact,
          );
          authenticatedReviewedArtifact = authenticated;
          reviewedArtifactCustody = {
            artifact_kind: "reviewed_artifact",
            relative_path: authenticated.relative_path,
            sha256: authenticated.sha256,
            bytes: authenticated.bytes,
          };
          if (meta.reviewed_artifact_custody_schema_version !== 1) {
            meta.reviewed_artifact_custody_start_round = meta.rounds.length + 1;
          }
          meta.reviewed_artifact_custody_schema_version = 1;
        }
      } else if (params.reviewed_artifact) {
        throw new Error(
          "reviewed_artifact_custody_without_draft_file: custody metadata requires draft_file",
        );
      }
      const durableConvergence = blockConvergenceForUnresolvedEvidence(
        params.convergence,
        meta.evidence_checklist ?? [],
      );
      if (params.review_kind === "circular_revision") {
        if (meta.mode !== "circular" || !params.circular_state) {
          throw new Error("circular_round_requires_mode_and_atomic_state");
        }
        const state = params.circular_state;
        if (
          !Number.isSafeInteger(state.next_cursor) ||
          (state.next_cursor as number) < 0 ||
          (state.next_cursor as number) >= state.rotation_order.length
        ) {
          throw new Error("circular_round_next_cursor_invalid");
        }
        if (params.promote_staged_generation) {
          const marker = meta.generation_in_flight;
          const peer = params.peers[0];
          if (
            !marker?.settled_result_path ||
            marker.round !== meta.rounds.length + 1 ||
            marker.peer !== peer?.peer ||
            marker.label !== "rotation"
          ) {
            throw new Error("circular_round_staged_generation_required");
          }
          const staged = this.authenticateStagedCircularGeneration(sessionId, meta, {
            round: meta.rounds.length + 1,
            peer: peer.peer,
            label: "rotation",
          });
          const { authenticated, parsed } = staged;
          if (
            parsed.peer !== peer.peer ||
            parsed.provider !== peer.provider ||
            parsed.model !== peer.model ||
            parsed.text !== peer.text
          ) {
            throw new Error(`provider_result_identity_mismatch: ${marker.settled_result_path}`);
          }
          providerResultCustody = {
            artifact_kind: "provider_result",
            relative_path: marker.settled_result_path,
            sha256: authenticated.sha256,
            bytes: authenticated.bytes,
          };
        } else {
          throw new Error("circular_round_staged_generation_required");
        }
      }
      if (authenticatedReviewedArtifact) {
        this.assertPeerReviewDispatchVisibility(
          sessionId,
          meta,
          params.peers,
          authenticatedReviewedArtifact,
          true,
        );
      }
      if (durableConvergence.recovery_converged && authenticatedReviewedArtifact) {
        const currentPeerIds = new Set(params.peers.map((peer) => peer.peer));
        for (const peerId of durableConvergence.ready_peers) {
          if (currentPeerIds.has(peerId)) continue;
          const historicalRound = [...meta.rounds]
            .reverse()
            .find((round) => round.peers.some((peer) => peer.peer === peerId));
          const historicalPeer = historicalRound?.peers.find((peer) => peer.peer === peerId);
          if (!historicalRound || !historicalPeer) {
            throw new Error(`recovery_quorum_peer_custody_missing: peer=${peerId}`);
          }
          const historicalArtifact = this.readRoundReviewedArtifact(sessionId, historicalRound);
          if (
            historicalArtifact.sha256 !== authenticatedReviewedArtifact.sha256 ||
            historicalArtifact.bytes !== authenticatedReviewedArtifact.bytes
          ) {
            throw new Error(`recovery_quorum_artifact_mismatch: peer=${peerId}`);
          }
          this.assertPeerReviewDispatchVisibility(
            sessionId,
            meta,
            [historicalPeer],
            historicalArtifact,
            true,
          );
        }
      }
      const round: ReviewRound = {
        round: meta.rounds.length + 1,
        review_kind:
          params.review_kind ??
          (meta.reviewed_artifact_custody_schema_version === 1
            ? params.draft_file === undefined
              ? "pre_dispatch_block"
              : "reviewed_artifact"
            : undefined),
        started_at: params.started_at,
        completed_at: now(),
        caller_status: params.caller_status,
        draft_file: params.draft_file,
        reviewed_artifact: reviewedArtifactCustody,
        provider_result: providerResultCustody,
        prompt_file: params.prompt_file,
        peers: params.peers,
        rejected: params.rejected,
        convergence: durableConvergence,
      };
      meta.rounds.push(round);
      if (params.circular_state) {
        const initialDraftCustody =
          params.circular_state.initial_draft_custody ?? meta.circular_state?.initial_draft_custody;
        meta.circular_state = {
          ...params.circular_state,
          ...(initialDraftCustody ? { initial_draft_custody: initialDraftCustody } : {}),
        };
      }
      if (params.promote_staged_generation) delete meta.generation_in_flight;
      meta.failed_attempts = [
        ...(meta.failed_attempts ?? []),
        ...params.rejected.map((failure) => ({ ...failure, round: round.round })),
        ...(params.accounting_only_failures ?? []).map((failure) => ({
          ...failure,
          round: round.round,
        })),
      ];
      if (
        params.hold_in_flight_for_finalize === true &&
        durableConvergence.converged &&
        meta.in_flight?.round === round.round
      ) {
        // The broker mutation is committed with this round, but the round
        // reservation remains until finalize seals the terminal outcome. This
        // closes the append-to-finalize operator-update race without allowing
        // recovery to roll back an already appended round.
        delete meta.in_flight.evidence_broker_snapshot;
        // Provider settlements have now been promoted into round.peers /
        // failed_attempts. Retaining them in the reservation would double
        // count usage and cost until finalize clears in_flight.
        delete meta.in_flight.provider_settlements;
        delete meta.in_flight.provider_call_reservations;
        meta.in_flight.peers = [];
      } else {
        delete meta.in_flight;
      }
      meta.convergence_scope = params.convergence_scope;
      const transitionedAt = now();
      meta.convergence_health = transitionHealth(
        meta,
        durableConvergence.converged ? "converged" : "blocked",
        durableConvergence.reason,
        transitionedAt,
      );
      meta.updated_at = transitionedAt;
      meta.totals = this.totalsFor(meta);
      // v2.22.0 (B.P3): append per-round cost. Sum of peer.cost.total_cost
      // across this round's peers. Coerced to 0 when adapters didn't
      // surface a cost (stub paths, error rounds). Read AFTER totalsFor
      // so the new round's peer costs are already counted by the merger,
      // but we recompute the round-local sum independently to avoid
      // diff-based drift if a peer's cost changed in a retry loop.
      const roundCost =
        params.peers.reduce((sum, peer) => sum + (peer.cost?.total_cost ?? 0), 0) +
        params.rejected.reduce((sum, failure) => sum + (failure.cost?.total_cost ?? 0), 0) +
        (params.accounting_only_failures ?? []).reduce(
          (sum, failure) => sum + (failure.cost?.total_cost ?? 0),
          0,
        ) +
        (meta.generation_files ?? [])
          .filter((generation) => generation.round === round.round)
          .reduce((sum, generation) => sum + (generation.cost?.total_cost ?? 0), 0);
      meta.costs_per_round = [...(meta.costs_per_round ?? []), roundCost];
      const shapeError = sessionMetaShapeError(meta);
      if (shapeError) throw new Error(`schema_validation_failed: ${shapeError}`);
      await writeJson(this.metaPath(sessionId), meta);
      return round;
    });
  }

  async recordPreflightFailure(
    sessionId: string,
    failures: PeerFailure[],
    round = 0,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) return meta;
      meta.failed_attempts = [
        ...(meta.failed_attempts ?? []),
        ...failures.map((failure) => ({ ...failure, round })),
      ];
      const transitionedAt = now();
      meta.convergence_health = transitionHealth(
        meta,
        "blocked",
        failures[0]?.message ??
          "truthfulness_preflight blocked the session before a provider round started.",
        transitionedAt,
      );
      meta.updated_at = transitionedAt;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async recordPreflightCheck(
    sessionId: string,
    record: Omit<PreflightCheckRecord, "ts"> & { ts?: string | undefined },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) return meta;
      meta.preflight_checks = [
        ...(meta.preflight_checks ?? []),
        {
          ...record,
          ts: record.ts ?? now(),
        },
      ];
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.22.0 (B.P3): one-shot guard for `session.budget_warning` emit
  // idempotency. Persisted in meta.json so the warning fires at most
  // once per session even across host restarts.
  async markBudgetWarningEmitted(sessionId: string): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.budget_warning_emitted = true;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.25.0 (circular mode): atomically replace meta.circular_state. The
  // orchestrator's circular loop calls this every round so resumed
  // sessions can pick up the rotation cursor and consecutive-no-change
  // count from disk without re-deriving them by walking events.
  async setCircularState(
    sessionId: string,
    state: NonNullable<SessionMeta["circular_state"]>,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const initialDraftCustody =
        state.initial_draft_custody ?? meta.circular_state?.initial_draft_custody;
      meta.circular_state = {
        ...state,
        ...(initialDraftCustody ? { initial_draft_custody: initialDraftCustody } : {}),
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async ensureSessionMode(sessionId: string, mode: SessionMode): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const persistedMode = meta.mode ?? (meta.circular_state ? "circular" : undefined);
      if (persistedMode !== undefined && persistedMode !== mode) {
        throw new Error(
          `session_mode_mismatch: session ${sessionId} is ${persistedMode}; refusing ${mode}`,
        );
      }
      meta.session_mode_schema_version = 1;
      meta.mode = persistedMode ?? mode;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v3.5.0 (CRV2-1 + CRV2-6, Codex operational report): persist
  // requested-vs-effective budget + max_rounds traceability once at the
  // start of a run. Pre-v3.5.0 the durable record only had
  // `cost_ceiling_usd` (always the effective value) and nothing for
  // max_rounds — so retroactive analysis could not tell whether a
  // ceiling came from a per-call arg or a config default, nor what
  // max_rounds the caller actually requested. This fills that gap with
  // pure-additive metadata; `cost_ceiling_usd` is kept in sync with
  // `effective_cost_ceiling_usd` for back-compat with v3.4.x readers.
  async setSessionTraceability(
    sessionId: string,
    traceability: {
      requested_max_rounds: number | null;
      effective_max_rounds: number | null;
      requested_max_cost_usd: number | null;
      effective_cost_ceiling_usd: number | null;
      cost_ceiling_source: "call_arg" | "env_default" | "config_default";
    },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.requested_max_rounds = traceability.requested_max_rounds;
      meta.effective_max_rounds = traceability.effective_max_rounds;
      meta.requested_max_cost_usd = traceability.requested_max_cost_usd;
      meta.effective_cost_ceiling_usd = traceability.effective_cost_ceiling_usd;
      meta.cost_ceiling_source = traceability.cost_ceiling_source;
      // Keep the legacy field in sync so v3.4.x dashboard/readers that
      // only know `cost_ceiling_usd` still see the effective ceiling.
      meta.cost_ceiling_usd = traceability.effective_cost_ceiling_usd;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v3.2.0 (Codex bug report 2026-05-12): public guard for orchestrator
  // entry points. Throws when the session has already been finalized so
  // round-starting tools fail fast instead of appending rounds onto a
  // closed session (which would re-derive `convergence_health` from the
  // post-final round's `convergence.converged` and leave the meta in the
  // contradictory `outcome=converged / health=blocked` state observed in
  // session 41244a1c). Error code is structured for upstream callers.
  assertNotFinalized(sessionId: string): void {
    const meta = this.read(sessionId);
    if (meta.outcome) {
      const err = new Error(
        `session_already_finalized: session ${sessionId} is finalized with outcome="${meta.outcome}"; cannot start new rounds`,
      );
      (err as Error & { code?: string }).code = "session_already_finalized";
      throw err;
    }
  }

  private async persistCancelledTerminal(
    meta: SessionMeta,
    outcomeReason = "session_cancelled",
  ): Promise<SessionMeta> {
    const sessionId = meta.session_id;
    const ts = now();
    const requestedReason = meta.control?.reason ?? outcomeReason;
    let brokerRollback: EvidenceBrokerRollback | undefined;
    // A settled circular marker already owns exact authenticated bytes and
    // provider accounting. Promote it into the generation ledger before the
    // terminal write instead of misclassifying it as an interrupted unknown
    // attempt. This mutation and outcome=aborted share the caller-held lock and
    // the single meta.json replacement below.
    const settledCircularGeneration = this.promoteSettledCircularGenerationForAccounting(
      sessionId,
      meta,
    );
    if (meta.in_flight) {
      if (!inFlightRoundAlreadyAppended(meta)) {
        this.accountInterruptedInFlight(meta, `cancelled: ${requestedReason}`);
        brokerRollback = restoreInterruptedEvidenceBrokerSnapshot(meta);
      }
    } else if (!settledCircularGeneration) {
      this.accountInterruptedBackgroundGeneration(meta, `cancelled: ${requestedReason}`);
    }
    this.accountInterruptedPendingProviderCalls(meta, `cancelled: ${requestedReason}`);
    delete meta.in_flight;
    delete meta.generation_in_flight;
    meta.outcome = "aborted";
    meta.outcome_reason = outcomeReason;
    meta.control = {
      status: "cancelled",
      reason: requestedReason,
      job_id: meta.control?.job_id,
      owner_pid: meta.control?.owner_pid,
      requested_at: meta.control?.requested_at,
      updated_at: ts,
    };
    meta.convergence_health = transitionHealth(meta, "cancelled", outcomeReason, ts);
    meta.updated_at = ts;
    await writeJson(this.metaPath(sessionId), meta);
    if (brokerRollback) {
      await this.appendEventRecord({
        type: "session.evidence_broker_transaction_rolled_back",
        session_id: sessionId,
        round: brokerRollback.round,
        message: `Evidence Broker mutations from non-appended round ${brokerRollback.round} were rolled back during cancellation.`,
        data: { ...brokerRollback, cause: "cancelled_before_append" },
      });
    }
    try {
      await this.appendEventRecord({
        type: "session.cancelled",
        session_id: sessionId,
        ts,
        message: `Session cancelled: ${requestedReason}`,
        data: { outcome: "aborted", reason: outcomeReason, requested_reason: requestedReason },
      });
    } catch {
      /* event persistence is best-effort; session_doctor will flag gaps */
    }
    try {
      this.saveReport(sessionId, this.renderSessionReport(meta, this.readEvents(sessionId)));
    } catch {
      /* report regeneration is best-effort; meta.json remains authoritative */
    }
    return meta;
  }

  async finalize(
    sessionId: string,
    outcome: NonNullable<SessionMeta["outcome"]>,
    reason?: string,
  ): Promise<SessionMeta> {
    // A terminal transition must be the final durable event. Drain events
    // emitted before finalize() before acquiring the terminal write lock.
    await this.flushPendingEvents();
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        if (meta.outcome === outcome && (reason === undefined || meta.outcome_reason === reason)) {
          return meta;
        }
        const err = new Error(
          `session_already_finalized: session ${sessionId} is finalized as ${meta.outcome}/${meta.outcome_reason ?? "unspecified"}; refusing terminal transition to ${outcome}/${reason ?? "unspecified"}`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      // Cancellation and finalization contend on the same session lock. If a
      // durable cancellation request won that race, it is the authoritative
      // terminal intent: never persist the contradictory pair
      // outcome=converged/control=cancel_requested.
      if (meta.control?.status === "cancel_requested") {
        return this.persistCancelledTerminal(meta, "session_cancelled");
      }
      if (meta.generation_in_flight) {
        const generation = meta.generation_in_flight;
        const err = new Error(
          `cannot_finalize_generation_in_flight: session ${sessionId} still has ${generation.peer}/round-${generation.round}/${generation.label} in flight. Request cancellation and wait for provider work to settle before finalizing.`,
        );
        (err as Error & { code?: string }).code = "cannot_finalize_generation_in_flight";
        throw err;
      }
      if ((meta.pending_provider_call_reservations?.length ?? 0) > 0) {
        const err = new Error(
          `cannot_finalize_provider_calls_in_flight: session ${sessionId} still has ${meta.pending_provider_call_reservations?.length} paid provider call reservation(s) in flight. Request cancellation and wait for provider work to settle before finalizing.`,
        );
        (err as Error & { code?: string }).code = "cannot_finalize_provider_calls_in_flight";
        throw err;
      }
      const latestRound = meta.rounds.at(-1);
      let authenticatedFinalContent: string | undefined;
      const completingReservedConvergedRound =
        outcome === "converged" &&
        meta.in_flight !== undefined &&
        meta.in_flight.round === latestRound?.round &&
        latestRound.convergence.converged;
      if (meta.in_flight && !completingReservedConvergedRound) {
        const err = new Error(
          `cannot_finalize_in_flight_session: session ${sessionId} still has round ${meta.in_flight.round} in flight. Request cancellation with session_cancel_job and wait for provider work to settle before finalizing.`,
        );
        (err as Error & { code?: string }).code = "cannot_finalize_in_flight_session";
        throw err;
      }
      // v3.2.0 (Codex bug report 2026-05-12): when the caller asserts
      // outcome="converged", the latest round (if any) MUST have
      // `convergence.converged === true`. Otherwise we would persist the
      // contradictory `outcome=converged / health=blocked` state observed
      // in session 41244a1c (R6 had perplexity:unparseable_after_recovery
      // → convergence.converged=false, but session_finalize was invoked
      // with outcome="converged"/"unanimous_ready" anyway). Refuse with a
      // structured error so the operator/caller fixes the mismatch
      // upstream instead of corrupting the meta.
      if (outcome === "converged") {
        if (meta.rounds.length === 0) {
          const err = new Error(
            'session_finalize_outcome_mismatch: cannot finalize as "converged" — at least one completed convergent round is required',
          );
          (err as Error & { code?: string }).code = "session_finalize_outcome_mismatch";
          throw err;
        }
        const latest = meta.rounds[meta.rounds.length - 1];
        if (latest?.convergence?.converged !== true) {
          const err = new Error(
            `session_finalize_outcome_mismatch: cannot finalize as "converged" — latest round (round=${latest?.round ?? "undefined"}) has convergence.converged=${latest?.convergence?.converged ?? "undefined"}, reason="${latest?.convergence?.reason ?? "n/a"}"`,
          );
          (err as Error & { code?: string }).code = "session_finalize_outcome_mismatch";
          throw err;
        }
        if (latest.review_kind === "circular_revision") {
          this.readRoundProviderResult(sessionId, meta, latest);
        }
        // The vote applies to the exact redacted bytes authenticated before
        // dispatch and again at round append. A later replacement invalidates
        // convergence rather than allowing a verdict to finalize a different
        // artifact.
        if (this.roundRequiresReviewedArtifactCustody(meta, latest) || latest.reviewed_artifact) {
          authenticatedFinalContent = this.readRoundReviewedArtifact(sessionId, latest).content;
        }
      }
      if (completingReservedConvergedRound) delete meta.in_flight;
      // A normal background job is terminalized inside this same session
      // lock. Its later process-local cleanup must remain a no-op so the
      // report stays immutable, therefore remove the running control before
      // sealing the terminal snapshot. Cancellation took its dedicated path
      // above and intentionally persists control=cancelled.
      delete meta.control;
      meta.outcome = outcome;
      if (reason) meta.outcome_reason = reason;
      const ts = now();
      meta.convergence_health = transitionHealth(
        meta,
        outcome === "converged" ? "converged" : outcome === "max-rounds" ? "blocked" : "aborted",
        reason ?? outcome,
        ts,
      );
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      if (authenticatedFinalContent !== undefined) {
        try {
          // Write only the descriptor-authenticated bytes used by the verdict,
          // and only after the terminal metadata has committed. A failed
          // terminal write therefore cannot leave a misleading final.md.
          this.saveAuthenticatedFinal(sessionId, authenticatedFinalContent);
        } catch {
          // meta.json is authoritative. Restart recovery can recreate this
          // convenience mirror only after revalidating the same custody.
        }
      }
      try {
        await this.appendEventRecord({
          type: "session.finalized",
          session_id: sessionId,
          ts,
          message: `Session finalized as ${outcome}${reason ? `: ${reason}` : ""}`,
          data: { outcome, reason: reason ?? null },
        });
      } catch {
        /* event persistence is best-effort; session_doctor will flag gaps */
      }
      // Keep the durable report terminally consistent without requiring an
      // explicit session_report call from the operator.
      try {
        this.saveReport(sessionId, this.renderSessionReport(meta, this.readEvents(sessionId)));
      } catch {
        /* report regeneration is best-effort; meta.json remains authoritative */
      }
      return meta;
    });
  }

  async requestCancellation(
    sessionId: string,
    reason = "requester_requested",
    jobId?: string,
    options: { require_active_execution?: boolean } = {},
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const err = new Error(
          `session_already_finalized: cannot request cancellation for ${sessionId} with outcome=${meta.outcome}`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      const activeJobId = meta.control?.job_id;
      if (jobId && activeJobId && jobId !== activeJobId) {
        const err = new Error(
          `background_job_mismatch: cancellation requested for job ${jobId}, but session ${sessionId} is owned by job ${activeJobId}`,
        );
        (err as Error & { code?: string }).code = "background_job_mismatch";
        throw err;
      }
      const executionActive =
        Boolean(meta.in_flight) ||
        Boolean(meta.generation_in_flight) ||
        (meta.pending_provider_call_reservations?.length ?? 0) > 0 ||
        meta.control?.status === "running" ||
        meta.control?.status === "cancel_requested";
      if (options.require_active_execution && !executionActive) {
        const err = new Error(
          `no_active_execution: session ${sessionId} has no in-flight round, generation, or running background job`,
        );
        (err as Error & { code?: string }).code = "no_active_execution";
        throw err;
      }
      if (meta.control?.status === "cancel_requested") return meta;
      meta.control = {
        status: "cancel_requested",
        reason,
        // An omitted id targets the one durable owner.  Persisting the
        // canonical id prevents sibling windows from creating an invisible
        // cancellation that no owner-side watcher can match.
        job_id: activeJobId ?? jobId,
        owner_pid: meta.control?.owner_pid,
        requested_at: now(),
        updated_at: now(),
      };
      const transitionedAt = now();
      meta.convergence_health = transitionHealth(
        meta,
        "blocked",
        `Cancellation requested: ${reason}`,
        transitionedAt,
      );
      meta.updated_at = transitionedAt;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async markCancelled(sessionId: string, reason = "cancelled"): Promise<SessionMeta> {
    await this.flushPendingEvents();
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        if (meta.outcome === "aborted" && meta.outcome_reason === reason) return meta;
        const err = new Error(
          `session_already_finalized: session ${sessionId} is finalized as ${meta.outcome}/${meta.outcome_reason ?? "unspecified"}; refusing cancellation overwrite`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      return this.persistCancelledTerminal(meta, reason);
    });
  }

  isCancellationRequested(sessionId: string): boolean {
    const meta = this.read(sessionId);
    return (
      meta.control?.status === "cancel_requested" ||
      meta.control?.status === "cancelled" ||
      (meta.outcome === "aborted" && meta.outcome_reason === "session_cancelled")
    );
  }

  async appendFallbackEvent(
    sessionId: string,
    event: NonNullable<SessionMeta["fallback_events"]>[number],
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.fallback_events = [...(meta.fallback_events ?? []), event];
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.7.0 Evidence Broker: aggregate NEEDS_EVIDENCE asks from a round
  // into the session-level checklist. Each (peer, ask) pair is
  // deduplicated by sha256(peer + ":" + ask) so the same ask repeated
  // across rounds increments `round_count` instead of producing
  // duplicate entries. Returns the updated checklist (or empty array
  // if nothing was added/updated).
  async appendEvidenceChecklistItems(
    sessionId: string,
    round: number,
    incoming: Array<{ peer: PeerId; ask: string }>,
  ): Promise<NonNullable<SessionMeta["evidence_checklist"]>> {
    if (!incoming.length) return [];
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      const admission = evaluateEvidenceChecklistAdmission(
        checklist,
        round,
        incoming,
        this.config.evidence_broker,
      );
      if (!admission.accepted) {
        throw new EvidenceChecklistContractViolationError(admission);
      }
      const byId = new Map(checklist.map((item) => [item.id, item]));
      const ts = now();
      for (const { peer, ask } of incoming) {
        const trimmed = ask.trim();
        if (!trimmed) continue;
        const aliasTarget = strictChecklistAliasTarget(trimmed, peer, checklist, round);
        if (aliasTarget) {
          // Only an explicit same-owner, older, strict "same item" alias is
          // folded. Cross-peer references and requests that append a new
          // requirement remain first-class blockers; dropping them would let
          // one peer erase another peer's independent concern.
          if (round > aliasTarget.last_round) {
            aliasTarget.last_round = round;
            aliasTarget.last_seen_at = ts;
            aliasTarget.round_count += 1;
          }
          continue;
        }
        const id = checklistItemId(peer, trimmed);
        const existingItem = byId.get(id);
        if (existingItem) {
          // Same ask resurfaced. Bump last_round/last_seen_at and
          // round_count only when the round number is strictly newer
          // (avoid double-counting if the same caller_request appears
          // multiple times within the same round across peers — though
          // we already iterate per-peer, so this is defensive).
          if (round > existingItem.last_round) {
            existingItem.last_round = round;
            existingItem.last_seen_at = ts;
            existingItem.round_count += 1;
          }
        } else {
          byId.set(id, {
            id,
            peer,
            first_round: round,
            last_round: round,
            round_count: 1,
            ask: trimmed,
            first_seen_at: ts,
            last_seen_at: ts,
          });
        }
      }
      const updated = Array.from(byId.values()).sort((a, b) => {
        if (a.first_round !== b.first_round) return a.first_round - b.first_round;
        if (a.peer !== b.peer) return a.peer.localeCompare(b.peer);
        return a.ask.localeCompare(b.ask);
      });
      meta.evidence_checklist = updated;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return updated;
    });
  }

  inspectEvidenceChecklistAdmission(
    sessionId: string,
    round: number,
    incoming: readonly { peer: PeerId; ask: string }[] = [],
  ): EvidenceChecklistAdmission {
    const meta = this.read(sessionId);
    return evaluateEvidenceChecklistAdmission(
      meta.evidence_checklist ?? [],
      round,
      incoming,
      this.config.evidence_broker,
    );
  }

  /**
   * Removes only unresolved checklist entries for which the orchestrator has
   * already proved that the runtime authored the request. This is metadata
   * repair, not evidence satisfaction: the original rounds remain immutable
   * and every removal gets a dedicated audit record.
   */
  async reclassifyRuntimeGeneratedEvidenceChecklistItems(
    sessionId: string,
    proofs: Array<{ item_id: string; peer: PeerId; proof_round: number; proof_rule: string }>,
  ): Promise<EvidenceChecklistRuntimeReclassification[]> {
    if (!proofs.length) return [];
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) return [];
      const proofById = new Map(proofs.map((proof) => [proof.item_id, proof]));
      const removed: EvidenceChecklistRuntimeReclassification[] = [];
      const retained: EvidenceChecklistItem[] = [];
      const ts = now();
      for (const item of meta.evidence_checklist ?? []) {
        const proof = proofById.get(item.id);
        const status = item.status ?? "open";
        if (
          !proof ||
          proof.peer !== item.peer ||
          (status !== "open" && status !== "not_resurfaced")
        ) {
          retained.push(item);
          continue;
        }
        removed.push({
          ts,
          item_id: item.id,
          peer: item.peer,
          ask: item.ask,
          first_round: item.first_round,
          last_round: item.last_round,
          previous_status: status,
          proof_round: proof.proof_round,
          proof_rule: proof.proof_rule,
          reason: "runtime_remediation_misattributed_as_peer_request",
        });
      }
      if (!removed.length) return [];
      meta.evidence_checklist = retained;
      meta.evidence_checklist_runtime_reclassifications = [
        ...(meta.evidence_checklist_runtime_reclassifications ?? []),
        ...removed,
      ];
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return removed;
    });
  }

  async collapseReferencedEvidenceChecklistAliases(
    sessionId: string,
  ): Promise<EvidenceChecklistAliasCollapse[]> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) return [];
      const checklist = meta.evidence_checklist ?? [];
      const unresolved = (item: EvidenceChecklistItem): boolean => {
        const status = item.status ?? "open";
        return status === "open" || status === "not_resurfaced";
      };
      const collapsed: EvidenceChecklistAliasCollapse[] = [];
      const removedIds = new Set<string>();
      const ts = now();
      const directTarget = new Map<string, EvidenceChecklistItem>();
      for (const alias of checklist) {
        if (!unresolved(alias)) continue;
        const target = strictChecklistAliasTarget(
          alias.ask,
          alias.peer,
          checklist.filter(unresolved),
          alias.first_round,
        );
        if (target) directTarget.set(alias.id, target);
      }
      const survivingTarget = (alias: EvidenceChecklistItem): EvidenceChecklistItem | undefined => {
        const visited = new Set([alias.id]);
        let target = directTarget.get(alias.id);
        while (target && directTarget.has(target.id)) {
          if (visited.has(target.id)) return undefined;
          visited.add(target.id);
          target = directTarget.get(target.id);
        }
        return target;
      };
      for (const alias of checklist) {
        const previousStatus = alias.status ?? "open";
        if (previousStatus !== "open" && previousStatus !== "not_resurfaced") continue;
        const sameOwnerTarget = survivingTarget(alias);
        if (!sameOwnerTarget) continue;
        sameOwnerTarget.last_round = Math.max(sameOwnerTarget.last_round, alias.last_round);
        sameOwnerTarget.last_seen_at =
          sameOwnerTarget.last_seen_at > alias.last_seen_at
            ? sameOwnerTarget.last_seen_at
            : alias.last_seen_at;
        sameOwnerTarget.round_count += alias.round_count;
        removedIds.add(alias.id);
        collapsed.push({
          ts,
          alias_item_id: alias.id,
          peer: alias.peer,
          ask: alias.ask,
          first_round: alias.first_round,
          last_round: alias.last_round,
          previous_status: previousStatus,
          referenced_item_ids: [directTarget.get(alias.id)?.id ?? sameOwnerTarget.id],
          merged_into_item_id: sameOwnerTarget.id,
          reason: "checklist_item_reference_alias",
        });
      }
      if (!collapsed.length) return [];
      meta.evidence_checklist = checklist.filter((item) => !removedIds.has(item.id));
      meta.evidence_checklist_alias_collapses = [
        ...(meta.evidence_checklist_alias_collapses ?? []),
        ...collapsed,
      ];
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return collapsed;
    });
  }

  // v2.8.0: terminal statuses owned by the operator. The runtime never
  // auto-mutates items in these states — it only surfaces them via the
  // peer_resurfaced_terminal collection so the orchestrator can emit a
  // visibility event. Held as a Set because the runtime checks membership
  // on every item every round; a Set lookup avoids any risk of someone
  // later writing the buggy `(status === "satisfied" || "deferred" ||
  // "rejected")` truthy-OR form by accident.
  static readonly TERMINAL_STATUSES: ReadonlySet<EvidenceChecklistStatus> =
    new Set<EvidenceChecklistStatus>(["satisfied", "deferred", "rejected"]);

  // v2.8.0: resurfacing-inference for the evidence checklist. Runs AFTER
  // appendEvidenceChecklistItems for a given round and applies two rules
  // atomically under the session lock:
  //   1. Items in `open` whose `last_round < currentRound` were not
  //      brought back by any peer this round → promote to `addressed`
  //      and stamp `addressed_at_round`.
  //   2. Items in `addressed` whose `last_round === currentRound` were
  //      resurfaced this round (aggregation already bumped last_round
  //      and round_count) → revert to `open` and clear addressed_at_round.
  // Terminal operator statuses (satisfied/deferred/rejected) are NEVER
  // touched here. The peer_resurfaced_terminal information is surfaced
  // by the orchestrator via a separate event so operators see when peers
  // keep asking for items they explicitly closed; the status itself is
  // operator-owned.
  async runEvidenceChecklistAddressDetection(
    sessionId: string,
    currentRound: number,
  ): Promise<{
    // v3.5.0 (CRV2-2): renamed `addressed` → `not_resurfaced`. The
    // resurfacing-inference path no longer claims the evidence was
    // confirmed — it only records that the peer did not re-ask. See the
    // EvidenceChecklistStatus type doc for the semantics.
    not_resurfaced: EvidenceChecklistItem[];
    reopened: EvidenceChecklistItem[];
    peer_resurfaced_terminal: EvidenceChecklistItem[];
  }> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      if (!checklist.length) {
        return { not_resurfaced: [], reopened: [], peer_resurfaced_terminal: [] };
      }
      const notResurfaced: EvidenceChecklistItem[] = [];
      const reopened: EvidenceChecklistItem[] = [];
      const peerResurfacedTerminal: EvidenceChecklistItem[] = [];
      const history = meta.evidence_status_history ?? [];
      const ts = now();
      for (const item of checklist) {
        const status: EvidenceChecklistStatus = item.status ?? "open";
        if (status === "open" && item.last_round < currentRound) {
          // v3.5.0 (CRV2-2): an `open` item the peer did not resurface
          // becomes `not_resurfaced`, NOT `addressed`. "The peer did not
          // re-ask" is not proof the evidence was satisfied — only the
          // judge autowire (verified-satisfied) or explicit operator
          // action or a later strictly grounded READY/verified recheck by the
          // same requester may move an item to a confirmed state. This keeps
          // the audit trail honest. `not_resurfaced` remains convergence-
          // blocking until one of those explicit signals arrives.
          item.status = "not_resurfaced";
          item.addressed_at_round = currentRound;
          // v2.9.0: tag the inference path so the dashboard and audit
          // trail can distinguish runtime resurfacing from runtime judge
          // promotions. Operator-set terminal statuses do not populate
          // this field; setEvidenceChecklistItemStatus clears it.
          item.address_method = "resurfacing";
          delete item.judge_rationale;
          notResurfaced.push(item);
          history.push({
            ts,
            item_id: item.id,
            from: "open",
            to: "not_resurfaced",
            by: "runtime",
            round: currentRound,
            note: `auto: peer did not resurface ask in round ${currentRound} (not proof of satisfaction)`,
          });
        } else if (
          (status === "not_resurfaced" || status === "addressed") &&
          item.last_round === currentRound
        ) {
          // v3.5.0 (CRV2-2): a peer resurfacing an item reverts it to
          // `open` regardless of whether the prior state was the soft
          // `not_resurfaced` inference or a judge/operator `addressed` —
          // the peer's renewed ask wins over either inference path.
          const from: EvidenceChecklistStatus = status;
          item.status = "open";
          delete item.addressed_at_round;
          delete item.address_method;
          delete item.judge_rationale;
          reopened.push(item);
          history.push({
            ts,
            item_id: item.id,
            from,
            to: "open",
            by: "runtime",
            round: currentRound,
            note: `auto: peer resurfaced ask in round ${currentRound}`,
          });
        } else if (SessionStore.TERMINAL_STATUSES.has(status) && item.last_round === currentRound) {
          // Operator closed it but the peer brought it back this round.
          // Status stays terminal (operator-owned); we surface it for
          // the orchestrator to emit a visibility event.
          peerResurfacedTerminal.push(item);
        }
      }
      if (notResurfaced.length || reopened.length) {
        meta.evidence_status_history = history;
        meta.updated_at = ts;
        await writeJson(this.metaPath(sessionId), meta);
      }
      return {
        not_resurfaced: notResurfaced,
        reopened,
        peer_resurfaced_terminal: peerResurfacedTerminal,
      };
    });
  }

  // v2.8.0: operator workflow mutator for the evidence checklist. Used by
  // the session_evidence_checklist_update MCP tool. Allowed transitions
  // (operator): open → satisfied | deferred | rejected | open;
  // addressed | not_resurfaced → satisfied | deferred | rejected | open.
  // Terminal-state items can also be moved BACK to "open" by the operator
  // (retract a deferral/rejection); that re-arms the runtime
  // auto-promotion logic. Operator CANNOT move items to "addressed" or
  // "not_resurfaced" — both are runtime-managed (judge promotion and
  // resurfacing inference respectively). Returns the mutated item and the
  // appended history entry.
  async setEvidenceChecklistItemStatus(
    sessionId: string,
    itemId: string,
    status: Exclude<EvidenceChecklistStatus, "addressed" | "not_resurfaced">,
    options: { note?: string | undefined; by?: "operator" | "runtime" | undefined } = {},
  ): Promise<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry }> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.in_flight && (options.by ?? "operator") === "operator") {
        throw new Error(
          `evidence_checklist_update_in_flight: round ${meta.in_flight.round} is still running; retry after it completes or is recovered`,
        );
      }
      const checklist = meta.evidence_checklist ?? [];
      const item = checklist.find((entry) => entry.id === itemId);
      if (!item) {
        throw new Error(`evidence_checklist_item_not_found: ${itemId}`);
      }
      const from: EvidenceChecklistStatus = item.status ?? "open";
      // No-op transitions still record history so the audit trail captures
      // the operator's explicit intent.
      const ts = now();
      const entry: EvidenceStatusHistoryEntry = {
        ts,
        item_id: itemId,
        from,
        to: status,
        by: options.by ?? "operator",
        note: options.note,
      };
      item.status = status;
      // The signature excludes "addressed" so any operator-driven status
      // change clears the runtime-managed stamps (v2.8.0 addressed_at_round
      // + v2.9.0 address_method + judge_rationale).
      delete item.addressed_at_round;
      delete item.address_method;
      delete item.judge_rationale;
      const history = meta.evidence_status_history ?? [];
      history.push(entry);
      meta.evidence_status_history = history;
      meta.evidence_checklist = checklist;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  // v2.9.0: runtime-judge promotion path. Promotes an unresolved `open` or
  // `not_resurfaced` item to `addressed`, but never touches terminal
  // operator statuses. `not_resurfaced` means the peer did not repeat the
  // ask; it is not a terminal disposition. Atomic under the session lock.
  // Returns null when the item is already addressed, terminal, or missing so
  // the caller can skip emit.
  private authenticateEvidenceJudgeGeneration(
    sessionId: string,
    meta: SessionMeta,
    params: { item_id: string; round: number; judge_peer: PeerId; artifact_path: string },
  ): { peer: PeerId; rationale: string } {
    const fail = (detail: string, cause?: unknown): Error => {
      const error = new Error(
        `evidence_judge_authorization_failed: peer=${params.judge_peer} ${detail}`,
        cause === undefined ? undefined : { cause },
      );
      (
        error as Error & {
          code?: string;
          judge_peer?: PeerId;
        }
      ).code = "evidence_judge_authorization_failed";
      (error as Error & { judge_peer?: PeerId }).judge_peer = params.judge_peer;
      return error;
    };
    const expectedLabel = `judge-${params.item_id}`;
    const matchingArtifacts = (meta.generation_files ?? []).filter(
      (artifact) =>
        artifact.path === params.artifact_path &&
        artifact.round === params.round &&
        artifact.peer === params.judge_peer &&
        artifact.label === expectedLabel,
    );
    if (matchingArtifacts.length !== 1) {
      throw fail(
        `generation_ledger_mismatch: ${params.artifact_path} has ${matchingArtifacts.length} matching entries`,
      );
    }
    const artifact = matchingArtifacts[0];
    if (!artifact) throw fail(`generation_ledger_missing: ${params.artifact_path}`);
    const authenticated = this.readContainedRegularFile(
      sessionId,
      params.artifact_path,
      "provider_result",
    );
    if (authenticated.sha256 !== artifact.sha256 || authenticated.bytes !== artifact.bytes) {
      throw fail(`provider_result_integrity_mismatch: ${params.artifact_path}`);
    }

    let generation: GenerationResult;
    try {
      generation = JSON.parse(authenticated.content) as GenerationResult;
    } catch (error) {
      throw fail(`provider_result_invalid_json: ${params.artifact_path}`, error);
    }
    if (
      generation.peer !== params.judge_peer ||
      typeof generation.provider !== "string" ||
      typeof generation.model !== "string" ||
      typeof generation.text !== "string"
    ) {
      throw fail(`provider_result_identity_mismatch: ${params.artifact_path}`);
    }
    if (!generation.provider_prompt) {
      throw fail(`provider_prompt_custody_required: ${params.artifact_path}`);
    }
    try {
      this.assertProviderPromptCustodyIntegrity(sessionId, meta, generation.provider_prompt, {
        round: params.round,
        peer: params.judge_peer,
        provider: generation.provider,
        model: generation.model,
        call_kind: "evidence_judge",
        label: expectedLabel,
      });
    } catch (error) {
      throw fail(safeErrorMessage(error), error);
    }

    let judgment: Record<string, unknown>;
    try {
      const parsed = JSON.parse(generation.text) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("structured judgment must be an object");
      }
      judgment = parsed as Record<string, unknown>;
    } catch (error) {
      throw fail(`structured_judgment_invalid_json: ${params.artifact_path}`, error);
    }
    const parserWarnings = judgment.parser_warnings;
    const rationale = judgment.rationale;
    if (
      judgment.satisfied !== true ||
      judgment.confidence !== "verified" ||
      typeof rationale !== "string" ||
      rationale.trim().length === 0 ||
      !Array.isArray(parserWarnings) ||
      parserWarnings.length > 0 ||
      parserWarnings.some((warning) => typeof warning !== "string") ||
      (generation.parser_warnings !== undefined && generation.parser_warnings.length > 0)
    ) {
      throw fail(`structured_judgment_not_verified: ${params.artifact_path}`);
    }
    return { peer: params.judge_peer, rationale };
  }

  async markEvidenceItemAddressedByJudge(
    sessionId: string,
    itemId: string,
    params: {
      round: number;
      rationale: string;
      judge_peer: PeerId;
      judge_peers: readonly PeerId[];
      generation_paths: readonly string[];
    },
  ): Promise<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry } | null> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // Cancellation can win after a judge completes its last optimistic
      // isCancelled check but before this promotion acquires the session lock.
      // Do not mutate checklist state in a session that is now terminal or
      // has a durable cancellation request; the orchestrator will seal the
      // cancellation after paid-call settlement.
      if (meta.outcome || meta.control?.status === "cancel_requested") return null;
      const checklist = meta.evidence_checklist ?? [];
      const item = checklist.find((entry) => entry.id === itemId);
      if (!item) return null;
      const status: EvidenceChecklistStatus = item.status ?? "open";
      // Allowed runtime transitions: open|not_resurfaced → addressed (judge).
      // Terminal statuses (satisfied/deferred/rejected) and already-addressed
      // items are NOT auto-mutated here.
      if (status !== "open" && status !== "not_resurfaced") return null;
      if (
        params.judge_peers.length === 0 ||
        params.judge_peers.length !== params.generation_paths.length ||
        new Set(params.judge_peers).size !== params.judge_peers.length ||
        params.judge_peers[0] !== params.judge_peer
      ) {
        throw new Error(`evidence_judge_authorization_set_invalid: ${itemId}`);
      }
      const authorizations = params.judge_peers.map((judgePeer, index) =>
        this.authenticateEvidenceJudgeGeneration(sessionId, meta, {
          item_id: itemId,
          round: params.round,
          judge_peer: judgePeer,
          artifact_path: params.generation_paths[index] ?? "",
        }),
      );
      const authenticatedRationale = authorizations
        .map((authorization) => authorization.rationale)
        .join(" || ");
      if (params.rationale !== authenticatedRationale) {
        throw new Error(`evidence_judge_authorization_rationale_mismatch: ${itemId}`);
      }
      const ts = now();
      const rationale = authenticatedRationale.trim().slice(0, 800);
      item.status = "addressed";
      item.addressed_at_round = params.round;
      item.address_method = "judge";
      item.judge_rationale = rationale;
      const entry: EvidenceStatusHistoryEntry = {
        ts,
        item_id: itemId,
        from: status,
        to: "addressed",
        by: "runtime",
        round: params.round,
        note: `judge[${params.judge_peer}]: ${rationale}`,
      };
      const history = meta.evidence_status_history ?? [];
      history.push(entry);
      meta.evidence_status_history = history;
      meta.evidence_checklist = checklist;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  async markEvidenceItemsAddressedByRequesterReverification(
    sessionId: string,
    params: { round: number; peer: PeerId; evidence_sources: string[] },
  ): Promise<Array<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry }>> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      const evidenceSources = params.evidence_sources
        .map((source) => source.trim())
        .filter(Boolean);
      if (!evidenceSources.length) return [];
      const sourceDigest = crypto
        .createHash("sha256")
        .update(JSON.stringify(evidenceSources))
        .digest("hex");
      const ts = now();
      const history = meta.evidence_status_history ?? [];
      const promoted: Array<{
        item: EvidenceChecklistItem;
        history_entry: EvidenceStatusHistoryEntry;
      }> = [];
      for (const item of checklist) {
        const status: EvidenceChecklistStatus = item.status ?? "open";
        if (
          item.peer !== params.peer ||
          item.last_round >= params.round ||
          (status !== "open" && status !== "not_resurfaced")
        ) {
          continue;
        }
        if (
          !checklistAskCorroborated(
            item,
            evidenceSources,
            checklist.map((candidate) => candidate.id),
          )
        )
          continue;
        const entry: EvidenceStatusHistoryEntry = {
          ts,
          item_id: item.id,
          from: status,
          to: "addressed",
          by: "runtime",
          round: params.round,
          note: `requester_reverified[${params.peer}]: ${evidenceSources.length} strictly grounded source(s), sha256=${sourceDigest}`,
        };
        item.status = "addressed";
        item.addressed_at_round = params.round;
        item.address_method = "requester_reverified";
        delete item.judge_rationale;
        history.push(entry);
        promoted.push({ item, history_entry: entry });
      }
      if (!promoted.length) return [];
      meta.evidence_checklist = checklist;
      meta.evidence_status_history = history;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return promoted;
    });
  }

  async recoverInterruptedSessions(activeSessionIds = new Set<string>()): Promise<SessionMeta[]> {
    const recovered: SessionMeta[] = [];
    for (const session of this.list()) {
      try {
        await this.settleOrphanedBackgroundJobStatuses(session, activeSessionIds);
      } catch {
        // Operational job history is advisory. A failed status repair must not
        // block recovery of authoritative session metadata.
      }
      if (session.outcome === "converged") {
        let restoredMissingFinal = false;
        await this.withSessionLock(session.session_id, async () => {
          const current = this.read(session.session_id);
          const latest = current.rounds.at(-1);
          if (
            current.outcome === "converged" &&
            latest &&
            (this.roundRequiresReviewedArtifactCustody(current, latest) || latest.reviewed_artifact)
          ) {
            restoredMissingFinal = this.restoreFinalArtifactFromRound(current, latest);
          }
        });
        if (restoredMissingFinal) {
          const repaired = this.read(session.session_id);
          try {
            await this.appendEvent({
              type: "session.recovered_after_restart",
              session_id: repaired.session_id,
              ts: now(),
              message:
                "Restart recovery authenticated the converged round and recreated its missing final.md mirror without replacing any existing artifact.",
              data: {
                recovered_after_restart: true,
                final_artifact_recovered: true,
                source: "terminal_missing_final_mirror",
              },
            });
          } catch {
            /* event persistence is best-effort; session_doctor will flag gaps */
          }
          try {
            this.saveReport(
              repaired.session_id,
              this.renderSessionReport(repaired, this.readEvents(repaired.session_id)),
            );
          } catch {
            /* report regeneration is best-effort; meta.json remains authoritative */
          }
          recovered.push(repaired);
        }
        continue;
      }
      const pendingProviderCalls = (session.pending_provider_call_reservations?.length ?? 0) > 0;
      const livePendingProviderCall = (session.pending_provider_call_reservations ?? []).some(
        (reservation) => this.pendingProviderCallOwnerIsAlive(reservation),
      );
      const liveInFlightOwner = this.inFlightOwnerIsAlive(session);
      const orphanedBackgroundControl =
        (session.control?.status === "running" || session.control?.status === "cancel_requested") &&
        !session.in_flight;
      if (
        session.outcome ||
        activeSessionIds.has(session.session_id) ||
        livePendingProviderCall ||
        liveInFlightOwner ||
        (!session.in_flight &&
          !session.generation_in_flight &&
          !pendingProviderCalls &&
          !orphanedBackgroundControl)
      )
        continue;
      let actuallyRecovered = false;
      let recoveredConvergedRound: ReviewRound | undefined;
      const updated = await this.withSessionLock(session.session_id, async () => {
        const current = this.read(session.session_id);
        const currentOrphanedBackgroundControl =
          (current.control?.status === "running" ||
            current.control?.status === "cancel_requested") &&
          !current.in_flight;
        const currentPendingProviderCalls =
          (current.pending_provider_call_reservations?.length ?? 0) > 0;
        const currentLivePendingProviderCall = (
          current.pending_provider_call_reservations ?? []
        ).some((reservation) => this.pendingProviderCallOwnerIsAlive(reservation));
        const currentLiveInFlightOwner = this.inFlightOwnerIsAlive(current);
        if (
          current.outcome ||
          activeSessionIds.has(current.session_id) ||
          currentLivePendingProviderCall ||
          currentLiveInFlightOwner ||
          (!current.in_flight &&
            !current.generation_in_flight &&
            !currentPendingProviderCalls &&
            !currentOrphanedBackgroundControl)
        ) {
          return current;
        }
        const stagedCircularGeneration =
          current.mode === "circular" &&
          current.generation_in_flight?.settled_result_path !== undefined;
        if (stagedCircularGeneration && current.generation_in_flight) {
          if (current.control?.status === "cancel_requested") {
            // The request and exact provider result both survived the owner.
            // Cancellation remains authoritative: consume the staged bytes and
            // terminalize them in the same locked metadata replacement.
            actuallyRecovered = true;
            return this.persistCancelledTerminal(current, "session_cancelled");
          }
          // The provider already settled and its exact redacted result is
          // descriptor-authenticated on disk. Preserve it for deterministic
          // continuation instead of charging/repeating the provider call.
          current.generation_in_flight.owner_pid = 0;
          delete current.control;
          const transitionedAt = now();
          current.convergence_health = transitionHealth(
            current,
            "blocked",
            "A settled circular result was recovered and awaits atomic round promotion.",
            transitionedAt,
          );
          current.updated_at = transitionedAt;
          actuallyRecovered = true;
          await writeJson(this.metaPath(current.session_id), current);
          return current;
        }
        const recoveredRound = this.sealRecoveredAppendedConvergence(current);
        if (recoveredRound) {
          // appendRound durably committed unanimity before the process died.
          // Re-seal that exact terminal snapshot instead of reopening a round
          // that has no outstanding provider work and no human action pending.
          recoveredConvergedRound = recoveredRound;
          actuallyRecovered = true;
          await writeJson(this.metaPath(current.session_id), current);
          return current;
        }
        // A dead owner has not durably acknowledged a requested cancellation.
        // Do not invent a clean terminal cancellation: retain the established
        // recovery path below, which records the interrupted owner and makes
        // the session safely resumable from its durable snapshot.
        const round = current.in_flight?.round;
        const interruptedGeneration = current.generation_in_flight;
        let brokerRollback: EvidenceBrokerRollback | undefined;
        if (current.in_flight) {
          // Once a round exists, provider dispatch may already have happened.
          // Preserve the conservative unknown-spend accounting on recovery.
          if (!inFlightRoundAlreadyAppended(current)) {
            this.accountInterruptedInFlight(current, "recovered_after_restart");
            brokerRollback = restoreInterruptedEvidenceBrokerSnapshot(current);
          }
          delete current.in_flight;
          // in_flight is the authoritative broader dispatch envelope. A
          // generation marker cannot add a second unknown attempt for the same
          // interrupted interval.
          delete current.generation_in_flight;
        } else if (current.generation_in_flight) {
          this.accountInterruptedBackgroundGeneration(current, "recovered_after_restart");
          delete current.generation_in_flight;
        }
        this.accountInterruptedPendingProviderCalls(current, "recovered_after_restart");
        const previousControl = current.control;
        const reason =
          round === undefined
            ? interruptedGeneration
              ? `Generation ${interruptedGeneration.peer}/round-${interruptedGeneration.round}/${interruptedGeneration.label} was interrupted before its result was durably accounted.`
              : previousControl?.status === "cancel_requested"
                ? `Cancellation was requested${previousControl.reason ? ` (${previousControl.reason})` : ""}, but the background owner exited before a durable round began.`
                : "The background owner exited before a durable round began. Start a new round to continue from saved session context."
            : `Round ${round} was interrupted before completion. Start a new round to continue from saved session context.`;
        const transitionedAt = now();
        if (previousControl?.job_id) {
          const interruptedJob = this.readBackgroundJobStatus(
            current.session_id,
            previousControl.job_id,
          );
          if (interruptedJob?.status === "running") {
            await this.writeBackgroundJobStatus({
              ...interruptedJob,
              status: previousControl.status === "cancel_requested" ? "cancelled" : "failed",
              completed_at: transitionedAt,
              error: `background_job_recovered_after_restart: ${reason}`,
            });
          }
        }
        current.control = {
          status: "recovered_after_restart",
          reason,
          job_id: previousControl?.job_id,
          owner_pid: previousControl?.owner_pid,
          requested_at: previousControl?.requested_at,
          updated_at: transitionedAt,
        };
        current.convergence_health = transitionHealth(
          current,
          "stale",
          round === undefined
            ? "Recovered an orphaned background job after MCP restart. Start a new round to continue from saved session context."
            : `Recovered interrupted round ${round} after MCP restart. Start a new round to continue from saved session context.`,
          transitionedAt,
        );
        current.updated_at = transitionedAt;
        await writeJson(this.metaPath(current.session_id), current);
        if (brokerRollback) {
          await this.appendEventRecord({
            type: "session.evidence_broker_transaction_rolled_back",
            session_id: current.session_id,
            round: brokerRollback.round,
            message: `Evidence Broker mutations from interrupted round ${brokerRollback.round} were rolled back during recovery.`,
            data: { ...brokerRollback, cause: "recovered_after_restart" },
          });
        }
        actuallyRecovered = true;
        return current;
      });
      if (actuallyRecovered && recoveredConvergedRound) {
        this.restoreFinalArtifactFromRound(updated, recoveredConvergedRound);
        try {
          await this.appendEvent({
            type: "session.finalized",
            session_id: updated.session_id,
            ts: updated.updated_at,
            message:
              "Session finalized as converged: recovered appended unanimous round after restart",
            data: {
              outcome: "converged",
              reason: updated.outcome_reason ?? "unanimous_ready",
              recovered_after_restart: true,
              round: recoveredConvergedRound.round,
            },
          });
        } catch {
          /* event persistence is best-effort; session_doctor will flag gaps */
        }
        try {
          const reported = this.read(updated.session_id);
          this.saveReport(
            reported.session_id,
            this.renderSessionReport(reported, this.readEvents(reported.session_id)),
          );
        } catch {
          /* report regeneration is best-effort; meta.json remains authoritative */
        }
      }
      if (actuallyRecovered) recovered.push(updated);
    }
    return recovered;
  }

  async markBackgroundJobRunning(
    sessionId: string,
    owner: { job_id: string; owner_pid: number },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // requestCancellation and this transition share the session lock.  If
      // cancellation wins the race, starting the deferred background job must
      // not erase it; if running wins, the subsequent cancellation write wins.
      if (meta.outcome || meta.control?.status === "cancel_requested") return meta;
      if (meta.control?.status === "running") {
        if (meta.control.job_id === owner.job_id) return meta;
        const err = new Error(
          `background_job_already_running: session ${sessionId} is owned by job ${meta.control.job_id ?? "unknown"}; refusing owner ${owner.job_id}`,
        );
        (err as Error & { code?: string }).code = "background_job_already_running";
        throw err;
      }
      meta.control = {
        status: "running",
        job_id: owner.job_id,
        owner_pid: owner.owner_pid,
        updated_at: now(),
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async markBackgroundGenerationInFlight(
    sessionId: string,
    generation: BackgroundGenerationInFlight,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome) {
        const err = new Error(
          `session_already_finalized: cannot dispatch generation for ${sessionId} with outcome=${meta.outcome}`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      if (meta.control?.status === "cancel_requested") return meta;
      const existing = meta.generation_in_flight;
      if (existing) {
        const err = new Error(
          `generation_already_in_flight: ${existing.peer}/round-${existing.round}/${existing.label}`,
        );
        (err as Error & { code?: string }).code = "generation_already_in_flight";
        throw err;
      }
      const ts = now();
      meta.generation_in_flight = generation;
      if (meta.control) meta.control.updated_at = ts;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async clearBackgroundGenerationInFlight(
    sessionId: string,
    peer: PeerId,
    round: number,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.outcome || !meta.generation_in_flight) return meta;
      const before = meta.generation_in_flight;
      this.settleBackgroundGenerationMarker(meta, peer, round);
      if (meta.generation_in_flight === before) return meta;
      const ts = now();
      if (meta.control) meta.control.updated_at = ts;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async clearBackgroundJobControl(sessionId: string, jobId: string): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // Terminal persistence and its generated report are a single immutable
      // snapshot.  Late process-local cleanup must not mutate meta.json after
      // that report has been sealed.
      if (meta.outcome) return meta;
      if (meta.control?.job_id !== jobId || meta.control.status === "cancel_requested") return meta;
      delete meta.control;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.12.0: walk session events.ndjson and aggregate
  // `session.evidence_judge_pass.shadow_decision` events into a peer-keyed
  // rollup. Operator observability: how many shadow decisions exist, what
  // the would_promote rate looks like per judge_peer, what confidence
  // distribution the judge returns. Walks the event log per session
  // (O(events) per call); acceptable for v2.12 because the corpus is
  // bounded (≤ a few hundred sessions historically) and the dashboard
  // refreshes on demand.
  aggregateShadowJudgments(
    sessionId?: string,
    preloadedSessions?: readonly SessionMeta[],
  ): ShadowJudgmentRollup {
    const sessions = preloadedSessions ?? (sessionId ? [this.read(sessionId)] : this.list());
    const byPeer: Partial<Record<PeerId, ShadowJudgmentPeerStats>> = {};
    let decisionsTotal = 0;
    let wouldPromoteTotal = 0;
    const peerKnown: readonly PeerId[] = PEERS;
    for (const session of sessions) {
      const events = this.readEvents(session.session_id);
      for (const event of events) {
        const data = shadowDecisionData(event);
        if (!data) continue;
        const judgePeer = data.judge_peer;
        if (!judgePeer || !peerKnown.includes(judgePeer)) continue;
        let entry = byPeer[judgePeer];
        if (!entry) {
          entry = {
            judge_peer: judgePeer,
            decisions_total: 0,
            would_promote: 0,
            would_skip_satisfied_unverified: 0,
            would_skip_not_satisfied: 0,
            by_confidence: {},
            first_seen_at: null,
            last_seen_at: null,
          };
          byPeer[judgePeer] = entry;
        }
        entry.decisions_total += 1;
        decisionsTotal += 1;
        if (data.would_promote === true) {
          entry.would_promote += 1;
          wouldPromoteTotal += 1;
        } else if (data.satisfied === true) {
          entry.would_skip_satisfied_unverified += 1;
        } else {
          entry.would_skip_not_satisfied += 1;
        }
        if (
          data.confidence === "verified" ||
          data.confidence === "inferred" ||
          data.confidence === "unknown"
        ) {
          entry.by_confidence[data.confidence] = (entry.by_confidence[data.confidence] ?? 0) + 1;
        }
        const ts = event.ts ?? null;
        if (ts) {
          if (!entry.first_seen_at || ts < entry.first_seen_at) entry.first_seen_at = ts;
          if (!entry.last_seen_at || ts > entry.last_seen_at) entry.last_seen_at = ts;
        }
      }
    }
    return {
      decisions_total: decisionsTotal,
      would_promote_total: wouldPromoteTotal,
      by_judge_peer: byPeer,
    };
  }

  metrics(sessionId?: string): RuntimeMetrics {
    const sessions = sessionId ? [this.read(sessionId)] : this.list();
    const peerResults: RuntimeMetrics["peer_results"] = {};
    const peerFailures: RuntimeMetrics["peer_failures"] = {};
    const decisionQuality: RuntimeMetrics["decision_quality"] = {};
    const peerLatencies: number[] = [];
    const generationLatencies: number[] = [];
    let moderationRecoveries = 0;
    let fallbackEvents = 0;
    // v2.8.0: per-peer health roll-up. Each accumulator tracks all the
    // fields needed for PeerHealthSummary; rates are computed at the end.
    type PeerAccumulator = {
      results_total: number;
      ready_count: number;
      not_ready_count: number;
      needs_evidence_count: number;
      unresolved_count: number;
      cost_sum: number;
      cost_count: number;
      parser_warnings_total: number;
      rejected_total: number;
      failures_by_class: Partial<Record<PeerFailure["failure_class"], number>>;
    };
    const perPeer: Partial<Record<PeerId, PeerAccumulator>> = {};
    const accumulator = (peer: PeerId): PeerAccumulator => {
      let entry = perPeer[peer];
      if (!entry) {
        entry = {
          results_total: 0,
          ready_count: 0,
          not_ready_count: 0,
          needs_evidence_count: 0,
          unresolved_count: 0,
          cost_sum: 0,
          cost_count: 0,
          parser_warnings_total: 0,
          rejected_total: 0,
          failures_by_class: {},
        };
        perPeer[peer] = entry;
      }
      return entry;
    };

    for (const session of sessions) {
      fallbackEvents += session.fallback_events?.length ?? 0;
      for (const round of session.rounds) {
        for (const peer of round.peers) {
          peerResults[peer.peer] = (peerResults[peer.peer] ?? 0) + 1;
          const quality = peer.decision_quality ?? "failed";
          decisionQuality[quality] = (decisionQuality[quality] ?? 0) + 1;
          if (Number.isFinite(peer.latency_ms)) peerLatencies.push(peer.latency_ms);
          if (peer.parser_warnings.some((warning) => warning.includes("moderation_safe_retry"))) {
            moderationRecoveries += 1;
          }
          const acc = accumulator(peer.peer);
          acc.results_total += 1;
          if (peer.status === "READY") acc.ready_count += 1;
          else if (peer.status === "NOT_READY") acc.not_ready_count += 1;
          else if (peer.status === "NEEDS_EVIDENCE") acc.needs_evidence_count += 1;
          else acc.unresolved_count += 1;
          if (
            peer.cost?.total_cost != null &&
            Number.isFinite(peer.cost.total_cost) &&
            peer.cost.source !== "stub"
          ) {
            acc.cost_sum += peer.cost.total_cost;
            acc.cost_count += 1;
          }
          acc.parser_warnings_total += peer.parser_warnings.length;
        }
        for (const failure of round.rejected) {
          peerFailures[failure.failure_class] = (peerFailures[failure.failure_class] ?? 0) + 1;
          const acc = accumulator(failure.peer);
          acc.rejected_total += 1;
          acc.failures_by_class[failure.failure_class] =
            (acc.failures_by_class[failure.failure_class] ?? 0) + 1;
        }
      }
      for (const generation of session.generation_files ?? []) {
        if (generation.latency_ms != null && Number.isFinite(generation.latency_ms)) {
          generationLatencies.push(generation.latency_ms);
        }
      }
    }

    const average = (values: number[]): number | null =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    const perPeerHealth: Partial<Record<PeerId, PeerHealthSummary>> = {};
    for (const [peer, acc] of Object.entries(perPeer) as Array<[PeerId, PeerAccumulator]>) {
      const total = acc.results_total;
      perPeerHealth[peer] = {
        peer,
        results_total: total,
        ready_count: acc.ready_count,
        not_ready_count: acc.not_ready_count,
        needs_evidence_count: acc.needs_evidence_count,
        unresolved_count: acc.unresolved_count,
        ready_rate: total > 0 ? acc.ready_count / total : 0,
        needs_evidence_rate: total > 0 ? acc.needs_evidence_count / total : 0,
        avg_cost_usd: acc.cost_count > 0 ? acc.cost_sum / acc.cost_count : null,
        total_cost_usd: acc.cost_count > 0 ? acc.cost_sum : null,
        parser_warnings_total: acc.parser_warnings_total,
        rejected_total: acc.rejected_total,
        failures_by_class: acc.failures_by_class,
      };
    }

    return {
      generated_at: now(),
      scope: sessionId ? "session" : "all",
      session_id: sessionId,
      sessions: {
        total: sessions.length,
        converged: sessions.filter((session) => session.outcome === "converged").length,
        aborted: sessions.filter((session) => session.outcome === "aborted").length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        unfinished: sessions.filter((session) => !session.outcome).length,
      },
      rounds: sessions.reduce((sum, session) => sum + session.rounds.length, 0),
      peer_results: peerResults,
      peer_failures: peerFailures,
      decision_quality: decisionQuality,
      moderation_recoveries: moderationRecoveries,
      fallback_events: fallbackEvents,
      total_usage: mergeUsage(sessions.map((session) => session.totals.usage)),
      total_cost: mergeCost(sessions.map((session) => session.totals.cost)),
      latency_ms: {
        peer_average: average(peerLatencies),
        generation_average: average(generationLatencies),
      },
      per_peer_health: perPeerHealth,
      // v2.12.0: shadow_decision rollup. See aggregateShadowJudgments().
      shadow_judgment: this.aggregateShadowJudgments(sessionId, sessions),
    };
  }

  peerReliabilityReport(sessionId?: string): PeerReliabilityReport {
    const sessions = sessionId ? [this.read(sessionId)] : this.list();
    type ReliabilityAccumulator = Omit<
      PeerReliabilityStats,
      "sessions_seen" | "avg_latency_ms" | "total_cost_usd"
    > & {
      session_ids: Set<string>;
      latency_sum: number;
      latency_count: number;
      cost_sum: number;
      cost_count: number;
    };
    const peerSet = new Set<PeerId>(PEERS);
    const byPeer: Partial<Record<PeerId, ReliabilityAccumulator>> = {};
    const acc = (peer: PeerId): ReliabilityAccumulator => {
      let entry = byPeer[peer];
      if (!entry) {
        entry = {
          peer,
          session_ids: new Set<string>(),
          results_total: 0,
          ready: 0,
          not_ready: 0,
          needs_evidence: 0,
          unresolved_status: 0,
          parser_warnings_total: 0,
          parser_warnings_by_type: {},
          decision_quality: {},
          rejected_total: 0,
          provider_errors: 0,
          failures_by_class: {},
          open_asks: 0,
          not_resurfaced_asks: 0,
          addressed_asks: 0,
          satisfied_asks: 0,
          deferred_asks: 0,
          rejected_asks: 0,
          fabrication_events: 0,
          latency_sum: 0,
          latency_count: 0,
          cost_sum: 0,
          cost_count: 0,
        };
        byPeer[peer] = entry;
      }
      return entry;
    };

    for (const session of sessions) {
      for (const round of session.rounds) {
        for (const peerResult of round.peers) {
          const entry = acc(peerResult.peer);
          entry.session_ids.add(session.session_id);
          entry.results_total += 1;
          if (peerResult.status === "READY") entry.ready += 1;
          else if (peerResult.status === "NOT_READY") entry.not_ready += 1;
          else if (peerResult.status === "NEEDS_EVIDENCE") entry.needs_evidence += 1;
          else entry.unresolved_status += 1;
          const quality = peerResult.decision_quality ?? "failed";
          entry.decision_quality[quality] = (entry.decision_quality[quality] ?? 0) + 1;
          for (const warning of peerResult.parser_warnings) {
            entry.parser_warnings_total += 1;
            entry.parser_warnings_by_type[warning] =
              (entry.parser_warnings_by_type[warning] ?? 0) + 1;
          }
          if (Number.isFinite(peerResult.latency_ms)) {
            entry.latency_sum += peerResult.latency_ms;
            entry.latency_count += 1;
          }
          if (
            peerResult.cost?.total_cost != null &&
            Number.isFinite(peerResult.cost.total_cost) &&
            peerResult.cost.source !== "stub"
          ) {
            entry.cost_sum += peerResult.cost.total_cost;
            entry.cost_count += 1;
          }
        }
        for (const failure of round.rejected) {
          const entry = acc(failure.peer);
          entry.session_ids.add(session.session_id);
          entry.rejected_total += 1;
          if (failure.failure_class === "provider_error") entry.provider_errors += 1;
          entry.failures_by_class[failure.failure_class] =
            (entry.failures_by_class[failure.failure_class] ?? 0) + 1;
        }
      }
      for (const item of session.evidence_checklist ?? []) {
        const entry = acc(item.peer);
        entry.session_ids.add(session.session_id);
        const status = item.status ?? "open";
        if (status === "open") entry.open_asks += 1;
        else if (status === "not_resurfaced") entry.not_resurfaced_asks += 1;
        else if (status === "addressed") entry.addressed_asks += 1;
        else if (status === "satisfied") entry.satisfied_asks += 1;
        else if (status === "deferred") entry.deferred_asks += 1;
        else if (status === "rejected") entry.rejected_asks += 1;
      }
      for (const event of this.readEvents(session.session_id)) {
        if (!event.type.includes("fabrication")) continue;
        const dataPeer = (event.data?.peer ?? event.peer) as PeerId | undefined;
        if (!dataPeer || !peerSet.has(dataPeer)) continue;
        const entry = acc(dataPeer);
        entry.session_ids.add(session.session_id);
        entry.fabrication_events += 1;
      }
    }

    const reportByPeer: PeerReliabilityReport["by_peer"] = {};
    for (const [peer, entry] of Object.entries(byPeer) as Array<[PeerId, ReliabilityAccumulator]>) {
      reportByPeer[peer] = {
        peer,
        sessions_seen: entry.session_ids.size,
        results_total: entry.results_total,
        ready: entry.ready,
        not_ready: entry.not_ready,
        needs_evidence: entry.needs_evidence,
        unresolved_status: entry.unresolved_status,
        parser_warnings_total: entry.parser_warnings_total,
        parser_warnings_by_type: entry.parser_warnings_by_type,
        decision_quality: entry.decision_quality,
        rejected_total: entry.rejected_total,
        provider_errors: entry.provider_errors,
        failures_by_class: entry.failures_by_class,
        open_asks: entry.open_asks,
        not_resurfaced_asks: entry.not_resurfaced_asks,
        addressed_asks: entry.addressed_asks,
        satisfied_asks: entry.satisfied_asks,
        deferred_asks: entry.deferred_asks,
        rejected_asks: entry.rejected_asks,
        fabrication_events: entry.fabrication_events,
        avg_latency_ms: entry.latency_count > 0 ? entry.latency_sum / entry.latency_count : null,
        total_cost_usd: entry.cost_count > 0 ? entry.cost_sum : null,
      };
    }
    return {
      generated_at: now(),
      scope: sessionId ? "session" : "all",
      session_id: sessionId,
      by_peer: reportByPeer,
    };
  }

  // v2.16.0: read-only operational doctor. This is intentionally a
  // reporting surface, not a cleanup tool: it never finalizes, rewrites
  // or deletes sessions. Operators use it after audits to see which
  // sessions need human action and which records are legacy metadata
  // artifacts (for example caller==lead_peer before the petitioner/
  // relator split).
  //
  // v2.22.0 (A.P2): `includeLegacy` toggles per-session enumeration of
  // `findings.self_lead_metadata`. Default false because pre-v2.16.0
  // sessions carry the legacy self-lead artifact at a 38% hit rate
  // (178/467 in the May 2026 audit corpus); enumerating them every call
  // floods the response. `totals.self_lead_metadata` count remains
  // visible regardless. Pass `includeLegacy=true` to enumerate.
  //
  // v2.22.0 (B.P2): `findings.open_evidence_sessions[i]` entries gain
  // `item_types` (open items grouped by surfacing peer) and
  // `chronic_blockers` (item ids with `round_count >= 3`) so operators
  // can see which evidence asks are systemic vs cauda ruidosa.
  async sessionDoctor(
    limit = 20,
    includeLegacy = false,
    repair = false,
    includeTerminalFindings = false,
  ): Promise<SessionDoctorReport> {
    const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    // v3.6.0 (C): opt-in repair pass BEFORE the read-only audit. Fixes
    // the contradictory `outcome="converged" + health.state="blocked"`
    // state left on disk by pre-v3.2.0 sessions (v3.2.0 fixed the cause
    // via the finalize/appendRound invariants; old corrupt metas
    // persist). Only that specific contradiction is touched, only when
    // the operator explicitly passes `repair: true`. Recomputes
    // `convergence_health` from the latest round's `convergence.converged`.
    const repaired: NonNullable<SessionDoctorReport["repaired"]> = [];
    const sessions = this.list();
    if (repair) {
      for (const session of sessions) {
        if (session.outcome === "converged" && session.convergence_health?.state === "blocked") {
          const latest = session.rounds.at(-1);
          const latestConverged = latest?.convergence?.converged === true;
          // Only repair when the latest round actually converged — i.e.
          // the `outcome="converged"` finalize was legitimate and only
          // the health field is the stale lie. If the latest round did
          // NOT converge, the contradiction is deeper and we leave it
          // for manual operator inspection rather than guessing.
          if (latestConverged) {
            const fromState = session.convergence_health?.state;
            const fixed = await this.withSessionLock(session.session_id, async () => {
              const meta = this.read(session.session_id);
              if (
                meta.outcome === "converged" &&
                meta.convergence_health?.state === "blocked" &&
                meta.rounds.at(-1)?.convergence?.converged === true
              ) {
                const transitionedAt = now();
                meta.convergence_health = transitionHealth(
                  meta,
                  "converged",
                  `v3.6.0 doctor repair: recomputed health from latest round (was "blocked" with outcome="converged" — pre-v3.2.0 corruption artifact)`,
                  transitionedAt,
                );
                meta.updated_at = transitionedAt;
                await writeJson(this.metaPath(session.session_id), meta);
                return true;
              }
              return false;
            });
            if (fixed) {
              const index = sessions.findIndex((item) => item.session_id === session.session_id);
              if (index >= 0) sessions[index] = this.read(session.session_id);
              repaired.push({
                session_id: session.session_id,
                from_health_state: fromState,
                to_health_state: "converged",
                reason:
                  "outcome=converged but health=blocked; latest round has convergence.converged=true — recomputed health",
              });
            }
          }
        }
      }
    }
    const openSessions: SessionDoctorEntry[] = [];
    const staleSessions: SessionDoctorEntry[] = [];
    const blockedSessions: SessionDoctorEntry[] = [];
    const maxRoundsSessions: SessionDoctorEntry[] = [];
    const selfLeadMetadata: SessionDoctorEntry[] = [];
    const openEvidenceSessions: SessionDoctorEntry[] = [];
    const notResurfacedEvidenceSessions: SessionDoctorEntry[] = [];
    const grokProviderErrorSessions: SessionDoctorEntry[] = [];
    const eventReadErrorSessions: SessionDoctorEntry[] = [];
    const terminalEventMissingSessions: SessionDoctorEntry[] = [];
    const reviewedArtifactCustodyFailureSessions: SessionDoctorEntry[] = [];
    let eventsTotal = 0;
    let tokenDeltaEvents = 0;
    let tokenCompletedEvents = 0;
    let realSessions = 0;
    let stubSessions = 0;
    let peerCallCostUsd: number | null = null;
    let generationCostUsd: number | null = null;
    let failedAttemptCostUsd: number | null = null;
    let unpricedProviderAttempts = 0;
    let legacyAccountingSessions = 0;
    let totalCostUsd: number | null = null;
    let terminalEventMissingCount = 0;

    const pushLimited = (target: SessionDoctorEntry[], entry: SessionDoctorEntry): void => {
      if (target.length < cappedLimit) target.push(entry);
    };

    for (const session of sessions) {
      const scope = session.convergence_scope;
      const petitioner = scope?.petitioner ?? scope?.caller ?? session.caller;
      const leadPeer = scope?.lead_peer;
      const evidenceList = session.evidence_checklist ?? [];
      const openEvidenceItemsList = evidenceList.filter(
        (item) => (item.status ?? "open") === "open",
      );
      const openEvidenceItems = openEvidenceItemsList.length;
      const notResurfacedEvidenceItems = evidenceList.filter(
        (item) => item.status === "not_resurfaced",
      ).length;
      const grokProviderErrors = (session.failed_attempts ?? []).filter(
        (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
      ).length;
      const reviewedArtifactCustodyFailures =
        this.reviewedArtifactCustodyReportStatus(session).failures.length;
      if (isStubSession(session)) stubSessions += 1;
      else realSessions += 1;
      const costBreakdown = sessionCostBreakdown(session);
      peerCallCostUsd = addNullableCost(peerCallCostUsd, costBreakdown.peer_total);
      generationCostUsd = addNullableCost(generationCostUsd, costBreakdown.generation_total);
      failedAttemptCostUsd = addNullableCost(
        failedAttemptCostUsd,
        costBreakdown.failed_attempt_total,
      );
      unpricedProviderAttempts += costBreakdown.unpriced_failed_attempts;
      if (costBreakdown.accounting_coverage === "legacy_unknown") {
        legacyAccountingSessions += 1;
      }
      const sessionTotalCost = session.totals.cost.total_cost;
      if (sessionTotalCost != null && Number.isFinite(sessionTotalCost)) {
        totalCostUsd = addNullableCost(totalCostUsd, sessionTotalCost);
      }
      const entry: SessionDoctorEntry = {
        session_id: session.session_id,
        version: session.version,
        caller: session.caller,
        petitioner,
        lead_peer: leadPeer,
        outcome: session.outcome,
        outcome_reason: session.outcome_reason,
        health_state: session.convergence_health?.state,
        health_detail: session.convergence_health?.detail,
        rounds: session.rounds.length,
        updated_at: session.updated_at,
        ...(openEvidenceItems > 0 ? { open_evidence_items: openEvidenceItems } : {}),
        ...(notResurfacedEvidenceItems > 0
          ? { not_resurfaced_evidence_items: notResurfacedEvidenceItems }
          : {}),
        ...(grokProviderErrors > 0 ? { grok_provider_errors: grokProviderErrors } : {}),
        ...(reviewedArtifactCustodyFailures > 0
          ? { reviewed_artifact_custody_failures: reviewedArtifactCustodyFailures }
          : {}),
      };

      // v2.22.0 (B.P2): drill-down for open-evidence entries. Aggregate
      // open items by peer + flag chronic blockers (round_count >= 3).
      if (openEvidenceItems > 0) {
        const itemTypes: Partial<Record<PeerId, number>> = {};
        const chronicBlockers: string[] = [];
        for (const item of openEvidenceItemsList) {
          itemTypes[item.peer] = (itemTypes[item.peer] ?? 0) + 1;
          if (item.round_count >= 3) {
            chronicBlockers.push(item.id);
          }
        }
        entry.item_types = itemTypes;
        entry.chronic_blockers = chronicBlockers;
      }

      // v3.7.5 (A1, logs+sessions study 2026-05-15): terminal outcomes
      // are NEVER stale or blocked — they are DONE. Pre-v3.7.5 the
      // doctor classified solely on `convergence_health.state` which
      // markCancelled writes as "stale" on `outcome="aborted"`. Result:
      // 22 cancelled sessions of 244 (9%) were flagged as needing
      // attention when they were terminal. Likewise the v3.6.0 repair
      // path was the symmetric symptom for `outcome="converged" +
      // state="blocked"`. The classification fix keeps backward compat
      // with the 244 existing sessions on disk (no migration) and only
      // recognizes the truth at the consumer layer: if the session has
      // a terminal outcome, do not flag it as stale or blocked.
      const isTerminal = session.outcome != null;
      if (!session.outcome) pushLimited(openSessions, entry);
      if (!isTerminal && session.convergence_health?.state === "stale")
        pushLimited(staleSessions, entry);
      if (!isTerminal && session.convergence_health?.state === "blocked")
        pushLimited(blockedSessions, entry);
      if (session.outcome === "max-rounds" && includeTerminalFindings)
        pushLimited(maxRoundsSessions, entry);
      if (petitioner && leadPeer && petitioner === leadPeer) pushLimited(selfLeadMetadata, entry);
      if (openEvidenceItems > 0) pushLimited(openEvidenceSessions, entry);
      if (notResurfacedEvidenceItems > 0 && (!isTerminal || includeTerminalFindings))
        pushLimited(notResurfacedEvidenceSessions, entry);
      if (grokProviderErrors > 0) pushLimited(grokProviderErrorSessions, entry);
      if (reviewedArtifactCustodyFailures > 0) {
        pushLimited(reviewedArtifactCustodyFailureSessions, entry);
      }

      let sessionEvents: SessionEvent[] = [];
      try {
        sessionEvents = this.readEvents(session.session_id);
      } catch (error) {
        entry.event_read_error = redact(error instanceof Error ? error.message : String(error));
        pushLimited(eventReadErrorSessions, entry);
      }

      if (session.outcome) {
        const expectedTerminalEvent: "session.finalized" | "session.cancelled" =
          session.control?.status === "cancelled" || session.outcome_reason === "session_cancelled"
            ? "session.cancelled"
            : "session.finalized";
        const hasExpectedTerminalEvent = sessionEvents.some(
          (event) => event.type === expectedTerminalEvent,
        );
        if (!hasExpectedTerminalEvent) {
          terminalEventMissingCount += 1;
          entry.terminal_event_missing = true;
          entry.terminal_event_expected = expectedTerminalEvent;
          pushLimited(terminalEventMissingSessions, entry);
        }
      }

      for (const event of sessionEvents) {
        eventsTotal += 1;
        if (event.type === "peer.token.delta") tokenDeltaEvents += 1;
        if (event.type === "peer.token.completed") tokenCompletedEvents += 1;
      }
    }

    // v2.22.0 (A.P2): compute the headline self_lead_metadata count
    // BEFORE deciding whether to suppress the per-session array, so
    // `totals.self_lead_metadata` always reflects reality even when the
    // findings array is empty.
    const selfLeadCount = sessions.filter((session) => {
      const scope = session.convergence_scope;
      const petitioner = scope?.petitioner ?? scope?.caller ?? session.caller;
      return Boolean(petitioner && scope?.lead_peer && petitioner === scope.lead_peer);
    }).length;

    const recommendations: string[] = [];
    if (openSessions.length > 0) {
      recommendations.push(
        "Review open_sessions first; finalize, contest, cancel or explicitly continue each live case.",
      );
    }
    if (selfLeadCount > 0) {
      // Recommendation fires off the headline count, not the in-array
      // count, so operators are still nudged when the array is hidden.
      const baseAdvice =
        "Treat self_lead_metadata as legacy/protocol-drift evidence; do not rewrite historical records automatically.";
      if (!includeLegacy) {
        recommendations.push(
          `${baseAdvice} ${selfLeadCount} legacy sessions hidden by default — pass include_legacy=true to enumerate.`,
        );
      } else {
        recommendations.push(baseAdvice);
      }
    }
    if (openEvidenceSessions.length > 0) {
      recommendations.push(
        "Address or explicitly terminal-mark open evidence checklist items before expecting convergence.",
      );
    }
    if (notResurfacedEvidenceSessions.length > 0) {
      recommendations.push(
        "`not_resurfaced` evidence items are inference-only; review them separately from satisfied/deferred/rejected items.",
      );
    }
    if (grokProviderErrorSessions.length > 0) {
      recommendations.push(
        "Run a Grok-specific smoke/probe for sessions with grok provider errors before relying on Grok in release gates.",
      );
    }
    if (eventReadErrorSessions.length > 0) {
      recommendations.push(
        "Inspect event_read_error_sessions manually; malformed events.ndjson records were skipped for doctor aggregation but not modified.",
      );
    }
    if (eventsTotal > 0 && tokenDeltaEvents / eventsTotal > 0.5) {
      recommendations.push(
        "Token delta events dominate this corpus; increase CROSS_REVIEW_TOKEN_DELTA_CHARS_THRESHOLD or disable token streaming for low-noise audits.",
      );
    }
    if (terminalEventMissingCount > 0) {
      recommendations.push(
        "Terminal outcome metadata exists without matching terminal events; treat as legacy/event-gap evidence and inspect before relying on event-only analytics.",
      );
    }
    if (reviewedArtifactCustodyFailureSessions.length > 0) {
      recommendations.push(
        "Do not finalize or restore sessions with reviewed_artifact_custody_failures; inspect the persisted draft path, SHA-256 and byte count.",
      );
    }

    return {
      generated_at: now(),
      scope: "all",
      limit: cappedLimit,
      totals: {
        sessions: sessions.length,
        real_sessions: realSessions,
        stub_sessions: stubSessions,
        open: sessions.filter((session) => !session.outcome).length,
        stale: sessions.filter(
          (session) => !session.outcome && session.convergence_health?.state === "stale",
        ).length,
        blocked: sessions.filter(
          (session) => !session.outcome && session.convergence_health?.state === "blocked",
        ).length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        self_lead_metadata: selfLeadCount,
        open_evidence_sessions: sessions.filter((session) =>
          (session.evidence_checklist ?? []).some((item) => (item.status ?? "open") === "open"),
        ).length,
        not_resurfaced_evidence_sessions: sessions.filter((session) =>
          (session.evidence_checklist ?? []).some((item) => item.status === "not_resurfaced"),
        ).length,
        grok_provider_error_sessions: sessions.filter((session) =>
          (session.failed_attempts ?? []).some(
            (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
          ),
        ).length,
        event_read_error_sessions: eventReadErrorSessions.length,
        terminal_event_missing_sessions: terminalEventMissingCount,
        reviewed_artifact_custody_failure_sessions: sessions.filter(
          (session) => this.reviewedArtifactCustodyReportStatus(session).status === "FAILED",
        ).length,
      },
      cost_breakdown: {
        total_cost_usd: totalCostUsd,
        peer_call_cost_usd: peerCallCostUsd,
        generation_cost_usd: generationCostUsd,
        failed_attempt_cost_usd: failedAttemptCostUsd,
        unpriced_provider_attempts: unpricedProviderAttempts,
        legacy_accounting_sessions: legacyAccountingSessions,
      },
      findings: {
        open_sessions: openSessions,
        stale_sessions: staleSessions,
        blocked_sessions: blockedSessions,
        max_rounds_sessions: maxRoundsSessions,
        // v2.22.0 (A.P2): suppress per-session enumeration unless
        // operator passes include_legacy=true. Headline count remains
        // in `totals.self_lead_metadata`.
        self_lead_metadata: includeLegacy ? selfLeadMetadata : [],
        open_evidence_sessions: openEvidenceSessions,
        not_resurfaced_evidence_sessions: notResurfacedEvidenceSessions,
        grok_provider_error_sessions: grokProviderErrorSessions,
        event_read_error_sessions: eventReadErrorSessions,
        terminal_event_missing_sessions: terminalEventMissingSessions,
        reviewed_artifact_custody_failure_sessions: reviewedArtifactCustodyFailureSessions,
      },
      event_noise: {
        events_total: eventsTotal,
        token_delta_events: tokenDeltaEvents,
        token_completed_events: tokenCompletedEvents,
        token_delta_ratio: eventsTotal > 0 ? tokenDeltaEvents / eventsTotal : null,
      },
      recommendations,
      // v3.6.0 (C): only present when repair was requested; lists the
      // converged+blocked contradictions that were recomputed.
      ...(repair ? { repaired } : {}),
    };
  }

  // v2.14.0 (item 1): compute precision/recall/F1 for the shadow judge
  // against empirical ground truth (whether peers raised the same ask
  // in a subsequent round). Walks events.ndjson per session, finds each
  // `session.evidence_judge_pass.shadow_decision` event, looks up the
  // matching item in `meta.evidence_checklist` by id, and classifies
  // based on (would_promote x ask_resurfaced). Returns per-peer rollup.
  computeJudgmentPrecisionReport(opts?: {
    peer?: PeerId | undefined;
    since?: string | undefined;
    session_id?: string | undefined;
  }): JudgmentPrecisionReport {
    const sessions = opts?.session_id ? [this.read(opts.session_id)] : this.list();
    const peerKnown: readonly PeerId[] = PEERS;
    const byPeer: Partial<Record<PeerId, JudgmentPrecisionPeerStats>> = {};
    let totalDecisions = 0;
    let totalWithGroundTruth = 0;
    let totalSkippedNoGT = 0;
    const acc = (peer: PeerId): JudgmentPrecisionPeerStats => {
      let entry = byPeer[peer];
      if (!entry) {
        entry = {
          judge_peer: peer,
          decisions_total: 0,
          decisions_with_ground_truth: 0,
          decisions_skipped_no_ground_truth: 0,
          true_positive: 0,
          false_positive: 0,
          true_negative: 0,
          false_negative: 0,
          precision: null,
          recall: null,
          f1: null,
          by_confidence: {},
        };
        byPeer[peer] = entry;
      }
      return entry;
    };
    for (const session of sessions) {
      const events = this.readEvents(session.session_id);
      const checklist = session.evidence_checklist ?? [];
      const itemById = new Map<string, EvidenceChecklistItem>();
      for (const item of checklist) itemById.set(item.id, item);
      const maxRound = session.rounds.length;
      for (const event of events) {
        const data = shadowDecisionData(event);
        if (!data) continue;
        const judgePeer = data.judge_peer;
        if (!judgePeer || !peerKnown.includes(judgePeer)) continue;
        if (opts?.peer && judgePeer !== opts.peer) continue;
        if (opts?.since && event.ts && event.ts < opts.since) continue;
        const itemId = data.item_id;
        if (!itemId) continue;
        const item = itemById.get(itemId);
        if (!item) continue;
        const judgeRound = event.round ?? item.last_round;
        const peerStats = acc(judgePeer);
        peerStats.decisions_total += 1;
        totalDecisions += 1;
        // Ground truth: did the ask resurface AFTER the judge ran?
        // last_round > judgeRound → resurfaced. last_round === judgeRound
        // AND maxRound > judgeRound → not resurfaced (we have evidence
        // peers had a chance to ask again and didn't). last_round ===
        // judgeRound AND maxRound === judgeRound → no ground truth.
        const resurfaced = item.last_round > judgeRound;
        const peersHadChance = maxRound > judgeRound;
        if (!resurfaced && !peersHadChance) {
          peerStats.decisions_skipped_no_ground_truth += 1;
          totalSkippedNoGT += 1;
          continue;
        }
        peerStats.decisions_with_ground_truth += 1;
        totalWithGroundTruth += 1;
        const wouldPromote = data.would_promote === true;
        let bucket: "tp" | "fp" | "tn" | "fn";
        if (wouldPromote && !resurfaced) bucket = "tp";
        else if (wouldPromote && resurfaced) bucket = "fp";
        else if (!wouldPromote && resurfaced) bucket = "tn";
        else bucket = "fn";
        if (bucket === "tp") peerStats.true_positive += 1;
        else if (bucket === "fp") peerStats.false_positive += 1;
        else if (bucket === "tn") peerStats.true_negative += 1;
        else peerStats.false_negative += 1;
        if (data.confidence) {
          let bc = peerStats.by_confidence[data.confidence];
          if (!bc) {
            bc = { tp: 0, fp: 0, tn: 0, fn: 0 };
            peerStats.by_confidence[data.confidence] = bc;
          }
          bc[bucket] += 1;
        }
      }
    }
    // Compute precision/recall/f1 per peer.
    for (const peer of Object.keys(byPeer) as PeerId[]) {
      const stats = byPeer[peer];
      if (!stats) continue;
      const tp = stats.true_positive;
      const fp = stats.false_positive;
      const fn = stats.false_negative;
      stats.precision = tp + fp > 0 ? tp / (tp + fp) : null;
      stats.recall = tp + fn > 0 ? tp / (tp + fn) : null;
      stats.f1 =
        stats.precision != null && stats.recall != null && stats.precision + stats.recall > 0
          ? (2 * stats.precision * stats.recall) / (stats.precision + stats.recall)
          : null;
    }
    return {
      generated_at: now(),
      peer_filter: opts?.peer,
      since_filter: opts?.since,
      session_filter: opts?.session_id,
      decisions_total: totalDecisions,
      decisions_with_ground_truth: totalWithGroundTruth,
      decisions_skipped_no_ground_truth: totalSkippedNoGT,
      by_judge_peer: byPeer,
    };
  }

  // v2.14.0 (path-A structural fix): resolve `meta.evidence_files[]`
  // entries into in-memory contents for inlining into peer prompts.
  // Reads each attachment from disk. A single selected artifact may consume
  // the complete UTF-16 budget; multiple artifacts use a 60% per-file cap to
  // leave room for at least one other attachment plus headers. The method
  // accumulates into a total cap and returns whatever fits. The active
  // automatic caller snapshot is read first. Superseded caller submissions
  // remain audit-only by default. The orchestrator may read them locally to
  // replay a previously grounded requester verdict against the corrected
  // checklist matcher, but they never re-enter a later peer prompt or current
  // evidence/truthfulness/grounding corpus.
  // Other custody channels retain their historical order. Files that cannot be read
  // (deleted, permission denied) are skipped silently — the caller
  // sees only the metadata that survived. This closes the recurring
  // "meta-channel limit" pattern (v2.5.0, v2.13.0) where codex demanded
  // evidence the MCP `caller → server` 200KB channel could not carry:
  // the file content already lives in `data_dir/sessions/<id>/evidence/`
  // by the time we inline, so the only constraint is the peer model's
  // context window — much larger than the MCP boundary.
  readEvidenceAttachments(
    sessionId: string,
    totalCapChars: number,
    callerSubmissionId?: string,
    includeHistoricalCallerSubmissions = false,
  ): ResolvedEvidenceAttachment[] {
    if (!Number.isFinite(totalCapChars) || totalCapChars <= 0) return [];
    let meta: SessionMeta;
    try {
      meta = this.read(sessionId);
    } catch {
      return [];
    }
    const allFiles = meta.evidence_files ?? [];
    if (!allFiles.length) return [];
    let files = allFiles;
    const activeSubmissionId = callerSubmissionId ?? meta.active_caller_evidence_submission_id;
    if (activeSubmissionId) {
      const activeSubmission = (meta.caller_evidence_submissions ?? []).find(
        (submission) => submission.submission_id === activeSubmissionId,
      );
      if (!activeSubmission) {
        throw new Error(
          `active_caller_evidence_submission_invalid: ${activeSubmissionId} has no persisted manifest`,
        );
      }
      const byPath = new Map(allFiles.map((file) => [file.path, file]));
      const activeFiles = activeSubmission.attachment_paths.map((attachmentPath) => {
        const file = byPath.get(attachmentPath);
        if (!file) {
          throw new Error(
            `evidence_integrity_unavailable: active caller submission ${activeSubmissionId} references ${attachmentPath}`,
          );
        }
        return file;
      });
      const nonCallerSubmissionFiles = allFiles.filter(
        (file) => currentEvidenceAttachment(file)?.origin !== "caller_submitted",
      );
      const activePaths = new Set(activeSubmission.attachment_paths);
      const selectedCallerPaths = new Set(activePaths);
      const historicalCallerFiles = includeHistoricalCallerSubmissions
        ? [...(meta.caller_evidence_submissions ?? [])]
            .reverse()
            .filter((submission) => submission.submission_id !== activeSubmissionId)
            .flatMap((submission) => submission.attachment_paths)
            .filter((attachmentPath) => {
              if (selectedCallerPaths.has(attachmentPath)) return false;
              selectedCallerPaths.add(attachmentPath);
              return true;
            })
            .map((attachmentPath) => {
              const file = byPath.get(attachmentPath);
              if (!file) {
                throw new Error(
                  `evidence_integrity_unavailable: historical caller submission references ${attachmentPath}`,
                );
              }
              return file;
            })
        : [];
      files = [...activeFiles, ...historicalCallerFiles, ...nonCallerSubmissionFiles];
    }
    const perFileCap =
      files.length === 1
        ? Math.floor(totalCapChars)
        : Math.max(2_000, Math.floor(totalCapChars * 0.6));
    const result: ResolvedEvidenceAttachment[] = [];
    let used = 0;
    for (const file of files) {
      const custody = currentEvidenceAttachment(file);
      let authenticated: ReturnType<SessionStore["readContainedRegularFile"]>;
      try {
        authenticated = this.readContainedRegularFile(sessionId, file.path, "evidence_integrity");
      } catch (error) {
        if (custody) {
          throw error;
        }
        continue;
      }
      const actualBytes = authenticated.bytes;
      const actualSha256 = authenticated.sha256;
      if (custody && (actualBytes !== custody.bytes || actualSha256 !== custody.sha256)) {
        throw new Error(
          `evidence_integrity_mismatch: ${file.path} expected sha256=${custody.sha256} bytes=${custody.bytes}, got sha256=${actualSha256} bytes=${actualBytes}`,
        );
      }
      const raw = authenticated.content;
      const remaining = totalCapChars - used;
      if (remaining <= 0) break;
      const cap = Math.min(perFileCap, remaining);
      const truncated = raw.length > cap;
      const slice = truncated ? utf16PrefixAtSafeBoundary(raw, cap) : raw;
      result.push({
        label: file.label,
        relative_path: file.path,
        content: slice,
        bytes: actualBytes,
        total_utf16_units: raw.length,
        truncated,
        provenance_status: custody ? "verified" : "legacy_unverified",
        authority_status: custody
          ? custody.attached_by === "operator"
            ? "operator_verified"
            : "caller_submitted_unverified"
          : "legacy_unverified",
        content_type: file.content_type,
        ...(custody
          ? {
              sha256: custody.sha256,
              attached_by: custody.attached_by,
              attached_at: custody.attached_at,
              origin: custody.origin,
            }
          : {}),
      });
      used += slice.length;
    }
    return result;
  }

  // v2.14.0 (item 4): contest a final verdict. Stamps the contested
  // session's meta with the contestation record AND initializes a new
  // session that references back. Validates the original session is
  // in a final state (converged | aborted | max-rounds). Per the
  // tribunal-colegiado memory, this is the canonical "caller NOT_READY
  // → novo ciclo deliberativo dentro dos mesmos autos" surface — the
  // original session is preserved (append-only); a new session opens
  // for re-deliberation with a fresh task + initial_draft and a
  // structural reference back to the contested session.
  async contestVerdict(params: {
    session_id: string;
    reason: string;
    new_task: string;
    new_initial_draft?: string | undefined;
    new_caller?: PeerId | "operator" | undefined;
  }): Promise<{ contested_meta: SessionMeta; new_session_id: string }> {
    if (!params.new_caller) {
      throw new Error(
        "new_caller_required: contestVerdict requires an explicitly authenticated new session caller.",
      );
    }
    const newCaller: PeerId | "operator" = params.new_caller;
    let newSessionId: string | undefined;
    // Validation, successor creation and original stamping are serialized by
    // the original session lock. Before this boundary two concurrent contests
    // could both observe `contestation` as absent, create two successors and
    // let the last writer orphan the first chain link.
    const contestedMeta = await this.withSessionLock(params.session_id, async () => {
      const original = this.read(params.session_id);
      if (!original.outcome) {
        throw new Error(
          `cannot_contest_in_flight_session: session ${params.session_id} has no outcome yet (still in flight). Wait for it to converge or finalize before contesting.`,
        );
      }
      if (original.contestation) {
        throw new Error(
          `session_already_contested: session ${params.session_id} was already contested at ${original.contestation.contested_at} (new_session_id=${original.contestation.new_session_id}).`,
        );
      }

      // A contest opens a new deliberative cycle inside the same autos.  The
      // capability snapshot and review focus are custody metadata, not
      // disposable runtime decoration, so preserve them unless a higher layer
      // supplies a freshly probed successor later.
      const newSession = await this.init(
        params.new_task,
        newCaller,
        original.capability_snapshot,
        original.review_focus,
      );
      newSessionId = newSession.session_id;
      if (params.new_initial_draft !== undefined) {
        this.saveDraft(newSession.session_id, 0, params.new_initial_draft);
      }
      // Cross-link successor → original while the original contest right is
      // exclusively held. Lock ordering is original then newly-created child;
      // no other path can hold the child and wait for its not-yet-linked parent.
      await this.withSessionLock(newSession.session_id, async () => {
        const successor = this.read(newSession.session_id);
        successor.contests_session_id = params.session_id;
        successor.updated_at = now();
        await writeJson(this.metaPath(newSession.session_id), successor);
      });

      original.contestation = {
        contested_at: now(),
        reason: params.reason,
        original_outcome: original.outcome ?? null,
        new_session_id: newSession.session_id,
      };
      original.updated_at = now();
      await writeJson(this.metaPath(params.session_id), original);
      return original;
    });
    if (!newSessionId) throw new Error("contest_successor_creation_failed");
    return { contested_meta: contestedMeta, new_session_id: newSessionId };
  }

  async attachCallerEvidenceSubmission(
    sessionId: string,
    params: {
      submitted_by: PeerId | "operator";
      artifact_text: string;
      items: Array<{
        label: string;
        content: string;
        content_type?: string;
        extension?: string;
      }>;
    },
  ): Promise<{ submission: CallerEvidenceSubmission; meta: SessionMeta }> {
    if (params.submitted_by !== "operator" && !PEERS.includes(params.submitted_by)) {
      throw new Error(`evidence_submitted_by_invalid: ${String(params.submitted_by)}`);
    }
    const submissionId = crypto.randomUUID();
    const artifactSha256 = crypto
      .createHash("sha256")
      .update(params.artifact_text, "utf8")
      .digest("hex");
    const prepared = params.items.map((item) => {
      const persisted = Buffer.from(redact(item.content), "utf8");
      return {
        label: item.label,
        safeLabel: safeFilePart(item.label),
        extension: safeFilePart(item.extension ?? "txt").replace(/\./g, "") || "txt",
        content_type: item.content_type,
        persisted,
        sha256: crypto.createHash("sha256").update(persisted).digest("hex"),
        bytes: persisted.byteLength,
      };
    });

    return this.withSessionLock(sessionId, async () => {
      const current = this.read(sessionId);
      if (current.outcome) {
        const error = new Error(
          `session_already_finalized: session ${sessionId} is finalized with outcome="${current.outcome}"; cannot submit caller evidence`,
        );
        (error as Error & { code?: string }).code = "session_already_finalized";
        throw error;
      }
      const submittedAt = now();
      const attachmentPaths: string[] = [];
      const attachmentEvents: RuntimeEvent[] = [];
      for (const item of prepared) {
        const duplicate = (current.evidence_files ?? []).find((candidate) => {
          const currentCandidate = currentEvidenceAttachment(candidate);
          return (
            currentCandidate?.sha256 === item.sha256 &&
            currentCandidate.bytes === item.bytes &&
            currentCandidate.attached_by === params.submitted_by &&
            currentCandidate.origin === "caller_submitted" &&
            currentCandidate.label === item.label
          );
        });
        if (duplicate) {
          attachmentPaths.push(duplicate.path);
          continue;
        }
        const relativePath =
          `evidence/${timestampFilePart()}-${item.safeLabel}-${crypto.randomUUID()}.${item.extension}`.replace(
            /\\/g,
            "/",
          );
        const file = path.join(this.sessionDir(sessionId), relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, item.persisted);
        const attachment: EvidenceAttachment = {
          ts: submittedAt,
          attached_at: submittedAt,
          attached_by: params.submitted_by,
          origin: "caller_submitted",
          integrity_version: 1,
          sha256: item.sha256,
          bytes: item.bytes,
          label: item.label,
          path: relativePath,
          content_type: item.content_type,
        };
        current.evidence_files = [...(current.evidence_files ?? []), attachment];
        attachmentPaths.push(relativePath);
        attachmentEvents.push({
          type: "session.evidence_attached",
          session_id: sessionId,
          ts: submittedAt,
          message: `Caller-submitted evidence persisted as unverified material from ${params.submitted_by}: ${item.label}`,
          data: {
            label: item.label,
            path: relativePath,
            content_type: item.content_type,
            sha256: item.sha256,
            bytes: item.bytes,
            attached_by: params.submitted_by,
            attached_at: submittedAt,
            origin: "caller_submitted",
            authority_status: "caller_submitted_unverified",
          },
        });
      }
      const submission: CallerEvidenceSubmission = {
        submission_id: submissionId,
        submitted_at: submittedAt,
        submitted_by: params.submitted_by,
        artifact_sha256: artifactSha256,
        attachment_paths: attachmentPaths,
      };
      current.caller_evidence_submissions = [
        ...(current.caller_evidence_submissions ?? []),
        submission,
      ];
      current.active_caller_evidence_submission_id = submissionId;
      current.updated_at = submittedAt;
      await writeJson(this.metaPath(sessionId), current);
      for (const event of attachmentEvents) await this.appendEventRecord(event);
      await this.appendEventRecord({
        type: "session.caller_evidence_submission_activated",
        session_id: sessionId,
        ts: submittedAt,
        message: `Activated caller evidence submission ${submissionId} from ${params.submitted_by} with ${attachmentPaths.length} artifact(s).`,
        data: {
          submission_id: submissionId,
          submitted_by: params.submitted_by,
          artifact_sha256: artifactSha256,
          attachment_paths: attachmentPaths,
          attachment_count: attachmentPaths.length,
        },
      });
      return { submission, meta: current };
    });
  }

  async attachEvidence(
    sessionId: string,
    params: {
      label: string;
      content: string;
      content_type?: string;
      extension?: string;
      attached_by: PeerId | "operator";
      origin: EvidenceAttachmentOrigin;
      deduplicate?: boolean;
    },
  ): Promise<{ path: string; meta: SessionMeta }> {
    if (params.attached_by !== "operator" && !PEERS.includes(params.attached_by)) {
      throw new Error(`evidence_attached_by_invalid: ${String(params.attached_by)}`);
    }
    if (!EVIDENCE_ATTACHMENT_ORIGINS.has(params.origin)) {
      throw new Error(`evidence_origin_invalid: ${String(params.origin)}`);
    }
    const extension = safeFilePart(params.extension ?? "txt").replace(/\./g, "") || "txt";
    const label = safeFilePart(params.label);
    const persisted = Buffer.from(redact(params.content), "utf8");
    const sha256 = crypto.createHash("sha256").update(persisted).digest("hex");
    const bytes = persisted.byteLength;

    const meta = await this.withSessionLock(sessionId, async () => {
      const current = this.read(sessionId);
      if (current.outcome) {
        const error = new Error(
          `session_already_finalized: session ${sessionId} is finalized with outcome="${current.outcome}"; cannot attach evidence`,
        );
        (error as Error & { code?: string }).code = "session_already_finalized";
        throw error;
      }
      if (params.deduplicate) {
        const duplicate = (current.evidence_files ?? []).find((candidate) => {
          const currentCandidate = currentEvidenceAttachment(candidate);
          return (
            currentCandidate?.sha256 === sha256 &&
            currentCandidate.bytes === bytes &&
            currentCandidate.attached_by === params.attached_by &&
            currentCandidate.origin === params.origin
          );
        });
        if (duplicate) {
          return { meta: current, path: duplicate.path };
        }
      }
      const attachedAt = now();
      const relativePath =
        `evidence/${timestampFilePart()}-${label}-${crypto.randomUUID()}.${extension}`.replace(
          /\\/g,
          "/",
        );
      const file = path.join(this.sessionDir(sessionId), relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, persisted);
      const attachment: EvidenceAttachment = {
        ts: attachedAt,
        attached_at: attachedAt,
        attached_by: params.attached_by,
        origin: params.origin,
        integrity_version: 1,
        sha256,
        bytes,
        label: params.label,
        path: relativePath,
        content_type: params.content_type,
      };
      current.evidence_files = [...(current.evidence_files ?? []), attachment];
      current.updated_at = attachedAt;
      await writeJson(this.metaPath(sessionId), current);
      await this.appendEventRecord({
        type: "session.evidence_attached",
        session_id: sessionId,
        ts: attachedAt,
        message:
          params.origin === "caller_submitted" && params.attached_by !== "operator"
            ? `Caller-submitted evidence persisted as unverified material from ${params.attached_by}: ${params.label}`
            : `Evidence attached by ${params.attached_by}: ${params.label}`,
        data: {
          label: params.label,
          path: relativePath,
          content_type: params.content_type,
          sha256,
          bytes,
          attached_by: params.attached_by,
          attached_at: attachedAt,
          origin: params.origin,
          authority_status:
            params.attached_by === "operator" ? "operator_verified" : "caller_submitted_unverified",
        },
      });
      return { meta: current, path: relativePath };
    });

    return { path: meta.path, meta: meta.meta };
  }

  async escalateToOperator(
    sessionId: string,
    params: { reason: string; severity: "info" | "warning" | "critical" },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.operator_escalations = [
        ...(meta.operator_escalations ?? []),
        { ts: now(), reason: params.reason, severity: params.severity },
      ];
      const transitionedAt = now();
      meta.convergence_health = transitionHealth(
        meta,
        meta.outcome === "converged" ? "converged" : "blocked",
        `Operator escalation requested: ${params.reason}`,
        transitionedAt,
      );
      meta.updated_at = transitionedAt;
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async sweepIdle(
    idleMs: number,
    outcome: "aborted" | "max-rounds" = "aborted",
    reason = "stale",
  ): Promise<SessionMeta[]> {
    const effectiveIdleMs = Math.max(idleMs, SWEEP_MIN_IDLE_MS);
    const nowMs = Date.now();
    const swept: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome) continue;
      const updatedAt = Date.parse(session.updated_at);
      const idleFor = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
      if (idleFor < effectiveIdleMs) continue;
      const finalized = await this.withSessionLock(session.session_id, async () => {
        const current = this.read(session.session_id);
        if (current.outcome) return undefined;
        if (current.in_flight || current.generation_in_flight) return undefined;
        if (current.control?.status === "cancel_requested") {
          return this.persistCancelledTerminal(current, "session_cancelled");
        }
        const ts = now();
        delete current.control;
        current.outcome = outcome;
        current.outcome_reason = reason;
        current.convergence_health = transitionHealth(
          current,
          outcome === "aborted" ? "aborted" : "blocked",
          reason,
          ts,
          { idle_ms: idleFor },
        );
        current.updated_at = ts;
        await writeJson(this.metaPath(session.session_id), current);
        try {
          await this.appendEventRecord({
            type: "session.finalized",
            session_id: session.session_id,
            ts,
            message: `Session finalized as ${outcome}${reason ? `: ${reason}` : ""}`,
            data: { outcome, reason, idle_ms: idleFor },
          });
        } catch {
          /* event persistence is best-effort; session_doctor will flag gaps */
        }
        try {
          this.saveReport(
            session.session_id,
            this.renderSessionReport(current, this.readEvents(session.session_id)),
          );
        } catch {
          /* report regeneration is best-effort; meta.json remains authoritative */
        }
        return current;
      });
      if (finalized) swept.push(finalized);
    }
    return swept;
  }

  // v2.4.0 / audit closure (P1.3 companion): boot sweep of orphan .tmp
  // files. Crashes inside writeJson (between writeFileSync and renameSync)
  // leave files matching `<basename>.<pid>.<ts>.<nonce>.tmp` in the session
  // directory. Walk every session dir at boot, drop files matching the
  // .tmp pattern whose holder pid is dead OR whose timestamp is older than
  // 1h. Idempotent + best-effort. Returns counts for telemetry.
  // v3.7.5 (B1, logs+sessions study 2026-05-15): prune the
  // `<data_dir>/corrupt_sessions/` quarantine directory. Created
  // historically when meta.json corruption was severe enough to move
  // the whole session dir (one such case from the 2026-05-08 v2.25.1
  // redact escape-boundary bug remains on disk). Pre-v3.7.5 there was
  // no automated cleanup — the entries accumulated forever even after
  // root-cause fixes shipped. This method scans the directory and
  // removes subdirectories whose mtime is older than `minAgeMs`,
  // leaving fresher cases for forensic inspection. Read-only when the
  // dir does not exist. Errors per-entry are swallowed and surface as
  // `kept` so a single permission failure doesn't abort the sweep.
  pruneCorruptSessions(minAgeMs: number): { scanned: number; removed: number; kept: number } {
    const corruptDir = path.join(this.config.data_dir, "corrupt_sessions");
    if (!fs.existsSync(corruptDir)) return { scanned: 0, removed: 0, kept: 0 };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(corruptDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, removed: 0, kept: 0 };
    }
    const cutoff = Date.now() - Math.max(0, minAgeMs);
    let scanned = 0;
    let removed = 0;
    let kept = 0;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      scanned += 1;
      const entryPath = path.join(corruptDir, ent.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(entryPath).mtimeMs;
      } catch {
        kept += 1;
        continue;
      }
      if (mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed += 1;
      } catch {
        kept += 1;
      }
    }
    return { scanned, removed, kept };
  }

  sweepOrphanTmpFiles(): { scanned: number; removed: number } {
    let scanned = 0;
    let removed = 0;
    const root = this.sessionsDir();
    if (!fs.existsSync(root)) return { scanned, removed };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return { scanned, removed };
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionPath = path.join(root, ent.name);
      let files: string[];
      try {
        files = fs.readdirSync(sessionPath);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = TMP_FILE_PATTERN.exec(f);
        if (!m) continue;
        scanned += 1;
        const tmpPid = Number.parseInt(m[1] ?? "", 10);
        const tmpTs = Number.parseInt(m[2] ?? "", 10);
        const tmpAge = Date.now() - tmpTs;
        const holderAlive = Number.isInteger(tmpPid) ? this.processAlive(tmpPid) : false;
        if (!holderAlive || tmpAge > TMP_STALE_AFTER_MS) {
          try {
            fs.unlinkSync(path.join(sessionPath, f));
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { scanned, removed };
  }

  /**
   * Reconcile non-review provider calls (currently initial generations and
   * evidence judges) after a host crash. These calls do not always own an
   * `in_flight` review round, so clearStaleInFlight cannot see them. A live
   * owner is an explicit stop signal: another MCP host may still be settling
   * the same provider call and its result must retain the reservation.
   */
  async clearStalePendingProviderCalls(): Promise<{ scanned: number; cleared: number }> {
    let scanned = 0;
    let cleared = 0;
    for (const session of this.list()) {
      const pending = session.pending_provider_call_reservations ?? [];
      if (session.outcome || pending.length === 0) continue;
      scanned += 1;
      if (pending.some((reservation) => this.pendingProviderCallOwnerIsAlive(reservation))) {
        continue;
      }
      try {
        let recovered: SessionMeta | undefined;
        await this.withSessionLock(session.session_id, async () => {
          const current = this.read(session.session_id);
          const currentPending = current.pending_provider_call_reservations ?? [];
          if (
            current.outcome ||
            currentPending.length === 0 ||
            currentPending.some((reservation) => this.pendingProviderCallOwnerIsAlive(reservation))
          ) {
            return;
          }
          if (current.control?.status === "cancel_requested") {
            recovered = await this.persistCancelledTerminal(current, "session_cancelled");
            cleared += 1;
            return;
          }
          const reconciled = this.accountInterruptedPendingProviderCalls(
            current,
            "startup_pending_provider_call_sweep",
          );
          if (reconciled === 0) return;
          const transitionedAt = now();
          current.control = {
            status: "recovered_after_restart",
            reason:
              `${reconciled} paid provider call(s) were interrupted after their dispatch ` +
              "marker was persisted; billing is conservatively marked unknown.",
            job_id: current.control?.job_id,
            owner_pid: current.control?.owner_pid,
            requested_at: current.control?.requested_at,
            updated_at: transitionedAt,
          };
          current.convergence_health = transitionHealth(
            current,
            "stale",
            "Recovered outstanding paid provider call reservations after MCP restart.",
            transitionedAt,
          );
          current.updated_at = transitionedAt;
          await writeJson(this.metaPath(current.session_id), current);
          recovered = current;
          cleared += 1;
        });
        if (recovered && !recovered.outcome) {
          await this.appendEvent({
            type: "session.pending_provider_calls_recovered",
            session_id: recovered.session_id,
            ts: recovered.updated_at,
            message:
              "Startup sweep reconciled paid provider calls whose owning process was no longer alive.",
            data: {
              pending_provider_calls_recovered: true,
              billing_status: "unknown",
            },
          });
          const reported = this.read(recovered.session_id);
          this.saveReport(
            reported.session_id,
            this.renderSessionReport(reported, this.readEvents(reported.session_id)),
          );
        }
      } catch {
        /* best-effort; a later startup or explicit recovery can retry safely */
      }
    }
    return { scanned, cleared };
  }

  // v2.4.0 / audit closure (P3.11): clear stale meta.in_flight at boot.
  // `markInFlight` sets meta.in_flight before each round and clearInFlight
  // is supposed to clear it on resolve/reject. If the host crashes
  // mid-spawn, in_flight stays set forever — confusing audit consumers
  // and `recoverInterruptedSessions` consumers that read it as "round in
  // progress". sweepIdle clears in_flight only after 24h idle (footgun
  // floor). This companion sweep covers the common host-crash case where
  // we want to reconcile in_flight as soon as the new boot starts, not
  // after a day. Conditions to clear:
  //   - holder pid (lock holder, if any) is dead, OR
  //   - in_flight.started_at is older than HEARTBEAT_STALE_AFTER_MS.
  // Sessions still actively running on a live PID, or with a live reserved
  // provider call, are skipped. Idempotent + best-effort. Returns counts for
  // telemetry.
  async clearStaleInFlight(): Promise<{ scanned: number; cleared: number }> {
    const HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
    let scanned = 0;
    let cleared = 0;
    for (const session of this.list()) {
      if (!session.in_flight) continue;
      scanned += 1;
      const livePendingProviderCall = (session.pending_provider_call_reservations ?? []).some(
        (reservation) => this.pendingProviderCallOwnerIsAlive(reservation),
      );
      if (livePendingProviderCall) continue;
      if (this.inFlightOwnerIsAlive(session)) continue;
      const startedIso = session.in_flight.started_at;
      const startedAge = startedIso ? Date.now() - Date.parse(startedIso) : Infinity;
      // v4.1.0: lock-holder freshness is reported by proper-lockfile's
      // mtime-based stale detection. lockfile.check returns true if the
      // lock is actively held (mtime within `stale` ms), false otherwise.
      // This replaces the pre-v4.1.0 PID-aliveness check, which had
      // collision risk after PID-recycling restart.
      let holderAlive: boolean;
      try {
        holderAlive = await lockfile.check(this.metaPath(session.session_id), {
          stale: 120_000,
          realpath: false,
          lockfilePath: path.join(this.sessionDir(session.session_id), ".lock"),
        });
      } catch {
        // metaPath missing or unreadable: treat as no active holder.
        holderAlive = false;
      }
      // Fallback heartbeat staleness signal when no active lock and
      // started_at indicates the in_flight marker itself is stale.
      const appendedConvergenceAwaitingSeal =
        inFlightRoundAlreadyAppended(session) &&
        session.rounds.at(-1)?.convergence.converged === true &&
        (session.pending_provider_call_reservations?.length ?? 0) === 0;
      if (
        !holderAlive &&
        Number.isFinite(startedAge) &&
        startedAge <= HEARTBEAT_STALE_AFTER_MS &&
        !appendedConvergenceAwaitingSeal
      ) {
        // No live holder but started_at is recent; do nothing yet (lock
        // may have been released cleanly; let normal finalize handle it).
        continue;
      }
      if (!holderAlive || startedAge > HEARTBEAT_STALE_AFTER_MS) {
        try {
          let recoveredConvergedRound: ReviewRound | undefined;
          let recoveredConvergedSession: SessionMeta | undefined;
          let recoveredInterruptedSession: SessionMeta | undefined;
          await this.withSessionLock(session.session_id, async () => {
            const current = this.read(session.session_id);
            if (!current.in_flight) return;
            const currentLivePendingProviderCall = (
              current.pending_provider_call_reservations ?? []
            ).some((reservation) => this.pendingProviderCallOwnerIsAlive(reservation));
            if (currentLivePendingProviderCall) return;
            if (this.inFlightOwnerIsAlive(current)) return;
            const recoveredRound = this.sealRecoveredAppendedConvergence(current);
            if (recoveredRound) {
              recoveredConvergedRound = recoveredRound;
              recoveredConvergedSession = current;
              await writeJson(this.metaPath(current.session_id), current);
              cleared += 1;
              return;
            }
            const interruptedRound = current.in_flight.round;
            const appendedReservation = inFlightRoundAlreadyAppended(current);
            if (!appendedReservation) {
              this.accountInterruptedInFlight(current, "stale_in_flight_sweep");
            }
            const brokerRollback = appendedReservation
              ? undefined
              : restoreInterruptedEvidenceBrokerSnapshot(current);
            delete current.in_flight;
            // in_flight is the broader accounting envelope; never leave a
            // narrower generation marker behind for a second recovery charge.
            delete current.generation_in_flight;
            const previousControl = current.control;
            const reason = appendedReservation
              ? `The background owner exited after durable round ${interruptedRound} was appended. Start a new round to continue from saved session context.`
              : `Round ${interruptedRound} was interrupted before completion. Start a new round to continue from saved session context.`;
            const transitionedAt = now();
            if (previousControl?.job_id) {
              const interruptedJob = this.readBackgroundJobStatus(
                current.session_id,
                previousControl.job_id,
              );
              if (interruptedJob?.status === "running") {
                await this.writeBackgroundJobStatus({
                  ...interruptedJob,
                  status: previousControl.status === "cancel_requested" ? "cancelled" : "failed",
                  completed_at: transitionedAt,
                  error: `background_job_recovered_after_restart: ${reason}`,
                });
              }
            }
            current.control = {
              status: "recovered_after_restart",
              reason,
              job_id: previousControl?.job_id,
              owner_pid: previousControl?.owner_pid,
              requested_at: previousControl?.requested_at,
              updated_at: transitionedAt,
            };
            current.convergence_health = transitionHealth(
              current,
              "stale",
              `Recovered interrupted round ${interruptedRound} during the startup sweep. Start a new round to continue from saved session context.`,
              transitionedAt,
            );
            current.updated_at = transitionedAt;
            await writeJson(this.metaPath(session.session_id), current);
            if (brokerRollback) {
              await this.appendEventRecord({
                type: "session.evidence_broker_transaction_rolled_back",
                session_id: current.session_id,
                round: brokerRollback.round,
                message: `Evidence Broker mutations from stale round ${brokerRollback.round} were rolled back during the startup sweep.`,
                data: { ...brokerRollback, cause: "stale_in_flight_sweep" },
              });
            }
            recoveredInterruptedSession = current;
            cleared += 1;
          });
          if (recoveredConvergedSession && recoveredConvergedRound) {
            this.restoreFinalArtifactFromRound(recoveredConvergedSession, recoveredConvergedRound);
            try {
              await this.appendEvent({
                type: "session.finalized",
                session_id: recoveredConvergedSession.session_id,
                ts: recoveredConvergedSession.updated_at,
                message:
                  "Session finalized as converged: startup sweep recovered appended unanimous round",
                data: {
                  outcome: "converged",
                  reason: recoveredConvergedSession.outcome_reason ?? "unanimous_ready",
                  recovered_after_restart: true,
                  round: recoveredConvergedRound.round,
                },
              });
            } catch {
              /* event persistence is best-effort; session_doctor will flag gaps */
            }
            try {
              const reported = this.read(recoveredConvergedSession.session_id);
              this.saveReport(
                reported.session_id,
                this.renderSessionReport(reported, this.readEvents(reported.session_id)),
              );
            } catch {
              /* report regeneration is best-effort; meta.json remains authoritative */
            }
          }
          if (recoveredInterruptedSession) {
            try {
              await this.appendEvent({
                type: "session.recovered_after_restart",
                session_id: recoveredInterruptedSession.session_id,
                ts: recoveredInterruptedSession.updated_at,
                message:
                  recoveredInterruptedSession.control?.reason ??
                  "Startup sweep recovered an interrupted review round.",
                data: {
                  recovered_after_restart: true,
                  source: "stale_in_flight_sweep",
                },
              });
            } catch {
              /* event persistence is best-effort; session_doctor will flag gaps */
            }
            try {
              const reported = this.read(recoveredInterruptedSession.session_id);
              this.saveReport(
                reported.session_id,
                this.renderSessionReport(reported, this.readEvents(reported.session_id)),
              );
            } catch {
              /* report regeneration is best-effort; meta.json remains authoritative */
            }
          }
        } catch {
          /* best-effort */
        }
      }
    }
    return { scanned, cleared };
  }

  // v2.5.0: abort sessions that were never finalized.
  //
  // Empirical analysis of 253 historical sessions surfaced 22 in-progress
  // orphans where every peer had reached READY but the dedicated operator
  // console never invoked `session_finalize`. Those sessions stayed at `outcome:
  // undefined` indefinitely, polluting `session_list` and stealing rows
  // from `session_recover_interrupted` consumers that interpret a missing
  // outcome as "still running".
  //
  // The session-start contract (orchestrator.ts > sessionContractDirectives
  // rule 4) now requires the caller to notify the human operator; this boot
  // sweep cleans up cases where the operator console never finalized after
  // that notification. It is a companion to `clearStaleInFlight`, with a
  // longer threshold because the failure mode is "host died after a
  // session ran", not "host died mid-round".
  //
  // Conditions to abort:
  //   - meta.outcome is undefined (not finalized);
  //   - meta.in_flight is absent (i.e. the in-flight sweep already ran or
  //     the session was never marked in-flight); a still-in-flight session
  //     is the inFlight sweep's job, not ours;
  //   - no active lock holder, OR the session is past the staleness
  //     threshold (default 24h via CROSS_REVIEW_STALE_HOURS).
  //
  // Idempotent + best-effort. Returns counts for telemetry.
  async abortStaleSessions(staleHours?: number): Promise<{ scanned: number; aborted: number }> {
    const envHours = Number.parseFloat(process.env.CROSS_REVIEW_STALE_HOURS ?? "");
    const hours =
      staleHours != null && staleHours > 0
        ? staleHours
        : Number.isFinite(envHours) && envHours > 0
          ? envHours
          : 24;
    const staleThresholdMs = hours * 60 * 60 * 1000;
    let scanned = 0;
    let aborted = 0;
    for (const session of this.list()) {
      // Already finalized? Skip.
      if (session.outcome) continue;
      // Currently in-flight? Don't race the in-flight sweep — let it
      // either clear in_flight (next pass aborts) or leave it in place
      // (legitimate running session, must not be touched).
      if (session.in_flight) continue;
      scanned += 1;
      // v4.1.0: lock-holder freshness via proper-lockfile mtime-based
      // stale detection. lockfile.check returns true if a live holder
      // is touching the lockfile mtime within `stale` ms.
      let holderAlive: boolean;
      try {
        holderAlive = await lockfile.check(this.metaPath(session.session_id), {
          stale: 120_000,
          realpath: false,
          lockfilePath: path.join(this.sessionDir(session.session_id), ".lock"),
        });
      } catch {
        holderAlive = false;
      }
      if (holderAlive) continue;
      const lastTouched = Date.parse(session.updated_at);
      if (!Number.isFinite(lastTouched)) continue;
      if (Date.now() - lastTouched < staleThresholdMs) continue;
      try {
        await this.finalize(session.session_id, "aborted", `stale_no_finalize_${hours}h`);
        aborted += 1;
      } catch {
        /* best-effort */
      }
    }
    return { scanned, aborted };
  }
}
