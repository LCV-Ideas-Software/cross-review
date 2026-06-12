import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

{
  const prettierIgnore = fs.readFileSync(path.join(process.cwd(), ".prettierignore"), "utf8");
  const ignoredPatterns = prettierIgnore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const forbidden of ["README.md", "**/README.md", "src", "src/**", "scripts", "scripts/**"]) {
    assert.ok(
      !ignoredPatterns.includes(forbidden),
      `hard-gate / no-mask: .prettierignore must not hide ${forbidden} from Prettier coverage.`,
    );
  }

  const eslintConfig = fs.readFileSync(path.join(process.cwd(), "eslint.config.js"), "utf8");
  assert.ok(
    !/"@typescript-eslint\/no-explicit-any"\s*:\s*(?:["']off["']|\[\s*["']off["'])/.test(
      eslintConfig,
    ),
    "hard-gate / no-mask: eslint.config.js must not disable @typescript-eslint/no-explicit-any globally.",
  );
  assert.ok(
    !/"@typescript-eslint\/no-unused-vars"\s*:\s*(?:["']off["']|\[\s*["']off["'])/.test(
      eslintConfig,
    ),
    "hard-gate / no-mask: eslint.config.js must not disable @typescript-eslint/no-unused-vars globally.",
  );
  assert.ok(
    /"@typescript-eslint\/no-unused-vars"\s*:\s*\[\s*["']error["']/.test(eslintConfig),
    "hard-gate / no-mask: @typescript-eslint/no-unused-vars must remain an error.",
  );
  console.log("[source-contract-smoke] hard_gate_no_linter_formatter_masking_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  const sessionListBlock = serverSrc.match(
    /"session_list"[\s\S]{0,2500}?async \(\{ limit, offset, outcome_filter, detail, response_format \}\)/,
  );
  assert.ok(
    sessionListBlock,
    "v4.2.0 / session_list: handler must expose bounded pagination inputs.",
  );
  assert.ok(
    serverSrc.includes("const SESSION_LIST_DEFAULT_LIMIT = 25"),
    "v4.2.0 / session_list: default limit must stay bounded for stdio transports.",
  );
  assert.ok(
    serverSrc.includes("const SESSION_LIST_MAX_LIMIT = 100"),
    "v4.2.0 / session_list: max limit must cap oversized pages.",
  );
  assert.ok(
    serverSrc.includes("SessionListOutcomeFilterSchema"),
    "v4.2.0 / session_list: outcome_filter schema must remain wired.",
  );
  assert.ok(
    serverSrc.includes("summarizeSessionForList"),
    "v4.2.0 / session_list: default list output must stay summary-based.",
  );
  assert.ok(
    serverSrc.includes("pagination: {"),
    "v4.2.0 / session_list: response must surface pagination metadata.",
  );
  const runtimeSmokeSrc = fs.readFileSync(
    path.join(process.cwd(), "scripts", "runtime-smoke.ts"),
    "utf8",
  );
  assert.ok(
    runtimeSmokeSrc.includes('callTool("session_list"'),
    "v4.2.0 / session_list: runtime-smoke must exercise bounded session_list.",
  );
  console.log("[source-contract-smoke] session_list_bounded_pagination_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  const cancelJobBlock = serverSrc.match(
    /"session_cancel_job"[\s\S]{0,2600}?registerTool\(\s*"session_recover_interrupted"/,
  );
  assert.ok(
    cancelJobBlock,
    "v4.2.0 / session_cancel_job: smoke must find the cancel-job handler block.",
  );
  const cancelJobSrc = cancelJobBlock?.[0] ?? "";
  assert.ok(
    /if \(!jobs\.length\) \{[\s\S]{0,500}?requested:\s*false[\s\S]{0,500}?no_running_job_matched/.test(
      cancelJobSrc,
    ),
    "v4.2.0 / session_cancel_job: no active job must return requested=false/no_running_job_matched.",
  );
  assert.ok(
    !/if \(!jobs\.length\) \{[\s\S]{0,300}?markCancelled/.test(cancelJobSrc),
    "v4.2.0 / session_cancel_job: no active job must not terminal-abort the whole session.",
  );

  const runtimeSmokeSrc = fs.readFileSync(
    path.join(process.cwd(), "scripts", "runtime-smoke.ts"),
    "utf8",
  );
  assert.ok(
    runtimeSmokeSrc.includes("runtime_smoke_no_active_job"),
    "v4.2.0 / session_cancel_job: runtime-smoke must exercise the no-active-job path.",
  );
  assert.ok(
    /assert\.equal\(\s*noJobCancelState\.outcome,\s*undefined/.test(runtimeSmokeSrc),
    "v4.2.0 / session_cancel_job: runtime-smoke must assert no-job cancellation stays non-terminal.",
  );
  console.log("[source-contract-smoke] session_cancel_job_no_active_job_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  for (const toolName of [
    "session_cancel_job",
    "contest_verdict",
    "regenerate_caller_tokens",
    "escalate_to_operator",
    "session_finalize",
  ]) {
    const toolStart = serverSrc.indexOf(`registerTool(\n    "${toolName}"`);
    const nextToolStart = serverSrc.indexOf("registerTool(", toolStart + toolName.length + 2);
    const handlerBlock =
      toolStart >= 0
        ? serverSrc.slice(toolStart, nextToolStart >= 0 ? nextToolStart : serverSrc.length)
        : undefined;
    assert.ok(handlerBlock, `v4.3.2 / identity: smoke must find ${toolName} handler block.`);
    assert.ok(
      /caller:\s*CallerSchema\.default\("operator"\)/.test(handlerBlock ?? ""),
      `v4.3.2 / identity: ${toolName} must expose caller with operator default.`,
    );
    assert.ok(
      /verifyToolCallerIdentity\(\s*runtime,\s*"[^"]+",\s*caller,\s*server\.server\.getClientVersion\(\)/.test(
        handlerBlock ?? "",
      ),
      `v4.3.2 / identity: ${toolName} must verify caller identity before side effects.`,
    );
  }
  const toolRegistrations = [...serverSrc.matchAll(/registerTool\(\n\s+"([^"]+)"/g)];
  const mutatingIdentityFailures: string[] = [];
  for (let index = 0; index < toolRegistrations.length; index += 1) {
    const match = toolRegistrations[index];
    assert.ok(match, "tool registration match should exist");
    const toolName = match[1];
    assert.ok(toolName, "tool registration name should exist");
    const nextMatch = toolRegistrations[index + 1];
    const handlerBlock = serverSrc.slice(match.index ?? 0, nextMatch?.index ?? serverSrc.length);
    if (!/readOnlyHint:\s*false/.test(handlerBlock)) continue;
    const hasCallerSchema = /caller:\s*CallerSchema\.default\("operator"\)/.test(handlerBlock);
    const hasIdentityVerification =
      /verifyToolCallerIdentity\(\s*runtime,\s*"[^"]+",\s*(?:caller|input\.caller),\s*server\.server\.getClientVersion\(\)/.test(
        handlerBlock,
      );
    if (!hasCallerSchema || !hasIdentityVerification) {
      mutatingIdentityFailures.push(toolName);
    }
  }
  assert.deepEqual(
    mutatingIdentityFailures,
    [],
    `v4.4.1 / identity: every mutating tool must expose and verify caller identity.`,
  );
  console.log("[source-contract-smoke] side_effect_tool_identity_gate_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  assert.ok(
    !/tokens:\s*generated\.map/.test(serverSrc),
    "v4.3.2 / caller_tokens: regenerate_caller_tokens must not return plaintext generated.map in the MCP response.",
  );
  assert.ok(
    /token_fingerprints/.test(serverSrc),
    "v4.3.2 / caller_tokens: regenerate_caller_tokens response must expose token fingerprints instead of secrets.",
  );
  assert.ok(
    !/Returns the new map so the operator can copy/.test(serverSrc),
    "v4.3.2 / caller_tokens: tool description must not instruct hosts to expose copied plaintext tokens via MCP response.",
  );
  console.log("[source-contract-smoke] regenerate_caller_tokens_no_plaintext_response_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  assert.ok(
    /process\.on\("SIGTERM"/.test(serverSrc) && /process\.on\("SIGINT"/.test(serverSrc),
    "v4.3.3 / shutdown: server main must install SIGTERM and SIGINT handlers.",
  );
  assert.ok(
    /flushPendingEvents\(\)/.test(serverSrc) &&
      /eventLog\.flush\(\)/.test(serverSrc) &&
      /setTimeout\(/.test(serverSrc),
    "v4.3.3 / shutdown: signal handlers must flush pending store/log events with a bounded timeout.",
  );
  console.log("[source-contract-smoke] signal_flush_handlers_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  const storeSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "session-store.ts"),
    "utf8",
  );
  const orchSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "orchestrator.ts"),
    "utf8",
  );
  const configSrc = fs.readFileSync(path.join(process.cwd(), "src", "core", "config.ts"), "utf8");
  const fileConfigSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "file-config.ts"),
    "utf8",
  );
  const cacheManifestSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "cache-manifest.ts"),
    "utf8",
  );
  const retrySrc = fs.readFileSync(path.join(process.cwd(), "src", "peers", "retry.ts"), "utf8");
  const openaiSrc = fs.readFileSync(path.join(process.cwd(), "src", "peers", "openai.ts"), "utf8");
  const grokSrc = fs.readFileSync(path.join(process.cwd(), "src", "peers", "grok.ts"), "utf8");
  const perplexitySrc = fs.readFileSync(
    path.join(process.cwd(), "src", "peers", "perplexity.ts"),
    "utf8",
  );
  const dashboardSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "dashboard", "server.ts"),
    "utf8",
  );
  const typesSrc = fs.readFileSync(path.join(process.cwd(), "src", "core", "types.ts"), "utf8");

  assert.ok(
    /evidenceAttachmentCache/.test(storeSrc) &&
      /catch\s*\{\s*\n\s*return \[\];\s*\n\s*\}/.test(storeSrc),
    "v4.4.1 / evidence: readEvidenceAttachments should cache reads and fail closed to no attachments.",
  );
  assert.ok(
    /Session cancellation was requested before this round started\.[\s\S]{0,400}?savePeerFailure/.test(
      orchSrc,
    ),
    "v4.4.1 / cancellation: pre-call cancellation branch must persist per-peer failure artifacts.",
  );
  assert.ok(
    !/const summary = safePromptText\(/.test(orchSrc) &&
      !/const existing = byId\.get/.test(storeSrc),
    "v4.4.1 / cleanup: shadowing in prior-round summaries and evidence checklist should stay removed.",
  );
  assert.ok(
    /must be a non-negative number; ignoring this value/.test(configSrc) &&
      /Number\.isFinite\(rawCap\)\s*&&\s*rawCap\s*>\s*0/.test(configSrc) &&
      !/Default 3 maps to 12 rounds/.test(configSrc),
    "v4.4.1 / config: numeric env parsing and circular rotation docs should reject stale negative/stale-count behavior.",
  );
  assert.ok(
    /const PeerSchema = z\.enum\(PEERS\)/.test(fileConfigSrc) &&
      /peer:\s*PeerSchema\.optional\(\)/.test(fileConfigSrc) &&
      /consensus_peers:\s*z\.array\(PeerSchema\)\.optional\(\)/.test(fileConfigSrc),
    "v4.4.1 / file-config: evidence judge peer fields must be roster enums, not arbitrary strings.",
  );
  assert.ok(
    /SESSION_ID_PATTERN/.test(cacheManifestSrc) &&
      /invalid session_id for cache manifest/.test(cacheManifestSrc) &&
      /flag:\s*"wx"/.test(cacheManifestSrc),
    "v4.4.1 / cache-manifest: manifest paths should validate UUIDs and tmp writes should use wx.",
  );
  assert.ok(
    /enabledPeers\?: readonly PeerId\[\]/.test(serverSrc) &&
      /suppliedPeersMatchEnabled/.test(serverSrc) &&
      /peers:\s*z\s*\n\s*\.array\(PeerSchema\)\s*\n\s*\.min\(0\)/.test(serverSrc),
    "v4.4.1 / peer-lock: no-op full-panel peer inputs should not emit notices, and empty arrays should reach the lock.",
  );
  assert.ok(
    /function attachPeerFailure/.test(retrySrc) && /peerFailure/.test(retrySrc),
    "v4.4.1 / retry: exhausted retries should preserve the classified PeerFailure metadata.",
  );
  assert.ok(
    !/inputTokens\s*>\s*cached/.test(openaiSrc) && !/inputTokens\s*>\s*cached/.test(grokSrc),
    "v4.4.1 / cache-cost: OpenAI/Grok must not infer cache_write_tokens from input minus cached tokens.",
  );
  assert.ok(
    /probe_mode:\s*"auth_only" \| "live"/.test(typesSrc) &&
      /CROSS_REVIEW_PERPLEXITY_PROBE_MODE/.test(configSrc) &&
      /probe_mode === "auth_only"/.test(perplexitySrc),
    "v4.4.1 / perplexity: probe defaults must avoid tokenized Sonar calls.",
  );
  assert.ok(
    /request\.method !== "GET" && request\.method !== "POST"/.test(dashboardSrc) &&
      /if \(request\.method === "POST"\)[\s\S]{0,120}?saveReport/.test(dashboardSrc),
    "v4.4.1 / dashboard: GET report route should not persist files; only POST may save.",
  );
  assert.ok(
    /export interface RuntimeEventDataByType/.test(typesSrc) &&
      /export type RuntimeEventData</.test(typesSrc) &&
      /export interface RuntimeEvent<T extends RuntimeEventType = RuntimeEventType>/.test(typesSrc),
    "v4.4.1 / runtime-events: RuntimeEvent data should have a typed event-data map.",
  );
  console.log("[source-contract-smoke] v4_4_1_total_sweep_guard_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  assert.ok(
    serverSrc.includes("function sessionInitMarkdown"),
    "v4.2.0 / session_init: markdown renderer must exist.",
  );
  assert.ok(
    /response_format === "markdown"\s*\?\s*textResult\(sessionInitMarkdown\(meta\), "markdown"\)/.test(
      serverSrc,
    ),
    'v4.2.0 / session_init: response_format="markdown" must not fall through to JSON.stringify.',
  );
  const runtimeSmokeSrc = fs.readFileSync(
    path.join(process.cwd(), "scripts", "runtime-smoke.ts"),
    "utf8",
  );
  assert.ok(
    runtimeSmokeSrc.includes('callToolText("session_init"'),
    "v4.2.0 / session_init: runtime-smoke must exercise markdown session_init.",
  );
  console.log("[source-contract-smoke] session_init_markdown_response_test: PASS");
}

{
  const smokeSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "smoke.ts"), "utf8");
  const sourceStylePins = (
    smokeSrc.match(
      /\.test\([^)\r\n]*(?:Src|Source|Config|Text|Code|Compiled|Dist|Block|Window|Harness|Instruction|Smoke|Report|Json|Markdown)/g,
    ) ?? []
  ).length;
  assert.ok(
    sourceStylePins <= 144,
    `T2#10 / source-contract split: scripts/smoke.ts has ${sourceStylePins} source-style regex pins; keep new static contracts in scripts/source-contract-smoke.ts.`,
  );
  console.log("[source-contract-smoke] smoke_source_contract_budget_test: PASS");
}
