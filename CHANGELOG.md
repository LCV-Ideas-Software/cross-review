# Changelog

All notable changes to this project will be documented here.

The format follows Keep a Changelog conventions. Public version display follows the organization
standard `v00.00.00`; npm package versions remain SemVer.

## [Unreleased]

### Alterado

- site/index.html deixou de carregar o widget/SDK SumUp e passou a encaminhar apoios para https://www.lcv.dev/sponsor?project=cross-review-v2, com backend dedicado sponsor-motor via Mercado Pago Checkout Pro.

## [v02.18.05] - 2026-05-07

**Patch — anti-drift smoke drivers for v2.18.4 audit closure (operator directive 2026-05-07).** v2.18.4 shipped 6 surgical fixes from the Codex external audit; v2.18.5 hardens those fixes against silent regression with 5 anti-drift smoke checks. Companion to `cross-review-v1` v1.12.7 (parallel ship; same operator directive).

### Adicionado

- **`hono_override_anti_drift_test`** (P1.1). Reads `package.json`, asserts `overrides.hono === ">=4.12.16"` and that `overrides["ip-address"]` (the v2.18.1 precedent) remains intact. Anti-drift guard against accidental removal of either override by future Dependabot PRs or refactors. Same shape as the v2.18.4 P1.1 fix.
- **`abort_signal_threading_anti_drift_test`** (P1.3). Source-level grep on `src/core/orchestrator.ts`: ≥2 `signal?: AbortSignal` param declarations (consensus + single-peer judge passes); ≥2 `signal: params.signal` receiver wirings; ≥2 `signal: input.signal` autowire emitter wirings; consensus pass body has NO leftover `signal: undefined` literal (was hardcoded pre-v2.18.4).
- **`max_items_per_pass_default_anti_drift_test`** (P1.4). Source-level: env-var fallback in `config.ts` is `?? "4"` (string for parseInt); numeric fallback is `: 4`; legacy `?? "8"` literal is gone for the env-var key. Behavioral: `loadConfig()` with env unset returns `evidence_judge_autowire.max_items_per_pass === 4`. Guards against silent restoration of the doubled budget exposure (with default `consensus_peers=4`, the cap reduction halves worst-case round paid judge calls from 32 to 16).
- **`clamp_effort_for_model_anti_drift_test`** (P2.1). Behavioral: `clampEffortForModel("xhigh", "grok-4.3") === "high"`; `clampEffortForModel("minimal", "grok-4.3") === "high"`; passthrough for `none|low|medium|high` on grok-4.3; full-scale passthrough for `grok-4.20-multi-agent` (xhigh stays xhigh); unknown models pass through unchanged. Source-level: `clampEffortForModel` wired at exactly 2 `responses.create` call sites (non-streaming + streaming). The function is now exported from `src/peers/grok.ts` so the smoke harness can verify the clamp shape directly.
- **`consensus_event_per_peer_attribution_anti_drift_test`** (P2.4). Source-level: legacy `judge_peer: params.judge_peers[0]` co-emitted at ≥2 sites for backward compat; new `judge_peers: params.judge_peers` array emitted at ≥2 sites; `per_peer_verdict: perPeerVerdict` map at ≥2 sites. Co-emission contract: every `this.emit({ ... judge_peer: params.judge_peers[0] ... })` payload also includes the `judge_peers` array AND `per_peer_verdict` map (scoped scan splits source by `this.emit({` boundaries to avoid false-positives on the function-call site at `markEvidenceItemAddressedByJudge`).

### Alterado

- `clampEffortForModel` is now exported from `src/peers/grok.ts` (`export function clampEffortForModel(...)`). Behavior unchanged for in-file callers; the export enables direct verification by the smoke harness without spinning a request-shape stub.

### Notas técnicas

- Smoke harness gains 5 new test markers (hono_override / abort_signal_threading / max_items_per_pass_default / clamp_effort_for_model / consensus_event_per_peer_attribution). All five PASS in stub mode; harness completes with `ok: true` / exit 0.
- Lint / typecheck / format clean. `npm audit --audit-level=moderate` returns 0 vulnerabilities.
- Public surface impact: additive only — `clampEffortForModel` becomes a named export of `src/peers/grok.ts`. No runtime behavior change for existing callers; no breaking changes.
- Operator directive 2026-05-07: shipping the anti-drift drivers I had flagged as "possible future work" after v2.18.4. Each driver targets a fix where silent regression would be hardest to notice in production telemetry: P1.1 (npm audit re-introduces moderate advisories), P1.3 (cancellation stops propagating to in-flight judges), P1.4 (judge call budget silently doubles), P2.1 (grok-4.3 starts 400ing on `xhigh`), P2.4 (per-peer accuracy resumes being uncomputable from raw event stream).

## [v02.18.04] - 2026-05-07

**Patch — Codex external audit 2026-05-07 outcome: 6 surgical fixes (P1.1, P1.2, P1.3, P1.4, P2.1, P2.4).** Codex submitted a read-only audit of cross-review-v2 v2.18.3 with 4 P1 + 7 P2 findings; this ship lands the 6 verified-actionable items. Findings deferred or non-issue: P2.2 (sessions histórico — operational housekeeping, session_sweep exists), P2.3 (token noise — config option not bug), P2.5 (grok historical errors — passive log), P2.6 (deepseek cache pricing — forward optimization), P2.7 (publish.yml tag padding — Codex misread; regex accepts both formats, P3 polish).

### Corrigido (P1)

