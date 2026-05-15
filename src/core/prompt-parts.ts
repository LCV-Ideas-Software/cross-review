// v2.21.0 (caching): canonical prompt-parts builder.
//
// Splits a peer-bound prompt into three layers ordered by stability:
//
//   1. stablePrefix: schema_version + system role + task + review_focus +
//      convergence rules + ordered evidence_index (paths only, NO
//      timestamps). Identical across rounds for the same case so
//      providers can cache the prefix tokens.
//   2. semiStableContext: evidence file CONTENTS + checklist current
//      state. Changes when the caller anexa new evidence or the
//      checklist mutates.
//   3. dynamicRound: round number, draft, prior round responses,
//      in-flight peer state. Changes every round by design.
//
// Critical invariant: changing only round / draft / priorRounds MUST
// NOT change the stablePrefix hash. The smoke harness tests this via
// `cache_hash_invariance_test`; a regression would silently invalidate
// every provider's cache hit on every round (a real money leak).
//
// Hash: sha256 hex of the LF-normalized stablePrefix string. CRLF is
// replaced before hashing so checking the same case from a Windows
// editor does not produce a different hash than CI on Linux.

import crypto from "node:crypto";
import type { PeerId } from "./types.js";

export interface PromptPartsInput {
  cacheSchemaVersion: string;
  systemRole: string;
  task: string;
  reviewFocus?: string | undefined;
  convergenceRules: string;
  /** Sorted list of evidence paths only — NO contents, NO timestamps. */
  evidenceIndex: string[];
  /** Evidence file CONTENTS — semi-stable across rounds. */
  evidenceContent: string;
  round: number;
  draft: string;
  priorRounds?: string | undefined;
}

export interface PromptParts {
  stablePrefix: string;
  stablePrefixHash: string;
  semiStableContext: string;
  dynamicRound: string;
}

function lfNormalize(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Compute the canonical sha256 hex hash of a stablePrefix string. The
 * caller is expected to pass the EXACT string that goes to the provider,
 * minus CRLF. We re-normalize defensively so the hash is platform-stable
 * regardless of how the caller constructed the string.
 */
export function hashStablePrefix(stablePrefix: string): string {
  return crypto.createHash("sha256").update(lfNormalize(stablePrefix), "utf8").digest("hex");
}

/**
 * Build the three-layer prompt parts. The ORDER of fields inside
 * stablePrefix is locked: any reordering changes hashes for every
 * caller, which is the whole point of cache_schema_version. If you
 * change the structure, bump CROSS_REVIEW_CACHE_SCHEMA_VERSION so
 * existing caches drop.
 */
export function buildPromptParts(input: PromptPartsInput): PromptParts {
  const stablePrefixLines: string[] = [
    `cache_schema_version: ${input.cacheSchemaVersion}`,
    "",
    "## SYSTEM",
    input.systemRole,
    "",
    "## TASK",
    input.task,
  ];
  if (input.reviewFocus) {
    stablePrefixLines.push("", "## REVIEW_FOCUS", input.reviewFocus);
  }
  stablePrefixLines.push("", "## CONVERGENCE_RULES", input.convergenceRules);

  // Evidence INDEX only (paths sorted, no timestamps) belongs in the
  // stablePrefix because the set of attached files is stable for the
  // whole case; the file CONTENTS belong in semiStableContext (changes
  // when the caller anexa more material mid-session).
  const sortedIndex = [...input.evidenceIndex].sort();
  stablePrefixLines.push("", "## EVIDENCE_INDEX");
  if (sortedIndex.length === 0) {
    stablePrefixLines.push("(none)");
  } else {
    for (const p of sortedIndex) {
      stablePrefixLines.push(`- ${p}`);
    }
  }
  const stablePrefix = lfNormalize(stablePrefixLines.join("\n"));

  const semiStableContext = lfNormalize(
    [
      "## EVIDENCE_CONTENT",
      input.evidenceContent && input.evidenceContent.length > 0
        ? input.evidenceContent
        : "(no attached evidence)",
    ].join("\n"),
  );

  const dynamicLines: string[] = [`## ROUND ${input.round}`, "", "### DRAFT", input.draft];
  if (input.priorRounds && input.priorRounds.length > 0) {
    dynamicLines.push("", "### PRIOR_ROUNDS", input.priorRounds);
  }
  const dynamicRound = lfNormalize(dynamicLines.join("\n"));

  const stablePrefixHash = hashStablePrefix(stablePrefix);
  return { stablePrefix, stablePrefixHash, semiStableContext, dynamicRound };
}

/**
 * Test helper that asserts swapping ONLY round / draft / priorRounds
 * between two PromptPartsInput values produces an identical
 * stablePrefixHash. Throws if the invariant breaks. Used by the smoke
 * harness; exported so external callers can pin the contract.
 */
export function assertHashInvariant(input1: PromptPartsInput, input2: PromptPartsInput): void {
  const a = buildPromptParts(input1);
  const b = buildPromptParts(input2);
  if (a.stablePrefixHash !== b.stablePrefixHash) {
    throw new Error(
      `prompt-parts hash invariance broken: ${a.stablePrefixHash} != ${b.stablePrefixHash}`,
    );
  }
}

/**
 * Construct a pair-scoped cache key (peer:caller:<schema>) used as
 * prompt_cache_key in OpenAI/Grok and as the namespace seed in the
 * cache manifest. Pair-scoped means two different callers reviewing the
 * same case still share cache hits with the same peer; mixing across
 * caller identities is intentional because the system role + task body
 * differs by caller anyway.
 *
 * The `cacheSchemaVersion` is expected to already include the canonical
 * `v` prefix (e.g., "v1"). The function does NOT prepend another `v` —
 * cross-review R1 catch (codex + gemini, 2026-05-10): a pre-shipped
 * defect produced `:vv1` which violated the contract documented in
 * `docs/caching.md` (`cross-review:<peer>:<caller>:v<N>`).
 */
export function pairScopedCacheKey(
  peer: PeerId,
  caller: PeerId | "operator",
  cacheSchemaVersion: string,
): string {
  // Defensive: callers pass the canonical "v1"/"v2" form. If a caller
  // forgets the prefix and passes bare "1", we re-add it so the on-wire
  // key shape stays stable across env-var typos.
  const normalized = cacheSchemaVersion.startsWith("v")
    ? cacheSchemaVersion
    : `v${cacheSchemaVersion}`;
  return `cross-review:${peer}:${caller}:${normalized}`;
}
