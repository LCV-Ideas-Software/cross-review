import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { redact, redactJsonValue, safeErrorMessage } from "../security/redact.js";
import { blockConvergenceForUnresolvedEvidence } from "./convergence.js";
import { mergeCost, mergeUsage } from "./cost.js";
import { sessionCostBreakdown, sessionReportMarkdown } from "./reports.js";
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
  PreflightCheckRecord,
  ResolvedEvidenceAttachment,
  ReviewRound,
  ReviewStatus,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeMetrics,
  SessionDoctorEntry,
  SessionDoctorReport,
  SessionEvent,
  SessionMeta,
  ShadowJudgmentPeerStats,
  ShadowJudgmentRollup,
} from "./types.js";
import { PEERS } from "./types.js";

export const SWEEP_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
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

export function extractChecklistCodeSymbols(ask: string): string[] {
  const camelCaseSymbols = (ask.match(/\b[a-z][A-Za-z0-9]*\b/g) ?? []).filter((value) =>
    /[A-Z]/.test(value.slice(1)),
  );
  return [...camelCaseSymbols, ...(ask.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi) ?? [])].map(
    (value) => value.normalize("NFKC").toLowerCase(),
  );
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
  if (meta.totals === null || typeof meta.totals !== "object" || Array.isArray(meta.totals)) {
    return "totals must be an object";
  }
  return undefined;
}

