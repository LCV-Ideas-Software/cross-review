# Architecture

This API-only `cross-review` implementation is intentionally independent from the CLI-based `cross-review-v1` project.

## Runtime Layers

1. MCP server: exposes workflow tools over stdio.
2. Orchestrator: creates sessions, runs reviews, checks unanimity and asks the lead peer to revise.
3. Peer adapters: call official provider APIs and client libraries.
4. Model selection: validates the canonical no-downgrade pin against official
   model APIs where available; it never auto-selects an off-policy model.
5. Session store: writes durable JSON and Markdown artifacts under `<data_dir>/sessions`.
6. Session events: writes durable `events.ndjson` streams per session for long-running work.
7. Token streaming: writes count-based `peer.token.delta` and `peer.token.completed` events when provider streaming is enabled.
8. Reports: writes `session-report.md` with convergence, failures, decision quality, peer-vs-generation cost split, evidence checklist status and recent events.
9. Observability: writes one NDJSON log per process under `<data_dir>/logs`.
10. Dashboard: local read-only HTTP UI for sessions, events, reports, probes and metrics.

## Real Execution Rule

Runtime default is real API execution. Stubs are disabled unless
`CROSS_REVIEW_STUB=1` is paired with explicit confirmation
(`CROSS_REVIEW_STUB_CONFIRMED=1` or `NODE_ENV=test`).

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

## Terminal Events and Audit Reports

Session outcome changes are persisted in `meta.json` and mirrored into
`events.ndjson` as terminal events. Normal finalization writes
`session.finalized`; cooperative cancellation writes `session.cancelled`.
`session_doctor` flags legacy or corrupted sessions where terminal outcome
metadata exists without the expected terminal event.

Cost reporting distinguishes reviewer peer calls from relator/lead generation
artifacts. `session_report` and `session_doctor` expose the split so historical
audits can reconcile total cost without confusing peer-only totals with all-in
session cost.

Evidence checklist state is also surfaced in reports. `not_resurfaced` means an
ask was not repeated in a later round; it is not a verified satisfaction signal.
If the ready/unanimity gate is otherwise satisfied while checklist items remain
`open` or `not_resurfaced`, convergence is blocked. Non-resurfacing is not proof
that the requested evidence was supplied; only an explicit, auditable terminal
disposition can close the item.

`session_doctor` keeps terminal `max-rounds` and terminal `not_resurfaced`
history in aggregate totals while omitting that terminal inventory from default
operational findings. Use `include_terminal_findings=true` when a historical
cleanup/audit needs the per-session list.

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
`provider_refusal`, `silent_model_downgrade` and other rejected peer failures
always block unanimity until resolved.

Every `READY` vote, including `confidence="inferred"`, requires concrete
evidence sources traceable to the artifact or operator-custodied attachments.
Runtime facts may validate a matching runtime claim in the separate
truthfulness preflight, but cannot by themselves prove that a peer reviewed the
artifact. Missing, generic, invented, or untraceable
citations are downgraded to `NEEDS_EVIDENCE`; incomplete structured status does
not converge, and the same checks are re-applied in the convergence layer so a
parser or adapter path cannot bypass them.

Skip-peer convergence is reserved for genuine provider/model unavailability.
Retryable provider overloads can be skipped after retries are exhausted, but
non-retryable provider errors, such as payload or schema rejections, remain
blocking failures.

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

Claude Fable 5 refusals are different from transport errors: Anthropic returns
HTTP 200 with `stop_reason="refusal"` and optional `stop_details`. The
Anthropic adapter treats this as a non-skippable `provider_refusal`, emits a
structured `provider.refusal` event, discards incomplete refusal output, and
only tries another Claude model when the operator configured an explicit
fallback chain.

## Model Discovery

Provider model APIs are queried at probe/session initialization where the
provider exposes a model-list surface:

- OpenAI: Models API.
- Anthropic: Models API.
- Gemini: `models.list`.
- DeepSeek: OpenAI-compatible `/models`.
- xAI: OpenAI-compatible `/models`.
- Perplexity: no public Sonar `models.list`; the runtime keeps the officially
  documented pin with inferred confidence. Its default `auth_only` probe checks
  key presence without buying a completion, while `live` deliberately performs
  a minimal paid request.

