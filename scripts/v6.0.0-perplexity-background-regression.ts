// v6.0.0 — Perplexity Agent API background mode (issue #296).
//
// The provider severs a synchronous Agent API request at ~300 s
// (300618/300596/300596/300576 ms observed across three sessions, message
// "terminated") while our own retry timeout is 1 800 000 ms, so the cut is
// the provider's and a Perplexity peer could never vote on a long review.
// Perplexity documents background mode as the path for long runs: create
// with `background: true`, then poll `GET /v1/agent/{id}` until a terminal
// status; the run survives client disconnection
// (https://docs.perplexity.ai/docs/agent-api/background-mode), and the
// output-control page says to prefer it over streaming for multi-minute
// runs.
//
// These cases prove the adapter speaks that protocol without any network:
// the SDK surface it calls (`responses.create` and the raw `get`) is
// stubbed the same way scripts/provider-terminal-smoke.ts stubs it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { isSkippableFailure } from "../src/core/convergence.js";
import type { AppConfig, PeerCallContext, PeerFailure, RuntimeEvent } from "../src/core/types.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-perplexity-background-"),
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
const config: AppConfig = {
  ...baseConfig,
  retry: { ...baseConfig.retry, max_attempts: 1 },
  streaming: { ...baseConfig.streaming, tokens: true, include_text: false },
};

function withTimeout(ms: number): AppConfig {
  return { ...config, retry: { ...config.retry, timeout_ms: ms } };
}

function setClient(adapter: object, client: unknown): void {
  Object.defineProperty(adapter, "client", {
    configurable: true,
    value: async () => client,
  });
}

function context(options: { stream?: boolean; signal?: AbortSignal } = {}): PeerCallContext & {
  events: RuntimeEvent[];
} {
  const events: RuntimeEvent[] = [];
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440296",
    round: 1,
    task: "perplexity background mode regression",
    stream_tokens: options.stream === true,
    ...(options.signal ? { signal: options.signal } : {}),
    emit: (event) => events.push(event),
    events,
  };
}

type StubPayload = Record<string, unknown>;

type RequestOptions = Record<string, unknown> | undefined;

type Recorder = {
  payloads: StubPayload[];
  getPaths: string[];
  // The per-request options of each retrieval. `timeout` and `maxRetries` are
  // part of the contract the poll loop's deadline depends on, so they are
  // recorded rather than discarded (case 12).
  getOptions: RequestOptions[];
  // The per-request options of each create. Both create sites pin
  // `maxRetries: 0` so an accepted-but-lost POST cannot start a second stored,
  // billable background run whose id is never observed (case 14).
  createOptions: RequestOptions[];
  postPaths: string[];
};

function recordingClient(
  recorder: Recorder,
  create: (payload: StubPayload) => Promise<unknown>,
  get: (path: string, options: RequestOptions) => Promise<unknown>,
): unknown {
  return {
    responses: {
      create: async (payload: StubPayload, options: RequestOptions) => {
        recorder.payloads.push(payload);
        recorder.createOptions.push(options);
        return create(payload);
      },
    },
    get: async (requestPath: string, options: RequestOptions) => {
      recorder.getPaths.push(requestPath);
      recorder.getOptions.push(options);
      return get(requestPath, options);
    },
    // The documented cancel answers a minimal acknowledgement, not a full
    // agent response: `{ response_id, status: "cancelling" }`
    // (https://docs.perplexity.ai/api-reference/agent-cancel-post).
    post: async (requestPath: string) => {
      recorder.postPaths.push(requestPath);
      return { response_id: "resp_fixture", status: "cancelling" };
    },
  };
}

