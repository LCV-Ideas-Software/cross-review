import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_REQUEST_TIMEOUT_MS } from "../src/core/timeouts.js";

const runtimeSmokeDataDir =
  process.env.CROSS_REVIEW_RUNTIME_SMOKE_DATA_DIR ??
  fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-runtime-smoke-"));
const runtimeSmokeConfigPath = path.join(runtimeSmokeDataDir, "config.json");
const runtimeSmokeOperatorToken = "07".repeat(32);
fs.writeFileSync(
  runtimeSmokeConfigPath,
  JSON.stringify({ version: "runtime-smoke-v1" }, null, 2),
  "utf8",
);
fs.writeFileSync(
  path.join(runtimeSmokeDataDir, "host-tokens.json"),
  JSON.stringify(
    {
      version: 2,
      generated_at: "2026-07-10T00:00:00.000Z",
      tokens: {
        codex: "01".repeat(32),
        claude: "02".repeat(32),
        gemini: "03".repeat(32),
        deepseek: "04".repeat(32),
        grok: "05".repeat(32),
        perplexity: "06".repeat(32),
        operator: runtimeSmokeOperatorToken,
      },
    },
    null,
    2,
  ),
  "utf8",
);
const invalidMetaDir = path.join(runtimeSmokeDataDir, "sessions", "invalid-shape");
fs.mkdirSync(invalidMetaDir, { recursive: true });
fs.writeFileSync(path.join(invalidMetaDir, "meta.json"), "{}", "utf8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/mcp/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CROSS_REVIEW_DATA_DIR: runtimeSmokeDataDir,
    CROSS_REVIEW_CONFIG_FILE: runtimeSmokeConfigPath,
    CROSS_REVIEW_CALLER_TOKEN: runtimeSmokeOperatorToken,
    CROSS_REVIEW_REQUIRE_TOKEN: "true",
    CROSS_REVIEW_STUB: process.env.CROSS_REVIEW_STUB ?? "1",
    // v2.4.0 / audit closure (P1.1): runtime smoke is a legitimate stub
    // consumer; opt in to the double-confirmation gate.
    CROSS_REVIEW_STUB_CONFIRMED: process.env.CROSS_REVIEW_STUB_CONFIRMED ?? "1",
    CROSS_REVIEW_MAX_SESSION_COST_USD: process.env.CROSS_REVIEW_MAX_SESSION_COST_USD ?? "1000",
    CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD:
      process.env.CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD ?? "1000",
    CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD:
      process.env.CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD ?? "1000",
    CROSS_REVIEW_OPENAI_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_OPENAI_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_OPENAI_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_OPENAI_OUTPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_GEMINI_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_GEMINI_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_GEMINI_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_GEMINI_OUTPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_DEEPSEEK_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_DEEPSEEK_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_DEEPSEEK_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_DEEPSEEK_OUTPUT_USD_PER_MILLION ?? "1000",
    // v3.7.4 (Codex v3.7.3 parecer AUDIT-1): the public MCP path strips a
    // caller's `peers` list (v3.3.0 `lockCallerPeerSelection`), so every
    // round here runs the full server-configured 6-peer panel — grok and
    // perplexity included. Without their rate cards `missingFinancialControlVars`
    // trips and the round finalizes `outcome=max-rounds` /
    // `financial_controls_missing` instead of actually running. Inject all
    // six peers' cost rates so the round genuinely converges and the
    // outcome asserts below mean something.
    CROSS_REVIEW_GROK_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_GROK_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_GROK_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_GROK_OUTPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_PERPLEXITY_INPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_PERPLEXITY_INPUT_USD_PER_MILLION ?? "1000",
    CROSS_REVIEW_PERPLEXITY_OUTPUT_USD_PER_MILLION:
      process.env.CROSS_REVIEW_PERPLEXITY_OUTPUT_USD_PER_MILLION ?? "1000",
    // Perplexity bills a context-tier fee for every request even when
    // disable_search=true. Inject every tier so inherited context settings
    // cannot make this runtime smoke fail financial preflight.
    CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH:
      process.env.CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH ?? "1",
    CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_LOW_USD_PER_1000_REQUESTS:
      process.env.CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_LOW_USD_PER_1000_REQUESTS ?? "0",
    CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS:
      process.env.CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS ?? "0",
    CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS:
      process.env.CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS ?? "0",
  },
});

const client = new Client({ name: "cross-review-runtime-smoke", version: "0.0.0" });

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: MCP_REQUEST_TIMEOUT_MS,
    maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS,
  });
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content[0]?.type === "text" ? (content[0].text ?? "{}") : "{}";
  if ((result as { isError?: boolean }).isError) {
    throw new Error(text);
  }
  return JSON.parse(text);
}

async function callToolText(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: MCP_REQUEST_TIMEOUT_MS,
    maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS,
  });
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content[0]?.type === "text" ? (content[0].text ?? "") : "";
}

