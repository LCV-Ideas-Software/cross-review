# Cross-review v4.5.4 Remediation / v4.5.5 Release Audit

Date: 2026-07-12, America/Sao_Paulo  
Repository: `LCV-Ideas-Software/cross-review`  
Source target: `4.5.5` / `v04.05.05`
Runtime observed during diagnosis: `4.5.3`  
Method: root-cause analysis, focused RED/GREEN regressions, integrated smoke,
runtime smoke, source-contract audit and official-provider documentation review

## Executive conclusion

The 4.5.3 failures were real cross-review defects, not rejections of the
reviewed applications. The most damaging defect class was a mismatch between
the evidence contract presented to reviewers and the heuristics that later
reclassified their answers. Valid raw `READY` votes could be converted to
`NEEDS_EVIDENCE`, while a subsequent relator preflight could abort on product
version metadata or an attributed provider-documentation quote.

The v4.5.4 source repairs the observed P0 paths:

- authenticated inline evidence is transported automatically; no manual
  operator attachment is required;
- each citation is grounded independently against one attachment, with its own
  path, full SHA-256 and literal quote;
- instructions, questions, third-party quotations and reviewed-product
  versions are not treated as local runtime assertions;
- the raw provider verdict, parsed verdict, normalized verdict and every
  transformation remain durable and reportable;
- an evidence-ask author is excluded before consensus-judge dispatch and from
  the unanimity denominator;
- cancellation propagates through retries, paid recoveries, judges and
  relators, including requests made by another MCP window;
- failed, skipped, cancelled, judge and generation attempts enter an explicit
  financial ledger; unknown coverage prevents a false reconciliation claim;
- persisted per-call and `until_stopped` ceilings are enforced before every
  reviewer, recovery, judge and generation dispatch;
- orphaned in-flight review rounds fail closed with explicit unpriced attempts,
  and an operator cannot erase active provider work by finalizing the session;
- caller `max_rounds` is hard unless `allow_auto_extension=true` is explicitly
  supplied; and
- central config accepts `ultra` as an operator-facing compatibility alias but
  normalizes it to a provider-supported wire value.

No P0 known from the supplied Claude/Codex reports or the subsequent paid-call
inventory remains open in the normal, catchable execution paths covered by the
regressions. Architectural P1 limitations are recorded below rather than hidden.

## Audit inputs

This remediation incorporated:

1. the operator-supplied Claude technical report for v4.5.3;
2. [the consolidated 4.5.x field report](./2026-07-11-cross-review-4.5.x-field-report.md);
3. [the independent v4.5.3 runtime hardgate report](./cross-review-v4.5.3-hardgate-runtime-field-report-2026-07-11.md);
4. session `6ea69902-1d9c-4ad6-a50d-e7b48649f3d1`, which received materially
   unanimous READY votes but aborted in truthfulness preflight;
5. sessions `55013c4b-9678-4638-9457-fcf9227e9e60` and `8789eb50`, plus the
   later 4.5.3 field records that exposed citation, relator and accounting defects;
6. the central-config/runtime question raised by the operator; and
7. a source-level inventory of all paid `call`, `generate` and judge dispatches.

The runtime was checked through its live `server_info` surface, not inferred
from installed files. The reloaded host reported 4.5.3, the loaded and current
central-config hashes matched, `config_load.applied=true` and
`reload_required=false`. The earlier stale-window hypothesis was valid as a
general operational risk, but it did not explain the post-reload 4.5.3 defects.

## Root-cause graph

```text
authenticated caller evidence
        |
        v
evidence/truthfulness preflight
  | false claim tokenization
  | namespace collision (reviewed app vs cross-review runtime)
  v
provider calls -> raw READY
        |
        v
grounding/status normalization
  | joined-source parsing
  | cross-attachment digest/quote correlation
  | prompt/parser citation grammar mismatch
  v
READY reclassified as NEEDS_EVIDENCE
        |
        v
relator/judge/retry paths
  | self-judge in unanimity denominator
  | cancellation only process-local
  | failed/skipped calls omitted from ledger
  v
formal abort or non-convergence without a substantive code objection
```

