import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { maxOutputTokensForPeer } from "../src/core/output-budget.js";
import type { PeerCallContext, PeerFailure, PeerId, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { STREAM_TEXT_MAX_BYTES } from "../src/peers/base.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { resolveBestModel } from "../src/peers/model-selection.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import {
  PerplexityAdapter,
  stripPerplexityThinkingBlock,
  stripPerplexityThinkingForTokenEvents,
} from "../src/peers/perplexity.js";
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
  num_search_queries?: number;
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
    // v4.6.0: the Perplexity Agent API pin also bills web_search per
    // invocation; price it at 1 USD each so search accounting is visible.
    perplexity: { ...terminalBillingRate, search_queries_per_1000: 1000 },
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

// DeepSeek native Responses rejects missing/completed-with-refusal/incomplete
// terminals. Neither a plausible provisional verdict nor reasoning is final text.
function deepSeekResponse(
  model: string,
  text: string | null | undefined,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "deepseek-native-response-fixture",
    status: "completed",
    model,
    output: [
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "fixture-private-reasoning" }],
      },
      {
        type: "message",
        role: "assistant",
        content: text === undefined ? [] : [{ type: "output_text", text }],
      },
    ],
    ...overrides,
  };
}

for (const terminal of [undefined, "incomplete", "in_progress", "failed"] as const) {
  for (const streamed of [false, true]) {
    for (const phase of ["call", "generate"] as const) {
      const adapter = new DeepSeekAdapter(config);
      const response = deepSeekResponse(adapter.model, READY, {
        status: terminal,
        ...(terminal === "incomplete"
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
      });
      setClient(adapter, {
        responses: {
          create: async () =>
            streamed
              ? events([
                  { type: "response.output_text.delta", delta: READY },
                  ...(terminal === undefined
                    ? []
                    : [
                        {
                          type: `response.${terminal}`,
                          response,
                        },
                      ]),
                ])
              : response,
        },
      });
      await assertTerminalRejection(
        () => adapter[phase]("fixture", context(streamed)),
        /terminal|incomplete|failed/i,
      );
    }
  }
}

// Native Responses preserves the existing UTF8 streaming resource bound,
// even when the eventual completed message would have been small and healthy.
for (const phase of ["call", "generate"] as const) {
  const adapter = new DeepSeekAdapter(config);
  let calls = 0;
  const oversizedDelta = `${"é".repeat(STREAM_TEXT_MAX_BYTES / 2)}a`;
  setClient(adapter, {
    responses: {
      create: async () => {
        calls += 1;
        return events([
          { type: "response.output_text.delta", delta: oversizedDelta },
          { type: "response.completed", response: deepSeekResponse(adapter.model, "healthy") },
        ]);
      },
    },
  });
  const ctx = context(true);
  await assert.rejects(() => adapter[phase]("fixture", ctx), /streaming response exceeded.*bytes/);
  assert.equal(calls, 1);
  assert.equal(
    ctx.events.some((event) => event.type === "peer.token.completed"),
    false,
  );
  assert.ok(ctx.events.some((event) => event.type === "peer.token.discarded"));
}

// Completed-only assistant text has the same cap, preserving its already
// reported native billing even without provisional delta events.
for (const phase of ["call", "generate"] as const) {
  const adapter = new DeepSeekAdapter(billingConfig);
  const oversizedFinalText = `${"é".repeat(STREAM_TEXT_MAX_BYTES / 2)}a`;
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          {
            type: "response.completed",
            response: deepSeekResponse(adapter.model, oversizedFinalText, {
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
          },
        ]),
    },
  });
  const ctx = context(true);
  await assertBilledTerminalRejection(() => adapter[phase]("fixture", ctx), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
  assert.equal(
    ctx.events.some((event) => event.type === "peer.token.completed"),
    false,
  );
}

