import { z } from "zod";
import type { DecisionQuality, PeerStructuredStatus, ReviewStatus } from "./types.js";

const STATUS_VALUES = ["READY", "NOT_READY", "NEEDS_EVIDENCE"] as const satisfies ReviewStatus[];
const CONFIDENCE_VALUES = ["verified", "inferred", "unknown"] as const;
// v2.5.0: differentiated per-field caps. Empirical analysis of 253 historical
// sessions showed 36 `summary_truncated_to_800` warnings (all on
// claude-as-peer) while evidence_sources items rarely tripped the cap.
// Operator directive 2026-05-03: "summary curto, evidence_sources detalhado".
// Summary stays compact (800) to enforce concise verdict surfacing; evidence
// headroom (2500) lets peers paste the diff/grep/log line that proves the
// claim; caller_requests/follow_ups (1500) sit in between because they tend
// to enumerate multi-step asks but shouldn't degrade into prose either.
const MAX_SUMMARY_LENGTH = 800;
const MAX_EVIDENCE_LENGTH = 2500;
const MAX_REQUEST_LENGTH = 1500;
const MAX_ARRAY_ITEMS = 30;
// v2.4.0 / audit closure (P1.4): byte-level cap on each candidate JSON
// payload BEFORE JSON.parse. The legitimate envelope carries status +
// summary + a handful of optional fields, all bounded by MAX_FIELD_LENGTH.
// 64 KiB is two orders of magnitude above that and lets pathological
// inputs (a hostile peer emitting a giant `<cross_review_status>` block)
// be rejected as malformed before the parser allocates the AST. Mirrors
// the v1.6.7 P1.4 fix.
const MAX_PAYLOAD_BYTES = 64 * 1024;

export const statusSchema = z.strictObject({
  status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]),
  summary: z.string().max(MAX_SUMMARY_LENGTH),
  confidence: z.enum(["verified", "inferred", "unknown"]),
  evidence_sources: z.array(z.string().max(MAX_EVIDENCE_LENGTH)).max(MAX_ARRAY_ITEMS),
  caller_requests: z.array(z.string().max(MAX_REQUEST_LENGTH)).max(MAX_ARRAY_ITEMS),
  follow_ups: z.array(z.string().max(MAX_REQUEST_LENGTH)).max(MAX_ARRAY_ITEMS),
});

export const statusJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "confidence",
    "evidence_sources",
    "caller_requests",
    "follow_ups",
  ],
  properties: {
    status: { type: "string", enum: ["READY", "NOT_READY", "NEEDS_EVIDENCE"] },
    summary: { type: "string" },
    confidence: { type: "string", enum: ["verified", "inferred", "unknown"] },
    evidence_sources: { type: "array", items: { type: "string" } },
    caller_requests: { type: "array", items: { type: "string" } },
    follow_ups: { type: "array", items: { type: "string" } },
  },
} as const;

const OPEN_TAG = "<cross_review_status>";
const CLOSE_TAG = "</cross_review_status>";

