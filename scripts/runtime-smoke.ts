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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/mcp/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CROSS_REVIEW_DATA_DIR: runtimeSmokeDataDir,
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
    // Perplexity also bills a per-1000-requests search fee; when search is
    // enabled `missingFinancialControlVars` requires the request fee for
    // the configured `search_context_size`. This stub smoke does not
    // exercise paid search, so disable it — and, belt-and-suspenders in
    // case an inherited operator env re-enables it, inject the request fee
    // for every search_context_size so the financial preflight passes
    // regardless.
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
  const noJobSession = (await callTool("session_init", {
    task: "Runtime smoke: verify no-job cancellation is non-terminal.",
    review_focus: "runtime/cancel-no-job",
    response_format: "json",
  })) as { session_id: string };
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
