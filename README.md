<p align="center">
  <img src=".github/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="520" />
</p>

# cross-review

> MCP server orchestrating API-first cross-review between Claude, ChatGPT Codex,
> Gemini, DeepSeek, Grok, and Perplexity with unanimous convergence gates.

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen.svg)](#status)
[![release](https://img.shields.io/github/v/release/LCV-Ideas-Software/cross-review?sort=semver)](https://github.com/LCV-Ideas-Software/cross-review/releases)
[![npm](https://img.shields.io/npm/v/@lcv-ideas-software/cross-review.svg)](https://www.npmjs.com/package/@lcv-ideas-software/cross-review)
[![CI](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/ci.yml/badge.svg)](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/ci.yml)
[![CodeQL](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/codeql.yml/badge.svg)](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/codeql.yml)
[![Publish](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/publish.yml/badge.svg)](https://github.com/LCV-Ideas-Software/cross-review/actions/workflows/publish.yml)
[![runtime: API-only](https://img.shields.io/badge/runtime-API--only-blue.svg)](#what-it-does)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](./LICENSE)

**Upgrade from the published registry.**

```bash
npm upgrade -g @lcv-ideas-software/cross-review
# or using the GitHub Packages mirror:
npm upgrade -g @lcv-ideas-software/cross-review --registry=https://npm.pkg.github.com
```

**Status.** Stable. This source prepares **v04.05.04** (package `4.5.4`).
The public registry can lag while the publish workflow runs; use the npm badge
or `npm view @lcv-ideas-software/cross-review version` for registry state and
`server_info` for the version actually loaded by an MCP window. See
[CHANGELOG.md](./CHANGELOG.md) for the full release history.

> **Project renamed 2026-05-15.** This project was previously published as
> [`@lcv-ideas-software/cross-review-v2`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2)
> (versions 0.x through 3.7.5). v4.0.0 is the first release under the
> shorter canonical name `@lcv-ideas-software/cross-review` after the
> companion `cross-review-v1` project was discontinued and archived.
> Historical CHANGELOG entries below v4.0.0 reference the prior name
> verbatim.

The version history at a glance:

| Release              | Scope                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`v04.05.04`**      | Runtime-hardgate remediation — fix grounding, truthfulness namespaces, consensus judging, multi-window cancellation, accounting, session ceilings, terminal reports and cross-provider `ultra` normalization.                                                               |
| **`v04.05.03`**      | Security/hardgate patch — remove exponential regex backtracking, trust integrity-checked attachment path/digest metadata, accept correlated single-quoted artifact literals and stop treating source-version bumps as historical runtime claims.                            |
| **`v04.05.02`**      | Patch release — publish the complete authenticated-evidence transport update with a hermetic clean-runner regression fixture; no operator central configuration is required by the test gate.                                                                               |
| **`v04.05.01`**      | Patch release — restore authenticated peer evidence transport with append-only active snapshots, combined preflight parity, strict operational records, independent relator/reviewer roles and immutable terminal outcomes; no manual operator attachment is required.      |
| **`v04.05.00`**      | Minor release — refresh all six provider contracts and add fail-closed provider terminals, runtime config fingerprints, operator evidence custody, peer self-attestation rejection, and grounded READY votes.                                                               |
| **`v04.04.08`**      | Patch — raise the transitive `hono` override floor and clear the current advisory set.                                                                                                                                                                                      |
| **`v04.04.07`**      | Patch — promote the patched `protobufjs` floor for downstream consumers.                                                                                                                                                                                                    |
| **`v04.04.06`**      | Patch — close the remaining Claude re-validation tail: orchestrator attached-evidence reads now fail closed, session_doctor defaults to action-oriented findings, and T2#10 source-regex debt drops to a locked total of 160.                                               |
| **`v04.04.05`**      | Patch — close the seven verified residual audit items: evidence fail-closed realpath handling, typed shadow-decision runtime events, derived release date, redaction-comment correction, retry/security gate verification, and a locked T2#10 smoke source-contract budget. |
| **`v04.04.04`**      | Patch — central config can now carry model-specific rate cards, so Claude Opus 4.8 and Claude Fable 5 pricing are both stored and the active Anthropic rates follow the configured Claude model automatically.                                                              |
| **`v04.04.03`**      | Patch — continue the T2#10 smoke-debt reduction by moving the lazy provider SDK import source contract into the dedicated source-contract smoke, preserving coverage while reducing broad smoke regex pins.                                                                 |
| **`v04.04.02`**      | Patch — support Claude Fable 5 as an explicit Anthropic production-model option, including verified model selection, refusal handling, refusal events, docs and cost guidance.                                                                                              |
| **`v04.04.01`**      | Patch — complete residual audit sweep: full mutating-tool identity gate, evidence attachment cache/safety, async EventLog flush, Perplexity auth-only probe mode, cache-cost correctness, dashboard report method split, and dedicated source-contract smoke isolation.     |
| **`v04.04.00`**      | Minor — consolidated audit close-out: log-level validation, realpath containment, initial-draft fabrication guard, Perplexity probe minimization, identity audit events, derived tool list, docs and metadata guards.                                                       |
| **`v04.03.09`**      | Patch — move `truthfulness_preflight` coverage into a focused smoke script and tighten evidence-artifact matching for path-qualified refs and `.md/.diff/.patch/.csv` files.                                                                                                |
| **`v04.03.08`**      | Patch — move `evidence_preflight` behavior coverage into a focused smoke script and run it explicitly before the broader smoke suite.                                                                                                                                       |
| **`v04.03.07`**      | Patch — evidence preflight now blocks paid review when the submission references an external evidence/log artifact that was not attached to the session.                                                                                                                    |
| **`v04.03.06`**      | Patch — isolate `runtime-smoke` in a temporary data directory so harness runs do not write open sessions into the operator's real runtime corpus.                                                                                                                           |
| **`v04.03.05`**      | Patch — filter Perplexity streaming `<think>` token events, expand `~` in central config paths, escape dashboard runtime paths, and harden smoke scripts.                                                                                                                   |
| **`v04.03.04`**      | Patch — harden cross-process event sequencing, exact-match fabrication checks, Gemini missing-text handling, and streaming provider error retry classification.                                                                                                             |
| **`v04.03.03`**      | Patch — add forensic diagnostics for append/event and identity failures, flush pending events on shutdown signals, retry structured provider 5xx errors, and refresh official AI provider SDKs.                                                                             |
| **`v04.03.02`**      | Patch — harden persistence redaction, finalized-session mutation guards, side-effect identity gates, caller-token rotation output, and Windows registry config fallback.                                                                                                    |
| **`v04.03.01`**      | Patch — tighten skip-peer classification so non-retryable provider errors block, while Anthropic overload events remain retryable and better surfaced in skip diagnostics.                                                                                                  |
| **`v04.03.00`**      | Minor — P1/P2/P3 follow-up with unresolved-evidence close-out visibility, an offline fixture eval harness, and a read-only peer reliability report.                                                                                                                         |
| **`v04.02.05`**      | Patch — harden session auditability with terminal events, cost split reporting, `not_resurfaced` visibility, and relator provenance checks for session IDs/GitHub URLs.                                                                                                     |
| **`v04.02.04`**      | Patch — harden truthfulness preflight auditability, add a read-only preflight retest tool, and reduce false parser warnings for attached/log evidence.                                                                                                                      |
| **`v04.02.03`**      | Patch — promote the Gemini canonical default to `gemini-3.1-pro-preview` and refresh the active local Gemini rate card.                                                                                                                                                     |
| **`v04.02.02`**      | Patch — provider-doc refresh, Perplexity probe repair, current model pins, and rate-card guidance.                                                                                                                                                                          |
| **`v04.02.01`**      | Patch — publish the workspace hard-gate cleanup as a package release.                                                                                                                                                                                                       |
| **`v04.02.00`**      | Minor — bounded MCP session listing and cancellation semantics cleanup.                                                                                                                                                                                                     |
| **`v04.01.01`**      | Patch — release the hard-gate cleanup as a published package.                                                                                                                                                                                                               |
| **`v04.01.00`**      | Minor — security hardening of session-store concurrency, write-path DoS surface, and credential redaction.                                                                                                                                                                  |
| **`v04.00.08`**      | Patch — eliminate the recurring `js/file-access-to-http` CodeQL false positive at the source.                                                                                                                                                                               |
| **`v04.00.07`**      | Patch — bounded npm registry fetch in the post-publish verifier.                                                                                                                                                                                                            |
| **`v04.00.06`**      | Patch — Windows-safe registry verifier.                                                                                                                                                                                                                                     |
| **`v04.00.05`**      | Patch — hard-gate close-out for the Codex v4.0.4 audit.                                                                                                                                                                                                                     |
| **`v04.00.04`**      | Patch — restore prettier coverage of `src/` and `scripts/` (close audit on v4.0.3 hard-gate gap).                                                                                                                                                                           |
| **`v04.00.03`**      | Patch — biome/check gate wiring after the v4 rename.                                                                                                                                                                                                                        |
| **`v04.00.02`**      | Patch — Codex second-pass audit close-out (6 findings).                                                                                                                                                                                                                     |
| **`v04.00.01`**      | Patch — close-out of post-v4.0.0 audit (eight surfaces left stale by the rename bulk-replace).                                                                                                                                                                              |
| **`v04.00.00`**      | Major — project renamed to `cross-review`                                                                                                                                                                                                                                   |
| **`v03.07.05`**      | Patch — logs+sessions study 2026-05-15 close-out (4 surgical fixes from 244-session/429-round corpus).                                                                                                                                                                      |
| **`v03.07.03`**      | Patch — "sem fallback é sem fallback" directive + Codex v3.7.2 parecer residuals.                                                                                                                                                                                           |
| **`v03.07.02`**      | Patch — Codex 3rd super-audit close-out of v3.7.1                                                                                                                                                                                                                           |
| **`v03.07.01`**      | Patch — Codex super-audit close-out of v3.7.0                                                                                                                                                                                                                               |
| **`v03.07.00`**      | Minor — Codex super-audit close-out 2026-05-14                                                                                                                                                                                                                              |
| **`v03.06.00`**      | Minor — observability + caller-discipline close-out 2026-05-14                                                                                                                                                                                                              |
| **`v03.05.00`**      | Minor — Codex operational-report close-out 2026-05-14: 5 findings from sessions `f0db3970` + `df052926`.                                                                                                                                                                    |
| **`v03.04.00`**      | Minor — Perplexity multi-failure-mode close-out 2026-05-13: 3 coordinated fixes covering 7 production sessions Codex flagged (`51973fac`, `f72e597a`, `f9a19401`, `99d46a2b`, `00d92cce`, `59776026`, `0003b2fe`).                                                          |
| **`v03.03.00`**      | Minor — Caller peer-selection lock (operator directive 2026-05-12: "TODOS OS AGENTES/PEERS SEMPRE PARTICIPAM, INDEPENDENTE DA ESCOLHA OU VONTADE DO CALLER").                                                                                                               |
| **`v03.02.00`**      | Patch — Codex bug-report close-out 2026-05-12: three surgical fixes (Perplexity `<think>` parser + session-state invariant + orchestrator strict peers).                                                                                                                    |
| **`v03.01.00`**      | Minor — Central config file (`config.json`). Eliminates ~700 redundant env-var declarations across the 7 MCP host configs.                                                                                                                                                  |
| **`v03.00.00`**      | Major — Perplexity joins the sexteto. Quinteto (5 peers) → sexteto (6).                                                                                                                                                                                                     |
| **`v02.28.00`**      | Minor — Cold-start hardening Part 3: Windows registry env-var lookup bulk-cached (3-7 s → ~100 ms).                                                                                                                                                                         |
| **`v02.27.01`**      | Patch — Cold-start hardening Part 2: lazy-load 5 provider SDKs + defer 6 startup sweeps to setTimeout(30s).                                                                                                                                                                 |
| **`v02.27.00`**      | Minor — Cold-start hardening Part 1: corrupted meta.json auto-quarantine + finalized-session auto-prune.                                                                                                                                                                    |
| **`v02.26.01`**      | Patch — `max_attached_evidence_chars` default raised 80_000 → 200_000 to fix multi-file evidence truncation.                                                                                                                                                                |
| **`v02.26.00`**      | Minor — Full pricing-model schema: base + extended-tier + cache (read/write) + promo (limited-time discount), all env-configurable, graceful fallback when fields are absent or promo expires.                                                                              |
| **`v02.25.01`**      | Patch — `meta.json` corruption hotfix: `redact()` env-style pattern was crossing JSON-escape boundaries.                                                                                                                                                                    |
| **`v02.25.00`**      | Third deliberation mode `circular` joins `ship` and `review`.                                                                                                                                                                                                               |
| **`v02.24.00`**      | Evidence-provenance lock for the ship-mode relator (Codex bug report 2026-05-10).                                                                                                                                                                                           |
| **`v02.23.00`**      | Anthropic empty-revision degenerate path detection.                                                                                                                                                                                                                         |
| **`v02.22.00`**      | `session_doctor` drill-down + per-round cost telemetry + budget warning event.                                                                                                                                                                                              |
| **`v02.21.00`**      | Cross-provider prompt caching across all 5 peers (OpenAI, Anthropic, Gemini, DeepSeek, Grok).                                                                                                                                                                               |
| **`v02.18.08`**      | Site sponsor card iteration.                                                                                                                                                                                                                                                |
| **`v02.18.07`**      | Patch — `site/index.html` visual identity refresh.                                                                                                                                                                                                                          |
| **`v02.18.06`**      | Patch — Gemini API function-declaration compatibility for MCP tool inputSchemas.                                                                                                                                                                                            |
| **`v02.18.05`**      | Patch — anti-drift smoke drivers for v2.18.4 audit closure (operator directive 2026-05-07).                                                                                                                                                                                 |
| **`v02.18.04`**      | Patch — Codex external audit 2026-05-07 outcome: 6 surgical fixes (P1.1, P1.2, P1.3, P1.4, P2.1, P2.4).                                                                                                                                                                     |
| **`v02.18.03`**      | Patch — Gemini default pin bump `gemini-3.1-pro-preview` → `gemini-2.5-pro` (operator preference 2026-05-07; coordinated with cross-review-v1 v1.12.4).                                                                                                                     |
| **`v02.18.02`**      | Tier 5 — Windows process-tree introspection (coordinated with cross-review-v1 v1.12.2).                                                                                                                                                                                     |
| **`v02.18.01`**      | Hotfix: closes Dependabot security advisory GHSA-v2v4-37r5-5v8g (medium severity) — `ip-address` XSS in Address6 HTML-emitting methods.                                                                                                                                     |
| **`v02.18.00`**      | F1 caller capability tokens (coordinated with cross-review-v1 v1.11.0).                                                                                                                                                                                                     |
| **`v02.17.00`**      | HARD GATE — identity forgery rejection (operator directive 2026-05-05).                                                                                                                                                                                                     |
| **`v02.16.00`**      | Tribunal protocol repair plus operational doctor.                                                                                                                                                                                                                           |
| **`v02.15.01`**      | `server_info` consensus visibility hotfix.                                                                                                                                                                                                                                  |
| **`v02.15.00`**      | Backlog bundle for operational judge controls.                                                                                                                                                                                                                              |
| **`v02.14.01`**      | Grok reasoning model hotfix.                                                                                                                                                                                                                                                |
| **`v02.14.00`**      | Grok joins the tribunal.                                                                                                                                                                                                                                                    |
| **`v02.13.00`**      | Lead meta-review drift fix.                                                                                                                                                                                                                                                 |
| **`v02.12.00`**      | Shadow judge observability.                                                                                                                                                                                                                                                 |
| **`v02.11.00`**      | Relator lottery plus shadow auto-wire.                                                                                                                                                                                                                                      |
| **`v02.09.00`**      | LLM evidence-judge pass.                                                                                                                                                                                                                                                    |
| **`v02.08.00`**      | Per-peer health and Evidence Broker lifecycle.                                                                                                                                                                                                                              |
| **`v02.07.00`**      | Evidence Broker.                                                                                                                                                                                                                                                            |
| **`v02.06.01`**      | Fallback/recovery budget hard gate.                                                                                                                                                                                                                                         |
| **`v02.06.00`**      | Token-delta compaction plus v2.5 format hotfix bundle.                                                                                                                                                                                                                      |
| **`v02.05.00`**      | Evidence and budget hardening pass.                                                                                                                                                                                                                                         |
| **`v02.04.01`**      | CI stub fail-fast hotfix.                                                                                                                                                                                                                                                   |
| **`v02.04.00`**      | Audit-closure hardening pass.                                                                                                                                                                                                                                               |
| **`v02.03.03`**      | Prompt shielding and financial safety.                                                                                                                                                                                                                                      |
| **`v02.03.02`**      | CI-green README/docs cleanup.                                                                                                                                                                                                                                               |
| **`v02.03.01`**      | README organizational standardization.                                                                                                                                                                                                                                      |
| **`v02.03.00`**      | Provider-neutral `review_focus`.                                                                                                                                                                                                                                            |
| **`v02.02.00`**      | Provider token streaming.                                                                                                                                                                                                                                                   |
| **`v02.01.01`**      | CodeQL and model-selection hardening.                                                                                                                                                                                                                                       |
| **`v02.01.00`**      | First stable `cross-review` release.                                                                                                                                                                                                                                        |
| **`v02.00.04`**      | Session event race hotfix.                                                                                                                                                                                                                                                  |
| **`v02.00.03`**      | Background sessions and durable reports.                                                                                                                                                                                                                                    |
| **`v02.00.02`**      | Publishing and dashboard sanitization.                                                                                                                                                                                                                                      |
| **`v02.00.01`**      | Public npm/package metadata alignment.                                                                                                                                                                                                                                      |
| **`v02.00.00`**      | Development package line hardening.                                                                                                                                                                                                                                         |
| **`v2.0.0-alpha.2`** | Durable session recovery alpha.                                                                                                                                                                                                                                             |
| **`v2.0.0-alpha.1`** | Model attestation and store hardening alpha.                                                                                                                                                                                                                                |
| **`v2.0.0-alpha.0`** | Initial API/SDK-only MCP server.                                                                                                                                                                                                                                            |

## What It Does

`cross-review` is the stable API-first implementation of the cross-review
pattern. It orchestrates provider API clients (OpenAI/Codex, Anthropic/Claude,
Google Gemini, DeepSeek, xAI/Grok, and Perplexity Sonar) and provides an
MCP-compatible server surface.

Runtime calls are real provider calls by default. Stubs exist only for smoke
tests and CI when `CROSS_REVIEW_STUB=1`.

- OpenAI client library for the Codex/OpenAI peer.
- Anthropic TypeScript client library for Claude.
- Google Gen AI client library for Gemini.
- OpenAI-compatible DeepSeek API through the OpenAI client library.
- OpenAI-compatible xAI Grok API through the OpenAI client library.
- OpenAI-compatible Perplexity Sonar API through the OpenAI client library.

## Quick Start

```powershell
# Set API keys (PowerShell example)
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GROK_API_KEY", "<GROK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("PERPLEXITY_API_KEY", "<PERPLEXITY_API_KEY>", "User")
```

Restart your terminal after changing environment variables.

Run the MCP host only from the package published by the registry; do not point a
production host at this checkout:

```bash
npm upgrade -g @lcv-ideas-software/cross-review
```

For local smoke tests (no-cost):

```powershell
$env:CROSS_REVIEW_STUB = "1"
npm --registry=https://registry.npmjs.org test
```

## Configuration

Model selection and runtime behaviour can be controlled with environment
variables. Example overrides (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.6-sol", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MODEL", "sonar-reasoning-pro", "User")
```

`ultra` is a Codex product/CLI execution mode, not a literal OpenAI Responses
API `reasoning.effort`. Cross-review nevertheless accepts it in central config,
environment variables and per-call overrides as a compatibility alias, then
normalizes it inside each provider adapter. For `gpt-5.6-sol`, the wire value is
the official `max`; `ultra` is never sent to the Responses API. Using `max`
directly remains equivalent and makes the API value explicit. The shared
legacy value `minimal` is likewise translated to GPT-5.6's lowest active API
effort, `low`. Explicit older-model overrides use a family-aware compatibility
matrix: GPT-5.5/5.4/5.2 map `minimal` to `low` and `max`/`ultra` to `xhigh`;
GPT-5.1 maps `minimal` to `low` and `xhigh`/`max`/`ultra` to `high`; original
GPT-5 maps `none` to `minimal` and `xhigh`/`max`/`ultra` to `high`. Supported
native values pass through unchanged.

Claude Fable 5 is the canonical Anthropic pin. Its request deliberately omits
the explicit `thinking` field: Fable applies adaptive thinking automatically,
while `output_config.effort` controls depth. Anthropic documents a 30-day data
retention posture and no zero-data-retention option for this model. A response
with `stop_reason="refusal"` is recorded as `provider_refusal`, and partial
refusal output is not accepted as a review.

For Grok, `GROK_API_KEY` is canonical. The default pin is `grok-4.5`; xAI
accepts only `low`, `medium`, or `high` reasoning effort for it, so the adapter
clamps the shared scale before sending the request.

Central configuration is loaded once when the MCP server process starts. Use
`server_info.config_load` to inspect the loaded path, parse result, loaded and
current SHA-256/mtime, and `reload_required`. `live_reload_supported` is
`false`: after editing `config.json` or host environment variables, restart or
reload the MCP host/window. A stale or invalid central config blocks paid calls
instead of silently spending under fallback defaults.

Financial and budget controls are required for paid provider calls. Configure
these environment variables before running real sessions (example):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_MAX_SESSION_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD", "20", "User")
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
- `session_peer_reliability_report`
- `session_check_convergence`
- `session_preflight_check`
- `session_truthfulness_preflight_check`
- `session_attach_evidence`
- `session_evidence_checklist_update`
- `session_evidence_judge_pass`
- `session_evidence_judge_consensus_pass`
- `session_judgment_precision_report`
- `contest_verdict`
- `escalate_to_operator`
- `regenerate_caller_tokens`
- `session_sweep`
- `session_finalize`

`session_doctor` separates real and stub sessions, flags terminal outcomes that
lack terminal events, and reports peer-call cost separately from generation
artifact cost. Terminal `max-rounds` and terminal `not_resurfaced` history stay
in totals but are omitted from default operational findings; pass
`include_terminal_findings=true` to enumerate that historical inventory.
`session_report` uses the same cost split and calls out `not_resurfaced`
evidence checklist items as inference-only, not proof that the requested
evidence was satisfied. If a session otherwise reaches unanimity with open or
`not_resurfaced` checklist items, finalization records an
`*_with_unresolved_evidence` outcome reason and emits a durable unresolved
evidence event. `session_peer_reliability_report` is read-only and aggregates
per-peer parser warnings, evidence ask status, provider failures, cost and
latency.

## Anti-deception and evidence custody

The runtime does not treat a peer's claim that work was completed as proof.
Before paid calls and again during convergence, it checks runtime/model claims,
workflow and authorization assertions, test/build/hash claims, concrete source
correspondence, unresolved evidence asks, model attestation, and structured
status completeness. Authenticated caller evidence supplied inline or through
the `evidence` field is persisted with an integrity digest and transported to
every reviewer as `PEER-SUBMITTED / UNVERIFIED`; no manual operator attachment
is required. Each external submission atomically supersedes the active caller
snapshot while preserving prior manifests for audit, so retries cannot inherit
old failures or replay old successes. Every `READY` vote must cite sources traceable to the reviewed
artifact or admitted evidence. When operational claims depend only on
peer-submitted material, at least two independent non-author reviewers must use
`confidence="verified"` and cite the attachment path, SHA-256 and correlated raw
lines; one voter, inferred confidence or narrative repetition cannot converge.
Relator output that invents operational evidence is rejected rather than
propagated.

`READY` is intentionally not free-form. Its `summary` must be exactly
`No blocking objections remain.`, `caller_requests` and `follow_ups` must be
empty, and no narrative may appear outside the JSON/status envelope. Detail
belongs in `evidence_sources`. This removes synonym/negation ambiguity: any
noncanonical READY becomes `NEEDS_EVIDENCE` and cannot converge.

Each attachment-backed `evidence_sources` item has one canonical string format:

```text
Attachment: evidence/review.txt
sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Artifact quote: "Tests 74 passed (74)"
```

This block shows the decoded string; a raw JSON response encodes its two line
breaks as `\n`.

The path and full 64-character lowercase digest identify the same persisted
attachment, and `Artifact quote` is a literal from that attachment. The quote
must be at least 12 characters and must end the item. Cite the smallest
sufficient literal (normally no more than 500 characters); the hard limits are
2,500 characters per whole item and 30 items. Multiple sources belong in
separate array items—never join attachments or append rationale after a quote.
The wire type deliberately remains `string[]`, so existing string-producing
clients remain compatible; the runtime does not require citation objects.

These limits are both anti-verbosity and anti-shortcut controls. A peer must
inspect the artifact and cite the decisive raw value, but must not replace a
review with a full-file, full-log, or provider-output dump. A bare filename,
digest, generic assurance, or empty code fence cannot sustain `READY`.

Only the human operator may call the optional `session_attach_evidence`
authority surface or mutate terminal state and security configuration. Each new
attachment records the verified caller, origin, timestamp, byte count and
SHA-256, emits a durable custody event, and is re-hashed on every read.
Tampering fails closed. Peer-attributed material remains reviewable but cannot
grant operator authority; a generic attachment does not by itself prove an
unrelated claim.

An evidence requester may automatically withdraw only its own earlier ask after
a strictly grounded `READY/verified` recheck. That transition is recorded as
`requester_reverified`; silence remains `not_resurfaced`, and no peer can close
another peer's ask or an operator-terminal item.

On an existing session, review starters require the persisted petitioner token
or the dedicated operator token. Evidence is attributed to the authenticated
invoker rather than inherited from the session owner, so a peer cannot turn its
submission into `operator_verified` by continuing an operator-owned session.

Caller identity uses seven distinct local capabilities: one for each peer and
one for `operator`. Operator tools require the operator token even when token
enforcement for peers is otherwise permissive. Keep that token only in a
dedicated human-console MCP host—placing it in a model host grants that model
operator authority. `host-tokens.json` contains secrets and assumes the local
OS account/data directory is trusted.

`session_cancel_job` and `contest_verdict` accept only the explicitly persisted
session petitioner with its peer token, or the dedicated operator. Legacy
sessions without an explicit petitioner require the operator token.

## Repository conventions

- **License**: [Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) and [THIRDPARTY](./THIRDPARTY.md).
- **Security disclosure**: see [SECURITY.md](./SECURITY.md).
- **Code of conduct**: see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Changelog**: [CHANGELOG.md](./CHANGELOG.md).
- **Contributing**: see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Sponsorship**: see the repo's `Sponsor` button or [central sponsor page](https://www.lcv.dev/sponsor).
- **Action pinning**: all GitHub Actions are pinned by full SHA per supply-chain hardening baseline.
- **Code owners**: [.github/CODEOWNERS](.github/CODEOWNERS).

## Links

- Site: [https://cross-review.lcv.dev](https://cross-review.lcv.dev)
- npmjs.com: [https://www.npmjs.com/package/@lcv-ideas-software/cross-review](https://www.npmjs.com/package/@lcv-ideas-software/cross-review)
- GitHub: [https://github.com/LCV-Ideas-Software/cross-review](https://github.com/LCV-Ideas-Software/cross-review)
- Sponsors: [https://github.com/sponsors/LCV-Ideas-Software](https://github.com/sponsors/LCV-Ideas-Software)

## License

Apache-2.0. See [LICENSE](./LICENSE), [NOTICE](./NOTICE), and [THIRDPARTY](./THIRDPARTY.md).

---

<p align="center"><span style="font-size: 1.5em;"><strong>Copyright © 2026 LCV Ideas &amp; Software</strong></span><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713 - Pinheiros<br>São Paulo - SP - CEP 05424-150<br>CNPJ: 66.584.678/0001-77 - IM: 3039854</sub></p>
