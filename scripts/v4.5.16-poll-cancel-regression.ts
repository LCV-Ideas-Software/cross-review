import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/core/config.js";
import { SessionStore } from "../src/core/session-store.js";
import { MCP_REQUEST_TIMEOUT_MS } from "../src/core/timeouts.js";
import {
  compactJobsForPoll,
  sessionPollPayload,
  synthesizeDurableJob,
  textResult,
} from "../src/mcp/server.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type StartedRound = { session_id: string; job: { job_id: string } };
type PollJob = { job_id?: string; status?: string };
type PollPayload = {
  outcome?: string | null;
  active_round_number?: number | null;
  latest_completed_round_number?: number | null;
  in_flight?: Record<string, unknown> | null;
  latest_round?: {
    peers?: Array<Record<string, unknown>>;
  } | null;
  jobs?: PollJob[];
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v4516-poll-cancel-"));
const configPath = path.join(dataDir, "config.json");
const operatorToken = "07".repeat(32);
const failures: string[] = [];
let serverStderr = "";

fs.writeFileSync(configPath, JSON.stringify({ version: "v4.5.16-regression" }), "utf8");
fs.writeFileSync(
  path.join(dataDir, "host-tokens.json"),
  JSON.stringify({
    version: 2,
    generated_at: "2026-07-13T00:00:00.000Z",
    tokens: {
      codex: "01".repeat(32),
      claude: "02".repeat(32),
      gemini: "03".repeat(32),
      deepseek: "04".repeat(32),
      grok: "05".repeat(32),
      perplexity: "06".repeat(32),
      operator: operatorToken,
    },
  }),
  "utf8",
);

const rateEnvironment = Object.fromEntries(
  ["OPENAI", "ANTHROPIC", "GEMINI", "DEEPSEEK", "GROK", "PERPLEXITY"].flatMap((provider) => [
    [`CROSS_REVIEW_${provider}_INPUT_USD_PER_MILLION`, "1"],
    [`CROSS_REVIEW_${provider}_OUTPUT_USD_PER_MILLION`, "1"],
  ]),
);

const serverEnvironment = {
  ...process.env,
  ...rateEnvironment,
  CROSS_REVIEW_DATA_DIR: dataDir,
  CROSS_REVIEW_CONFIG_FILE: configPath,
  CROSS_REVIEW_CALLER_TOKEN: operatorToken,
  CROSS_REVIEW_REQUIRE_TOKEN: "true",
  CROSS_REVIEW_STUB: "1",
  CROSS_REVIEW_STUB_CONFIRMED: "1",
  CROSS_REVIEW_MAX_SESSION_COST_USD: "10000",
  CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD: "10000",
  CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD: "10000",
  CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH: "1",
  CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_LOW_USD_PER_1000_REQUESTS: "0",
  CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS: "0",
  CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS: "0",
};

function createTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp/server.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: serverEnvironment,
  });
}

const transport = createTransport();
const client = new Client({ name: "cross-review-poll-cancel-regression", version: "4.5.16" });
transport.stderr?.on("data", (chunk) => {
  serverStderr += String(chunk);
});

function check(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  return callTextWith(client, name, args);
}

async function callTextWith(
  targetClient: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = (await targetClient.callTool({ name, arguments: args }, undefined, {
    timeout: MCP_REQUEST_TIMEOUT_MS,
    maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS,
  })) as ToolResult;
  const text = result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  if (result.isError) throw new Error(text);
  return text;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

async function callJsonWith<T>(
  targetClient: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callTextWith(targetClient, name, args)) as T;
}

