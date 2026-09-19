// v09.02.00 — one re-creation after a bare asynchronous failure (CROSREV-48).
//
// Twice (sessions 5c55f692 on 14/09/2026 and 96dd5a4b on 18/09/2026) the
// Perplexity Agent API accepted the reviewer's create, then reported the
// background run `failed` at the first retrieval with the bare body
// `{"code":"invalid_request","message":"invalid request","type":"invalid_request"}`
// — no `param`, no HTTP status, no usage — about two seconds after the create.
// The payload is accepted when probed (CROSREV-48, 17/09/2026), so the failure
// is the provider's own, and because it classifies `retryable: false` it
// blocks ALL READY convergence for the whole session.
//
// The run is terminal when this is seen, so re-creating it cannot orphan a
// live, billing run (the hazard the v6.0.0 cases guard). These cases prove the
// adapter re-creates exactly once, through `withRetry` itself, and that every
// other failure keeps today's verdict. Same stubbed SDK surface as
// scripts/v6.0.0-perplexity-background-regression.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import type { AppConfig, PeerCallContext, PeerFailure, RuntimeEvent } from "../src/core/types.js";
import {
  isPerplexityBareAsyncFailure,
  PERPLEXITY_BARE_FAILURE_RECREATE_WINDOW_MS,
  PerplexityAdapter,
} from "../src/peers/perplexity.js";

process.env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-perplexity-bare-failure-"),
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
// `withRetry` is the re-creation mechanism, so the loop must be armed the way
// production arms it (three attempts); the cases assert it stops at two.
const config: AppConfig = {
  ...baseConfig,
  retry: { ...baseConfig.retry, max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 },
  streaming: { ...baseConfig.streaming, tokens: false, include_text: false },
  // A priced success is what separates the failed try (unpriced) from the
  // answer (priced) in the accounting the cases assert; without a rate card
  // both attempts would read as unpriced.
  cost_rates: {
    ...baseConfig.cost_rates,
    perplexity: { input_per_million: 3, output_per_million: 15 },
  },
};

function setClient(adapter: object, client: unknown): void {
  Object.defineProperty(adapter, "client", {
    configurable: true,
    value: async () => client,
  });
}

function context(options: { stream?: boolean } = {}): PeerCallContext & { events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440048",
    round: 1,
    task: "perplexity bare failure re-creation regression",
    stream_tokens: options.stream === true,
    emit: (event) => events.push(event),
    events,
  };
}

type StubPayload = Record<string, unknown>;

type Recorder = { payloads: StubPayload[]; getPaths: string[]; postPaths: string[] };

function recorder(): Recorder {
  return { payloads: [], getPaths: [], postPaths: [] };
}

function recordingClient(
  calls: Recorder,
  create: (payload: StubPayload, createIndex: number) => Promise<unknown>,
  get: (requestPath: string, getIndex: number) => Promise<unknown>,
): unknown {
  return {
    responses: {
      create: async (payload: StubPayload) => {
        calls.payloads.push(payload);
        return create(payload, calls.payloads.length);
      },
    },
    get: async (requestPath: string) => {
      calls.getPaths.push(requestPath);
      return get(requestPath, calls.getPaths.length);
    },
    post: async (requestPath: string) => {
      calls.postPaths.push(requestPath);
      return { response_id: "resp_fixture", status: "cancelling" };
    },
  };
}

// The 18/09/2026 terminal object, as retrieved: `failed`, the bare body with
// `type` and `code`, no `param`, no usage.
function bareFailedResponse(id: string): Record<string, unknown> {
  return {
    id,
    status: "failed",
    error: { code: "invalid_request", message: "invalid request", type: "invalid_request" },
    usage: null,
  };
}

function completedResponse(id: string, model: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  };
}

function peerFailureOf(error: unknown): PeerFailure {
  const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
  assert.ok(failure, "the rejection must carry the classified PeerFailure");
  return failure;
}