function recorder(): Recorder {
  return { payloads: [], getPaths: [], getOptions: [], createOptions: [], postPaths: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status: number, message: string): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function completedResponse(model: string, text: string): Record<string, unknown> {
  return {
    id: "resp_background_fixture",
    status: "completed",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  };
}

// (1) The long calls declare background mode on the wire. `store: false`
// cannot survive there: a non-stored response is not retrievable
// (https://docs.perplexity.ai/docs/agent-api/conversation-state), so the
// reviewer and relator payloads must ask the provider to retain the
// response while the probe keeps `store: false`.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => completedResponse(adapter.model, READY),
      async () => {
        throw new Error("the terminal create must not be polled");
      },
    ),
  );
  const reviewed = await adapter.call("fixture", context());
  assert.equal(reviewed.text, READY);
  const reviewPayload = calls.payloads[0];
  assert.equal(
    reviewPayload?.background,
    true,
    "the reviewer request must be created in background mode (issue #296)",
  );
  assert.equal(
    reviewPayload?.store,
    true,
    "background retrieval requires a retrievable response: store must be true on the reviewer path",
  );
  const generated = await adapter.generate("fixture", context());
  assert.equal(generated.text, READY);
  const generationPayload = calls.payloads[1];
  assert.equal(
    generationPayload?.background,
    true,
    "the relator request must be created in background mode (issue #296)",
  );
  assert.equal(
    generationPayload?.store,
    true,
    "background retrieval requires a retrievable response: store must be true on the relator path",
  );
  assert.deepEqual(
    calls.getPaths,
    [],
    "a create that already returns a terminal status must not be polled",
  );
  assert.deepEqual(
    calls.postPaths,
    [],
    "a run that reached a terminal status must not be cancelled",
  );
  console.log("[v6.0.0-perplexity-background] payload_declares_background: PASS");
}

// (2) A pending create is polled on the documented retrieval endpoint
// `GET /v1/agent/{id}` until a terminal status, and the terminal object is
// what the adapter answers with.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  const polled = [
    { id: "resp_bg_poll", status: "in_progress" },
    completedResponse(adapter.model, READY),
  ];
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_bg_poll", status: "queued" }),
      async () => polled.shift(),
    ),
  );
  const result = await adapter.call("fixture", context());
  assert.equal(result.text, READY, "the terminal polled object is the answer");
  assert.equal(result.usage?.input_tokens, 11);
  assert.equal(result.usage?.output_tokens, 7);
  assert.deepEqual(
    calls.getPaths,
    ["/agent/resp_bg_poll", "/agent/resp_bg_poll"],
    "polling must use the documented Agent API retrieval path GET /v1/agent/{id}",
  );
  console.log("[v6.0.0-perplexity-background] polls_until_terminal: PASS");
}

// (3) A non-terminal status is never an answer, even when the pending
// object already carries assistant text: `queued` and `in_progress` are the
// documented non-terminal statuses, so text found on them must be ignored
// until the run reaches a terminal status.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  const pendingWithText = {
    id: "resp_bg_pending_text",
    status: "in_progress",
    model: "perplexity/kimi-k3",
    output: [{ type: "message", content: [{ type: "output_text", text: "PREMATURE" }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const polled: unknown[] = [pendingWithText, completedResponse("perplexity/kimi-k3", READY)];
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ ...pendingWithText, status: "queued" }),
      async () => polled.shift(),
    ),
  );
  const result = await adapter.generate("fixture", context());
  assert.equal(result.text, READY, "a non-terminal poll must never be promoted to an answer");
  assert.equal(calls.getPaths.length, 2);
  console.log("[v6.0.0-perplexity-background] non_terminal_is_never_an_answer: PASS");
}

// (4) Cancellation through `context.signal` stops the polling loop: no
// retrieval request is issued after the abort and the failure is classified
// as cancelled, not as a provider error.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  const controller = new AbortController();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => {
        setTimeout(() => controller.abort(), 10);
        return { id: "resp_bg_cancel", status: "queued" };
      },
      async () => ({ id: "resp_bg_cancel", status: "in_progress" }),
    ),
  );
  const started = Date.now();
  await assert.rejects(
    () => adapter.call("fixture", context({ signal: controller.signal })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = (error as Error & { peerFailure?: { failure_class?: string } }).peerFailure;
      assert.equal(failure?.failure_class, "cancelled");
      return true;
    },
  );
  assert.deepEqual(calls.getPaths, [], "cancellation must stop the poll before the next retrieval");
  assert.deepEqual(
    calls.postPaths,
    ["/agent/resp_bg_cancel/cancel"],
    "an abandoned background run keeps executing and billing: it must be asked to stop",
  );
  assert.ok(
    Date.now() - started < 900,
    "cancellation must interrupt the poll interval instead of waiting it out",
  );
  console.log("[v6.0.0-perplexity-background] cancellation_stops_polling: PASS");
}