// Native server_error remains inside the existing bounded retry envelope;
// billing from the rejected attempt and its provisional token discard survive.
for (const streamed of [false, true]) {
  for (const phase of ["call", "generate"] as const) {
    const adapter = new DeepSeekAdapter(billingConfig);
    let calls = 0;
    const ctx = context(streamed);
    setClient(adapter, {
      responses: {
        create: async () => {
          calls += 1;
          const response =
            calls === 1
              ? deepSeekResponse(adapter.model, "partial", {
                  status: "failed",
                  error: { code: "server_error", message: "synthetic native inference failure" },
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                })
              : deepSeekResponse(adapter.model, phase === "call" ? READY : "healthy", {
                  usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
                });
          return streamed
            ? events([
                {
                  type: "response.output_text.delta",
                  delta: calls === 1 ? "partial" : phase === "call" ? READY : "healthy",
                },
                { type: calls === 1 ? "response.failed" : "response.completed", response },
              ])
            : response;
        },
      },
    });
    const result = await adapter[phase]("fixture", ctx);
    assert.equal(calls, 2);
    assert.equal(result.text, phase === "call" ? READY : "healthy");
    assert.equal(result.usage?.input_tokens, 17);
    assert.equal(result.usage?.output_tokens, 8);
    assert.equal(result.usage?.total_tokens, 25);
    if (streamed) assert.ok(ctx.events.some((event) => event.type === "peer.token.discarded"));
  }
}

// v4.6.0: Perplexity speaks the Agent API (Responses protocol). A
// non-completed terminal — content filtering or output exhaustion — must be
// rejected even when a plausible READY payload is present.
{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        model: adapter.model,
        output: [{ type: "message", content: [{ type: "output_text", text: READY }] }],
      }),
    },
  });
  await assertTerminalRejection(() => adapter.call("fixture", context()));
}

// Codex review round 5: a completed Agent API response without assistant
// message text must surface as EMPTY text (handled by the status parser and
// the orchestrator's empty-generation guards), never as a JSON serialization
// of the provider envelope that could be promoted as a relator draft.
{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "completed",
        model: adapter.model,
        output: [{ type: "search_results", queries: ["fixture"], results: [] }],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      }),
    },
  });
  const degenerate = await adapter.generate("fixture", context());
  assert.equal(degenerate.text, "", "tool-only terminals must yield empty text, not raw JSON");
}

// A `failed` terminal carries the provider error; the rejection must surface
// that message instead of a bare status (parity with openai.ts/grok.ts).
{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "failed",
        model: adapter.model,
        output: [],
        error: { message: "model overloaded upstream", code: "server_error" },
      }),
    },
  });
  await assert.rejects(
    () => adapter.generate("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: Record<string, unknown> }).peerFailure;
      assert.ok(failure, "failed terminal must preserve structured PeerFailure metadata");
      assert.match(String(failure?.message), /model overloaded upstream/i);
      return true;
    },
  );
}

{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: READY },
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              model: adapter.model,
            },
          },
        ]),
    },
  });
  await assertTerminalRejection(() => adapter.generate("fixture", context(true)));
}

// Codex review round 9: a cancelled stream terminal can still carry final
// usage; the rejected attempt must retain that accounting instead of being
// settled as an unpriced missing-completion.
{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: "partial " },
          {
            type: "response.cancelled",
            response: {
              id: "resp_fixture_cancelled_usage",
              status: "cancelled",
              model: adapter.model,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]),
    },
  });
  await assertBilledTerminalRejection(() => adapter.call("fixture", context(true)), {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    total_cost: 0.00002,
  });
}

// The Agent API `response.completed` event carries the aggregate output
// items. When no usable delta text was streamed, the adapter must read the
// terminal message instead of mistaking the empty delta buffer for a blank
// model response and triggering a second paid decision-retry call.
{
  const adapter = new PerplexityAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: "" },
          {
            type: "response.completed",
            response: {
              id: "resp_fixture_terminal_aggregate",
              status: "completed",
              model: adapter.model,
              output: [
                { type: "search_results", queries: ["fixture"], results: [] },
                { type: "message", content: [{ type: "output_text", text: READY }] },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]),
    },
  });
  const result = await adapter.call("fixture", context(true));
  assert.equal(result.text, READY);
  assert.equal(result.raw_status, "READY");
  const rawTelemetry = result.raw as Record<string, unknown>;
  assert.deepEqual(
    {
      streamed: rawTelemetry.streamed,
      request_id: rawTelemetry.request_id,
      events: rawTelemetry.events,
      raw_delta_chars: rawTelemetry.raw_delta_chars,
      terminal_message_chars: rawTelemetry.terminal_message_chars,
      visible_chars: rawTelemetry.visible_chars,
      terminal_message_fallback_used: rawTelemetry.terminal_message_fallback_used,
      empty_usable_output: rawTelemetry.empty_usable_output,
    },
    {
      streamed: true,
      request_id: "resp_fixture_terminal_aggregate",
      events: 2,
      raw_delta_chars: 0,
      terminal_message_chars: READY.length,
      visible_chars: READY.length,
      terminal_message_fallback_used: true,
      empty_usable_output: false,
    },
  );
  assert.equal(result.usage?.input_tokens, 10);
  assert.equal(result.usage?.output_tokens, 5);
  const generated = await adapter.generate("fixture", context(true));
  assert.equal(generated.text, READY);
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

