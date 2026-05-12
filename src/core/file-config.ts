// v3.1.0 (operator directive 2026-05-12): central config file.
//
// Before v3.1.0, every operational knob (models, reasoning_effort,
// per-peer pricing, budget ceilings, autowire judge/consensus, cache
// TTLs, perplexity sub-config, token-delta streaming thresholds, peer
// enable toggles) had to be declared as a `CROSS_REVIEW_*` env var in
// every one of the 7 MCP host configs. With the sexteto reaching ~100
// env vars per host × 7 hosts = ~700 redundant declarations to keep in
// sync, drift between hosts became routine and operator-toilsome.
//
// This module introduces a single source-of-truth JSON file. cross-
// review-v2 reads it at boot, validates with zod, and pre-populates
// `process.env` with the env-var names that the existing
// `loadConfig()` pipeline already consumes. Effect: file values become
// defaults; explicit env-var overrides (from MCP host config or Windows
// registry) still win because the existing envValue() pipeline checks
// `process.env` first AND we skip writing to process.env when the
// existing pipeline (process.env + registry fallback) already resolves
// the var.
//
// Precedence (high → low):
//   1. process.env (MCP host config explicit declaration)
//   2. Windows registry (v2.28.0 fallback)
//   3. Central config file (THIS module)
//   4. Hardcoded defaults inside loadConfig()
//
// API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
// DEEPSEEK_API_KEY, GROK_API_KEY, PERPLEXITY_API_KEY) are NOT covered
// by this file by design — they remain in Windows registry per the
// secrets_policy "API keys are read from Windows environment variables
// only". The file does NOT define an `api_keys` section.
//
// Per-host identity (CROSS_REVIEW_CALLER_TOKEN, CROSS_REVIEW_REQUIRE_
// TOKEN) is also NOT covered: each MCP host declares its own caller
// identity in its own config.
//
// File location: `${data_dir}/config.json` by default, overridable via
// CROSS_REVIEW_V2_CONFIG_FILE env var. Absence is non-fatal (boot
// proceeds with env+defaults exactly like pre-v3.1.0).
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { PeerId } from "./types.js";

// All sub-schemas use .strict() so an unknown field surfaces as a
// zod error at boot rather than silently being ignored. The operator
// gets a clear message pointing at the typo'd field.

const ReasoningEffortValueSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const PerPeerStringSchema = z
  .object({
    codex: z.string().optional(),
    claude: z.string().optional(),
    gemini: z.string().optional(),
    deepseek: z.string().optional(),
    grok: z.string().optional(),
    perplexity: z.string().optional(),
  })
  .strict()
  .optional();

