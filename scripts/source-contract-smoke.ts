import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sourceMatches(source: string, pattern: RegExp): boolean {
  return pattern.test(source);
}

function sourceOmits(source: string, pattern: RegExp): boolean {
  return !sourceMatches(source, pattern);
}

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
    /"session_cancel_job"[\s\S]{0,9000}?registerTool\(\s*"session_recover_interrupted"/,
  );
  assert.ok(
    cancelJobBlock,
    "v4.2.0 / session_cancel_job: smoke must find the cancel-job handler block.",
  );
  const cancelJobSrc = cancelJobBlock?.[0] ?? "";
  assert.ok(
    /if \(!jobs\.length && !durableExecutionActive\) \{[\s\S]{0,300}?cancellationNoopPayload/.test(
      cancelJobSrc,
    ) && serverSrc.includes('"job_already_terminal"'),
    "v4.5.16 / session_cancel_job: settled work must return the compact terminal/no-active contract.",
  );
  assert.ok(
    !/if \(!jobs\.length && !durableExecutionActive\) \{[\s\S]{0,300}?markCancelled/.test(
      cancelJobSrc,
    ),
    "v4.5.4 / session_cancel_job: no local or durable active job must not terminal-abort the whole session.",
  );
  assert.ok(
    cancelJobSrc.includes("durableSessionExecutionActive(session)") &&
      cancelJobSrc.includes("durable_execution: durableJob") &&
      cancelJobSrc.includes("require_active_execution: true") &&
      cancelJobSrc.includes("readBackgroundJobStatuses(session_id)") &&
      cancelJobSrc.includes("mergeObservedJobs"),
    "v4.5.4 / session_cancel_job: cross-process execution must be detected and surfaced durably.",
  );

  const sessionStoreSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "session-store.ts"),
    "utf8",
  );
  assert.ok(
    serverSrc.includes("writeBackgroundJobStatus(job)") &&
      sessionStoreSrc.includes("readBackgroundJobStatuses(sessionId") &&
      sessionStoreSrc.includes('path.join(this.sessionDir(sessionId), "background-jobs")') &&
      sessionStoreSrc.includes("background_job_recovered_after_restart"),
    "v4.5.16 / background jobs: job status must survive a sibling host or runtime restart.",
  );
  assert.ok(
    sessionStoreSrc.includes("background_job_already_running") &&
      serverSrc.includes("unsettledTerminalJob") &&
      serverSrc.includes('markCancelled(session_id, "session_cancelled")') &&
      serverSrc.includes("remained active after startup cleanup"),
    "v4.5.16 / background jobs: concurrent owners and failed settlements must remain recoverable.",
  );
  assert.ok(
    serverSrc.includes('SessionPollDetailSchema = z.enum(["summary", "full"])') &&
      serverSrc.includes(
        'detail === "full" ? (session.in_flight ?? null) : inFlightSummary(session)',
      ) &&
      serverSrc.includes("latest_completed_round_number") &&
      serverSrc.includes(
        'jobs: detail === "full" ? localJobs : jobs.map((job) => terminalJobSummary(job))',
      ),
    "v4.5.16 / session_poll: default polling must remain compact and distinguish active from completed rounds.",
  );
  assert.ok(
    sessionStoreSrc.includes("expectedPostTerminalAuditEvents.has(event.type)") &&
      sessionStoreSrc.includes('"session.identity_verified"'),
    "v4.5.16 / terminal audit: only explicitly allowlisted auth events may suppress an expected immutable-chain append.",
  );
  const ciSrc = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(
    ciSrc.includes("run: npm test"),
    "v4.5.16 / CI: the complete regression suite, including the focused runtime regression, must pass before tagging.",
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
    runtimeSmokeSrc.includes("noJobCancelState.outcome") &&
      runtimeSmokeSrc.includes("no-job cancellation must not terminal-abort"),
    "v4.2.0 / session_cancel_job: runtime-smoke must assert no-job cancellation stays non-terminal.",
  );
  console.log("[source-contract-smoke] session_cancel_job_no_active_job_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  for (const toolName of [
    "session_cancel_job",
    "session_evidence_judge_pass",
    "session_evidence_judge_consensus_pass",
    "contest_verdict",
    "session_finalize",
  ]) {
    const toolStart = serverSrc.indexOf(`registerTool(\n    "${toolName}"`);
    const nextToolStart = serverSrc.indexOf("registerTool(", toolStart + toolName.length + 2);
    const handlerBlock =
      toolStart >= 0
        ? serverSrc.slice(toolStart, nextToolStart >= 0 ? nextToolStart : serverSrc.length)
        : undefined;
    assert.ok(handlerBlock, `v4.3.2 / identity: smoke must find ${toolName} handler block.`);
    // v07.00.00: the inverse contract. `caller` used to default to "operator",
    // which made a principal with no channel to this server the implicit caller
    // of every tool. It is now declared by the agent actually calling, and the
    // default must never come back.
    assert.ok(
      /caller:\s*CallerSchema,/.test(handlerBlock ?? ""),
      `v07.00.00 / identity: ${toolName} must require an explicit peer caller.`,
    );
    assert.ok(
      !/CallerSchema\.default\(/.test(handlerBlock ?? ""),
      `v07.00.00 / identity: ${toolName} must not default \`caller\` to any identity.`,
    );
    assert.ok(
      /verify(?:OperatorToolCallerIdentity|ToolCallerIdentity|SessionMutationAuthority)\(\s*runtime,\s*"[^"]+",\s*caller,\s*server\.server\.getClientVersion\(\)/.test(
        handlerBlock ?? "",
      ),
      `v4.3.2 / identity: ${toolName} must verify caller identity before side effects.`,
    );
    if (toolName.startsWith("session_evidence_judge_")) {
      // v07.00.00: this used to demand operator authority. The gate protected
      // nothing a judge pass actually needs: what keeps a judgment honest is
      // that a peer may never rule on its own evidence ask, and that the
      // consensus pass needs two distinct judges. Both are enforced in the
      // orchestrator, independently of who called the tool, so the contract
      // now pins those instead of an identity nobody could present.
      assert.ok(
        !/verifyOperatorToolCallerIdentity/.test(handlerBlock ?? ""),
        `v07.00.00 / identity: ${toolName} must not demand operator authority.`,
      );
    }
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
    // v07.00.00: `caller` no longer carries a default, so the shape to detect
    // is the bare schema. A mutating tool must still expose the field.
    const hasCallerSchema = /caller:\s*CallerSchema,/.test(handlerBlock);
    const hasIdentityVerification =
      /verify(?:OperatorToolCallerIdentity|ToolCallerIdentity|SessionMutationAuthority)\(\s*runtime,\s*"[^"]+",\s*(?:caller|input\.caller),\s*server\.server\.getClientVersion\(\)/.test(
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
  // v07.00.00: `regenerate_caller_tokens` is gone, so the three assertions that
  // policed how it exposed secrets have nothing to police. The property they
  // protected — no plaintext token ever leaves through an MCP response — is
  // now structural: no tool reads or returns the token map at all.
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  assert.ok(
    !serverSrc.includes("regenerate_caller_tokens"),
    "v07.00.00 / caller_tokens: the token-rotation tool must not come back; rotation is a boot-time act on disk, outside MCP.",
  );
  assert.ok(
    !/tokens:\s*generated\.map/.test(serverSrc),
    "v07.00.00 / caller_tokens: no MCP response may carry the plaintext token map.",
  );
  console.log("[source-contract-smoke] no_token_rotation_over_mcp_test: PASS");
}