// The current native contract bills these three refusal categories before
// output. Other/null categories are currently unbilled; this is not a promise
// about future billing policy. Review/generation and both transports agree.
for (const category of [
  "bio",
  "frontier_llm",
  "reasoning_extraction",
  "cyber",
  "general_harms",
  "unrecognized-fixture-category",
  null,
] as const) {
  const billed =
    category === "bio" || category === "frontier_llm" || category === "reasoning_extraction";
  for (const streamed of [false, true]) {
    for (const phase of ["review", "generation"] as const) {
      const adapter = new AnthropicAdapter(billingConfig);
      let calls = 0;
      const message = {
        content: [],
        model: adapter.model,
        stop_reason: "refusal",
        stop_details: { type: "refusal", category },
        usage: { input_tokens: 10, output_tokens: 0 },
      };
      setClient(adapter, {
        messages: {
          create: async () => {
            calls += 1;
            return message;
          },
          stream: () => {
            calls += 1;
            return {
              controller: { abort: () => undefined },
              on: () => undefined,
              finalMessage: async () => message,
            };
          },
        },
      });
      const ctx = context(streamed);
      await assertBilledTerminalRejection(
        () =>
          phase === "review" ? adapter.call("fixture", ctx) : adapter.generate("fixture", ctx),
        {
          input_tokens: 10,
          output_tokens: 0,
          total_tokens: 10,
          total_cost: billed ? 0.00001 : 0,
          failure_class: "provider_refusal",
        },
      );
      assert.equal(calls, 1, "a classifier refusal must not trigger retry or fallback");
      const refusal = ctx.events.find((event) => event.type === "provider.refusal");
      assert.equal(refusal?.data?.billed, billed);
      assert.equal(refusal?.data?.category, category);
      assert.equal(refusal?.data?.usable_output, false);
    }
  }
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
for (const streamed of [false, true]) {
  for (const phase of ["call", "generate"] as const) {
    const adapter = new DeepSeekAdapter(billingConfig);
    let calls = 0;
    const response = deepSeekResponse(adapter.model, READY, {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
    setClient(adapter, {
      responses: {
        create: async () => {
          calls += 1;
          return streamed
            ? events([
                { type: "response.output_text.delta", delta: READY },
                { type: "response.incomplete", response },
              ])
            : response;
        },
      },
    });
    await assertBilledTerminalRejection(() => adapter[phase]("fixture", context(streamed)), {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      reasoning_tokens: 3,
      total_cost: 0.00002,
    });
    assert.equal(calls, 1);
  }
}

{
  const adapter = new PerplexityAdapter(billingConfig);
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

// v4.6.0: an Agent API `incomplete` terminal can arrive with `usage: null`
// (output budget exhausted). The provider still billed the prompt and the
// output budget, so the rejected attempt must be priced with the request
// envelope (prompt chars / 4 + max_output_tokens) rather than settle as zero.
async function assertEstimatedIncompleteBilling(
  run: () => Promise<unknown>,
  expectedSearches: number | undefined,
): Promise<void> {
  const expectedOutput = maxOutputTokensForPeer(billingConfig, "perplexity");
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    const failure = (
      error as Error & {
        peerFailure?: {
          billing_status?: string;
          unpriced_attempts?: number;
          usage?: BillingUsage;
          cost?: { total_cost?: number };
        };
      }
    ).peerFailure;
    assert.ok(failure, "incomplete terminal must preserve structured PeerFailure metadata");
    assert.equal(failure?.billing_status, "reported");
    assert.equal(failure?.unpriced_attempts ?? 0, 0);
    const inputTokens = failure?.usage?.input_tokens ?? 0;
    assert.ok(inputTokens > 0, "estimated input tokens must come from the prompt size");
    assert.equal(failure?.usage?.output_tokens, expectedOutput);
    assert.equal(failure?.usage?.total_tokens, inputTokens + expectedOutput);
    assert.equal(
      failure?.usage?.num_search_queries,
      expectedSearches,
      "reviewer requests declare web_search and must carry the declared search estimate; relator requests never do",
    );
    // billingConfig prices searches at 1000 USD per 1000 invocations (1 USD each).
    const expectedCost =
      inputTokens * 0.000001 + expectedOutput * 0.000002 + (expectedSearches ?? 0) * 1;
    assert.ok(
      Math.abs((failure?.cost?.total_cost ?? Number.NaN) - expectedCost) < 1e-12,
      `estimated incomplete billing mismatch: ${JSON.stringify(failure?.cost)}`,
    );
    return true;
  });
}

{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        model: adapter.model,
        output: [],
        usage: null,
      }),
    },
  });
  await assertEstimatedIncompleteBilling(
    () => adapter.call("fixture", context()),
    billingConfig.perplexity.web_search_invocations_estimate,
  );
}

