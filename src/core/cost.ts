// v2.21.0 (caching): cost layer extends to merge cache_read/cache_write
// tokens and surface estimated cache savings on CostEstimate. Primary
// flat input/output rates still come from config.cost_rates (env);
// cache-rates.json provides FALLBACK fresh-vs-cached deltas used by
// estimateCacheSavings only.

import cacheRatesJson from "./cache-rates.json" with { type: "json" };
import type { AppConfig, CostEstimate, PeerId, TokenUsage } from "./types.js";

type CacheRateCard =
  | {
      fresh_input_per_million_usd: number;
      cached_input_per_million_usd?: number;
      cache_read_per_million_usd?: number;
      cache_write_5min_per_million_usd?: number;
      cache_write_1h_per_million_usd?: number;
      note?: string;
    }
  | undefined;

type RatesByProvider = Record<string, CacheRateCard>;

const PROVIDER_FOR_PEER: Record<PeerId, keyof typeof cacheRatesJson | string> = {
  codex: "openai",
  claude: "anthropic",
  gemini: "gemini",
  deepseek: "deepseek",
  grok: "grok",
};

export function mergeUsage(items: Array<TokenUsage | undefined>): TokenUsage {
  const total: TokenUsage = {};
  for (const item of items) {
    if (!item) continue;
    total.input_tokens = (total.input_tokens ?? 0) + (item.input_tokens ?? 0);
    total.output_tokens = (total.output_tokens ?? 0) + (item.output_tokens ?? 0);
    total.total_tokens = (total.total_tokens ?? 0) + (item.total_tokens ?? 0);
    total.reasoning_tokens = (total.reasoning_tokens ?? 0) + (item.reasoning_tokens ?? 0);
    // v2.21.0 (caching): merge cache telemetry. cache_read/write are
    // additive across calls; mode/key_hash are NOT merged because they
    // are per-call attributes (different rounds may hit different
    // cache scopes or modes).
    total.cache_read_tokens = (total.cache_read_tokens ?? 0) + (item.cache_read_tokens ?? 0);
    total.cache_write_tokens = (total.cache_write_tokens ?? 0) + (item.cache_write_tokens ?? 0);
  }
  return total;
}

export function estimateCost(config: AppConfig, peer: PeerId, usage?: TokenUsage): CostEstimate {
  const rate = config.cost_rates[peer];
  if (!usage || !rate) {
    return { currency: "USD", estimated: false, source: "unknown-rate" };
  }
  const input = ((usage.input_tokens ?? 0) / 1_000_000) * rate.input_per_million;
  const output = ((usage.output_tokens ?? 0) / 1_000_000) * rate.output_per_million;
  const base: CostEstimate = {
    currency: "USD",
    input_cost: input,
    output_cost: output,
    total_cost: input + output,
    estimated: true,
    source: "configured-rate",
  };
  // v2.21.0 (caching): when cache telemetry is present, populate
  // savings on the CostEstimate so dashboards + reports see it next to
  // input/output cost. Pure addition — no subtraction from total_cost
  // because the configured input rate already reflects the discounted
  // billing (provider returns lower input_tokens or charges less for
  // cached tokens internally).
  if ((usage.cache_read_tokens ?? 0) > 0 || (usage.cache_write_tokens ?? 0) > 0) {
    const savings = estimateCacheSavings(peer, usage);
    if (savings.unknown) {
      base.cache_savings_unknown = true;
    } else if (savings.savings_usd > 0) {
      base.cache_savings_usd = savings.savings_usd;
    }
  }
  return base;
}

export function mergeCost(costs: Array<CostEstimate | undefined>): CostEstimate {
  let known = false;
  let total = 0;
  let savings = 0;
  let savingsKnown = false;
  let savingsUnknown = false;
  for (const cost of costs) {
    if (cost?.total_cost == null) {
      // continue to inspect savings even when total is missing
    } else {
      known = true;
      total += cost.total_cost;
    }
    if (cost?.cache_savings_usd != null) {
      savings += cost.cache_savings_usd;
      savingsKnown = true;
    }
    if (cost?.cache_savings_unknown) {
      savingsUnknown = true;
    }
  }
  if (!known) {
    return { currency: "USD", estimated: false, source: "unknown-rate" };
  }
  const merged: CostEstimate = {
    currency: "USD",
    total_cost: total,
    estimated: true,
    source: "configured-rate",
  };
  if (savingsKnown && savings > 0) merged.cache_savings_usd = savings;
  if (savingsUnknown) merged.cache_savings_unknown = true;
  return merged;
}

/**
 * v2.21.0 (caching): estimate the savings that flowed from a cache hit
 * vs the fresh input rate for the same peer. Returns { unknown: true }
 * when the rate card has no entry for the provider — operators see
 * "we got a cache hit but cannot price it" instead of a silent zero.
 */
export function estimateCacheSavings(
  peer: PeerId,
  usage: TokenUsage,
): { savings_usd: number; unknown: boolean } {
  const provider = PROVIDER_FOR_PEER[peer];
  const ratesMap = cacheRatesJson as unknown as RatesByProvider;
  const card = ratesMap[provider];
  if (!card) return { savings_usd: 0, unknown: true };
  const readTokens = usage.cache_read_tokens ?? 0;
  if (readTokens <= 0) return { savings_usd: 0, unknown: false };

  const fresh = card.fresh_input_per_million_usd ?? 0;
  // Anthropic rate card uses cache_read_per_million_usd; OpenAI/Grok/
  // DeepSeek/Gemini use cached_input_per_million_usd. Try both keys.
  const cached = card.cache_read_per_million_usd ?? card.cached_input_per_million_usd ?? 0;
  if (fresh <= 0 || cached < 0 || fresh <= cached) {
    // Fresh cheaper or equal → no positive savings to report.
    return { savings_usd: 0, unknown: false };
  }
  const savings = ((fresh - cached) * readTokens) / 1_000_000;
  return { savings_usd: savings, unknown: false };
}
