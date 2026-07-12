import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import type { PeerCallContext, PeerFailure, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";
import { withRetry } from "../src/peers/retry.js";

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
  reasoning_tokens?: number;
};

const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  retry: { ...baseConfig.retry, max_attempts: 1 },
  streaming: { ...baseConfig.streaming, tokens: true, include_text: false },
};

const terminalBillingRate = { input_per_million: 1, output_per_million: 2 };
const billingConfig = {
  ...config,
  retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
  cost_rates: {
    ...config.cost_rates,
    codex: terminalBillingRate,
    claude: terminalBillingRate,
    gemini: terminalBillingRate,
    deepseek: terminalBillingRate,
    grok: terminalBillingRate,
    perplexity: terminalBillingRate,
  },
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

async function assertBilledTerminalRejection(
  run: () => Promise<unknown>,
  expected: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
    total_cost: number;
    failure_class?: string;
  },
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    const failure = (
      error as Error & {
        peerFailure?: {
          failure_class?: string;
          retryable?: boolean;
          attempts?: number;
          billing_status?: string;
          unpriced_attempts?: number;
          usage?: BillingUsage;
          cost?: { total_cost?: number };
        };
      }
    ).peerFailure;
    assert.ok(failure, "terminal rejection must preserve structured PeerFailure metadata");
    assert.equal(failure?.retryable, false);
    assert.equal(failure?.attempts, 1, "a terminal provider outcome must not be retried");
    assert.equal(failure?.billing_status, "reported");
    assert.equal(failure?.unpriced_attempts ?? 0, 0);
    assert.equal(failure?.failure_class, expected.failure_class ?? "provider_error");
    assert.equal(failure?.usage?.input_tokens, expected.input_tokens);
    assert.equal(failure?.usage?.output_tokens, expected.output_tokens);
    assert.equal(failure?.usage?.total_tokens, expected.total_tokens);
    if (expected.reasoning_tokens !== undefined) {
      assert.equal(failure?.usage?.reasoning_tokens, expected.reasoning_tokens);
    }
    assert.ok(
      Math.abs((failure?.cost?.total_cost ?? Number.NaN) - expected.total_cost) < 1e-12,
      `terminal billing mismatch: ${JSON.stringify(failure?.cost)}`,
    );
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

// DeepSeek documents insufficient_system_resource as an interrupted inference,
// not a completed answer. It is transient: discard partial output, preserve
// billing, and use the configured bounded retry envelope.
{
  const adapter = new DeepSeekAdapter(billingConfig);
  let calls = 0;
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return calls === 1
            ? {
                model: adapter.model,
                choices: [
                  {
                    finish_reason: "insufficient_system_resource",
                    message: { content: "partial" },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }
            : {
                model: adapter.model,
                choices: [{ finish_reason: "stop", message: { content: READY } }],
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
              };
        },
      },
    },
  });
  const result = await adapter.call("fixture", context());
  assert.equal(calls, 2);
  assert.equal(result.usage?.input_tokens, 17);
  assert.equal(result.usage?.output_tokens, 8);
  assert.equal(result.usage?.total_tokens, 25);
}

{
  const adapter = new DeepSeekAdapter(billingConfig);
  let calls = 0;
  const ctx = context(true);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return calls === 1
            ? events([
                {
                  model: adapter.model,
                  choices: [
                    {
                      finish_reason: "insufficient_system_resource",
                      delta: { content: "partial" },
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                },
              ])
            : events([
                {
                  model: adapter.model,
                  choices: [{ finish_reason: "stop", delta: { content: "healthy" } }],
                  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
                },
              ]);
        },
      },
    },
  });
  const result = await adapter.generate("fixture", ctx);
  assert.equal(calls, 2);
  assert.equal(result.text, "healthy");
  assert.equal(result.usage?.input_tokens, 17);
  assert.equal(result.usage?.output_tokens, 8);
  assert.ok(ctx.events.some((event) => event.type === "peer.token.discarded"));
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
  await assertTerminalRejection(
    () => adapter.call("fixture", context()),
    /prompt.*blocked|blockReason/i,
  );
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

