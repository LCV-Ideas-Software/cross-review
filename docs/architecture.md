# Architecture

This API-only `cross-review` implementation is intentionally independent from the CLI-based `cross-review-v1` project.

## Runtime Layers

1. MCP server: exposes workflow tools over stdio.
2. Orchestrator: creates sessions, runs reviews, checks unanimity and asks the lead peer to revise.
3. Peer adapters: call official provider APIs and client libraries.
4. Model selection: validates the canonical no-downgrade pin against official
   model APIs where available; it never auto-selects an off-policy model.
5. Session store: writes durable JSON and Markdown artifacts plus compact
   background-job status under `<data_dir>/sessions`.
6. Session events: writes durable `events.ndjson` streams per session for long-running work.
7. Token streaming: writes attempt-scoped `peer.token.delta`,
   `peer.token.discarded` and `peer.token.completed` events when provider
   streaming is enabled.
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

`session_poll` defaults to `detail="summary"`. It exposes bounded progress,
verdict and convergence data without retransmitting complete prior-round peer
`text`, `raw` or `structured` bodies. `detail="full"` and
`session_read` are the explicit forensic paths. The poll distinguishes
`active_round_number` (work currently executing) from
`latest_completed_round_number` (the newest round already appended); an
active round can therefore be newer than the latest completed one.

Background-job observations are written as compact per-job records inside the
contained session directory and reconciled with process-local state. This lets
sibling MCP hosts and restarted runtimes distinguish terminal work from an
unknown job id. A cancellation that loses the race to settlement is an
idempotent no-op: `job_already_terminal` or
`session_already_terminal` is returned with `final_state` instead of an
ambiguous missing-running-job result.

Object-returning tools honor `response_format="markdown"` through a shared
Markdown renderer. Caller-, peer- and persistence-controlled strings are
HTML-neutralized before rendering; JSON remains the default wire text.

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

Every delta is marked `provisional: true` and carries the provider-attempt
number. Consumers commit text only after the matching
`peer.token.completed` (`committed: true`). Any truncation, filtered terminal,
network failure, cancellation or retry cancels the buffer timer, drops pending
text and emits `peer.token.discarded` for that attempt before another attempt
can become authoritative. This preserves live observability without letting a
stale partial READY prefix masquerade as the final verdict.

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
that the requested evidence was supplied. An explicit operator disposition, an
independent judge, or a strictly grounded `READY/verified` recheck by the same
peer that opened the ask can close it; the latter is persisted as
`requester_reverified` and cannot affect another peer's or a terminal item.

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

Every `READY` vote requires concrete evidence sources traceable to the artifact,
authenticated caller evidence or optional operator-verified attachments. If an
operational claim depends only on peer-submitted evidence, `inferred` is not
enough: at least two independent reviewers must return `READY/verified` with the
persisted path, SHA-256 and value-corresponding raw quote.
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

Authenticated caller evidence is automatically persisted, integrity-hashed and
transported as reviewable material; no manual operator action is required.
An append-only submission manifest selects exactly one active automatic
caller-evidence snapshot. Superseded snapshots remain forensic history but are
excluded from current preflight/prompt/grounding, preventing retry poisoning,
stale-success replay and oldest-first prompt starvation. Evidence filenames
include UUID entropy so concurrent same-label writes cannot collide.
Optional authority promotion plus evidence/checklist, terminal-state, and
security mutations remain operator-only MCP operations. A new evidence artifact
stores `attached_by`, `origin`, `attached_at`, UTF-8 byte count and SHA-256 and
emits `session.evidence_attached`. Every read recomputes bytes and digest;
missing or altered current-format evidence fails closed. Peer-attributed
material is included in reviewer prompts with an explicit unverified label;
legacy attachments remain audit-only.

Integrity is not authority. For peer-submitted operational evidence, the author
is recused and convergence requires a minimum two-reviewer corroboration panel.
Each qualifying vote must be verified and bind its citation to the persisted
path, digest and literal values. Conflicting command records or any non-zero
exit code block the claimed success even when nearby text says `passed`.

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

The canonical attachment citation is one string array item, in this exact
order: `Attachment: <persisted-path>`, `sha256=<64 lowercase hex>`, then
`Artifact quote: "<literal from that same attachment>"`. The three components
are separated by newlines after JSON decoding (raw JSON encodes them as `\n`),
and the quote (minimum 12 characters) ends the item.
Multiple sources are multiple items; concatenating sources defeats
same-attachment correlation and is invalid. `evidence_sources` remains a
`string[]` contract for compatibility. Peers should use the smallest sufficient
literal (normally at most 500 characters), not whole files, logs, or provider
responses; the schema hard caps the complete item at 2,500 characters and the
array at 30 items.

These controls attest observable behavior, not a model's private effort. In
circular mode an unchanged artifact is only a stability signal and requires a
full independent rotation before convergence; one peer echoing text is not
cryptographic proof of cognition. Attachment SHA-256 attests post-custody
integrity, not human authorship, and the local token/evidence files inherit the
operating-system account's trust boundary.

## Provider Thinking Baseline

The peer adapters use the strongest official reasoning controls available for each provider because cross-review is correctness-oriented:

