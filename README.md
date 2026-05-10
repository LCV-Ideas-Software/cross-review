<p align="center">
  <img src=".github/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas & Software" width="520" />
</p>

# cross-review-v2

> MCP server orchestrating API-first cross-review between Claude, ChatGPT Codex,
> Gemini, DeepSeek, and Grok with unanimous convergence gates.

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen.svg)](#status)
[![npm](https://img.shields.io/npm/v/@lcv-ideas-software/cross-review-v2.svg)](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2)
[![runtime: API-only](https://img.shields.io/badge/runtime-API--only-blue.svg)](#what-it-does)
[![security: CodeQL Default Setup](https://img.shields.io/badge/security-CodeQL%20Default%20Setup-informational.svg)](#security)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](./LICENSE)

**Install.**

```bash
npm install -g @lcv-ideas-software/cross-review-v2
# or using the GitHub Packages mirror:
npm install -g @lcv-ideas-software/cross-review-v2 --registry=https://npm.pkg.github.com
```

**Status.** Stable. Current release: **v02.21.00** (npm package `2.21.0`). See
[CHANGELOG.md](./CHANGELOG.md) for the release history.

The version history at a glance:

| Release | Scope |
|---|---|
| **`v02.21.00`** | **Cross-provider prompt caching across all 5 peers (OpenAI, Anthropic, Gemini, DeepSeek, Grok).** Single coordinated ship that wires uniform prompt-caching telemetry through the runtime: each adapter parses provider-native cache fields (`prompt_tokens_details.cached_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `cachedContentTokenCount` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`); orchestrator emits a canonical `provider.cache.usage` event; per-session `cache_manifest.json` is appended for every cached call. **Anthropic** uses EXPLICIT cache_control breakpoints on the system prompt (TTL `5m`/`1h`). **OpenAI** uses pair-scoped `prompt_cache_key` + `prompt_cache_retention` (`in_memory`/`24h`). **Grok** mirrors OpenAI plus `x-grok-conv-id` header for cache-bucket scoping. **DeepSeek** parses auto-cache telemetry (no payload changes). **Gemini** parses implicit-cache telemetry only (explicit `caches.create` deferred). New `src/core/prompt-parts.ts` builds the canonical `stablePrefix` that always begins with `cache_schema_version: vN` and produces a sha256 hex hash invariant across rounds for the same case. New `src/core/cache-manifest.ts` persists per-session cache history with the same atomic-write retry pattern as `meta.json`. New rate cards in `src/core/cache-rates.json` populate `CostEstimate.cache_savings_usd` (or `cache_savings_unknown` when no rate matches). Operator can disable globally with `CROSS_REVIEW_V2_DISABLE_CACHE=true`; TTL via `CROSS_REVIEW_V2_CACHE_TTL_ANTHROPIC` / `CROSS_REVIEW_V2_CACHE_TTL_OPENAI`; schema bump via `CROSS_REVIEW_V2_CACHE_SCHEMA_VERSION`. 5 new smoke markers (`cache_hash_invariance_test`, `cache_schema_version_in_prefix_test`, `cache_rates_json_loaded_test`, `cache_manifest_atomic_write_test`, `cache_disable_kill_switch_test`). New `docs/caching.md` documents per-provider behavior matrix. **Minor bump** — public surface is additive; pre-v2.21 callers see no behavior change. |
| **`v02.18.08`** | **Site sponsor card iteration.** `site/index.html` GitHub Sponsors iframe (caixa branca cross-origin) substituído por link card dark navy com ❤ pink + meta cyan + seta animada; card movido para DEPOIS dos botões (lcv.dev/sponsor primário, GitHub Sponsors alternativa). Companion ship Phase 3 (12 repos). |
| **`v02.18.07`** | **Patch — `site/index.html` visual identity refresh.** GitHub Pages doc/sponsor page reskin to the new LCV org dark-first navy/cyan visual identity (palette `#050b18`/`#38bdf8`/`#34d399`, radial gradients, glow shadows, gradient text on h1). Coordinated companion ship with cross-review-v1 1.12.9, deepseek-cli 0.3.1, grok-cli 1.6.2, sponsor-motor APP v01.02.02, and `.github-org/site` (org root + /sponsor). No change to the published npm tarball (`files[]` does not include `site/`); only the GitHub Pages page changes. **Patch bump** (no public surface change). |
| **`v02.18.06`** | **Patch — Gemini API function-declaration compatibility for MCP tool inputSchemas.** Gemini Code Assist forwards each MCP tool's `inputSchema` to the Gemini API as a `function_declarations[*].parameters` payload; the Gemini API's OpenAPI 3.0 subset rejects three patterns the SDK was emitting from the existing zod schemas, surfacing as `400 INVALID_ARGUMENT` for every chat turn including cross-review-v2 tools. v2.18.6 cleans the offending zod usage. **(1)** `additionalProperties: false` removed from every MCP tool inputSchema (~28 tools) by dropping the `.strict()` chain; runtime accepts the same valid arguments because handlers consume only declared properties via destructuring. **(2)** `caller` field flattened from `z.union([PeerSchema, z.literal("operator")])` (6 occurrences) to a single `CallerSchema = z.enum([...PEERS, "operator"])`, replacing the `anyOf: [enum, const]` shape with a clean single `enum`. **(3)** `reasoning_effort_overrides` refactored from `z.record(PeerSchema, ReasoningEffortSchema).optional()` to an explicit `z.object({codex?, claude?, gemini?, deepseek?, grok?}).optional()`, eliminating the non-OpenAPI `propertyNames` constraint and the spurious `required: [<all 5 peers>]` artifact that contradicted the field's `.optional()` declaration. No behavior change for any caller passing valid arguments — Claude Code, Codex CLI, Gemini Code Assist, Grok CLI and DeepSeek CLI continue invoking the same tools with the same keys. Lint/typecheck/format clean; smoke harness completes with `ok: true / events: 96`. **Patch bump** (compatibilidade pública preservada; única diferença observável é que campos extras não declarados passam a ser silenciosamente descartados em vez de rejeitados com `mcp_arg_validation_failed`). |
| **`v02.18.05`** | **Patch — anti-drift smoke drivers for v2.18.4 audit closure (operator directive 2026-05-07).** v2.18.4 shipped 6 surgical fixes from the Codex external audit; v2.18.5 hardens those fixes against silent regression with 5 anti-drift smoke checks (`hono_override` / `abort_signal_threading` / `max_items_per_pass_default` / `clamp_effort_for_model` / `consensus_event_per_peer_attribution`). **P1.1**: `package.json` overrides.hono === ">=4.12.16" + ip-address override retained. **P1.3**: ≥2 sites with `signal?: AbortSignal` param + `signal: params.signal` wiring + `signal: input.signal` autowire emission; consensus pass has no leftover `signal: undefined`. **P1.4**: source-level `?? "4"` fallback + behavioral `loadConfig()` returns max_items_per_pass=4 (env unset). **P2.1**: behavioral clampEffortForModel("xhigh", "grok-4.3")="high"; passthrough on multi-agent; clamp wired at exactly 2 responses.create sites. **P2.4**: legacy judge_peer + new judge_peers array + per_peer_verdict map co-emitted at every `this.emit({...})` event payload. `clampEffortForModel` is now exported from src/peers/grok.ts so the harness can verify directly. Companion to cross-review-v1 v1.12.7 (parallel ship, same operator directive). Smoke harness completes with `ok: true` / exit 0; lint/typecheck/format clean; `npm audit --audit-level=moderate` 0 vulnerabilities. **Patch bump** (additive — only new exports + new smoke markers; no runtime behavior change). |
| **`v02.18.04`** | **Patch — Codex external audit 2026-05-07 outcome: 6 surgical fixes (P1.1, P1.2, P1.3, P1.4, P2.1, P2.4).** Codex submitted a read-only audit of cross-review-v2 v2.18.3 with 4 P1 + 7 P2 findings; this ship lands 6 verified-actionable items. **P1.1**: `package.json` adds `"hono": ">=4.12.16"` override clearing 2 npm-audit moderate advisories (GHSA-9vqf-7f2p-gf9v + GHSA-69xw-7hcm-h432) via @modelcontextprotocol/sdk transitive (practical exposure ~zero in stdio runtime, but audit-gate matters for publish + defense-in-depth; same precedent as v2.18.1 ip-address override). **P1.2**: `src/security/redact.ts` adds `xai-` API key pattern at parity with sk-/sk-ant-/AIza/etc; logs/sessions could previously leak xAI keys via persisted provider errors. **P1.3**: `runEvidenceChecklistJudgeConsensusPass` + `runEvidenceChecklistJudgePass` now thread `AbortSignal` through to `judgeEvidenceAsk(context.signal)` — pre-v2.18.4 the consensus path hardcoded `signal: undefined` and single-peer omitted the field, so `session_cancel_job` could not abort judges mid-flight. Autowire call sites pass `input.signal` from round scope. **P1.4**: lowered default `CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS` from 8 → 4 — with default consensus_peers=4, worst-case round goes from 4×8=32 paid judge calls down to 4×4=16. Operators wanting prior behavior set env-var explicitly. **P2.1**: `GROK_REASONING_EFFORT_MODELS` allowlist expanded from `{"grok-4.20-multi-agent"}` to include `"grok-4.3"` per current xAI docs (verified via WebFetch 2026-05-07; xAI added `grok-4.3` reasoning_effort support after v2.16.0 froze). New `clampEffortForModel()` narrows internal `xhigh`/`minimal` scale to `high` for grok-4.3 (which only accepts `none|low|medium|high`). v2.16.0 verification 2026-05-05 was authoritative at the time but is now stale; v2.18.4 closes the drift. **P2.4**: consensus events at orchestrator.ts:1008 + :1030 previously emitted only `judge_peer: params.judge_peers[0]`, so the rollup at session-store.ts:911 attributed every consensus decision to the first peer (codex by default). v2.18.4 keeps `judge_peer` for backward compat AND emits `judge_peers: PeerId[]` + `per_peer_verdict` map so per-peer accuracy is computable from the raw event stream. Smoke harness completes with exit 0 + final `{ ok: true, events: 96 }` payload (the harness's binary success signal); `grok_reasoning_capability_allowlist_test` updated from prior `size === 1` to `size === 2`. Lint/typecheck/format clean. **Patch bump** (additive public surface; default-behavior change on `max_items_per_pass` documented). |
| **`v02.18.03`** | **Patch — Gemini default pin bump `gemini-3.1-pro-preview` → `gemini-2.5-pro` (operator preference 2026-05-07; coordinated with cross-review-v1 v1.12.4).** Source-of-truth defaults flipped: `src/core/config.ts` `models.gemini` default → `gemini-2.5-pro`; `src/peers/model-selection.ts` priority list → `["gemini-2.5-pro", "gemini-3.1-pro-preview"]` (3.1-pro-preview retained as fallback). Rationale: under Google One AI Ultra subscription, `gemini-2.5-pro` carries 1k requests/day quota vs `gemini-3.1-pro-preview`'s 250 requests/day; post-bump empirical sessions (08cbc942, 1d5be5f2, 256ac7c9 — all 2026-05-07) confirm `gemini-2.5-pro` stable across the 5-peer panel without rate_limit blockers. The 7 LCV-workspace MCP host configs already flipped `CROSS_REVIEW_GEMINI_MODEL=gemini-2.5-pro` env-override 2026-05-07; this ship aligns the source-of-truth defaults so a fresh install without env-override picks the same model. Workspace policy (operator directive 2026-05-07): only `gemini-*-pro` variants ≥ 2.5 are permitted — no `*-flash` and no models below 2.5. Smoke fixture `scripts/smoke.ts:225` (currentOfficialModel iterator) flipped to `gemini-2.5-pro`. `docs/api-keys.md` env-var example + `docs/model-selection.md` priority documentation refreshed to match. **Patch bump** (no public surface change beyond default model ID; behavior unchanged for env-override users). |
| **`v02.18.02`** | **Tier 5 — Windows process-tree introspection (coordinated with cross-review-v1 v1.12.2).** Closes the long-standing forensics gap: pre-v2.18.2 `getParentProcessSnapshot()` returned `parent_exe_basename: null` on Windows because we only had a POSIX `/proc/<ppid>/comm` reader (Windows path deferred at F1 v2.18.0). v2.18.2 closes the gap with a defensive `tasklist /FI "PID eq <ppid>" /FO CSV /NH` reader via `child_process.spawnSync` (`timeout: 500`, `windowsHide: true`); parser uses leading-quote discriminator and the same `1 ≤ length < 128` sanity filter as POSIX. Best-effort try/catch swallows ENOENT, timeout, parse failures. POSIX path unchanged. `scripts/smoke.ts` sub-test (14) extended with shape sanity + Windows-specific populated-basename assertion + source-level anti-drift guards. Forensics-only field — NOT used by F1 token gate or v2.17.0 clientInfo cross-check. **Patch bump** (no public surface change). |
| **`v02.18.00`** | **F1 caller capability tokens (coordinated with cross-review-v1 v1.11.0).** Cryptographic identity proof that complements the v2.17.0 clientInfo gate. Pre-v2.18.0 the v2.17.0 cross-check between `caller` and `clientInfo.name` only catches *inconsistent* self-reports — both fields are declared by the caller. F1 introduces a per-host secret (env `CROSS_REVIEW_CALLER_TOKEN`), authoritative on match and rejected on mismatch. New `caller-tokens` module exposes generation, loading, constant-time hex matching, env verification and a best-effort parent-process snapshot for forensics (Option C / Hybrid). New MCP tool `regenerate_caller_tokens` rotates `host-tokens.json`. New env vars `CROSS_REVIEW_CALLER_TOKEN`, `CROSS_REVIEW_TOKENS_FILE`, `CROSS_REVIEW_REQUIRE_TOKEN`. New `caller_tokens` block in `server_info` surfaces the gate state. `verifyCallerIdentity` extended with `verification_method` ("token" | "client_info" | "none") and `identity_metadata`. R2 codex catch hardening: `caller="operator"` from a host carrying a token throws `identity_forgery_blocked` (closes the operator-bypass window). Permissive default — hosts without tokens fall back to v2.17.0 clientInfo gate; operator opts into hard-enforce mode after distributing secrets. Smoke marker `caller_capability_tokens_test` covers 16 cases including the new overlay paths and the R2 hardening. **Minor bump** (additive public surface). |
| **`v02.17.00`** | **HARD GATE — identity forgery rejection (operator directive 2026-05-05).** Empirical evidence flagrada: cross-review-v2 session `0994cbaf` foi criada por Codex com `caller=claude` (impersonação para auto-exclusão do real Claude da panel). Pre-v2.17.0 v2 nem capturava `clientInfo` da MCP initialize handshake — `caller` era trusted unconditionally. v2.17.0 adiciona `verifyCallerIdentity(declaredCaller, clientInfo)` que cross-checks o caller declarado contra `getCallerCandidatesFromClientInfo(clientInfo)`. Aplicado em todos os 6 handlers caller-accepting: `session_init`, `ask_peers`, `session_start_round`, `run_until_unanimous`, `session_start_unanimous`, `contest_verdict` (quando `new_caller` provided). Match → OK + `identity_verified=true`. clientInfo unknown → OK + `identity_verified=false` (legitimate override). `caller="operator"` → OK (no agent claim made). Mismatch OR multi-match clientInfo → throws `identity_forgery_blocked`. Smoke `identity_forgery_blocked_test` (6 sub-tests). Coordinated ship com `cross-review-v1 v1.9.0`. **Minor bump** porque public surface adds `identity_forgery_blocked` error. Cross-review trilateral bypassed por operator directive (security fix to the gate itself, would otherwise route through compromised gate). |
| **`v02.16.00`** | **Tribunal protocol repair plus operational doctor.** Separates petitioner/caller from relator metadata, applies self-recusal to direct `ask_peers`, adds read-only `session_doctor`, fixes Windows smoke teardown, and refreshes provider model guidance from official docs. |
| **`v02.15.01`** | **`server_info` consensus visibility hotfix.** Exposes `consensus_peers` and `configured_consensus_peers_raw` for evidence-judge autowire so operators can audit the same configuration the dispatcher is using. |
| **`v02.15.00`** | **Backlog bundle for operational judge controls.** Added consensus-based judge autowire, per-call reasoning-effort overrides, opt-in real-API smoke, provider 4xx docs hints, and a Grok reasoning-capability allowlist while exposing consensus toggles across the six MCP host configs. |
| **`v02.14.01`** | **Grok reasoning model hotfix.** Switched the default Grok model to `grok-4.20-multi-agent` after real xAI verification and official docs showed `reasoning.effort` is accepted only on that model family. |
| **`v02.14.00`** | **Grok joins the tribunal.** Expanded the peer set to five with Grok, added per-peer on/off env vars, precision-report groundwork, active evidence-judge autowire, `contest_verdict`, multi-peer judge consensus, attached-evidence prompt injection, and CodeQL-safe temp-directory handling. |
| **`v02.13.00`** | **Lead meta-review drift fix.** Added explicit `ship` versus `review` session mode, lead drift detection, drift telemetry, and an abort gate so `run_until_unanimous` does not replace the artifact under review with a structured peer-review verdict. |
| **`v02.12.00`** | **Shadow judge observability.** Turned on evidence-judge shadow-mode data collection, surfaced autowire config in `server_info`, added dashboard/runtime rollups, and codified the tribunal-colegiado model for caller, relator, peer votes, and contestation. |
| **`v02.11.00`** | **Relator lottery plus shadow auto-wire.** Added automatic relator selection that excludes the caller and wired the v2.9 judge pass in shadow mode so self-review drift stops at the session structure. |
| **`v02.09.00`** | **LLM evidence-judge pass.** Added an operator-triggered judge that evaluates open evidence asks against the current draft and promotes only verified satisfied items, leaving inferred/unknown cases open. |
| **`v02.08.00`** | **Per-peer health and Evidence Broker lifecycle.** Added health rollups, evidence lifecycle tracking, resurfacing inference, dashboard surfaces, and the final architectural audit item on top of v2.7. |
| **`v02.07.00`** | **Evidence Broker.** Added a persistent per-session evidence checklist that deduplicates `NEEDS_EVIDENCE` caller requests and injects outstanding asks into subsequent revision prompts. |
| **`v02.06.01`** | **Fallback/recovery budget hard gate.** Replicated hard budget refusal to fallback and moderation-recovery paths so paid recovery calls cannot silently exceed the session cost ceiling. |
| **`v02.06.00`** | **Token-delta compaction plus v2.5 format hotfix bundle.** Coalesced streaming token delta events to reduce `events.ndjson` noise and bundled the deferred Prettier/format fix from v2.5. |
| **`v02.05.00`** | **Evidence and budget hardening pass.** Folded in operator-requested evidence/budget improvements plus empirical Codex/Gemini audit findings from historical session analysis. |
| **`v02.04.01`** | **CI stub fail-fast hotfix.** Fixed import-time server startup so the smoke harness can import MCP schemas while `CROSS_REVIEW_V2_STUB=1` is set in CI with explicit confirmation. |
| **`v02.04.00`** | **Audit-closure hardening pass.** Closed internal v2.3.3 technical-opinion priorities with additive public-surface hardening and several explicitly documented behavior changes. |
| **`v02.03.03`** | **Prompt shielding and financial safety.** Wrapped `review_focus` in escaped delimiters, blocked paid calls until financial controls are configured, expanded `server_info` financial diagnostics, and hardened MCP IDs, sweeps, jobs, and recovery cost alerts. |
| **`v02.03.02`** | **CI-green README/docs cleanup.** Reissued README organizational standardization under the repository Prettier policy and completed active-document rename cleanup in `NOTICE` and `CODE_OF_CONDUCT.md`. |
| **`v02.03.01`** | **README organizational standardization.** Adopted the shared LCV README opening while preserving the API-first runtime, model-selection, streaming, and observability sections. |
| **`v02.03.00`** | **Provider-neutral `review_focus`.** Added focus support across session tools, persisted focus metadata, injected bounded focus blocks into generation/review/retry prompts, and aligned auto-tag/publish automation with the stable package line. |
| **`v02.02.00`** | **Provider token streaming.** Added real token streaming for OpenAI, Anthropic, Gemini, and DeepSeek, with count-based progress events, runtime controls, and text-redaction defaults for persisted event logs. |
| **`v02.01.01`** | **CodeQL and model-selection hardening.** Fixed secret-redaction ReDoS and dashboard log-injection alerts, added decision retry for empty peer output, max-output-token controls, stronger model selection, and improved thinking controls. |
| **`v02.01.00`** | **First stable `cross-review-v2` release.** Promoted the API-first implementation to stable with cancellation, restart recovery, metrics, runtime capabilities, prompt compaction, budget preflight, model fallback, and stable naming. |
| **`v02.00.04`** | **Session event race hotfix.** Removed the CodeQL file-system race in `events.ndjson` persistence by appending under the session lock. |
| **`v02.00.03`** | **Background sessions and durable reports.** Added background MCP tools, durable events and reports, peer decision-quality tracking, generation accounting, provider cost rates, budget guard, moderation-safe retry, and dashboard event/report APIs. |
| **`v02.00.02`** | **Publishing and dashboard sanitization.** Normalized npm dist-tags, replaced the sponsor landing with the SumUp support page, sanitized dashboard 500 responses, and bumped the alpha runtime. |
| **`v02.00.01`** | **Public npm/package metadata alignment.** Enforced public npm visibility, added registry visibility checks, aligned funding metadata, normalized `repository.url`, and bumped the alpha runtime. |
| **`v02.00.00`** | **Development package line hardening.** Added parser format recovery, convergence metadata, shared MCP timeout/runtime smoke, auto-tag/release publishing, padded public tags, prepack clean builds, ignore-rule hardening, and quorum preservation. |
| **`v2.0.0-alpha.2`** | **Durable session recovery alpha.** Added in-flight metadata, convergence health, evidence attachment, operator escalation, session sweep, convergence inspection, silent-model-downgrade failures, and smoke coverage for the new surfaces. |
| **`v2.0.0-alpha.1`** | **Model attestation and store hardening alpha.** Added reported-model tracking, failed-attempt aggregation, recovery hints, atomic/locked session writes, UUID path hardening, safer probes, self-review prevention, English peer prompts, and expanded redaction. |
| **`v2.0.0-alpha.0`** | **Initial API/SDK-only MCP server.** Introduced official SDK adapters for OpenAI, Anthropic, Gemini, and DeepSeek, runtime model discovery, best-model selection, and a durable local session store. |

## What It Does

`cross-review-v2` is the stable API-first implementation of the cross-review
pattern. It orchestrates provider API clients (OpenAI/Codex, Anthropic/Claude,
Google Gemini, DeepSeek, and xAI/Grok) and provides an MCP-compatible server
surface.

Runtime calls are real provider calls by default. Stubs exist only for smoke
tests and CI when `CROSS_REVIEW_V2_STUB=1`.

- OpenAI client library for the Codex/OpenAI peer.
- Anthropic TypeScript client library for Claude.
- Google Gen AI client library for Gemini.
- OpenAI-compatible DeepSeek API through the OpenAI client library.
- OpenAI-compatible xAI Grok API through the OpenAI client library.

## Quick Start

```powershell
# Set API keys (PowerShell example)
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GROK_API_KEY", "<GROK_API_KEY>", "User")
```

Restart your terminal after changing environment variables.

Build and run locally:

```bash
npm install
npm run build
node dist/src/mcp/server.js
```

For local smoke tests (no-cost):

```powershell
$env:CROSS_REVIEW_V2_STUB = "1"
npm test
```

## Configuration

Model selection and runtime behaviour can be controlled with environment
variables. Example overrides (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.20-multi-agent", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_REASONING_EFFORT", "xhigh", "User")
```

For Grok, `GROK_API_KEY` is canonical. `grok-4-latest`, `grok-4.3`,
`grok-4.20`, and `grok-4.20-reasoning` use xAI automatic reasoning without an explicit
`reasoning.effort` field. `grok-4.20-multi-agent` accepts explicit
`reasoning.effort`; `low`/`medium` select 4 agents and `high`/`xhigh` select
16 agents.

Financial and budget controls are required for paid provider calls. Configure
these environment variables before running real sessions (example):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_MAX_SESSION_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_UNTIL_STOPPED_MAX_COST_USD", "20", "User")
```

## MCP Tools

- `server_info`
- `runtime_capabilities`
- `probe_peers`
- `session_init`
- `session_list`
- `session_read`
- `ask_peers`
- `session_start_round`
- `run_until_unanimous`
- `session_start_unanimous`
- `session_cancel_job`
- `session_recover_interrupted`
- `session_poll`
- `session_events`
- `session_metrics`
- `session_doctor`
- `session_report`
- `session_check_convergence`
- `session_attach_evidence`
- `escalate_to_operator`
- `session_sweep`
- `session_finalize`

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2026 Leonardo Cardozo Vargas.

---

<p align="center"><span style="font-size: 1.5em;"><strong>© LCV Ideas &amp; Software</strong></span><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713&nbsp;&nbsp;- Pinheiros<br>São Paulo - SP<br>CEP 05.424-150<br>CNPJ: 66.584.678/0001-77<br>IM 05.424-150</sub></p>