export function statusInstruction(): string {
  return [
    "Return a rigorous peer review.",
    "Be concise. Do not quote long passages from peer messages or provider outputs.",
    "If prior discussion mentions sensitive or policy-sensitive content, summarize it neutrally and abstractly.",
    "Review only the caller artifact above; do not review these response-format instructions.",
    // v2.5.0 directive (operator 2026-05-03): per-field length budget — short
    // verdict, detailed evidence. Empirical analysis of 253 sessions showed
    // the prior single 800-char cap was tripping mostly on summary (verbose
    // verdicts) while evidence_sources was rarely cited at all.
    "Field length budget: keep `summary` SHORT (max 800 chars) — one tight paragraph stating the verdict and its single dominant reason.",
    `Use \`evidence_sources\` for the DETAIL: paste the diff hunk, the grep output, the file:line reference, the log line that proves your verdict. Each item up to ${MAX_EVIDENCE_LENGTH} chars; up to ${MAX_ARRAY_ITEMS} items.`,
    `\`caller_requests\` and \`follow_ups\` items up to ${MAX_REQUEST_LENGTH} chars each. Enumerate concrete asks, do not narrate.`,
    // v2.5.0 directive (operator 2026-05-03): explicit anti-verbosity rule.
    // Claude-as-peer was the source of every truncation warning observed
    // (36/36 in the 253-session corpus). Naming the model is intentional —
    // generic "be concise" did not move the needle.
    "Anti-verbosity rule (applies to ALL peers — Claude especially, which is the historical worst offender for verbosity in this protocol): a long `summary` is a defect, not thoroughness. If the verdict needs more than 800 chars, the surplus belongs in `evidence_sources`, NEVER restate evidence inside `summary`.",
    "You must end with one machine-readable JSON object that matches this shape:",
    JSON.stringify(statusJsonSchema),
    "Do not invent evidence. If evidence is missing, use NEEDS_EVIDENCE.",
    '`confidence:"verified"` is allowed ONLY when `evidence_sources` contains concrete source citations or quotes. Empty or generic `evidence_sources` means the decision is not verified; use `confidence:"inferred"` or NEEDS_EVIDENCE instead.',
    "READY always requires at least one concrete evidence source, including when confidence is inferred. An empty list, generic assurance, or an otherwise empty code fence is a lazy non-decision and will be downgraded to NEEDS_EVIDENCE.",
    `READY must be lossless and canonical: confidence cannot be unknown, \`summary\` must be exactly ${JSON.stringify(READY_CANONICAL_SUMMARY)}, and both \`caller_requests\` and \`follow_ups\` must be empty. Put all detailed findings and citations in \`evidence_sources\`. Any other READY wording is downgraded to NEEDS_EVIDENCE.`,
    "For READY, return only the machine-readable JSON object (optionally inside the documented status tag or a JSON fence). Narrative prose outside that envelope is ambiguous and will be downgraded to NEEDS_EVIDENCE.",
    "For current runtime/version/model/pricing claims, task framing is not evidence. Cite raw `server_info`, `runtime_capabilities`, `probe_peers`, `capability_snapshot`, provider docs/API output, or attached evidence.",
    "READY means you have no remaining blocking objection.",
    "NOT_READY means concrete corrections remain.",
    "NEEDS_EVIDENCE means you require specific external evidence before deciding.",
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && STATUS_VALUES.includes(value as ReviewStatus);
}

function truncateField(
  field: string,
  value: string,
  maxLength: number,
  warnings: string[],
): string {
  if (value.length <= maxLength) return value;
  warnings.push(`${field}_truncated_to_${maxLength}`);
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeStringArray(
  field: keyof Pick<PeerStructuredStatus, "evidence_sources" | "caller_requests" | "follow_ups">,
  value: unknown,
  itemMaxLength: number,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${field}_dropped_non_array`);
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) warnings.push(`${field}_dropped_non_string_items`);
  if (strings.length > MAX_ARRAY_ITEMS)
    warnings.push(`${field}_truncated_to_${MAX_ARRAY_ITEMS}_items`);

  return strings
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item, index) => truncateField(`${field}_${index}`, item, itemMaxLength, warnings));
}

function normalizeStructuredStatus(
  value: unknown,
  warnings: string[],
): PeerStructuredStatus | null {
  if (!isObject(value) || !isReviewStatus(value.status)) return null;

  const normalized: PeerStructuredStatus = { status: value.status };

  if (typeof value.summary === "string") {
    normalized.summary = truncateField("summary", value.summary, MAX_SUMMARY_LENGTH, warnings);
  } else if (value.summary !== undefined) {
    warnings.push("summary_dropped_non_string");
  }

  if (
    typeof value.confidence === "string" &&
    CONFIDENCE_VALUES.includes(value.confidence as never)
  ) {
    normalized.confidence = value.confidence as PeerStructuredStatus["confidence"];
  } else if (value.confidence !== undefined) {
    warnings.push("confidence_dropped_invalid_value");
  }

  const evidenceSources = normalizeStringArray(
    "evidence_sources",
    value.evidence_sources,
    MAX_EVIDENCE_LENGTH,
    warnings,
  );
  if (evidenceSources) normalized.evidence_sources = evidenceSources;

  const callerRequests = normalizeStringArray(
    "caller_requests",
    value.caller_requests,
    MAX_REQUEST_LENGTH,
    warnings,
  );
  if (callerRequests) normalized.caller_requests = callerRequests;

  const followUps = normalizeStringArray(
    "follow_ups",
    value.follow_ups,
    MAX_REQUEST_LENGTH,
    warnings,
  );
  if (followUps) normalized.follow_ups = followUps;

  const parsed = statusSchema.safeParse(normalized);
  if (!parsed.success) {
    warnings.push(`status_normalization_failed:${parsed.error.message.slice(0, 300)}`);
    return null;
  }

  return parsed.data;
}

function extractJsonKeyStatus(candidate: string): ReviewStatus | null {
  const match = candidate.match(/"status"\s*:\s*"(READY|NOT_READY|NEEDS_EVIDENCE)"/);
  return match ? (match[1] as ReviewStatus) : null;
}

function hasDuplicateJsonProperty(candidate: string): boolean {
  type JsonFrame = { kind: "object"; keys: Set<string>; expectingKey: boolean } | { kind: "array" };
  const stack: JsonFrame[] = [];

  let index = 0;
  while (index < candidate.length) {
    const char = candidate[index];
    if (char === '"') {
      const stringStart = index;
      index += 1;
      while (index < candidate.length) {
        if (candidate[index] === "\\") {
          index += 2;
          continue;
        }
        if (candidate[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }

      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectingKey) {
        let afterString = index;
        while (/\s/.test(candidate[afterString] ?? "")) afterString += 1;
        if (candidate[afterString] === ":") {
          let key: unknown;
          try {
            key = JSON.parse(candidate.slice(stringStart, index));
          } catch {
            // Malformed JSON is handled by the normal parser below.
            return false;
          }
          if (typeof key === "string") {
            if (frame.keys.has(key)) return true;
            frame.keys.add(key);
            frame.expectingKey = false;
          }
        }
      }
      continue;
    }

    if (char === "{") {
      stack.push({ kind: "object", keys: new Set<string>(), expectingKey: true });
    } else if (char === "[") {
      stack.push({ kind: "array" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectingKey = true;
    }
    index += 1;
  }
  return false;
}

const CONCRETE_EVIDENCE_SOURCE_PATTERN =
  /https?:\/\/|@@\s*[-+]|\bevidence[\\/][\w./-]+\b|\bAttachment:\s*\S|["“][^"”\r\n]{12,}["”]|\bEXIT[_ ]?CODE\s*[:=]\s*\d+\b|\bTest Files\s+\d+\s+(?:passed|failed)\b|\bTests?\s+\d+\s+(?:passed|failed)\b|\btest result:\s*(?:ok|FAILED)\b/i;

export const READY_CANONICAL_SUMMARY = "No blocking objections remain.";

function normalizeResponseNarrative(text: string): string {
  return text
    .replace(/```(?:json)?/gi, " ")
    .replaceAll("```", " ")
    .replaceAll(OPEN_TAG, " ")
    .replaceAll(CLOSE_TAG, " ")
    .trim();
}

function hasConcreteJsonEvidence(source: string): boolean {
  const trimmed = source.trim();
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) return false;
  try {
    const parsed = JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
    if (!isObject(parsed)) return false;
    const entries = Object.entries(parsed);
    if (entries.length < 2) return false;
    const selfDescribingRuntimeKeys = new Set([
      "version",
      "release_date",
      "model",
      "status",
      "peer",
    ]);
    return entries.some(([key, value]) => {
      if (selfDescribingRuntimeKeys.has(key.toLowerCase())) return false;
      if (isObject(value) || Array.isArray(value)) return true;
      return typeof value === "number" || typeof value === "boolean" || String(value).length >= 4;
    });
  } catch {
    return false;
  }
}

