import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import type { PeerCallContext, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.OPENAI_API_KEY = "fixture-openai-key";
process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
process.env.GEMINI_API_KEY = "fixture-gemini-key";
process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
process.env.GROK_API_KEY = "fixture-grok-key";
process.env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-provider-terminal-"),
);

const READY = JSON.stringify({
  status: "READY",
  summary: "No blocking objections remain.",
  confidence: "inferred",
  evidence_sources: [],
  caller_requests: [],
  follow_ups: [],
});

type BillingUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  retry: { ...baseConfig.retry, max_attempts: 1 },
  streaming: { ...baseConfig.streaming, tokens: true, include_text: false },
};

function setClient(adapter: object, client: unknown): void {
  Object.defineProperty(adapter, "client", {
    configurable: true,
    value: async () => client,
  });
}

function context(stream = false): PeerCallContext & { events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440099",
    round: 1,
    task: "provider terminal smoke",
    stream_tokens: stream,
    emit: (event) => events.push(event),
    events,
  };
}

async function* events<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

function assertTerminalRejection(
  run: () => Promise<unknown>,
  expected: RegExp = /terminal|incomplete|finish_reason|finishReason|stop_reason|blockReason/i,
): Promise<void> {
  return assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    const failure = (
      error as Error & { peerFailure?: { failure_class?: string; retryable?: boolean } }
    ).peerFailure;
    assert.ok(failure, "terminal rejection must preserve structured PeerFailure metadata");
    assert.equal(failure?.retryable, false, "terminal rejection must not become skippable");
    return true;
  });
}

// Responses API: an apparently valid READY prefix is not usable when the
// provider reports an incomplete response or the stream never reaches the
// response.completed terminal event.
{
  const adapter = new OpenAIAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({ status: "incomplete", output_text: READY, model: adapter.model }),
    },
  });
  const ctx = context();
  await assertTerminalRejection(() => adapter.call("fixture", ctx));
  assert.ok(
    ctx.events.some(
      (event) =>
        event.type === "provider.terminal_rejected" &&
        event.data?.usable_output === false &&
        event.data?.retryable === false,
    ),
    "terminal rejection must emit a structured, fail-closed provider event",
  );
}

{
  const adapter = new OpenAIAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({ output_text: READY, model: adapter.model }),
    },
  });
  await assertTerminalRejection(
    () => adapter.call("fixture", context()),
    /status=missing|terminal/i,
  );
}

{
  const adapter = new OpenAIAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => events([{ type: "response.output_text.delta", delta: READY }]),
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context(true)));
}

{
  const adapter = new GrokAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: READY },
          { type: "response.incomplete", response: { status: "incomplete" } },
        ]),
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context(true)));
}

// Chat Completions: truncated/filtered output and streams without an allowed
// finish_reason cannot be promoted to a peer verdict or a relator artifact.
{
  const adapter = new DeepSeekAdapter(config);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => ({
          model: adapter.model,
          choices: [{ finish_reason: "length", message: { content: READY } }],
        }),
      },
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
}

{
  const adapter = new DeepSeekAdapter(config);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () =>
          events([{ model: adapter.model, choices: [{ delta: { content: READY } }] }]),
      },
    },
  });
  await assertTerminalRejection(() => adapter.generate("fixture", context(true)));
}

{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => ({
          model: adapter.model,
          choices: [{ finish_reason: "content_filter", message: { content: READY } }],
        }),
      },
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
}

{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () =>
          events([
            {
              model: adapter.model,
              choices: [{ finish_reason: "length", delta: { content: READY } }],
            },
          ]),
      },
    },
  });
  await assertTerminalRejection(() => adapter.generate("fixture", context(true)));
}

