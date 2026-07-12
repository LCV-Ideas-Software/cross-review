// v2.21.0 (caching): cost layer extends to merge cache_read/cache_write
// tokens and surface estimated cache savings on CostEstimate.
// v2.26.0 (full pricing model + no-hardcoded-financials): cost_rates is
// now a complete schema supporting base + extended-tier (>threshold) +
// cache (read/write) + promo (limited-time discount until
// promo_expires_at). selectRate() chooses the right value per
// (category, tier, promo-active?) at estimation time. The legacy
// cache-rates.json fallback was REMOVED per operator directive
// 2026-05-11 ("nada hardcoded para preços financeiros — o sistema deve
// travar até o operador configurar as variáveis"). When cache rate env
// vars are absent, selectRate() gracefully degrades to the input rate
// (zero savings) instead of synthesizing prices from a static file.

import type {
  AppConfig,
  CostEstimate,
  CostRateConfig,
  ModelCostRateConfig,
  PeerId,
  TokenUsage,
} from "./types.js";

// v2.26.0: pricing categories and rate selection.
type CostRate = NonNullable<AppConfig["cost_rates"]["codex"]>;
type RateCategory = "input" | "output" | "cache_read" | "cache_write";

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//i, "");
}

function completeRate(card: ModelCostRateConfig | undefined): CostRateConfig | undefined {
  if (
    !card ||
    typeof card.input_per_million !== "number" ||
    typeof card.output_per_million !== "number"
  ) {
    return undefined;
  }
  return card as CostRateConfig;
}

/**
 * Resolve pricing against the model that will actually be sent on the wire.
 * The active pin keeps the generic env/registry card as highest precedence.
 * A different model (for example an explicit fallback adapter) must have its
 * own retained central-config card; borrowing the primary model's rates would
 * make a budget preflight look authoritative while pricing the wrong product.
 */
export function resolveCostRate(
  config: AppConfig,
  peer: PeerId,
  effectiveModel?: string,
): CostRateConfig | undefined {
  const configuredModel = config.models?.[peer];
  const primaryRate = config.cost_rates?.[peer];
  if (!effectiveModel && !configuredModel) return primaryRate;
  const effective = normalizeModelId(effectiveModel ?? configuredModel ?? "");
  const configured = normalizeModelId(configuredModel ?? "");
  if (effective === configured && primaryRate) return primaryRate;

  const cards = config.model_cost_rates?.[peer];
  if (cards) {
    const exact = Object.entries(cards).find(
      ([model]) => normalizeModelId(model) === effective,
    )?.[1];
    const exactRate = completeRate(exact);
    if (exactRate) return exactRate;
    if (exact) return undefined;

    // Perplexity's documented Sonar ids are distinct billable products:
    // `sonar` is never a family card for `sonar-*`.
    if (peer !== "perplexity") {
      const familyMatches = Object.entries(cards)
        .filter(([family]) => effective.startsWith(`${normalizeModelId(family)}-`))
        .sort(([left], [right]) => normalizeModelId(right).length - normalizeModelId(left).length);
      if (familyMatches.length > 0) return completeRate(familyMatches[0]?.[1]);
    }
  }

  // No explicit override: a constructed config that only retained a model
  // card may still price its primary pin. Effective overrides fail closed.
  if (effective === configured) {
    const primaryCard = cards
      ? Object.entries(cards).find(([model]) => normalizeModelId(model) === configured)?.[1]
      : undefined;
    return completeRate(primaryCard);
  }
  return undefined;
}