{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: "partial" },
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              model: adapter.model,
              usage: null,
            },
          },
        ]),
    },
  });
  await assertEstimatedIncompleteBilling(
    () => adapter.generate("fixture", context(true)),
    undefined,
  );
}

{
  const adapter = new PerplexityAdapter(billingConfig);
  setClient(adapter, {
    responses: {
      create: async () =>
        events([
          { type: "response.output_text.delta", delta: READY },
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
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
// The completed native Responses metadata, final assistant text and cache /
// reasoning usage survive both roles. Unknown native IDs stay unknown; no
// Chat finish_reason or HTTP request_id is manufactured.
for (const responseId of ["deepseek-native-response-fixture", undefined]) {
  for (const phase of ["call", "generate"] as const) {
    const adapter = new DeepSeekAdapter(config);
    const usage = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 120,
    };
    const response = deepSeekResponse(adapter.model, "healthy", { id: responseId, usage });
    setClient(adapter, {
      responses: {
        create: async () =>
          events([
            { type: "response.created", response: { ...response, status: "in_progress" } },
            { type: "response.reasoning_text.delta", delta: "fixture-private-reasoning" },
            { type: "response.output_text.delta", delta: "healthy" },
            { type: "response.completed", response },
          ]),
      },
    });
    const ctx = context(true);
    const result = await adapter[phase]("fixture", ctx);
    assert.equal(result.text, "healthy");
    assert.deepEqual(result.raw, {
      streamed: true,
      provider: "deepseek",
      chunks: 4,
      model: adapter.model,
      response_id: responseId ?? null,
      status: "completed",
      incomplete_details: null,
      error: null,
      output: response.output.filter((item) => item.type === "message"),
      usage,
    });
    assert.equal(result.usage?.input_tokens, 60);
    assert.equal(result.usage?.cache_read_tokens, 40);
    assert.equal(result.usage?.cache_write_tokens, undefined);
    assert.equal(result.usage?.output_tokens, 20);
    assert.equal(result.usage?.reasoning_tokens, 12);
    assert.equal(result.usage?.total_tokens, 120);
    assert.equal(
      ctx.events.some((event) => event.type === "provider.terminal_rejected"),
      false,
    );
  }
}

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
  const response = deepSeekResponse(adapter.model, "healthy");
  setClient(adapter, { responses: { create: async () => response } });
  const result = await adapter.generate("fixture", context());
  assert.equal(result.text, "healthy");
  assert.equal(result.raw, response);
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

// Literal reasoning tags in structured evidence belong to the final answer.
// Suppress leading provider reasoning without changing quoted JSON strings,
// including a tag that is only partially received in the streaming buffer.
{
  const literalReady = JSON.stringify({
    status: "READY",
    summary: "Preserve literal <think>marker</think> in evidence.",
    confidence: "inferred",
    evidence_sources: [],
    caller_requests: [],
    follow_ups: [],
  });
  for (const preamble of [
    "",
    "<think>fixture reasoning</think>",
    "<think>one</think><think>two</think>",
  ]) {
    assert.equal(stripPerplexityThinkingBlock(preamble + literalReady), literalReady);
    assert.equal(stripPerplexityThinkingForTokenEvents(preamble + literalReady), literalReady);
  }
  assert.equal(
    stripPerplexityThinkingForTokenEvents('{"summary":"literal <thi'),
    '{"summary":"literal <thi',
  );
  for (const streamed of [false, true]) {
    const adapter = new PerplexityAdapter(config);
    const terminal = {
      status: "completed",
      model: adapter.model,
      output: [{ type: "message", content: [{ type: "output_text", text: literalReady }] }],
    };
    setClient(adapter, {
      responses: {
        create: async () =>
          streamed
            ? events([
                { type: "response.output_text.delta", delta: literalReady },
                { type: "response.completed", response: terminal },
              ])
            : terminal,
      },
    });
    assert.equal((await adapter.call("fixture", context(streamed))).text, literalReady);
    assert.equal((await adapter.generate("fixture", context(streamed))).text, literalReady);
  }
}

// Completed reasoning-only, wrong-role or missing final text stays empty.
// Even a provisional READY delta cannot replace the completed native output.
for (const content of [null, "", "   ", undefined]) {
  for (const streamed of [false, true]) {
    const adapter = new DeepSeekAdapter(config);
    const response = deepSeekResponse(adapter.model, content);
    setClient(adapter, {
      responses: {
        create: async () =>
          streamed
            ? events([
                { type: "response.output_text.delta", delta: READY },
                { type: "response.completed", response },
              ])
            : response,
      },
    });
    for (const phase of ["call", "generate"] as const) {
      const result = await adapter[phase]("fixture", context(streamed));
      assert.equal(result.text, "");
      assert.ok(result.parser_warnings?.includes("deepseek_completed_without_assistant_text"));
    }
  }
}
for (const streamed of [false, true]) {
  const adapter = new DeepSeekAdapter(config);
  const response = deepSeekResponse(adapter.model, READY, {
    output: [
      { type: "message", role: "user", content: [{ type: "output_text", text: READY }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: READY }] },
    ],
  });
  setClient(adapter, {
    responses: {
      create: async () =>
        streamed ? events([{ type: "response.completed", response }]) : response,
    },
  });
  assert.equal((await adapter.generate("fixture", context(streamed))).text, "");
}

// Native refusal is billed, never retried or silently salvaged into final text.
for (const streamed of [false, true]) {
  for (const phase of ["call", "generate"] as const) {
    const adapter = new DeepSeekAdapter(billingConfig);
    let calls = 0;
    const response = deepSeekResponse(adapter.model, undefined, {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "synthetic native refusal" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    setClient(adapter, {
      responses: {
        create: async () => {
          calls += 1;
          return streamed
            ? events([
                { type: "response.refusal.delta", delta: "synthetic native refusal" },
                { type: "response.completed", response },
              ])
            : response;
        },
      },
    });
    await assertBilledTerminalRejection(() => adapter[phase]("fixture", context(streamed)), {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      total_cost: 0.00002,
      failure_class: "provider_refusal",
    });
    assert.equal(calls, 1);
  }
}

// Model-list authentication alone does not prove the configured model is
// reachable. Check missing pins and explicit authorization failures without
// making a tokenized request, then cover the successful pin.
for (const Adapter of [DeepSeekAdapter, GrokAdapter, PerplexityAdapter]) {
  for (const catalogCase of ["present", "absent", "unauthorized"] as const) {
    const adapter = new Adapter(config);
    let catalogCalls = 0;
    let tokenizedCalls = 0;
    setClient(adapter, {
      models: {
        list: async () => {
          catalogCalls += 1;
          if (catalogCase === "unauthorized") {
            throw Object.assign(new Error("Fixture authentication failed"), { status: 401 });
          }
          return {
            data: [{ id: catalogCase === "present" ? adapter.model : "fixture-other-model" }],
          };
        },
      },
      responses: {
        create: async () => {
          tokenizedCalls += 1;
          throw new Error("The catalog probe must not generate tokens");
        },
      },
    });
    const probe = await adapter.probe();
    assert.equal(probe.available, catalogCase === "present", `${adapter.id}: ${catalogCase}`);
    assert.equal(catalogCalls, 1);
    assert.equal(tokenizedCalls, 0);
    assert.equal(probe.model, adapter.model, "an absent pin must never select a fallback");
    if (catalogCase === "absent") assert.match(probe.message ?? "", /authenticated model catalog/);
    if (catalogCase === "unauthorized") assert.match(probe.message ?? "", /authentication failed/);
  }
}

// xAI's catalog publishes aliases alongside ids; a documented alias is
// available when its target is returned even if it is not itself an id.
{
  const adapter = new GrokAdapter(config);
  setClient(adapter, {
    models: {
      list: async () => ({ data: [{ id: "fixture-dated-model", aliases: [adapter.model] }] }),
    },
  });
  assert.equal((await adapter.probe()).available, true);
}

// Native xAI cost ticks include all billable token dimensions. Preserve the
// exact provider total alongside the existing configured-rate estimate.
{
  const adapter = new GrokAdapter(config);
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "completed",
        model: adapter.model,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: READY }] },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 15,
          total_tokens: 25,
          output_tokens_details: { reasoning_tokens: 12 },
          cost_in_usd_ticks: 37_756_000,
        },
      }),
    },
  });
  for (const operation of ["call", "generate"] as const) {
    const result = await adapter[operation]("fixture", context());
    assert.equal(result.usage?.provider_reported_total_cost_usd, 0.0037756);
    assert.equal(result.usage?.output_tokens, 15);
    assert.equal(result.usage?.reasoning_tokens, 12);
  }
}

