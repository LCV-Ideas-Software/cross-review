import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { selectRate } from "../src/core/cost.js";
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
  /xAI `grok-4\.5`[\s\S]*?`>200000`[\s\S]*?input `4`[\s\S]*?output `12`[\s\S]*?cached input `1`/,
);
assert.match(
  costsDoc,
  /"grok-4\.5": \{[\s\S]*?"threshold_tokens": 200000,[\s\S]*?"input_extended_per_million": 4,[\s\S]*?"output_extended_per_million": 12,[\s\S]*?"cache_read_extended_per_million": 1/,
);

console.log("v4.5.18 pricing regression: 6/6 passed");
