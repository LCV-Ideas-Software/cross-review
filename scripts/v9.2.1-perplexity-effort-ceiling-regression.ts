// v09.02.01 — the Perplexity reasoning-effort ceiling (CROSREV-51).
//
// Every bare `invalid request` failure of the Perplexity peer since
// 14/09/2026 had one mechanism, measured to the terminal state on
// 20/09/2026 with the adapter's exact reviewer payload: the pinned
// `perplexity/kimi-k3` rejects `reasoning.effort` `xhigh` and `max` (HTTP 400
// synchronously; in background mode a run born `queued` that is `failed`
// with the bare body at the first retrieval), while `minimal`, `low`,
// `medium` and `high` complete with reasoning tokens reported. The adapter
// used to send `max`, the documented ceiling the model accepted on
// 23/08/2026.
//
// These cases pin the clamp table and prove, on the stubbed SDK surface the
// v6.0.0 and v9.2.0 cases use, that neither the reviewer nor the relator
// request ever carries `xhigh` or `max` on the wire — even under an explicit
// `max` override, which is what an operator's environment may still say.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import type { AppConfig, PeerCallContext, RuntimeEvent } from "../src/core/types.js";
import { clampEffortForPerplexity, PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-perplexity-effort-ceiling-"),
);

const READY = JSON.stringify({
  status: "READY",
  summary: "No blocking objections remain.",
  confidence: "inferred",
  evidence_sources: [],
  caller_requests: [],
  follow_ups: [],
});

const baseConfig = loadConfig();

function configWithEffort(effort: AppConfig["reasoning_effort"]["perplexity"]): AppConfig {
  return {
    ...baseConfig,
    reasoning_effort: { ...baseConfig.reasoning_effort, perplexity: effort },
    retry: { ...baseConfig.retry, max_attempts: 1, base_delay_ms: 1, max_delay_ms: 1 },
    streaming: { ...baseConfig.streaming, tokens: false, include_text: false },
    perplexity: {
      ...baseConfig.perplexity,
      search_context_size: "low",
      disable_search: false,
      max_steps: 1,
    },
  };
}

function context(): PeerCallContext & { events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440051",
    round: 1,
    task: "perplexity effort ceiling regression",
    stream_tokens: false,
    emit: (event) => events.push(event),
    events,
  };
}

type StubPayload = Record<string, unknown>;

function completedResponse(id: string, model: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  };
}

function recordingAdapter(config: AppConfig): {
  adapter: PerplexityAdapter;
  payloads: StubPayload[];
} {
  const adapter = new PerplexityAdapter(config);
  const payloads: StubPayload[] = [];
  Object.defineProperty(adapter, "client", {
    configurable: true,
    value: async () => ({
      responses: {
        create: async (payload: StubPayload) => {
          payloads.push(payload);
          return { id: `resp_effort_${payloads.length}`, status: "queued" };
        },
      },
      get: async () => completedResponse("resp_effort_1", adapter.model, READY),
      post: async () => ({ response_id: "resp_effort_1", status: "cancelling" }),
    }),
  });
  return { adapter, payloads };
}

function effortOf(payload: StubPayload | undefined): unknown {
  return (payload?.reasoning as { effort?: unknown } | undefined)?.effort;
}

// (1) The clamp table: the accepted subset passes through, everything above
// it lands on `high`, and the aliases behave as before below the ceiling.
{
  assert.equal(clampEffortForPerplexity("none"), "minimal");
  assert.equal(clampEffortForPerplexity("minimal"), "minimal");
  assert.equal(clampEffortForPerplexity("low"), "low");
  assert.equal(clampEffortForPerplexity("medium"), "medium");
  assert.equal(clampEffortForPerplexity("high"), "high");
  assert.equal(clampEffortForPerplexity("xhigh"), "high", "xhigh is rejected by the pin");
  assert.equal(clampEffortForPerplexity("max"), "high", "max is rejected by the pin");
  assert.equal(clampEffortForPerplexity("ultra"), "high", "the alias lands on the ceiling");
  assert.equal(clampEffortForPerplexity(undefined), "high", "unset takes the ceiling");
  console.log("[v9.2.1-perplexity-effort-ceiling] clamp_table: PASS");
}

// (2) The shipped default is the ceiling the model accepts, not the enum's
// documented top.
{
  assert.equal(
    baseConfig.reasoning_effort.perplexity,
    process.env.CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT?.toLowerCase() || "high",
    "default Perplexity effort must be high (CROSREV-51)",
  );
  console.log("[v9.2.1-perplexity-effort-ceiling] default_is_high: PASS");
}

// (3) Reviewer path under a `max` override: the wire carries `high`, the
// search tool and the structured-output wrapper are untouched.
{
  const { adapter, payloads } = recordingAdapter(configWithEffort("max"));
  const result = await adapter.call("fixture", context());
  assert.equal(result.text, READY);
  assert.equal(payloads.length, 1);
  assert.equal(effortOf(payloads[0]), "high", "reviewer wire effort under a max override");
  assert.deepEqual(payloads[0]?.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(payloads[0]?.max_steps, 1);
  assert.equal(
    (payloads[0]?.response_format as { type?: unknown } | undefined)?.type,
    "json_schema",
  );
  console.log("[v9.2.1-perplexity-effort-ceiling] reviewer_wire_is_high: PASS");
}

// (4) Relator path under an `ultra` override: same ceiling, and the relator
// still sends no search tool.
{
  const { adapter, payloads } = recordingAdapter(configWithEffort("ultra"));
  const result = await adapter.generate("fixture", context());
  assert.equal(result.text, READY);
  assert.equal(payloads.length, 1);
  assert.equal(effortOf(payloads[0]), "high", "relator wire effort under an ultra override");
  assert.equal(payloads[0]?.tools, undefined, "the relator never sends the search tool");
  console.log("[v9.2.1-perplexity-effort-ceiling] relator_wire_is_high: PASS");
}

// (5) A per-call override above the ceiling is clamped the same way; one
// below it passes through unchanged.
{
  const { adapter, payloads } = recordingAdapter(configWithEffort("high"));
  await adapter.call("fixture", { ...context(), reasoning_effort_override: "xhigh" });
  await adapter.call("fixture", { ...context(), reasoning_effort_override: "medium" });
  assert.equal(effortOf(payloads[0]), "high", "xhigh per-call override is clamped");
  assert.equal(effortOf(payloads[1]), "medium", "medium per-call override passes through");
  console.log("[v9.2.1-perplexity-effort-ceiling] per_call_override_is_clamped: PASS");
}

// (6) No request ever carries a value outside the accepted subset, whatever
// the configured scale value is.
{
  const accepted = new Set(["minimal", "low", "medium", "high"]);
  for (const effort of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ] as const) {
    const { adapter, payloads } = recordingAdapter(configWithEffort(effort));
    await adapter.call("fixture", context());
    assert.ok(
      accepted.has(String(effortOf(payloads[0]))),
      `configured ${effort} must never reach the wire outside the accepted subset (got ${String(effortOf(payloads[0]))})`,
    );
  }
  console.log("[v9.2.1-perplexity-effort-ceiling] wire_never_exceeds_ceiling: PASS");
}

console.log("[v9.2.1-perplexity-effort-ceiling] ALL CASES PASS");