// Current live Grok4.7 includes reasoning in output; older official examples
// separate it. Total-minus-input normalizes either contract without adding
// reasoning twice. Missing total never invents an additional billed bucket.
for (const [nativeUsage, expectedOutput, expectedTotal] of [
  [
    {
      input_tokens: 32,
      output_tokens: 9,
      total_tokens: 151,
      output_tokens_details: { reasoning_tokens: 110 },
      input_tokens_details: { cached_tokens: 8 },
    },
    119,
    151,
  ],
  [
    {
      input_tokens: 32,
      output_tokens: 119,
      total_tokens: 151,
      output_tokens_details: { reasoning_tokens: 110 },
      input_tokens_details: { cached_tokens: 8 },
    },
    119,
    151,
  ],
  [
    { input_tokens: 32, output_tokens: 9, output_tokens_details: { reasoning_tokens: 110 } },
    9,
    undefined,
  ],
  [
    {
      input_tokens: 1249,
      output_tokens: 31,
      total_tokens: 1280,
      output_tokens_details: { reasoning_tokens: 30 },
      input_tokens_details: { cached_tokens: 1152 },
    },
    31,
    1280,
  ],
] as const) {
  const adapter = new GrokAdapter({
    ...billingConfig,
    retry: { ...billingConfig.retry, max_attempts: 1 },
    cost_rates: {
      ...billingConfig.cost_rates,
      grok: { input_per_million: 1, output_per_million: 2, cache_read_per_million: 1 },
    },
  });
  setClient(adapter, {
    responses: {
      create: async () => ({
        status: "completed",
        model: adapter.model,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: READY }] },
        ],
        usage: { ...nativeUsage, cost_in_usd_ticks: 37_756_000 },
      }),
    },
  });
  for (const operation of ["call", "generate"] as const) {
    const result = await adapter[operation]("Native billing fixture.", context());
    assert.equal(result.usage?.output_tokens, expectedOutput);
    assert.equal(
      result.usage?.reasoning_tokens,
      nativeUsage.output_tokens_details.reasoning_tokens,
    );
    if (expectedTotal !== undefined) assert.equal(result.usage?.total_tokens, expectedTotal);
    const expectedCost = (nativeUsage.input_tokens + expectedOutput * 2) / 1_000_000;
    assert.ok(Math.abs((result.cost?.total_cost ?? 0) - expectedCost) < 1e-12);
    assert.equal(
      result.usage?.provider_reported_total_cost_usd,
      0.0037756,
      "native charged total stays separate from configured-rate estimate",
    );
  }
}