// A max_tokens response is recoverable only when MEDIUM is a genuine effort
// reduction. LOW/MEDIUM requests must never be repeated at the same or a
// higher effort merely because the model is Fable 5.
for (const requestedEffort of ["low", "medium"] as const) {
  const noReductionConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 2, base_delay_ms: 1, max_delay_ms: 1 },
    reasoning_effort: { ...config.reasoning_effort, claude: requestedEffort },
  };
  const adapter = new AnthropicAdapter(noReductionConfig);
  const efforts: unknown[] = [];
  let calls = 0;
  setClient(adapter, {
    messages: {
      create: async (body: { output_config?: { effort?: unknown } }) => {
        calls += 1;
        efforts.push(body.output_config?.effort);
        return {
          content: [{ type: "text", text: READY }],
          model: adapter.model,
          stop_reason: "max_tokens",
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
  assert.equal(calls, 1, `${requestedEffort} effort must not trigger Fable recovery`);
  assert.deepEqual(efforts, [requestedEffort]);
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

// Provider terminal metadata is returned after the provider has already
// accepted and processed the request. Every rejected terminal must therefore
// retain the usage/cost ledger for that attempt instead of being mislabeled as
// an unpriced local failure.
{
  const adapter = new DeepSeekAdapter(billingConfig);
  let calls = 0;
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return {
            model: adapter.model,
            choices: [{ finish_reason: "length", message: { content: READY } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
  assert.equal(calls, 1);
}

{
  const adapter = new DeepSeekAdapter(billingConfig);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () =>
          events([
            {
              model: adapter.model,
              choices: [{ finish_reason: "length", delta: { content: READY } }],
              usage: null,
            },
            {
              model: adapter.model,
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]),
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context(true)), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () => ({
          model: adapter.model,
          choices: [{ finish_reason: "content_filter", message: { content: READY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    chat: {
      completions: {
        create: async () =>
          events([
            {
              model: adapter.model,
              choices: [{ finish_reason: "content_filter", delta: { content: READY } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]),
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context(true)), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

{
  const adapter = new OpenAIAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output_text: READY,
        model: adapter.model,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

{
  const adapter = new GrokAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output_text: READY,
        model: adapter.model,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

// xAI documents Responses errors alongside completed/in_progress/incomplete
// statuses rather than an OpenAI-only `failed` enum. Preserve a non-null error
// before generic incomplete-terminal rejection.
{
  const oneAttemptConfig = {
    ...billingConfig,
    retry: { ...billingConfig.retry, max_attempts: 1 },
  };
  const adapter = new GrokAdapter(oneAttemptConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "incomplete",
        model: adapter.model,
        error: {
          code: "rate_limit_exceeded",
          message: "xAI response envelope rate limit.",
          status: 429,
        },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      assert.equal(failure?.failure_class, "rate_limit");
      assert.equal(failure?.billing_status, "reported");
      assert.match(String(failure?.message), /xAI response envelope rate limit/i);
      return true;
    },
  );
}

// A non-stream Responses `status=failed` carries the provider error object.
// Preserve it before the generic terminal assertion so rate limits and prompt
// moderation retain their original classification as well as billing.
{
  const oneAttemptConfig = {
    ...billingConfig,
    retry: { ...billingConfig.retry, max_attempts: 1 },
  };
  const adapter = new OpenAIAdapter(oneAttemptConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "failed",
        model: adapter.model,
        error: {
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          message: "Provider request rate limit exceeded.",
          status: 429,
        },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      assert.equal(failure?.failure_class, "rate_limit");
      assert.equal(failure?.retryable, true);
      assert.equal(failure?.billing_status, "reported");
      assert.equal(failure?.unpriced_attempts ?? 0, 0);
      assert.equal((failure?.usage as BillingUsage | undefined)?.total_tokens, 15);
      assert.ok(
        Math.abs(
          ((failure?.cost as { total_cost?: number } | undefined)?.total_cost ?? Number.NaN) -
            0.00002,
        ) < 1e-12,
      );
      assert.match(String(failure?.message), /rate limit exceeded/i);
      return true;
    },
  );
}

// A retryable terminal with reported usage must be merged into a later
// successful attempt instead of disappearing from the final ledger.
{
  const adapter = new OpenAIAdapter(billingConfig);
  let calls = 0;
  setClient(adapter, {
    responses: {
      create: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: "failed",
            model: adapter.model,
            error: { code: "server_error", message: "Transient provider failure." },
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        }
        return {
          status: "completed",
          model: adapter.model,
          output_text: READY,
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        };
      },
    },
  });
  const result = await adapter.call("fixture", context());
  assert.equal(calls, 2);
  assert.deepEqual(
    {
      input: result.usage?.input_tokens,
      output: result.usage?.output_tokens,
      total: result.usage?.total_tokens,
      attempts: result.attempts,
      unpriced: result.unpriced_attempts ?? 0,
    },
    { input: 30, output: 15, total: 45, attempts: 2, unpriced: 0 },
  );
  assert.ok(Math.abs((result.cost?.total_cost ?? Number.NaN) - 0.00006) < 1e-12);
}

// Direct withRetry regression: a provider result is first merged with prior
// retry billing, then cancellation wins immediately after settlement. The
// cancellation failure must retain that settled ledger exactly once.
{
  const controller = new AbortController();
  let calls = 0;
  const failureFromError = (error: unknown, attempt: number, started: number): PeerFailure => {
    const record = error as {
      name?: string;
      message?: string;
      usage?: BillingUsage;
    };
    return {
      peer: "codex",
      provider: "openai",
      failure_class: record.name === "AbortError" ? "cancelled" : "provider_error",
      message: record.message ?? String(error),
      retryable: record.name !== "AbortError",
      attempts: attempt,
      latency_ms: Date.now() - started,
      ...(record.usage ? { usage: record.usage, billing_status: "reported" as const } : {}),
    };
  };
  await assert.rejects(
    () =>
      withRetry(
        billingConfig,
        async (attempt) => {
          calls += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("retryable billed failure"), {
              retry_billing_requires_merge: true,
              accounted_attempts: 1,
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            });
          }
          controller.abort("after settled result");
          return { usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } };
        },
        failureFromError,
        { signal: controller.signal },
      ),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.equal(failure?.failure_class, "cancelled");
      assert.equal(failure?.attempts, 2);
      assert.equal(failure?.usage?.input_tokens, 17);
      assert.equal(failure?.usage?.output_tokens, 25);
      assert.equal(failure?.usage?.total_tokens, 42);
      return true;
    },
  );
  assert.equal(calls, 2);
}

// Direct withRetry regression: cancellation can become visible after the
// retry delay resolves but before the next provider attempt begins. Billing
// from completed prior attempts must survive that top-of-loop cancellation.
{
  const controller = new AbortController();
  let abortOnDelayCleanup = true;
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return controller.signal.reason;
    },
    addEventListener(...args: Parameters<AbortSignal["addEventListener"]>) {
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>) {
      controller.signal.removeEventListener(...args);
      if (abortOnDelayCleanup) {
        abortOnDelayCleanup = false;
        controller.abort("before next retry attempt");
      }
    },
  } as AbortSignal;
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        billingConfig,
        async () => {
          calls += 1;
          throw Object.assign(new Error("retryable billed failure"), {
            retry_billing_requires_merge: true,
            accounted_attempts: 1,
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          });
        },
        (error, attempt, started): PeerFailure => {
          const record = error as { name?: string; message?: string };
          return {
            peer: "codex",
            provider: "openai",
            failure_class: record.name === "AbortError" ? "cancelled" : "provider_error",
            message: record.message ?? String(error),
            retryable: record.name !== "AbortError",
            attempts: attempt,
            latency_ms: Date.now() - started,
          };
        },
        { signal },
      ),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.equal(failure?.failure_class, "cancelled");
      assert.equal(failure?.attempts, 1);
      assert.equal(failure?.usage?.input_tokens, 10);
      assert.equal(failure?.usage?.output_tokens, 20);
      assert.equal(failure?.usage?.total_tokens, 30);
      assert.equal(failure?.billing_status, "reported");
      return true;
    },
  );
  assert.equal(calls, 1);
}

// Direct withRetry regression: a billed retry followed by an unpriced final
// failure has only partial cost coverage. Retaining prior usage must not turn
// that incomplete ledger into a misleading `reported` billing status.
{
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        billingConfig,
        async (attempt) => {
          calls += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("retryable billed failure"), {
              retry_billing_requires_merge: true,
              accounted_attempts: 1,
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            });
          }
          throw new Error("fetch failed without provider usage");
        },
        (error, attempt, started): PeerFailure => ({
          peer: "codex",
          provider: "openai",
          failure_class: "network",
          message: error instanceof Error ? error.message : String(error),
          retryable: attempt < 2,
          attempts: attempt,
          latency_ms: Date.now() - started,
          billing_status: "unknown",
          unpriced_attempts: attempt,
        }),
      ),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.equal(failure?.failure_class, "network");
      assert.equal(failure?.attempts, 2);
      assert.equal(failure?.usage?.total_tokens, 30);
      assert.equal(failure?.unpriced_attempts, 1);
      assert.equal(failure?.billing_status, "unknown");
      return true;
    },
  );
  assert.equal(calls, 2);
}

// Official Responses SSE errors use `type=error` and top-level fields. Both
// OpenAI and the xAI Responses-compatible adapter must retain that signal.
for (const adapter of [
  new OpenAIAdapter({ ...billingConfig, retry: { ...billingConfig.retry, max_attempts: 1 } }),
  new GrokAdapter({ ...billingConfig, retry: { ...billingConfig.retry, max_attempts: 1 } }),
]) {
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          {
            type: "error",
            code: "rate_limit_exceeded",
            message: "Official top-level stream error.",
            param: null,
            sequence_number: 1,
          },
        ]),
    },
  });
  await assert.rejects(
    () => adapter.call("fixture", context(true)),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      assert.equal(failure?.failure_class, "rate_limit");
      assert.match(String(failure?.message), /official top-level stream error/i);
      return true;
    },
  );
}