try {
  const genericMarkdown = textResult(
    { status: "completed", nested: { count: 1 }, peers: ["claude", "gemini"] },
    "markdown",
  ).content[0]?.text;
  check(
    !genericMarkdown?.trimStart().startsWith("{") && genericMarkdown?.includes("**status:**"),
    "object responses advertised as markdown still used JSON serialization",
  );
  const hostileMarkdown = textResult(
    { message: "first line\n<script>alert('unsafe')</script> & raw" },
    "markdown",
  ).content[0]?.text;
  check(
    !hostileMarkdown?.includes("<script>") &&
      hostileMarkdown?.includes("&lt;script&gt;") &&
      hostileMarkdown.includes("&amp; raw"),
    "multiline markdown output preserved raw HTML instead of escaping it",
  );

  const syntheticSession = {
    session_id: "11111111-1111-4111-8111-111111111111",
    control: {
      status: "running" as const,
      job_id: "22222222-2222-4222-8222-222222222222",
      owner_pid: process.pid,
      updated_at: "2026-07-13T00:00:00.000Z",
    },
  } as Parameters<typeof synthesizeDurableJob>[0];
  const completedLocalJob = {
    job_id: syntheticSession.control?.job_id ?? "",
    kind: "ask_peers" as const,
    session_id: syntheticSession.session_id,
    status: "completed" as const,
    started_at: "2026-07-13T00:00:00.000Z",
    completed_at: "2026-07-13T00:00:01.000Z",
  };
  check(
    synthesizeDurableJob(syntheticSession, [completedLocalJob]) === null,
    "a terminal local job was duplicated as a synthetic running durable job",
  );
  const settlementFailedJob = {
    ...completedLocalJob,
    status: "failed" as const,
    error: "background_job_settlement_failed: injected regression",
  };
  check(
    synthesizeDurableJob(syntheticSession, [settlementFailedJob])?.status === "running",
    "a failed local settlement hid the still-active durable control marker",
  );
  const settlementDurable = synthesizeDurableJob(syntheticSession, [settlementFailedJob]);
  const settlementPollJobs = compactJobsForPoll(
    [settlementFailedJob],
    settlementDurable,
    syntheticSession.control?.job_id,
  );
  check(
    settlementPollJobs.length === 1 &&
      settlementPollJobs[0]?.status === "running" &&
      settlementPollJobs[0]?.error?.includes("background_job_settlement_failed"),
    "poll exposed contradictory failed/running entries for one unsettled job id",
  );

  const raceStore = new SessionStore({
    ...loadConfig(),
    data_dir: path.join(dataDir, "store-race"),
  });
  const raceSession = await raceStore.init("Atomic cancellation regression.", "operator", []);
  const raceJobId = "33333333-3333-4333-8333-333333333333";
  await raceStore.markBackgroundJobRunning(raceSession.session_id, {
    job_id: raceJobId,
    owner_pid: process.pid,
  });
  await raceStore.clearBackgroundJobControl(raceSession.session_id, raceJobId);
  let lateCancellationError = "";
  try {
    await raceStore.requestCancellation(
      raceSession.session_id,
      "must not recreate terminal control",
      raceJobId,
      { require_active_execution: true },
    );
  } catch (error) {
    lateCancellationError = error instanceof Error ? error.message : String(error);
  }
  check(
    /no_active_execution/.test(lateCancellationError),
    "requestCancellation accepted a stale pre-lock snapshot after durable work had finished",
  );
  check(
    raceStore.read(raceSession.session_id).control === undefined,
    "late cancellation recreated an orphan cancel_requested control",
  );

  const ownerRaceSession = await raceStore.init("Concurrent owner regression.", "operator", []);
  const ownerA = "44444444-4444-4444-8444-444444444444";
  const ownerB = "55555555-5555-4555-8555-555555555555";
  await raceStore.markBackgroundJobRunning(ownerRaceSession.session_id, {
    job_id: ownerA,
    owner_pid: process.pid,
  });
  let concurrentOwnerError = "";
  try {
    await raceStore.markBackgroundJobRunning(ownerRaceSession.session_id, {
      job_id: ownerB,
      owner_pid: process.pid,
    });
  } catch (error) {
    concurrentOwnerError = error instanceof Error ? error.message : String(error);
  }
  check(
    /background_job_already_running/.test(concurrentOwnerError) &&
      raceStore.read(ownerRaceSession.session_id).control?.job_id === ownerA,
    "a concurrent background start overwrote the first durable owner",
  );

  const recoveredSession = await raceStore.init(
    "Recovered job history regression.",
    "operator",
    [],
  );
  const recoveredJobId = "66666666-6666-4666-8666-666666666666";
  await raceStore.markBackgroundJobRunning(recoveredSession.session_id, {
    job_id: recoveredJobId,
    owner_pid: 2_147_483_647,
  });
  await raceStore.writeBackgroundJobStatus({
    job_id: recoveredJobId,
    kind: "ask_peers",
    session_id: recoveredSession.session_id,
    status: "running",
    started_at: "2026-07-13T00:00:00.000Z",
  });
  await raceStore.recoverInterruptedSessions(new Set());
  check(
    raceStore.readBackgroundJobStatus(recoveredSession.session_id, recoveredJobId)?.status ===
      "failed",
    "restart recovery left the interrupted job history marked as running",
  );

  const activeSentinel = "ACTIVE_IN_FLIGHT_SENTINEL_".repeat(20_000);
  const activeSession = {
    ...raceStore.read(raceSession.session_id),
    in_flight: {
      round: 2,
      peers: Array.from({ length: 100_000 }, () => "claude"),
      started_at: "2026-07-13T00:00:00.000Z",
      status: "running",
      evidence_broker_snapshot: { activeSentinel },
    },
  } as unknown as Parameters<typeof sessionPollPayload>[0];
  const activeSummary = JSON.stringify(sessionPollPayload(activeSession, [], "summary", []));
  const activeFull = JSON.stringify(sessionPollPayload(activeSession, [], "full", []));
  check(
    !activeSummary.includes(activeSentinel) && activeSummary.length < 20_000,
    `summary poll leaked an active evidence snapshot (${activeSummary.length} bytes)`,
  );
  check(activeFull.includes(activeSentinel), "detail=full omitted the active forensic snapshot");

  const hostileJobs = Array.from({ length: 1_000 }, (_, index) => ({
    job_id: `${index.toString(16).padStart(8, "0")}-7777-4777-8777-${index
      .toString(16)
      .padStart(12, "0")}`,
    kind: "ask_peers" as const,
    session_id: activeSession.session_id,
    status: "running" as const,
    started_at: new Date(index).toISOString(),
    error: activeSentinel,
    result_summary: { outcome: activeSentinel },
  }));
  const hostileJobsSummary = sessionPollPayload(activeSession, hostileJobs, "summary", []);
  const hostileJobsFull = sessionPollPayload(activeSession, hostileJobs, "full", []);
  check(
    hostileJobsSummary.jobs.length <= 2 && JSON.stringify(hostileJobsSummary).length < 20_000,
    "summary poll did not cap hostile background-job cardinality",
  );
  check(
    hostileJobsFull.jobs.length === hostileJobs.length,
    "detail=full did not preserve complete background-job history",
  );

  const hostileMetadataSession = {
    ...raceStore.read(raceSession.session_id),
    outcome: "aborted",
    outcome_reason: activeSentinel,
    convergence_health: {
      state: "aborted",
      last_event_at: "2026-07-13T00:00:00.000Z",
      detail: activeSentinel,
      extra: activeSentinel,
    },
    control: {
      status: "recovered_after_restart",
      reason: activeSentinel,
      updated_at: "2026-07-13T00:00:00.000Z",
      extra: activeSentinel,
    },
    generation_in_flight: {
      peer: "claude",
      provider: activeSentinel,
      model: activeSentinel,
      label: activeSentinel,
      round: 1,
      started_at: "2026-07-13T00:00:00.000Z",
      owner_pid: process.pid,
    },
  } as unknown as Parameters<typeof sessionPollPayload>[0];
  const hostileMetadataSummary = JSON.stringify(
    sessionPollPayload(hostileMetadataSession, [], "summary", []),
  );
  const hostileMetadataFull = JSON.stringify(
    sessionPollPayload(hostileMetadataSession, [], "full", []),
  );
  check(
    !hostileMetadataSummary.includes(activeSentinel) && hostileMetadataSummary.length < 20_000,
    "summary poll leaked unbounded outcome/health/control/generation metadata",
  );
  check(
    hostileMetadataFull.includes(activeSentinel),
    "detail=full did not preserve unabridged operational metadata",
  );

  await client.connect(transport);
  const started = await callJson<StartedRound>("session_start_round", {
    task: "Focused stub regression for poll and settled-job cancellation contracts.",
    draft: "Review this neutral fixture.",
    response_format: "json",
  });

  let finalPoll: PollPayload | undefined;
  let terminalJob: PollJob | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const poll = await callJson<PollPayload>("session_poll", {
      session_id: started.session_id,
      response_format: "json",
    });
    finalPoll = poll;
    terminalJob = poll.jobs?.find((job) => job.job_id === started.job.job_id);
    if (terminalJob && terminalJob.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  check(finalPoll !== undefined, "session_poll never returned a payload");
  check(terminalJob?.status === "completed", "the exact started job did not settle as completed");
  check(finalPoll?.outcome === "converged", "the fixture session did not reach its terminal state");
  check(
    !finalPoll?.latest_round?.peers?.some(
      (peer) => "text" in peer || "raw" in peer || "structured" in peer,
    ),
    "session_poll default payload leaked full peer text/raw/structured data from the prior round",
  );

  const persistedMetaPath = path.join(dataDir, "sessions", started.session_id, "meta.json");
  const persistedMeta = JSON.parse(fs.readFileSync(persistedMetaPath, "utf8")) as {
    rounds: Array<{
      peers: Array<{
        text?: string;
        raw?: unknown;
        structured?: unknown;
        parser_warnings?: string[];
        provider?: string;
        model?: string;
        model_reported?: string;
      }>;
    }>;
  };
  const sentinel = "POLL_FULL_PAYLOAD_SENTINEL_".repeat(2_000);
  const persistedPeer = persistedMeta.rounds.at(-1)?.peers[0];
  if (persistedPeer) {
    persistedPeer.text = sentinel;
    persistedPeer.raw = { sentinel };
    persistedPeer.structured = { status: "READY", summary: sentinel, evidence_sources: [sentinel] };
    persistedPeer.parser_warnings = Array.from({ length: 100 }, () => sentinel);
    persistedPeer.provider = sentinel;
    persistedPeer.model = sentinel;
    persistedPeer.model_reported = sentinel;
    fs.writeFileSync(persistedMetaPath, JSON.stringify(persistedMeta), "utf8");
  }
  const boundedPollText = await callText("session_poll", {
    session_id: started.session_id,
    response_format: "json",
  });
  check(
    !boundedPollText.includes(sentinel),
    "summary poll contained an unbounded prior peer payload",
  );
  check(
    boundedPollText.length < 20_000,
    `summary poll was not bounded (${boundedPollText.length})`,
  );
  const forensicPollText = await callText("session_poll", {
    session_id: started.session_id,
    detail: "full",
    response_format: "json",
  });
  check(forensicPollText.includes(sentinel), "detail=full did not preserve forensic compatibility");

  const markdown = await callText("session_poll", {
    session_id: started.session_id,
    response_format: "markdown",
  });
  check(
    !markdown.trimStart().startsWith("{"),
    'session_poll response_format="markdown" returned a JSON object serialization',
  );
  check(
    markdown.includes("# cross-review session poll"),
    "session_poll markdown omitted its title",
  );
  check(markdown.includes("**session\\_id:**"), "session_poll markdown omitted session_id");
  check(markdown.includes("**outcome:**"), "session_poll markdown omitted outcome");
  check(
    markdown.includes("latest\\_completed\\_round\\_number"),
    "session_poll markdown omitted completed-round state",
  );

  const jobStatusPath = path.join(
    dataDir,
    "sessions",
    started.session_id,
    "background-jobs",
    `${started.job.job_id}.json`,
  );
  const historyDeadline = Date.now() + 5_000;
  let durableTerminalStatus = "";
  while (Date.now() < historyDeadline) {
    if (fs.existsSync(jobStatusPath)) {
      durableTerminalStatus =
        (JSON.parse(fs.readFileSync(jobStatusPath, "utf8")) as { status?: string }).status ?? "";
      if (durableTerminalStatus === "completed") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check(durableTerminalStatus === "completed", "terminal job status was not persisted durably");

  const siblingTransport = createTransport();
  const siblingClient = new Client({
    name: "cross-review-poll-cancel-sibling-regression",
    version: "4.5.16",
  });
  await siblingClient.connect(siblingTransport);
  try {
    const siblingPoll = await callJsonWith<PollPayload>(siblingClient, "session_poll", {
      session_id: started.session_id,
      response_format: "json",
    });
    check(
      siblingPoll.jobs?.some(
        (job) => job.job_id === started.job.job_id && job.status === "completed",
      ),
      "a sibling MCP host could not observe the terminal background job",
    );
    const siblingCancel = await callJsonWith<{
      requested?: boolean;
      reason?: string;
      terminal_job?: { job_id?: string; status?: string };
    }>(siblingClient, "session_cancel_job", {
      session_id: started.session_id,
      job_id: started.job.job_id,
      reason: "cross_process_terminal_lookup",
      response_format: "json",
    });
    check(
      siblingCancel.requested === false &&
        siblingCancel.reason === "job_already_terminal" &&
        siblingCancel.terminal_job?.status === "completed",
      "a sibling MCP host treated a terminal job as an unknown active-job miss",
    );
  } finally {
    await siblingClient.close();
  }

  const sessionBeforeCancel = await callText("session_read", {
    session_id: started.session_id,
    response_format: "json",
  });
  const cancel = await callJson<{
    requested?: boolean;
    reason?: string;
    terminal_job?: { job_id?: string; status?: string; completed_at?: string };
    final_state?: { session_outcome?: string | null; latest_round_number?: number | null };
  }>("session_cancel_job", {
    session_id: started.session_id,
    job_id: started.job.job_id,
    reason: "settled_job_race_regression",
    response_format: "json",
  });
  check(cancel.requested === false, "a settled job must not accept a new cancellation request");
  check(
    cancel.reason === "job_already_terminal",
    `settled cancellation returned ambiguous reason=${String(cancel.reason)}`,
  );
  check(cancel.terminal_job?.job_id === started.job.job_id, "terminal response omitted the job id");
  check(cancel.terminal_job?.status === "completed", "terminal response omitted completed status");
  check(Boolean(cancel.terminal_job?.completed_at), "terminal response omitted completion time");
  check(
    cancel.final_state?.session_outcome === "converged" &&
      typeof cancel.final_state.latest_round_number === "number",
    "settled cancellation omitted the compact final session state",
  );
  const sessionAfterCancel = await callText("session_read", {
    session_id: started.session_id,
    response_format: "json",
  });
  check(
    sessionAfterCancel === sessionBeforeCancel,
    "terminal cancellation mutated sealed session state",
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const logText = fs.existsSync(path.join(dataDir, "logs"))
    ? fs
        .readdirSync(path.join(dataDir, "logs"))
        .map((file) => fs.readFileSync(path.join(dataDir, "logs", file), "utf8"))
        .join("\n")
    : "";
  check(
    !/append_event_persist_failed[\s\S]*session\.identity_verified/.test(
      `${serverStderr}\n${logText}`,
    ),
    "terminal cancellation emitted a false post-terminal identity event persistence failure",
  );

  const unsettledFixture = await callJson<StartedRound>("session_start_round", {
    task: "Settlement failure must remain cancellable without an explicit job id.",
    draft: "FORCE_NOT_READY",
    response_format: "json",
  });
  const unsettledDeadline = Date.now() + 15_000;
  while (Date.now() < unsettledDeadline) {
    const poll = await callJson<PollPayload>("session_poll", {
      session_id: unsettledFixture.session_id,
      response_format: "json",
    });
    if (
      poll.jobs?.some(
        (job) => job.job_id === unsettledFixture.job.job_id && job.status === "completed",
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const unsettledMetaPath = path.join(
    dataDir,
    "sessions",
    unsettledFixture.session_id,
    "meta.json",
  );
  const unsettledMeta = JSON.parse(fs.readFileSync(unsettledMetaPath, "utf8")) as {
    control?: Record<string, unknown>;
  };
  unsettledMeta.control = {
    status: "running",
    job_id: unsettledFixture.job.job_id,
    owner_pid: process.pid,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(unsettledMetaPath, JSON.stringify(unsettledMeta), "utf8");
  const unsettledJobPath = path.join(
    dataDir,
    "sessions",
    unsettledFixture.session_id,
    "background-jobs",
    `${unsettledFixture.job.job_id}.json`,
  );
  const unsettledJob = JSON.parse(fs.readFileSync(unsettledJobPath, "utf8")) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    unsettledJobPath,
    JSON.stringify({
      ...unsettledJob,
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "background_job_settlement_failed: injected regression",
    }),
    "utf8",
  );
  const settlementSiblingTransport = createTransport();
  const settlementSiblingClient = new Client({
    name: "cross-review-settlement-sibling-regression",
    version: "4.5.16",
  });
  await settlementSiblingClient.connect(settlementSiblingTransport);
  let unsettledCancel: { requested?: boolean; control?: { status?: string } };
  try {
    unsettledCancel = await callJsonWith(settlementSiblingClient, "session_cancel_job", {
      session_id: unsettledFixture.session_id,
      reason: "settlement_cleanup_without_job_id",
      response_format: "json",
    });
  } finally {
    await settlementSiblingClient.close();
  }
  const unsettledFinal = JSON.parse(
    await callText("session_read", {
      session_id: unsettledFixture.session_id,
      response_format: "json",
    }),
  ) as { outcome?: string; outcome_reason?: string; control?: { status?: string } };
  check(
    unsettledCancel.requested === true &&
      unsettledFinal.outcome === "aborted" &&
      unsettledFinal.outcome_reason === "session_cancelled" &&
      unsettledFinal.control?.status === "cancelled",
    "cancel without job_id left a settlement-failed job durably orphaned",
  );

  const firstOpenJob = await callJson<StartedRound>("session_start_round", {
    task: "Old terminal job must not cancel a newer active job.",
    draft: "FORCE_NOT_READY",
    response_format: "json",
  });
  const firstDeadline = Date.now() + 15_000;
  let firstOpenJobStatus: string | undefined;
  while (Date.now() < firstDeadline) {
    const poll = await callJson<PollPayload>("session_poll", {
      session_id: firstOpenJob.session_id,
      response_format: "json",
    });
    firstOpenJobStatus = poll.jobs?.find((job) => job.job_id === firstOpenJob.job.job_id)?.status;
    if (firstOpenJobStatus && firstOpenJobStatus !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check(firstOpenJobStatus === "completed", "the old job fixture did not complete");
  const secondActiveJob = await callJson<StartedRound>("session_start_round", {
    session_id: firstOpenJob.session_id,
    task: "Old terminal job must not cancel a newer active job.",
    draft: "FORCE_CANCEL_SLOW",
    response_format: "json",
  });
  const oldJobCancel = await callJson<{
    requested?: boolean;
    reason?: string;
    terminal_job?: { job_id?: string; status?: string };
  }>("session_cancel_job", {
    session_id: firstOpenJob.session_id,
    job_id: firstOpenJob.job.job_id,
    reason: "must_not_cancel_new_job",
    response_format: "json",
  });
  check(
    oldJobCancel.requested === false &&
      oldJobCancel.reason === "job_already_terminal" &&
      oldJobCancel.terminal_job?.job_id === firstOpenJob.job.job_id,
    "cancelling an old terminal job did not return its own terminal state",
  );
  let activeAfterOldCancel: PollPayload = {};
  const activeRoundDeadline = Date.now() + 5_000;
  while (Date.now() < activeRoundDeadline) {
    activeAfterOldCancel = await callJson<PollPayload>("session_poll", {
      session_id: firstOpenJob.session_id,
      response_format: "json",
    });
    if (
      activeAfterOldCancel.jobs?.some(
        (job) => job.job_id === secondActiveJob.job.job_id && job.status === "running",
      ) &&
      activeAfterOldCancel.active_round_number !== null &&
      activeAfterOldCancel.in_flight !== null
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check(
    activeAfterOldCancel.jobs?.some(
      (job) => job.job_id === secondActiveJob.job.job_id && job.status === "running",
    ),
    "cancelling an old terminal job interfered with the newer active job",
  );
  check(
    typeof activeAfterOldCancel.active_round_number === "number" &&
      typeof activeAfterOldCancel.latest_completed_round_number === "number" &&
      activeAfterOldCancel.active_round_number > activeAfterOldCancel.latest_completed_round_number,
    "poll did not distinguish the active round from the latest completed round",
  );
  check(
    activeAfterOldCancel.in_flight !== null &&
      !Object.hasOwn(activeAfterOldCancel.in_flight ?? {}, "evidence_broker_snapshot"),
    "active summary poll exposed the evidence broker snapshot",
  );
  const newJobCancel = await callJson<{ requested?: boolean }>("session_cancel_job", {
    session_id: firstOpenJob.session_id,
    job_id: secondActiveJob.job.job_id,
    reason: "regression_cleanup",
    response_format: "json",
  });
  check(newJobCancel.requested === true, "the active cleanup cancellation was not accepted");

  if (failures.length) {
    throw new Error(
      `v4.5.16 poll/cancel regressions (${failures.length}):\n- ${failures.join("\n- ")}`,
    );
  }
  console.log("[v4.5.16-poll-cancel-regression] PASS");
} finally {
  await client.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
