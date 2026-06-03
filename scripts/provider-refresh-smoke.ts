import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { selectFromCandidates } from "../src/peers/model-selection.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-provider-refresh-"),
);

const config = loadConfig();

{
  const adapter = new PerplexityAdapter(config);
  let capturedPayload: { max_tokens?: number; disable_search?: boolean } | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        chat: {
          completions: {
            create: (payload: { max_tokens?: number; disable_search?: boolean }) => Promise<void>;
          };
        };
      }>;
    }
  ).client = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          capturedPayload = payload;
        },
      },
    },
  });

  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(capturedPayload?.disable_search, true);
  assert.ok(
    typeof capturedPayload?.max_tokens === "number" && capturedPayload.max_tokens >= 16,
    "Perplexity probe must request at least 16 max_tokens for sonar-reasoning-pro.",
  );
}

{
  const claude = selectFromCandidates(
    "claude",
    [{ id: "claude-opus-4-8", source: "api" }],
    "claude-opus-4-8",
  );
  assert.equal(claude.selected, "claude-opus-4-8");
  assert.equal(claude.confidence, "verified");
}

{
  const grok = selectFromCandidates("grok", [{ id: "grok-4.3", source: "api" }], "grok-4.3");
  assert.equal(grok.selected, "grok-4.3");
  assert.equal(grok.confidence, "verified");
}

{
  const configSource = fs.readFileSync("src/core/config.ts", "utf8");
  const modelSelectionSource = fs.readFileSync("src/peers/model-selection.ts", "utf8");
  assert.ok(
    configSource.includes('claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-opus-4-8"'),
  );
  assert.ok(configSource.includes('grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.3"'));
  assert.ok(modelSelectionSource.includes('claude: ["claude-opus-4-8"]'));
  assert.ok(modelSelectionSource.includes('grok: ["grok-4.3"]'));
}

console.log("[provider-refresh-smoke] PASS");