// Gemini exposes blocking and termination metadata separately from text.
// Either signal wins over a plausible READY prefix.
{
  const adapter = new GeminiAdapter(config);
  setClient(adapter, {
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContent: async () => ({
          text: READY,
          modelVersion: adapter.model,
          promptFeedback: { blockReason: "SAFETY" },
          candidates: [{ finishReason: "STOP" }],
        }),
      },
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
}

{
  const adapter = new GeminiAdapter(config);
  setClient(adapter, {
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContentStream: async () =>
          events([
            {
              text: READY,
              modelVersion: adapter.model,
              candidates: [{ finishReason: "MAX_TOKENS" }],
            },
          ]),
      },
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context(true)));
}

// Anthropic delivers a final Message for both streaming and non-streaming.
// A max-token or pause terminal must be checked before parsing any text.
{
  const adapter = new AnthropicAdapter(config);
  setClient(adapter, {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: READY }],
        model: adapter.model,
        stop_reason: "max_tokens",
      }),
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
}

// Claude Fable 5 gets exactly one controlled recovery from max_tokens. The
// second call lowers effort and the successful result retains billable usage
// from both provider responses.
{
  const recoveryConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" as const },
    cost_rates: {
      ...config.cost_rates,
      claude: { input_per_million: 1, output_per_million: 1 },
    },
  };
  const adapter = new AnthropicAdapter(recoveryConfig);
  const efforts: unknown[] = [];
  let calls = 0;
  setClient(adapter, {
    messages: {
      create: async (body: { output_config?: { effort?: unknown } }) => {
        calls += 1;
        efforts.push(body.output_config?.effort);
        if (calls === 1) {
          return {
            content: [{ type: "text", text: READY }],
            model: adapter.model,
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }
        return {
          content: [{ type: "text", text: READY }],
          model: adapter.model,
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 5 },
        };
      },
    },
  });
  const ctx = context();
  const result = await adapter.call("fixture", ctx);
  assert.equal(calls, 2, "Fable max_tokens recovery must make exactly one retry");
  assert.deepEqual(efforts, ["max", "medium"]);
  assert.equal(result.usage?.input_tokens, 17);
  assert.equal(result.usage?.output_tokens, 25);
  assert.equal(result.usage?.total_tokens, 42);
  assert.ok(
    ctx.events.some((event) => event.type === "peer.max_tokens_recovery.started"),
    "controlled max_tokens recovery must be observable",
  );
}

// If cancellation arrives after the recovery response settles, withRetry
// attaches the already-combined result. Anthropic must not merge the first
// max_tokens usage into that combined result a second time.
{
  const recoveryConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" as const },
    cost_rates: {
      ...config.cost_rates,
      claude: { input_per_million: 1, output_per_million: 1 },
    },
  };
  const controller = new AbortController();
  const adapter = new AnthropicAdapter(recoveryConfig);
  let calls = 0;
  setClient(adapter, {
    messages: {
      create: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "text", text: READY }],
            model: adapter.model,
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }
        controller.abort("after second settlement");
        return {
          content: [{ type: "text", text: READY }],
          model: adapter.model,
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 5 },
        };
      },
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", { ...context(), signal: controller.signal }),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      const usage = failure?.usage as BillingUsage | undefined;
      const cost = failure?.cost as { total_cost?: number } | undefined;
      assert.equal(failure?.failure_class, "cancelled");
      assert.equal(failure?.attempts, 2);
      assert.equal(failure?.unpriced_attempts ?? 0, 0);
      assert.equal(failure?.billing_status, "reported");
      assert.equal(usage?.input_tokens, 17);
      assert.equal(usage?.output_tokens, 25);
      assert.equal(usage?.total_tokens, 42);
      assert.ok(Math.abs((cost?.total_cost ?? 0) - 0.000042) < 1e-12);
      return true;
    },
  );
}