function isStubSession(session: SessionMeta): boolean {
  const peerCosts = session.rounds.flatMap((round) => round.peers.map((peer) => peer.cost));
  const generationCosts = (session.generation_files ?? []).map((generation) => generation.cost);
  const failureCosts = (session.failed_attempts ?? []).map((failure) => failure.cost);
  const costs = [...peerCosts, ...generationCosts, ...failureCosts].filter(Boolean);
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

async function writeJson(file: string, data: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(TMP_NONCE_BYTES).toString("hex");
  const tmp = `${file}.${process.pid}.${Date.now()}.${nonce}.tmp`;
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
    const generations = meta.generation_files ?? [];
    const failedAttempts = meta.failed_attempts ?? [];
    return {
      usage: mergeUsage([
        ...peerResults.map((peer) => peer.usage),
        ...generations.map((generation) => generation.usage),
        ...failedAttempts.map((failure) => failure.usage),
      ]),
      cost: mergeCost([
        ...peerResults.map((peer) => peer.cost),
        ...generations.map((generation) => generation.cost),
        ...failedAttempts.map((failure) => failure.cost),
      ]),
    };
  }

  private accountInterruptedInFlight(meta: SessionMeta, reason: string): void {
    const inFlight = meta.in_flight;
    if (!inFlight) return;
    const elapsed = Math.max(0, Date.now() - Date.parse(inFlight.started_at));
    const unknownAttempts = inFlight.peers.map((peer) => {
      const snapshot = meta.capability_snapshot.find((entry) => entry.peer === peer);
      return {
        peer,
        provider: snapshot?.provider ?? peer,
        model: snapshot?.model ?? this.config.models[peer],
        failure_class: "provider_error" as const,
        message:
          `possible_provider_attempt_interrupted: ${reason}; ` +
          `round ${inFlight.round} ended without a durable provider result. ` +
          "At least one attempt is conservatively marked unpriced; exact billing requires provider reconciliation.",
        retryable: false,
        attempts: 1,
        latency_ms: Number.isFinite(elapsed) ? elapsed : 0,
        billing_status: "unknown" as const,
        unpriced_attempts: 1,
        round: inFlight.round,
      };
    });
    meta.failed_attempts = [...(meta.failed_attempts ?? []), ...unknownAttempts];
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
      round: pending.round,
    };
    meta.failed_attempts = [...(meta.failed_attempts ?? []), unknownAttempt];
    meta.totals = this.totalsFor(meta);
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
  ): Promise<SessionMeta> {
    const session_id = crypto.randomUUID();
    const initializedAt = now();
    // v2.22.0 (B.P3): snapshot the cost ceiling at session_init time so
    // budget pressure analysis is decoupled from later env-var mutation.
    // null when the operator runs without a session-level cost cap.
    const ceiling = this.config.budget.max_session_cost_usd;
    const meta: SessionMeta = {
      session_id,
      version: this.config.version,
      accounting_schema_version: 2,
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
    const terminalEvent =
      event.type === "session.finalized" ||
      event.type === "session.cancelled" ||
      event.type === "session.evidence_broker_transaction_rolled_back";
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
    if (meta.convergence_health) {
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

  saveDraft(sessionId: string, round: number, draft: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-draft.md`);
    fs.writeFileSync(file, redact(draft), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async saveGeneration(
    sessionId: string,
    round: number,
    result: GenerationResult,
    label = "generation",
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
      const artifact: GenerationArtifact = {
        ts: now(),
        round,
        label,
        peer: result.peer,
        path: relativePath,
        usage: result.usage,
        cost: result.cost,
        latency_ms: result.latency_ms,
        unpriced_attempts: result.unpriced_attempts,
      };
      meta.generation_files = [...(meta.generation_files ?? []), artifact];
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

  saveFinal(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "final.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveReport(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "session-report.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
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

  async recordPeerFailureAccounting(
    sessionId: string,
    round: number,
    failure: PeerFailure,
    label = "failure",
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
      draft_file?: string | undefined;
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
      const durableConvergence = blockConvergenceForUnresolvedEvidence(
        params.convergence,
        meta.evidence_checklist ?? [],
      );
      const round: ReviewRound = {
        round: meta.rounds.length + 1,
        started_at: params.started_at,
        completed_at: now(),
        caller_status: params.caller_status,
        draft_file: params.draft_file,
        prompt_file: params.prompt_file,
        peers: params.peers,
        rejected: params.rejected,
        convergence: durableConvergence,
      };
      meta.rounds.push(round);
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
      meta.circular_state = state;
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
    if (meta.in_flight) {
      if (!inFlightRoundAlreadyAppended(meta)) {
        this.accountInterruptedInFlight(meta, `cancelled: ${requestedReason}`);
        brokerRollback = restoreInterruptedEvidenceBrokerSnapshot(meta);
      }
    } else {
      this.accountInterruptedBackgroundGeneration(meta, `cancelled: ${requestedReason}`);
    }
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
      this.saveReport(sessionId, sessionReportMarkdown(meta, this.readEvents(sessionId)));
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
      const latestRound = meta.rounds.at(-1);
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
        this.saveReport(sessionId, sessionReportMarkdown(meta, this.readEvents(sessionId)));
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
        const id = crypto
          .createHash("sha256")
          .update(`${peer}:${trimmed}`)
          .digest("hex")
          .slice(0, 16);
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

  // v2.9.0: runtime-judge promotion path. Promotes an `open` item to
  // `addressed` ONLY — never touches terminal operator statuses, never
  // moves anything other than open. Atomic under the session lock.
  // Returns null when the item is not currently `open` (already
  // addressed, terminal, or missing) so the caller can skip emit.
  async markEvidenceItemAddressedByJudge(
    sessionId: string,
    itemId: string,
    params: { round: number; rationale: string; judge_peer: PeerId },
  ): Promise<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry } | null> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      const item = checklist.find((entry) => entry.id === itemId);
      if (!item) return null;
      const status: EvidenceChecklistStatus = item.status ?? "open";
      // Single allowed transition: open → addressed (judge). Terminal
      // statuses (satisfied/deferred/rejected) and already-addressed
      // items are NOT auto-mutated here.
      if (status !== "open") return null;
      const ts = now();
      const rationale = params.rationale.trim().slice(0, 800);
      item.status = "addressed";
      item.addressed_at_round = params.round;
      item.address_method = "judge";
      item.judge_rationale = rationale;
      const entry: EvidenceStatusHistoryEntry = {
        ts,
        item_id: itemId,
        from: "open",
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
      const orphanedBackgroundControl =
        (session.control?.status === "running" || session.control?.status === "cancel_requested") &&
        !session.in_flight;
      if (
        session.outcome ||
        activeSessionIds.has(session.session_id) ||
        (!session.in_flight && !session.generation_in_flight && !orphanedBackgroundControl)
      )
        continue;
      let actuallyRecovered = false;
      const updated = await this.withSessionLock(session.session_id, async () => {
        const current = this.read(session.session_id);
        const currentOrphanedBackgroundControl =
          (current.control?.status === "running" ||
            current.control?.status === "cancel_requested") &&
          !current.in_flight;
        if (
          current.outcome ||
          activeSessionIds.has(current.session_id) ||
          (!current.in_flight && !current.generation_in_flight && !currentOrphanedBackgroundControl)
        ) {
          return current;
        }
        const ownerPid = current.generation_in_flight?.owner_pid ?? current.control?.owner_pid;
        if (ownerPid && this.processAlive(ownerPid)) return current;
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
        const previousControl = current.control;
        const reason =
          round === undefined
            ? interruptedGeneration
              ? `Generation ${interruptedGeneration.peer}/round-${interruptedGeneration.round}/${interruptedGeneration.label} was interrupted before its result was durably accounted.`
              : previousControl?.status === "cancel_requested"
                ? `Cancellation was requested${previousControl.reason ? ` (${previousControl.reason})` : ""}, but the background owner exited before a durable round began.`
                : "The background owner exited before a durable round began. Start a new round to continue from saved session context."
            : `Round ${round} was interrupted before completion and can be resumed manually.`;
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
  // Reads each attachment from disk, applies a per-file cap (60% of the
  // total cap to leave room for at least 1 other attachment + headers),
  // accumulates into a total-cap, and returns whatever fits. The active
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
    let sessionDir: string;
    try {
      meta = this.read(sessionId);
      sessionDir = this.sessionDir(sessionId);
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
    const perFileCap = Math.max(2_000, Math.floor(totalCapChars * 0.6));
    const result: ResolvedEvidenceAttachment[] = [];
    let used = 0;
    for (const file of files) {
      const custody = currentEvidenceAttachment(file);
      const absolutePath = this.safeResolveContainedExistingPath(sessionDir, file.path);
      if (!absolutePath) {
        if (custody) {
          throw new Error(`evidence_integrity_unavailable: ${file.path}`);
        }
        continue;
      }
      let persisted: Buffer;
      try {
        persisted = fs.readFileSync(absolutePath);
      } catch (error) {
        if (custody) {
          throw new Error(`evidence_integrity_unavailable: ${file.path}`, { cause: error });
        }
        continue;
      }
      const actualBytes = persisted.byteLength;
      const actualSha256 = crypto.createHash("sha256").update(persisted).digest("hex");
      if (custody && (actualBytes !== custody.bytes || actualSha256 !== custody.sha256)) {
        throw new Error(
          `evidence_integrity_mismatch: ${file.path} expected sha256=${custody.sha256} bytes=${custody.bytes}, got sha256=${actualSha256} bytes=${actualBytes}`,
        );
      }
      const raw = persisted.toString("utf8");
      const remaining = totalCapChars - used;
      if (remaining <= 0) break;
      const cap = Math.min(perFileCap, remaining);
      const truncated = raw.length > cap;
      const slice = truncated ? raw.slice(0, cap) : raw;
      result.push({
        label: file.label,
        relative_path: file.path,
        content: slice,
        bytes: actualBytes,
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
            sessionReportMarkdown(current, this.readEvents(session.session_id)),
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
  // Sessions still actively running on a live PID are skipped. Idempotent
  // + best-effort. Returns counts for telemetry.
  async clearStaleInFlight(): Promise<{ scanned: number; cleared: number }> {
    const HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
    let scanned = 0;
    let cleared = 0;
    for (const session of this.list()) {
      if (!session.in_flight) continue;
      scanned += 1;
      const ownerPid = session.generation_in_flight?.owner_pid ?? session.control?.owner_pid;
      if (ownerPid && this.processAlive(ownerPid)) continue;
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
      if (!holderAlive && Number.isFinite(startedAge) && startedAge <= HEARTBEAT_STALE_AFTER_MS) {
        // No live holder but started_at is recent; do nothing yet (lock
        // may have been released cleanly; let normal finalize handle it).
        continue;
      }
      if (!holderAlive || startedAge > HEARTBEAT_STALE_AFTER_MS) {
        try {
          await this.withSessionLock(session.session_id, async () => {
            const current = this.read(session.session_id);
            if (!current.in_flight) return;
            const currentOwnerPid =
              current.generation_in_flight?.owner_pid ?? current.control?.owner_pid;
            if (currentOwnerPid && this.processAlive(currentOwnerPid)) return;
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
            current.updated_at = now();
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
            cleared += 1;
          });
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