{
  // v07.00.00: a session persisted before the operator identity was retired can
  // still name "operator" as its petitioner. Such a record has no peer owner,
  // so BOTH round entry points must refuse it rather than let the acting peer
  // adopt it — adoption would hand any peer another principal's session, the
  // privilege confusion the owner check exists to prevent.
  const orchestratorSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "orchestrator.ts"),
    "utf8",
  );
  const refusals = orchestratorSrc.match(/session_owner_unverified/g) ?? [];
  assert.ok(
    refusals.length >= 2,
    "v07.00.00 / authority: askPeers and runUntilUnanimous must both refuse a session whose persisted petitioner is not a peer",
  );
  // Strip line comments first. The sentence that records the removal names
  // what was removed, and a gate that cannot tell an obituary from an offer
  // fires on its own explanation — this one did, on the first run.
  const orchestratorCode = orchestratorSrc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !/callerForLottery === "operator"/.test(orchestratorCode) &&
      !/effectivePetitioner === "operator"/.test(orchestratorCode),
    "v07.00.00 / authority: no auto-recusal branch may exempt the retired identity",
  );
  console.log("[source-contract-smoke] retired_identity_has_no_authority_branch_test: PASS");
}

{
  // v07.00.00 (PR #300 review, Codex P1): the two ACTIVE evidence-judge tools
  // spend the session's budget on paid provider calls and can move checklist
  // items to `addressed`. They were gated on identity alone, so any peer
  // holding a valid caller token could drive ANOTHER petitioner's session:
  // supply an arbitrary draft, bill that petitioner for the judge calls, and
  // change their unresolved-item state. Identity answers "who are you"; only
  // the owner gate answers "is this yours".
  //
  // Sliced per handler rather than matched over the whole file, because the
  // file legitimately contains both helpers and a file-wide search cannot tell
  // which tool each call belongs to.
  const judgeServerSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "mcp", "server.ts"),
    "utf8",
  );
  for (const tool of ["session_evidence_judge_pass", "session_evidence_judge_consensus_pass"]) {
    const start = judgeServerSrc.indexOf(`registerTool(\n    "${tool}"`);
    assert.ok(start >= 0, `v07.00.00 / judge authority: ${tool} must be a registered tool`);
    const nextTool = judgeServerSrc.indexOf("\n  registerTool(", start + 1);
    const handler = judgeServerSrc.slice(start, nextTool === -1 ? undefined : nextTool);
    assert.ok(
      handler.includes(`verifySessionMutationAuthority(\n        runtime,\n        "${tool}"`),
      `v07.00.00 / judge authority: ${tool} must gate on the persisted petitioner, not identity alone — it spends that petitioner's budget and mutates their checklist`,
    );
    assert.ok(
      !handler.includes(`verifyToolCallerIdentity(\n        runtime,\n        "${tool}"`),
      `v07.00.00 / judge authority: ${tool} must not fall back to the identity-only check`,
    );
  }
  console.log("[source-contract-smoke] active_judge_requires_session_owner_test: PASS");
}

