import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import type { PeerId, RuntimeEvent, TokenUsage } from "../src/core/types.js";
import { PEERS } from "../src/core/types.js";
import { resolveBestModels } from "../src/peers/model-selection.js";
import { createAdapters } from "../src/peers/registry.js";

process.env.CROSS_REVIEW_STUB = "0";
process.env.CROSS_REVIEW_STREAM_TOKENS = "1";
process.env.CROSS_REVIEW_DATA_DIR =
  process.env.CROSS_REVIEW_DATA_DIR ||
  path.join(os.tmpdir(), `cross-review-api-streaming-smoke-${Date.now()}`);

const config = loadConfig();
const missing = PEERS.filter((peer) => !config.api_keys[peer]);
if (missing.length > 0) {
  throw new Error(
    `Missing API keys for real streaming smoke: ${missing.join(", ")}. ` +
      "Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY and DEEPSEEK_API_KEY.",
  );
}

await resolveBestModels(config);
const adapters = createAdapters(config);

function tokenChars(events: RuntimeEvent[], peer: PeerId): number {
  return events
    .filter((event) => event.type === "peer.token.delta" && event.peer === peer)
    .reduce((total, event) => total + Number(event.data?.chars ?? 0), 0);
}

function usageSummary(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.reasoning_tokens,
  };
}

const prompt = [
  "Real streaming smoke test.",
  "Return a valid cross-review JSON decision with status READY.",
  "Keep the summary short and do not include any secret or raw prompt text.",
].join("\n");

const results = [];

for (const peer of PEERS) {
  const events: RuntimeEvent[] = [];
  const result = await adapters[peer].call(prompt, {
    session_id: `api-streaming-smoke-${peer}`,
    round: 1,
    task: "Verify real provider token streaming for cross-review.",
    stream: true,
    stream_tokens: true,
    emit(event) {
      events.push(event);
    },
  });
  const deltaEvents = events.filter(
    (event) => event.type === "peer.token.delta" && event.peer === peer,
  );
  const completedEvents = events.filter(
    (event) => event.type === "peer.token.completed" && event.peer === peer,
  );
  assert.ok(deltaEvents.length > 0, `${peer} did not emit peer.token.delta events.`);
  assert.equal(completedEvents.length, 1, `${peer} did not emit one completion event.`);
  assert.ok(result.text.length > 0, `${peer} returned empty text.`);

  results.push({
    peer,
    provider: result.provider,
    requested_model: result.model,
    reported_model: result.model_reported,
    status: result.status,
    decision_quality: result.decision_quality,
    delta_events: deltaEvents.length,
    streamed_chars: tokenChars(events, peer),
    usage: usageSummary(result.usage),
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      streaming_tokens: config.streaming.tokens,
      streaming_text: config.streaming.include_text,
      data_dir: config.data_dir,
      results,
    },
    null,
    2,
  ),
);