function isConcreteEvidenceSource(source: string): boolean {
  return CONCRETE_EVIDENCE_SOURCE_PATTERN.test(source) || hasConcreteJsonEvidence(source);
}

function enforceReadyInvariants(
  structured: PeerStructuredStatus,
  warnings: string[],
  responseNarrative = "",
): PeerStructuredStatus {
  if (structured.status !== "READY") return structured;

  const lossy = warnings.some(
    (warning) =>
      warning.includes("truncated") ||
      warning.includes("dropped") ||
      warning.includes("recovered_after_schema_warning"),
  );
  if (lossy) {
    warnings.push("ready_rejected_lossy_parse");
    return {
      ...structured,
      status: "NEEDS_EVIDENCE",
      caller_requests: [
        ...(structured.caller_requests ?? []),
        "Return a complete, non-truncated structured verdict before claiming readiness.",
      ].slice(0, MAX_ARRAY_ITEMS),
    };
  }

  if (structured.confidence === "unknown") {
    warnings.push("ready_with_unknown_confidence");
    return {
      ...structured,
      status: "NEEDS_EVIDENCE",
      caller_requests: [
        ...(structured.caller_requests ?? []),
        "Resolve the stated uncertainty and cite concrete evidence before claiming readiness.",
      ].slice(0, MAX_ARRAY_ITEMS),
    };
  }

  if (structured.summary !== READY_CANONICAL_SUMMARY) {
    warnings.push("ready_noncanonical_summary");
    return {
      ...structured,
      status: "NEEDS_EVIDENCE",
      caller_requests: [
        ...(structured.caller_requests ?? []),
        `Use the exact canonical READY summary: ${READY_CANONICAL_SUMMARY}`,
      ].slice(0, MAX_ARRAY_ITEMS),
    };
  }

  if (responseNarrative.trim().length > 0) {
    warnings.push("ready_with_external_narrative");
    return {
      ...structured,
      status: "NEEDS_EVIDENCE",
      caller_requests: [
        ...(structured.caller_requests ?? []),
        "Return READY only as the complete machine-readable status object, without narrative outside its envelope.",
      ].slice(0, MAX_ARRAY_ITEMS),
    };
  }

  if ((structured.caller_requests ?? []).length > 0) {
    warnings.push("ready_with_caller_requests");
    return { ...structured, status: "NEEDS_EVIDENCE" };
  }

  if ((structured.follow_ups ?? []).length > 0) {
    warnings.push("ready_with_follow_ups");
    return { ...structured, status: "NEEDS_EVIDENCE" };
  }

  return structured;
}