const PerPeerStringListSchema = z
  .object({
    codex: z.array(z.string()).optional(),
    claude: z.array(z.string()).optional(),
    gemini: z.array(z.string()).optional(),
    deepseek: z.array(z.string()).optional(),
    grok: z.array(z.string()).optional(),
    perplexity: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const PerPeerReasoningSchema = z
  .object({
    codex: ReasoningEffortValueSchema.optional(),
    claude: ReasoningEffortValueSchema.optional(),
    gemini: ReasoningEffortValueSchema.optional(),
    deepseek: ReasoningEffortValueSchema.optional(),
    grok: ReasoningEffortValueSchema.optional(),
    perplexity: ReasoningEffortValueSchema.optional(),
  })
  .strict()
  .optional();

const PerPeerBoolSchema = z
  .object({
    codex: z.boolean().optional(),
    claude: z.boolean().optional(),
    gemini: z.boolean().optional(),
    deepseek: z.boolean().optional(),
    grok: z.boolean().optional(),
    perplexity: z.boolean().optional(),
  })
  .strict()
  .optional();

// Per-peer cost-rate sub-schema. Mirrors AppConfig.cost_rates[peer]
// from src/core/types.ts (18 optional fields). All numbers; operator
// chooses which apply per provider (e.g., Anthropic has cache, Gemini
// has threshold/extended, DeepSeek has promo, Perplexity has request
// fees + 4th-dimension deep-research fields).
const CostRateEntrySchema = z
  .object({
    input_per_million: z.number().nonnegative().optional(),
    output_per_million: z.number().nonnegative().optional(),
    cache_read_per_million: z.number().nonnegative().optional(),
    cache_write_per_million: z.number().nonnegative().optional(),
    input_extended_per_million: z.number().nonnegative().optional(),
    output_extended_per_million: z.number().nonnegative().optional(),
    cache_read_extended_per_million: z.number().nonnegative().optional(),
    cache_write_extended_per_million: z.number().nonnegative().optional(),
    threshold_tokens: z.number().int().nonnegative().optional(),
    promo_input_per_million: z.number().nonnegative().optional(),
    promo_output_per_million: z.number().nonnegative().optional(),
    promo_input_extended_per_million: z.number().nonnegative().optional(),
    promo_output_extended_per_million: z.number().nonnegative().optional(),
    promo_cache_read_per_million: z.number().nonnegative().optional(),
    promo_cache_write_per_million: z.number().nonnegative().optional(),
    promo_cache_read_extended_per_million: z.number().nonnegative().optional(),
    promo_cache_write_extended_per_million: z.number().nonnegative().optional(),
    promo_expires_at_utc: z.string().optional(),
    request_fee_low_per_1000: z.number().nonnegative().optional(),
    request_fee_medium_per_1000: z.number().nonnegative().optional(),
    request_fee_high_per_1000: z.number().nonnegative().optional(),
    citation_tokens_per_million: z.number().nonnegative().optional(),
    deep_research_reasoning_tokens_per_million: z.number().nonnegative().optional(),
    search_queries_per_1000: z.number().nonnegative().optional(),
  })
  .strict();

const PerPeerCostRatesSchema = z
  .object({
    codex: CostRateEntrySchema.optional(),
    claude: CostRateEntrySchema.optional(),
    gemini: CostRateEntrySchema.optional(),
    deepseek: CostRateEntrySchema.optional(),
    grok: CostRateEntrySchema.optional(),
    perplexity: CostRateEntrySchema.optional(),
  })
  .strict()
  .optional();

const EvidenceJudgeAutowireSchema = z
  .object({
    mode: z.enum(["off", "shadow", "active"]).optional(),
    peer: z.string().optional(),
    consensus_peers: z.array(z.string()).optional(),
    max_items_per_pass: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const BudgetSchema = z
  .object({
    max_session_cost_usd: z.number().nonnegative().optional(),
    until_stopped_max_cost_usd: z.number().nonnegative().optional(),
    preflight_max_round_cost_usd: z.number().nonnegative().optional(),
    default_max_rounds: z.number().int().positive().optional(),
    circular_max_rotations: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const CacheSchema = z
  .object({
    disable_cache: z.boolean().optional(),
    schema_version: z.string().optional(),
    ttl_anthropic: z.enum(["5m", "1h"]).optional(),
    ttl_openai: z.enum(["5m", "1h"]).optional(),
  })
  .strict()
  .optional();

const PerplexitySubSchema = z
  .object({
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    disable_search: z.boolean().optional(),
  })
  .strict()
  .optional();

const TokenStreamingSchema = z
  .object({
    chars_threshold: z.number().int().positive().optional(),
    ms_threshold: z.number().int().positive().optional(),
    verbose: z.boolean().optional(),
  })
  .strict()
  .optional();

const RetrySchema = z
  .object({
    max_attempts: z.number().int().positive().optional(),
    base_delay_ms: z.number().int().positive().optional(),
    max_delay_ms: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const FileConfigSchema = z
  .object({
    // Optional schema version sentinel so future breaking changes can
    // be detected. Currently no version-specific logic; absence is OK.
    version: z.string().optional(),
    log_level: z.enum(["debug", "info", "warn", "error"]).optional(),
    stub: z.boolean().optional(),
    dashboard_port: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    models: PerPeerStringSchema,
    fallback_models: PerPeerStringListSchema,
    reasoning_effort: PerPeerReasoningSchema,
    peer_enabled: PerPeerBoolSchema,
    cost_rates: PerPeerCostRatesSchema,
    budget: BudgetSchema,
    retry: RetrySchema,
    evidence_judge_autowire: EvidenceJudgeAutowireSchema,
    cache: CacheSchema,
    perplexity: PerplexitySubSchema,
    token_streaming: TokenStreamingSchema,
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const PEER_TO_ENV_PREFIX: Record<PeerId, string> = {
  codex: "CROSS_REVIEW_OPENAI",
  claude: "CROSS_REVIEW_ANTHROPIC",
  gemini: "CROSS_REVIEW_GEMINI",
  deepseek: "CROSS_REVIEW_DEEPSEEK",
  grok: "CROSS_REVIEW_GROK",
  perplexity: "CROSS_REVIEW_PERPLEXITY",
};

const COST_RATE_FIELD_TO_ENV_SUFFIX: Record<string, string> = {
  input_per_million: "INPUT_USD_PER_MILLION",
  output_per_million: "OUTPUT_USD_PER_MILLION",
  cache_read_per_million: "CACHE_READ_USD_PER_MILLION",
  cache_write_per_million: "CACHE_WRITE_USD_PER_MILLION",
  input_extended_per_million: "INPUT_EXTENDED_USD_PER_MILLION",
  output_extended_per_million: "OUTPUT_EXTENDED_USD_PER_MILLION",
  cache_read_extended_per_million: "CACHE_READ_EXTENDED_USD_PER_MILLION",
  cache_write_extended_per_million: "CACHE_WRITE_EXTENDED_USD_PER_MILLION",
  threshold_tokens: "THRESHOLD_TOKENS",
  promo_input_per_million: "PROMO_INPUT_USD_PER_MILLION",
  promo_output_per_million: "PROMO_OUTPUT_USD_PER_MILLION",
  promo_input_extended_per_million: "PROMO_INPUT_EXTENDED_USD_PER_MILLION",
  promo_output_extended_per_million: "PROMO_OUTPUT_EXTENDED_USD_PER_MILLION",
  promo_cache_read_per_million: "PROMO_CACHE_READ_USD_PER_MILLION",
  promo_cache_write_per_million: "PROMO_CACHE_WRITE_USD_PER_MILLION",
  promo_cache_read_extended_per_million: "PROMO_CACHE_READ_EXTENDED_USD_PER_MILLION",
  promo_cache_write_extended_per_million: "PROMO_CACHE_WRITE_EXTENDED_USD_PER_MILLION",
  promo_expires_at_utc: "PROMO_EXPIRES_AT_UTC",
  request_fee_low_per_1000: "REQUEST_FEE_LOW_USD_PER_1000_REQUESTS",
  request_fee_medium_per_1000: "REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS",
  request_fee_high_per_1000: "REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS",
  citation_tokens_per_million: "CITATION_TOKENS_USD_PER_MILLION",
  deep_research_reasoning_tokens_per_million: "DEEP_RESEARCH_REASONING_TOKENS_USD_PER_MILLION",
  search_queries_per_1000: "SEARCH_QUERIES_USD_PER_1000_REQUESTS",
};

// Flatten the structured FileConfig into a flat map of env-var-name →
// string-value. The existing loadConfig() pipeline reads from
// process.env, so the file's contribution is to seed those env vars
// when they aren't already explicitly set.
export function flattenFileConfigToEnvMap(config: FileConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: unknown) => {
    if (value == null) return;
    out[name] = String(value);
  };

  set("CROSS_REVIEW_V2_LOG_LEVEL", config.log_level);
  if (config.stub != null) set("CROSS_REVIEW_V2_STUB", config.stub ? "true" : "false");
  set("CROSS_REVIEW_V2_DASHBOARD_PORT", config.dashboard_port);
  set("CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS", config.max_output_tokens);

  // Per-peer model / reasoning / fallback / enabled.
  if (config.models) {
    for (const [peer, model] of Object.entries(config.models) as [PeerId, string | undefined][]) {
      if (model) set(`${PEER_TO_ENV_PREFIX[peer]}_MODEL`, model);
    }
  }
  if (config.fallback_models) {
    for (const [peer, list] of Object.entries(config.fallback_models) as [
      PeerId,
      string[] | undefined,
    ][]) {
      if (list && list.length > 0)
        set(`${PEER_TO_ENV_PREFIX[peer]}_FALLBACK_MODELS`, list.join(","));
    }
  }
  if (config.reasoning_effort) {
    for (const [peer, effort] of Object.entries(config.reasoning_effort) as [
      PeerId,
      string | undefined,
    ][]) {
      if (effort) set(`${PEER_TO_ENV_PREFIX[peer]}_REASONING_EFFORT`, effort);
    }
  }
  if (config.peer_enabled) {
    for (const [peer, on] of Object.entries(config.peer_enabled) as [
      PeerId,
      boolean | undefined,
    ][]) {
      if (on != null) set(`CROSS_REVIEW_V2_PEER_${peer.toUpperCase()}`, on ? "on" : "off");
    }
  }
  if (config.cost_rates) {
    for (const [peer, rate] of Object.entries(config.cost_rates) as [
      PeerId,
      Record<string, unknown> | undefined,
    ][]) {
      if (!rate) continue;
      const prefix = PEER_TO_ENV_PREFIX[peer];
      for (const [field, value] of Object.entries(rate)) {
        if (value == null) continue;
        const suffix = COST_RATE_FIELD_TO_ENV_SUFFIX[field];
        if (!suffix) continue;
        set(`${prefix}_${suffix}`, value);
      }
    }
  }

  if (config.budget) {
    set("CROSS_REVIEW_V2_MAX_SESSION_COST_USD", config.budget.max_session_cost_usd);
    set("CROSS_REVIEW_V2_UNTIL_STOPPED_MAX_COST_USD", config.budget.until_stopped_max_cost_usd);
    set("CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD", config.budget.preflight_max_round_cost_usd);
    set("CROSS_REVIEW_V2_DEFAULT_MAX_ROUNDS", config.budget.default_max_rounds);
    set("CROSS_REVIEW_V2_CIRCULAR_MAX_ROTATIONS", config.budget.circular_max_rotations);
  }
  if (config.retry) {
    set("CROSS_REVIEW_V2_RETRY_ATTEMPTS", config.retry.max_attempts);
    set("CROSS_REVIEW_V2_RETRY_BASE_MS", config.retry.base_delay_ms);
    set("CROSS_REVIEW_V2_RETRY_MAX_MS", config.retry.max_delay_ms);
    set("CROSS_REVIEW_V2_TIMEOUT_MS", config.retry.timeout_ms);
  }
  if (config.evidence_judge_autowire) {
    set("CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE", config.evidence_judge_autowire.mode);
    set("CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER", config.evidence_judge_autowire.peer);
    if (config.evidence_judge_autowire.consensus_peers) {
      set(
        "CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS",
        config.evidence_judge_autowire.consensus_peers.join(","),
      );
    }
    set(
      "CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS",
      config.evidence_judge_autowire.max_items_per_pass,
    );
  }
  if (config.cache) {
    if (config.cache.disable_cache != null) {
      set("CROSS_REVIEW_V2_DISABLE_CACHE", config.cache.disable_cache ? "true" : "false");
    }
    set("CROSS_REVIEW_V2_CACHE_SCHEMA_VERSION", config.cache.schema_version);
    set("CROSS_REVIEW_V2_CACHE_TTL_ANTHROPIC", config.cache.ttl_anthropic);
    set("CROSS_REVIEW_V2_CACHE_TTL_OPENAI", config.cache.ttl_openai);
  }
  if (config.perplexity) {
    set("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE", config.perplexity.search_context_size);
    if (config.perplexity.disable_search != null) {
      set(
        "CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH",
        config.perplexity.disable_search ? "true" : "false",
      );
    }
  }
  if (config.token_streaming) {
    set("CROSS_REVIEW_V2_TOKEN_DELTA_CHARS_THRESHOLD", config.token_streaming.chars_threshold);
    set("CROSS_REVIEW_V2_TOKEN_DELTA_MS_THRESHOLD", config.token_streaming.ms_threshold);
    if (config.token_streaming.verbose != null) {
      set("CROSS_REVIEW_V2_TOKEN_DELTA_VERBOSE", config.token_streaming.verbose ? "1" : "0");
    }
  }

  return out;
}

// Resolve the file path: CROSS_REVIEW_V2_CONFIG_FILE env wins; else
// `${dataDir}/config.json`. Caller passes dataDir so this module does
// not need its own copy of the data-dir resolution logic.
//
// v3.1.0 R1 fix (codex cross-review catch 2026-05-12): accept an
// optional envValue helper so the path-lookup honors the v2.28.0
// Windows registry fallback. Without this, an operator who stores
// CROSS_REVIEW_V2_CONFIG_FILE in HKCU\Environment (instead of the MCP
// host config) would see the override silently ignored. When the
// helper is omitted (e.g., external smoke callers), fall back to
// `process.env` directly to preserve backward compatibility.
export function resolveConfigFilePath(
  dataDir: string,
  envValue?: (name: string) => string | undefined,
): string {
  const overridePath = envValue
    ? envValue("CROSS_REVIEW_V2_CONFIG_FILE")
    : process.env.CROSS_REVIEW_V2_CONFIG_FILE;
  if (overridePath && overridePath.trim().length > 0) {
    return path.resolve(overridePath);
  }
  return path.join(dataDir, "config.json");
}

export interface ApplyFileConfigResult {
  applied: boolean;
  path: string;
  fields_applied: number;
  fields_overridden_by_env: number;
  parse_error?: string;
}

// Public API used by `loadConfig()`. Reads the file (if present),
// validates with zod, flattens to env-var map, and writes each entry
// into process.env IFF the env var is not already explicitly set
// (process.env wins; Windows registry wins via existing v2.28.0
// fallback path inside envValue()). Caller passes `envValue` so we
// honor the same registry-fallback semantics without duplicating the
// cache logic.
//
// IDEMPOTENT — calling twice produces the same final state because the
// existence check uses envValue() which sees the post-first-call state.
//
// `parse_error` is set when the JSON or schema validation fails; the
// caller can surface this as a boot notice. We do NOT throw on file-
// load failure because the operator may have just started with a
// half-edited config; falling through to env+defaults is preferable to
// crashing the MCP host.
export function applyFileConfigToEnv(
  dataDir: string,
  envValue: (name: string) => string | undefined,
): ApplyFileConfigResult {
  // v3.1.0 R1 fix: thread envValue into resolveConfigFilePath so the
  // CROSS_REVIEW_V2_CONFIG_FILE override respects v2.28.0 registry
  // fallback (operator-stored override path in HKCU\Environment works).
  const filePath = resolveConfigFilePath(dataDir, envValue);
  if (!fs.existsSync(filePath)) {
    return { applied: false, path: filePath, fields_applied: 0, fields_overridden_by_env: 0 };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      applied: false,
      path: filePath,
      fields_applied: 0,
      fields_overridden_by_env: 0,
      parse_error: `read_failed: ${(error as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      applied: false,
      path: filePath,
      fields_applied: 0,
      fields_overridden_by_env: 0,
      parse_error: `json_parse_failed: ${(error as Error).message}`,
    };
  }
  const validated = FileConfigSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      applied: false,
      path: filePath,
      fields_applied: 0,
      fields_overridden_by_env: 0,
      parse_error: `schema_validation_failed: ${validated.error.message}`,
    };
  }
  const envMap = flattenFileConfigToEnvMap(validated.data);
  let applied = 0;
  let overridden = 0;
  for (const [name, value] of Object.entries(envMap)) {
    // envValue() checks process.env AND Windows registry. Both win
    // over the file. We only write the file's value when nothing has
    // claimed this name yet.
    const existing = envValue(name);
    if (existing !== undefined && existing !== "") {
      overridden++;
      continue;
    }
    process.env[name] = value;
    applied++;
  }
  return {
    applied: true,
    path: filePath,
    fields_applied: applied,
    fields_overridden_by_env: overridden,
  };
}