// (5) The overall deadline is `config.retry.timeout_ms`; the poll loop must
// stop there instead of waiting on a run the provider never finishes.
{
  const adapter = new PerplexityAdapter(withTimeout(300));
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_bg_deadline", status: "queued" }),
      async () => ({ id: "resp_bg_deadline", status: "in_progress" }),
    ),
  );
  const started = Date.now();
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /perplexity_background_poll_timeout/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250, `the deadline must not fire early (elapsed ${elapsed} ms)`);
  assert.ok(elapsed < 1500, `the deadline must bound the poll loop (elapsed ${elapsed} ms)`);
  assert.deepEqual(
    calls.postPaths,
    ["/agent/resp_bg_deadline/cancel"],
    "a run the deadline abandons must be asked to stop, not left running and billing",
  );
  console.log("[v6.0.0-perplexity-background] overall_deadline_honoured: PASS");
}

// (6) The reproduction of issue #296: the provider severs the streaming
// connection mid-run ("terminated"). Because the run was created in
// background mode it survives the disconnection, so the adapter retrieves
// the terminal object instead of failing the attempt, and the provisional
// token output of the severed stream is discarded rather than presented as
// the answer.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  async function* severed(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_severed", status: "queued" } };
    yield { type: "response.output_text.delta", delta: "partial answer" };
    throw new Error("terminated");
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => severed(),
      async () => ({ ...completedResponse(adapter.model, READY), id: "resp_bg_severed" }),
    ),
  );
  const ctx = context({ stream: true });
  const result = await adapter.call("fixture", ctx);
  assert.equal(result.text, READY, "the retrieved terminal object is the answer after a severance");
  assert.deepEqual(calls.getPaths, ["/agent/resp_bg_severed"]);
  const raw = result.raw as Record<string, unknown>;
  assert.equal(raw.stream_severed, true);
  assert.equal(raw.background_polls, 1);
  assert.deepEqual(
    calls.postPaths,
    [],
    "a run retrieved to a terminal status must not be cancelled",
  );
  assert.ok(
    ctx.events.some((event) => event.type === "peer.token.discarded"),
    "the provisional deltas of a severed stream must be discarded, never committed",
  );
  console.log("[v6.0.0-perplexity-background] severed_stream_resumes_by_retrieval: PASS");
}

// (7) The deadline is anchored before the create, not at the severance:
// a stream that burns most of `retry.timeout_ms` before being severed must
// not hand the poll loop a fresh full budget.
{
  const adapter = new PerplexityAdapter(withTimeout(1000));
  const calls = recorder();
  async function* slowSevered(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_slow", status: "queued" } };
    await new Promise((resolve) => setTimeout(resolve, 800));
    throw new Error("terminated");
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => slowSevered(),
      async () => ({ id: "resp_bg_slow", status: "in_progress" }),
    ),
  );
  const started = Date.now();
  await assert.rejects(
    () => adapter.generate("fixture", context({ stream: true })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /perplexity_background_poll_timeout/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1400,
    `the poll deadline must be anchored at the create, not at the severance (elapsed ${elapsed} ms)`,
  );
  console.log("[v6.0.0-perplexity-background] deadline_anchored_at_create: PASS");
}

// (8) The probe is a short call and does not have the problem: it stays
// synchronous, keeps `store: false` (nothing ever retrieves it) and is
// never polled.
{
  const adapter = new PerplexityAdapter({
    ...config,
    perplexity: { ...config.perplexity, probe_mode: "live" },
  });
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ status: "completed", model: adapter.model, output: [] }),
      async () => {
        throw new Error("the probe must never be polled");
      },
    ),
  );
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  const probePayload = calls.payloads[0];
  assert.equal(probePayload?.store, false, "the probe never needs retrieval: store stays false");
  assert.ok(
    !("background" in (probePayload ?? {})),
    "the probe is a short synchronous call and must not declare background mode",
  );
  assert.deepEqual(calls.getPaths, []);
  console.log("[v6.0.0-perplexity-background] probe_path_unchanged: PASS");
}