function enforceTruthfulnessStatus(
  structured: PeerStructuredStatus,
  warnings: string[],
  responseNarrative = "",
): PeerStructuredStatus {
  const contradictionChecked = enforceReadyInvariants(structured, warnings, responseNarrative);
  if (contradictionChecked.status !== "READY") return contradictionChecked;
  structured = contradictionChecked;
  if (structured.confidence !== "verified" && structured.status !== "READY") return structured;
  const evidenceSources = (structured.evidence_sources ?? [])
    .map((source) => source.trim())
    .filter(Boolean);
  let evidenceWarning: string | undefined;
  if (!evidenceSources.length) {
    evidenceWarning =
      structured.confidence === "verified"
        ? "verified_without_evidence_sources"
        : "ready_without_evidence_sources";
  } else {
    const hasConcreteEvidence = evidenceSources.some(isConcreteEvidenceSource);
    if (!hasConcreteEvidence) {
      evidenceWarning =
        structured.confidence === "verified"
          ? "verified_without_concrete_evidence_sources"
          : "ready_without_concrete_evidence_sources";
    }
  }
  if (!evidenceWarning) return structured;
  warnings.push(evidenceWarning);
  if (structured.status !== "READY") return structured;
  warnings.push("ready_downgraded_to_needs_evidence");
  return {
    ...structured,
    status: "NEEDS_EVIDENCE",
    caller_requests: [
      ...(structured.caller_requests ?? []),
      "Provide concrete evidence sources before claiming verified readiness.",
    ].slice(0, MAX_ARRAY_ITEMS),
  };
}

