import { z } from "zod";
import type {
  DecisionQuality,
  DecisionTransformation,
  PeerStructuredStatus,
  ReviewStatus,
} from "./types.js";

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
// A citation may use the full hard cap when a decisive raw record genuinely
// needs it, but the prompt steers peers toward a much smaller literal. The
// grounding grammar needs only one value-corresponding excerpt, not a file or
// provider-output dump.
const TARGET_EVIDENCE_QUOTE_LENGTH = 500;
const MIN_EVIDENCE_QUOTE_LENGTH = 12;
const MAX_REQUEST_LENGTH = 1500;
const MAX_ARRAY_ITEMS = 30;
// v2.4.0 / audit closure (P1.4): byte-level cap on each candidate JSON
// payload BEFORE JSON.parse. The legitimate envelope carries status +
// summary + a handful of optional fields, all bounded by MAX_FIELD_LENGTH.
// The local schema permits 30 evidence items at 2500 chars plus 60 request/
// follow-up items at 1500 chars. JSON escaping can expand one code unit to six
// bytes, so a valid worst-case envelope approaches 1 MiB. Keep the byte guard
// aligned with that published contract while still rejecting unbounded hostile
// status blocks before JSON.parse allocates their AST.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

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
    summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH },
    confidence: { type: "string", enum: ["verified", "inferred", "unknown"] },
    evidence_sources: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string", maxLength: MAX_EVIDENCE_LENGTH },
    },
    caller_requests: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string", maxLength: MAX_REQUEST_LENGTH },
    },
    follow_ups: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string", maxLength: MAX_REQUEST_LENGTH },
    },
  },
} as const;

// The Zod schema and statusJsonSchema above are the complete local contract.
// Provider APIs accept different documented JSON-Schema subsets, so adapters
// must never treat the canonical schema as a universally portable wire shape.
// This minimal projection uses only the common structural keywords documented
// across the schema-capable providers; dimensional limits remain enforced by
// the prompt, normalization and Zod validation after the response arrives.
export const portableStatusJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: statusJsonSchema.required,
  properties: {
    status: statusJsonSchema.properties.status,
    summary: { type: "string" },
    confidence: statusJsonSchema.properties.confidence,
    evidence_sources: { type: "array", items: { type: "string" } },
    caller_requests: { type: "array", items: { type: "string" } },
    follow_ups: { type: "array", items: { type: "string" } },
  },
} as const;

// Gemini's published closed keyword list includes maxItems but not maxLength.
export const geminiStatusJsonSchema = {
  ...portableStatusJsonSchema,
  properties: {
    ...portableStatusJsonSchema.properties,
    evidence_sources: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string" },
    },
    caller_requests: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string" },
    },
    follow_ups: {
      type: "array",
      maxItems: MAX_ARRAY_ITEMS,
      items: { type: "string" },
    },
  },
} as const;