## Findings and remediations

### P0 — Valid multi-source evidence was treated as one fabricated quote

The old path joined `evidence_sources` and reparsed the combined string. This
made two individually valid sources fail as a set and permitted predicates from
different sources to interact.

v4.5.4 validates each source independently. A valid source plus an invented
source fails; two valid sources pass. Path, digest and literal must correlate
inside the same attachment, preventing an attachment-A digest from grounding an
attachment-B quote.

### P0 — Truthfulness heuristics confused grammar and namespaces

Bare tokens such as `production`, dates and version strings were enough to
classify instructions, attributed provider quotations, database migrations or
the reviewed application's version as local cross-review runtime assertions.

v4.5.4 requires claim-bearing syntax, excludes imperatives/questions and
attributed documentation, and scopes model/version comparison to cross-review's
own runtime facts. Workflow/run/session wording is temporal context rather than
a runtime namespace; historical gating requires an explicit cross-review, MCP,
`server_info`, `runtime_capabilities` or local-runtime subject. Genuine
contradictory runtime assertions remain blocked.

### P0 — Verdict transformations were not first-class evidence

Reports emphasized the normalized result and made it difficult to distinguish a
provider's answer from a runtime reclassification.

Every result now records `raw_status`, `parsed_status`, `normalized_status` and
the ordered transformation list. Grounding changes append a named
transformation. Reports and durable artifacts show the full chain.

### P0 — Consensus included an item's author as a failed judge

When the configured consensus panel contained the peer that opened an evidence
ask, self-judgment was correctly forbidden but incorrectly counted as a failed
vote. Unanimity was therefore mathematically impossible.

The author is now removed before dispatch and before denominator calculation.
At least two independent eligible judges are required. Shadow mode emits both
positive and negative decisions and distinguishes `would_promote` from actual
mutation.

### P0 — Cancellation was late, retryable and process-local

Provider aborts could be classified as timeouts; retry/backoff, fallback,
format recovery, judges or relators could continue after cancellation. A second
MCP window could see a durable session but not the owner process's local job.

All six adapters pass the same `AbortSignal` through retry. Backoff is
abort-aware; cancellation is non-retryable; paid barriers recheck durable state
before dispatch. Background owner PID/job ID and cancel requests are durable,
the owner polls them, and a sibling window can synthesize/poll remote job state.
Job IDs are validated rather than silently rebound. A cancel request that wins
the session lock also wins over finalization, including the narrow interval
after a convergent round; it cannot coexist with a contradictory converged
outcome. Pre-round running/cancel states remain visible and recoverable without
assuming that job liveness itself proves a paid provider dispatch.

### P0 — `max_rounds` and cost ceilings were not actually hard

Legacy auto-grants could exceed a caller ceiling. More seriously,
`max_cost_usd` was persisted as the effective ceiling while reviewers,
fallback, moderation recovery, format recovery and judges continued to consult
the global config ceiling. Enforcement could happen only after spend.

`max_rounds` is now hard by default. Automatic extension requires the explicit
`allow_auto_extension` opt-in and persists the effective ceiling. Every paid
path reads the session's `effective_cost_ceiling_usd`/`cost_ceiling_usd`, and all
four relator/rotator generation sites perform projected-cost preflight before
dispatch.

### P0 — Financial reconciliation omitted paid attempts

The 4.5.3 ledger omitted judge calls, failed relator generations, skipped
providers, some retry/recovery paths and Claude `max_tokens` responses. It could
therefore present an internally neat but materially incomplete total.

Accounting schema v2 includes failed attempts and `unpriced_attempts`.
Successful/failed judges, generations, skipped providers, fallback,
moderation/format recovery and cancellation-after-settlement are included in
totals. Legacy sessions are always `legacy_unknown`; a v2 session is reconciled
only when all attempts are priced and arithmetic agrees.