export function parsePeerStatus(text: string): {
  status: ReviewStatus | null;
  structured: PeerStructuredStatus | null;
  parser_warnings: string[];
} {
  const warnings: string[] = [];
  const trimmed = text.trim();
  const candidates: Array<{ json: string; source: string }> = [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push({ json: trimmed, source: "raw_object" });
  }

  const openAt = trimmed.lastIndexOf(OPEN_TAG);
  const closeAt = trimmed.lastIndexOf(CLOSE_TAG);
  if (openAt >= 0 && closeAt > openAt) {
    candidates.push({
      json: trimmed.slice(openAt + OPEN_TAG.length, closeAt).trim(),
      source: "status_tag",
    });
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const block of fenced.reverse()) {
    candidates.push({
      json: block
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim(),
      source: "fenced_json",
    });
  }

  const lastBrace = trimmed.lastIndexOf("{");
  if (lastBrace >= 0) candidates.push({ json: trimmed.slice(lastBrace), source: "last_brace" });

  for (const candidate of candidates) {
    // v2.4.0 / audit closure (P1.4): reject oversized candidate before
    // JSON.parse so a hostile peer can't OOM the orchestrator with a giant
    // structured block. Byte-level (Buffer.byteLength) so multi-byte
    // UTF-8 doesn't slip past a char-length check.
    if (Buffer.byteLength(candidate.json, "utf8") > MAX_PAYLOAD_BYTES) {
      warnings.push(`status_candidate_dropped_oversized:${candidate.source}`);
      continue;
    }
    if (hasDuplicateJsonProperty(candidate.json)) {
      warnings.push(`status_candidate_rejected_duplicate_property:${candidate.source}`);
      return { status: null, structured: null, parser_warnings: warnings };
    }
    try {
      const json = JSON.parse(candidate.json) as unknown;
      const parsed = statusSchema.safeParse(json);
      const candidateAt = trimmed.lastIndexOf(candidate.json);
      const responseNarrative =
        candidateAt >= 0
          ? normalizeResponseNarrative(
              `${trimmed.slice(0, candidateAt)} ${trimmed.slice(candidateAt + candidate.json.length)}`,
            )
          : trimmed;
      if (parsed.success) {
        if (candidate.source === "fenced_json") warnings.push("status_json_extracted_from_fence");
        if (candidate.source === "status_tag") warnings.push("status_json_extracted_from_tag");
        const structured = enforceTruthfulnessStatus(parsed.data, warnings, responseNarrative);
        return {
          status: structured.status,
          structured,
          parser_warnings: warnings,
        };
      }

      const recoveryWarnings = [...warnings, parsed.error.message.slice(0, 500)];
      const normalized = normalizeStructuredStatus(json, recoveryWarnings);
      if (normalized) {
        if (candidate.source === "fenced_json")
          recoveryWarnings.push("status_json_extracted_from_fence");
        if (candidate.source === "status_tag")
          recoveryWarnings.push("status_json_extracted_from_tag");
        recoveryWarnings.push("status_json_recovered_after_schema_warning");
        const structured = enforceTruthfulnessStatus(
          normalized,
          recoveryWarnings,
          responseNarrative,
        );
        return {
          status: structured.status,
          structured,
          parser_warnings: recoveryWarnings,
        };
      }

      warnings.push(parsed.error.message.slice(0, 500));
    } catch {
      const recoveredStatus = extractJsonKeyStatus(candidate.json);
      if (recoveredStatus) {
        warnings.push(`status_recovery_rejected_incomplete_contract:${candidate.source}`);
      }
    }
  }

  const legacy = trimmed.match(/STATUS:\s*(READY|NOT_READY|NEEDS_EVIDENCE)\s*$/);
  if (legacy) {
    warnings.push("legacy_status_rejected_incomplete_contract");
  }

  return { status: null, structured: null, parser_warnings: warnings };
}

export function decisionQualityFromStatus(
  status: ReviewStatus | null,
  parserWarnings: string[],
): DecisionQuality {
  if (status == null) return "needs_operator_review";
  if (
    parserWarnings.some(
      (warning) =>
        warning.includes("recovered") ||
        warning.includes("format_recovery_retry_succeeded") ||
        warning.includes("decision_retry_succeeded") ||
        warning.includes("moderation_safe_retry_succeeded") ||
        warning.includes("truncated") ||
        warning.includes("dropped"),
    )
  ) {
    return "recovered";
  }
  if (parserWarnings.length) return "format_warning";
  return "clean";
}