- **P1.1 hono advisory** — `package.json` `overrides` now pins `hono: ">=4.12.16"` to clear `npm audit --audit-level=moderate` failures from `@modelcontextprotocol/sdk@1.29.0` transitive (advisories `GHSA-9vqf-7f2p-gf9v` bodyLimit bypass + `GHSA-69xw-7hcm-h432` JSX HTML injection, both range `<4.12.16`). Practical exposure essentially zero in stdio runtime (StdioServerTransport doesn't load HTTP/JSX paths) but the audit-gate matters for publish workflow + defense-in-depth. Same precedent as the `ip-address` override since v2.18.1.

- **P1.2 xai- API key redaction** — `src/security/redact.ts` `SECRET_PATTERNS` now includes `/xai-[A-Za-z0-9_-]{20,}/g` at parity with `sk-`/`sk-ant-`/`AIza`/`xox[baprs]-`/etc. Previously xAI keys could leak into logs/sessions via persisted provider error messages or environment dumps. Smoke test extended to verify the pattern fires on realistic shapes + does NOT match short prefixes (false-positive guard).

- **P1.3 AbortSignal threading on judge passes** — Pre-v2.18.4 `runEvidenceChecklistJudgeConsensusPass` (orchestrator.ts:929) hard-coded `signal: undefined` in the `judgeEvidenceAsk()` context and `runEvidenceChecklistJudgePass` built the context without a signal field at all, so `session_cancel_job` could not abort judge calls mid-flight — operators paid for full provider responses even after cancellation. v2.18.4 adds optional `signal?: AbortSignal` to both function `params`, threads it into the `PeerCallContext`, and at the autowire call sites (orchestrator.ts:2341 + 2381) passes `input.signal` from the round scope. Cancellation now propagates correctly to in-flight judge requests.

- **P1.4 consensus shadow cost defensive default** — `src/core/config.ts` lowered the default `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS` from `8` to `4`. Math: with `consensus_peers=4` (codex+gemini+deepseek+grok) and old default `max_items_per_pass=8`, worst-case round fired up to `4 × 8 = 32` paid judge calls. Lowering the default to `4` halves the worst-case to `4 × 4 = 16`. Operators wanting prior behavior set `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS=8` (or higher) explicitly. Single-peer mode also reduces (1×8 → 1×4) — coverage tradeoff acknowledged; raise via env-var if needed.

### Alterado (P2)

- **P2.1 Grok grok-4.3 reasoning_effort support** — `src/peers/grok.ts` `GROK_REASONING_EFFORT_MODELS` Set expanded from `{"grok-4.20-multi-agent"}` to `{"grok-4.20-multi-agent", "grok-4.3"}`. xAI documentation (verified via WebFetch 2026-05-07 at `https://docs.x.ai/developers/model-capabilities/text/reasoning`) explicitly states `grok-4.3 supports reasoning_effort` with values `none|low (default)|medium|high`. New helper `clampEffortForModel(effort, model)` clamps the internal `xhigh`/`minimal` scale to `high` when targeting `grok-4.3` (which doesn't accept `xhigh`); `grok-4.20-multi-agent` keeps the full `xhigh`-inclusive range. Wired at both `responses.create` call sites (lines 244 + 332). v2.16.0 verification (2026-05-05 operator directive) is now stale by the xAI docs update; v2.18.4 closes the drift.

- **P2.4 consensus metrics per-peer attribution** — `orchestrator.ts:1008` (active-mode `evidence_checklist_addressed` event) and `:1030` (shadow-mode `shadow_decision` event) previously emitted only `judge_peer: params.judge_peers[0]`, so the rollup at `session-store.ts:911` (`groupBy judge_peer`) attributed every consensus decision to whichever peer was first in the configured list (codex by default), making per-peer accuracy analysis impossible. v2.18.4 keeps `judge_peer` for backward-compat readers but ALSO emits the full `judge_peers: PeerId[]` list and `per_peer_verdict: Record<PeerId, "verified_satisfied" | "disagree" | "failed">` map so operators can compute accurate per-peer accuracy from the raw event stream.

### Notas técnicas

- Smoke harness completes with exit 0 + final `{ ok: true, events: 96 }` payload (each named PASS marker prints during the run; the harness's terminal `ok` is the binary success signal). Updated to assert new `GROK_REASONING_EFFORT_MODELS.size === 2` + `has("grok-4.3") === true` + xAI key redaction pattern fires on realistic xAI key shapes (and does NOT fire on short prefixes — false-positive guard). `grok_reasoning_capability_allowlist_test` updated from prior `size === 1` / `has("grok-4.3") === false` assertions.
- Lint/typecheck/format clean.
- Public surface impact: additive only. New optional `signal` param on judge passes is backward-compatible (existing callers pass nothing → behaves like pre-v2.18.4). Event payload gains new fields (`judge_peers`, `per_peer_verdict`) — additive. `judge_peer` field unchanged for legacy readers.
- Default behavior change: `max_items_per_pass` default 8 → 4 affects operators relying on the implicit default; explicit env-var unchanged. CHANGELOG calls this out so operators can audit their consensus pass throughput.

## [v02.18.03] - 2026-05-07

**Patch — Gemini default pin bump `gemini-3.1-pro-preview` → `gemini-2.5-pro` (operator preference 2026-05-07; coordinated with cross-review-v1 v1.12.4).** Earlier today the 7 LCV-workspace MCP host configs flipped `CROSS_REVIEW_GEMINI_MODEL` env-override to `gemini-2.5-pro` (operator directive: `gemini-2.5-pro` carries 1k requests/day quota under Google One AI Ultra vs `gemini-3.1-pro-preview`'s 250 requests/day). v2.18.3 aligns the source-of-truth defaults so a fresh install without env-override picks the same model. Workspace policy 2026-05-07: only `gemini-*-pro` variants ≥ 2.5 are permitted — no `*-flash` and no models below 2.5.

### Changed

- **`src/core/config.ts`** — `VERSION` 2.18.2 → 2.18.3; `RELEASE_DATE` 2026-05-06 → 2026-05-07; `models.gemini` default fallback `"gemini-3.1-pro-preview"` → `"gemini-2.5-pro"` (env-override `CROSS_REVIEW_GEMINI_MODEL` continues to take priority when set).
- **`src/peers/model-selection.ts`** — gemini priority list reordered from `["gemini-3.1-pro-preview", "gemini-2.5-pro"]` to `["gemini-2.5-pro", "gemini-3.1-pro-preview"]`. 3.1-pro-preview retained as fallback for hosts that explicitly select it.
- **`scripts/smoke.ts`** line 225 — `currentOfficialModel` iterator entry `"gemini-3.1-pro-preview"` → `"gemini-2.5-pro"` to align with the new default.
- **`docs/api-keys.md`** — `CROSS_REVIEW_GEMINI_MODEL` env-var example flipped to `gemini-2.5-pro`.
- **`docs/model-selection.md`** — priority block flipped to `gemini-2.5-pro > gemini-3.1-pro-preview`; added paragraph explaining workspace policy (`gemini-*-pro` ≥ 2.5 only; no `*-flash`).

### Notas técnicas

- Lint/typecheck/format clean. Smoke 6/6 PASS unchanged (smoke fixture's `currentOfficialModel` array updated to reference the new canonical pin — `scripts/smoke.ts:225` flipped `gemini-3.1-pro-preview` → `gemini-2.5-pro` — but the 6-test suite assertions and shape are unchanged from v2.18.2; capability_snapshot probe in real sessions returns `model: "gemini-2.5-pro"` from env-override on the 7 LCV hosts).
- No public surface change beyond default model ID. Hosts using `CROSS_REVIEW_GEMINI_MODEL` env-override (default for the 7 LCV-workspace MCP hosts since 2026-05-07) see no behavior change at all.
- Coordinated with `cross-review-v1` v1.12.4 (parallel ship; same gemini default flip in `peer-spawn.js` `GEMINI_MODEL` constant + `top-models.json` `gemini.id`).

## [v02.18.02] - 2026-05-06

**Patch — Tier 5 Windows process-tree introspection.** Closes the long-standing forensics gap: pre-v2.18.2 `getParentProcessSnapshot()` returned `parent_exe_basename: null` on Windows because we only had a POSIX `/proc/<ppid>/comm` reader (added in F1 v2.18.0; Windows path explicitly deferred per `project_cross_review_f1_caller_capability_tokens_design.md`). v2.18.2 closes the gap with a defensive `tasklist`-based reader. Coordinated with cross-review-v1 v1.12.2 (parallel ship; same shape, same constraints, same time budget).

### Changed

- `src/core/caller-tokens.ts` — `getParentProcessSnapshot()` now branches on `process.platform === "win32"` and shells out to `tasklist /FI "PID eq <ppid>" /FO CSV /NH` via `child_process.spawnSync` (`encoding: "utf8"`, `timeout: 500`, `windowsHide: true`). Output discriminator: stdout starts with `"` for valid PID (CSV row `"<image>","<pid>",...`), starts with `INFO`/`INFORMAÇÕES:` for "no tasks running" (no leading quote). Parser extracts the first quoted field as the `.exe` basename and applies the same `1 ≤ length < 128` sanity filter as the POSIX path. Best-effort: try/catch swallows ENOENT, timeout, parse failures, all errors — never throws. POSIX path unchanged.

### Added

- **`scripts/smoke.ts`** — sub-test (14) inside `caller_capability_tokens_test` extended with v2.18.2 Tier 5 assertions: shape sanity (`parent_pid` is null or positive integer, `parent_exe_basename` is null or sane string); on Windows with valid `parent_pid`, asserts `parent_exe_basename` is populated; source-level anti-drift guards (`spawnSync("tasklist", ...)`, `timeout: 500`).

### Notes

- Forensics-only: `parent_exe_basename` is metadata captured at session_init in `meta.identity_metadata.parent_exe_basename`. It is NOT used by the F1 token gate (which authenticates via `CROSS_REVIEW_CALLER_TOKEN`) or the v2.17.0 clientInfo cross-check. The field exists for audit trail / forensics review.
- Time budget: 500ms cap on `spawnSync`. Empirical Windows tasklist latency is 50-200ms on warm cache; the cap is defensive against cold filesystem or denied access.
- Smoke: build clean, smoke PASS (4 markers all green: per_call_reasoning_effort_overrides_accepted_test, provider_4xx_param_rejection_docs_hint_test, identity_forgery_blocked_test, caller_capability_tokens_test with extended Tier 5 sub-test).

## [v02.18.01] - 2026-05-05

**Hotfix: closes Dependabot security advisory GHSA-v2v4-37r5-5v8g (medium severity) — `ip-address` XSS in Address6 HTML-emitting methods.** Pre-v2.18.1 the transitive dependency chain `@modelcontextprotocol/sdk@1.29.0 → express-rate-limit@8.4.1 → ip-address@10.1.0` pinned a vulnerable version (also pulled in via `@google/genai@1.52.0 → express-rate-limit@8.4.1`). The exploitability in this codebase is essentially zero (we don't use Address6 HTML-emitting methods, and we don't run the MCP HTTP transport — peers are API-first), but the advisory still surfaces in any `npm audit` and in dependabot. Dependabot's automatic update workflow (#14, run 25409531881) could not resolve the chain because the parent packages don't yet ship a bumped requirement, so dependabot reported "No patched version available for ip-address" and failed.

Fix: added `overrides: { "ip-address": ">=10.1.1" }` to `package.json`. npm resolves the override regardless of transitive parents' constraints; the new install pulls a patched version (`>=10.1.1`, currently resolved to `10.2.0` in `package-lock.json`) which is past the vulnerable range. **Patch bump** because no public surface changed. Coordinated with cross-review-v1 v1.11.1 (same root cause, same fix).

### Fixed

- `package.json` `overrides.ip-address` pinned to `>=10.1.1` to close GHSA-v2v4-37r5-5v8g (Dependabot alert #1, medium severity). Also unblocks the failed Dependabot Updates run #14 (operator-flagged 2026-05-05).

## [v02.18.00] - 2026-05-05

**Closes F1 from the v2 backlog: caller capability tokens.** Cryptographic identity proof complementing the v2.17.0 clientInfo gate. Pre-v2.18.0 the v2.17.0 cross-check between declared `caller` and `clientInfo.name` only catches _inconsistent_ self-reports — both fields are declared by the caller. An attacker that lies consistently in both passes the gate. F1 introduces a per-host secret (env var `CROSS_REVIEW_CALLER_TOKEN`), authoritative on match and rejected on mismatch. Coordinated ship with cross-review-v1 v1.11.0 (same scope, same env var names, same operator workflow).

This is a **minor bump** because the public surface adds (a) a new `regenerate_caller_tokens` MCP tool, (b) new fields `verification_method` and `identity_metadata` on the `CallerIdentityResult` shape returned by `verifyCallerIdentity`, (c) a new `caller_tokens` block in `server_info`, and (d) three new env vars (`CROSS_REVIEW_CALLER_TOKEN` per host, `CROSS_REVIEW_TOKENS_FILE` for path override, `CROSS_REVIEW_REQUIRE_TOKEN` for opt-in hard-enforce). Permissive default: hosts without tokens continue to work via the v2.17.0 clientInfo fallback. Operator decisions 2026-05-05: Option C (Hybrid: token enforcement + parent-process forensics breadcrumb), default+customizable token path, ship the regenerate tool now, ship permissive (operator opts into hard-enforce later).

### Added

- New module `src/core/caller-tokens.ts` exposing: `getTokensFilePath`, `generateHostTokens`, `loadHostTokens`, `ensureHostTokens`, `verifyTokenForCaller`, `getParentProcessSnapshot`, `tokensMatch` (constant-time hex comparison via `crypto.timingSafeEqual`), `resolveAgentForToken`, `getEnvToken`, `isHardEnforceMode`. Token shape: 256-bit secret per agent (`crypto.randomBytes(32).toString("hex")`), file mode `0o600` on POSIX, atomic-ish write via `flag: "wx"` for first generation.
- New MCP tool `regenerate_caller_tokens`: rotates `host-tokens.json` and returns the new map so the operator can copy each per-agent secret into the corresponding MCP host config. Stale tokens start being rejected post-rotation.
- New env vars:
  - `CROSS_REVIEW_CALLER_TOKEN`: per-host secret (operator distributes from `host-tokens.json`).
  - `CROSS_REVIEW_TOKENS_FILE`: optional override for the tokens file path (default `<data_dir>/host-tokens.json`).
  - `CROSS_REVIEW_REQUIRE_TOKEN=true`: opt-in hard-enforce — refuses any caller without a valid token.
- New fields on `CallerIdentityResult`:
  - `verification_method: "token" | "client_info" | "none"`.
  - `identity_metadata: { parent_pid, parent_exe_basename }` (best-effort forensics; `parent_exe_basename` is null on Windows pending native-API integration in v2.19+).
- New `caller_tokens` block in `server_info`: `loaded`, `file_path`, `generated_at`, `hard_enforce`, `agents[]` so operators can confirm the gate state without reading the file.
- New smoke marker `caller_capability_tokens_test` covering: ensureHostTokens generates with mode 0o600 + 5 distinct 64-char hex tokens, loadHostTokens idempotent, tokensMatch constant-time covers equal/different/length-mismatch/null, verifyTokenForCaller match/mismatch/unknown/absent paths, verifyCallerIdentity overlay (token match → method=token; mismatch → throws; absent + permissive → falls back to v2.17.0; absent + hard-enforce → throws), operator caller skips token overlay, generateHostTokens overwrite rotates secrets, getParentProcessSnapshot is best-effort.

### Changed

- `verifyCallerIdentity` em `src/mcp/server.ts`: token check overlays the existing v2.17.0 clientInfo logic. Token present → must resolve to declared caller (else `identity_forgery_blocked: token resolves to X but caller declared Y`). Token absent + hard-enforce → throws `identity_forgery_blocked: CROSS_REVIEW_REQUIRE_TOKEN=true ... but no CROSS_REVIEW_CALLER_TOKEN was provided`. Token absent + permissive (default) → falls back to v2.17.0 clientInfo cross-check unchanged.
- `main()` em `src/mcp/server.ts` initializes `HOST_TOKENS_RECORD` after `createRuntime()` (loads existing file OR generates with mode `0o600`). One-shot stderr line on first generation publishes the file path + per-agent distribution instructions. Failure to read/write tokens file is non-fatal: server boots, v2.17.0 fallback continues to work for non-migrated hosts.
- `getCallerCandidatesFromClientInfo` and `verifyCallerIdentity` import path moved into the same module as the tokens overlay (`src/mcp/server.ts` now imports from `src/core/caller-tokens.ts`); public re-exports unchanged.

### Fixed (cross-review trilateral R2 codex catch — 2026-05-05 mid-ship hardening)

R2 codex flagged a defense-in-depth concern: the original v2.18.0 draft had `caller="operator"` skip the token overlay regardless of env state. A malicious AI-agent host could thus pass `caller="operator"` to bypass the token gate (especially relevant when CROSS_REVIEW_REQUIRE_TOKEN=true). Fix: `verifyCallerIdentity` now throws `identity_forgery_blocked` when `caller="operator"` is declared from a host that carries `CROSS_REVIEW_CALLER_TOKEN` — the token binds to a specific AI agent's identity, so declaring operator from such a host is forgery. Genuine human-driven invocations (curl, dashboard, stdio) without a token continue to work; the operator is the gate-setter, intentionally exempt from agent-token enforcement. Smoke `caller_capability_tokens_test` case 12 split into three sub-cases: (12) operator-with-token throws, (12b) operator-without-token works, (12c) operator-in-hard-enforce-without-token still works (gate-setter exemption documented).

Per `feedback_peer_review_rigor.md`, codex's iterative rigor closed a real bypass before ship.

### Operational notes

- **Migration runbook**: (1) start v2.18.0 once on each MCP host (file generates if absent). (2) Operator reads `<data_dir>/host-tokens.json`. (3) Pastes per-agent secret into each of the 6 MCP host configs as `CROSS_REVIEW_CALLER_TOKEN`. (4) Reload all 6 hosts. (5) Validate via `server_info.caller_tokens.loaded === true` and inspect a session response showing `verification_method: "token"`. (6) Optionally flip `CROSS_REVIEW_REQUIRE_TOKEN=true` once all hosts are migrated to enable hard-enforce.
- **Token rotation**: call `regenerate_caller_tokens` MCP tool. Save the returned map. Redistribute. Reload affected hosts. Stale tokens get rejected with `identity_forgery_blocked: token does not match any known agent`.
- **Threat model unchanged**: F1 raises the bar for impersonation from "consistently fake clientInfo + caller" to "extract per-host secret from operator filesystem". Workstation compromise still defeats the gate; F1 closes the easier in-protocol attack vector.
- **Coordinated with cross-review-v1 v1.11.0**: same scope, same env var names. Operators can use the SAME `CROSS_REVIEW_CALLER_TOKEN` value across both runtimes per host (the token files are independent — one in v1's STATE_DIR, one in v2's data_dir — but the operator can choose to use identical secrets for simplicity, or different secrets for compartmentalization).

## [v02.17.00] - 2026-05-05

**HARD GATE — identity forgery rejection (operator directive 2026-05-05).** Pre-v2.17.0 the `caller` field on tool inputs was trusted unconditionally; v2 did not even capture `clientInfo` from the MCP initialize handshake. An agent (e.g. Codex CLI from the operator's terminal) could pass `caller="claude"` while its MCP client identified itself as "codex", impersonating Claude in tribunal sessions: self-excluding the real Claude from the panel while the impersonator stayed on the panel reviewing its own petition. **Empirical evidence**: cross-review-v2 session `0994cbaf-c270-4eaa-b42b-a0e638b9d1b6` (2026-05-05T05:30:10Z) was created by Codex with `caller=claude` for exactly this purpose.

This is a **minor bump** (not patch) because the public surface adds a new error class (`identity_forgery_blocked`). Callers passing `caller` consistent with their `clientInfo.name` (or with an unknown clientInfo, or `caller="operator"`) continue to work unchanged; mismatched callers will start receiving errors.

### Added

- `getCallerCandidatesFromClientInfo(clientInfo)` exported from `src/mcp/server.ts`: returns ARRAY of `PeerId`s whose name appears as substring in lowercased `clientInfo.name`. Walks `PEERS` (claude/codex/gemini/deepseek/grok).
- `verifyCallerIdentity(declaredCaller, clientInfo)` exported from `src/mcp/server.ts`: cross-checks the declared `caller` against the clientInfo-derived candidate set. Returns `{ identity_verified, client_info_name }` on success; throws `identity_forgery_blocked` on mismatch.

### Changed

- All tool handlers that accept `caller` now invoke `verifyCallerIdentity` against `server.server.getClientVersion()` BEFORE delegating to the orchestrator: `session_init`, `ask_peers`, `session_start_round`, `run_until_unanimous`, `session_start_unanimous`, and (when `new_caller` is provided) `contest_verdict`. Mismatch throws an explicit error that surfaces both the declared caller and the clientInfo-derived agent.

### Decision rules

| Declared `caller` | clientInfo resolves to      | Result                                                                           |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `operator`        | anything                    | OK — `identity_verified=false` (no agent claim made)                             |
| Agent X           | nothing (unknown host)      | OK — `identity_verified=false` (legitimate override for headless/scripted hosts) |
| Agent X           | exactly Agent X             | OK — `identity_verified=true`                                                    |
| Agent X           | exactly Agent Y (Y ≠ X)     | **THROWS** `identity_forgery_blocked`                                            |
| Agent X           | multiple agents (ambiguous) | **THROWS** `identity_forgery_blocked` (cannot validate against ambiguous host)   |

### Smoke marker (1 new)

- `identity_forgery_blocked_test` (in `scripts/smoke.ts`): 6 sub-cases covering all decision rows above plus the empirical attack reproduction (Codex client + caller=claude → rejected, closes the `0994cbaf` class) plus a direct test of `getCallerCandidatesFromClientInfo` returning the multi-match array correctly.

### Operational notes

- **Cross-review trilateral was bypassed for this ship** by explicit operator directive 2026-05-05. Same precedent as the one-time exception when cross-review-mcp itself is broken (`feedback_cross_review_self_repair_exception.md`): routing this security fix through the very gate it hardens would be circular.
- **The `feedback_no_self_review_hard_rule.md` workspace HARD GATE** is the policy this enforces. Without identity verification, the no-self-review hard gate was structurally bypassable.
- Coordinated ship with `cross-review-v1 v1.9.0` which closes the same gap on the v1 side.

## [v02.16.00] - 2026-05-05

**Tribunal protocol repair, read-only operational doctor, Windows smoke closure,
and official provider-doc refresh.** This release repairs the audit semantics
identified in the live session/log corpus: a petitioner/caller could still be
persisted as `lead_peer` in direct `ask_peers` metadata, and synchronous
`run_until_unanimous` initialized new sessions with the relator as the durable
caller. The runtime now keeps the impetrante/petitioner separate from the
relator/acting peer, auto-recuses peer callers from direct review rounds, and
adds a read-only doctor surface for open/stale/blocked sessions without deleting
or finalizing historical records.

### Fixed

- `ask_peers` no longer synthesizes `convergence_scope.lead_peer = caller`.
  Direct ask-peers rounds have no relator unless an internal caller supplies a
  real `lead_peer`; the persisted scope records `petitioner`, canonical
  `caller`, and `acting_peer` separately.
- Direct `ask_peers` now auto-recuses peer callers from `reviewer_peers` just
  like `run_until_unanimous`, so an agent cannot vote on its own petition.
- Synchronous `run_until_unanimous` initializes new sessions with the original
  petitioner/caller, not the selected relator. Internal rounds still use the
  relator as `acting_peer`, with `lead_peer` stored separately.
- `session_start_unanimous` follows the same durable caller rule: session
  caller is always the petitioner, never a fallback relator.
- `scripts/smoke.ts` now exits explicitly after all assertions and `ok:true`
  are emitted, with optional `CROSS_REVIEW_V2_SMOKE_DUMP_HANDLES=1` diagnostics.
  This closes the Windows local-test hang where assertions passed but opaque
  handles kept `npm run smoke` / `npm test` alive until timeout.

### Added

- New MCP tool `session_doctor`: read-only operational audit over durable
  sessions. It reports open/stale/blocked/max-rounds sessions, legacy
  self-lead metadata, open evidence asks, Grok provider-error sessions, and
  token-event noise. Malformed `events.ndjson` files are reported as
  `event_read_error_sessions` and skipped for aggregation without being
  modified. It never mutates, finalizes, deletes, or rewrites sessions.
- `SessionStore.sessionDoctor(limit)` and new `SessionDoctorReport` /
  `SessionDoctorEntry` types.
- Smoke markers:
  - `ask_peers_auto_recusal_persisted_scope_test`
  - `run_until_persists_petitioner_not_lead_test`
  - `session_doctor_readonly_findings_test`
- Official provider-doc refresh report:
  `docs/reports/cross-review-v2-official-provider-docs-refresh-2026-05-05.md`.

### Changed

- Grok model guidance now reflects the official xAI split:
  `grok-4.20-multi-agent` accepts explicit `reasoning.effort`
  (`low`/`medium` = 4 agents, `high`/`xhigh` = 16 agents), while
  `grok-4-latest`, `grok-4.20`, `grok-4.20-reasoning`, and related automatic
  reasoning models omit that field.
- Grok model priority list now keeps the explicit multi-agent model first while
  reflecting current xAI general/reasoning guidance:
  `grok-4.20-multi-agent > grok-4-latest > grok-4.3 >
grok-4.20-reasoning > grok-4.20 > grok-4-1-fast > grok-4 > grok-3-fast >
grok-3`.
- `docs/model-selection.md` now records the 2026-05-05 official-doc check for
  OpenAI, Anthropic, Gemini, DeepSeek, and xAI.
- `server_info.sponsors_url` now matches the package homepage domain
  `https://cross-review-v2.lcv.dev`.
- README now lists `GROK_API_KEY`, Grok configuration examples, and
  `session_doctor`.

### Validation

- Official documentation refresh for OpenAI, Anthropic, Google Gemini,
  DeepSeek, and xAI/Grok.
- `npm run format:check`
- `git diff --check`
- `npm run lint`
- `npm run typecheck`
- `npm run smoke` (Windows, exits 0)
- `npm test` (build + smoke + runtime-smoke, exits 0)
- `npm run runtime-default-smoke` (opt-in script skipped because
  `CROSS_REVIEW_V2_REAL_API_SMOKE` is unset)
- `npm audit --audit-level=moderate` (0 vulnerabilities)
- `npm pack --dry-run --json` (105 files, package
  `@lcv-ideas-software/cross-review-v2@2.16.0`)

## [v02.15.01] - 2026-05-04

**Hotfix: `server_info` surfaces `consensus_peers` + `configured_consensus_peers_raw`.** v2.15.0 added the multi-peer judge consensus parser to `AppConfig.evidence_judge_autowire` and wired the dispatcher to honor `consensus_peers >= 2` correctly, but the `server_info` MCP tool handler at `src/mcp/server.ts:292` only serialized the v2.12.0 fields (`mode`, `peer`, `active`, `max_items_per_pass`, `configured_mode_raw`, `configured_peer_raw`). Operators setting `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS` saw no evidence of the configuration in `server_info` even though the dispatch path was using it — silent visibility regression caught when the operator inspected `server_info` after configuring 6 MCP hosts with per-host consensus peer lists.

Operator directive: every config the parser supports MUST be visible via `server_info` for operator audit. Hotfix adds the two missing fields to the serialized payload.

### Changed

- `src/mcp/server.ts` `evidence_judge_autowire` block now includes `consensus_peers: PeerId[]` and `configured_consensus_peers_raw: string`.
- New smoke marker `server_info_surfaces_consensus_peers_test` reads `src/mcp/server.ts` and asserts both property names appear in the `evidence_judge_autowire` block — locks in the regression so future field additions don't silently miss serialization again.

### Why this gap was not caught in v2.15.0

The v2.15.0 smoke marker `consensus_autowire_config_parsed_test` validated that `loadConfig()` correctly produced `consensus_peers` and `configured_consensus_peers_raw` from the env var, and the dispatch path was exercised by `judge_consensus_pass_test`. Neither test invoked the `server_info` MCP tool handler. The v2.12.0 fields were carried over from the original handler and the new fields were added to the parser without revisiting the serializer — a copy-paste-class oversight that the v2.15.1 marker now fences.

## [v02.15.00] - 2026-05-04

**v2.15.0 ships the 6 backlog items from `project_cross_review_v2_v215_backlog_candidates.md` as a single minor bump (operator directive 2026-05-04: "Quero TODOS implementados").** Driven by functional testing of v2.14.x against the real xAI API, which surfaced the `reasoning.effort` model-rejection that birthed the `feedback_consult_docs_before_amputating.md` HARD RULE. v2.15.0 codifies that rule at three levels: per-model capability allowlist (item 6), runtime 4xx docs-pointer (item 5), and operator-triggered per-call effort overrides (item 2) so dialing parameters down per-call is a first-class option rather than a config-edit detour.

### Added — Item 1: consensus-based judge autowire

New env var `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS` (comma-separated peer ids). When set with ≥ 2 enabled peers, the orchestrator dispatches to `runEvidenceChecklistJudgeConsensusPass` instead of the single-peer judge — only items where ALL configured judges return `verified-satisfied` get promoted. Falls back to single-peer (`AUTOWIRE_PEER`) when consensus isn't configured. Either path emits the same shadow vs active mutation guarantees.

- `AppConfig.evidence_judge_autowire.consensus_peers: PeerId[]` + `configured_consensus_peers_raw: string` (raw env value preserved for `server_info` debugging).
- `active` flag flips on when single peer is set OR consensus has ≥ 2 enabled peers.
- Orchestrator dispatch chooses consensus when `consensus_peers.filter(enabled).length >= 2`.
- New smoke marker `consensus_autowire_config_parsed_test`.

### Added — Item 2: per-call `reasoning_effort_overrides` MCP parameter

New optional field on `ask_peers`, `session_start_round`, `run_until_unanimous`, and `session_start_unanimous`: `reasoning_effort_overrides: Partial<Record<PeerId, ReasoningEffort>>`. When supplied, each peer's adapter reads the override from `PeerCallContext.reasoning_effort_override` (falling back to `config.reasoning_effort[peer_id]`). Operator can dial down expensive peers (Grok `grok-4.20-multi-agent` xhigh = 16 agents) for routine reviews without editing the 6 MCP configs.

- `PeerCallContext.reasoning_effort_override?: ReasoningEffort` (new field).
- `AskPeersInput` and `RunUntilUnanimousInput` carry the optional map; orchestrator propagates per-peer values into the call context (`askPeers`, `runUntilUnanimous` lead generation + revision, `callPeerForReview` recovery path).
- Wired into 4 adapters (codex/claude/grok/deepseek). Gemini has no effort knob today and silently ignores the override.
- New zod `ReasoningEffortOverridesSchema = z.record(PeerSchema, ReasoningEffortSchema).optional()` on the 4 affected MCP tools.
- New smoke marker `per_call_reasoning_effort_overrides_accepted_test`.

### Added — Item 3: `runtime-default-smoke` opt-in real-API script

New `npm run runtime-default-smoke` script. Opt-in via `CROSS_REVIEW_V2_REAL_API_SMOKE=1`; default exits 0 with "skipping" message. Exercises live provider 4xx surfaces so the docs-hint path (item 5) and per-model allowlist gate (item 6) prove themselves in production conditions, not synthetic stubs. Currently exercises Grok; extensible to other peers by editing the `PEERS_TO_TEST` env list. Returns non-zero only when the runtime should have gated a parameter that the provider rejected — a real regression — and benign reasons (auth, network) are reported as informational.

### Added — Item 4A: boot notice for non-allowlist Grok + custom effort

When the operator sets `CROSS_REVIEW_GROK_REASONING_EFFORT` to a non-default value AND the configured Grok model is NOT in the reasoning-effort allowlist, the boot notice surfaces a one-time stderr line explaining: (a) the parameter is silently dropped on this model per docs at https://docs.x.ai/docs/guides/reasoning, (b) the override has no effect, (c) the operator can switch to `grok-4.20-multi-agent` to honor it. Mirrors the existing `xhigh` warning cadence.

### Added — Item 5: 4xx parameter-rejection docs-hint enforcement

When `classifyProviderError` sees a 4xx error message that cites a named provider parameter (e.g. "Argument not supported on this model: reasoning.effort"), the failure now carries `recovery_hint: "consult_docs_then_revise"` plus a structured `docs_hint: { parameter, docs_url }` pointing at the official docs page for that parameter (xAI deep link for `reasoning.effort`, OpenAI Responses API reference, Anthropic extended thinking page, etc.). The companion `reformulation_advice` cites the workspace `feedback_consult_docs_before_amputating.md` HARD RULE verbatim and recommends the allowlist-gate fix (model-capability detection) over amputation. Surface enforces the rule at runtime so any future ship hitting a 4xx parameter rejection sees the docs link and the "do NOT amputate" guidance immediately.

- New `recovery_hint` enum value: `consult_docs_then_revise`.
- New `PeerFailure.docs_hint?: { parameter, docs_url? }` field.
- Two regex patterns (prefix form: `"<keyword>: <param>"`; suffix form: `"parameter <param> is not supported"`) to catch common 4xx shapes across providers.
- Provider docs URL maps for openai/anthropic/google/deepseek/xai with deep links for known sticky parameters (`reasoning.effort`, `thinking`).
- New smoke marker `provider_4xx_param_rejection_docs_hint_test` (canonical xAI 400 + negative case for generic 4xx).

### Added — Item 6: per-model reasoning capability allowlist (Grok)

`peers/grok.ts` exports `GROK_REASONING_EFFORT_MODELS: ReadonlySet<string>` (currently `{"grok-4.20-multi-agent"}`) plus `modelAcceptsReasoningEffort(model)`. The Grok adapter's request body conditionally includes `reasoning: { effort }` only when the configured model is in the allowlist; non-allowlist models (`grok-4-latest`, `grok-4.3`, `grok-3-fast`, etc.) get the parameter omitted and rely on xAI's automatic reasoning. This frees the operator from being locked to `grok-4.20-multi-agent` (v2.14.1 hotfix) — any Grok model now works for cross-review.

- New smoke marker `grok_reasoning_capability_allowlist_test` (positive + negative cases + Set size assertion as a future-additions guard).
- Future: when xAI exposes a model-capability discovery endpoint, replace the static set with a runtime probe + cache.

### Changed

- `package.json` version: `2.14.1` → `2.15.0`.
- 6 MCP host configs (`.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `.gemini/antigravity/mcp_config.json`, `.grok/settings.json`) now expose `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS=""` so the toggle is visible to operators and switching to consensus mode is a one-line edit (`""` → `"codex,gemini,deepseek"`).

### Smoke markers (4 new on top of v2.14.x's 51, total 55)

`grok_reasoning_capability_allowlist_test`, `consensus_autowire_config_parsed_test`, `per_call_reasoning_effort_overrides_accepted_test`, `provider_4xx_param_rejection_docs_hint_test`.

## [v02.14.01] - 2026-05-04

**Hotfix: Grok default model switched to `grok-4.20-multi-agent` so `reasoning.effort` works.** Functional verification of v2.14.0 against the real xAI API surfaced a 400: `Model grok-4-latest does not support parameter reasoningEffort`. Operator-directed re-check against official xAI docs at https://docs.x.ai/docs/guides/reasoning confirmed: only `grok-4.20-multi-agent` accepts the `reasoning.effort` parameter — all other Grok-4 models (`grok-4.3`, `grok-4-1-fast`, and the `grok-4-latest` alias that resolves to one of them) reject it with a 400. v2.14.0's default was `grok-4-latest`, hence the rejection.

Operator directive (2026-05-04): switch to the highest-capability Grok model that accepts `reasoning.effort` rather than disabling the parameter. v2.14.1 makes that switch.

### Changed

- `AppConfig.models.grok` default: `grok-4-latest` → `grok-4.20-multi-agent` in `src/core/config.ts`.
- `PRIORITY[grok]` reordered in `src/peers/model-selection.ts`: `grok-4.20-multi-agent` promoted to head, followed by the v2.14.0 entries (`grok-4-latest`, `grok-4`, `grok-3-fast`, `grok-3`) which trigger 400s when reasoning_effort is sent.
- 6 MCP host configs (`.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `.gemini/antigravity/mcp_config.json`, `.grok/settings.json`) updated `CROSS_REVIEW_GROK_MODEL` to `grok-4.20-multi-agent`.
- `peers/grok.ts` header doc updated to cite the docs verbatim and warn about the **semantic difference** of `reasoning.effort` on `grok-4.20-multi-agent` (it controls **agent count** — 4 or 16 — not chain-of-thought depth as on OpenAI/Anthropic).
- Smoke marker `grok_integration_test` updated to assert default model = `grok-4.20-multi-agent`.

### Why not just disable reasoning_effort?

Initial reflex on the 400 was to drop the parameter from the GrokAdapter body. Operator pushback: "consultou docs?" — verification showed that disabling `reasoning_effort` would silently lose access to the only Grok feature that actually controls reasoning intensity (multi-agent collaboration count). Switching the model preserves the parameter's contract while fixing the rejection.

## [v02.14.00] - 2026-05-04

**v2.14.0 ships the 7 deferred items + per-peer toggle + path-A structural fix as a single minor bump (operator scope re-framing 2026-05-04).** v2.13.0 shipped only the lead drift fix. v2.14.0 ships the rest of the 6 v2.13 backlog items (precision report, active-mode autowire, multi-peer consensus, contest_verdict, Grok integration) plus the operator-added per-peer on/off toggle and the path-A structural fix. Cross-review ship-trilaterals will use `run_until_unanimous` again now that drift fix is live.

### Added — Item 7: path-A structural fix (`attachedEvidenceBlock`)

Closes the recurring "meta-channel limit" pattern (v2.5.0 + v2.13.0): codex demanded literal evidence proportional to ship size; the MCP `caller → server` channel (200KB) couldn't carry it. Now the caller anexa via existing `session_attach_evidence` MCP tool; orchestrator's `askPeers` and `runUntilUnanimous` resolve attachments via new `SessionStore.readEvidenceAttachments(sessionId, totalCapChars)` and inline them into peer prompts via `attachedEvidenceBlock` (between review_focus and original task). Files travel `disk → server prompt → peer context window` (much wider than MCP boundary, e.g. Claude Opus 4.7 = 1M tokens, GPT-5.5 = 128K).

- New `AppConfig.prompt.max_attached_evidence_chars` (env `CROSS_REVIEW_V2_MAX_ATTACHED_EVIDENCE_CHARS`, default 80_000). Per-attachment cap at 60% of total; oldest-first ordering preserved; unreadable files silently skipped.
- New helper `attachedEvidenceBlock(attachments)` renders `## Attached Evidence` block with per-attachment header (label, relative_path, content_type, byte size, truncation note) + verbatim content.
- Wired into `buildReviewPrompt` + `buildRevisionPrompt`. Moderation-safe path deliberately excludes attachments (compact + sanitized contract).
- 2 new smoke markers: `attached_evidence_inlined_in_peer_prompt_test` (R2 prompt contains verbatim attached content + `## Attached Evidence` header), `attached_evidence_cap_respected_test` (4×30k attachments × 80k cap → output ≤ 80k).

### Added — Item 6: per-peer on/off env vars (operator directive 2026-05-04)

`CROSS_REVIEW_V2_PEER_<NAME>=on|off` (CODEX/CLAUDE/GEMINI/DEEPSEEK/GROK). Default `on`. Recognized truthy: `on/true/1/yes/enabled`. Recognized falsy: `off/false/0/no/disabled`. Unrecognized → defaults to `on` with stderr warning. Minimum 2 enabled peers — orchestrator constructor throws `InsufficientEnabledPeersError` otherwise. Lottery + dispatch filter to the enabled subset; explicit `peers[]` or `lead_peer` referencing a disabled peer hard-rejected with `PeerDisabledError`.

- New `AppConfig.peer_enabled: Record<PeerId, boolean>`.
- New `loadPeerEnabledConfig()` parser in config.ts.
- New error classes `PeerDisabledError` + `InsufficientEnabledPeersError` in orchestrator.
- `server_info.peer_enabled` payload + `peers_enabled_count`.
- 3 new smoke markers: `peer_enabled_env_parsed_test`, `peer_minimum_two_required_test`, `peer_dispatch_rejects_disabled_test`.

### Added — Item 1: precision report MCP tool

`session_judgment_precision_report({peer?, since?, session_id?})` walks `session.evidence_judge_pass.shadow_decision` events across sessions, correlates each with the matching evidence_checklist item's subsequent resurfacing behavior, and computes precision/recall/F1 per `judge_peer`. Operator uses this to validate a judge_peer's accuracy before flipping autowire to active mode (item 2).

- Classification: TP (would_promote=true, ask not resurfaced); FP (would_promote=true, ask resurfaced); TN (would_promote=false, ask resurfaced); FN (would_promote=false, ask not resurfaced).
- Decisions whose `item.last_round === judge_round` AND no later round exists are excluded as `decisions_skipped_no_ground_truth`.
- New types `JudgmentPrecisionReport` + `JudgmentPrecisionPeerStats` (per-peer counts + by_confidence buckets + first/last_seen_at).
- New `SessionStore.computeJudgmentPrecisionReport(opts)` method.
- New MCP tool `session_judgment_precision_report` (read-only, idempotent).
- 1 new smoke marker: `judgment_precision_report_test` (drives 3 askPeers rounds in shadow mode + asserts ≥1 TP).

### Added — Item 2: active-mode autowire promoted to first-class

`CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE` accepts `"active"` (was rejected as unknown in v2.12-v2.13). Active mode runs the judge AFTER aggregation/address-detection and PROMOTES verified-satisfied items via `markEvidenceItemAddressedByJudge`. Boot notice WARNS loudly when active mode is on (operator must have validated precision via item 1 first).

- `EvidenceJudgeAutowireMode` type extended to `"off" | "shadow" | "active"`.
- `evidence_judge_autowire.active` flag now `true` when mode is shadow OR active.
- Boot notice differentiated WARN vs notice for active vs shadow.
- 1 new smoke marker: `evidence_judge_autowire_active_promotes_test` (drives 2 askPeers rounds in active mode, asserts at least 1 item has `address_method="judge"`).

### Added — Item 4: contest_verdict MCP action

Per the tribunal-colegiado memory: caller READY = acata (use session_finalize); caller NOT_READY = contesta (use new `contest_verdict`). Stamps the original session's meta with a `contestation` record (timestamp + reason + original_outcome + new_session_id) and initializes a NEW session whose `contests_session_id` points back. Chain-of-custody append-only.

- New SessionMeta fields `contestation` + `contests_session_id`.
- New `SessionStore.contestVerdict(params)` method (validates final-state-only; rejects double-contestation; cross-links new session ↔ original).
- New MCP tool `contest_verdict`.
- 1 new smoke marker: `contest_verdict_chain_of_custody_test`.

### Added — Item 3: multi-peer judge consensus

New `runEvidenceChecklistJudgeConsensusPass({session_id, judge_peers, draft, mode?})` fires the judge against MULTIPLE peers in parallel; promotes ONLY when ALL peers return verified-satisfied + non-empty rationale + zero parser_warnings. Disagreement keeps the item open with `consensus_disagreement` reason + per_peer details. Reduces single-judge bias risk.

- Cost-aware: each item costs N peer calls in parallel.
- Requires ≥2 judge_peers; validates all are runtime-enabled.
- New MCP tool `session_evidence_judge_consensus_pass`.
- 1 new smoke marker: `judge_consensus_pass_test` (3 peers all verified-satisfied → promoted; disabled peer → PeerDisabledError).

### Added — Item 5: Grok integration (5th peer)

xAI's Grok joined the quinteto. Adapter at `src/peers/grok.ts` uses OpenAI Responses API surface at `https://api.x.ai/v1` (via OpenAI SDK with custom baseURL). Default model `grok-4-latest` (operator-corrected; NOT grok-4.3). Auth via `XAI_API_KEY` (canonical) with `GROK_API_KEY` fallback.

- `PEERS = [..., "grok"]` (5 entries; was 4).
- Config additions: `models.grok`, `fallback_models.grok`, `reasoning_effort.grok`, `api_keys.grok`, `cost_rates.grok`, `peer_enabled.grok`.
- COST_RATE_ENV_PREFIX adds `grok: "CROSS_REVIEW_GROK"`.
- model-selection.ts: PRIORITY[grok] = ["grok-4-latest", "grok-4", "grok-3-fast", "grok-3"]; new `grokModels(config)` lists models via `https://api.x.ai/v1`.
- registry.ts: `GrokAdapter` for real calls + `StubAdapter("grok")` for stub mode.
- **6 MCP host configs** (Claude Code, VS Code, Gemini Code Assist, Codex CLI, Antigravity, **Grok CLI** at `lcv-workspace\.grok\settings.json`) gain `GROK_API_KEY` + `CROSS_REVIEW_GROK_MODEL` + `CROSS_REVIEW_GROK_*_USD_PER_MILLION` env vars + the 5 `CROSS_REVIEW_V2_PEER_<NAME>=on` toggles (CODEX/CLAUDE/GEMINI/DEEPSEEK/GROK). Auth env var canonicalized to `GROK_API_KEY` (was `XAI_API_KEY` in initial v2.14 draft; operator correction 2026-05-04 — peer name is "grok", env var follows). The Grok CLI environment is NEW in v2.14.0 — workspace `AGENTS.md` updated from "Five MCP Environments" to "Six MCP Environments" + memory `reference_mcp_config_locations.md` updated accordingly.
- MCP zod schemas: peer enums use `PeerSchema` (auto-tracks PEERS); `peers[]` array `.max(5)` (was `.max(4)`); `judge_peers[]` for consensus pass also `.max(5)`.
- 1 new smoke marker: `grok_integration_test` (PEERS includes grok; loadConfig populates grok in all maps; 5-peer askPeers includes grok with `provider=stub-xai`; lottery occasionally picks grok).

### Fixed — CodeQL alerts #5 + #6 (`js/insecure-temporary-file`, high severity)

v2.13.0 attempted to fix these by adding `crypto.randomBytes(8)` entropy to `Date.now()`-based suffixes — but CodeQL did not recognize that pattern as a sanitizer. The alerts remained open after v2.13.0 push. v2.14.0 switches `smokeTmpDir(label)` to use `fs.mkdtempSync(prefix)`, the canonical CodeQL-recognized safe pattern. `mkdtempSync` creates the directory atomically with secure permissions and a kernel-injected unguessable suffix; both alerts close on next CodeQL scan.

### Changed

- `PEERS` constant expanded from 4 to 5 entries.
- All MCP zod schemas with `.max(4)` peer arrays bumped to `.max(5)`.
- All hardcoded `z.enum(["codex", "claude", "gemini", "deepseek"])` callsites in mcp/server.ts replaced with `PeerSchema = z.enum(PEERS)` (auto-tracks future peer additions).
- Smoke harness setup loop iterates 5 providers (added GROK) for cost-rate env defaults.
- Pre-existing relator lottery smoke markers updated for 5-peer pool: `relator_lottery_excludes_caller_test` (pool size 4 with caller excluded; operator caller pool size 5), `relator_lottery_uniform_distribution_test` (N=2000 over 4 candidates, expected 500 ±15%), `lead_peer_caller_match_rejected_test` (5-peer permutations).
- `config_evidence_judge_autowire_parsed_test`: "active" no longer treated as unrecognized; uses "TURBO" as the unknown-mode fixture.

### Smoke total

51/51 PASS (was 41/41 in v2.13.0 → +10 new markers across items 1, 2, 3, 4, 5, 6, 7).

## [v02.13.00] - 2026-05-04

**Lead_peer meta-review drift fix (item 1 of 6 v2.13 items).** Closes the v2.12 ship-blocker bug where `run_until_unanimous` lead generations on `task` phrasings starting with "Review v..." caused the lead_peer to interpret the call as meta-review (review of a review) instead of artifact-under-revision. Empirically observed in 2 v2.12 ship-trilaterals (sessions `1efd1930-...` and `25e0a8a6-...`) where ~$0.83 was burned across rounds in which the lead emitted structured `NEEDS_EVIDENCE` responses in place of refined drafts. Workaround in v2.12 was to use `ask_peers` (no lead-generation step). v2.13.0 fixes the underlying behavior so `run_until_unanimous` is reliable again — necessary precondition for shipping v2.13.1 (items 2-6) under the workspace HARD GATE.

This is the v2.13.0 sub-release; items 2-6 (precision report, active-mode auto-wire, multi-peer judge consensus, contest_verdict MCP action, Grok integration) ship in v2.13.1 once the `run_until_unanimous` cross-review surface is unblocked.

### Added

- **`SessionMode = "ship" | "review"` type** in `src/core/types.ts`. Disambiguates the caller's intent for `run_until_unanimous` and `session_start_unanimous`. `ship` (default) — `initial_draft` is the artifact under refinement, lead_peer produces a NEW REVISED VERSION as prose. `review` — `initial_draft` is the review subject, lead may emit structured responses (preserves v2.12 behavior for callers who want it).
- **`mode: SessionMode` parameter on `RunUntilUnanimousInput`** + zod schemas for `run_until_unanimous` and `session_start_unanimous` MCP tools. Default `"ship"`.
- **`leadShipModeDirective()`** prompt block injected into `buildRevisionPrompt` and `buildInitialDraftPrompt` when `mode === "ship"`. Codifies for the lead: "you are the relator producing a refined artifact (prose), NOT a peer reviewer voting; do NOT start your output with `READY`/`NOT_READY`/`NEEDS_EVIDENCE`; do NOT emit a JSON object with a `status` field; output only the revised artifact text".
- **`detectLeadDrift(generationText)` helper** + `LEAD_DRIFT_PATTERN` regex (`/^\s*[{`'"]?\s\*"?(READY|NOT_READY|NEEDS_EVIDENCE)\b/`) scanning the first 200 chars. Returns `true` when the lead's output starts with a structured peer-review status keyword — meta-review drift signature.
- **`session.lead_drift_detected` event** — fires once per drifted lead generation. Data: `{lead_peer, round_kind: "initial-draft" | "revision", consecutive_drifts (revision only), first_chars: <first 100 chars>}`. Operator-visible signal that the lead misread the call as meta-review.
- **Drift-tolerance gate**: 2 consecutive drifts on the revision path abort the session with `outcome: "aborted"` + `outcome_reason: "lead_meta_review_drift"`. A single drift preserves the prior `draft` for the next round (does NOT replace it with the lead's meta-review output), so the round loop continues with the artifact peers were actually reviewing. The drift counter resets to 0 when a non-drifted revision is observed.
- **Initial-draft drift handling**: when no `initial_draft` is provided AND the lead's INITIAL generation drifts, the session aborts immediately (no prior draft to fall back to).
- **`mode === "review"` opt-out**: drift detection runs only when `mode === "ship"`. Callers who explicitly request review semantics keep the v2.12 behavior (structured responses accepted).
- **`FORCE_DRIFT` stub marker** in `src/peers/stub.ts`. When the prompt contains `FORCE_DRIFT`, `StubAdapter.generate()` prepends `NEEDS_EVIDENCE\n\nsummary: ...` to its output so smoke tests can drive the drift detector deterministically.
- **2 new smoke markers** (39/39 PASS = 37 carry-over from v2.12.0 + 2 new):
  - `lead_drift_detected_test` — drives `runUntilUnanimous({lead=claude, peers=[claude, codex], task with FORCE_DRIFT + FORCE_NEEDS_EVIDENCE, initial_draft, max_rounds=4})`. Reviewer codex emits NEEDS_EVIDENCE per round (loop alive); lead claude generates 2 consecutive drifts. Asserts (a) ≥1 `session.lead_drift_detected` event with `lead_peer="claude"`; (b) `outcome=aborted` + `outcome_reason=lead_meta_review_drift`.
  - `lead_drift_review_mode_skipped_test` — same setup with `mode: "review"`. Asserts ZERO drift events fire (detection disabled in review mode).

### Changed

- **`buildRevisionPrompt` + `buildInitialDraftPrompt` signatures** — now take optional `mode: SessionMode` parameter (default `"ship"` for backwards-compatibility). Other callers of these functions in the orchestrator are unaffected because the default preserves prior behavior.

### Fixed (codex+gemini R1 ship-review catch + CodeQL alerts)

- **Drift detection regex hardening (codex+gemini R1 + codex+deepseek R2 catches).** The initial v2.13.0 draft had a single `LEAD_DRIFT_PATTERN` matching only the keyword-prefix shape (`NEEDS_EVIDENCE\n...`). **R1 catch (codex+gemini)**: regex would NOT match raw JSON drift `{"status":"NEEDS_EVIDENCE","summary":"..."}`. R-fix1 added a leading-brace-anchored JSON pattern. **R2 catch (codex+deepseek)**: that JSON pattern still missed markdown-fenced JSON drift (` ```json\n{...}\n``` `), a common LLM output shape. R-fix2 replaced the brace-anchored pattern with `LEAD_DRIFT_PATTERN_STATUS_FIELD = /["']?status["']?\s*:\s*["'](READY|NOT_READY|NEEDS_EVIDENCE)\b/i` — scans for the status key/value pair ANYWHERE in the 200-char window, no leading-brace anchor. Catches raw JSON, markdown-fenced JSON, JSON-LD, and any wrapper. False-positive risk capped because the value MUST be one of READY|NOT_READY|NEEDS_EVIDENCE (a draft mentioning "status bar" doesn't match). New stub markers `FORCE_DRIFT_JSON` + `FORCE_DRIFT_MD` emit raw and markdown-fenced JSON respectively. New smoke markers `lead_drift_json_detected_test` + `lead_drift_md_detected_test` verify both shapes (with first_chars assertions proving the drift event captures verbatim shape). Total smoke = 41/41 PASS.
- **CodeQL alerts #5 + #6 (`js/insecure-temporary-file`, high severity).** scripts/smoke.ts had ~25 `path.join(os.tmpdir(), cross-review-v2-...-${Date.now()})` constructions; `Date.now()` is predictable, so an attacker could pre-create a file at the predictable path before the smoke harness writes there (TOCTOU). Fix: new helper `smokeTmpDir(label)` using `crypto.randomBytes(8).toString("hex")` for unguessable suffix; bulk-refactored every call site. Closes both CodeQL alerts.

### Workaround used to ship v2.13.0 itself

Because the bug being fixed is in `run_until_unanimous`, this v2.13.0 ship review uses `ask_peers` directly (the documented v2.12 workaround). After v2.13.0 ships and the runtime reloads, subsequent ships (including v2.14.0+) can use `run_until_unanimous` again with `mode: "ship"` enabled by default.

### Trilateral outcome: majority-verified READY (path A; cross-review-v2 session `c213630b-0f29-4ac1-8aa5-daf23f2cbc3c`, 5 rounds, ~$0.89)

R5 final state: caller=claude READY + gemini READY (verified) + deepseek READY (verified) + codex NEEDS_EVIDENCE (verified, 3 asks). **75% verified READY** (3 of 4 colegiado parties). Codex's residual asks were evidence-presentation only (paste full smoke output verbatim, paste MCP handler pass-through diff for `mode`, paste threshold proof as literal log not narrative) — NOT correctness blockers. The drift detection regex hardening (R1+R2 catches), the abort-threshold logic, and the mode wiring are all unanimously verified by the trilateral; codex's residual is the same "meta-channel limit" pattern documented in v2.5.0 ship-review.

Per workspace `feedback_convergence_framing.md`, this is reported as majority-verified READY (caller + 2/3 peers, 75% of 4-party convergence). Workspace HARD GATE 2026-04-26 honored to its spirit (peer review before public ship; codex+gemini+deepseek+claude all reviewed; real bugs caught by codex+gemini in R1 and codex+deepseek in R2 were fixed and verified). Codex's R5 ask classification (presentation-format, not correctness) follows the v2.5.0 path A precedent.

### Scope re-framing for v2.14+ (operator directive 2026-05-04)

Original v2.13 plan was 6 backlog items: (1) lead drift fix, (2) precision report, (3) active-mode auto-wire, (4) multi-peer judge consensus, (5) contest*verdict MCP action, (6) Grok integration. Operator added a 7th item mid-cycle: **per-peer on/off env vars** (`CROSS_REVIEW_V2_PEER*<NAME>=on|off`, minimum 2 enabled, lottery + dispatch filter disabled peers). Operator then judged that 6 architectural items + Grok (5th peer) + per-peer toggle = 7 items deserves a minor bump (v2.14) rather than v2.13.1. v2.13.0 ships ONLY the lead drift fix; items 2-7 ship in v2.14.0.

## [v02.12.00] - 2026-05-03

**Shadow auto-wire observability — turn on the data collection that v2.11.0 shipped but left dark.** v2.11.0 delivered the relator lottery (structural safeguard against self-review) and the shadow-mode auto-wire (non-mutating judge pass), but the env vars governing the shadow pass were never set in the 5 MCP host configs, so no `session.evidence_judge_pass.shadow_decision` events were ever emitted in production. Per advisor recommendation (2026-05-03), v2.12 keeps a tight scope: turn the shadow pass on, expose the config + the resulting decision corpus through `server_info` and the dashboard, and defer the LLM-based judgment-precision report to v2.13 once a real corpus exists. v2.12 also reaffirms the cross-review-v2 mental model as a `tribunal colegiado` (operator + codex framing 2026-05-03): caller = impetrante, lead_peer = juiz relator (sorteado em v2.11+), peers = colegiado, veredito contestável via novo ciclo append-only.

### Added

- **`AppConfig.evidence_judge_autowire`** + parser in `core/config.ts`. New typed struct `EvidenceJudgeAutowireConfig` with fields `mode: "off"|"shadow"|string`, `peer: PeerId|undefined`, `active: boolean`, `max_items_per_pass: number`, `configured_mode_raw: string`, `configured_peer_raw: string`. The `string` widening on `mode` lets a typo (e.g. `"ACTIVE"`) survive without throwing — the boot notice still warns the operator, and `active` reports whether the runtime will actually fire the shadow pass. Source of truth read once at boot; orchestrator + boot notice now share one parsed struct instead of three independent env reads.
- **`server_info.evidence_judge_autowire`** payload — operators inspecting `server_info` see `mode`, `peer` (or `null` if invalid), `active` flag, `max_items_per_pass`, and the raw env values. Closes the v2.11.0 follow-up where shadow could be silently misconfigured (env empty / typo) and the only signal was a one-shot boot notice on stderr.
- **`SessionStore.aggregateShadowJudgments(sessionId?)`** — walks `events.ndjson` per session, filters `session.evidence_judge_pass.shadow_decision` events, aggregates by `judge_peer` into `ShadowJudgmentPeerStats {decisions_total, would_promote, would_skip_satisfied_unverified, would_skip_not_satisfied, by_confidence: {verified, inferred, unknown}, first_seen_at, last_seen_at}`. Returns `ShadowJudgmentRollup {decisions_total, would_promote_total, by_judge_peer}`. Walks the event log per session (O(events) per call); acceptable for v2.12 because the corpus is bounded.
- **`RuntimeMetrics.shadow_judgment`** — `metrics()` now returns the shadow-judgment rollup so MCP `session_metrics` and the dashboard share one observability surface.
- **Dashboard panel "Judge shadow (decisões observadas)"** — sortable table grouped by `judge_peer` with decisions, would_promote count + rate, skipped (satisfied-but-unverified vs not-satisfied), confidence buckets (verified/inferred/unknown), first_seen_at, last_seen_at. Empty state hint: "Ative o judge shadow setando CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE=shadow + \_PEER=codex".
- **Two new smoke markers** (mantém a base v2.11.0 → 35 + 2 = 37 markers):
  - `config_evidence_judge_autowire_parsed_test` — verifies `loadConfig().evidence_judge_autowire` honors valid `MODE=shadow + PEER=codex`, rejects unknown peer (`peer=undefined`, `active=false`), preserves unknown mode raw (`mode="active"` for `MODE=ACTIVE`), and treats empty env as `mode="off"`.
  - `metrics_shadow_judgment_rollup_test` — drives 2 askPeers rounds in shadow mode (1 generates the open ask, 1 forces FORCE_NEEDS_EVIDENCE + FORCE_JUDGE_SATISFIED so the judge runs against the open item with verified verdict), then asserts `aggregateShadowJudgments()` records ≥1 decision + ≥1 would_promote + ≥1 verified-confidence + populated first/last_seen_at; `metrics().shadow_judgment.decisions_total` matches direct call.

### Changed

- **`core/orchestrator.ts` autowire path** — replaced inline env reads with `this.config.evidence_judge_autowire`. The config struct is the single source of truth; future call sites read from one place.
- **`core/orchestrator.ts:runEvidenceChecklistJudgePass` cap** — replaced inline `Number.parseInt(process.env.CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS ?? "8", 10)` with `this.config.evidence_judge_autowire.max_items_per_pass`. The 1..100 hard floor/ceiling stays as a defensive guard. **R1 ship-review note**: codex flagged a subtle behavior divergence in the initial v2.12 draft (parser used `intEnv()` which has a `parsed > 0` filter, changing the orchestrator's clamp result for negative env values from 1 to 8). Restored exact pre-v2.12 semantics: parser now uses `Number.parseInt(env ?? "8", 10)` directly (no positive-only filter), so negative values flow through and the orchestrator's `Math.max(1, Math.min(100, cap))` clamps them to 1 as before. Negative `MAX_ITEMS_PER_PASS` is still operator-typo territory; the fix is to preserve EXACT prior behavior, not to "improve" it silently.
- **`mcp/server.ts` boot notice** — same migration as the orchestrator: notice now reads from `runtime.config.evidence_judge_autowire`. Behavior identical (single warning per boot when shadow misconfigured); implementation simpler.

### Operational rollout

- **`CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE=shadow` + `_PEER=codex`** added to the 5 MCP host configs (Claude Code, VS Code, Gemini Code Assist, ChatGPT Codex, Google Antigravity). codex chosen as judge because its peer-review rigor empirically surfaces real correctness defects (see `feedback_peer_review_rigor.md`); same rigor likely transfers to the judge role. Until shadow_decisions accumulate, the choice is provisional — v2.13 precision report will validate empirically and may swap to a different peer.

### Mental model (codified, no code change)

- **`tribunal colegiado` framing reaffirmed** (operator + codex 2026-05-03 refinement): caller = impetrante, `lead_peer` sorteado = juiz relator, peers = colegiado de juízes, votos = respostas estruturadas peer (READY/NOT_READY/NEEDS_EVIDENCE), veredito = síntese colegiado, contestação = caller pede novo ciclo deliberativo dentro dos mesmos autos (não reinício). Caller never votes as peer — only `READY` (acata) or `NOT_READY` (contesta). Memory `project_cross_review_v2_tribunal_colegiado_model.md` now carries the precise jurisprudential mapping table.

### Deferred to v2.13+

- **Active-mode auto-wire** — promote shadow's verified-satisfied verdicts to actual `markEvidenceItemAddressedByJudge` mutations. Premature without the precision report.
- **Judgment precision report** (`session_judgment_precision_report` MCP tool) — walk sessions, correlate `shadow_decision` events with subsequent peer behavior, compute precision/recall/F1 per `judge_peer`. Prereq: sufficient shadow corpus (collected by v2.12 + a few weeks of real cross-review traffic).
- **Multi-peer judge consensus** — fire shadow against 2 or 3 peers in parallel, count agreement. Cheap with shadow because no mutations; useful signal for active-mode confidence.
- **Judge-induced retry on "unknown" confidence** — small polish; revisit after precision data.
- **First-class `contest_verdict` MCP action** — formalize the `caller NOT_READY → novo ciclo` path so contestation preserves audit trail without manual session re-init.

## [v02.11.00] - 2026-05-03

**Relator lottery (auto-recusal) + shadow-mode auto-wire of the v2.9.0 judge pass.** v2.11.0 bundles two items: (1) the relator lottery — a structural safeguard that prevents an agent from reviewing its own submission, modeled on judicial colegiados (operator directive 2026-05-03 after v2.10.0 wasted ~$2 USD across 4 trilaterals where caller=claude was also lead_peer=claude); and (2) the shadow-mode auto-wire originally planned for v2.10.0 (data-collection surface for the v2.9.0 judge pass before flipping to active mutation in v2.12+). The v2.10.0 release was rolled into v2.11.0 because v2.10's trilateral never converged validly under the broken self-review pattern.

### Added (relator lottery — new in v2.11.0)

- **`src/core/relator-lottery.ts` module.** Exports `assignRelator(caller, sessionPeers?)` (RNG via `crypto.randomInt` over `sessionPeers \ {caller}` — falls back to `PEERS \ {caller}` when the subset is omitted), `assertLeadPeerNotCaller(caller, leadPeer, sessionPeers?)` (throws `CallerCannotBeLeadPeerError` on self-review AND `LeadPeerNotInSessionError` when the explicit lead is not a participating peer), and `resolveLeadPeer(caller, leadPeer?, sessionPeers?)` that combines the two: when leadPeer omitted → lottery; when supplied → validate non-self AND in-session. **Session-peers-aware** (deepseek catch from R-fix trilateral): pre-fix, the lottery filtered the global `PEERS` constant, so a peer subset like `["codex","gemini"]` could produce a non-participating relator. Post-fix the lottery only picks from peers actually participating in the session.
- **`caller` parameter on `RunUntilUnanimousInput`** + MCP schemas for `run_until_unanimous` and `session_start_unanimous`. Type: `PeerId | "operator"`. Default `"operator"` preserves v2.10.0 behavior (no exclusion). When set to a peer id, activates the lottery + self-recusal validation.
- **`lead_peer` is now optional on the MCP schemas** (was `.default("codex")` in v2.10.0). When omitted with `caller === "operator"` the orchestrator still picks `"codex"` (v2.10.0 default preserved). When omitted with a peer caller, the lottery picks one of the 3 non-caller peers.
- **`session.relator_assigned` event** — fires once per session when the lottery assigns a relator. Data: `{caller, candidate_pool, assigned, entropy_source: "crypto.randomInt", kind: "lottery"}`. Audit-trail-grade — operators can reconstruct the random draw post-hoc.
- **`CallerCannotBeLeadPeerError`** — dedicated error class thrown when a caller explicitly passes `lead_peer === caller`. Message: `"caller_cannot_be_lead_peer: <caller> cannot review own submission. Submit without lead_peer to trigger automatic relator lottery, or pick a different non-caller peer (codex|claude|gemini|deepseek)."`. No silent fallback to lottery — operator must fix the call.
- **Auto-recusal from reviewer pool (operator clarification 2026-05-03).** The caller is now also stripped from `input.peers` (the reviewer list) before the lottery runs and before any reviewer round dispatches. The auto-recusal is **per-session**: a peer that is the caller in this session is excluded here, but stays available as a reviewer in OTHER sessions where it is not the petitioner.
- **`LeadPeerNotInSessionError`** — thrown when an explicit `lead_peer` is supplied but is not present in the session peers list. Prevents the orchestrator from assigning a non-participating relator.
- **`entropy_source: "crypto.randomInt" | "explicit"`** on `RelatorAssignment`. Lottery assignments tag `"crypto.randomInt"`; explicit-leadpeer assignments tag `"explicit"` so audit trails can distinguish the two paths without reading the kind discriminant. (Pre-fix, both tagged `"crypto.randomInt"` — misleading because the explicit path uses no RNG.)
- **Six new smoke markers** (4 lottery + 2 R-fix):
  - `relator_lottery_excludes_caller_test` — 100 sorteios com caller=claude → assigned ∈ {codex,gemini,deepseek}; nunca claude. Plus 50 sorteios cada com caller=codex/gemini/deepseek (simetria) e 1 sorteio com caller=operator (pool size 4, sem exclusão).
  - `relator_lottery_uniform_distribution_test` — 1500 sorteios com caller=claude. Counts dos 3 não-caller dentro de ±15% de 500 cada. Guard contra `Math.random` slipping in.
  - `lead_peer_caller_match_rejected_test` — `assertLeadPeerNotCaller("claude", "claude")` joga `CallerCannotBeLeadPeerError`. Variantes válidas (caller=claude + lead=codex/gemini/deepseek) e operator caller também testadas.
  - `relator_assigned_event_emitted_test` — `runUntilUnanimous({caller: "claude", lead_peer: undefined})` emite exatamente 1 evento `session.relator_assigned` com `caller`, `candidate_pool` (3 peers, sem claude), `assigned`, `entropy_source: "crypto.randomInt"`, `kind: "lottery"`.
  - `relator_lottery_session_peers_aware_test` (R-fix) — subset com `peers=["codex","gemini"]` + caller=claude → assigned ∈ subset, nunca deepseek. Subset com 1 peer → assigned é exatamente esse peer. Subset apenas com caller → `no_eligible_relator`. Explicit `lead_peer="deepseek"` com session=`["codex","gemini"]` → `LeadPeerNotInSessionError`. Explicit válido → `entropy_source: "explicit"`.
  - `relator_auto_recusal_filters_session_peers_test` (R-fix) — `runUntilUnanimous({caller: "claude", peers: ["codex","claude","gemini"]})` → caller removido do pool antes do lottery; `candidate_pool` retornado no evento tem 2 peers (codex+gemini), sem claude.

### Added (shadow-mode auto-wire — originally drafted for v2.10.0, lifted into v2.11.0)

- **`mode: "active" | "shadow"` parameter on `runEvidenceChecklistJudgePass`** in `core/orchestrator.ts`. Default `"active"` preserves the v2.9.0 contract (verified-satisfied judgments call `markEvidenceItemAddressedByJudge`). `"shadow"` routes the same per-item branches into a non-mutating path that records each verdict in a new `shadow_decisions` array on the return shape and emits `session.evidence_judge_pass.shadow_decision` events. The `started` and `completed` events also carry `mode` in `data` so dashboards can distinguish runs.
- **`shadow_decisions: Array<{item_id, would_promote, satisfied, confidence, parser_warnings, rationale_empty, rationale}>`** on the orchestrator return shape and the MCP tool result. Always empty in active mode.
- **`session.evidence_judge_pass.shadow_decision` event** — fires once per judged item in shadow mode. Data: `item_id`, `would_promote` (bool), `satisfied`, `confidence`, `judge_peer`. The `would_promote` flag is `true` only when the active path would have promoted (satisfied + verified + non-empty rationale + zero parser_warnings); all other verdicts carry `false`.
- **askPeers auto-wire hook** — fires AFTER `runEvidenceChecklistAddressDetection` and BEFORE convergence finalization. Reads `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE` (`off | shadow`, case-insensitive, default `off`) and `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER` (one of `codex|claude|gemini|deepseek`). When mode=`shadow` and peer is valid, calls `runEvidenceChecklistJudgePass({mode: "shadow", draft: input.draft, round: round.round})`. Misconfiguration emits `session.evidence_judge_pass.autowire_skipped` (unknown mode, missing peer) or `session.evidence_judge_pass.autowire_failed` (judge call threw). Misconfig NEVER throws.
- **MCP tool optional `shadow_mode: boolean`** on `session_evidence_judge_pass`. Default `false` keeps the v2.9.0 active contract; `true` forwards `mode: "shadow"` to the orchestrator.
- **Boot-time notice** in `mcp/server.ts main()` for AUTOWIRE env-var validation. Three branches: invalid mode → notice + skip. mode=shadow but peer missing/invalid → notice + skip. mode=shadow + valid peer → notice acknowledging shadow mode active. All notices via `console.error`; runtime never throws on stray env values.
- **Three smoke markers (carry-over from v2.10.0 draft)**:
  - `evidence_judge_autowire_off_no_calls_test` — env unset → askPeers fires zero `session.evidence_judge_pass.*` events.
  - `evidence_judge_autowire_shadow_emits_decision_test` — env=`shadow` + peer=`claude`. R1 produces a NEEDS_EVIDENCE item; R2 with `FORCE_NEEDS_EVIDENCE FORCE_JUDGE_SATISFIED` draft → `shadow_decision` event fires for the seed item with `would_promote=true`; on-disk status remains `open`.
  - `evidence_judge_autowire_shadow_does_not_promote_test` — direct invariant: explicit `runEvidenceChecklistJudgePass({mode: "shadow"})` with FORCE_JUDGE_SATISFIED draft yields `promoted.length === 0`, `shadow_decisions.length === 1` with `would_promote=true`, no `addressed` history entry, no `address_method` set on disk.

### Behavioral change (operator-visible)

- **Auto-recusal is now structural.** Any caller (peer agent) submitting via MCP must pass `caller: "<own-id>"` and either omit `lead_peer` (lottery picks a non-caller) or pass `lead_peer` of a different peer. Passing `lead_peer === caller` is hard-rejected with `CallerCannotBeLeadPeerError`.
- **Operator callers preserve v2.10.0 behavior.** When `caller` is omitted (defaults to `"operator"`) or explicitly set to `"operator"`, no exclusion applies and the v2.10.0 default `lead_peer="codex"` kicks in for omitted lead.
- **Shadow auto-wire env knobs** `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE` (default `off`) and `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER` (no default; required when mode=shadow). When configured, every `askPeers` round adds one judge call per open checklist item (capped via `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS`, default 8). Judge cost tracked through the same FinOps path as generations.
- Default behavior (no env set, no caller passed) is identical to v2.10.0 / v2.9.0.

### Validation

- **`npm run typecheck`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with PASS markers for the 4 lottery + 3 shadow auto-wire markers plus all v2.7-v2.9 carry-overs.
- **Cross-review-v2 trilateral session [pending]** caller=claude, lead_peer omitido (sorteio) ou explícito ≠claude. HARD GATE 2026-04-26 + Self-Review Prohibition (2026-05-03) enforced before push.

### Out of scope (deferred to v2.12+)

- **Active-mode auto-wire** (mutating). Will ship after v2.11 shadow data shows acceptable single-judge precision.
- **Multi-peer judge consensus.**
- **Judgment caching across rounds.**
- **Judge-induced retry on `unknown` confidence.**

### Note: v2.10.0 was never released

- v2.10.0 was drafted with the shadow auto-wire bundle but its trilateral cross-review never converged validly because the caller (claude) set `lead_peer=claude` — auto-loop of self-review producing meta-review drift. After 4 trilateral attempts (~$2 USD spent), operator detected the violation and authorized rolling v2.10.0's deliverables into v2.11.0 alongside the relator lottery as the structural safeguard. The pre-v2.11 git tags jump from `v2.9.0` directly to `v2.11.0`; no `v2.10.0` tag exists in the repo.

### Added

- **`mode: "active" | "shadow"` parameter on `runEvidenceChecklistJudgePass`** in `core/orchestrator.ts`. Default `"active"` preserves the v2.9.0 contract (verified-satisfied judgments call `markEvidenceItemAddressedByJudge`). `"shadow"` routes the same per-item branches into a non-mutating path that records each verdict in a new `shadow_decisions` array on the return shape and emits `session.evidence_judge_pass.shadow_decision` events. The `started` and `completed` events also carry `mode` in `data` so dashboards can distinguish runs.
- **`shadow_decisions: Array<{item_id, would_promote, satisfied, confidence, parser_warnings, rationale_empty, rationale}>`** on the orchestrator return shape and the MCP tool result. Always empty in active mode.
- **`mode: "active" | "shadow"`** on the `session.evidence_judge_pass.completed` and `started` event payloads.
- **`session.evidence_judge_pass.shadow_decision` event** — fires once per judged item in shadow mode. Data: `item_id`, `would_promote` (bool), `satisfied`, `confidence`, `judge_peer`. The `would_promote` flag is `true` only when the active path would have promoted (satisfied + verified + non-empty rationale + zero parser_warnings); all other verdicts carry `false`. This is the operator-facing signal for empirical judgment quality.
- **askPeers auto-wire hook** — fires AFTER `runEvidenceChecklistAddressDetection` and BEFORE convergence finalization. Reads `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE` (`off | shadow`, case-insensitive, default `off`) and `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER` (one of `codex|claude|gemini|deepseek`). When mode=`shadow` and peer is valid, calls `runEvidenceChecklistJudgePass({mode: "shadow", draft: input.draft, round: round.round})`. Misconfiguration paths emit `session.evidence_judge_pass.autowire_skipped` (unknown mode, missing peer) or `session.evidence_judge_pass.autowire_failed` (judge call threw). Misconfig NEVER throws — a typo cannot break a paying review round.
- **MCP tool optional `shadow_mode: boolean`** on `session_evidence_judge_pass`. Default `false` keeps the v2.9.0 active contract; `true` forwards `mode: "shadow"` to the orchestrator. Operators can dogfood shadow on individual items without enabling the env-driven auto-wire.
- **Boot-time notice** in `mcp/server.ts main()`. Three branches: (1) `MODE` is set to a value other than `off`/`shadow` → notice + skip. (2) `MODE=shadow` but `PEER` missing/invalid → notice + skip. (3) `MODE=shadow` + valid peer → notice acknowledging shadow mode is active. Notices go to `stderr`; runtime never throws on stray env values.
- **Three new smoke markers**:
  - `evidence_judge_autowire_off_no_calls_test` — env unset → askPeers fires zero `session.evidence_judge_pass.*` events. Locks in the v2.9.0 backcompat contract.
  - `evidence_judge_autowire_shadow_emits_decision_test` — env=`shadow` + peer=`claude`. R1 produces a NEEDS_EVIDENCE item; R2 with `FORCE_NEEDS_EVIDENCE FORCE_JUDGE_SATISFIED` draft (peer raises ask again to keep it open after address detection; judge says verified-satisfied) → `shadow_decision` event fires for the seed item with `would_promote=true`; on-disk status remains `open`; `address_method` and `judge_rationale` remain undefined.
  - `evidence_judge_autowire_shadow_does_not_promote_test` — direct invariant: explicit `runEvidenceChecklistJudgePass({mode: "shadow"})` with FORCE_JUDGE_SATISFIED draft yields `promoted.length === 0`, `shadow_decisions.length === 1` with `would_promote=true`, no `addressed` history entry, no `address_method` set on disk. Mirrors the v2.8.0/v2.9.0 terminal-preservation pattern but for the shadow code path.

### Behavioral change (operator-visible)

- New env knobs `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE` (default `off`) and `CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER` (no default; required when mode=shadow). When configured, every `askPeers` round adds one judge call per open checklist item (capped via the existing `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS`, default 8). Judge cost is tracked through the same FinOps path as generations — operators see real spend even in shadow mode.
- Default behavior (no env set) is identical to v2.9.0; nothing changes for callers that have not opted in.
- Shadow-mode runs leave the evidence checklist byte-identical to a no-judge run: state, status, audit history are all untouched. Only events are added.

### Validation

- **`npm run typecheck`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with PASS markers for the v2.10.0 trio plus all v2.7-v2.9 carry-overs.
- **Cross-review-v2 trilateral session [pending]** caller=claude, peers=codex+gemini+deepseek. HARD GATE 2026-04-26 enforced before push.

### Out of scope (deferred to v2.11+)

- **Active-mode auto-wire** (mutating). Will ship after v2.10 shadow data shows acceptable single-judge precision.
- **Multi-peer judge consensus.**
- **Judgment caching across rounds.**
- **Judge-induced retry on `unknown` confidence.**

## [v02.09.00] - 2026-05-03

**LLM-based satisfied detection for the Evidence Broker (operator-triggered judge pass).** v2.8.0 closed the architectural backlog with heuristic resurfacing-inference (1-round-late signal: a peer that does not bring an ask back next round → addressed). v2.9.0 adds the explicit second signal that was deferred: an operator-triggered LLM judge pass that reads `(ask, draft)` pairs and rules whether the new draft satisfies each open ask. Confidence floor is `verified` only; `inferred` and `unknown` leave items open. Operator-set terminal statuses (`satisfied`/`deferred`/`rejected`) and items already auto-promoted are NEVER touched. Surface is one MCP tool only — auto-wiring into `askPeers` is intentionally deferred to v2.10+ until empirical judgment quality data is available.

### Added

- **`EvidenceChecklistItem.address_method?: "resurfacing" | "judge"`** + **`judge_rationale?: string`** in `core/types.ts`. Operator-set terminal statuses do not populate either; both are cleared on revert to `open` and on operator transition. Sessions saved by v2.8.x have neither field — items are still treated as `addressed` with method unknown until the next runtime mutation.
- **`EvidenceAskJudgment` interface** with `satisfied`, `confidence` (`verified | inferred | unknown`), `rationale`, plus the same FinOps fields as `PeerResult` (`usage`, `cost`, `latency_ms`, `attempts`, `parser_warnings`).
- **`PeerAdapter.judgeEvidenceAsk(ask, draft, context)`** method. Default implementation in `BasePeerAdapter` builds a tightly-scoped JSON-output prompt (ask + draft only, no session history per design), routes through `this.generate()` so cost is accounted by the same path as generations, and parses the response into `EvidenceAskJudgment`. Stub adapter overrides with deterministic FORCE*JUDGE*\* markers (`FORCE_JUDGE_SATISFIED` → verified satisfied, `FORCE_JUDGE_INFERRED` → satisfied but inferred, `FORCE_JUDGE_UNKNOWN` → unknown, `FORCE_JUDGE_PARSE_FAIL` → invalid JSON for parser warnings).
- **`SessionStore.markEvidenceItemAddressedByJudge(sessionId, itemId, params)`** — atomic open→addressed promotion under `withSessionLock`. Returns `null` when the item is not currently open (already addressed, terminal, or missing) so the caller skips emit. Sets `address_method = "judge"`, `addressed_at_round`, `judge_rationale` (capped 800 chars), and appends a runtime history entry with `note: "judge[<peer>]: <rationale>"`.
- **`CrossReviewOrchestrator.runEvidenceChecklistJudgePass(params)`** — walks open items (optionally filtered by `item_ids`), capped at `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS` (default 8, hard-bounded 1..100), calls `judge_peer.judgeEvidenceAsk(item.ask, draft, context)` per item, promotes only when `satisfied && confidence === "verified"`, classifies the rest as `satisfied_but_unverified` / `not_satisfied` / `judge_failed`. Failures (network/timeout/parse) never crash the pass — they are recorded in the `skipped` array with the error message.
- **Three new orchestrator events**:
  - `session.evidence_judge_pass.started` — fires at pass entry; data carries `judge_peer`, `items_queued`, `capped`.
  - `peer.judge.completed` — per-item judgment ruling; data carries `item_id`, `satisfied`, `confidence`, `parser_warnings`.
  - `session.evidence_judge_pass.completed` — fires at pass exit; data carries `judge_peer`, `promoted_count`, `skipped_count`, `capped`. The existing `session.evidence_checklist_addressed` event also fires per promoted item with `data.method === "judge"` so dashboards can distinguish runtime sources.
- **`session_evidence_judge_pass` MCP tool.** Inputs: `session_id` (UUIDv4), `judge_peer` (one of `codex|claude|gemini|deepseek`), `draft` (1..200 000 chars), optional `item_ids` (array of hex item ids), optional `round`, optional `review_focus`. Returns the orchestrator's `{promoted, skipped, judged_count, capped}` summary. The tool is purely operator-triggered — no auto-wire in `askPeers`.
- **Backfill of `address_method = "resurfacing"`** in the v2.8.0 `runEvidenceChecklistAddressDetection` path. Items promoted by resurfacing-inference in v2.9.0+ sessions now carry the attribution; the existing reopen path also clears the new fields. Operator transitions clear all three runtime-set fields (`addressed_at_round` + `address_method` + `judge_rationale`) per the type-system invariant.
- **Promotion-gate hardening (codex R1 catch).** Before mutating state via `markEvidenceItemAddressedByJudge`, the orchestrator additionally requires `judgment.parser_warnings.length === 0` AND `judgment.rationale.trim().length > 0`. A judgment with `satisfied=true, confidence="verified"` but missing rationale OR populated parser_warnings is reclassified as `skipped.reason === "judge_failed"` with the warning surfaced in `message`, and a `peer.judge.failed` event is emitted with `parser_warnings` + `rationale_empty` flags. Pre-fix, a malformed JSON response defaulted to `satisfied=false, confidence="unknown"` and silently fell through to `not_satisfied`; post-fix it surfaces explicitly as `judge_failed`. The fix was prompted by codex during the v2.9.0 trilateral cross-review session `59d04035-8265-462f-be47-53659b433bb4`.
- **Four new smoke markers**:
  - `evidence_judge_marks_addressed_when_verified_satisfied_test` — happy path: R1 produces 1 open item via `FORCE_NEEDS_EVIDENCE`; judge pass with `FORCE_JUDGE_SATISFIED` draft promotes to addressed, populates `address_method="judge"` + `judge_rationale`, appends history entry with `note` starting `judge[claude]:`, emits `session.evidence_checklist_addressed` with `data.method === "judge"`.
  - `evidence_judge_skips_when_inferred_or_unknown_test` — confidence floor: `FORCE_JUDGE_INFERRED` and `FORCE_JUDGE_UNKNOWN` drafts both leave the item `open`, populate `skipped[]` with the correct reason and confidence, never set `address_method`.
  - `evidence_judge_preserves_terminal_statuses_test` — operator workflow regression guard: 5-item fixture (open + satisfied + deferred + rejected + already-addressed). Judge pass with universal `FORCE_JUDGE_SATISFIED` MUST queue only the 1 open item (`judged_count === 1`), promote only that one, leave the 3 terminal items + the already-addressed item byte-identical on disk. Mirrors the v2.8.0 `evidence_checklist_terminal_preservation_test` but for the judge code path.
  - `evidence_judge_rejects_malformed_response_test` — locks in the codex R1 promotion-gate fix. `FORCE_JUDGE_PARSE_FAIL` draft → judge response without a JSON object → `parser_warnings` populated → MUST classify as `skipped.reason === "judge_failed"` with the parser warning surfaced in `message`. Asserts the item stays `open`, `address_method` stays unset, and `peer.judge.failed` event fires.

### Behavioral change (operator-visible)

- New env knob `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS` (default 8) caps how many items are judged per call; excess items return in `capped: true` with `judged_count < n_open`. The cap is per-pass, not cumulative — operators can call the tool again to drain remaining items.
- Items promoted by the judge carry `address_method: "judge"` and a populated `judge_rationale`; items promoted by the v2.8.0 resurfacing-inference now carry `address_method: "resurfacing"`. Dashboards and `session_read` consumers can distinguish runtime sources without reading the history trail.
- Terminal operator statuses remain non-negotiably operator-owned. The judge will not promote, demote, or otherwise mutate `satisfied`/`deferred`/`rejected` items. Same rule as v2.8.0's resurfacing-inference; `SessionStore.TERMINAL_STATUSES` set membership is the single source of truth.

### Validation

- **`npm run typecheck`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 26 PASS markers (22 carry-over from v2.8.0 + 4 new).
- **Cross-review-v2 trilateral cross-review** — production-test of the v2.8.0 Evidence Broker lifecycle (resurfacing-inference fired in session `59d04035`, auto-promoted 1 ask to `addressed` between rounds; prompt block filtered to open-only). Initial session `59d04035-8265-462f-be47-53659b433bb4` aborted at `max_rounds` (~$0.67) after codex caught the real promotion-gate bug. Fix applied; fresh trilateral session `d45f9734-1724-46b7-940e-9e4e8a90d0a3` converged **unanimous_ready in 1 round** (~$0.19, all 3 peers READY) with verbatim corrected source inline. Total v2.9.0 trilateral cost ~$0.86. Per workspace `feedback_peer_review_rigor.md`, codex's R1 catch surfaced a real correctness defect that would have shipped without the trilateral.

### Out of scope (deferred to v2.10+)

- **Auto-wire of judge pass in `askPeers`** — runs before reviewers when env-configured. Defers until empirical judgment quality is observed.
- **Multi-peer judge consensus** — currently one judge_peer per pass.
- **Judgment caching across rounds** — if the same `(ask, draft_hash)` pair repeats, re-judging is the current behavior.
- **Judge-induced retry on `unknown` confidence** — left as `skipped`; operator can re-run with a different judge_peer.

## [v02.08.00] - 2026-05-03

**Per-provider health dashboard + Evidence Broker lifecycle (Codex+Gemini audit, last architectural item).** Bundles three independent features that all extend v2.7.0's Evidence Broker plus the per-provider rollup that closes the original audit list. (a) Per-peer health metrics expose READY rate, NEEDS_EVIDENCE rate, total/avg cost, parser warnings, and rejected_total grouped by `failure_class`, surfaced in `RuntimeMetrics.per_peer_health` and rendered as a sortable table in the dashboard. (b) Address detection auto-promotes `EvidenceChecklistItem` from `open` to `addressed` via resurfacing-inference: if a peer that asked for evidence in round N does not bring the same ask back in round N+1, the runtime concludes the ask was satisfied and emits a `session.evidence_checklist_addressed` event. The conflict rule when a peer brings an addressed item back is documented and exercised by smoke. (c) New MCP tool `session_evidence_checklist_update` lets the operator move items to terminal statuses (`satisfied`, `deferred`, `rejected`) or back to `open` with an optional note; every transition appends an entry to a durable `evidence_status_history` audit trail.

### Added

- **`PeerHealthSummary` interface** in `core/types.ts` — `peer`, `results_total`, `ready_count`, `not_ready_count`, `needs_evidence_count`, `unresolved_count`, `ready_rate`, `needs_evidence_rate`, `avg_cost_usd`, `total_cost_usd`, `parser_warnings_total`, `rejected_total`, `failures_by_class`. `RuntimeMetrics.per_peer_health` carries the rollup keyed by `PeerId`.
- **`SessionStore.metrics()` per-peer rollup.** Single pass over all rounds accumulates per-peer counts, costs (excluding `source: "stub"` entries to avoid skewing FinOps numbers with synthetic test runs), parser warnings, and rejection counts grouped by `failure_class`. Computed rates are clamped to 0 when `results_total === 0`.
- **`EvidenceChecklistStatus` type union** — `"open" | "addressed" | "satisfied" | "deferred" | "rejected"`. Items without `status` are treated as `"open"` for back-compat with sessions saved by v2.7.x.
- **`EvidenceStatusHistoryEntry` interface** + `SessionMeta.evidence_status_history` — durable audit trail. Each entry: `ts`, `item_id`, `from`, `to`, `by: "runtime" | "operator"`, optional `round`, optional `note`. Newest-appended ordering.
- **`SessionStore.runEvidenceChecklistAddressDetection(sessionId, currentRound)`** — atomic resurfacing-inference pass under the session lock. Open items whose `last_round < currentRound` are promoted to `addressed` and stamped with `addressed_at_round`. Items already `addressed` whose `last_round === currentRound` (i.e. aggregation just bumped them) revert to `open` and clear `addressed_at_round`. Terminal operator statuses are NEVER auto-changed; the method returns a `peer_resurfaced_terminal` collection so the orchestrator can emit a visibility event.
- **`SessionStore.setEvidenceChecklistItemStatus(sessionId, itemId, status, options)`** — operator workflow mutator. `status` parameter type excludes `"addressed"` to enforce the rule that runtime alone owns auto-promotion. Appends a history entry every time, even on no-op calls, so the audit captures explicit operator intent.
- **`session_evidence_checklist_update` MCP tool.** Inputs: `session_id` (UUIDv4), `item_id` (16-hex sha256 prefix), `status` (`"open" | "satisfied" | "deferred" | "rejected"`), optional `note`. Returns the mutated item + appended history entry.
- **Three new orchestrator events**:
  - `session.evidence_checklist_addressed` — fires when at least one item was auto-promoted to addressed in the current round; data carries `ids` + `count`.
  - `session.evidence_checklist_reopened` — fires when at least one previously-addressed item reverted to open because the peer resurfaced it; data carries `ids` + `count`.
  - `session.evidence_checklist_peer_resurfaced_terminal` — fires when a peer brought back an item that the operator had explicitly closed (status preserved); data carries `items: [{id, peer, status}]`.
- **Dashboard "Saúde por provider" card.** Sortable table rendering `per_peer_health` with `Resultados`, `READY`, `NEEDS_EVIDENCE`, `NOT_READY`, `READY rate`, `NE rate`, `Custo total`, `Custo médio`, `Parser warns`, `Rejections`. Sorted by `results_total` descending so the most-active peer appears first. Refreshes alongside the existing metrics card.
- **`SessionStore.TERMINAL_STATUSES` static readonly Set** — the runtime checks `TERMINAL_STATUSES.has(status)` instead of an `||` chain to avoid any future refactor accidentally writing the buggy `(status === "satisfied" || "deferred" || "rejected")` truthy-OR form (always-truthy because non-empty strings are truthy in JS/TS). Codex+deepseek surfaced this regression risk during the R1 of the v2.8.0 trilateral; the explicit Set membership is type-safe and idiomatic.
- **Four new smoke markers**:
  - `evidence_checklist_terminal_preservation_test` — locks in the rule that `runEvidenceChecklistAddressDetection` NEVER auto-mutates terminal items and that an open item resurfaced in the current round is not misclassified under `peer_resurfaced_terminal`. 5-item fixture with one of each status (open/satisfied/deferred/rejected/addressed) all at `last_round === currentRound`. Asserts: open stays open (no auto-promote, no terminal misclassification), terminals all reported and preserved on disk, addressed reverts to open, addressed/reopened sets exclude terminal ids.
  - `evidence_checklist_address_detection_test` — R1 with `FORCE_NEEDS_EVIDENCE` produces 1 open item; R2 with a clean draft (no marker) auto-promotes it to addressed, populates `addressed_at_round`, appends a runtime history entry, and emits `session.evidence_checklist_addressed`.
  - `evidence_checklist_operator_status_update_test` — `setEvidenceChecklistItemStatus(itemId, "satisfied", {note})` mutates status, appends operator-attributed history, persists across `store.read()`, leaves the open-set empty. A second call to `"deferred"` confirms `from` correctly reflects the prior `"satisfied"` state.
  - `per_peer_health_metrics_test` — mixed askPeers round (claude FORCE_NEEDS_EVIDENCE + codex default READY) yields `per_peer_health[claude].ready_rate === 0`, `[codex].ready_rate === 1`, both peers' `avg_cost_usd === null` (stub zero-cost excluded from FinOps totals), `rejected_total === 0`.

### Behavioral change (operator-visible)

- The "Outstanding Evidence Asks" prompt block now filters to items in `open` status only. Items auto-marked `addressed` or operator-closed (`satisfied`/`deferred`/`rejected`) are omitted from the prompt so peers focus on what is still outstanding. The dashboard and `session_read` continue to surface the full checklist with status badges.
- Sessions running through `runUntilUnanimous` will see fewer recurring asks per round once R1's items have been satisfied and the inference promotes them. Sessions where peers cycle through the same blocker repeatedly will see the `[seen N rounds]` tag continue to escalate (round_count keeps incrementing even while status flips back to open).
- Operators can now mark items as `deferred` (out of scope for this session) or `rejected` (ask itself unfounded) without losing the audit trail. The peer-resurfaced-terminal event surfaces when a peer keeps demanding something the operator explicitly closed — useful for noticing peer/operator disagreement without acting on it automatically.

### Validation

- **`npm run typecheck`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 22 PASS markers (18 carry-over from v2.7.0 + 4 new: `evidence_checklist_terminal_preservation_test`, `evidence_checklist_address_detection_test`, `evidence_checklist_operator_status_update_test`, `per_peer_health_metrics_test`).
- **Cross-review-v2 trilateral session `41237780-4639-4c9d-8b56-902ea6e36267`** caller=claude, peers=codex+gemini+deepseek, 2 rounds, ~$0.55 USD. **Outcome: converged unanimous_ready** (all 4 parties READY in R2). R1: codex+deepseek caught a suspicious truthy-OR predicate shorthand in the inline excerpt I sent (`(status==="satisfied"||"deferred"||"rejected")` would have been always-truthy); gemini READY R1. The actual production code already used the correct explicit form, but the trilateral correctly flagged the regression risk. R2: applied a defensive refactor to `SessionStore.TERMINAL_STATUSES.has(status)` Set membership + added the `evidence_checklist_terminal_preservation_test` regression smoke marker. Trilateral converged unanimous READY. (An earlier session `092356b9-6974-40ee-b0fa-d6faf6ab7826` ran 7 rounds and aborted with `lead_peer_meta_review_drift_pivoting_to_initial_draft` because `run_until_unanimous` had the lead generate a meta-review instead of substantive content; the fix was to provide the evidence package directly via `initial_draft`.)

### Deferred to v2.9+

- LLM-based "satisfied" detection (uses peer judgment of the new draft against open asks) is a candidate for v2.9 if the heuristic resurfacing-inference proves insufficient in practice. The architectural backlog from the original Codex+Gemini audit is closed with this release.

## [v02.07.00] - 2026-05-03

**Evidence Broker (Codex+Gemini audit item #1).** Empirical analysis of 253 historical sessions surfaced 200+ NEEDS_EVIDENCE blockers across peers, with many sessions repeating the same `caller_request` across multiple rounds without explicit acknowledgement. v2.7.0 adds a per-session "evidence checklist" that aggregates every NEEDS_EVIDENCE peer's `caller_requests` into a deduplicated, persistent list. Each subsequent revision prompt now surfaces the running checklist as a "Outstanding Evidence Asks" block, so the caller can no longer drift past unaddressed asks unintentionally.

### Added

- **`SessionMeta.evidence_checklist?: EvidenceChecklistItem[]`** in `core/types.ts`. Each item carries a stable id (`sha256(peer + ":" + ask)`, 16 hex chars), the originating peer, the verbatim ask, the first/last round it surfaced in, the cumulative `round_count`, and ISO timestamps for first/last sighting. Sorted by first_round → peer → ask for stable ordering.
- **`SessionStore.appendEvidenceChecklistItems(sessionId, round, incoming)`** in `core/session-store.ts`. Takes a list of `{ peer, ask }` pairs from one round, deduplicates against the existing checklist by id, and bumps `round_count` + `last_round` + `last_seen_at` for resurfacing asks. Identity is `sha256(peer + ":" + trimmed_ask).slice(0, 16)`. Whitespace-only asks are skipped. Persisted via `withSessionLock` for concurrent-write safety.
- **Post-round aggregation hook** in `core/orchestrator.ts:askPeers`. After every successful `appendRound`, walks `peers` for NEEDS_EVIDENCE entries, collects their `structured.caller_requests`, and feeds them to `appendEvidenceChecklistItems`. Emits a new `session.evidence_checklist_updated` event with the running totals.
- **`evidenceChecklistBlock(meta)` prompt helper** in `core/orchestrator.ts`. Renders the checklist as a Markdown section with `- **<peer>** (R<first_round>[ seen N rounds]): <ask>` per item. Repeated asks (`round_count > 1`) get a `[seen N rounds]` tag so the caller sees stickiness at a glance.
- **`buildRevisionPrompt` injection.** The "Outstanding Evidence Asks" block is injected after the Review Focus block and before the Original Task section in every revision prompt that runs against a session with a non-empty checklist. Initial-draft and review-round prompts are unchanged.
- **`evidence_broker_aggregate_dedupe_test` smoke marker.** Drives 2 askPeers rounds with FORCE_NEEDS_EVIDENCE on claude (stub returns the same `caller_request` both rounds). Verifies: (a) R1 produces exactly 1 checklist item with `round_count=1`, `first_round=1`, `last_round=1`; (b) R2's same ask does NOT duplicate — it bumps `round_count=2`, `last_round=2`; (c) both rounds emit `session.evidence_checklist_updated`; (d) the verbatim caller_request "Remove the test marker." is preserved.

### Behavioral change (operator-visible)

- Sessions running `runUntilUnanimous` now see revision prompts that explicitly enumerate every outstanding `caller_request` from prior rounds. Sessions where peers converge on R1 (no NEEDS_EVIDENCE) see no change — the checklist stays empty and the prompt block is omitted. Sessions where peers cycle through repeated NEEDS_EVIDENCE will see the `[seen N rounds]` tag escalate in subsequent prompts, surfacing the stickiness.
- New event type `session.evidence_checklist_updated` appears in `events.ndjson` after every round that aggregated at least one new or resurfacing ask. Operators monitoring `session_events` can read this to detect "session is making no evidence progress" patterns.

### Validation

- **`npm run build`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 18 PASS markers (17 carry-over from v2.6.1 + 1 new: `evidence_broker_aggregate_dedupe_test`).
- **Cross-review-v2 trilateral session `734aa133-c9cf-44d2-875d-75afa077c884`** caller=claude, peers=codex+gemini+deepseek, 2 rounds, ~$0.34 USD. **Outcome: converged unanimous_ready** (all 4 parties READY). R1 codex caught a real protocol contradiction in `evidenceChecklistBlock` wording — it said "NEEDS_EVIDENCE on R1 is acceptable" while session-start contract rule #1 says R1 NEEDS_EVIDENCE is a draft defect. R2 applied codex's verbatim suggested fix ("R1 NEEDS_EVIDENCE indicates missing upfront evidence in the original draft (a draft defect per session-start contract rule #1); any same ask resurfacing in R2+ is additionally a revision defect.") — all 3 peers verified-READY in R2. Per `feedback_peer_review_rigor.md`: codex's rigor surfaced a real bug that gemini+deepseek both missed.

### Deferred to v2.7.1+ (small follow-ups)

- **Address detection.** v2.7.0 does not auto-mark items as "addressed" when the new draft mentions/satisfies the ask. Heuristic detection (substring/similarity match against the new draft) is the v2.7.1 follow-up. v2.8+ may use an LLM-based judgment call.
- **Operator workflow** for marking items as "satisfied" / "deferred" / "rejected" explicitly via a dedicated MCP tool.

### Deferred to v2.8+ (architectural)

- **Per-provider health dashboard** (Codex+Gemini): READY rate, NEEDS_EVIDENCE rate, average cost, parser warnings per provider. Builds on the existing dashboard server.

## [v02.06.01] - 2026-05-03

**Hard budget gate replication for fallback + moderation-recovery paths (v2.6.1 backlog item from v2.5.0/v2.6.0 deferral).** Pre-v2.6.1 only the format-recovery branch refused paid recoveries that would breach `max_session_cost_usd`; the fallback and moderation-safe-retry branches still proceeded silently after their `cost_alert` events. v2.6.1 brings them in line: each branch now evaluates `priorRoundsCost + estimate > sessionCostLimit` BEFORE the paid call and surfaces a `peer.fallback.budget_blocked` / `peer.moderation_recovery.budget_blocked` event + `failure_class: budget_preflight` failure if the projected spend would exceed the limit.

### Added

- **Hard budget gate at the fallback path** in `orchestrator.ts:callPeerForReview`. The gate runs after `peer.fallback.cost_alert` and before `fallback.call(prompt, context)`. Returns a `budget_preflight` `PeerFailure` if the gate fires; the fallback iteration continues with the next configured fallback adapter (or terminates if none remain).
- **Hard budget gate at the moderation-recovery path** in `orchestrator.ts:callPeerForReview`. Mirrors the fallback gate but uses the moderation-safe prompt for the estimate (smaller than the original prompt because `buildModerationSafeReviewPrompt` caps the draft at 16 KiB instead of the full `max_draft_chars`).
- **`format_recovery_hard_budget_gate_test` smoke marker** (deferred from v2.5.0 / v2.6.0 — finally landed). Uses a 15 KiB filler draft to make `recoveryEstimate ≈ preflightEstimate`, so the actual first-call cost (input × rate, no amplification) suffices to push `prior + first_call + recoveryEstimate` past the limit while preflight still passes. Verifies `peer.format_recovery.budget_blocked` event fires + `failure_class: budget_preflight` failure is recorded.

### Behavioral change (operator-visible)

- Sessions running close to `max_session_cost_usd` may now see fallback or moderation retries refused with `failure_class: budget_preflight` instead of silently overrunning. Sessions with adequate budget see no change. Operators monitoring `events.ndjson` will see new `peer.fallback.budget_blocked` and `peer.moderation_recovery.budget_blocked` event types when the gate fires.

### Validation

- **`npm run build`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 17 PASS markers (16 carry-over from v2.6.0 + 1 new: `format_recovery_hard_budget_gate_test`).
- **Cross-review-v2 trilateral session `f7c6b8b6-9f0f-4f80-b5e2-6686c709b9a7`** caller=claude, peers=codex+gemini+deepseek, 3 rounds. Outcome: gemini READY (verified, 3×), deepseek READY (verified, 3×), codex NEEDS_EVIDENCE (3×). Codex's residual is a meta-channel/evidence-packaging concern (acknowledged in R3 that the fallback-id symmetry argument is plausible; under-proves the moderation smoke-gap because moderationSafePrompt size depends on more than just the draft cap). Operator escalation chose **path A** (same as v2.5.0/v2.6.0 ships): ship with codex residual documented, v2.6.2 backlog tracks any post-commit refinements. Majority-verified READY (caller + 2/3 peers).

### Smoke coverage gap (intentionally documented)

- `peer.fallback.budget_blocked` and `peer.moderation_recovery.budget_blocked` smoke markers are NOT included. These two gates use the same arithmetic shape as preflight (`prior + estimate > limit`, same limit from `budgetLimit(config)`, same per-call estimate because prompt and adapter are identical), so the budget window where preflight passes AND the gate fires is mathematically empty in stub-driven smoke. The format-recovery gate is testable because it adds the already-incurred `currentPeerFirstCallCost`; fallback and moderation gates run BEFORE any peer-side cost is recorded. The gates are exercised in production where prior session totals accumulate over multiple rounds and actual provider costs vary from preflight estimates. Code review of `orchestrator.ts:callPeerForReview` validates the gate logic.

### Deferred to v2.7+ (architectural, unchanged)

- **Evidence Broker** (Codex+Gemini #1).
- **Per-provider health dashboard** (Codex+Gemini).

## [v02.06.00] - 2026-05-03

**Token-delta event compaction (Codex+Gemini audit, item A) + bundled v2.5.0 format hotfix.** Empirical measurement of 253 historical sessions surfaced 96 282 of 98 664 events (97.6%) as `peer.token.delta` — by far the dominant noise in `events.ndjson` files. v2.6.0 coalesces streaming token deltas in the adapter layer before emitting the event, dramatically reducing event-log volume without changing the total content streamed. Same release also bundles the prettier format fix that was reported as the v2.5.0 CI #31 failure (format-only, no functional impact).

### Added

- **`TokenEventBuffer` class in `peers/base.ts`.** Coalesces deltas before emit. Flushes either when the buffered length crosses the byte threshold (default 1024 chars) OR when time-since-last-flush crosses the ms threshold (default 250 ms), whichever fires first. `complete()` flushes the remainder and emits `peer.token.completed`.
- **`createTokenEventBuffer()` factory on `BasePeerAdapter`.** Each adapter call constructs the buffer once and uses `tokenStream.append(delta)` per chunk + `tokenStream.complete(text.length)` at end, replacing direct `emitTokenDelta` / `emitTokenCompleted` calls.
- **Verbose escape hatch `CROSS_REVIEW_V2_TOKEN_DELTA_VERBOSE=1`.** When set, every chunk emits immediately (legacy v2.5.x chunk-level behavior). Useful for operators who want maximum token-stream observability.
- **Two env knobs**: `CROSS_REVIEW_V2_TOKEN_DELTA_BYTES_THRESHOLD` (default 1024) and `CROSS_REVIEW_V2_TOKEN_DELTA_MS_THRESHOLD` (default 250) for tuning the coalesce thresholds without rebuild.

### Fixed

- **Prettier format on v2.5.0 files.** `CHANGELOG.md`, `scripts/smoke.ts`, and `src/core/orchestrator.ts` failed `npm run format:check` on v2.5.0 commit `cd0f040` (CI run #25283189042). Reformatted via `npm run format`. No functional changes.

### Migrated

- All 5 streaming adapters (`stub`, `openai`, `anthropic`, `gemini`, `deepseek`) — both the `call()` and `generate()` paths — now use `TokenEventBuffer` instead of direct `emitTokenDelta`/`emitTokenCompleted`. The legacy methods stay as primitives that the buffer flushes through.

### Behavioral change (operator-visible)

- Default-mode sessions emit ~10-20× fewer `peer.token.delta` events. A 50-chunk response that previously fired 50 events will fire ~3-5 coalesced events with the same total `chars` reported. Set `CROSS_REVIEW_V2_TOKEN_DELTA_VERBOSE=1` to restore legacy granularity.

### Validation

- **`npm run build`** clean.
- **`npm run format:check`** clean (the v2.5.0 CI failure is now resolved).
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 16 PASS markers (13 carry-over + 3 new): `token_delta_event_compaction_test` verifies that 50 32-char chunks produce <50 delta events in default mode and exactly 50 in verbose mode; `token_delta_stall_timer_test` proves the setTimeout-based flush fires during stream stalls (Gemini R1 fix); `token_delta_complete_try_finally_test` proves `complete()` emits `peer.token.completed` even if final `flushDelta` throws (Codex R1 fix).
- **Cross-review-v2 trilateral session `cc0a5fff-7e72-4daf-91c9-08079c269f64`** caller=claude, peers=codex+gemini+deepseek, 5 rounds, total cost ~$0.50 USD. Outcome: **converged unanimous_ready** (all 4 parties READY). R1 surfaced 2 real bugs that I fixed in v2.6.0 itself: Gemini caught the missing setTimeout for time-based flush during stream stalls; Codex caught the missing try/finally in `complete()`. R2-R5 closed evidentiary gaps for codex on the bundled prettier hotfix (literal full diff finally satisfied).

### Deferred to v2.6.1+ (carried from v2.5.1 backlog)

- Hard budget gate replication for fallback + moderation-recovery paths.
- Smoke marker for `peer.format_recovery.budget_blocked` (stub `output_tokens=text.length` arithmetic prevents a clean budget window — needs a unit-test fixture).
- Post-commit inspectable artifact for codex re-review of v2.5.0/v2.6.0 changes.

### Deferred to v2.7+ (architectural)

- **Evidence Broker** (Codex+Gemini #1): translate peer NEEDS_EVIDENCE asks into a structured per-round checklist that the next prompt explicitly addresses. Major design (changes session schema + prompt builders + status-parser).
- **Per-provider health dashboard** (Codex+Gemini): READY rate, NEEDS_EVIDENCE rate, average cost, parser warnings per provider.

## [v02.05.00] - 2026-05-03

**Operator-driven evidence-and-budget hardening pass + Codex/Gemini empirical-audit fold-ins.** Empirical analysis of 253 historical sessions (Codex audit 2026-05-03) surfaced concrete, measurable gaps that this release closes. Operator authorized a scope of 4 originals + 3 Codex fixes + 1 Gemini fix + 1 env knob; all shipped together with smoke coverage.

### Added

- **Differentiated per-field caps in `core/status.ts`.** `MAX_FIELD_LENGTH = 800` was tripping mostly on `summary` (verbose verdicts) while `evidence_sources` was rarely used at all. Replaced with `MAX_SUMMARY_LENGTH=800` (kept), `MAX_EVIDENCE_LENGTH=2500`, `MAX_REQUEST_LENGTH=1500`. Schema, parser truncation warnings, and `statusInstruction()` directive all use the per-field cap.
- **Session-start contract directive helper `sessionContractDirectives()` in `core/orchestrator.ts`.** Four mandatory rules injected into every caller/peer prompt builder (review, moderation-safe, revision, initial-draft): (1) R1 evidence-upfront — caller drafts must embed concrete evidence (file paths with line numbers, grep output, diff hunks, MD5 hashes, log excerpts) inline; (2) anti-verbosity (Claude named explicitly — historical worst offender for summary truncation in the corpus); (3) compactness symmetry — caller drafts obey the same compactness budget peers do; (4) caller finalize obligation — invoke `session_finalize` immediately on unanimous READY. Resolves the 22 in-progress orphan sessions Codex measured in the corpus.
- **`statusInstruction()` rewrite.** Now surfaces the per-field budget guidance ("summary SHORT 800 chars; detail belongs in evidence_sources up to 2500 chars; caller_requests/follow_ups up to 1500 chars each") and a Claude-named anti-verbosity rule.
- **`SessionStore.abortStaleSessions()`** companion to `clearStaleInFlight()`. Walks `outcome === undefined` sessions whose `updated_at` is older than the threshold (default 24h via `CROSS_REVIEW_V2_STALE_HOURS`), skips active in-flight or live-lock sessions, marks `outcome=aborted` + `outcome_reason=stale_no_finalize_<hours>h`. Wired into `mcp/server.ts` boot path next to the in-flight sweep.
- **`CROSS_REVIEW_V2_DEFAULT_MAX_ROUNDS` env var** (default 8). `config.budget.default_max_rounds` replaces the hardcoded 8 in `runUntilUnanimous`. The MCP zod schema still caps caller-supplied values at 32.
- **Auto-grant +1 round logic in `runUntilUnanimous`.** When a session reaches its ceiling with caller READY + every peer in `{READY, NEEDS_EVIDENCE}` + zero NOT_READY/rejected, the orchestrator grants one extra round so the caller can address the evidence asks. `AUTO_GRANT_CEILING = 2` and a deterministic `blockerFingerprint(peers)` (NEEDS_EVIDENCE peers + sorted `caller_requests`) prevent successive grants on the same asks. Emits `session.auto_round_granted` and `session.auto_round_skipped`. Targets the 22 max-rounds aborts Codex measured in the corpus.
- **`peer.fallback.cost_alert` and `peer.moderation_recovery.cost_alert` events.** Pre-v2.5.0 only `peer.format_recovery.cost_alert` notified FinOps consumers about paid recoveries; the fallback and moderation-safe paths were silent. Codex measured 11 `format_recovery.started` events with only 2 cost-alert siblings — the fallback/moderation paths skewed the ratio. Both events now mirror the format-recovery shape with `estimated_extra_cost_usd`.
- **Hard budget gate at format-recovery.** Pre-v2.5.0 `peer.format_recovery.cost_alert` was advisory; the paid recovery proceeded even when `current_session_cost + estimated_extra > max_session_cost_usd`. Now the orchestrator refuses the recovery, marks the peer with `failure_class: budget_preflight`, and emits `peer.format_recovery.budget_blocked` with structured cost data.

### Fixed

- **Stub adapters no longer attribute real currency.** Codex measured `US$ 39,255` of phantom spend by stubs in the 253-session corpus (`source: "stub"` was missing; cost rates were applied to character-count tokens). `peers/stub.ts` now overrides every `PeerResult.cost` and `GenerationResult.cost` with a canonical zero-cost estimate tagged `source: "stub"` (added to the `CostEstimate.source` enum in `core/types.ts`). Token usage is preserved for telemetry. A test-only escape hatch `CROSS_REVIEW_V2_STUB_FORCE_REAL_COST=1` lets smoke validate `budget_exceeded` enforcement.
- **Convergence reason surfaces per-peer `failure_class`.** The legacy `"one or more peers failed or did not respond"` (47 occurrences in the corpus, every one equally unactionable) is replaced with `"peers failed or did not respond: claude:network, gemini:rate_limit, codex:missing"`. The reason field stays a single string; granularity comes from enumerating peer + failure_class for every contributor.
- **Stub `generate()` propagates FORCE\_\* test markers.** Pre-v2.5.0 the stub passed a 1200-char slice of the prompt as the synthetic body. The v2.5.0 contract directive injection lengthened the prompt header beyond the 1200-char window, breaking multi-round smoke tests that rely on FORCE\_\* marker continuity (e.g. budget-exceeded driving claude with FORCE_NOT_READY across 3 rounds). Fixed by detecting carried markers in the input prompt and prefixing them to the generated body.

### Behavioral changes (operator-visible)

- Auto-grant changes the practical max-rounds ceiling from `default_max_rounds` (default 8) to `default_max_rounds + AUTO_GRANT_CEILING` (default 10) for sessions that would converge with one more revision round. The grant gate is restricted to caller-READY + only-NEEDS_EVIDENCE blockers; repeat-blocker fingerprint prevents pathological spending. Sessions with NOT_READY peers or rejected peers see no behavior change.
- Format-recovery hard budget gate converts a previously-advisory cost alert into a session-blocking decision when the next paid recovery would arithmetically breach `max_session_cost_usd`. Sessions with adequate budget see no change; sessions running close to the cap may now surface `failure_class: budget_preflight` instead of silently overrunning.
- Smoke unconditionally overrides `CROSS_REVIEW_V2_DATA_DIR` to a fresh `os.tmpdir()` path even when the operator sets the env var. This was previously honored via a `||` fallback, but operators who set it to point at the live runtime directory (`~/.cross-review/data` etc.) saw smoke pollute their session history AND inherit stale orphan sessions that broke deterministic assertions. Documented in the smoke header.

### Validation

- **`npm run build`** clean (TypeScript 6.0.3, exit 0).
- **`npm run smoke`** EXIT=0 with 13 PASS markers, 9 of them new for v2.5.0:
  - `summary_cap_differentiation_test`
  - `session_contract_directives_test`
  - `default_max_rounds_env_honored_test`
  - `stale_session_aborted_24h_test`
  - `stale_session_skipped_when_running_test`
  - `stub_zero_cost_test`
  - `convergence_structured_failure_reason_test`
  - `auto_grant_evidence_only_then_skipped_repeat_test`
  - `auto_grant_blocked_by_not_ready_test`
- **`npm run lint`** clean (eslint . --max-warnings=0).
- **Cross-review-v2 trilateral session `5419e29a-7d99-4c49-99c5-1b28316a9071`** caller=claude, peers=codex+gemini+deepseek, 4 rounds. Outcome: gemini READY (verified, 4×), deepseek READY (verified, 3×), codex NEEDS_EVIDENCE (4×). Codex's residual was a meta-channel limit — the full 60 KB diff exceeded the MCP message budget once protocol overhead was factored in, so codex could not independently verify the diff line-by-line despite each round's increasingly detailed code excerpts (R3 inlined the bug-fix diff for the format-recovery cost gate; R4 inlined orchestrator.ts:1058-1172 verbatim). Operator escalation chose path A: ship with codex's residual documented and a v2.5.1 follow-up to provide a post-commit inspectable artifact (commit hash + per-file split-diff) for codex re-review. This release is therefore majority-verified READY (caller + 2/3 peers) with a known structural blocker rather than a code blocker.

### Deferred to v2.5.1 (small follow-ups)

- **Hard budget gate also for fallback and moderation-recovery paths.** v2.5.0 only gates format-recovery (the most common chargeable retry); replicating the same `current_session_cost + estimated_extra > limit` check at the fallback and moderation-recovery sites is a small, self-contained follow-up that fits a patch release.
- **Smoke marker for `peer.format_recovery.budget_blocked`.** The format-recovery hard-budget gate is exercised by code path inspection (orchestrator.ts:1095-1140) and TypeScript compilation, not by a dedicated stub-driven smoke marker in v2.5.0. Reason: stub `output_tokens=text.length` (~80 chars) is much smaller than `max_output_tokens` (default 20K), so estimatedPeerRoundCost over-estimates relative to actual cost and there is no clean budget window where preflight passes but the gate fires deterministically without flake-prone arithmetic. v2.5.1 will introduce a shared harness that covers the gate at all three retry sites with the budget tuning resolved.

### Deferred to v2.6+ (architectural)

- **Token-delta event compaction.** 96 282 of 98 664 events in the 253-session corpus are `peer.token.delta`. Operators can opt out via `CROSS_REVIEW_V2_STREAM_TOKENS=0` today; an architectural buffered-emit refactor is deferred.
- **Evidence Broker** (Codex audit recommendation #1): translate peer NEEDS_EVIDENCE asks into a structured checklist for the next round; deferred as a major design.
- **Cost reconciliation peer×total.** Historical `meta.json` rows have `mergeCost(peer_costs) !== totals.cost.total_cost` drift; a migration pass is risky without versioned cost-algorithm tagging — deferred.
- **Provider-health dashboard.** New observability surface; deferred.
- **Two parallel directive sources.** `statusInstruction()` in `status.ts` and `sessionContractDirectives()` in `orchestrator.ts` both encode Claude-named anti-verbosity and per-field budget rules; not identical and at risk of drifting. Tech-debt note — extract a shared `peerProtocolRules.ts` later.

## [v02.04.01] - 2026-05-02

**CI hotfix for the v2.4.0 stub fail-fast gate.** The v2.4.0 P1.1 fix throws when `CROSS_REVIEW_V2_STUB=1` is set without confirmation. CI workflow `ci.yml` already passed `CROSS_REVIEW_V2_STUB=1` to the smoke step, but `mcp/server.ts` had a top-level `main().catch(...)` that ran on every module import — including the smoke harness's `import { SessionIdSchema, pruneCompletedJobs } from "../src/mcp/server.js"`. In CI, that import-time `main()` saw STUB=1 without confirmation (because confirmation is only set inside `scripts/smoke.ts`'s body, after ESM imports resolve) and tripped the gate. Locally the test passed only because the host env did not pre-set STUB.

### Fixed

- **`mcp/server.ts` top-level `main()` guard.** `main()` now runs only when the module is invoked as the entry point (canonical ESM `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` check). Importing named exports (`SessionIdSchema`, `pruneCompletedJobs`, `JobStatus`) no longer triggers a server boot, so the smoke harness can validate the schema without spinning up a real orchestrator.
- **`.github/workflows/ci.yml` + `publish.yml`.** Belt-and-suspenders: both workflows now also set `CROSS_REVIEW_V2_STUB_CONFIRMED: "1"` alongside `CROSS_REVIEW_V2_STUB: "1"` so the gate is satisfied even if a future change reintroduces import-time side effects.

### Validation

- `CROSS_REVIEW_V2_STUB=1 npm run smoke` (reproducing the CI failure scenario without the confirmation flag) — EXIT=0 GREEN with all four `[smoke]` markers PASS.
- `CROSS_REVIEW_V2_STUB=1 CROSS_REVIEW_V2_STUB_CONFIRMED=1 npm test` — EXIT=0 GREEN.

## [v02.04.00] - 2026-05-02

**Audit-closure hardening pass.** Closes 18 priorities + 5 misc items from the internal v2.3.3 technical opinion audit. Mirrors the v1 v1.6.7 cycle. Additive within the v2.x public surface plus three behavioral changes flagged below.

### Added

- **`STREAM_TEXT_MAX_BYTES = 16 MiB` per peer call.** Anthropic, OpenAI, Gemini and DeepSeek streaming buffers now reject responses that exceed the cap before the SDK materializes the final message. The retry layer classifies the overflow as a regular failure so the caller observes a structured rejection instead of an OOM.
- **`StreamBuffer` class in `peers/base.ts`** with O(1) per-append byte accounting (running counter; never re-scans the accumulated buffer). Refined after cross-review-v2 R3 caught an O(N²) regression in the initial `appendStreamText` shim. The shim is preserved for stateless callers but production adapters use the class form.
- **`SessionStore.sweepOrphanTmpFiles()`** removes `*.<pid>.<ts>.<nonce>.tmp` artifacts left behind by interrupted writes (P1.3 companion).
- **`SessionStore.clearStaleInFlight()`** clears `meta.in_flight` when the lock holder PID is dead OR `started_at > 30 min`. Wired into `mcp/server.ts` boot path alongside `sweepOrphanTmpFiles`.
- **MCP tool schema caps.** `task` (32 KiB), `draft` (200 KiB), `initial_draft` (200 KiB) now declare `.max()` so oversized inputs are rejected at the schema layer before the parser/spawn/persistence layers touch them.
- **`MAX_PAYLOAD_BYTES = 64 KiB` byte-level guard before `JSON.parse`** in `core/status.ts`. Hostile peers can no longer OOM the orchestrator with a giant `<cross_review_status>` block.
- **Retry-After header extraction.** `errors.ts` now reads `Retry-After` from `error.headers` (fetch shape) and `error.response.headers` (legacy shape) and populates `failure.retry_after_ms`. The retry loop already consumes that field.
- **5xx gateway errors are retryable.** 502/503/504 transient gateway responses are no longer collapsed into the generic `provider_error` non-retryable class.
- **`AbortSignal` propagation in Gemini.** Both `call()` and `generate()` now pass `context.signal` to the GoogleGenAI SDK, so `session_cancel_job` can interrupt in-flight Gemini requests instead of waiting for the natural response.
- **Boot stub double-confirmation (fail-fast).** `CROSS_REVIEW_V2_STUB=1` alone now THROWS at startup; activation requires `NODE_ENV=test` OR `CROSS_REVIEW_V2_STUB_CONFIRMED=1`. Guards production deploys against accidental stub activation via stray dotenv variables AND preserves operator intent — flag-only users (local dev, CI offline, budget kill) are NOT silently billed for real provider calls. Refined after cross-review-v2 R1 caught a financial-safety regression in the initial fallback design.
- **`SECURITY.md` Threat Model section.** Documents the single-user trusted-host assumption, multi-host concurrency caveats, dashboard binding, stub safety, schema caps, streaming caps and `OPENAI_BASE_URL` precedence.
- **Dashboard CSP + clickjacking headers.** The HTML response now ships `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Format-recovery quota.** Per-session cap of 6 recoveries; subsequent peer parser failures report `failure_class: "format_recovery_exhausted"` instead of triggering more paid recovery calls.

### Fixed

- **`atomicWriteFile` retry on Windows.** Pre-v2.4.0 `fs.renameSync` failures with `EPERM`/`EACCES`/`EBUSY`/`EEXIST` left orphan `.tmp` files in the session directory. v2.4.0 retries with backoff (10/20/40/80/160 ms × 5), adds a `crypto.randomBytes(2)` nonce to the tmp filename, and unlinks the tmp on terminal failure. Mirrors v1 v1.6.7 P1.2.
- **`JSON.parse` failures now contextualized.** `readJson()` wraps parse errors with the source file path so audit consumers see WHICH file is malformed instead of a bare `SyntaxError`.
- **`SessionIdSchema` lowercase normalization.** UUIDv4 regex was already case-insensitive but zod did not normalize the output. v2.4.0 transforms to lowercase before downstream consumers see the value, eliminating the TOCTOU surface on case-sensitive filesystems.
- **`CROSS_REVIEW_V2_DATA_DIR` tilde expansion.** `~`, `~/...` and `~\...` are now expanded to `os.homedir()` before `path.resolve()`.
- **Retry backoff jitter.** `retry.ts` now applies full jitter (random in [0, capped]) to the exponential backoff so concurrent peers hitting the same provider do not synchronize their retries (thundering herd).
- **Convergence strict equality.** `p.status == null` (loose) replaced with `=== null || === undefined` so a future code path producing `""` or `0` would not be misclassified as `NEEDS_EVIDENCE`.
- **Model-selection nullish coalescing.** `config.models[peer] || PRIORITY[peer][0]` replaced with `??` so an explicit `null` fallback is preserved.
- **`appendEvent` in-memory monotonic seq counter.** Pre-v2.4.0 `seq` was recomputed by reading + counting the events file inside the session lock; the counter is now cached per session_id and incremented strictly monotonically. Restart re-initializes from disk.
- **`redact()` env-style assignments.** Patterns like `PASSWORD=value`, `API_KEY: token`, `Authorization: Bearer ...` are now redacted while preserving the key name for audit observability.
- **Cost preflight includes retry/fallback amplification.** `estimatedPeerRoundCost` multiplies by `min(4, retry.max_attempts + len(fallback_models))` so the budget gate is conservative against the worst-case retry chain.
- **Model-selection env override validation.** Overrides outside the documented PRIORITY list are honored but flagged with `confidence: "inferred"` so a typo surfaces here instead of as a provider 404 mid-round.

### Behavioral changes (operator-visible)

- `CROSS_REVIEW_V2_STUB=1` alone now BOOTS WITH REAL ADAPTERS. Set `NODE_ENV=test` or `CROSS_REVIEW_V2_STUB_CONFIRMED=1` to opt in deliberately. Stderr prints a loud notice for both paths.
- `convergence_scope` enum unchanged (no new values introduced — equivalent to v1 v1.6.7 P2.6 wisdom that adding a new prefix would break enum-validating consumers).
- Session ids returned from MCP tools are always lowercase (case-insensitive UUIDs accepted, lowercase output).

### Validation

- `npm run format:check`
- `npm run lint`
- `npm test` (build + smoke + runtime-smoke).

### Pre-commit cross-review

- Cross-review-v2 quadrilateral session `13690e71-7205-4b46-837d-7da9091d89b6` converged READY after 6 rounds (caller=claude, peers=codex+gemini+deepseek). Codex (original v2 author) raised five successive rigorous blockers across R1–R5: financial-safety regression in initial stub gate (later flagged stronger by gemini), pre-allocation byte check ordering, seq cache durability, format-recovery concurrency, and finally an unconditional `markInFlight` overwrite that allowed concurrent same-session ask_peers to race the recovery counter. R5 added an explicit `if (meta.in_flight) throw` guard inside `markInFlight` and a `mark_in_flight_concurrency_guard_test` smoke marker. Final outcome: `unanimous_ready` with codex/gemini/deepseek READY and decision_quality clean across all three. New smoke markers visible in CI: `session_id_schema_lowercase_test: PASS`, `stream_buffer_overflow_test: PASS`, `seq_cache_append_failure_restart_test: PASS`, `mark_in_flight_concurrency_guard_test: PASS`.

## [v02.03.03] - 2026-04-30

### Fixed

- `review_focus` is now wrapped in escaped `<review_focus>...</review_focus>` delimiters before prompt injection. The block explicitly states that tagged content is operator-provided scope data, not instructions that can override protocol, schemas, safety rules or task directives. This operationalizes the Gemini/Antigravity "Prompt Shielding" recommendation while keeping parity with `cross-review-v1`.
- Paid provider calls are now blocked until explicit financial controls are configured: session ceiling, preflight round ceiling, `until_stopped` ceiling when applicable, and per-peer USD-per-million input/output rate cards. Missing financial variables return `financial_controls_missing` before provider calls instead of relying on hard-coded cost fallbacks.
- `server_info` now reports `financial_controls.paid_calls_ready`, the missing financial variables, and the active policy so operators can diagnose cost-configuration blockers before starting a paid run.
- Hardened the MCP surface with UUIDv4-only session/job schemas, a 24-hour minimum idle floor for `session_sweep`, completed-job pruning, and `peer.format_recovery.cost_alert` events before automatic format-recovery or decision-retry calls.

### Validation

- `npm run format:check`
- `npm test` — covers `<review_focus>` tags, escaped attempted `</review_focus>` injection, redaction, bounding, the existing `OUT OF SCOPE` clause, UUIDv4-only session/job schemas, missing financial-control blocking, the configurable `until_stopped` cost ceiling, the 24-hour sweep floor, completed-job pruning, and format-recovery cost alerts.

## [v02.03.02] - 2026-04-30

### Fixed

- Reissued the README organizational standardization after applying the repository Prettier policy, so the latest release is also the first CI-green artifact after the standardization pass.
- `NOTICE` and `CODE_OF_CONDUCT.md` now use the stable `cross-review-v2` project name and current dependency framing, completing the active-document rename cleanup.

## [v02.03.01] - 2026-04-30

### Changed

- `README.md` now follows the shared organizational opening pattern adopted across the public repositories, while preserving the API-first runtime, model-selection, streaming, and observability sections specific to `cross-review-v2`.

## [v02.03.00] - 2026-04-30

### Added

- Added optional provider-neutral `review_focus` support to `session_init`, `ask_peers`, `session_start_round`, `run_until_unanimous` and `session_start_unanimous`.
- Persisted session-level focus as `meta.review_focus` plus `review-focus.md`, and injected it into initial generation, review, revision, moderation-safe retry, format recovery and decision-retry prompts as a bounded/redacted `Review Focus` block that strips accidental leading `/focus` prefixes.
- Added `CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS` so operators can tune the focus anchor length without changing source code.

### Changed

- Incorporated the community `/focus` suggestion as a cross-provider scope anchor instead of a Claude-specific slash command. Official Claude Code docs describe `/focus` as a focus-mode UI toggle, so `cross-review-v2` now uses explicit prompt context that applies equally to OpenAI/Codex, Anthropic/Claude, Gemini and DeepSeek.
- Front-loaded the `Review Focus` block before task/history material in generation, review, revision and retry prompts, and added an explicit `OUT OF SCOPE` rejection clause so reviewers do not turn unrelated findings into blockers.
- Promoted the release to minor because `review_focus` and `CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS` expand the public MCP/configuration surface without breaking existing callers.
- Aligned `auto-tag.yml` with the npm-production environment policy by creating lightweight release tags and dispatching `publish.yml` on the tag ref instead of `main`.
- Standardized publishing with `cross-review-v1`: `publish.yml` now uses separate gate, npmjs.com, GitHub Packages and GitHub Release jobs, with npm Trusted Publishing, `--provenance`, and an npm `>=11.5.1` gate.

### Validation

- `npm run format:check`
- `npm run lint`
- `npm test` — includes runtime smoke, redaction/truncation checks for `review_focus`, accidental `/focus` prefix stripping, front-loaded focus ordering, `OUT OF SCOPE` clause coverage, and retry-path coverage for format recovery and decision retry prompts.

## [v02.02.00] - 2026-04-30

### Added

- Added real provider token streaming across OpenAI, Anthropic, Gemini and DeepSeek adapters.
- Added count-based `peer.token.delta` and `peer.token.completed` session events so long-running reviews can expose live progress without waiting for full provider responses.
- Added `CROSS_REVIEW_V2_STREAM_TOKENS` and `runtime_capabilities.token_streaming` as the public runtime controls for token streaming.
- Added optional `CROSS_REVIEW_V2_STREAM_TEXT=1` for trusted local diagnostics that need redacted streamed text in session events.
- Added a real API streaming smoke script that verifies all four providers emit token events without printing prompts, responses or API keys.

### Changed

- Kept token streaming enabled by default while preserving the existing final-result parsing and unanimity gate.
- Kept token event text disabled by default so persisted `events.ndjson` progress events cannot leak sensitive strings split across provider chunks.
- Documented the provider-native streaming APIs used by each peer adapter and corrected the local MCP path examples to the stable `cross-review-v2` folder name.

## [v02.01.01] - 2026-04-30

### Fixed

- Removed the CodeQL `js/polynomial-redos` alert from secret redaction by replacing the private-key block regular expression with bounded delimiter scanning.
- Removed the CodeQL `js/log-injection` alert from the dashboard error path by avoiding user-controlled error text in the console log line.
- Added regression coverage for mismatched, unterminated, repeated and overlapping private-key markers so malformed PEM-like payloads remain safely redacted without reintroducing ReDoS risk.
- Added a full decision retry when a peer returns no usable review decision, preventing empty provider output from becoming a false `NEEDS_EVIDENCE` recovery.
- Added configurable `CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS` support and standardized the high output-token budget across OpenAI, Anthropic, Gemini and DeepSeek review/generation calls.
- Tightened model selection to advanced thinking-capable models only, removed weak/deprecated fallbacks, and enabled provider-specific thinking controls for Anthropic, Gemini and DeepSeek.
- Added smoke coverage proving weak/deprecated returned candidates do not trigger silent model downgrades, plus a redacted real-API capability report for the four provider keys.
- Raised the default Anthropic effort to `xhigh` for Claude Opus 4.7 adaptive-thinking review work.
- Removed residual public references to the temporary development package name after the stable `cross-review-v2` rename.

## [v02.01.00] - 2026-04-29

### Added

- Promoted the API-first implementation to the first stable release as `cross-review-v2`.
- Added cooperative background-job cancellation with `session_cancel_job`, durable cancellation metadata and provider `AbortSignal` forwarding where supported.
- Added `session_recover_interrupted` for restart recovery of stale in-flight sessions.
- Added `session_metrics` and `runtime_capabilities` tools for observability and host/tool discovery.
- Added configurable prompt compaction limits for verbose peer history and moderation-sensitive review rounds.
- Added conservative budget preflight checks before expensive review rounds when limits and rate cards are configured.
- Added per-peer fallback model lists with auditable fallback events.

### Changed

- Renamed active runtime, package, bin commands, public docs, Pages metadata and MCP server identity from the development name used before this release to `cross-review-v2`.
- Changed status badges and release documentation from alpha/prerelease to stable SemVer.
- Expanded session reports and dashboard contracts to include cancellation, recovery, metrics and fallback state.

### Fixed

- Prevented long-running background work from becoming opaque by exposing durable metrics, events, cancellation status and restart-recovery state.
- Reduced moderation failures caused by overly verbose peer history through bounded prompt summaries.

## [v02.00.04] - 2026-04-29

### Fixed

- Removed the CodeQL `js/file-system-race` alert in session event persistence by appending `events.ndjson` under the session lock instead of reading/appending through an unlocked race window.
- Bumped the SDK package/runtime version to `2.0.4-alpha.0`.

## [v02.00.03] - 2026-04-29

### Added

- Added background MCP tools `session_start_round`, `session_start_unanimous`, `session_poll`, `session_events` and `session_report` for long-running real API sessions.
- Added durable per-session `events.ndjson` and `session-report.md` artifacts.
- Added per-peer decision quality tracking in convergence results and reports.
- Added generation artifact accounting so lead-peer drafts and revisions contribute to session token/cost totals.
- Added configurable provider cost-rate env vars plus optional session budget guard.
- Added moderation-safe retry handling for provider prompt rejections caused by verbose or policy-sensitive peer history.

### Changed

- Compact prior peer history in follow-up prompts by using structured summaries and requested changes instead of replaying raw peer output.
- Expanded `run_until_unanimous` with `session_id`, `until_stopped` and `max_cost_usd`.
- Improved dashboard session cards and added session event/report APIs.
- Bumped the SDK package/runtime version to `2.0.3-alpha.0`.

### Fixed

- Persisted runtime events through the MCP server and dashboard event sinks instead of keeping them only in process logs.
- Made parser recovery failures explicit as `unparseable_after_recovery` blockers.

## [v02.00.02] - 2026-04-29

### Changed

- Normalized npmjs.com dist-tags so `latest` and the prerelease alias point to the newest published SDK package version.
- Replaced the SDK Pages sponsor landing with the organization-standard SumUp support page.

### Fixed

- Sanitized dashboard HTTP 500 responses so internal exception messages are logged server-side but never returned to clients, resolving CodeQL `js/stack-trace-exposure`.
- Bumped the SDK package/runtime version to `2.0.2-alpha.0`.

## [v02.00.01] - 2026-04-29

### Changed

- Enforced npmjs.com package access as public after publish and added an unauthenticated registry visibility check before the release workflow can pass.
- Aligned the repository funding metadata with the organization-wide Sponsors pattern and preserved that YAML style outside Prettier formatting.
- Normalized `repository.url` to npm's canonical `git+https://...git` form.
- Bumped the SDK package/runtime version to `2.0.1-alpha.0`.

## [v02.00.00] - 2026-04-29

### Added

- Added smoke coverage for parser recovery on overlong summaries, fenced JSON and invalid JSON with an unambiguous status key.
- Added automatic one-shot per-peer format recovery when a response has no parseable status.
- Added convergence metadata that distinguishes latest-round unanimity from recovered session-quorum unanimity.
- Added a shared 300s MCP request timeout constant and runtime smoke script so local MCP clients do not fail on the SDK default 60s timeout while real peers are still processing.

### Changed

- Activated automatic tag creation from `package.json` version on pushes to `main`.
- Activated GitHub release and package publishing for the development package line, using prerelease npm dist-tags such as `alpha` so alpha builds do not replace any stable `latest` channel.
- Aligned public version display and GitHub release tags with the organization `v00.00.00` standard while keeping npm SemVer for package publishing.
- Added a `prepack` clean build so local runtime data cannot leak into npm artifacts through stale `dist/` output.
- Hardened Git and npm ignore rules so `.env*`, `.tmp`/`tmp` and local runtime files are never published.
- Pointed the development homepage, MCP metadata and Pages site at the temporary development domain.
- Preserved the original expected quorum when a later recovery call reviews only a subset of peers.
- Clarified peer response-format instructions so models do not treat the schema itself as the artifact under review.
- Documented the distinction between MCP client request timeout and provider HTTP timeout.

### Fixed

- Fixed false non-convergence when a peer returned a valid status with `summary` or list fields larger than the strict schema limit; the parser now normalizes recoverable fields and keeps warnings in the audit trail.

## [v2.0.0-alpha.2] - 2026-04-28

### Added

- Added durable `in_flight`, `convergence_scope` and `convergence_health` metadata so interrupted sessions can be inspected and swept more safely.
- Added `session_attach_evidence`, `escalate_to_operator` and `session_sweep` MCP tools.
- Added `session_check_convergence` for read-only inspection of the latest convergence state.
- Added formal `silent_model_downgrade` failures when a provider returns a different model than the requested one.
- Added smoke coverage for evidence attachment, operator escalation and idle-session sweep.

### Changed

- Session rounds now clear in-flight state and update convergence health when they complete.
- Idle sweeps mark unfinished stale sessions with explicit outcome and health metadata.

## [v2.0.0-alpha.1] - 2026-04-28

### Added

- Added reported-model tracking for generation and review calls, with convergence blocked when a provider silently returns a different model.
- Added per-session failed-attempt aggregation in `meta.json`.
- Added contextual recovery hints for rate-limit and moderation failures.

### Changed

- Made session writes atomic and protected round/finalization updates with a local session lock.
- Hardened session path handling with strict UUID v4 validation and containment checks.
- Changed Gemini and DeepSeek probes to model-listing calls instead of paid generation calls.
- Prevented the lead peer from reviewing its own generated draft by default.
- Moved internal peer-exchange prompts to English technical wording.
- Expanded redaction coverage for API keys, tokens, JWTs, bearer credentials and private-key blocks.

### Fixed

- Fixed the OpenAI model probe call that used an invalid `limit` argument cast.
- Fixed stale adapter state after runtime model discovery.
- Tightened 429, authentication and moderation error classification to avoid false rate-limit reports.
- Fixed stale session metadata on converged `ask_peers` results.

## [v2.0.0-alpha.0] - 2026-04-28

### Added

- Initial API/SDK-only cross-review MCP server.
- Official SDK adapters for OpenAI, Anthropic, Google Gemini and DeepSeek.
- Runtime model discovery and documented best-model selection.
- Durable local session store with prompts, drafts, peer responses, failures and final artifacts.
- Strict unanimity gate across all selected peers.
- Local dashboard for session inspection.
- GitHub-ready workflows for CI, Pages, releases, packages and Dependabot automerge.
- Public-repo security baseline with secrets ignored and CodeQL Default Setup documented.