/**
 * v2.26.0: select the right per-million USD rate for a given (category,
 * tier, promo-active?) combination, with graceful fallback to the next
 * available rate when fields are absent or expired.
 *
 * Selection priority (each step falls through to the next when the
 * corresponding field is unset OR the condition does not apply):
 *   1. promo_<category>_extended_per_million — IFF in promo period AND
 *      large prompt AND field set
 *   2. promo_<category>_per_million — IFF in promo period AND field set
 *   3. <category>_extended_per_million — IFF large prompt AND field set
 *   4. <category>_per_million — base rate, set
 *   5. (cache_read / cache_write only) recurse into "input" category
 *      — gracefully degrade to "no cache discount" billing when the
 *      operator stops configuring cache rates entirely
 *
 * Fallback semantics intent (operator directive 2026-05-11):
 *   - When promo expires (today >= promo_expires_at) or promo fields are
 *     unset, automatically use base rates without operator intervention.
 *   - When extended-tier rates are unset for a tier-aware provider, use
 *     base for ALL prompt sizes (no penalty for missing config).
 *   - When cache rates are unset entirely, treat cache tokens as fresh
 *     input (no discount, no penalty). The provider may still bill them
 *     at a lower rate; we just stop modeling that detail.
 *
 * `now` is injected so tests and FinOps replays can pin the clock.
 */
export function selectRate(
  rate: CostRate,
  category: RateCategory,
  totalInputTokens: number,
  now: Date = new Date(),
): { rate_per_million: number; tier_used: NonNullable<CostEstimate["tier_used"]> } | undefined {
  const inPromo =
    rate.promo_expires_at != null && Date.parse(rate.promo_expires_at) > now.getTime();
  const isExtended = rate.threshold_tokens != null && totalInputTokens > rate.threshold_tokens;
  const promoBase = (
    {
      input: rate.promo_input_per_million,
      output: rate.promo_output_per_million,
      cache_read: rate.promo_cache_read_per_million,
      cache_write: rate.promo_cache_write_per_million,
    } as const
  )[category];
  const promoExtended = (
    {
      input: rate.promo_input_extended_per_million,
      output: rate.promo_output_extended_per_million,
      cache_read: rate.promo_cache_read_extended_per_million,
      cache_write: rate.promo_cache_write_extended_per_million,
    } as const
  )[category];
  const base = (
    {
      input: rate.input_per_million,
      output: rate.output_per_million,
      cache_read: rate.cache_read_per_million,
      cache_write: rate.cache_write_per_million,
    } as const
  )[category];
  const extended = (
    {
      input: rate.input_extended_per_million,
      output: rate.output_extended_per_million,
      cache_read: rate.cache_read_extended_per_million,
      cache_write: rate.cache_write_extended_per_million,
    } as const
  )[category];
  if (inPromo) {
    if (isExtended && promoExtended != null) {
      return { rate_per_million: promoExtended, tier_used: "promo_extended" };
    }
    if (promoBase != null) {
      return { rate_per_million: promoBase, tier_used: "promo" };
    }
    // No promo rate for this category → fall through to non-promo cascade.
  }
  if (isExtended && extended != null) {
    return { rate_per_million: extended, tier_used: "extended" };
  }
  if (base != null) {
    return { rate_per_million: base, tier_used: "base" };
  }
  // v2.26.0 graceful degradation: when a cache category has no rate at
  // all (operator stopped configuring it OR provider discontinued the
  // cache discount), bill cache tokens at the input rate instead of
  // dropping them silently. The tier_used reflects the input tier so
  // FinOps still sees promo/extended applied to the input fallback.
  if (category === "cache_read" || category === "cache_write") {
    return selectRate(rate, "input", totalInputTokens, now);
  }
  return undefined;
}

export function mergeUsage(items: Array<TokenUsage | undefined>): TokenUsage {
  const total: TokenUsage = {};
  let citationTokensSeen = false;
  let searchQueriesSeen = false;
  let searchPerformedSeen = false;
  let providerTotalSeen = false;
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
    if (item.citation_tokens !== undefined) {
      total.citation_tokens = (total.citation_tokens ?? 0) + item.citation_tokens;
      citationTokensSeen = true;
    }
    if (item.num_search_queries !== undefined) {
      total.num_search_queries = (total.num_search_queries ?? 0) + item.num_search_queries;
      searchQueriesSeen = true;
    }
    if (item.search_performed !== undefined) {
      total.search_performed = (total.search_performed ?? false) || item.search_performed;
      searchPerformedSeen = true;
    }
    if (item.provider_reported_total_cost_usd !== undefined) {
      total.provider_reported_total_cost_usd =
        (total.provider_reported_total_cost_usd ?? 0) + item.provider_reported_total_cost_usd;
      providerTotalSeen = true;
    }
  }
  if (!citationTokensSeen) delete total.citation_tokens;
  if (!searchQueriesSeen) delete total.num_search_queries;
  if (!searchPerformedSeen) delete total.search_performed;
  if (!providerTotalSeen) delete total.provider_reported_total_cost_usd;
  return total;
}