{
  // v07.00.00 (PR #300 review round 2, Codex P1): `session_attach_evidence`
  // was opened to peers in this release, which was right — the operator gate
  // it replaced named a principal with no channel. What went with it by
  // accident was the OWNER gate. Attachments are folded back into that
  // session's preflight corpora and reviewer prompts by
  // readEvidenceAttachments, so identity alone let any token-holder that
  // learned an open session_id — `session_list` returns them all — contaminate
  // another petitioner's review or push it into a failing preflight.
  //
  // The tool stays open to peers. It is closed to peers acting on a session
  // they do not own, and the description must say which of those two it is.
  const attachServerSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "mcp", "server.ts"),
    "utf8",
  );
  const attachStart = attachServerSrc.indexOf('registerTool(\n    "session_attach_evidence"');
  assert.ok(attachStart >= 0, "v07.00.00 / attach authority: the tool must be registered");
  const attachEnd = attachServerSrc.indexOf("\n  registerTool(", attachStart + 1);
  const attachHandler = attachServerSrc.slice(
    attachStart,
    attachEnd === -1 ? undefined : attachEnd,
  );
  assert.ok(
    attachHandler.includes(
      'verifySessionMutationAuthority(\n        runtime,\n        "session_attach_evidence"',
    ),
    "v07.00.00 / attach authority: session_attach_evidence must gate on the persisted petitioner — its artifacts re-enter that session's preflight corpora and reviewer prompts",
  );
  assert.ok(
    !attachHandler.includes(
      'verifyToolCallerIdentity(\n        runtime,\n        "session_attach_evidence"',
    ),
    "v07.00.00 / attach authority: session_attach_evidence must not fall back to the identity-only check",
  );
  assert.ok(
    !/Any authenticated peer may call it/i.test(attachHandler),
    "v07.00.00 / attach authority: the description must not promise any authenticated peer may call it — the gate is petitioner-scoped",
  );
  console.log("[source-contract-smoke] attach_evidence_requires_session_owner_test: PASS");
}

{
  // v07.00.00 (PR #300 review round 4, Codex P2): `probe_peers` declared
  // `caller` and never checked it. With CROSS_REVIEW_REQUIRE_TOKEN=true, or a
  // token belonging to a different peer, any enum-valid caller still reached
  // probeAll() and spent six outbound provider probes — one of them the
  // billable Perplexity live probe. A tool that declares an identity and
  // spends the operator's provider quota on it has to verify it.
  //
  // What this pins is the RULE, not the one site: every tool that declares
  // `caller` verifies it, with exactly two deliberate exceptions. Those two
  // are the discovery reads a host calls to learn whether the token gate is
  // armed and where host-tokens.json lives — precisely when it does not yet
  // hold a token — and neither touches session data, a provider, or money.
  // A third name joining that list fails this test.
  const callerGateSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "mcp", "server.ts"),
    "utf8",
  );
  const DISCOVERY_EXCEPTIONS = ["runtime_capabilities", "server_info"];
  const registrations = callerGateSrc.split('registerTool(\n    "').slice(1);
  assert.ok(
    registrations.length >= 25,
    `v07.00.00 / caller verification: the registration split found only ${registrations.length} tools, so the source shape changed and this contract is measuring nothing`,
  );
  // Both halves of a registration can be written inline OR referenced by name,
  // and two tools already use the named form (`savedSessionPreflightSchema` /
  // `savedSessionPreflightHandler`). A screen that reads only inline text
  // skips those silently: it would keep reporting the exception list as
  // unchanged while a third unverified tool sat outside the rule entirely.
  // Both are therefore resolved by identifier, and an identifier that cannot
  // be resolved fails loudly instead of passing. Resolving the handler BY NAME
  // rather than searching the whole file also matters in the other direction:
  // a file-wide search would credit every tool with the first verify call it
  // found anywhere.
  const bodyOfConst = (identifier: string, what: string): string => {
    const declaration = `const ${identifier} =`;
    const at = callerGateSrc.indexOf(declaration);
    assert.ok(
      at >= 0,
      `v07.00.00 / caller verification: ${what} '${identifier}' could not be resolved to a declaration, so this contract cannot see what it contains`,
    );
    const next = callerGateSrc.indexOf("\n  const ", at + 1);
    const stop = callerGateSrc.indexOf("\n  registerTool(", at + 1);
    const end = Math.min(
      next === -1 ? callerGateSrc.length : next,
      stop === -1 ? callerGateSrc.length : stop,
    );
    return callerGateSrc.slice(at, end);
  };
  const unverified: string[] = [];
  for (const registration of registrations) {
    const name = registration.slice(0, registration.indexOf('"'));
    const handlerAt = registration.indexOf("async (");
    const schemaSection = handlerAt > 0 ? registration.slice(0, handlerAt) : registration;
    const namedSchema = /inputSchema:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(schemaSection);
    const schema =
      namedSchema && namedSchema[1] ? bodyOfConst(namedSchema[1], "inputSchema") : schemaSection;
    let handler = handlerAt > 0 ? registration.slice(handlerAt, handlerAt + 4000) : "";
    if (handlerAt < 0) {
      const namedHandler = /\n\s*([A-Za-z_$][\w$]*)\(\s*"/.exec(registration);
      handler = namedHandler && namedHandler[1] ? bodyOfConst(namedHandler[1], "handler") : "";
    }
    if (!schema.includes("caller: CallerSchema")) continue;
    if (
      handler.includes("verifyToolCallerIdentity(") ||
      handler.includes("verifySessionMutationAuthority(")
    ) {
      continue;
    }
    unverified.push(name);
  }
  assert.deepEqual(
    unverified.sort(),
    DISCOVERY_EXCEPTIONS,
    `v07.00.00 / caller verification: a tool that declares 'caller' must verify it, except the two discovery reads called before a token exists; unverified=[${unverified.join(", ")}]`,
  );
  const probeStart = callerGateSrc.indexOf('registerTool(\n    "probe_peers"');
  assert.ok(probeStart >= 0, "v07.00.00 / caller verification: probe_peers must be registered");
  const probeEnd = callerGateSrc.indexOf("\n  registerTool(", probeStart + 1);
  const probeHandler = callerGateSrc.slice(probeStart, probeEnd === -1 ? undefined : probeEnd);
  assert.ok(
    probeHandler.includes('verifyToolCallerIdentity(runtime, "probe_peers", caller'),
    "v07.00.00 / caller verification: probe_peers spends provider quota on the declared caller, so it must verify it before probing",
  );
  console.log("[source-contract-smoke] probe_peers_verifies_caller_test: PASS");
}