type PollState = { outcome?: string; jobs?: Array<{ status: string }> };

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;
const TERMINAL_OUTCOMES = new Set(["converged", "aborted", "max-rounds"]);

async function pollUntilDone(sessionId: string): Promise<PollState> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState: PollState | undefined;
  while (Date.now() < deadline) {
    const state = (await callTool("session_poll", {
      session_id: sessionId,
      response_format: "json",
    })) as PollState;
    lastState = state;
    if (state.outcome && TERMINAL_OUTCOMES.has(state.outcome)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out polling runtime-smoke session ${sessionId} after ${POLL_TIMEOUT_MS} ms; last_state=${JSON.stringify(lastState)}`,
  );
}

try {
  await client.connect(transport);
  const serverInfo = await callTool("server_info", { response_format: "json" });
  const capabilities = await callTool("runtime_capabilities", { response_format: "json" });
  const packageVersion = (
    JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }
  ).version;
  assert.equal(
    (serverInfo as { version?: string }).version,
    packageVersion,
    "runtime-smoke: server_info.version must match package.json version",
  );
  assert.equal(
    (capabilities as { version?: string }).version,
    packageVersion,
    "runtime-smoke: runtime_capabilities.version must match package.json version",
  );
  const configLoad = (
    serverInfo as {
      config_load?: {
        path?: string;
        applied?: boolean;
        parse_error?: string | null;
        live_reload_supported?: boolean;
        reload_required?: boolean;
        loaded_sha256?: string;
      };
      models?: Record<string, string>;
      reasoning_effort?: Record<string, string>;
    }
  ).config_load;
  assert.equal(configLoad?.path, runtimeSmokeConfigPath);
  assert.equal(configLoad?.applied, true);
  assert.equal(configLoad?.parse_error, null);
  assert.equal(configLoad?.live_reload_supported, false);
  assert.equal(configLoad?.reload_required, false);
  assert.match(configLoad?.loaded_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(typeof (serverInfo as { models?: unknown }).models, "object");
  assert.equal(typeof (serverInfo as { reasoning_effort?: unknown }).reasoning_effort, "object");

  fs.writeFileSync(
    runtimeSmokeConfigPath,
    JSON.stringify({ version: "runtime-smoke-v2" }, null, 2),
    "utf8",
  );
  const staleServerInfo = (await callTool("server_info", {
    response_format: "json",
  })) as { config_load?: { reload_required?: boolean; current_sha256?: string } };
  assert.equal(
    staleServerInfo.config_load?.reload_required,
    true,
    "server_info must reveal when config.json changed after this MCP window loaded it.",
  );
  assert.match(staleServerInfo.config_load?.current_sha256 ?? "", /^[a-f0-9]{64}$/);
  fs.writeFileSync(
    runtimeSmokeConfigPath,
    JSON.stringify({ version: "runtime-smoke-v1" }, null, 2),
    "utf8",
  );
  const markdownInitText = await callToolText("session_init", {
    task: "Runtime smoke: verify session_init markdown response.",
    review_focus: "runtime/markdown-init",
    response_format: "markdown",
  });
  const sessionListResult = (await callTool("session_list", {
    limit: 2,
    offset: 0,
    outcome_filter: "all",
    detail: "summary",
    response_format: "json",
  })) as {
    sessions?: unknown[] | undefined;
    pagination?: {
      total?: number | undefined;
      returned?: number;
      limit?: number;
      has_more?: boolean;
    };
    detail?: string | undefined;
    outcome_filter?: string | undefined;
  };
  assert.equal(
    fs.existsSync(path.join(invalidMetaDir, "meta.json.bad")),
    true,
    "runtime session_list must quarantine a syntactically valid but structurally invalid meta.json.",
  );
  const noJobSession = (await callTool("session_init", {
    task: "Runtime smoke: verify no-job cancellation is non-terminal.",
    review_focus: "runtime/cancel-no-job",
    response_format: "json",
  })) as { session_id: string };
  let peerFinalizeBlocked = false;
  try {
    await callTool("session_finalize", {
      session_id: noJobSession.session_id,
      outcome: "aborted",
      reason: "unauthorized peer fixture",
      caller: "claude",
      response_format: "json",
    });
  } catch (error) {
    peerFinalizeBlocked = /operator_authority_required|identity_forgery_blocked/.test(
      String(error),
    );
  }
  assert.equal(
    peerFinalizeBlocked,
    true,
    "A peer must not be able to mutate terminal session state through session_finalize.",
  );
  const noJobCancelResult = (await callTool("session_cancel_job", {
    session_id: noJobSession.session_id,
    reason: "runtime_smoke_no_active_job",
    response_format: "json",
  })) as { requested: boolean; reason?: string; matched_jobs?: unknown[] };
  const noJobCancelState = (await callTool("session_poll", {
    session_id: noJobSession.session_id,
    response_format: "json",
  })) as PollState;
  const roundStart = (await callTool("session_start_round", {
    task: "Runtime smoke: verify async review round.",
    review_focus: "runtime/smoke",
    draft: "Runtime smoke draft.",
    peers: ["codex"],
    response_format: "json",
  })) as { session_id: string };
  const roundState = await pollUntilDone(roundStart.session_id);
  const events = await callTool("session_events", {
    session_id: roundStart.session_id,
    response_format: "json",
  });
  const report = await callTool("session_report", {
    session_id: roundStart.session_id,
    response_format: "json",
  });
  const unanimousStart = (await callTool("session_start_unanimous", {
    task: "Runtime smoke: verify async unanimity flow.",
    review_focus: "runtime/unanimous",
    lead_peer: "codex",
    peers: ["claude"],
    max_rounds: 2,
    response_format: "json",
  })) as { session_id: string };
  const unanimousState = await pollUntilDone(unanimousStart.session_id);
  const cancelStart = (await callTool("session_start_round", {
    task: "Runtime smoke: verify cancellation tool.",
    draft: "FORCE_CANCEL_SLOW",
    peers: ["codex"],
    response_format: "json",
  })) as { session_id: string; job: { job_id: string } };
  const cancelResult = await callTool("session_cancel_job", {
    session_id: cancelStart.session_id,
    job_id: cancelStart.job.job_id,
    reason: "runtime_smoke_cancel",
    response_format: "json",
  });
  const cancelState = await pollUntilDone(cancelStart.session_id);
  const metrics = await callTool("session_metrics", { response_format: "json" });
  const recovery = await callTool("session_recover_interrupted", { response_format: "json" });
  // v3.7.4 (Codex v3.7.3 parecer AUDIT-1): assert the durable terminal
  // state of every async flow this smoke claims to exercise. Without these
  // the harness printed `ok: true` even when a round was silently blocked
  // by the financial preflight (`outcome=max-rounds`) instead of actually
  // running. These asserts run BEFORE the `ok: true` print, so any flow
  // that did not reach its intended terminal state fails the smoke loudly
  // with a non-zero exit.
  assert.match(
    markdownInitText,
    /^# cross-review session [0-9a-f-]+/m,
    "runtime-smoke: session_init markdown response must start with a markdown heading",
  );
  assert.ok(
    markdownInitText.includes("## Task"),
    "runtime-smoke: session_init markdown response must include a Task section",
  );
  assert.equal(
    markdownInitText.trimStart().startsWith("{"),
    false,
    "runtime-smoke: session_init markdown response must not be JSON serialization",
  );
  assert.equal(
    sessionListResult.detail,
    "summary",
    "runtime-smoke: session_list must default/return summary detail for bounded list calls",
  );
  assert.equal(
    sessionListResult.outcome_filter,
    "all",
    "runtime-smoke: session_list must echo the outcome_filter",
  );
  assert.equal(
    sessionListResult.pagination?.limit,
    2,
    "runtime-smoke: session_list must honor the requested page limit",
  );
  assert.ok(
    (sessionListResult.sessions?.length ?? 0) <= 2,
    "runtime-smoke: session_list must not return more entries than the requested limit",
  );
  assert.equal(
    noJobCancelResult.requested,
    false,
    "runtime-smoke: no-job cancellation must not claim a cancellation request was issued",
  );
  assert.equal(
    noJobCancelResult.reason,
    "no_running_job_matched",
    "runtime-smoke: no-job cancellation must report no_running_job_matched",
  );
  assert.equal(
    noJobCancelState.outcome,
    undefined,
    `runtime-smoke: no-job cancellation must not terminal-abort the session — outcome=${String(noJobCancelState.outcome)}`,
  );
  assert.equal(
    roundState.outcome,
    "converged",
    `runtime-smoke: review round did not converge — outcome=${String(roundState.outcome)}`,
  );
  assert.equal(
    unanimousState.outcome,
    "converged",
    `runtime-smoke: unanimity flow did not converge — outcome=${String(unanimousState.outcome)}`,
  );
  assert.equal(
    cancelState.outcome,
    "aborted",
    `runtime-smoke: cancellation flow did not abort — outcome=${String(cancelState.outcome)}`,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime_smoke_data_dir: runtimeSmokeDataDir,
        serverInfo,
        capabilities,
        markdownInitText,
        sessionListResult,
        no_job_cancel_session_id: noJobSession.session_id,
        noJobCancelResult,
        noJobCancelState,
        round_session_id: roundStart.session_id,
        roundState,
        events,
        report,
        unanimous_session_id: unanimousStart.session_id,
        unanimousState,
        cancel_session_id: cancelStart.session_id,
        cancelResult,
        cancelState,
        metrics,
        recovery,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