// (9) A background run outlives transport trouble, so a failed retrieval must
// not abandon it while the deadline still has budget. Reviewer evidence P7b:
// against a server returning 500 on the first retrievals, the attempt died
// after 3 HTTP GETs and 2.5 s with 17.5 s of a 20 s budget unused, even though
// the run reached `completed` on a later retrieval — and, because that failure
// is classified retryable, `withRetry` then started further full background
// runs that kept executing and billing. This is the inverse: the loop tolerates
// the transient retrievals and answers with the terminal object.
{
  const adapter = new PerplexityAdapter(withTimeout(30_000));
  const calls = recorder();
  let retrievals = 0;
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_bg_flaky", status: "queued" }),
      async () => {
        retrievals += 1;
        if (retrievals <= 2) throw httpError(500, "upstream hiccup");
        return { ...completedResponse(adapter.model, READY), id: "resp_bg_flaky" };
      },
    ),
  );
  const result = await adapter.call("fixture", context());
  assert.equal(result.text, READY, "a transient retrieval failure must not discard a live run");
  assert.deepEqual(
    calls.getPaths,
    ["/agent/resp_bg_flaky", "/agent/resp_bg_flaky", "/agent/resp_bg_flaky"],
    "the poll must keep retrieving past a transient failure instead of aborting on the first one",
  );
  assert.equal((result.raw as Record<string, unknown>).background_retrieve_errors, 2);
  assert.deepEqual(
    calls.postPaths,
    [],
    "a run that was retrieved to a terminal status must not be cancelled",
  );
  console.log("[v6.0.0-perplexity-background] transient_retrieval_failures_tolerated: PASS");
}

// (10) Tolerance is not blindness. A non-transient retrieval status — 404 is
// the documented answer for an unknown id or another account's response — will
// never change, so it ends the poll at once instead of burning the deadline,
// and the run it abandons is still asked to stop.
{
  const adapter = new PerplexityAdapter(withTimeout(30_000));
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_bg_404", status: "queued" }),
      async () => {
        throw httpError(404, "response not found");
      },
    ),
  );
  const started = Date.now();
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /response not found/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(calls.getPaths.length, 1, "a non-transient retrieval status must not be retried");
  assert.ok(
    elapsed < 3000,
    `a non-transient status must not wait out the deadline (${elapsed} ms)`,
  );
  assert.deepEqual(calls.postPaths, ["/agent/resp_bg_404/cancel"]);
  console.log("[v6.0.0-perplexity-background] non_transient_retrieval_escapes: PASS");
}

// (11) The same abandonment happens when the caller cancels while the streamed
// connection is still alive: the run was created with `background: true`, so it
// survives the disconnection this adapter is about to perform. It must be asked
// to stop there too, or the operator's `session_cancel_job` leaves a run
// executing and billing with the reviewer's web_search tool active.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  const controller = new AbortController();
  async function* cancelledMidStream(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_stream_abort", status: "queued" } };
    controller.abort();
    throw new Error("Request was aborted");
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => cancelledMidStream(),
      async () => {
        throw new Error("a cancelled stream must not be polled");
      },
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context({ stream: true, signal: controller.signal })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = (error as Error & { peerFailure?: { failure_class?: string } }).peerFailure;
      assert.equal(failure?.failure_class, "cancelled");
      return true;
    },
  );
  assert.deepEqual(
    calls.postPaths,
    ["/agent/resp_bg_stream_abort/cancel"],
    "a cancellation during the stream must also stop the surviving background run",
  );
  console.log("[v6.0.0-perplexity-background] stream_cancellation_stops_the_run: PASS");
}

