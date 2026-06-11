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

**Install.**

```bash
npm install -g @lcv-ideas-software/cross-review
# or using the GitHub Packages mirror:
npm install -g @lcv-ideas-software/cross-review --registry=https://npm.pkg.github.com
```

**Status.** Stable. Current release: **v04.03.05** (npm package `4.3.5`). See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

> **Project renamed 2026-05-15.** This project was previously published as
> [`@lcv-ideas-software/cross-review-v2`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2)
> (versions 0.x through 3.7.5). v4.0.0 is the first release under the
> shorter canonical name `@lcv-ideas-software/cross-review` after the
> companion `cross-review-v1` project was discontinued and archived.
> Historical CHANGELOG entries below v4.0.0 reference the prior name
> verbatim.

The version history at a glance:

| Release              | Scope                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`v04.03.05`**      | Patch — filter Perplexity streaming `<think>` token events, expand `~` in central config paths, escape dashboard runtime paths, and harden smoke scripts.                                                          |
| **`v04.03.04`**      | Patch — harden cross-process event sequencing, exact-match fabrication checks, Gemini missing-text handling, and streaming provider error retry classification.                                                    |
| **`v04.03.03`**      | Patch — add forensic diagnostics for append/event and identity failures, flush pending events on shutdown signals, retry structured provider 5xx errors, and refresh official AI provider SDKs.                    |
| **`v04.03.02`**      | Patch — harden persistence redaction, finalized-session mutation guards, side-effect identity gates, caller-token rotation output, and Windows registry config fallback.                                           |
| **`v04.03.01`**      | Patch — tighten skip-peer classification so non-retryable provider errors block, while Anthropic overload events remain retryable and better surfaced in skip diagnostics.                                         |
| **`v04.03.00`**      | Minor — P1/P2/P3 follow-up with unresolved-evidence close-out visibility, an offline fixture eval harness, and a read-only peer reliability report.                                                                |
| **`v04.02.05`**      | Patch — harden session auditability with terminal events, cost split reporting, `not_resurfaced` visibility, and relator provenance checks for session IDs/GitHub URLs.                                            |
| **`v04.02.04`**      | Patch — harden truthfulness preflight auditability, add a read-only preflight retest tool, and reduce false parser warnings for attached/log evidence.                                                             |
| **`v04.02.03`**      | Patch — promote the Gemini canonical default to `gemini-3.1-pro-preview` and refresh the active local Gemini rate card.                                                                                            |
| **`v04.02.02`**      | Patch — provider-doc refresh, Perplexity probe repair, current model pins, and rate-card guidance.                                                                                                                 |
| **`v04.02.01`**      | Patch — publish the workspace hard-gate cleanup as a package release.                                                                                                                                              |
| **`v04.02.00`**      | Minor — bounded MCP session listing and cancellation semantics cleanup.                                                                                                                                            |
| **`v04.01.01`**      | Patch — release the hard-gate cleanup as a published package.                                                                                                                                                      |
| **`v04.01.00`**      | Minor — security hardening of session-store concurrency, write-path DoS surface, and credential redaction.                                                                                                         |
| **`v04.00.08`**      | Patch — eliminate the recurring `js/file-access-to-http` CodeQL false positive at the source.                                                                                                                      |
| **`v04.00.07`**      | Patch — bounded npm registry fetch in the post-publish verifier.                                                                                                                                                   |
| **`v04.00.06`**      | Patch — Windows-safe registry verifier.                                                                                                                                                                            |
| **`v04.00.05`**      | Patch — hard-gate close-out for the Codex v4.0.4 audit.                                                                                                                                                            |
| **`v04.00.04`**      | Patch — restore prettier coverage of `src/` and `scripts/` (close audit on v4.0.3 hard-gate gap).                                                                                                                  |
| **`v04.00.02`**      | Patch — Codex second-pass audit close-out (6 findings).                                                                                                                                                            |
| **`v04.00.01`**      | Patch — close-out of post-v4.0.0 audit (eight surfaces left stale by the rename bulk-replace).                                                                                                                     |
| **`v04.00.00`**      | Major — project renamed to `cross-review`                                                                                                                                                                          |
| **`v03.07.05`**      | Patch — logs+sessions study 2026-05-15 close-out (4 surgical fixes from 244-session/429-round corpus).                                                                                                             |
| **`v03.07.03`**      | Patch — "sem fallback é sem fallback" directive + Codex v3.7.2 parecer residuals.                                                                                                                                  |
| **`v03.07.02`**      | Patch — Codex 3rd super-audit close-out of v3.7.1                                                                                                                                                                  |
| **`v03.07.01`**      | Patch — Codex super-audit close-out of v3.7.0                                                                                                                                                                      |
| **`v03.07.00`**      | Minor — Codex super-audit close-out 2026-05-14                                                                                                                                                                     |
| **`v03.06.00`**      | Minor — observability + caller-discipline close-out 2026-05-14                                                                                                                                                     |
| **`v03.05.00`**      | Minor — Codex operational-report close-out 2026-05-14: 5 findings from sessions `f0db3970` + `df052926`.                                                                                                           |
| **`v03.04.00`**      | Minor — Perplexity multi-failure-mode close-out 2026-05-13: 3 coordinated fixes covering 7 production sessions Codex flagged (`51973fac`, `f72e597a`, `f9a19401`, `99d46a2b`, `00d92cce`, `59776026`, `0003b2fe`). |
| **`v03.03.00`**      | Minor — Caller peer-selection lock (operator directive 2026-05-12: "TODOS OS AGENTES/PEERS SEMPRE PARTICIPAM, INDEPENDENTE DA ESCOLHA OU VONTADE DO CALLER").                                                      |
| **`v03.02.00`**      | Patch — Codex bug-report close-out 2026-05-12: three surgical fixes (Perplexity `<think>` parser + session-state invariant + orchestrator strict peers).                                                           |
| **`v03.01.00`**      | Minor — Central config file (`config.json`). Eliminates ~700 redundant env-var declarations across the 7 MCP host configs.                                                                                         |
| **`v03.00.00`**      | Major — Perplexity joins the sexteto. Quinteto (5 peers) → sexteto (6).                                                                                                                                            |
| **`v02.28.00`**      | Minor — Cold-start hardening Part 3: Windows registry env-var lookup bulk-cached (3-7 s → ~100 ms).                                                                                                                |
| **`v02.27.01`**      | Patch — Cold-start hardening Part 2: lazy-load 5 provider SDKs + defer 6 startup sweeps to setTimeout(30s).                                                                                                        |
| **`v02.27.00`**      | Minor — Cold-start hardening Part 1: corrupted meta.json auto-quarantine + finalized-session auto-prune.                                                                                                           |
| **`v02.26.01`**      | Patch — `max_attached_evidence_chars` default raised 80_000 → 200_000 to fix multi-file evidence truncation.                                                                                                       |
| **`v02.26.00`**      | Minor — Full pricing-model schema: base + extended-tier + cache (read/write) + promo (limited-time discount), all env-configurable, graceful fallback when fields are absent or promo expires.                     |
| **`v02.25.01`**      | Patch — `meta.json` corruption hotfix: `redact()` env-style pattern was crossing JSON-escape boundaries.                                                                                                           |
| **`v02.25.00`**      | Third deliberation mode `circular` joins `ship` and `review`.                                                                                                                                                      |
| **`v02.24.00`**      | Evidence-provenance lock for the ship-mode relator (Codex bug report 2026-05-10).                                                                                                                                  |
| **`v02.23.00`**      | Anthropic empty-revision degenerate path detection.                                                                                                                                                                |
| **`v02.22.00`**      | `session_doctor` drill-down + per-round cost telemetry + budget warning event.                                                                                                                                     |
| **`v02.21.00`**      | Cross-provider prompt caching across all 5 peers (OpenAI, Anthropic, Gemini, DeepSeek, Grok).                                                                                                                      |
| **`v02.18.08`**      | Site sponsor card iteration.                                                                                                                                                                                       |
| **`v02.18.07`**      | Patch — `site/index.html` visual identity refresh.                                                                                                                                                                 |
| **`v02.18.06`**      | Patch — Gemini API function-declaration compatibility for MCP tool inputSchemas.                                                                                                                                   |
| **`v02.18.05`**      | Patch — anti-drift smoke drivers for v2.18.4 audit closure (operator directive 2026-05-07).                                                                                                                        |
| **`v02.18.04`**      | Patch — Codex external audit 2026-05-07 outcome: 6 surgical fixes (P1.1, P1.2, P1.3, P1.4, P2.1, P2.4).                                                                                                            |
| **`v02.18.03`**      | Patch — Gemini default pin bump `gemini-3.1-pro-preview` → `gemini-2.5-pro` (operator preference 2026-05-07; coordinated with cross-review-v1 v1.12.4).                                                            |
| **`v02.18.02`**      | Tier 5 — Windows process-tree introspection (coordinated with cross-review-v1 v1.12.2).                                                                                                                            |
| **`v02.18.01`**      | Hotfix: closes Dependabot security advisory GHSA-v2v4-37r5-5v8g (medium severity) — `ip-address` XSS in Address6 HTML-emitting methods.                                                                            |
| **`v02.18.00`**      | F1 caller capability tokens (coordinated with cross-review-v1 v1.11.0).                                                                                                                                            |
| **`v02.17.00`**      | HARD GATE — identity forgery rejection (operator directive 2026-05-05).                                                                                                                                            |
| **`v02.16.00`**      | Tribunal protocol repair plus operational doctor.                                                                                                                                                                  |
| **`v02.15.01`**      | `server_info` consensus visibility hotfix.                                                                                                                                                                         |
| **`v02.15.00`**      | Backlog bundle for operational judge controls.                                                                                                                                                                     |
| **`v02.14.01`**      | Grok reasoning model hotfix.                                                                                                                                                                                       |
| **`v02.14.00`**      | Grok joins the tribunal.                                                                                                                                                                                           |
| **`v02.13.00`**      | Lead meta-review drift fix.                                                                                                                                                                                        |
| **`v02.12.00`**      | Shadow judge observability.                                                                                                                                                                                        |
| **`v02.11.00`**      | Relator lottery plus shadow auto-wire.                                                                                                                                                                             |
| **`v02.09.00`**      | LLM evidence-judge pass.                                                                                                                                                                                           |
| **`v02.08.00`**      | Per-peer health and Evidence Broker lifecycle.                                                                                                                                                                     |
| **`v02.07.00`**      | Evidence Broker.                                                                                                                                                                                                   |
| **`v02.06.01`**      | Fallback/recovery budget hard gate.                                                                                                                                                                                |
| **`v02.06.00`**      | Token-delta compaction plus v2.5 format hotfix bundle.                                                                                                                                                             |
| **`v02.05.00`**      | Evidence and budget hardening pass.                                                                                                                                                                                |
| **`v02.04.01`**      | CI stub fail-fast hotfix.                                                                                                                                                                                          |
| **`v02.04.00`**      | Audit-closure hardening pass.                                                                                                                                                                                      |
| **`v02.03.03`**      | Prompt shielding and financial safety.                                                                                                                                                                             |
| **`v02.03.02`**      | CI-green README/docs cleanup.                                                                                                                                                                                      |
| **`v02.03.01`**      | README organizational standardization.                                                                                                                                                                             |
| **`v02.03.00`**      | Provider-neutral `review_focus`.                                                                                                                                                                                   |
| **`v02.02.00`**      | Provider token streaming.                                                                                                                                                                                          |
| **`v02.01.01`**      | CodeQL and model-selection hardening.                                                                                                                                                                              |
| **`v02.01.00`**      | First stable `cross-review` release.                                                                                                                                                                               |
| **`v02.00.04`**      | Session event race hotfix.                                                                                                                                                                                         |
| **`v02.00.03`**      | Background sessions and durable reports.                                                                                                                                                                           |
| **`v02.00.02`**      | Publishing and dashboard sanitization.                                                                                                                                                                             |
| **`v02.00.01`**      | Public npm/package metadata alignment.                                                                                                                                                                             |
| **`v02.00.00`**      | Development package line hardening.                                                                                                                                                                                |
| **`v2.0.0-alpha.2`** | Durable session recovery alpha.                                                                                                                                                                                    |
| **`v2.0.0-alpha.1`** | Model attestation and store hardening alpha.                                                                                                                                                                       |
| **`v2.0.0-alpha.0`** | Initial API/SDK-only MCP server.                                                                                                                                                                                   |

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

Build and run locally:

```bash
npm install
npm --registry=https://registry.npmjs.org run build
node dist/src/mcp/server.js
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
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.20-multi-agent", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_REASONING_EFFORT", "xhigh", "User")
```

For Grok, `GROK_API_KEY` is canonical. The default pin is `grok-4.3`, which
accepts explicit `reasoning.effort` through `high`; the adapter clamps the
shared effort scale before sending it. `grok-4-latest`, `grok-4.20`, and
`grok-4.20-reasoning` use xAI automatic reasoning in this runtime.
`grok-4.20-multi-agent` remains available as an explicit override for the
multi-agent variant.

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
artifact cost. `session_report` uses the same split and calls out
`not_resurfaced` evidence checklist items as inference-only, not proof that the
requested evidence was satisfied. If a session otherwise reaches unanimity with
open or `not_resurfaced` checklist items, finalization records an
`*_with_unresolved_evidence` outcome reason and emits a durable unresolved
evidence event. `session_peer_reliability_report` is read-only and aggregates
per-peer parser warnings, evidence ask status, provider failures, cost and
latency.

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