// Native Responses reasoning uses the documented low/high/max scale.
// Both roles preserve the same system instruction, configured output ceiling
// and caller context, without unsupported OpenAI controls or Chat fallback.
for (const [effort, expected] of [
  ["none", "low"],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "high"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "max"],
  ["ultra", "max"],
] as const) {
  for (const streamed of [false, true]) {
    const adapter = new DeepSeekAdapter(config);
    let payload: Record<string, unknown> | undefined;
    setClient(adapter, {
      responses: {
        create: async (body: Record<string, unknown>) => {
          payload = body;
          const response = deepSeekResponse(adapter.model, READY);
          return streamed ? events([{ type: "response.completed", response }]) : response;
        },
      },
    });
    for (const operation of ["call", "generate"] as const) {
      await adapter[operation]("fixture", {
        ...context(streamed),
        reasoning_effort_override: effort,
        max_output_tokens_override: 8192,
      });
      assert.ok(payload, "the native Responses request must be captured");
      assert.deepEqual(payload.reasoning, { effort: expected }, `${operation}: ${effort}`);
      assert.equal(typeof payload?.instructions, "string");
      assert.equal(payload?.model, adapter.model);
      assert.equal(payload?.max_output_tokens, 8192);
      assert.equal(payload?.stream, streamed ? true : undefined);
      for (const key of [
        "thinking",
        "reasoning_effort",
        "messages",
        "response_format",
        "store",
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
        "tools",
        "stream_options",
      ])
        assert.equal(payload?.[key], undefined, key);
      if (operation === "call") {
        const format = (
          payload.text as {
            format: {
              type: string;
              schema: { additionalProperties: boolean; required: readonly string[] };
            };
          }
        ).format;
        assert.equal(format.type, "json_schema");
        assert.equal(format.schema.additionalProperties, false);
        assert.deepEqual(format.schema.required, [
          "status",
          "summary",
          "confidence",
          "evidence_sources",
          "caller_requests",
          "follow_ups",
        ]);
      } else {
        assert.equal(payload?.text, undefined);
        assert.equal(payload?.input, "fixture");
      }
    }
  }
}