// (12) The deadline is a bound only if a single retrieval cannot outlive it.
// In this SDK `timeout` bounds ONE attempt and `maxRetries` defaults to 2, so
// a hung retrieval issued with the whole remaining budget as its timeout would
// cost three times that budget before the loop could look at its own deadline
// again — measured end to end at 17.4 s against a 6000 ms budget (2.9x) with
// three HTTP GETs for what the loop counted as one retrieval. The retrieval
// therefore pins `maxRetries: 0`, exactly like the cancel POST. Every other
// case's `get` stub ignores the options object and answers instantly, so this
// is the only one that models the SDK contract and the only one that can see
// this class of defect at all.
{
  const budgetMs = 3_000;
  const adapter = new PerplexityAdapter(withTimeout(budgetMs));
  const calls = recorder();
  let httpAttempts = 0;
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => ({ id: "resp_bg_hung", status: "queued" }),
      async (_requestPath, options) => {
        // openai-node's contract: (maxRetries ?? 2) + 1 attempts, each one
        // bounded by `timeout`, before the error reaches the caller.
        const maxRetries = typeof options?.maxRetries === "number" ? options.maxRetries : 2;
        const perAttempt = typeof options?.timeout === "number" ? options.timeout : budgetMs;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          httpAttempts += 1;
          await sleep(perAttempt);
        }
        throw new Error("Request timed out.");
      },
    ),
  );
  const started = Date.now();
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /perplexity_background_poll_timeout/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(
    calls.getOptions[0]?.maxRetries,
    0,
    "the retrieval must pin maxRetries to zero: the poll loop is the retry, not the SDK",
  );
  assert.equal(
    httpAttempts,
    1,
    `one retrieval must cost one HTTP attempt (issued ${httpAttempts})`,
  );
  assert.ok(elapsed >= budgetMs * 0.8, `the deadline must not fire early (elapsed ${elapsed} ms)`);
  assert.ok(
    elapsed < budgetMs * 1.5,
    `a hung retrieval must not outlive the deadline (elapsed ${elapsed} ms of ${budgetMs} ms)`,
  );
  assert.deepEqual(
    calls.postPaths,
    ["/agent/resp_bg_hung/cancel"],
    "a run the deadline abandons must be asked to stop, even when the retrieval hung",
  );
  console.log("[v6.0.0-perplexity-background] hung_retrieval_cannot_outlive_the_deadline: PASS");
}

// (13) A failure of OUR OWN event pipeline is not a terminal answer. The
// adapter used to mark every throw raised inside the loop body as a terminal
// rejection, so a local failure — the StreamBuffer ceiling, a token sink, a
// hostile event object — took the "that run is already over" branch and the
// surviving background run was never asked to stop. It kept executing and
// billing with the reviewer's web_search tool active. The run is alive on this
// path, so it earns the same best-effort cancel the poll loop performs at every
// non-terminal exit; and it must NOT be polled, because retrieving the terminal
// object would swallow the local failure and answer with it.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  async function* localFailureMidStream(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_local", status: "queued" } };
    yield {
      type: "response.output_text.delta",
      response: { id: "resp_bg_local", status: "in_progress" },
      get delta(): string {
        throw new Error("local event pipeline failure");
      },
    };
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => localFailureMidStream(),
      async () => {
        throw new Error("a local failure must not be answered by a retrieval");
      },
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context({ stream: true })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error).message,
        "local event pipeline failure",
        "the local failure must propagate unwrapped, keeping its identity and billing metadata",
      );
      return true;
    },
  );
  assert.deepEqual(
    calls.postPaths,
    ["/agent/resp_bg_local/cancel"],
    "a local pipeline failure abandons a live background run, so it must be asked to stop",
  );
  assert.deepEqual(calls.getPaths, [], "a local failure must not be resolved by polling");
  console.log("[v6.0.0-perplexity-background] local_failure_stops_the_run: PASS");
}