The selected model and selection evidence are persisted in the session capability snapshot.

## Central Configuration Runtime

Central `config.json`, process environment and Windows user environment are
read once during MCP process startup. `server_info.config_load` exposes the
load result, path, parse error, applied/overridden field counts, loaded and
current mtime/SHA-256, `live_reload_supported=false`, and `reload_required`.
Paid calls fail closed when the file was invalid at load or its current hash no
longer matches the loaded snapshot. Editing the file therefore requires an MCP
host/window restart or reload; opening a new tool call is not a live reload.

## Evidence Integrity and Anti-deception

Evidence attachment and authoritative evidence/checklist, terminal-state, and
security mutations are operator-only MCP operations. A new evidence attachment
stores `attached_by`, `origin`, `attached_at`, UTF-8 byte count and SHA-256 and
emits `session.evidence_attached`. Every read recomputes bytes and digest;
missing or altered current-format evidence fails closed. Legacy and
peer-attributed attachments are readable for audit but excluded from trusted
prompt/preflight/grounding corpora.

The identity map contains six peer capabilities plus a separate `operator`
capability. Operator-only tools require a verified operator token regardless of
the permissive peer-token setting. A model token cannot be reused as operator,
and evidence judges cannot rule on their own asks. The operator token belongs
only in a dedicated human-console host.

The truthfulness, evidence-provenance and convergence gates compare asserted
runtime/model values, workflow/deployment/authorization claims, hashes and test
or build results with the actual runtime facts and corresponding evidence. A
generic or unrelated attachment cannot bless a claim. Fabricated relator
assertions, model mismatches, unresolved evidence, self-review, incomplete
structured output, or unsupported verified confidence remain blocking.

READY uses a canonical decision envelope rather than natural-language intent
classification: `summary` is exactly `No blocking objections remain.`,
`caller_requests`/`follow_ups` are empty, and external narrative is forbidden.
All explanatory detail stays in grounded `evidence_sources`. Cancellation and
verdict contestation additionally require the explicit persisted petitioner
token or the operator token; ambiguous legacy ownership fails closed to the
operator.

These controls attest observable behavior, not a model's private effort. In
circular mode an unchanged artifact is only a stability signal and requires a
full independent rotation before convergence; one peer echoing text is not
cryptographic proof of cognition. Attachment SHA-256 attests post-custody
integrity, not human authorship, and the local token/evidence files inherit the
operating-system account's trust boundary.

## Provider Thinking Baseline

The peer adapters use the strongest official reasoning controls available for each provider because cross-review is correctness-oriented:

- OpenAI runs `gpt-5.6-sol` through the Responses API. Use
  `reasoning.effort=max`; `ultra` is a Codex product mode, not an API value.
- Anthropic runs canonical `claude-fable-5`. The request omits the explicit
  `thinking` field because adaptive thinking is automatic and controls depth
  with `output_config.effort`. Fable has 30-day/no-ZDR retention semantics.
- Gemini enables thinking configuration for the pinned Gemini 3.x model.
- DeepSeek enables Thinking Mode with top-level `reasoning_effort` and follows
  the official multi-round guidance by resending summarized context in each
  stateless request.
- Grok runs pinned `grok-4.5` with explicit `reasoning.effort` clamped to
  `low`, `medium`, or `high`.
- Perplexity runs the pinned `sonar-reasoning-pro` model with an explicit `reasoning_effort` (`minimal`/`low`/`medium`/`high`); the shared effort scale is clamped down into that range.

Raw chain-of-thought is not persisted. Session continuity is represented through prompts, structured peer decisions, summaries and artifacts.

## Stable Rename

The v4.0.0 release on 2026-05-15 renamed the product from `cross-review-v2` to
`cross-review` (npm package, GitHub repo, GitHub Pages domain, MCP server key
in host configs, env-var prefix, binaries). The companion `cross-review-v1`
package was discontinued and archived on the same date. Prior names remain
only in dated historical changelog entries and memory notes; all active
surfaces describe the product as `cross-review`.
