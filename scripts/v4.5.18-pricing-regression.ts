import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { estimateCacheSavings, selectRate } from "../src/core/cost.js";
import type { CostRateConfig } from "../src/core/types.js";

const grok45OfficialRate: CostRateConfig = {
  input_per_million: 2,
  output_per_million: 6,
  cache_read_per_million: 0.5,
  threshold_tokens: 200_000,
  input_extended_per_million: 4,
  output_extended_per_million: 12,
  cache_read_extended_per_million: 1,
};

assert.deepEqual(selectRate(grok45OfficialRate, "input", 200_000), {
  rate_per_million: 2,
  tier_used: "base",
});
assert.deepEqual(selectRate(grok45OfficialRate, "input", 200_001), {
  rate_per_million: 4,
  tier_used: "extended",
});
assert.deepEqual(selectRate(grok45OfficialRate, "output", 200_001), {
  rate_per_million: 12,
  tier_used: "extended",
});
assert.deepEqual(selectRate(grok45OfficialRate, "cache_read", 200_001), {
  rate_per_million: 1,
  tier_used: "extended",
});

// v4.7.0: official GPT-6 Astra card (developers.openai.com/api/docs/models/gpt-6-astra
// for the 272K threshold; developers.openai.com/api/docs/pricing for the
// absolute long-context rates). No promotional pricing exists for Astra.
const gpt6AstraOfficialRate: CostRateConfig = {
  input_per_million: 10,
  output_per_million: 50,
  cache_read_per_million: 1,
  cache_write_per_million: 12.5,
  threshold_tokens: 272_000,
  input_extended_per_million: 20,
  output_extended_per_million: 75,
  cache_read_extended_per_million: 2,
  cache_write_extended_per_million: 25,
};
for (const [category, base, extended] of [
  ["input", 10, 20],
  ["output", 50, 75],
  ["cache_read", 1, 2],
  ["cache_write", 12.5, 25],
] as const) {
  assert.deepEqual(selectRate(gpt6AstraOfficialRate, category, 272_000), {
    rate_per_million: base,
    tier_used: "base",
  });
  assert.deepEqual(selectRate(gpt6AstraOfficialRate, category, 272_001), {
    rate_per_million: extended,
    tier_used: "extended",
  });
}

// v4.7.0: official Claude Fable 5.1 card (platform.claude.com, what's new in
// Fable 5.1). Cache reads are 0.025x base input; cache writes are $12.50 (5m)
// or $20 (1h). The rate schema carries one cache_write field, so the card
// prices the write tier that matches the configured cache.ttl_anthropic.
const claudeFable51OfficialRate: CostRateConfig = {
  input_per_million: 10,
  output_per_million: 50,
  cache_read_per_million: 0.25,
  cache_write_per_million: 20,
};
assert.deepEqual(selectRate(claudeFable51OfficialRate, "cache_read", 1_000), {
  rate_per_million: 0.25,
  tier_used: "base",
});
assert.deepEqual(
  estimateCacheSavings(
    "claude",
    { input_tokens: 0, cache_read_tokens: 1_000_000 },
    claudeFable51OfficialRate,
  ),
  { savings_usd: 10 - 0.25, unknown: false },
);

const costsDoc = await readFile(new URL("../docs/costs.md", import.meta.url), "utf8");
assert.match(
  costsDoc,
  /xAI `grok-4\.6`[\s\S]*?`>200000`[\s\S]*?input `4`[\s\S]*?output `12`[\s\S]*?cached input `1`/,
);
assert.match(
  costsDoc,
  /"grok-4\.6": \{[\s\S]*?"threshold_tokens": 200000,[\s\S]*?"input_extended_per_million": 4,[\s\S]*?"output_extended_per_million": 12,[\s\S]*?"cache_read_extended_per_million": 1/,
);
// Pre-existing pattern: this regression pins docs/costs.md rows by regex so
// the documented rates cannot drift from the asserted official values.
assert.match(
  costsDoc,
  /OpenAI `gpt-6-astra`[\s\S]*?`10`[\s\S]*?`50`[\s\S]*?`1`[\s\S]*?`>272000`[\s\S]*?input `20`[\s\S]*?output `75`[\s\S]*?cached input `2`/,
);
assert.match(
  costsDoc,
  /"gpt-6-astra": \{[\s\S]*?"input_per_million": 10,[\s\S]*?"output_per_million": 50,[\s\S]*?"cache_read_per_million": 1,[\s\S]*?"cache_write_per_million": 12\.5,[\s\S]*?"threshold_tokens": 272000,[\s\S]*?"input_extended_per_million": 20,[\s\S]*?"output_extended_per_million": 75,[\s\S]*?"cache_read_extended_per_million": 2,[\s\S]*?"cache_write_extended_per_million": 25/,
);
assert.match(costsDoc, /Anthropic `claude-fable-5-1`[\s\S]*?`10`[\s\S]*?`50`[\s\S]*?`0\.25`/);
assert.match(
  costsDoc,
  /"claude-fable-5-1": \{[\s\S]*?"input_per_million": 10,[\s\S]*?"output_per_million": 50,[\s\S]*?"cache_read_per_million": 0\.25,[\s\S]*?"cache_write_per_million": 20/,
);
assert.doesNotMatch(costsDoc, /gpt-5\.6-sol|claude-fable-5(?![-\w])/);

console.log("v4.5.18 pricing regression: 21/21 passed");