// (14) Neither create may be retried by the SDK. `timeout` bounds a SINGLE
// attempt, so the SDK default of two retries lets a create eat three times
// CROSS_REVIEW_TIMEOUT_MS before the poll loop looks at its own deadline; and
// the SDK sends no `Idempotency-Key`, so a POST the provider accepted but whose
// response was lost is repeated, starting a SECOND stored, billable background
// run whose id this adapter never sees and `cancelBackgroundRun` can never
// reach. The retry authority is `withRetry`, not the SDK.
{
  const background = new PerplexityAdapter(config);
  const backgroundCalls = recorder();
  setClient(
    background,
    recordingClient(
      backgroundCalls,
      async () => completedResponse(background.model, READY),
      async () => {
        throw new Error("a terminal create must not be polled");
      },
    ),
  );
  await background.call("fixture", context());

  const streamed = new PerplexityAdapter(config);
  const streamedCalls = recorder();
  async function* completedStream(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_pins", status: "queued" } };
    yield { type: "response.output_text.delta", delta: READY };
    yield {
      type: "response.completed",
      response: completedResponse(streamed.model, READY),
    };
  }
  setClient(
    streamed,
    recordingClient(
      streamedCalls,
      async () => completedStream(),
      async () => {
        throw new Error("a completed stream must not be polled");
      },
    ),
  );
  const streamedResult = await streamed.call("fixture", context({ stream: true }));

  for (const [label, calls] of [
    ["background", backgroundCalls],
    ["streaming", streamedCalls],
  ] as const) {
    assert.equal(calls.createOptions.length, 1, `${label}: exactly one create is issued`);
    assert.equal(
      (calls.createOptions[0] as { maxRetries?: unknown } | undefined)?.maxRetries,
      0,
      `${label} create must pin maxRetries: 0 so the SDK cannot orphan a second billable run`,
    );
    assert.equal(
      (calls.createOptions[0] as { timeout?: unknown } | undefined)?.timeout,
      config.retry.timeout_ms,
      `${label} create must carry the configured timeout`,
    );
  }
  // `stream_severed` is an expression, not a constant (case 16): the clean
  // stream that ran above must still report an unbroken one.
  assert.equal(
    (streamedResult.raw as { stream_severed?: unknown }).stream_severed,
    false,
    "an uncut stream must not be recorded as severed",
  );
  console.log("[v6.0.0-perplexity-background] creates_pin_no_sdk_retries: PASS");
}

// (15) `maxRetries: 0` disarms only the SDK. `withRetry` wraps the WHOLE
// closure, creates included, so a create failure the classifier calls
// retryable made the adapter re-POST it — up to max_attempts stored, billable
// background runs, of which at most one id is ever observed. The Agent API
// publishes six endpoints, none of which lists runs, and no idempotency
// header, so the extra runs can never be found or stopped: they bill to
// completion with the reviewer's web_search tool active.
//
// The stop cannot be spelled `retryable: false`. Two other readers depend on
// that field meaning "would the provider succeed if asked again":
// `isSkippableFailure` uses it to leave a provider error `skipped` rather than
// `rejected` — flipping it would silently BLOCK convergence — and the
// orchestrator reads the same field for fallback eligibility. So the
// classification is asserted unchanged here, and only the retry loop is
// stopped, through `safe_to_repeat`.
{
  const retrying: AppConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 },
  };
  const adapter = new PerplexityAdapter(retrying);
  const calls = recorder();
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => {
        throw httpError(502, "Bad gateway");
      },
      async () => {
        throw new Error("a failed create must not be polled");
      },
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.ok(failure, "the failure must reach the orchestrator classified");
      assert.equal(
        failure.retryable,
        true,
        "the provider classification is untouched: a 502 is still a retryable provider error",
      );
      assert.equal(
        isSkippableFailure(failure),
        true,
        "convergence must still be reachable — a create that cannot repeat is not a rejection",
      );
      assert.equal(
        failure.safe_to_repeat,
        false,
        "only the retry loop learns the attempt has an un-repeatable side effect",
      );
      return true;
    },
  );
  assert.equal(
    calls.createOptions.length,
    1,
    "an ambiguous create failure must not be re-POSTed: the first run may already exist and is unreachable",
  );

  // The narrow half of the same contract: a 4xx is the provider REJECTING the
  // request before storing anything, so the ordinary rate-limit retry must
  // survive intact. Widening the mark to every create failure would trade one
  // hazard for a worse one.
  const rateLimited = new PerplexityAdapter(retrying);
  const rateLimitedCalls = recorder();
  setClient(
    rateLimited,
    recordingClient(
      rateLimitedCalls,
      async () => {
        throw httpError(429, "Too many requests");
      },
      async () => {
        throw new Error("a failed create must not be polled");
      },
    ),
  );
  await assert.rejects(
    () => rateLimited.call("fixture", context()),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.ok(failure);
      assert.equal(
        failure.safe_to_repeat,
        undefined,
        "a rejected request stored nothing, so it carries no repeat hazard",
      );
      return true;
    },
  );
  assert.equal(
    rateLimitedCalls.createOptions.length,
    retrying.retry.max_attempts,
    "a rate-limited create must still be retried the configured number of times",
  );
  console.log("[v6.0.0-perplexity-background] outer_retry_does_not_duplicate_creates: PASS");
}

