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
const runtimeSmokeCodexToken = "01".repeat(32);
const runtimeSmokeClaudeToken = "02".repeat(32);
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
        codex: runtimeSmokeCodexToken,
        claude: runtimeSmokeClaudeToken,
        gemini: "03".repeat(32),
        deepseek: "04".repeat(32),
        grok: "05".repeat(32),
        perplexity: "06".repeat(32),
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

const runtimeSmokeTransportOptions = {
  command: process.execPath,
  args: ["dist/src/mcp/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CROSS_REVIEW_DATA_DIR: runtimeSmokeDataDir,
    CROSS_REVIEW_CONFIG_FILE: runtimeSmokeConfigPath,
    CROSS_REVIEW_CALLER_TOKEN: runtimeSmokeClaudeToken,
    CROSS_REVIEW_REQUIRE_TOKEN: "true",
    CROSS_REVIEW_STUB: process.env.CROSS_REVIEW_STUB ?? "1",
    // v2.4.0 / audit closure (P1.1): runtime smoke is a legitimate stub
    // consumer; opt in to the double-confirmation gate.
    CROSS_REVIEW_STUB_CONFIRMED: process.env.CROSS_REVIEW_STUB_CONFIRMED ?? "1",
    CROSS_REVIEW_MAX_ATTACHED_EVIDENCE_CHARS: "200000",
    CROSS_REVIEW_DEFAULT_MAX_ROUNDS: "2",
    CROSS_REVIEW_MAX_SESSION_COST_USD: process.env.CROSS_REVIEW_MAX_SESSION_COST_USD ?? "10000",
    CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD:
      process.env.CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD ?? "10000",
    CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD:
      process.env.CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD ?? "10000",
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
    // The Agent API web_search fee applies only while search is enabled.
    // Disable search so inherited context settings cannot make this runtime
    // smoke fail financial preflight on a missing search-fee dimension.
    CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH:
      process.env.CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH ?? "1",
  },
};
const transport = new StdioClientTransport(runtimeSmokeTransportOptions);

const client = new Client({ name: "cross-review-runtime-smoke", version: "0.0.0" });