// A priced refusal after a priced max_tokens recovery has complete coverage.
// The classifier must not retain the refusal's pre-merge unpriced marker.
{
  const recoveryConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" as const },
    cost_rates: {
      ...config.cost_rates,
      claude: { input_per_million: 1, output_per_million: 1 },
    },
  };
  const adapter = new AnthropicAdapter(recoveryConfig);
  let calls = 0;
  setClient(adapter, {
    messages: {
      create: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "text", text: READY }],
            model: adapter.model,
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }
        return {
          content: [{ type: "text", text: READY }],
          model: adapter.model,
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "policy" },
          usage: { input_tokens: 7, output_tokens: 5 },
        };
      },
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      const usage = failure?.usage as BillingUsage | undefined;
      assert.equal(failure?.failure_class, "provider_refusal");
      assert.equal(failure?.unpriced_attempts ?? 0, 0);
      assert.equal(failure?.billing_status, "reported");
      assert.equal(usage?.input_tokens, 17);
      assert.equal(usage?.output_tokens, 25);
      assert.equal(usage?.total_tokens, 42);
      return true;
    },
  );
}

// If the controlled retry fails for an unrelated reason, the first
// max_tokens response remains billed and the unresolved second attempt is
// marked unpriced instead of disappearing from reconciliation.
{
  const recoveryConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" as const },
    cost_rates: {
      ...config.cost_rates,
      claude: { input_per_million: 1, output_per_million: 1 },
    },
  };
  const adapter = new AnthropicAdapter(recoveryConfig);
  let calls = 0;
  setClient(adapter, {
    messages: {
      create: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "text", text: READY }],
            model: adapter.model,
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }
        throw new Error("network fetch failed");
      },
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      assert.equal(failure?.failure_class, "network");
      assert.equal((failure?.usage as { total_tokens?: number } | undefined)?.total_tokens, 30);
      assert.equal(failure?.unpriced_attempts, 1);
      return true;
    },
  );
}

{
  const adapter = new AnthropicAdapter(config);
  setClient(adapter, {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: READY }],
        model: adapter.model,
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "policy" },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  });
  const ctx = context();
  await assert.rejects(() => adapter.call("fixture", ctx), /refusal/i);
  assert.ok(
    ctx.events.some(
      (event) =>
        event.type === "provider.refusal" &&
        event.data?.stop_reason === "refusal" &&
        event.data?.usable_output === false,
    ),
    "Anthropic refusal must discard partial output and emit an unusable-output event",
  );
}

{
  const adapter = new AnthropicAdapter(config);
  setClient(adapter, {
    messages: {
      stream: () => ({
        controller: { abort: () => undefined },
        on: () => undefined,
        finalMessage: async () => ({
          content: [{ type: "text", text: READY }],
          model: adapter.model,
          stop_reason: "pause_turn",
        }),
      }),
    },
  });
  await assertTerminalRejection(() => adapter.generate("fixture", context(true)));
}

// Healthy terminal states remain accepted.
{
  const adapter = new OpenAIAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({ status: "completed", output_text: "healthy", model: adapter.model }),
    },
  });
  assert.equal((await adapter.generate("fixture", context())).text, "healthy");
}

{
  const adapter = new DeepSeekAdapter(config);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => ({
          model: adapter.model,
          choices: [{ finish_reason: "stop", message: { content: "healthy" } }],
        }),
      },
    },
  });
  assert.equal((await adapter.generate("fixture", context())).text, "healthy");
}

{
  const adapter = new GeminiAdapter(config);
  setClient(adapter, {
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContent: async () => ({
          text: "healthy",
          modelVersion: adapter.model,
          candidates: [{ finishReason: "STOP" }],
        }),
      },
    },
  });
  assert.equal((await adapter.generate("fixture", context())).text, "healthy");
}

{
  const adapter = new AnthropicAdapter(config);
  setClient(adapter, {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "healthy" }],
        model: adapter.model,
        stop_reason: "end_turn",
      }),
    },
  });
  assert.equal((await adapter.generate("fixture", context())).text, "healthy");
}

console.log("[provider-terminal-smoke] PASS");