{
  // v07.00.00 (PR #300 review round 5, Codex P2): the v2 -> v7 token migration
  // truncated the live credential record to zero and wrote its replacement
  // into the same descriptor. host-tokens.json is the ONLY credential record,
  // so a disk-full error, a transient I/O failure or a power loss between the
  // truncate and the fsync left every peer token unverifiable — including the
  // owner-scoped tools that would be used to recover. The replacement is now
  // written beside it and swapped in.
  //
  // Behavioural coverage of a power loss is not reachable from a test, so what
  // is pinned is the structure that makes the window impossible: no in-place
  // truncation of the credential file, and a swap that fsyncs before it
  // renames.
  const tokensSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "caller-tokens.ts"),
    "utf8",
  );
  assert.ok(
    !tokensSrc.includes("ftruncateSync"),
    "v07.00.00 / token durability: the credential record must never be truncated in place — write a replacement beside it and swap it in",
  );
  const swapStart = tokensSrc.indexOf("function replaceTokensFileAtomically");
  assert.ok(
    swapStart >= 0,
    "v07.00.00 / token durability: the atomic replacement helper must exist",
  );
  const swapEnd = tokensSrc.indexOf("\nfunction ", swapStart + 1);
  const swap = tokensSrc.slice(swapStart, swapEnd === -1 ? undefined : swapEnd);
  const fsyncAt = swap.indexOf("fsyncSync");
  const renameAt = swap.indexOf("renameSync");
  assert.ok(
    fsyncAt >= 0 && renameAt >= 0 && fsyncAt < renameAt,
    "v07.00.00 / token durability: the replacement must be fsynced BEFORE it is renamed into place, or the swap trusts the page cache",
  );
  assert.ok(
    swap.includes('"wx"') && swap.includes("0o600"),
    "v07.00.00 / token durability: the temporary must refuse to clobber and must be created 0600, never briefly world-readable",
  );
  // Round 6: 0600 is not enough on Windows, where mode bits do not override
  // inherited NTFS entries — this module says so itself, which is why
  // hardenTokensFilePermissions exists. Renaming an un-hardened temp over the
  // live record silently hands a protected file back to whatever the parent
  // directory inherits, so the hardening must happen BEFORE the rename and a
  // failure to harden must refuse the swap rather than proceed.
  const hardenAt = swap.indexOf("hardenTokensFilePermissions(");
  assert.ok(
    hardenAt >= 0 && hardenAt < renameAt,
    "v07.00.00 / token durability: the replacement must be permission-hardened BEFORE it is renamed into place, or the swap can downgrade a protected DACL to an inherited one",
  );
  assert.ok(
    /if \(!hardenTokensFilePermissions\([\s\S]{0,120}throw new Error\(/.test(swap),
    "v07.00.00 / token durability: a replacement that cannot be hardened must never be swapped in",
  );

  // Round 6: the repair half of session_doctor rewrites finalized metadata, so
  // it lands where recovery landed — the owner's capability token, and only
  // the owner's own sessions. Without this the release's claim that
  // `session_sweep` is the sole cross-owner mutation is false.
  const authoritySrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  const doctorStart = authoritySrc.indexOf('registerTool(\n    "session_doctor"');
  assert.ok(doctorStart >= 0, "v07.00.00 / doctor authority: session_doctor must be registered");
  const doctorEnd = authoritySrc.indexOf("\n  registerTool(", doctorStart + 1);
  const doctor = authoritySrc.slice(doctorStart, doctorEnd === -1 ? undefined : doctorEnd);
  assert.ok(
    doctor.includes('assertOwnerTokenVerified("session_doctor.repair"'),
    "v07.00.00 / doctor authority: the repair pass must require the owner's capability token",
  );
  assert.ok(
    doctor.includes("repairInclude: (session) => derivePersistedSessionOwner(session) === caller"),
    "v07.00.00 / doctor authority: the repair pass must be filtered to the caller's own sessions",
  );
  const recoverStart = authoritySrc.indexOf('registerTool(\n    "session_recover_interrupted"');
  const recoverEnd = authoritySrc.indexOf("\n  registerTool(", recoverStart + 1);
  const recover = authoritySrc.slice(recoverStart, recoverEnd === -1 ? undefined : recoverEnd);
  assert.ok(
    recover.includes('assertOwnerTokenVerified("session_recover_interrupted"'),
    "v07.00.00 / recovery authority: scoping by ownership is not enough — the owner's token is required, as it is for every other owner-scoped mutation",
  );

  // Same round: the dashboard was translated to English while its root element
  // still declared pt-BR, so screen readers and translation tooling applied
  // Portuguese rules to English labels.
  const dashboardSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "dashboard", "server.ts"),
    "utf8",
  );
  assert.ok(
    !dashboardSrc.includes('lang="pt-BR"'),
    "v07.00.00 / dashboard: the document language must match the language of the UI it declares",
  );
  console.log("[source-contract-smoke] token_migration_is_durable_test: PASS");
}

