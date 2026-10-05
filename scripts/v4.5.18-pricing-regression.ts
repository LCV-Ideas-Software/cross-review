import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { mergeUsage, selectRate } from "../src/core/cost.js";
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

const costsDoc = await readFile(new URL("../docs/costs.md", import.meta.url), "utf8");
assert.match(
  costsDoc,
  /xAI `grok-4\.7`[\s\S]*?`>200000`[\s\S]*?input `4`[\s\S]*?output `12`[\s\S]*?cached input `1`/,
);
assert.match(
  costsDoc,
  /"grok-4\.7": \{[\s\S]*?"threshold_tokens": 200000,[\s\S]*?"input_extended_per_million": 4,[\s\S]*?"output_extended_per_million": 12,[\s\S]*?"cache_read_extended_per_million": 1/,
);

// Missing native totals/reasoning/cache buckets must not become measured zero.
assert.deepEqual(mergeUsage([{ input_tokens: 10, output_tokens: 9 }]), {
  input_tokens: 10,
  output_tokens: 9,
});
assert.deepEqual(
  mergeUsage([
    { input_tokens: 10, output_tokens: 9 },
    { total_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  ]),
  {
    input_tokens: 10,
    output_tokens: 9,
    total_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  },
);
assert.deepEqual(
  mergeUsage([
    undefined,
    { total_tokens: 11, reasoning_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5 },
    { input_tokens: 2, output_tokens: 1 },
    { total_tokens: 7, reasoning_tokens: 2, cache_read_tokens: 6, cache_write_tokens: 8 },
  ]),
  {
    input_tokens: 2,
    output_tokens: 1,
    total_tokens: 18,
    reasoning_tokens: 5,
    cache_read_tokens: 10,
    cache_write_tokens: 13,
  },
);
assert.deepEqual(mergeUsage([undefined]), {});

console.log("v4.5.18 pricing regression: 10/10 passed");