// (16) A transport cut that lands AFTER `response.completed` severs a
// connection whose answer is already complete in hand. openai 7.8.0 rejects
// the iterator when the socket dies before `data: [DONE]` (a live server
// closing there raises `TypeError: terminated`), and that rejection used to be
// rethrown unconditionally — failing the round on a finished, billed answer.
// The retrieval that repairs an ordinary severed stream cannot help: it is
// guarded by `!responseCompleted`, so on this path nothing recovers the run.
// Nor may the run be cancelled: it is already terminal, and the documented
// cancel answers 400 against a terminal run.
{
  const adapter = new PerplexityAdapter(config);
  const calls = recorder();
  async function* completedThenSevered(): AsyncGenerator<Record<string, unknown>> {
    yield { type: "response.created", response: { id: "resp_bg_done", status: "queued" } };
    yield { type: "response.output_text.delta", delta: READY };
    yield { type: "response.completed", response: completedResponse(adapter.model, READY) };
    // No `data: [DONE]`: the socket dies with the answer already delivered.
    throw new Error("terminated");
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => completedThenSevered(),
      async () => {
        throw new Error("a completed stream must not be polled");
      },
    ),
  );
  const result = await adapter.call("fixture", context({ stream: true }));
  assert.equal(
    JSON.parse(result.text).status,
    "READY",
    "the answer that already arrived must be the answer returned",
  );
  assert.equal(
    (result.raw as { stream_severed?: unknown }).stream_severed,
    true,
    "the record must still report the cut rather than claim an unbroken stream",
  );
  assert.deepEqual(calls.getPaths, [], "a completed run has nothing left to retrieve");
  assert.deepEqual(calls.postPaths, [], "a terminal run must not be cancelled: that answers 400");
  console.log("[v6.0.0-perplexity-background] completed_then_severed_keeps_the_answer: PASS");
}

// (17) The create can succeed and STILL leave an unreachable run. If the
// stream fails before the first `response.created`, `requestId` is never
// learned: the retrieval above is guarded by it, `cancelBackgroundRun` has no
// path to call, and the run the provider already stored keeps executing and
// billing with nobody able to stop it. `createAgentRun` cannot see this — it
// returned successfully — so the mark is applied where the error escapes
// instead. A repeat would add a SECOND unreachable run to the first.
{
  const retrying: AppConfig = {
    ...config,
    retry: { ...config.retry, max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 },
  };
  const adapter = new PerplexityAdapter(retrying);
  const calls = recorder();
  async function* failsBeforeCreatedEvent(): AsyncGenerator<Record<string, unknown>> {
    // A retryable provider error reaching us before any event carries an id.
    // The create has always been recorded by the time the stream is consumed,
    // so the throw always fires; the yield below is never reached.
    if (calls.createOptions.length > 0) throw httpError(503, "Service unavailable");
    yield { type: "response.created", response: { id: "never", status: "queued" } };
  }
  setClient(
    adapter,
    recordingClient(
      calls,
      async () => failsBeforeCreatedEvent(),
      async () => {
        throw new Error("a run with no id cannot be retrieved");
      },
    ),
  );
  await assert.rejects(
    () => adapter.call("fixture", context({ stream: true })),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.ok(failure);
      assert.equal(
        failure.retryable,
        true,
        "the provider classification is untouched: a 503 is still a retryable provider error",
      );
      assert.equal(isSkippableFailure(failure), true, "convergence must still be reachable");
      assert.equal(
        failure.safe_to_repeat,
        false,
        "a run whose id was never learned makes the attempt un-repeatable",
      );
      return true;
    },
  );
  assert.equal(
    calls.createOptions.length,
    1,
    "a stream that failed before the id must not be re-created: the first run is already unreachable",
  );
  assert.deepEqual(calls.postPaths, [], "there is no id to cancel");
  assert.deepEqual(calls.getPaths, [], "there is no id to retrieve");
  console.log("[v6.0.0-perplexity-background] pre_id_stream_failure_is_unrepeatable: PASS");
}

console.log("[v6.0.0-perplexity-background] ALL CASES PASS");