{
  // v07.00.00 (PR #300 review rounds 2-7): the English-only rule produced a
  // finding in SIX consecutive rounds. Each round I fixed the line that was
  // named and the next round named another one. Six site fixes did not enforce
  // the rule, so the rule is enforced here instead.
  //
  // What is forbidden is an AUTHORED comment in Portuguese. Portuguese is
  // admissible as DATA — a fixture the runtime must recognise, which lives in
  // a string literal, never in a comment — and as a QUOTATION of a standing
  // directive, which carries quote marks or an explicit marker. So the gate
  // reads contiguous comment blocks and skips any block that quotes or is
  // marked. Detection is orthographic first and lexical second: a closed word
  // list always lags the next comment, but Portuguese spelling does not.
  //
  // Replayed against the six findings this rule produced, it catches all six.
  const PT_MARKERS = ["verbatim", "pt-br", "quoted", "fixture", "directive"];
  const PT_ACCENTS = /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00e2\u00ea\u00f4\u00e3\u00f5\u00e7]/;
  const PT_WORDS =
    /(?<![\w-])(n[a\u00e3]o|s[a\u00e3]o|est[a\u00e1]|sess[a\u00e3]o|com|para|que|uma|por|dos|das|pelo|pela|sem|mais|ainda|ent[a\u00e3]o|quando|onde|como|isso|este|esta|seu|sua|deve|fora|cada|nunca|apenas|porque|todos|toda|colegiado|sorteio|removido|filtra|acata|contesta)(?![\w-])/;
  const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);
  const walkTsFiles = (dir: string, acc: string[]): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkTsFiles(full, acc);
      else if (entry.name.endsWith(".ts")) acc.push(full);
    }
    return acc;
  };
  const authoredPortuguese: string[] = [];
  for (const file of [
    ...walkTsFiles(path.join(process.cwd(), "src"), []),
    ...walkTsFiles(path.join(process.cwd(), "scripts"), []),
  ]) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let blockStart = -1;
    const flushBlock = (endExclusive: number): void => {
      if (blockStart < 0) return;
      const block = lines.slice(blockStart, endExclusive);
      const joined = block.join(" ");
      const lowered = joined.toLowerCase();
      const quotes = joined.includes('"') || joined.includes("`") || joined.includes("'");
      const marked = PT_MARKERS.some((marker) => lowered.includes(marker));
      if (!quotes && !marked) {
        for (let i = 0; i < block.length; i += 1) {
          const line = block[i] ?? "";
          const low = line.toLowerCase();
          if (low.includes("://")) continue;
          if (PT_ACCENTS.test(low) || PT_WORDS.test(low)) {
            authoredPortuguese.push(
              `${path.relative(process.cwd(), file).split(path.sep).join("/")}:${blockStart + i + 1}: ${line.trim().slice(0, 90)}`,
            );
          }
        }
      }
      blockStart = -1;
    };
    for (let i = 0; i < lines.length; i += 1) {
      if (isCommentLine(lines[i] ?? "")) {
        if (blockStart < 0) blockStart = i;
      } else {
        flushBlock(i);
      }
    }
    flushBlock(lines.length);
  }
  assert.deepEqual(
    authoredPortuguese,
    [],
    `v07.00.00 / English-only: an authored comment must be English. Portuguese belongs in fixtures (string literals the runtime must match) and in marked quotations of standing directives, never in the author's own commentary. Offending lines:\n${authoredPortuguese.join("\n")}`,
  );
  console.log("[source-contract-smoke] authored_comments_are_english_test: PASS");
}