export function estimateCost(
  config: AppConfig,
  peer: PeerId,
  usage?: TokenUsage,
  effectiveModel?: string,
): CostEstimate {
  const rate = resolveCostRate(config, peer, effectiveModel);
  if (!usage || !rate) {
    return { currency: "USD", estimated: false, source: "unknown-rate" };
  }
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_tokens ?? 0;
  const cacheWriteTokens = usage.cache_write_tokens ?? 0;
  // v2.26.0: tier selection considers the FULL prompt size (fresh input +
  // cached read + cache write) because providers like Gemini price by
  // total prompt length, not by post-cache fresh input.
  const totalInputForTier = inputTokens + cacheReadTokens + cacheWriteTokens;
  const inputSel = selectRate(rate, "input", totalInputForTier);
  const outputSel = selectRate(rate, "output", totalInputForTier);
  const cacheReadSel =
    cacheReadTokens > 0 ? selectRate(rate, "cache_read", totalInputForTier) : undefined;
  const cacheWriteSel =
    cacheWriteTokens > 0 ? selectRate(rate, "cache_write", totalInputForTier) : undefined;
  // selectRate always returns a value for input/output because base
  // _INPUT/_OUTPUT_USD_PER_MILLION is required at parse time.
  const inputCost = inputSel ? (inputTokens / 1_000_000) * inputSel.rate_per_million : 0;
  const outputCost = outputSel ? (outputTokens / 1_000_000) * outputSel.rate_per_million : 0;
  const cacheReadCost = cacheReadSel
    ? (cacheReadTokens / 1_000_000) * cacheReadSel.rate_per_million
    : 0;
  const cacheWriteCost = cacheWriteSel
    ? (cacheWriteTokens / 1_000_000) * cacheWriteSel.rate_per_million
    : 0;
  // v3.0.0 (Perplexity 6th peer): three additional cost dimensions —
  // (1) per-1000-requests fee scaled by search_context_size,
  // (2) citation_tokens (sonar-deep-research only),
  // (3) deep_research_reasoning_tokens (sonar-deep-research only),
  // (4) search_queries per-1000 fee (sonar-deep-research only).
  // All four are zero for non-perplexity peers (their cost_rates entry
  // never defines these fields) AND zero for non-deep-research
  // perplexity models (operator leaves citation/reasoning/queries
  // rates unset; usage.citation_tokens / usage.num_search_queries are
  // absent). Sonar's request fee is charged regardless of whether
  // `disable_search` prevents a web lookup; that flag changes latency,
  // not the per-request price.
  let requestCost = 0;
  let citationTokensCost = 0;
  let deepResearchReasoningTokensCost = 0;
  let searchQueriesCost = 0;
  // v4.5.0 docs correction: Perplexity charges the context-tier request
  // fee even when search_performed=false. Keep that usage flag as
  // observability only; never use it to suppress billed cost.
  const normalizedEffectiveModel = normalizeModelId(effectiveModel ?? config.models?.[peer] ?? "");
  const perplexityRequestFeeModels = new Set(["sonar", "sonar-pro", "sonar-reasoning-pro"]);
  if (peer === "perplexity" && perplexityRequestFeeModels.has(normalizedEffectiveModel)) {
    const size = config.perplexity?.search_context_size ?? "low";
    const requestFeePer1000 =
      size === "high"
        ? rate.request_fee_high_per_1000
        : size === "medium"
          ? rate.request_fee_medium_per_1000
          : rate.request_fee_low_per_1000;
    if (typeof requestFeePer1000 === "number" && requestFeePer1000 > 0) {
      requestCost = requestFeePer1000 / 1000;
    }
  }
  if (peer === "perplexity" && normalizedEffectiveModel === "sonar-deep-research") {
    const citationTokens = usage.citation_tokens ?? 0;
    if (citationTokens > 0 && typeof rate.citation_tokens_per_million === "number") {
      citationTokensCost = (citationTokens / 1_000_000) * rate.citation_tokens_per_million;
    }
    // sonar-deep-research bills reasoning_tokens at a separate rate from
    // output. Model identity is an explicit gate: stale or overly broad rate
    // cards must never make Reasoning Pro inherit Deep Research dimensions.
    const reasoningTokens = usage.reasoning_tokens ?? 0;
    if (
      reasoningTokens > 0 &&
      typeof rate.deep_research_reasoning_tokens_per_million === "number"
    ) {
      deepResearchReasoningTokensCost =
        (reasoningTokens / 1_000_000) * rate.deep_research_reasoning_tokens_per_million;
    }
    const numSearchQueries = usage.num_search_queries ?? 0;
    if (numSearchQueries > 0 && typeof rate.search_queries_per_1000 === "number") {
      searchQueriesCost = (numSearchQueries / 1000) * rate.search_queries_per_1000;
    }
  }
  const total =
    inputCost +
    outputCost +
    cacheReadCost +
    cacheWriteCost +
    requestCost +
    citationTokensCost +
    deepResearchReasoningTokensCost +
    searchQueriesCost;
  const base: CostEstimate = {
    currency: "USD",
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: total,
    estimated: true,
    source: "configured-rate",
  };
  if (cacheReadCost > 0) base.cache_read_cost = cacheReadCost;
  if (cacheWriteCost > 0) base.cache_write_cost = cacheWriteCost;
  if (requestCost > 0) base.request_cost = requestCost;
  if (citationTokensCost > 0) base.citation_tokens_cost = citationTokensCost;
  if (deepResearchReasoningTokensCost > 0) {
    base.deep_research_reasoning_tokens_cost = deepResearchReasoningTokensCost;
  }
  if (searchQueriesCost > 0) base.search_queries_cost = searchQueriesCost;
  // Surface the selected tier (priority: extended/promo over base) for
  // FinOps audit. When categories disagree (rare; only when promo or
  // extended apply to one but not the other), pick input's tier as the
  // representative — operators reading reports care most about which
  // BILLING regime the call landed under.
  if (inputSel) base.tier_used = inputSel.tier_used;
  // v2.21.0 (caching): when cache telemetry is present, populate
  // savings on the CostEstimate so dashboards + reports see it next to
  // input/output cost.
  if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
    const savings = estimateCacheSavings(peer, usage, rate);
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
  let input = 0;
  let output = 0;
  let inputKnown = false;
  let outputKnown = false;
  let cacheRead = 0;
  let cacheWrite = 0;
  let savings = 0;
  let savingsKnown = false;
  let savingsUnknown = false;
  // v3.0.0 (Perplexity 6th peer): accumulate the four Perplexity-specific
  // line items so multi-call sessions show the full pricing breakdown
  // in session reports + the dashboard. These remain zero for sessions
  // that don't include perplexity peer calls.
  let request = 0;
  let citationTokens = 0;
  let deepResearchReasoningTokens = 0;
  let searchQueries = 0;
  const tiers = new Set<NonNullable<CostEstimate["tier_used"]>>();
  for (const cost of costs) {
    if (cost?.total_cost == null) {
      // continue to inspect savings even when total is missing
    } else {
      known = true;
      total += cost.total_cost;
    }
    if (cost?.input_cost != null) {
      input += cost.input_cost;
      inputKnown = true;
    }
    if (cost?.output_cost != null) {
      output += cost.output_cost;
      outputKnown = true;
    }
    if (cost?.cache_read_cost != null) cacheRead += cost.cache_read_cost;
    if (cost?.cache_write_cost != null) cacheWrite += cost.cache_write_cost;
    if (cost?.cache_savings_usd != null) {
      savings += cost.cache_savings_usd;
      savingsKnown = true;
    }
    if (cost?.cache_savings_unknown) {
      savingsUnknown = true;
    }
    if (cost?.request_cost != null) request += cost.request_cost;
    if (cost?.citation_tokens_cost != null) citationTokens += cost.citation_tokens_cost;
    if (cost?.deep_research_reasoning_tokens_cost != null) {
      deepResearchReasoningTokens += cost.deep_research_reasoning_tokens_cost;
    }
    if (cost?.search_queries_cost != null) searchQueries += cost.search_queries_cost;
    if (cost?.tier_used) tiers.add(cost.tier_used);
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
  if (inputKnown) merged.input_cost = input;
  if (outputKnown) merged.output_cost = output;
  if (cacheRead > 0) merged.cache_read_cost = cacheRead;
  if (cacheWrite > 0) merged.cache_write_cost = cacheWrite;
  if (savingsKnown && savings > 0) merged.cache_savings_usd = savings;
  if (savingsUnknown) merged.cache_savings_unknown = true;
  if (request > 0) merged.request_cost = request;
  if (citationTokens > 0) merged.citation_tokens_cost = citationTokens;
  if (deepResearchReasoningTokens > 0) {
    merged.deep_research_reasoning_tokens_cost = deepResearchReasoningTokens;
  }
  if (searchQueries > 0) merged.search_queries_cost = searchQueries;
  if (tiers.size === 1) merged.tier_used = [...tiers][0];
  return merged;
}

/**
 * v2.21.0 (caching): estimate the savings that flowed from a cache hit
 * vs the fresh input rate for the same peer. Returns { unknown: true }
 * when the rate card has no entry for the provider — operators see
 * "we got a cache hit but cannot price it" instead of a silent zero.
 */
/**
 * v2.26.0: estimate cache-read savings using ONLY env-configured rates
 * via selectRate(). The legacy `cache-rates.json` fallback was removed
 * per operator directive 2026-05-11 ("nada hardcoded para preços
 * financeiros") — when an operator omits cache rate env vars, the
 * intelligent fallback in selectRate() treats cache reads as priced at
 * the input rate (zero savings) rather than synthesizing a fictional
 * cached rate from a hardcoded JSON. Returns `unknown: true` only when
 * no configRate is provided at all (defensive — `estimateCost()` already
 * short-circuits with "unknown-rate" before reaching this path).
 */
export function estimateCacheSavings(
  peer: PeerId,
  usage: TokenUsage,
  configRate: CostRate | undefined,
): { savings_usd: number; unknown: boolean } {
  void peer; // peer is kept in the signature for API stability + future telemetry
  const readTokens = usage.cache_read_tokens ?? 0;
  if (readTokens <= 0) return { savings_usd: 0, unknown: false };
  if (!configRate) return { savings_usd: 0, unknown: true };
  const totalInputForTier =
    (usage.input_tokens ?? 0) + readTokens + (usage.cache_write_tokens ?? 0);
  const freshSel = selectRate(configRate, "input", totalInputForTier);
  const cachedSel = selectRate(configRate, "cache_read", totalInputForTier);
  // Both should be defined because input is required and cache_read
  // gracefully degrades to input. Defensive guard for type narrowing.
  if (!freshSel || !cachedSel) return { savings_usd: 0, unknown: true };
  if (freshSel.rate_per_million <= cachedSel.rate_per_million) {
    return { savings_usd: 0, unknown: false };
  }
  const delta = freshSel.rate_per_million - cachedSel.rate_per_million;
  return { savings_usd: (delta * readTokens) / 1_000_000, unknown: false };
}