// xAI documents maxItems through 256 and guarantees maxLength through 2048.
// Keep the concise provider envelope inside those guarantees; the local
// evidence item cap intentionally remains 2500 for providers that support it.
export const grokStatusJsonSchema = {
  ...statusJsonSchema,
  properties: {
    ...statusJsonSchema.properties,
    evidence_sources: {
      ...statusJsonSchema.properties.evidence_sources,
      items: { type: "string", maxLength: 2048 },
    },
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
    "Use `evidence_sources` only for compact, literal citations that prove the verdict; keep rationale out of citation items.",
    "Canonical citation format for EACH `evidence_sources` string item:",
    "After JSON decoding, each item must contain these three lines in this exact order (encode the two line breaks as `\\n` in raw JSON):",
    'Attachment: <persisted-path>\nsha256=<64 lowercase hex>\nArtifact quote: "<literal text from that same attachment>"',
    `The \`Artifact quote\` must be at least ${MIN_EVIDENCE_QUOTE_LENGTH} characters and must be the last line at the end of the item; do not append rationale after it.`,
    `Cite the smallest sufficient literal, normally target at most ${TARGET_EVIDENCE_QUOTE_LENGTH} characters. The hard limit is ${MAX_EVIDENCE_LENGTH} characters for the whole item and ${MAX_ARRAY_ITEMS} items total; do not fill those limits unless the decisive raw record requires it.`,
    "Multiple sources must be separate `evidence_sources` array items. Never concatenate two attachments or two quotes into one item.",
    `\`caller_requests\` and \`follow_ups\` items up to ${MAX_REQUEST_LENGTH} chars each. Enumerate concrete asks, do not narrate.`,
    // v2.5.0 directive (operator 2026-05-03): explicit anti-verbosity rule.
    // Claude-as-peer was the source of every truncation warning observed
    // (36/36 in the 253-session corpus). Naming the model is intentional —
    // generic "be concise" did not move the needle.
    "Anti-verbosity and anti-shortcut rule (applies to ALL peers, including Claude): a long `summary` is a defect, not thoroughness, and `evidence_sources` is not a place for surplus narrative. Inspect the artifact, cite the smallest sufficient literal, and state only the verdict in `summary`. Do not dump full files, unbounded logs, or whole peer/provider outputs. Empty or generic assurances prove no review occurred and will be downgraded to NEEDS_EVIDENCE.",
    "You must end with one machine-readable JSON object that matches this shape:",
    JSON.stringify(statusJsonSchema),
    "Do not invent evidence. If evidence is missing, use NEEDS_EVIDENCE.",
    '`confidence:"verified"` is allowed ONLY when `evidence_sources` contains concrete source citations or quotes. Empty or generic `evidence_sources` means the decision is not verified; use `confidence:"inferred"` or NEEDS_EVIDENCE instead.',
    "READY always requires at least one concrete evidence source, including when confidence is inferred. A filename or digest without its correlated literal quote, an empty list, a generic assurance, or an otherwise empty code fence is a shortcut non-decision and will be downgraded to NEEDS_EVIDENCE.",
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

function canonicalReviewStatus(value: unknown): ReviewStatus | null {
  if (typeof value !== "string") return null;
  const canonical = value.toUpperCase();
  return STATUS_VALUES.includes(canonical as ReviewStatus) ? (canonical as ReviewStatus) : null;
}

function canonicalConfidence(value: unknown): PeerStructuredStatus["confidence"] | undefined {
  if (typeof value !== "string") return undefined;
  const canonical = value.toLowerCase();
  return CONFIDENCE_VALUES.includes(canonical as never)
    ? (canonical as PeerStructuredStatus["confidence"])
    : undefined;
}

function canonicalizeStructuredEnumCasing(value: unknown, warnings: string[]): unknown {
  if (!isObject(value)) return value;
  const status = canonicalReviewStatus(value.status);
  const confidence = canonicalConfidence(value.confidence);
  let changed = false;
  const canonical = { ...value };
  if (status && status !== value.status) {
    canonical.status = status;
    warnings.push("status_enum_casing_normalized");
    changed = true;
  }
  if (confidence && confidence !== value.confidence) {
    canonical.confidence = confidence;
    warnings.push("confidence_enum_casing_normalized");
    changed = true;
  }
  return changed ? canonical : value;
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
  if (!isObject(value)) return null;
  const status = canonicalReviewStatus(value.status);
  if (!status) return null;

  const normalized: PeerStructuredStatus = { status };

  if (typeof value.summary === "string") {
    normalized.summary = truncateField("summary", value.summary, MAX_SUMMARY_LENGTH, warnings);
  } else if (value.summary !== undefined) {
    warnings.push("summary_dropped_non_string");
  }

  const confidence = canonicalConfidence(value.confidence);
  if (confidence) {
    normalized.confidence = confidence;
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
  const match = candidate.match(/"status"\s*:\s*"(READY|NOT_READY|NEEDS_EVIDENCE)"/i);
  return canonicalReviewStatus(match?.[1]);
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

function recordDecisionTransformation(
  transformations: DecisionTransformation[],
  stage: string,
  from: ReviewStatus | null,
  to: ReviewStatus | null,
  rule: string,
  details?: Record<string, unknown>,
): void {
  transformations.push({
    stage,
    from,
    to,
    rule,
    reasons: [rule],
    ...(details ? { details } : {}),
  });
}

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
  transformations: DecisionTransformation[] = [],
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
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_rejected_lossy_parse",
    );
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
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_with_unknown_confidence",
    );
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
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_noncanonical_summary",
    );
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
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_with_external_narrative",
    );
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
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_with_caller_requests",
    );
    return { ...structured, status: "NEEDS_EVIDENCE" };
  }

  if ((structured.follow_ups ?? []).length > 0) {
    warnings.push("ready_with_follow_ups");
    recordDecisionTransformation(
      transformations,
      "ready_invariants",
      "READY",
      "NEEDS_EVIDENCE",
      "ready_with_follow_ups",
    );
    return { ...structured, status: "NEEDS_EVIDENCE" };
  }

  return structured;
}