{
  const adapter = new GrokAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "failed",
        model: adapter.model,
        error: {
          code: "invalid_prompt",
          type: "invalid_request_error",
          message: "The input was rejected by policy.",
        },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
    failure_class: "prompt_flagged_by_moderation",
  });
}

{
  const anthropicBillingConfig = {
    ...billingConfig,
    reasoning_effort: { ...billingConfig.reasoning_effort, claude: "low" as const },
  };
  const adapter = new AnthropicAdapter(anthropicBillingConfig);
  setClient(adapter, {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: READY }],
        model: adapter.model,
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

{
  const adapter = new AnthropicAdapter(billingConfig);
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
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
    failure_class: "provider_refusal",
  });
}

{
  const adapter = new GeminiAdapter(billingConfig);
  setClient(adapter, {
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContent: async () => ({
          text: READY,
          modelVersion: adapter.model,
          promptFeedback: { blockReason: "SAFETY" },
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 2,
            totalTokenCount: 17,
          },
        }),
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 7,
    total_tokens: 17,
    reasoning_tokens: 2,
    total_cost: 0.000024,
    failure_class: "prompt_flagged_by_moderation",
  });
}

// Responses API refusals are a completed transport response but unusable model
// output. The non-streaming content part and both streaming refusal events must
// bypass status/format recovery, remain non-retryable, and preserve billing.
{
  const refusalModel = "gpt-terminal-refusal-fixture";
  const refusalConfig = {
    ...billingConfig,
    model_cost_rates: {
      ...billingConfig.model_cost_rates,
      codex: {
        ...billingConfig.model_cost_rates?.codex,
        [refusalModel]: terminalBillingRate,
      },
    },
  };
  const adapter = new OpenAIAdapter(refusalConfig, refusalModel);
  let calls = 0;
  setClient(adapter, {
    responses: {
      create: async () => {
        calls += 1;
        return {
          status: "completed",
          model: refusalModel,
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "I cannot assist with that request." }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
      },
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context()), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
    failure_class: "provider_refusal",
  });
  assert.equal(calls, 1, "Responses refusal must not enter adapter retry or format recovery");
}

{
  const adapter = new OpenAIAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.refusal.delta", delta: "I cannot" },
          { type: "response.refusal.done", refusal: "I cannot assist." },
          {
            type: "response.completed",
            response: {
              status: "completed",
              model: adapter.model,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]),
    },
  });
  await assertBilledTerminalRejection(() => adapter.generate("fixture", context(true)), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
    failure_class: "provider_refusal",
  });
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