// (1) The reproduction, then the fix: the first create is accepted, the run
// fails at the first retrieval with the bare body, and the adapter creates a
// second run instead of persisting the failure. The second run answers, and
// the failed first try is accounted as one unpriced attempt whose spend is
// determinate (the provider reported no usage on a terminal outcome), so no
// budget gate is armed against a session that recovered.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async (_payload, createIndex) => ({ id: `resp_bare_${createIndex}`, status: "queued" }),
      async (requestPath) =>
        requestPath.endsWith("/resp_bare_1")
          ? bareFailedResponse("resp_bare_1")
          : completedResponse("resp_bare_2", adapter.model, READY),
    ),
  );
  const ctx = context();
  const result = await adapter.call("fixture", ctx);
  assert.equal(result.text, READY, "the second run's answer is the answer");
  assert.equal(calls.payloads.length, 2, "exactly one re-creation after the bare failure");
  assert.deepEqual(calls.getPaths, ["/agent/resp_bare_1", "/agent/resp_bare_2"]);
  assert.deepEqual(calls.postPaths, [], "a terminal run is never asked to cancel");
  assert.equal(result.attempts, 2, "the answer came from attempt 2");
  assert.equal(result.unpriced_attempts, 1, "the failed first try is one unpriced attempt");
  assert.equal(
    result.indeterminate_spend_attempts,
    0,
    "a terminal failure with no usage is determinate zero spend, not an indeterminate hold",
  );
  assert.equal(
    ctx.events.filter((event) => event.type === "peer.call.started").length,
    2,
    "the re-creation is visible as the second `peer.call.started`",
  );
  console.log("[v9.2.0-perplexity-bare-failure] bare_failure_is_recreated_once: PASS");
}

// (2) Once means once. Two bare failures in a row persist exactly as one did
// before this change: `retryable: false`, the provider's body preserved, two
// attempts on the record, and no third create.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async (_payload, createIndex) => ({ id: `resp_twice_${createIndex}`, status: "queued" }),
      async (requestPath) => bareFailedResponse(requestPath.slice("/agent/".length)),
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = peerFailureOf(error);
      assert.equal(failure.failure_class, "provider_error");
      assert.equal(failure.retryable, false, "the second bare failure keeps today's verdict");
      assert.equal(failure.attempts, 2);
      assert.equal(failure.message, "invalid request");
      assert.equal(failure.provider_error_detail?.code, "invalid_request");
      assert.equal(failure.provider_error_detail?.type, "invalid_request");
      assert.equal(failure.provider_error_detail?.http_status, undefined);
      return true;
    },
  );
  assert.equal(calls.payloads.length, 2, "never a third create");
  assert.deepEqual(calls.postPaths, [], "terminal runs are never asked to cancel");
  console.log("[v9.2.0-perplexity-bare-failure] second_bare_failure_persists: PASS");
}

// (3) A descriptive failure is not the signature. A `failed` terminal that
// names a parameter — the provider rejecting something about our request — is
// persisted on the first attempt, with one create, exactly as before.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_descriptive", status: "queued" }),
      async () => ({
        id: "resp_descriptive",
        status: "failed",
        error: {
          code: "invalid_value",
          message: "Invalid value for 'reasoning.effort'",
          type: "invalid_request_error",
          param: "reasoning.effort",
        },
        usage: null,
      }),
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = peerFailureOf(error);
      assert.equal(failure.retryable, false);
      assert.equal(failure.attempts, 1, "a descriptive failure is never re-created");
      assert.equal(failure.provider_error_detail?.param, "reasoning.effort");
      return true;
    },
  );
  assert.equal(calls.payloads.length, 1);
  console.log("[v9.2.0-perplexity-bare-failure] descriptive_failure_is_not_recreated: PASS");
}

// (4) Usage is billing. A bare message on a terminal that DID report usage is
// a run the provider worked on and charged for; re-creating it would double the
// spend, so it is persisted on the first attempt.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_billed", status: "queued" }),
      async () => ({
        ...bareFailedResponse("resp_billed"),
        usage: { input_tokens: 25_000, output_tokens: 0, total_tokens: 25_000 },
      }),
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = peerFailureOf(error);
      assert.equal(failure.attempts, 1, "a billed failure is never re-created");
      assert.equal(failure.billing_status, "reported", "and its usage stays on the record");
      return true;
    },
  );
  assert.equal(calls.payloads.length, 1);
  console.log("[v9.2.0-perplexity-bare-failure] billed_failure_is_not_recreated: PASS");
}