- OpenAI runs `gpt-5.6-sol` through the Responses API. Its strongest official
  API value is `reasoning.effort=max`. The shared config also accepts `ultra`
  as an operator-facing compatibility alias and normalizes it to `max`; the
  alias is never transmitted to OpenAI. Explicit GPT-5.5/5.4/5.2 overrides
  cap at `xhigh`, GPT-5.1 and original GPT-5 cap at `high`, and unsupported
  lower literals are translated to the nearest available family value.
- Anthropic runs canonical `claude-fable-5`. The request omits the explicit
  `thinking` field because adaptive thinking is automatic and controls depth
  with `output_config.effort`. Fable has 30-day/no-ZDR retention semantics.
- Gemini maps the shared configured effort to the pinned Gemini 3.x model's
  native `LOW`, `MEDIUM`, or `HIGH` thinking level.
- DeepSeek enables Thinking Mode with top-level `reasoning_effort` and follows
  the official multi-round guidance by resending summarized context in each
  stateless request.
- Grok runs pinned `grok-4.5` with explicit `reasoning.effort` clamped to
  `low`, `medium`, or `high` (`ultra` becomes `high`).
- Perplexity runs the pinned `sonar-reasoning-pro` model with an explicit
  `reasoning_effort` (`minimal`/`low`/`medium`/`high`); the shared effort scale
  is clamped down into that range (`ultra` becomes `high`).

The internal `ReasoningEffort` scale therefore includes the compatibility
alias `ultra`, but adapters own the provider-specific normalization boundary:
OpenAI GPT-5.6, Anthropic and DeepSeek use `max`; Grok 4.5 and Perplexity use
`high`; Gemini maps the shared setting to its native `ThinkingLevel` enum and
receives no shared effort string. Older explicit OpenAI model overrides use their own
family-specific effort enum instead of the GPT-5.6 enum.

## Provider Structured-Output Boundaries

The complete review-result contract remains local: Zod, normalization and the
prompt enforce all enum, item-count and length limits. Adapters transmit only
the JSON Schema subset documented by each provider:

- OpenAI receives the complete strict schema.
- Anthropic receives the official SDK helper's lowered schema; unsupported
  dimensional constraints are enforced locally, and documented enum casing
  variation is canonicalized only when it is an exact case-insensitive match.
- Gemini retains documented `maxItems` constraints but omits undocumented
  `maxLength` keywords.
- DeepSeek uses documented JSON Object mode plus local validation; it does not
  receive a JSON Schema wrapper.
- xAI retains documented limits, with evidence-item `maxLength` constrained to
  the guaranteed 2,048-character range, and omits undocumented
  `text.verbosity`.
- Perplexity receives the minimal documented Sonar JSON Schema wrapper without
  undocumented dimensional constraints or OpenAI-only streaming options.

One canonical schema is therefore never assumed to be a universal wire
contract.

## Output-Limit Recovery

Terminal output remains fail-closed. The runtime performs exactly one
controlled same-model recovery for OpenAI `response.incomplete` with
`incomplete_details.reason=max_output_tokens` and Gemini `MAX_TOKENS` when the
original effort can be reduced. Claude Fable 5 `max_tokens` receives the same
single recovery only from `high`/`xhigh`/`max`; `low` and `medium` do not retry,
because medium would increase or repeat effort. The second request keeps the
same prompt and output ceiling, records discarded partial streaming output,
and preserves per-attempt usage and cost. A second truncation ends the call.
DeepSeek `length`, generic xAI incomplete responses and Perplexity finish
reasons remain non-retryable because their public contracts do not distinguish
every cause safely.

`content_filter`, Gemini candidate `SAFETY`, refusals and other filtered output
terminals never enter generic retry, fallback or moderation-safe prompt
recovery. Only an explicit provider rejection of the input prompt, such as
Gemini `promptFeedback.blockReason`, can use the separate compact-input
recovery path, and its extra call remains subject to budget preflight.

Rejected terminals are still billable evidence. Adapters attach any
provider-reported usage and effective-model cost before throwing; the retry
layer merges billed failed attempts into a later success or final failure.
DeepSeek streaming defers rejection until it has drained the documented final
`choices: []` usage chunk. Responses API `status=failed` keeps
`response.error`; SSE `type=error` reads official top-level fields; and output
refusals (`output[].content[].type=refusal` or
`response.refusal.delta/done`) terminate without format recovery.

Truthfulness attribution is syntactic, not line-wide. “Cross-review runtime”,
“cross-review server”, `server_info`, `runtime_capabilities`, `model_pin` and
MCP runtime/server subjects belong to the local runtime namespace. A phrase
such as “cross-review submission/session” does not transfer an application's
model, version or date into that namespace. Separately, a generic assurance
copied from the artifact cannot prove its own READY verdict; concrete document
or code literals remain reviewable, while correctness/test claims require
independent value-corresponding evidence.

Raw chain-of-thought is not persisted. Session continuity is represented through prompts, structured peer decisions, summaries and artifacts.

## Stable Rename

The v4.0.0 release on 2026-05-15 renamed the product from `cross-review-v2` to
`cross-review` (npm package, GitHub repo, GitHub Pages domain, MCP server key
in host configs, env-var prefix, binaries). The companion `cross-review-v1`
package was discontinued and archived on the same date. Prior names remain
only in dated historical changelog entries and memory notes; all active
surfaces describe the product as `cross-review`.