{
  // v07.00.00 (PR #300 review rounds 1-7): "an owner-scoped mutation must be
  // scoped" produced findings in rounds 1, 2, 5, 6 and 7 — seven in total,
  // including a P1 in round 7 on the same file as a round-1 finding. Five site
  // fixes did not enforce the rule. What follows enforces it as a census: every
  // mutating tool is classified by the authority it actually requires, and the
  // three buckets are pinned. A new mutating tool, or an existing one that
  // loses its check, lands in the wrong bucket and fails here.
  const authoritySource = fs.readFileSync(
    path.join(process.cwd(), "src", "mcp", "server.ts"),
    "utf8",
  );
  const OWNER_SCOPED = [
    "ask_peers",
    "contest_verdict",
    "session_attach_evidence",
    "session_cancel_job",
    "session_doctor",
    "session_evidence_judge_consensus_pass",
    "session_evidence_judge_pass",
    "session_finalize",
    "session_recover_interrupted",
    "session_start_round",
    "session_start_unanimous",
  ];
  // The single deliberate exception. Sweep exists for sessions whose petitioner
  // is GONE, so scoping it by owner would disable its only purpose; it is
  // bounded by the 24-hour age floor instead. It must still know who is asking.
  const VERIFIED_IDENTITY_ONLY = ["session_sweep"];
  // These CREATE a session rather than mutate one that already has an owner,
  // so there is no owner to check against.
  const DECLARED_IDENTITY_ONLY = ["run_until_unanimous", "session_init"];

  const buckets: { owner: string[]; verified: string[]; declared: string[] } = {
    owner: [],
    verified: [],
    declared: [],
  };
  for (const registration of authoritySource.split('registerTool(\n    "').slice(1)) {
    const toolName = registration.slice(0, registration.indexOf('"'));
    const handlerAt = registration.indexOf("async (");
    const declaration = handlerAt > 0 ? registration.slice(0, handlerAt) : registration;
    if (!/readOnlyHint:\s*false/.test(declaration)) continue;
    const body = handlerAt > 0 ? registration.slice(handlerAt, handlerAt + 8000) : registration;
    if (
      body.includes("assertOwnerTokenVerified") ||
      body.includes("verifySessionMutationAuthority")
    ) {
      buckets.owner.push(toolName);
    } else if (body.includes("assertIdentityActuallyVerified")) {
      buckets.verified.push(toolName);
    } else {
      buckets.declared.push(toolName);
    }
  }
  assert.deepEqual(
    buckets.owner.sort(),
    OWNER_SCOPED,
    `v07.00.00 / mutation authority: these tools mutate a session that already has an owner and must require the owner's capability token; got [${buckets.owner.join(", ")}]`,
  );
  assert.deepEqual(
    buckets.verified.sort(),
    VERIFIED_IDENTITY_ONLY,
    `v07.00.00 / mutation authority: exactly one mutating tool may act across owners, and it must still require a verified identity; got [${buckets.verified.join(", ")}]`,
  );
  assert.deepEqual(
    buckets.declared.sort(),
    DECLARED_IDENTITY_ONLY,
    `v07.00.00 / mutation authority: only session-creating tools may run on a declared identity alone; got [${buckets.declared.join(", ")}]`,
  );

  // The companion rule, which produced findings in rounds 4, 6 and 7: every
  // public entry point that accepts a caller validates it at RUNTIME, because
  // the TypeScript declaration is erased in the shipped JavaScript. Pinning the
  // COUNT is what makes a fourth entry point fail rather than pass silently.
  const orchestratorSource = fs.readFileSync(
    path.join(process.cwd(), "src", "core", "orchestrator.ts"),
    "utf8",
  );
  const guarded = orchestratorSource.match(/assertCallerIsPeer\("([a-zA-Z]+)"/g) ?? [];
  assert.deepEqual(
    guarded.map((entry) => entry.replace(/assertCallerIsPeer\("/, "").replace(/"$/, "")).sort(),
    ["askPeers", "initSession", "runUntilUnanimous"],
    `v07.00.00 / caller validation: every public orchestrator entry point that accepts a caller must validate it at runtime; got [${guarded.join(", ")}]`,
  );
  console.log("[source-contract-smoke] mutation_authority_census_test: PASS");
}

{
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  assert.ok(
    serverSrc.includes('process.on("SIGTERM"') && serverSrc.includes('process.on("SIGINT"'),
    "v4.3.3 / shutdown: server main must install SIGTERM and SIGINT handlers.",
  );
  assert.ok(
    serverSrc.includes("flushPendingEvents()") &&
      serverSrc.includes("eventLog.flush()") &&
      serverSrc.includes("setTimeout("),
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
  const errorsSrc = fs.readFileSync(path.join(process.cwd(), "src", "peers", "errors.ts"), "utf8");
  const redactSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "security", "redact.ts"),
    "utf8",
  );

  assert.ok(
    sourceOmits(storeSrc, /evidenceAttachmentCache/) &&
      storeSrc.includes('crypto.createHash("sha256").update(persisted).digest("hex")') &&
      storeSrc.includes("evidence_integrity_mismatch"),
    "v4.5.0 / evidence: current-format attachments must be re-hashed on every read; stale content caches cannot bypass custody integrity.",
  );
  assert.ok(
    storeSrc.includes("safeResolveContainedExistingPath") &&
      storeSrc.includes(
        "const absolutePath = this.safeResolveContainedExistingPath(sessionDir, file.path)",
      ),
    "v4.4.5 / evidence: readEvidenceAttachments must use a non-throwing contained realpath resolver.",
  );
  assert.ok(
    orchSrc.includes("private safeReadEvidenceAttachments") &&
      (orchSrc.match(/this\.store\.readEvidenceAttachments\(/g) ?? []).length === 1,
    "v4.4.6 / evidence: orchestrator preflight paths must route attached-evidence reads through a fail-closed helper.",
  );
  assert.ok(
    sourceOmits(configSrc, /export const RELEASE_DATE\s*=\s*["']/) &&
      configSrc.includes("releaseDateFromChangelog"),
    "v4.4.5 / release_metadata: RELEASE_DATE must be derived from CHANGELOG metadata, not hand-maintained as a string literal.",
  );
  assert.ok(
    typesSrc.includes('"session.evidence_judge_pass.shadow_decision":') &&
      sourceOmits(storeSrc, /event\.data \?\? \{\}\) as \{[\s\S]{0,220}judge_peer/),
    "v4.4.5 / runtime-events: shadow_decision data must be typed in RuntimeEventDataByType, not recovered through local casts.",
  );
  assert.ok(
    sourceOmits(redactSrc, /JWT use groups|JWT uses groups|both env-style and JWT use groups/),
    "v4.4.5 / redaction: JWT comments must not claim capture groups for the non-capturing JWT pattern.",
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
    configSrc.includes("must be a non-negative number; ignoring this value") &&
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
    cacheManifestSrc.includes("SESSION_ID_PATTERN") &&
      cacheManifestSrc.includes("invalid session_id for cache manifest") &&
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
    retrySrc.includes("function attachPeerFailure") &&
      retrySrc.includes("peerFailure") &&
      errorsSrc.includes("peerFailure?: PeerFailure") &&
      errorsSrc.includes("return attachedFailure"),
    "v4.4.1 / retry: exhausted retries should preserve and consume the classified PeerFailure metadata.",
  );
  assert.ok(
    !/inputTokens\s*>\s*cached/.test(openaiSrc) && !/inputTokens\s*>\s*cached/.test(grokSrc),
    "v4.4.1 / cache-cost: OpenAI/Grok must not infer cache_write_tokens from input minus cached tokens.",
  );
  assert.ok(
    /probe_mode:\s*"auth_only" \| "live"/.test(typesSrc) &&
      configSrc.includes("CROSS_REVIEW_PERPLEXITY_PROBE_MODE") &&
      /probe_mode === "auth_only"/.test(perplexitySrc),
    "v4.4.1 / perplexity: probe defaults must avoid tokenized Sonar calls.",
  );
  assert.ok(
    /request\.method !== "GET" && request\.method !== "POST"/.test(dashboardSrc) &&
      /if \(request\.method === "POST"\)[\s\S]{0,120}?saveReport/.test(dashboardSrc),
    "v4.4.1 / dashboard: GET report route should not persist files; only POST may save.",
  );
  assert.ok(
    typesSrc.includes("export interface RuntimeEventDataByType") &&
      typesSrc.includes("export type RuntimeEventData<") &&
      typesSrc.includes(
        "export interface RuntimeEvent<T extends RuntimeEventType = RuntimeEventType>",
      ),
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

// v2.27.1 — lazy_provider_sdk_imports_test. Pins the cold-start
// hardening contract: every peer adapter must keep provider SDK imports
// as `import type` at the top of the file and resolve the runtime ctor
// via a cached dynamic `import()` inside `client()` / loader helper.
{
  const peerSources = [
    "src/peers/anthropic.ts",
    "src/peers/openai.ts",
    "src/peers/gemini.ts",
    "src/peers/deepseek.ts",
    "src/peers/grok.ts",
    "src/peers/model-selection.ts",
  ];
  const runtimeImportPatterns = [
    /^import\s+(?!type\s)[^;]*from\s+["']@anthropic-ai\/sdk["']/m,
    /^import\s+(?!type\s)[^;]*from\s+["']openai["']/m,
    /^import\s+(?!type\s)[^;]*from\s+["']@google\/genai["']/m,
  ];
  for (const file of peerSources) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of runtimeImportPatterns) {
      assert.ok(
        !pattern.test(source),
        `v2.27.1 / lazy_provider_sdk_imports: ${file} must keep provider SDK imports as type-only (pattern matched: ${pattern})`,
      );
    }
  }

  const distFiles = [
    "dist/src/peers/anthropic.js",
    "dist/src/peers/openai.js",
    "dist/src/peers/gemini.js",
    "dist/src/peers/deepseek.js",
    "dist/src/peers/grok.js",
    "dist/src/peers/model-selection.js",
  ];
  for (const file of distFiles) {
    if (!fs.existsSync(file)) continue;
    const compiled = fs.readFileSync(file, "utf8");
    assert.ok(
      !/from\s+["']@anthropic-ai\/sdk["']/.test(compiled),
      `v2.27.1 / lazy_provider_sdk_imports: ${file} must not contain @anthropic-ai/sdk runtime import`,
    );
    assert.ok(
      !/from\s+["']openai["']/.test(compiled),
      `v2.27.1 / lazy_provider_sdk_imports: ${file} must not contain openai runtime import`,
    );
    assert.ok(
      !/from\s+["']@google\/genai["']/.test(compiled),
      `v2.27.1 / lazy_provider_sdk_imports: ${file} must not contain @google/genai runtime import`,
    );
  }

  const anthropicSrc = fs.readFileSync("src/peers/anthropic.ts", "utf8");
  assert.ok(
    /export function loadAnthropicCtor\b/.test(anthropicSrc),
    "v2.27.1 / lazy_provider_sdk_imports: anthropic.ts must export loadAnthropicCtor",
  );
  const openaiSrc = fs.readFileSync("src/peers/openai.ts", "utf8");
  assert.ok(
    /export function loadOpenAICtor\b/.test(openaiSrc),
    "v2.27.1 / lazy_provider_sdk_imports: openai.ts must export loadOpenAICtor",
  );
  const geminiSrc = fs.readFileSync("src/peers/gemini.ts", "utf8");
  assert.ok(
    /export function loadGenaiModule\b/.test(geminiSrc),
    "v2.27.1 / lazy_provider_sdk_imports: gemini.ts must export loadGenaiModule",
  );
  const deepseekSrc = fs.readFileSync("src/peers/deepseek.ts", "utf8");
  assert.ok(
    /loadOpenAICtor/.test(deepseekSrc),
    "v2.27.1 / lazy_provider_sdk_imports: deepseek.ts must consume loadOpenAICtor",
  );
  const grokSrc = fs.readFileSync("src/peers/grok.ts", "utf8");
  assert.ok(
    /loadOpenAICtor/.test(grokSrc),
    "v2.27.1 / lazy_provider_sdk_imports: grok.ts must consume loadOpenAICtor",
  );
  const modelSelSrc = fs.readFileSync("src/peers/model-selection.ts", "utf8");
  for (const loader of ["loadAnthropicCtor", "loadOpenAICtor", "loadGenaiModule"]) {
    assert.ok(
      new RegExp(`\\b${loader}\\b`).test(modelSelSrc),
      `v2.27.1 / lazy_provider_sdk_imports: model-selection.ts must consume ${loader}`,
    );
  }
  console.log("[source-contract-smoke] lazy_provider_sdk_imports_test: PASS");
}

{
  const smokeSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "smoke.ts"), "utf8");
  const sourceContractSrc = fs.readFileSync(
    path.join(process.cwd(), "scripts", "source-contract-smoke.ts"),
    "utf8",
  );
  const sourcePinPattern = /\.test\(\s*[A-Za-z_$][\w$]*Src\b/g;
  const sourceStylePins = (smokeSrc.match(/\.test\(\s*[A-Za-z_$][\w$]*Src\b/g) ?? []).length;
  const sourceContractStylePins = (sourceContractSrc.match(sourcePinPattern) ?? []).length;
  const totalSourceStylePins = sourceStylePins + sourceContractStylePins;
  assert.ok(
    sourceStylePins <= 129,
    `T2#10 / source-contract split: scripts/smoke.ts has ${sourceStylePins} source-style regex pins; keep new static contracts in scripts/source-contract-smoke.ts.`,
  );
  assert.ok(
    sourceContractStylePins <= 29,
    `T2#10 / source-contract split: scripts/source-contract-smoke.ts has ${sourceContractStylePins} source-style regex pins; keep the contract file at or below the locked 29-pin baseline.`,
  );
  assert.ok(
    totalSourceStylePins <= 158,
    `T2#10 / source-contract split: combined smoke source-style regex pins are ${totalSourceStylePins}; keep the total at or below the locked 158-pin baseline.`,
  );
  console.log("[source-contract-smoke] smoke_source_contract_budget_test: PASS");
}