// (5) The window is part of the signature. The end-to-end cases cannot wait a
// minute, so the exported predicate is exercised at its boundary directly: the
// same terminal object qualifies inside the window and not beyond it, and a
// pending status never qualifies whatever it carries.
{
  const bare = bareFailedResponse("resp_window");
  assert.equal(isPerplexityBareAsyncFailure(bare, undefined, 0), true);
  assert.equal(
    isPerplexityBareAsyncFailure(bare, undefined, PERPLEXITY_BARE_FAILURE_RECREATE_WINDOW_MS),
    true,
    "the boundary itself is inside the window",
  );
  assert.equal(
    isPerplexityBareAsyncFailure(bare, undefined, PERPLEXITY_BARE_FAILURE_RECREATE_WINDOW_MS + 1),
    false,
    "one millisecond past the window is outside it",
  );
  assert.equal(isPerplexityBareAsyncFailure(bare, undefined, -1), false);
  assert.equal(isPerplexityBareAsyncFailure(bare, undefined, Number.NaN), false);
  assert.equal(
    isPerplexityBareAsyncFailure({ ...bare, status: "in_progress" }, undefined, 0),
    false,
    "a pending object is never a failure, whatever it carries",
  );
  // The 14/09/2026 shape — the bare message alone, without `type` or `code` —
  // is the same signature.
  assert.equal(
    isPerplexityBareAsyncFailure(
      { status: "failed", error: { message: "invalid request" } },
      undefined,
      2_500,
    ),
    true,
  );
  assert.equal(
    isPerplexityBareAsyncFailure(
      { status: "failed", error: { message: "invalid request", status: 400 } },
      undefined,
      0,
    ),
    false,
    "a numeric status on the error is a creation-style rejection, not the bare job failure",
  );
  console.log("[v9.2.0-perplexity-bare-failure] window_and_shape_boundaries: PASS");
}

// (6) The streaming path reaches the same terminal: the provider severs the
// stream, the retrieval finds the bare failure, and the re-creation streams
// again and answers.
{
  const adapter = new PerplexityAdapter({
    ...config,
    streaming: { ...config.streaming, tokens: true, include_text: false },
  });
  const calls = recorder();
  async function* severed(id: string): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id, status: "queued" } };
    throw new Error("terminated");
  }
  async function* completed(id: string): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id, status: "in_progress" } };
    yield { type: "response.output_text.delta", delta: READY };
    yield {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        model: adapter.model,
        output: [{ type: "message", content: [{ type: "output_text", text: READY }] }],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    };
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async (_payload, createIndex) =>
        createIndex === 1 ? severed("resp_stream_1") : completed("resp_stream_2"),
      async () => bareFailedResponse("resp_stream_1"),
    ),
  );
  const ctx = context({ stream: true });
  const result = await adapter.call("fixture", ctx);
  assert.equal(result.text, READY);
  assert.equal(calls.payloads.length, 2, "the severed-then-failed run is re-created once");
  assert.deepEqual(calls.getPaths, ["/agent/resp_stream_1"]);
  assert.deepEqual(calls.postPaths, [], "a terminal run is never asked to cancel");
  assert.ok(
    ctx.events.some((event) => event.type === "peer.token.discarded"),
    "the severed stream's provisional deltas are discarded before the re-creation",
  );
  console.log("[v9.2.0-perplexity-bare-failure] streaming_path_is_recreated_once: PASS");
}

// (7) The relator path (`generate`) shares the contract: one re-creation, then
// the revised draft from the second run.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async (_payload, createIndex) => ({ id: `resp_gen_${createIndex}`, status: "queued" }),
      async (requestPath) =>
        requestPath.endsWith("/resp_gen_1")
          ? bareFailedResponse("resp_gen_1")
          : completedResponse("resp_gen_2", adapter.model, "# Revised draft"),
    ),
  );
  const generation = await adapter.generate("fixture", context());
  assert.equal(generation.text, "# Revised draft");
  assert.equal(calls.payloads.length, 2);
  assert.equal(generation.attempts, 2);
  assert.equal(generation.unpriced_attempts, 1);
  assert.equal(generation.indeterminate_spend_attempts, 0);
  console.log("[v9.2.0-perplexity-bare-failure] relator_path_is_recreated_once: PASS");
}

console.log("[v9.2.0-perplexity-bare-failure] ALL CASES PASS");