function enforceTruthfulnessStatus(
  structured: PeerStructuredStatus,
  warnings: string[],
  responseNarrative = "",
  transformations: DecisionTransformation[] = [],
): PeerStructuredStatus {
  const contradictionChecked = enforceReadyInvariants(
    structured,
    warnings,
    responseNarrative,
    transformations,
  );
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
  recordDecisionTransformation(
    transformations,
    "truthfulness",
    "READY",
    "NEEDS_EVIDENCE",
    evidenceWarning,
    { secondary_rule: "ready_downgraded_to_needs_evidence" },
  );
  return {
    ...structured,
    status: "NEEDS_EVIDENCE",
    caller_requests: [
      ...(structured.caller_requests ?? []),
      "Provide concrete evidence sources before claiming verified readiness.",
    ].slice(0, MAX_ARRAY_ITEMS),
  };
}

export interface PeerStatusParseResult {
  status: ReviewStatus | null;
  raw_status: ReviewStatus | null;
  parsed_status: ReviewStatus | null;
  normalized_status: ReviewStatus | null;
  structured: PeerStructuredStatus | null;
  parser_warnings: string[];
  decision_transformations: DecisionTransformation[];
  /** @deprecated Compatibility alias; use decision_transformations. */
  status_transformations: DecisionTransformation[];
}

export function parsePeerStatus(text: string): PeerStatusParseResult {
  const warnings: string[] = [];
  const trimmed = text.trim();
  const candidates: Array<{ json: string; source: string }> = [];
  let observedRawStatus: ReviewStatus | null = null;

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
      return {
        status: null,
        raw_status: null,
        parsed_status: null,
        normalized_status: null,
        structured: null,
        parser_warnings: warnings,
        decision_transformations: [],
        status_transformations: [],
      };
    }
    try {
      const json = JSON.parse(candidate.json) as unknown;
      const rawStatus = isObject(json) ? canonicalReviewStatus(json.status) : null;
      if (rawStatus) observedRawStatus = rawStatus;
      const canonicalJson = canonicalizeStructuredEnumCasing(json, warnings);
      const parsed = statusSchema.safeParse(canonicalJson);
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
        const transformations: DecisionTransformation[] = [];
        const structured = enforceTruthfulnessStatus(
          parsed.data,
          warnings,
          responseNarrative,
          transformations,
        );
        return {
          status: structured.status,
          raw_status: rawStatus,
          parsed_status: parsed.data.status,
          normalized_status: structured.status,
          structured,
          parser_warnings: warnings,
          decision_transformations: transformations,
          status_transformations: transformations,
        };
      }

      const recoveryWarnings = [...warnings, parsed.error.message.slice(0, 500)];
      const normalized = normalizeStructuredStatus(canonicalJson, recoveryWarnings);
      if (normalized) {
        if (candidate.source === "fenced_json")
          recoveryWarnings.push("status_json_extracted_from_fence");
        if (candidate.source === "status_tag")
          recoveryWarnings.push("status_json_extracted_from_tag");
        recoveryWarnings.push("status_json_recovered_after_schema_warning");
        const transformations: DecisionTransformation[] = [];
        recordDecisionTransformation(
          transformations,
          "schema_recovery",
          rawStatus,
          normalized.status,
          "status_json_recovered_after_schema_warning",
        );
        const structured = enforceTruthfulnessStatus(
          normalized,
          recoveryWarnings,
          responseNarrative,
          transformations,
        );
        return {
          status: structured.status,
          raw_status: rawStatus,
          parsed_status: normalized.status,
          normalized_status: structured.status,
          structured,
          parser_warnings: recoveryWarnings,
          decision_transformations: transformations,
          status_transformations: transformations,
        };
      }

      warnings.push(parsed.error.message.slice(0, 500));
    } catch {
      const recoveredStatus = extractJsonKeyStatus(candidate.json);
      if (recoveredStatus) {
        observedRawStatus = recoveredStatus;
        warnings.push(`status_recovery_rejected_incomplete_contract:${candidate.source}`);
      }
    }
  }

  const legacy = trimmed.match(/STATUS:\s*(READY|NOT_READY|NEEDS_EVIDENCE)\s*$/);
  if (legacy) {
    observedRawStatus = legacy[1] as ReviewStatus;
    warnings.push("legacy_status_rejected_incomplete_contract");
  }

  return {
    status: null,
    raw_status: observedRawStatus,
    parsed_status: null,
    normalized_status: null,
    structured: null,
    parser_warnings: warnings,
    decision_transformations: [],
    status_transformations: [],
  };
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