Claude Fable 5 receives one controlled medium-effort recovery when a slot
remains after `max_tokens`. Usage and cost are aggregated exactly once. Tests
cover success, `max_tokens -> network`, `max_tokens -> refusal`, and
`max_tokens -> settled response -> cancellation`. An early Fable refusal is
recorded at zero cost even when input usage is present; a mid-stream refusal is
recorded as billable, following Anthropic's documented distinction.

### P0 — Restart/finalization could erase an explicit billing boundary

`recoverInterruptedSessions`, the stale in-flight sweep and manual finalize
could delete `in_flight` without recording that provider work might have been
billed.

Recovery now writes one conservative unknown attempt per in-flight peer and
forces reconciliation incomplete. A separate top-level generation marker is
persisted immediately before synchronous or background provider generation and
is cleared only in the same durable transition that records its result or
failure. Manual finalization rejects either active boundary, idle sweep leaves
them for interruption recovery, and pre-dispatch/post-round cancellation does
not invent an unknown attempt. Late provider settlement after cancellation
fails closed without rewriting the sealed terminal meta/report.

### P1 — Health, reporting and cache observability

Activity timestamps previously masqueraded as state transitions, terminal
aborts could look stale, report generation could precede terminal events,
repeated raw artifacts could overwrite each other, and a missing cache identity
could appear as an empty hash.

v4.5.4 separates activity/transition timestamps, uses explicit aborted and
cancelled health, audits all finalization sites so causal diagnostics precede
the terminal event, and keeps `events.ndjson` append-only. A genuinely late
event/result is rejected instead of resequencing history. Normal finalization,
cancellation and idle sweep regenerate a complete terminal report; background
cleanup/escalation cannot mutate a sealed snapshot. Repeated artifacts use
unique names and an unavailable cache key is `null` plus a reason.

## Six-provider compatibility matrix

| Peer             | Canonical pin            | Native reasoning contract used                                                                                  | `ultra` handling                      | Terminal/structured-output posture                                              |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| OpenAI/Codex     | `gpt-5.6-sol`            | Responses API; official efforts `none`, `low`, `medium`, `high`, `xhigh`, `max`; shared `minimal` maps to `low` | normalized to `max`                   | requires completed Responses terminal and JSON Schema                           |
| Anthropic/Claude | `claude-fable-5`         | adaptive thinking; `output_config.effort`; explicit `thinking` omitted                                          | normalized to `max`                   | `end_turn` complete; refusal and `max_tokens` are typed failures/recovery paths |
| Google/Gemini    | `gemini-3.1-pro-preview` | native high thinking level                                                                                      | retained as native high configuration | `STOP` required; prompt blocks and incomplete candidates fail closed            |
| DeepSeek         | `deepseek-v4-pro`        | thinking enabled and maximum documented effort                                                                  | normalized to `max`                   | chat terminal `stop` required; structured JSON response requested               |
| xAI/Grok         | `grok-4.5`               | documented `low`/`medium`/`high` effort                                                                         | clamped to `high`                     | completed Responses terminal required; no unsupported effort sent               |
| Perplexity       | `sonar-reasoning-pro`    | `/v1/sonar` schema accepts `minimal`/`low`/`medium`/`high`; model-specific depth effect is not promised         | clamped to `high`                     | chat `stop` required; search/request fee remains accounted                      |

Official references:

- OpenAI [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  and [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
- Anthropic [Fable 5 introduction](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort) and
  [refusals](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
- Google [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview),
  [Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3) and
  [thinking](https://ai.google.dev/gemini-api/docs/thinking).
- DeepSeek [API updates](https://api-docs.deepseek.com/updates) and
  [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).
- xAI [Grok 4.5](https://docs.x.ai/developers/grok-4-5) and
  [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).
- Perplexity [Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro),
  [request schema](https://docs.perplexity.ai/api-reference/sonar-post) and
  [pricing](https://docs.perplexity.ai/docs/getting-started/pricing).

`ultra` is intentionally not treated as an OpenAI API enum. OpenAI documents
`max` as GPT-5.6's top API reasoning effort and describes ultra separately as a
Codex product mode. Accepting the operator's central-config term and mapping it
to `max` fixes atomic config rejection without sending an invented API value.
The adapter also applies the official family matrix to explicit older-model
overrides: GPT-5.5/5.4/5.2 cap at `xhigh`, GPT-5.1 caps at `high`, and original
GPT-5 maps `none` to `minimal` and caps at `high`. The provider-refresh
regression exercises every shared effort across all six concrete family ids in
generation payloads and independently checks a review-call payload.

## Anti-lie / anti-fabrication assessment

The mechanisms remain strict, but they now test the right boundary:

| Mechanism                 | v4.5.4 assessment                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical READY envelope  | Preserved; summary, confidence, requests and follow-ups are schema-checked.                                                          |
| Evidence preflight        | Preserved and durable; execution uses the same result as the read-only preflight tool.                                               |
| Truthfulness preflight    | Preserved; runtime claims are namespace- and grammar-scoped to reduce false accusations.                                             |
| SHA-256 custody           | Preserved; digest proves integrity, not truth or operator authority.                                                                 |
| Literal grounding         | Strengthened; every source must correlate to one attachment and every item is checked.                                               |
| Peer-submitted evidence   | Automatically transported but remains unverified; at least two independent non-author reviewers are required for operational claims. |
| Anti-self-review          | Strengthened for consensus judges and retained for caller/relator voting.                                                            |
| Model-pin verification    | Preserved; reported-model mismatch remains a non-skippable failure.                                                                  |
| Terminal-state validation | Preserved for all six providers; partial/incomplete output is unusable.                                                              |
| Cost truthfulness         | Strengthened; unknown or legacy coverage can no longer report reconciliation complete.                                               |

No API can prove that Claude or another model performed a private amount of
reasoning. The enforceable controls are observable: response contract,
evidence custody, exact citations, independent reviewers, contradictions,
terminal completeness and durable transformations. The anti-laziness prompt
still names Claude because field history justified that targeted instruction,
but a model is never trusted merely because it says it worked.

## RED/GREEN evidence

Focused suites in the final source:

| Suite                                    | Final result | Core contract                                                                                |
| ---------------------------------------- | -----------: | -------------------------------------------------------------------------------------------- |
| `v4.5.4-grounding-regression`            |        20/20 | multi-source, cross-attachment, structural runtime namespace, schema parity, status trace    |
| `v4.5.4-judge-cost-regression`           |        10/10 | author exclusion, independent quorum, shadow visibility, judge ledger, persisted ceiling     |
| `v4.5.4-cancellation-regression`         |        13/13 | abort classification, retry barriers, hard rounds, terminal ordering, contest continuity     |
| `v4.5.4-durable-jobs-regression`         |        21/21 | sibling cancellation, job identity, sync/async recovery, terminal and dispatch guards        |
| `v4.5.4-health-activity-regression`      |          8/8 | activity vs transition, append-only terminal ordering/reporting and honest health            |
| `v4.5.4-accounting-preflight-regression` |        18/18 | v2/legacy coverage, generation dispatch settlement, late results and hard ceilings           |
| `provider-refresh-smoke`                 |         PASS | OpenAI 49-payload family matrix, Grok call/generate matrix and provider capability contracts |
| `provider-terminal-smoke`                |         PASS | all-provider terminal fail-closed plus Fable billing/recovery cases                          |
| `status-citation-contract-smoke`         |         PASS | canonical citation grammar and anti-verbosity instruction                                    |
| `evidence-transport-regression`          |         PASS | automatic authenticated evidence transport without manual attachment                         |
| `smoke`                                  |         PASS | complete historical behavioral/source-contract suite                                         |
| `runtime-smoke`                          |         PASS | built MCP runtime, tools, schemas, preflight, jobs, reports and config surface               |

The focused scripts were written or extended to fail on the 4.5.3 behavior
before the corresponding production change. The integrated suite also exposed
a real Fable regression: an early refusal must remain `billed=false` even when
Anthropic reports input usage, and production was corrected accordingly. Two
other failures were stale expectations that searched for a removed direct
`.generate` call or expected a post-spend `budget_exceeded` outcome where the
new hard gate correctly returns `budget_preflight` before dispatch.

## Residual limitations (honest, non-P0)

1. Review rounds have `in_flight` and relator/rotator generations now have a
   pre-dispatch `generation_in_flight` marker. A process kill during a judge
   dispatch can still occur without a dedicated per-attempt WAL. Complete
   cross-path crash accounting would require an append-only provider-attempt
   WAL (`started`/`settled`) for every dispatch category.
2. Terminally unhealthy non-Anthropic envelopes may contain usage that is not
   yet copied into `ProviderTerminalStateError`. Those attempts are marked
   unpriced, so they cannot create false-positive reconciliation, but known
   usage can be lost from the estimate.
3. Reviewer results settle concurrently and are appended as a round after the
   panel completes. Crash recovery now fails closed, but it may replace known
   settled values with conservative unknown attempts.
4. Recovery budget checks are conservative but not an atomic multi-process
   reservation. Two simultaneous recovery branches can independently observe
   the same remaining ceiling. A future reservation ledger would make the
   ceiling transactionally strict across processes.
5. A failed circular rotation is included in totals/failed attempts; if the
   round itself never exists, there is no corresponding `costs_per_round` slot.
6. Perplexity `probe_mode=live` is a paid completion and is intentionally
   outside a review session. The default `auth_only` mode avoids that spend but
   cannot prove the configured model will answer.

These limits are explicit and do not permit `reconciled=true` when the runtime
has evidence of unknown coverage. They are candidates for a future WAL release,
not reasons to hide or relabel the current results.

## Release close-out

Local pre-publish evidence on the 4.5.5 metadata:

- `npm run check`: PASS (Prettier, ESLint, Biome and TypeScript);
- `npm test`: PASS in 181.5 seconds, including build, every focused v4.5.4
  regression, evidence/custody/truthfulness contracts, the complete historical
  smoke and the built MCP runtime smoke;
- `git diff --check`: PASS; and
- no global install, `npm link` or source-built package installation was used.

The v04.05.04 tag passed repository CI, but its publish-only clean-runner gate
correctly stopped before registry publication because the cancellation fixture
inherited private operator rate cards. The failed run is GitHub Actions
`29181202703` on signed commit
`e8f6bd8ca34558487866f99d327b59dc2211cc2e`; no `4.5.4` npm package was
published and the immutable `v04.05.04` tag was not moved.

The same missing-rate environment was reproduced locally: cancellation was RED
at 10/13. A systematic audit of every `npm test` script then found two further
environment-dependent fixtures. Health had one paid stub path, while accounting
could report 18/18 even though its reviewer round was rejected before dispatch.
The accounting case first received a reviewer-result assertion and reproduced
RED (`round.peers.length` was 0); only then were complete synthetic zero-cost
rate cards added. Under the clean-runner simulation, cancellation passes 13/13,
health passes 8/8 and accounting passes 18/18 with a real stub reviewer result.
Production financial gates remain unchanged and still fail closed without real
rate cards.

The source must be committed directly to `main` with a signed commit. The
auto-tag workflow should create `v04.05.05`; the publish workflow must pass its
pre-publish gate, publish npmjs and GitHub Packages with provenance, and create
the GitHub Release. Final commit SHA, workflow URLs and registry integrity are
recorded after those external steps complete.

The operator installs only from the published registry:

```powershell
npm upgrade -g @lcv-ideas-software/cross-review
```

No local-source global installation, `npm link` or manual evidence attachment
is part of this remediation or its acceptance procedure.