// Grok's documented best-effort cache-miss control is omission of the
// sticky routing key. Honor global and per-peer disable in both roles,
// preserving ordinary automatic caching behavior and literal input.
for (const [enabled, disabled, expectKey] of [
  [true, false, true],
  [true, true, false],
  [false, false, false],
] as const) {
  const adapter = new GrokAdapter({
    ...config,
    cache: {
      ...config.cache,
      enabled,
      disable_per_peer: { ...config.cache.disable_per_peer, grok: disabled },
    },
  });
  let payload: Record<string, unknown> | undefined;
  setClient(adapter, {
    responses: {
      create: async (body: Record<string, unknown>) => {
        payload = body;
        return {
          status: "completed",
          model: adapter.model,
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: READY }] },
          ],
        };
      },
    },
  });
  for (const operation of ["call", "generate"] as const) {
    await adapter[operation]("Literal cache fixture.", { ...context(), caller: "codex" });
    assert.equal(
      typeof payload?.prompt_cache_key === "string",
      expectKey,
      `${operation}: native cache routing key`,
    );
    assert.ok(
      JSON.stringify(payload?.input).includes("Literal cache fixture."),
      "cache controls do not rewrite evidence",
    );
  }
}

// Catalog discovery precedes adapter probes. Its actual official SDK
// transport must obey the configured timeout and make only one HTTP
// attempt, preserving the pin when the read fails.
{
  const originalFetch = globalThis.fetch;
  // SDK timeout timers are unref'ed; this fixture supplies the transport
  // handle that a real in-flight HTTP request would keep alive.
  const keepAlive = setInterval(() => {}, 1000);
  const modelOverrideNames: Record<PeerId, string> = {
    codex: "CROSS_REVIEW_OPENAI_MODEL",
    claude: "CROSS_REVIEW_ANTHROPIC_MODEL",
    gemini: "CROSS_REVIEW_GEMINI_MODEL",
    deepseek: "CROSS_REVIEW_DEEPSEEK_MODEL",
    grok: "CROSS_REVIEW_GROK_MODEL",
    perplexity: "CROSS_REVIEW_PERPLEXITY_MODEL",
  };
  const savedOverrides = Object.fromEntries(
    Object.values(modelOverrideNames).map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of Object.values(modelOverrideNames)) delete process.env[name];
    for (const peer of Object.keys(modelOverrideNames) as PeerId[]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: { type: "overloaded_error", message: "fixture overload" } }),
          { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
        );
      };
      const selection = await resolveBestModel(config, peer);
      assert.equal(calls, 1, `${peer}: catalog SDK must not retry invisibly`);
      assert.equal(selection.selected, config.models[peer]);
      assert.equal(selection.confidence, "unknown");
      let aborted = false;
      globalThis.fetch = async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => {
            aborted = true;
            reject(new DOMException("fixture aborted", "AbortError"));
          };
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      const timed = await resolveBestModel(
        { ...config, retry: { ...config.retry, timeout_ms: 30 } },
        peer,
      );
      assert.equal(aborted, true, `${peer}: native catalog timeout aborts the HTTP request`);
      assert.equal(timed.selected, config.models[peer]);
      assert.equal(timed.confidence, "unknown");
    }
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(savedOverrides)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

console.log("[provider-terminal-smoke] PASS");