async function callToolWithClient(
  targetClient: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await targetClient.callTool({ name, arguments: args }, undefined, {
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

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return await callToolWithClient(client, name, args);
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
type RuntimePreflightPayload = {
  pass?: boolean;
  truthfulness_pass?: boolean;
  evidence_pass?: boolean;
  blocking_gates?: string[];
  evidence?: {
    result?: { evidence_authority?: string } | null;
  };
};

type RuntimePreflightAuthorityAttempt = {
  tool: "session_preflight_check" | "session_truthfulness_preflight_check";
  payload?: RuntimePreflightPayload;
  error?: string;
};
type EvidenceToolInputSchema = {
  properties?: { evidence?: { description?: string; maxLength?: number } };
};
type RuntimeToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};
type RuntimeMaxRoundsSchema = { minimum?: number; maximum?: number; default?: number };

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;
const TERMINAL_OUTCOMES = new Set(["converged", "aborted", "max-rounds"]);

async function pollUntilDoneWithClient(
  targetClient: Client,
  sessionId: string,
): Promise<PollState> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState: PollState | undefined;
  while (Date.now() < deadline) {
    const state = (await callToolWithClient(targetClient, "session_poll", {
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

async function pollUntilDone(sessionId: string): Promise<PollState> {
  return pollUntilDoneWithClient(client, sessionId);
}

try {
  await client.connect(transport);
  const serverInfo = await callTool("server_info", { caller: "claude", response_format: "json" });
  const capabilities = await callTool("runtime_capabilities", {
    caller: "claude",
    response_format: "json",
  });
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
    caller: "claude",
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
  const negativePreflightSession = (await callTool("session_init", {
    caller: "claude",
    task: "Runtime preflight check: completed implementation with 74 passed.",
    response_format: "json",
  })) as { session_id: string };
  const negativePreflightArgs = {
    session_id: negativePreflightSession.session_id,
    draft: "Implementation summary without any raw output.",
    caller: "claude",
    response_format: "json",
  };
  const negativeCombinedPreflight = (await callTool(
    "session_preflight_check",
    negativePreflightArgs,
  )) as RuntimePreflightPayload;
  const negativeAliasPreflight = (await callTool(
    "session_truthfulness_preflight_check",
    negativePreflightArgs,
  )) as RuntimePreflightPayload;
  for (const [tool, payload] of [
    ["session_preflight_check", negativeCombinedPreflight],
    ["session_truthfulness_preflight_check", negativeAliasPreflight],
  ] as const) {
    assert.equal(payload.truthfulness_pass, true, `${tool}: truthfulness control must pass`);
    assert.equal(payload.evidence_pass, false, `${tool}: missing evidence must fail`);
    assert.equal(
      payload.pass,
      false,
      `${tool}: top-level pass must reflect the failing evidence gate, not truthfulness alone`,
    );
    assert.deepEqual(payload.blocking_gates, ["evidence"]);
  }

  const codexTransport = new StdioClientTransport({
    ...runtimeSmokeTransportOptions,
    env: {
      ...runtimeSmokeTransportOptions.env,
      CROSS_REVIEW_CALLER_TOKEN: runtimeSmokeCodexToken,
    },
  });
  const codexClient = new Client({ name: "codex", version: "0.0.0" });
  let positiveCombinedPreflight: RuntimePreflightPayload;
  let positiveAliasPreflight: RuntimePreflightPayload;
  const operatorOwnerAttempts: RuntimePreflightAuthorityAttempt[] = [];
  try {
    await codexClient.connect(codexTransport);
    const listedTools = await codexClient.listTools();
    // crosrev-40: no MCP actor can "escalate to an operator"; the tool is gone
    // and session closure belongs to the persisted petitioner.
    assert.equal(
      listedTools.tools.some((tool) => tool.name === "escalate_to_operator"),
      false,
      "escalate_to_operator must not be registered",
    );
    // v07.00.00: two more tools are gone, so the surface is 28. Both demanded
    // operator authority, and opening either to peers would have dropped a real
    // property rather than removed a phantom: session_evidence_checklist_update
    // would let a peer mark its own evidence ask satisfied, permanently, and
    // regenerate_caller_tokens would let any peer rotate every host's token.
    for (const removed of [
      "session_evidence_checklist_update",
      "regenerate_caller_tokens",
    ] as const) {
      assert.equal(
        listedTools.tools.some((tool) => tool.name === removed),
        false,
        `${removed} must not be registered`,
      );
    }
    assert.equal(listedTools.tools.length, 28, "runtime must register exactly 28 tools");
    const initTool = listedTools.tools.find((tool) => tool.name === "session_init");
    assert.equal(
      (initTool?.inputSchema.properties?.task as { maxLength?: number } | undefined)?.maxLength,
      32_000,
      "native session_init must advertise the same scalar task ceiling as other starters",
    );
    for (const name of ["run_until_unanimous", "session_start_unanimous"]) {
      const tool = listedTools.tools.find((item) => item.name === name);
      const schema = tool?.inputSchema.properties?.max_rounds as RuntimeMaxRoundsSchema | undefined;
      assert.ok(schema);
      assert.equal(schema.minimum, 1);
      assert.equal(schema.maximum, 1000);
      assert.equal(
        Object.hasOwn(schema, "default"),
        false,
        `${name}: native schema must preserve omitted max_rounds for mode-specific defaults`,
      );
      assert.equal(tool?.inputSchema.required?.includes("max_rounds") ?? false, false);
    }
    for (const name of ["session_evidence_judge_pass", "session_evidence_judge_consensus_pass"]) {
      const tool = listedTools.tools.find((item) => item.name === name);
      assert.ok(tool);
      assert.equal(
        tool.annotations?.openWorldHint,
        true,
        `${name}: native provider calls are external`,
      );
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.idempotentHint, false);
    }
    const finalizeTool = listedTools.tools.find((tool) => tool.name === "session_finalize");
    assert.ok(finalizeTool?.description, "runtime must expose session_finalize with a description");
    const contestTool = listedTools.tools.find((tool) => tool.name === "contest_verdict");
    assert.ok(contestTool?.description, "runtime must expose contest_verdict with a description");
    // v07.00.00: this used to cover two tools. Removing the operator principal
    // left 51 user-facing sites still describing it, and the worst of them were
    // exactly here — descriptions offering "the operator token" as a credential
    // for `session_cancel_job`, `contest_verdict` and `session_finalize`, and a
    // title reading "Promote Operator Evidence" on a tool that promotes
    // nothing. So the gate now reads EVERY registered title and description
    // from the live tools/list, which is the surface a peer host actually
    // receives. It deliberately does not scan source files: the sentences that
    // record the removal legitimately name what was removed, and a file scan
    // cannot tell "this exists" from "this stopped existing".
    const retiredIdentityPatterns: Array<[RegExp, string]> = [
      [/operator\s+(?:capability\s+)?token/i, "no operator token is generated"],
      [
        /human operator|dedicated console|operator console|human-console|human console/i,
        "no human acts on the MCP surface",
      ],
      [/manual operator attachment/i, "no such attachment party ever existed"],
      [/OPERATOR-VERIFIED/, "the promoted evidence tier was collapsed"],
      [/Promote Operator Evidence/i, "the tool promotes nothing"],
      [/caller=operator|caller = operator/i, "the caller schema admits only peers"],
    ];
    const identityLeaks: string[] = [];
    for (const tool of listedTools.tools) {
      for (const surface of [tool.title, tool.description, tool.annotations?.title]) {
        if (typeof surface !== "string") continue;
        for (const [pattern, why] of retiredIdentityPatterns) {
          const hit = pattern.exec(surface);
          if (hit) identityLeaks.push(`${tool.name}: "${hit[0]}" — ${why}`);
        }
      }
    }
    assert.deepEqual(
      identityLeaks,
      [],
      "v07.00.00 / retired identity: a published tool surface describes the operator principal again",
    );
    assert.match(
      finalizeTool.description,
      /persisted session petitioner[\s\S]*pass `caller` explicitly/i,
      "session_finalize must tell peer hosts to pass their own caller identity",
    );
    const attachEvidenceTool = listedTools.tools.find(
      (tool) => tool.name === "session_attach_evidence",
    );
    assert.ok(attachEvidenceTool, "runtime must expose session_attach_evidence to every peer");
    // v07.00.00: the description used to announce an "optional operator-only
    // authority-promotion surface" and reassure the caller that no human action
    // was required. Both halves described a principal with no channel to this
    // server. What the description must now say is what the tool actually
    // does: the session's own petitioner may call it, and it promotes nothing.
    //
    // PR #300 review round 2: the description said "any authenticated peer",
    // which was true of the code and wrong as a contract — the gate was
    // identity-only, so a peer could attach to a session it did not own. Both
    // the gate and this sentence now name the petitioner.
    assert.match(
      attachEvidenceTool.description ?? "",
      /only the session's own petitioner[\s\S]*promotes nothing[\s\S]*`evidence` field/i,
      "session_attach_evidence must describe itself as petitioner-scoped and non-promoting",
    );
    assert.doesNotMatch(
      attachEvidenceTool.description ?? "",
      /operator/i,
      "v07.00.00: no tool description may name an operator",
    );
    for (const starterName of [
      "ask_peers",
      "session_start_round",
      "run_until_unanimous",
      "session_start_unanimous",
    ]) {
      const starter = listedTools.tools.find((tool) => tool.name === starterName);
      const schema = starter?.inputSchema as EvidenceToolInputSchema | undefined;
      // v07.00.00: the field used to promise "no manual operator attachment is
      // required" — reassurance about a party that never existed. What the
      // caller needs to know is that the field itself is the durable channel.
      assert.match(
        schema?.properties?.evidence?.description ?? "",
        /persisted automatically[\s\S]*caller_submitted_unverified/i,
        `${starterName}.evidence must advertise automatic durable transport and its provenance`,
      );
      assert.doesNotMatch(
        schema?.properties?.evidence?.description ?? "",
        /operator/i,
        `${starterName}.evidence must not name an operator`,
      );
      assert.equal(
        schema?.properties?.evidence?.maxLength,
        200_000,
        `${starterName}.evidence must publish its 200000-character transport boundary`,
      );
    }
    // Exercise both native schema refusal and aggregate admission in the actual
    // MCP handlers. Refused async starts must leave no session, durable job,
    // in-flight marker, capability snapshot, or peer dispatch event behind.
    const evidenceStartInventory = async () => {
      const listed = (await callToolWithClient(codexClient, "session_list", {
        caller: "codex",
        limit: 100,
        offset: 0,
        outcome_filter: "all",
        detail: "summary",
        response_format: "json",
      })) as { sessions?: Array<{ session_id: string }>; pagination?: { total?: number } };
      const sessionsRoot = path.join(runtimeSmokeDataDir, "sessions");
      const sessionFiles = fs
        .readdirSync(sessionsRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(sessionsRoot, file), fs.readFileSync(file, "utf8")] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right));
      const logsRoot = path.join(runtimeSmokeDataDir, "logs");
      const dispatchEvents = fs
        .readdirSync(logsRoot)
        .flatMap((name) =>
          fs
            .readFileSync(path.join(logsRoot, name), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type: string }),
        )
        .filter((event) => /^(?:peer\.|session\.created|job\.)/.test(event.type));
      return {
        total: listed.pagination?.total,
        sessionIds: (listed.sessions ?? []).map((session) => session.session_id).sort(),
        sessionFiles,
        dispatchEvents,
      };
    };
    const overLimitEvidence = "x".repeat(200_001);
    assert.equal(overLimitEvidence.length, 200_001);
    for (const starterName of ["session_start_round", "session_start_unanimous"] as const) {
      for (const aggregateAdmission of [false, true]) {
        const before = await evidenceStartInventory();
        const initialArtifact = "```text\nCOMMAND: npm test\nEXIT_CODE: 0\n```";
        const result = (await codexClient.callTool(
          {
            name: starterName,
            arguments: {
              caller: "codex",
              task: "Runtime boundary: inspect this proposed artifact.",
              evidence: aggregateAdmission ? "x".repeat(200_000) : overLimitEvidence,
              ...(aggregateAdmission
                ? starterName === "session_start_round"
                  ? { draft: initialArtifact }
                  : { initial_draft: initialArtifact }
                : {}),
              response_format: "json",
            },
          },
          undefined,
          { timeout: MCP_REQUEST_TIMEOUT_MS, maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS },
        )) as RuntimeToolResult;
        assert.equal(result.isError, true, `${starterName}: oversized evidence must be isError`);
        const errorText = (result.content ?? [])
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        assert.match(errorText, /200000/, `${starterName}: refusal must name the allowed size`);
        if (aggregateAdmission) {
          assert.match(
            errorText,
            /proposed caller evidence.*2000\d{2} characters/,
            `${starterName}: aggregate refusal must name the actual received size`,
          );
          assert.match(errorText, /No evidence was truncated/);
        }
        // EventLog appends asynchronously; let its diagnostic queue settle
        // before comparing dispatch records from both connected runtimes.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(
          await evidenceStartInventory(),
          before,
          `${starterName}: refused evidence must not create sessions, jobs, or dispatch events`,
        );
      }
    }
    for (const nestedInput of [false, true]) {
      const boundaryMembers = nestedInput
        ? { padding: Array.from({ length: 253 }, (_, index) => index) }
        : Object.fromEntries(
            Array.from({ length: 254 }, (_, index) => [`padding_${index}`, index]),
          );
      const accepted = await codexClient.callTool({
        name: "server_info",
        arguments: { caller: "codex", response_format: "json", ...boundaryMembers },
      });
      assert.notEqual(
        accepted.isError,
        true,
        `native SDK guard: ${nestedInput ? "nested" : "flat"} 256-member input must be accepted`,
      );
      const overflowMembers = nestedInput
        ? { padding: Array.from({ length: 253 }, (_, index) => index) }
        : Object.fromEntries(
            Array.from({ length: 254 }, (_, index) => [`padding_${index}`, index]),
          );
      const before = await evidenceStartInventory();
      const rejected = (await codexClient.callTool({
        name: "session_init",
        arguments: {
          caller: "codex",
          task: "Runtime SDK boundary: proposed session must never be initialized.",
          response_format: "json",
          ...overflowMembers,
        },
      })) as RuntimeToolResult;
      assert.equal(
        rejected.isError,
        true,
        `native SDK guard: ${nestedInput ? "nested" : "flat"} 257-member input must be isError`,
      );
      const errorText = (rejected.content ?? [])
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");
      assert.match(errorText, /arguments contain more than the maximum of 256 elements/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        await evidenceStartInventory(),
        before,
        "native SDK guard: overflow must be rejected before session initialization or dispatch",
      );
      const continued = (await callToolWithClient(codexClient, "server_info", {
        caller: "codex",
        response_format: "json",
      })) as { version?: string };
      assert.equal(continued.version, packageVersion, "native SDK refusal must leave MCP usable");
    }
    const beforeTaskOverflow = await evidenceStartInventory();
    const taskOverflow = (await codexClient.callTool({
      name: "session_init",
      arguments: {
        task: "X".repeat(32_001),
        caller: "codex",
        response_format: "json",
      },
    })) as RuntimeToolResult;
    assert.equal(taskOverflow.isError, true);
    assert.match(
      (taskOverflow.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
      /expected string to have <=32000 characters at task/,
    );
    assert.deepEqual(
      await evidenceStartInventory(),
      beforeTaskOverflow,
      "native scalar refusal must precede initialization, provider probes and all durable effects",
    );
    const manualCapSession = (await callToolWithClient(codexClient, "session_init", {
      task: "X".repeat(32_000),
      caller: "codex",
      response_format: "json",
    })) as { session_id: string; task: string };
    assert.equal(
      manualCapSession.task.length,
      32_000,
      "the exact native task boundary stays valid",
    );
    type ManualEvidenceEvent = {
      type: string;
      session_id: string;
      message: string;
      ts: string;
      seq: number;
      data?: Record<string, unknown>;
    };
    type ManualEvidenceParent = {
      parent_pid: number;
      parent_exe_basename: string | null;
    };
    const manualSessionDirectory = path.join(
      runtimeSmokeDataDir,
      "sessions",
      manualCapSession.session_id,
    );
    const awaitManualEvidenceEvent = async (type: string, afterSeq = 0) => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const page = (await callToolWithClient(codexClient, "session_events", {
          session_id: manualCapSession.session_id,
          response_format: "json",
        })) as { events?: ManualEvidenceEvent[] };
        const event = page.events?.find((item) => item.type === type && item.seq > afterSeq);
        if (event) {
          const meta = JSON.parse(
            fs.readFileSync(path.join(manualSessionDirectory, "meta.json"), "utf8"),
          ) as {
            updated_at: string;
            convergence_health: { last_event_at: string; last_activity_at: string };
          };
          // The event is appended before its metadata write and native release.
          // Observe all three before taking a strict durable-file snapshot.
          if (
            meta.updated_at >= event.ts &&
            meta.convergence_health.last_event_at >= event.ts &&
            meta.convergence_health.last_activity_at >= event.ts &&
            !fs.existsSync(path.join(manualSessionDirectory, ".lock"))
          ) {
            return event;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      assert.fail(`Manual evidence fixture did not durably settle ${type} after seq ${afterSeq}`);
    };
    // session_init emits session.created asynchronously. It is preexisting
    // fixture work, so settle it before attributing any delta to refusal.
    await awaitManualEvidenceEvent("session.created");
    const attachOverflow = async (content: string) => {
      const rejected = (await codexClient.callTool({
        name: "session_attach_evidence",
        arguments: {
          session_id: manualCapSession.session_id,
          caller: "codex",
          label: "manual-overflow",
          content,
          response_format: "json",
        },
      })) as RuntimeToolResult;
      assert.equal(
        rejected.isError,
        true,
        "MCP must refuse an over-cap manual attachment before persisting it",
      );
      const message = (rejected.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      assert.match(
        message,
        /evidence_transport_limit_exceeded: proposed attachment.*200001 characters; the configured limit is 200000/,
      );
    };
    const assertManualOverflowPreservesEvidence = async (content: string) => {
      const before = await evidenceStartInventory();
      const eventsPath = path.join(manualCapSession.session_id, "events.ndjson");
      const metaPath = path.join(manualCapSession.session_id, "meta.json");
      const beforeFiles = new Map(before.sessionFiles);
      const priorEventText = beforeFiles.get(eventsPath);
      assert.ok(priorEventText, "the creation event must already be durable in the baseline");
      const priorEvents = priorEventText
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as ManualEvidenceEvent);
      const previousSeq = priorEvents.at(-1)?.seq;
      assert.ok(previousSeq);
      await attachOverflow(content);
      const audit = await awaitManualEvidenceEvent("session.identity_verified", previousSeq);
      assert.equal(audit.seq, previousSeq + 1, "refusal may append only the next owner audit");
      assert.equal(audit.session_id, manualCapSession.session_id);
      assert.equal(audit.message, "caller identity verification completed.");
      assert.match(audit.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const parent = audit.data?.identity_metadata as ManualEvidenceParent | undefined;
      assert.ok(parent);
      assert.equal(parent.parent_pid, process.pid, "the native audit must identify this host");
      if (parent.parent_exe_basename !== null) {
        const nativeParentName =
          process.platform === "linux"
            ? fs.readFileSync(`/proc/${process.pid}/comm`, "utf8").trim()
            : path.basename(process.execPath);
        assert.equal(parent.parent_exe_basename.toLowerCase(), nativeParentName.toLowerCase());
      }
      assert.deepEqual(audit.data, {
        site: "session_attach_evidence",
        caller: "codex",
        identity_verified: true,
        verification_method: "token",
        client_info_name: "codex",
        identity_metadata: parent,
      });
      assert.deepEqual(Object.keys(audit).sort(), [
        "data",
        "message",
        "seq",
        "session_id",
        "ts",
        "type",
      ]);
      const previousMetaText = beforeFiles.get(metaPath);
      assert.ok(previousMetaText);
      const expectedMeta = JSON.parse(previousMetaText);
      const activityAt =
        expectedMeta.convergence_health.last_activity_at > audit.ts
          ? expectedMeta.convergence_health.last_activity_at
          : audit.ts;
      expectedMeta.updated_at =
        expectedMeta.updated_at > activityAt ? expectedMeta.updated_at : activityAt;
      expectedMeta.convergence_health.last_event_at = activityAt;
      expectedMeta.convergence_health.last_activity_at = activityAt;
      // The paginated API places seq first; the native durable writer appends
      // it after the original event fields. Preserve the exact on-disk order.
      const persistedAudit = {
        type: audit.type,
        session_id: audit.session_id,
        message: audit.message,
        data: audit.data,
        ts: audit.ts,
        seq: audit.seq,
      };
      const expected = {
        ...before,
        sessionFiles: before.sessionFiles.map(([file, text]) => [
          file,
          file === eventsPath
            ? `${text}${JSON.stringify(persistedAudit)}\n`
            : file === metaPath
              ? `${JSON.stringify(expectedMeta, null, 2)}\n`
              : text,
        ]),
      };
      // Owner authentication is audited even when admission refuses evidence.
      // Permit that exact event and its three activity timestamps, while every
      // other file, metadata field, attachment, reservation and dispatch stays equal.
      assert.deepEqual(await evidenceStartInventory(), expected);
      return audit.seq;
    };
    const firstRefusalAuditSeq = await assertManualOverflowPreservesEvidence("X".repeat(200_001));
    await callToolWithClient(codexClient, "session_attach_evidence", {
      session_id: manualCapSession.session_id,
      caller: "codex",
      label: "manual-exact-cap",
      content: "X".repeat(200_000),
      response_format: "json",
    });
    await awaitManualEvidenceEvent("session.identity_verified", firstRefusalAuditSeq);
    await awaitManualEvidenceEvent("session.evidence_attached", firstRefusalAuditSeq);
    await assertManualOverflowPreservesEvidence("Y");

    const roundDefaults = (await callToolWithClient(codexClient, "server_info", {
      caller: "codex",
      response_format: "json",
    })) as { budget: { default_max_rounds: number } };
    assert.equal(roundDefaults.budget.default_max_rounds, 2);
    for (const name of ["run_until_unanimous", "session_start_unanimous"] as const) {
      for (const explicitRounds of [undefined, 1]) {
        const result = (await callToolWithClient(codexClient, name, {
          caller: "codex",
          task: "Review the unchanged static artifact. FORCE_NEEDS_EVIDENCE",
          initial_draft: "Unchanged static fixture material. FORCE_NEEDS_EVIDENCE",
          mode: "review",
          allow_auto_extension: false,
          ...(explicitRounds === undefined ? {} : { max_rounds: explicitRounds }),
          response_format: "json",
        })) as { session_id?: string; session?: { session_id: string } };
        const sessionId = result.session_id ?? result.session?.session_id;
        assert.ok(sessionId);
        if (name === "session_start_unanimous") {
          await pollUntilDoneWithClient(codexClient, sessionId);
        }
        const saved = (await callToolWithClient(codexClient, "session_read", {
          session_id: sessionId,
          response_format: "json",
        })) as {
          requested_max_rounds: number | null;
          effective_max_rounds: number;
          outcome: string;
          rounds: unknown[];
        };
        assert.equal(saved.requested_max_rounds, explicitRounds ?? null);
        assert.equal(saved.effective_max_rounds, explicitRounds ?? 2);
        assert.equal(saved.rounds.length, explicitRounds ?? 2);
        assert.equal(saved.outcome, "max-rounds");
      }
    }

    const peerSession = (await callToolWithClient(codexClient, "session_init", {
      task: "Runtime peer preflight: completed implementation with 74 passed.",
      caller: "codex",
      response_format: "json",
    })) as { session_id: string };
    // v07.00.00 contract change: this used to assert that an AI attachment
    // attempt was REFUSED and redirected to the `evidence` field, because the
    // tool demanded operator authority. The tool is open now, so the successor
    // invariant is that the peer's own attachment SUCCEEDS and carries the one
    // provenance that exists. The protections that mattered — identity binding
    // and session ownership — are exercised immediately below, untouched.
    const peerAttachment = (await callToolWithClient(codexClient, "session_attach_evidence", {
      caller: "codex",
      session_id: peerSession.session_id,
      label: "open-attachment-channel",
      content: "COMMAND: npm test\nEXIT_CODE: 0",
      response_format: "json",
    })) as {
      path?: string;
      meta?: { evidence_files?: { attached_by?: string; origin?: string; label?: string }[] };
    };
    const attachedRecord = peerAttachment.meta?.evidence_files?.find(
      (file) => file.label === "open-attachment-channel",
    );
    assert.ok(peerAttachment.path, "the attachment must be persisted and its path returned");
    assert.equal(
      attachedRecord?.attached_by,
      "codex",
      "the attachment must be attributed to the authenticated caller",
    );
    assert.equal(
      attachedRecord?.origin,
      "session_attach_evidence",
      "the persisted record must name the surface the artifact came through",
    );
    // Provenance is not stored on the record: it is computed when the
    // attachment is read. That it resolves to `caller_submitted_unverified`,
    // with no tier above it, is asserted in evidence-custody-smoke.
    let forgedAttachmentCallerRejection = "";
    try {
      await callToolWithClient(codexClient, "session_attach_evidence", {
        session_id: peerSession.session_id,
        label: "forged-caller-regression",
        content: "COMMAND: npm test\nEXIT_CODE: 0",
        caller: "claude",
        response_format: "json",
      });
    } catch (error) {
      forgedAttachmentCallerRejection = error instanceof Error ? error.message : String(error);
    }
    assert.match(forgedAttachmentCallerRejection, /identity_forgery_blocked/i);
    assert.doesNotMatch(
      forgedAttachmentCallerRejection,
      /no human (?:operator )?action is required/i,
      "an invalid explicit peer identity must expose the authentication failure instead of being misrouted",
    );
    const peerEvidenceArgs = {
      session_id: peerSession.session_id,
      draft: "Implementation candidate submitted by Codex.",
      evidence: "COMMAND: npm test\nEXIT_CODE: 0\nSTDOUT:\nTests 74 passed, 0 failed",
      caller: "codex",
      response_format: "json",
    };
    positiveCombinedPreflight = (await callToolWithClient(
      codexClient,
      "session_preflight_check",
      peerEvidenceArgs,
    )) as RuntimePreflightPayload;
    positiveAliasPreflight = (await callToolWithClient(
      codexClient,
      "session_truthfulness_preflight_check",
      peerEvidenceArgs,
    )) as RuntimePreflightPayload;

    const evidenceSentinel = "AUTONOMOUS_EVIDENCE_SENTINEL_4_5_11";
    const peerRoundStart = (await callToolWithClient(codexClient, "session_start_round", {
      session_id: peerSession.session_id,
      task: "Runtime peer preflight: completed implementation with 74 passed.",
      draft: "Implementation candidate submitted by Codex; npm test reports 74 passed.",
      evidence: `${evidenceSentinel}\nCOMMAND: npm test\nEXIT_CODE: 0\nSTDOUT:\nTests 74 passed, 0 failed`,
      caller: "codex",
      response_format: "json",
    })) as { session_id: string };
    const peerRoundState = await pollUntilDoneWithClient(codexClient, peerRoundStart.session_id);
    assert.equal(peerRoundState.outcome, "converged");
    const peerRoundMeta = (await callToolWithClient(codexClient, "session_read", {
      session_id: peerRoundStart.session_id,
      response_format: "json",
    })) as {
      active_caller_evidence_submission_id?: string;
      caller_evidence_submissions?: Array<{
        submission_id: string;
        submitted_by: string;
        attachment_paths: string[];
      }>;
      evidence_files?: Array<{
        path: string;
        attached_by?: string;
        origin?: string;
        sha256?: string;
      }>;
    };
    const activeSubmission = peerRoundMeta.caller_evidence_submissions?.find(
      (submission) =>
        submission.submission_id === peerRoundMeta.active_caller_evidence_submission_id,
    );
    assert.equal(activeSubmission?.submitted_by, "codex");
    assert.equal(activeSubmission?.attachment_paths.length, 1);
    const activeAttachment = peerRoundMeta.evidence_files?.find(
      (attachment) => attachment.path === activeSubmission?.attachment_paths[0],
    );
    assert.equal(activeAttachment?.attached_by, "codex");
    assert.equal(activeAttachment?.origin, "caller_submitted");
    assert.match(activeAttachment?.sha256 ?? "", /^[a-f0-9]{64}$/);
    const peerPrompt = fs.readFileSync(
      path.join(
        runtimeSmokeDataDir,
        "sessions",
        peerRoundStart.session_id,
        "agent-runs",
        "round-1-prompt.md",
      ),
      "utf8",
    );
    assert.ok(
      peerPrompt.includes(evidenceSentinel),
      "MCP starter must persist and transport autonomous Codex evidence to the reviewer prompt",
    );

    const operatorOwnerArgs = {
      session_id: negativePreflightSession.session_id,
      caller: "codex",
      task: "I triggered workflow deployment run_id=8842 and confirmed the remote deployment succeeded; npm run test reports 74 passed.",
      draft: "Implementation candidate and deployment closure submitted by Codex.",
      evidence: [
        "GitHub Actions workflow dispatch event: deployment run_id=8842; conclusion=success.",
        "COMMAND: npm run test",
        "EXIT_CODE: 0",
        "STDOUT:",
        "Tests 74 passed, 0 failed",
      ].join("\n"),
      response_format: "json",
    };
    for (const tool of [
      "session_preflight_check",
      "session_truthfulness_preflight_check",
    ] as const) {
      try {
        const payload = (await callToolWithClient(
          codexClient,
          tool,
          operatorOwnerArgs,
        )) as RuntimePreflightPayload;
        operatorOwnerAttempts.push({ tool, payload });
      } catch (error) {
        operatorOwnerAttempts.push({
          tool,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const reportSession = (await callToolWithClient(codexClient, "session_init", {
      task: "Runtime report mutation belongs to its authenticated petitioner.",
      caller: "codex",
      response_format: "json",
    })) as { session_id: string };
    const ownedReportPath = path.join(
      runtimeSmokeDataDir,
      "sessions",
      reportSession.session_id,
      "session-report.md",
    );
    assert.equal(fs.existsSync(ownedReportPath), false);
    await assert.rejects(
      () =>
        callTool("session_report", {
          session_id: reportSession.session_id,
          caller: "claude",
          response_format: "json",
        }),
      /session_owner_mismatch/,
      "a different token-verified peer must not write the petitioner's report",
    );
    assert.equal(
      fs.existsSync(ownedReportPath),
      false,
      "a refused report mutation must leave no report artifact",
    );
    const ownedReport = (await callToolWithClient(codexClient, "session_report", {
      session_id: reportSession.session_id,
      caller: "codex",
      response_format: "json",
    })) as { path?: string };
    assert.equal(ownedReport.path, "session-report.md");
    assert.equal(fs.existsSync(ownedReportPath), true);

    // crosrev-40: the persisted petitioner closes its own non-terminal
    // session as `aborted` with its own token; the schema refuses every
    // other outcome before the handler runs, and a different peer is
    // refused by the session owner ACL.
    const petitionerSession = (await callToolWithClient(codexClient, "session_init", {
      task: "Runtime petitioner closure: relator generation failed.",
      caller: "codex",
      response_format: "json",
    })) as { session_id: string };
    // @modelcontextprotocol/sdk 1.30.0 validates the input schema before the
    // handler and converts the resulting InvalidParams (-32602) McpError into
    // an isError tool result whose text carries that code; callToolWithClient
    // surfaces it as a thrown Error(text).
    let convergedSchemaRejection = "";
    try {
      await callToolWithClient(codexClient, "session_finalize", {
        session_id: petitionerSession.session_id,
        outcome: "converged",
        reason: "self-sealed verdict",
        caller: "codex",
        response_format: "json",
      });
    } catch (error) {
      convergedSchemaRejection = error instanceof Error ? error.message : String(error);
    }
    assert.match(
      convergedSchemaRejection,
      /^MCP error -32602: Input validation error: Invalid arguments for tool session_finalize/,
      "session_finalize(outcome=converged) must be refused as InvalidParams by the tool input schema",
    );
    assert.doesNotMatch(
      convergedSchemaRejection,
      /session_finalize_outcome_mismatch|session_owner|session_already_finalized/,
      "the converged refusal must come from input validation, before the handler and the store invariant",
    );
    const claudeTransport = new StdioClientTransport({
      ...runtimeSmokeTransportOptions,
      env: {
        ...runtimeSmokeTransportOptions.env,
        CROSS_REVIEW_CALLER_TOKEN: runtimeSmokeClaudeToken,
      },
    });
    const claudeClient = new Client({ name: "claude", version: "0.0.0" });
    let otherPeerFinalizeRejection = "";
    try {
      await claudeClient.connect(claudeTransport);
      try {
        await callToolWithClient(claudeClient, "session_finalize", {
          session_id: petitionerSession.session_id,
          outcome: "aborted",
          reason: "not my session",
          caller: "claude",
          response_format: "json",
        });
      } catch (error) {
        otherPeerFinalizeRejection = error instanceof Error ? error.message : String(error);
      }
    } finally {
      await claudeClient.close();
    }
    assert.match(
      otherPeerFinalizeRejection,
      /session_owner_mismatch/,
      "a token-verified peer that is not the persisted petitioner must not close the session",
    );
    const petitionerClosed = (await callToolWithClient(codexClient, "session_finalize", {
      session_id: petitionerSession.session_id,
      outcome: "aborted",
      reason: "relator_generation_failed",
      caller: "codex",
      response_format: "json",
    })) as { outcome?: string; outcome_reason?: string };
    assert.equal(petitionerClosed.outcome, "aborted");
    assert.equal(petitionerClosed.outcome_reason, "relator_generation_failed");
    const petitionerClosedState = (await callToolWithClient(codexClient, "session_poll", {
      session_id: petitionerSession.session_id,
      response_format: "json",
    })) as PollState & { needs_attention?: boolean };
    assert.equal(petitionerClosedState.outcome, "aborted");
    assert.equal(petitionerClosedState.needs_attention, false);
    const petitionerClosedEvents = (await callToolWithClient(codexClient, "session_events", {
      session_id: petitionerSession.session_id,
      response_format: "json",
    })) as { events?: Array<{ type: string }> };
    assert.ok(
      petitionerClosedEvents.events?.some((event) => event.type === "session.finalized"),
      "the petitioner's close must persist a session.finalized event",
    );
  } finally {
    await codexClient.close();
  }
  for (const [tool, payload] of [
    ["session_preflight_check", positiveCombinedPreflight],
    ["session_truthfulness_preflight_check", positiveAliasPreflight],
  ] as const) {
    assert.equal(payload.truthfulness_pass, true, `${tool}: peer evidence truthfulness must pass`);
    assert.equal(payload.evidence_pass, true, `${tool}: peer evidence admission must pass`);
    assert.equal(payload.pass, true, `${tool}: authenticated caller evidence must pass on its own`);
    assert.equal(
      payload.evidence?.result?.evidence_authority,
      "caller_submitted_unverified",
      `${tool}: peer evidence must remain explicitly unverified`,
    );
  }
  for (const attempt of operatorOwnerAttempts) {
    if (attempt.error) {
      assert.match(
        attempt.error,
        /session_owner_mismatch|caller[^\n]*(?:mismatch|forbidden)|(?:owner|authority)[^\n]*mismatch/i,
        `${attempt.tool}: rejecting a Codex client on an operator-owned session must report an authority mismatch`,
      );
      continue;
    }
    const payload = attempt.payload;
    assert.ok(payload, `${attempt.tool}: expected either a payload or an authority rejection`);
    // v07.00.00: the three assertions that once accompanied this one asked
    // whether the evidence had been promoted — `operator_grounded` on both
    // preflights and a count of operator-verified attachments. Neither the
    // tier nor the fields exist any more, so the single invariant that
    // survives is the one that always mattered: a caller's evidence carries
    // its own unverified provenance and inherits nothing from the session it
    // was submitted into.
    assert.equal(
      payload.evidence?.result?.evidence_authority,
      "caller_submitted_unverified",
      `${attempt.tool}: a caller must never inherit the session owner's evidence authority`,
    );
  }
  const markdownInitText = await callToolText("session_init", {
    caller: "claude",
    task: "Runtime smoke: verify session_init markdown response.",
    review_focus: "runtime/markdown-init",
    response_format: "markdown",
  });
  const sessionListResult = (await callTool("session_list", {
    caller: "claude",
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
    caller: "claude",
    task: "Runtime smoke: verify no-job cancellation is non-terminal.",
    review_focus: "runtime/cancel-no-job",
    response_format: "json",
  })) as { session_id: string };
  // v07.00.00: this asserted that the main client — which then held the
  // operator token — was refused as identity forgery for declaring a peer
  // caller. That client now holds claude's own token and declares claude, so
  // the premise is gone. Nothing unique is lost: the petitioner closing its
  // own session is asserted immediately below, and a DIFFERENT peer being
  // refused is asserted earlier against the codex client.
  const petitionerClosableSession = (await callTool("session_init", {
    caller: "claude",
    task: "Runtime smoke: the petitioner closes a session it opened.",
    review_focus: "runtime/petitioner-finalize",
    response_format: "json",
  })) as { session_id: string };
  const petitionerClosed = (await callTool("session_finalize", {
    caller: "claude",
    session_id: petitionerClosableSession.session_id,
    outcome: "aborted",
    reason: "petitioner_closed",
    response_format: "json",
  })) as { outcome?: string; outcome_reason?: string };
  assert.equal(petitionerClosed.outcome, "aborted");
  assert.equal(petitionerClosed.outcome_reason, "petitioner_closed");
  const noJobCancelResult = (await callTool("session_cancel_job", {
    caller: "claude",
    session_id: noJobSession.session_id,
    reason: "runtime_smoke_no_active_job",
    response_format: "json",
  })) as { requested: boolean; reason?: string; matched_jobs?: unknown[] };
  const noJobCancelState = (await callTool("session_poll", {
    session_id: noJobSession.session_id,
    response_format: "json",
  })) as PollState;
  const roundStart = (await callTool("session_start_round", {
    caller: "claude",
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
    caller: "claude",
    response_format: "json",
  });
  const unanimousStart = (await callTool("session_start_unanimous", {
    caller: "claude",
    task: "Runtime smoke: verify async unanimity flow.",
    review_focus: "runtime/unanimous",
    lead_peer: "codex",
    peers: ["claude"],
    max_rounds: 2,
    response_format: "json",
  })) as { session_id: string };
  const unanimousState = await pollUntilDone(unanimousStart.session_id);
  const cancelStart = (await callTool("session_start_round", {
    caller: "claude",
    task: "Runtime smoke: verify cancellation tool.",
    draft: "FORCE_CANCEL_SLOW",
    peers: ["codex"],
    response_format: "json",
  })) as { session_id: string; job: { job_id: string } };
  const cancelResult = await callTool("session_cancel_job", {
    caller: "claude",
    session_id: cancelStart.session_id,
    job_id: cancelStart.job.job_id,
    reason: "runtime_smoke_cancel",
    response_format: "json",
  });
  const cancelState = await pollUntilDone(cancelStart.session_id);
  const metrics = await callTool("session_metrics", { response_format: "json" });
  const recovery = await callTool("session_recover_interrupted", {
    caller: "claude",
    response_format: "json",
  });
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
        negativeCombinedPreflight,
        negativeAliasPreflight,
        positiveCombinedPreflight,
        positiveAliasPreflight,
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
