# Architecture

This API-only `cross-review` implementation is intentionally independent from the CLI-based `cross-review-v1` project.

## Runtime Layers

1. MCP server: exposes workflow tools over stdio.
2. Orchestrator: creates sessions, runs reviews, checks unanimity and asks the lead peer to revise.
3. Peer adapters: call official provider APIs and client libraries.
4. Model selection: queries model APIs and chooses the highest-capability documented model available to the key.
5. Session store: writes durable JSON and Markdown artifacts under `data/sessions`.
6. Session events: writes durable `events.ndjson` streams per session for long-running work.
7. Token streaming: writes count-based `peer.token.delta` and `peer.token.completed` events when provider streaming is enabled.
8. Reports: writes `session-report.md` with convergence, failures, decision quality, costs and recent events.
9. Observability: writes one NDJSON log per process under `data/logs`.
10. Dashboard: local read-only HTTP UI for sessions, events, reports, probes and metrics.

## Real Execution Rule

Runtime default is real API execution. Stubs are disabled unless `CROSS_REVIEW_STUB=1`.

## Timeout Model

Real API review rounds are intentionally long-running. The provider-side HTTP
timeout is controlled by `CROSS_REVIEW_TIMEOUT_MS` and defaults to 30
minutes.

MCP hosts also have their own client-to-server request timeout. For real peer
calls, configure the host timeout to at least 300 seconds. A lower generic
default, such as 60 seconds, can close the MCP request while the provider calls
are still legitimately processing.

For host environments that cannot keep a long MCP request open, use
`session_start_round` or `session_start_unanimous`. Those tools create a
background in-process job and return immediately. Use `session_poll`,
`session_events`, `session_metrics` and `session_report` to follow progress
without blocking the client request. `session_cancel_job` requests cooperative
cancellation and forwards `AbortSignal` to provider client calls where supported.

## Streaming Model

`CROSS_REVIEW_STREAM_EVENTS` controls normal workflow events and defaults to
enabled. `CROSS_REVIEW_STREAM_TOKENS` controls provider token-progress events
and also defaults to enabled. `runtime_capabilities.token_streaming` reflects
the effective token-streaming setting, not a compile-time constant.

When token streaming is active, adapters use provider-native streaming APIs:

- OpenAI: Responses API streaming events, including `response.output_text.delta`.
- Anthropic: Messages stream helper with text deltas and `finalMessage()`.
- Gemini: `models.generateContentStream`.
- DeepSeek: OpenAI-compatible chat completions with `stream: true`.

The streaming path is not a separate fake progress channel. The same streamed
text is accumulated and then parsed into the existing review or generation
result.

For safety, `peer.token.delta` events include character counts by default rather
than provider text. `CROSS_REVIEW_STREAM_TEXT=1` can include redacted text in
trusted local diagnostics, but it is intentionally opt-in because providers may
split sensitive strings across chunks. Raw thinking content is still not
requested or persisted.

## Unanimity Rule

A session converges only when the caller status is `READY`, every selected peer returns `READY`, and no peer failed or omitted a machine-readable status.

Decision quality is tracked per peer:

- `clean`: parsed status without warnings.
- `format_warning`: parsed with non-blocking parser warnings.
- `recovered`: recovered through format repair, moderation-safe retry or bounded sanitization.
- `needs_operator_review`: no parseable status remains after recovery.
- `failed`: provider or model-selection failure blocked the peer.

`unparseable_after_recovery`, `prompt_flagged_by_moderation`,
`silent_model_downgrade` and other rejected peer failures always block
unanimity until resolved.

## Moderation-Safe Prompting

Prior peer history is summarized from structured fields instead of replaying
raw model text. This keeps prompts smaller, reduces the chance that a verbose
peer repeats policy-sensitive language into a later provider, and produces more
useful audit trails.

If a provider still rejects a prompt as moderated or safety-blocked, the
orchestrator records the failure class and retries once with a compact,
sanitized review prompt. This retry does not bypass provider policy: if the
compact context is insufficient, the peer must return `NEEDS_EVIDENCE` or the
session remains blocked for operator action.

## Model Discovery

Provider model APIs are queried at probe/session initialization:

- OpenAI: Models API.
- Anthropic: Models API.
- Gemini: `models.list`.
- DeepSeek: OpenAI-compatible `/models`.

The selected model and selection evidence are persisted in the session capability snapshot.

## Provider Thinking Baseline

The peer adapters use the strongest official reasoning controls available for each provider because cross-review is correctness-oriented:

- OpenAI runs through the Responses API with high reasoning effort.
- Anthropic uses adaptive thinking and omits raw thinking content from responses.
- Gemini enables thinking configuration for Gemini 3.x and the Gemini 2.5 fallback.
- DeepSeek enables Thinking Mode and follows the official multi-round guidance by resending the summarized session context in each stateless request.

Raw chain-of-thought is not persisted. Session continuity is represented through prompts, structured peer decisions, summaries and artifacts.

## Stable Rename

The v4.0.0 release on 2026-05-15 renamed the product from `cross-review-v2` to
`cross-review` (npm package, GitHub repo, GitHub Pages domain, MCP server key
in host configs, env-var prefix, binaries). The companion `cross-review-v1`
package was discontinued and archived on the same date. Prior names remain
only in dated historical changelog entries and memory notes; all active
surfaces describe the product as `cross-review`.
