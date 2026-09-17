# Detailed session audit — cross-review 4.5.16 and 4.5.17

Audit date: 17/07/2026
Scope: every durable session created since the publication of `v04.05.16`, the
corresponding logs, source `v04.05.16..v04.05.17`, the official contracts of the
six APIs, and the corrections prepared for `v04.05.18`.

## 1. Executive conclusion

The corpus holds exactly five 4.5.16 sessions and no 4.5.17 session. There were
29 model calls, 113,267 tokens and a reconciled cost of USD 0.964851031. No
provider rejected the request, no pin diverged and no parser lost a complete
response. One session converged in a single round, with four `READY` reviewers,
automatic evidence and zero human intervention.

The audit did, however, confirm defects internal to cross-review:

1. factual `NOT_READY` votes and sources presented with `NEEDS_EVIDENCE` did not
   receive the same anti-fabrication grounding applied to `READY`;
2. completed responses only gained a durable artifact after the slowest peer;
3. loops refused by the preflight lost the draft and stayed open until the
   reaper;
4. evidence-judge cache and cost were not fully manifested;
5. the shadow judge ran against freshly created asks, when no new evidence could
   yet exist;
6. reports discarded actions requested by the peers and favoured streaming
   events;
7. sessions with no calls showed an unknown cost instead of zero;
8. the session did not preserve a redacted snapshot of the effective
   configuration;
9. a unanimous judge consensus of `satisfied=false` was described as a
   disagreement;
10. the technical phrase "Service Bindings" improperly triggered the generic
    state detector for a "service".

These points are covered in source 4.5.18 by hermetic regressions. The automatic
judge was switched off in the central configuration as containment until the new
runtime is reloaded.

An independent review of the patch, run before the full suite, found five
residual gaps that had not yet appeared in the corpus: the peer's early artifact
did not take part in the recovery ledger; the generation cache was written before
the durable result and with a failure label; judges inherited `max` effort;
unknown pending cost was converted into zero; and demoting a sourceless
`NOT_READY` did not create an actionable ask. All of them received red
reproductions before the fix and are detailed in DEF-26 through DEF-30.

The independent closing found four further windows, also reproduced before any
fix: an authentic but irrelevant quote kept a clean veto; a crash between the
round's append and finalize left the material result without `final.md`; an
evidence-judge call could stay reserved after a crash or be improperly accounted
by a concurrent recovery; and the publication path accepted a tag input
different from the `workflow_dispatch` ref. These are DEF-33 through DEF-36.
None required a paid round or any human attachment or intervention.

## 2. Method and limits

What was examined:

- 435 directories under `<data_dir>/sessions`;
- 434 parseable `meta.json` files and one historical directory with no metadata;
- every relevant `meta.json`, `events.ndjson`, report and artifact for the
  versions in scope;
- the production diff between 4.5.16 and 4.5.17;
- the unpublished source prepared for 4.5.18;
- official documentation and wire contracts from OpenAI, Anthropic, Google,
  DeepSeek, xAI and Perplexity.

No sessions were opened, there was no paid provider retest, and no material
result was inferred from narrative without checking the persisted artifact. Tag
4.5.16 was published at 2026-07-13T10:16:17Z; every later session carried an
explicit version.

## 3. Runtime and configuration state

A fresh `server_info`, consulted during this audit, proved:

- loaded runtime: `4.5.17`;
- loaded config: SHA-256
  `57331b5b47bd80fedc9fed2cd4631554c10d1028048ce87e58130fcca38a054d`;
- updated central config: SHA-256
  `a8eec09cbafa07a11e814d7b46186d7e1769762ba20e2ecc31f24052e79fbef7`;
- `live_reload_supported=false`;
- `reload_required=true`;
- paid calls blocked by `CROSS_REVIEW_CONFIG_RELOAD_REQUIRED`.

This is the expected fail-closed behaviour. The on-disk configuration was
atomically changed to:

- `evidence_judge_autowire.mode="off"`;
- Grok 4.5 above 200,000 prompt tokens: input `4`, cached input `1`, output `12`
  USD per million;
- the Grok base card preserved at input `2`, cached input `0.5`, output `6`.

The new `evidence_judge_autowire.max_output_tokens` key was not written while the
4.5.17 host stayed loaded. The central schema is strict and an unknown key could
invalidate the whole file if the old host were restarted. The 4.5.18 runtime uses
a safe default of 2,048 tokens even without that key.

## 4. Complete inventory

Every date below is in UTC.

| Session                                | Version | Interval                        | Mode         | Result                                     | Rounds |               Calls | Tokens |         Cost |
| -------------------------------------- | ------- | ------------------------------- | ------------ | ------------------------------------------ | -----: | ------------------: | -----: | -----------: |
| `5dd0845a-8ddf-4de8-9000-ffba7253aa76` | 4.5.16  | 15/07 09:26:43 → 16/07 23:06:38 | loop         | `aborted / stale_no_finalize_24h`          |      0 |              0 paid |      0 |        USD 0 |
| `e0b55698-d6d1-42fd-91e3-5ca7afd80c62` | 4.5.16  | 15/07 09:27:25 → 16/07 23:06:38 | loop         | `aborted / stale_no_finalize_24h`          |      0 |              0 paid |      0 |        USD 0 |
| `808fe68d-3985-428f-a048-5812a2ce7761` | 4.5.16  | 15/07 09:27:54 → 16/07 23:06:37 | direct round | `aborted / stale_no_finalize_24h`          |      1 | 5 review + 16 judge | 65,470 | USD 0.782538 |
| `36214b31-1e47-42f4-addd-efc1385e2f55` | 4.5.16  | 17/07 00:17:29 → 00:19:32       | loop         | `max-rounds / generation_budget_preflight` |      1 |            4 review | 21,921 | USD 0.089524 |
| `5e5d0389-6140-4454-b216-680864e7b12a` | 4.5.16  | 17/07 00:21:23 → 00:23:04       | loop         | `converged / unanimous_ready`              |      1 |            4 review | 25,876 | USD 0.092789 |

Aggregate:

- five sessions;
- three paid rounds;
- 13 reviews and 16 judgements;
- 92,854 review tokens and 20,413 judge tokens;
- review cost USD 0.887963110;
- judge cost USD 0.076887921;
- a total of 113,267 tokens and USD 0.964851031;
- seven `READY`, three `NOT_READY` and three `NEEDS_EVIDENCE` in the raw;
- six `READY`, three `NOT_READY` and four `NEEDS_EVIDENCE` normalized;
- one correct `READY` demotion, since the composite quote skipped a line and was
  not a literal substring.

## 5. Per-session analysis

### 5.1. Session `5dd0845a`

The evidence preflight refused the aggregate claim "163 passed" because the
package listed `22 + 23 + 118` and did not carry the raw output matching the
aggregate total. Blocking before a paid call was defensible. The defect was one
of durability: the full draft was not persisted and the session only reached a
terminal state roughly 37h40 later, through the stale reaper.

### 5.2. Session `e0b55698`

The package held raw test results and a live-query section that read
`Pages bindings: WORKER->mainsite-motor; ADMIN_MOTOR->admin-motor`. The draft's
sentence "the active Pages->Workers path uses Service Bindings" was classified as
a generic health/state claim about a `service`.

The problem was not requiring proof for an operational fact; it was the lexical
collision between the Cloudflare product **Service Bindings** and the generic
subject `service`. The next runtime accepted the same fact when it received more
literal JSON, but the original category was still wrong. 4.5.18 excludes
`Service Binding(s)` from the service-health detector and keeps a real claim such
as "the current service is healthy" blocked when there is no raw status.

As in the previous session, the loop did not preserve the draft and only ended
through the reaper roughly 37h39 later.

### 5.3. Session `808fe68d`

Five providers answered with no rejection:

- Gemini: `READY`;
- Claude: `NEEDS_EVIDENCE`;
- DeepSeek, Grok and Perplexity: `NOT_READY`.

Material non-convergence is not a bug. The defects lie in the confidence given to
the vetoes and in durability:

- DeepSeek stayed `NOT_READY / clean` with zero `evidence_sources`;
- Claude stayed `NEEDS_EVIDENCE / clean` even though one source declared SHA-256
  `2e0d7ca35a1dd48478cc45cd6e918051b28d0ad6af76c86de9e409d94c48d841`, different
  from the real digest
  `2e0d7ca35a1dd48478cc45cd6e918051b28ad6af76c86de9e409d94c48d8410d`;
- the 4.5.16 code returned `grounded=true` for every status other than `READY`;
- factual requests originating from a normalized `NOT_READY` were not
  consistently forwarded to the Evidence Broker.

Responses that had already completed were left without a final artifact while
Perplexity kept running. Delay between completion and persistence:

- Gemini: 422.746 s;
- Grok: 414.576 s;
- Claude: 315.135 s;
- DeepSeek: 295.506 s;
- Perplexity: 0.042 s.

The shadow judge ran 16 calls against four freshly created asks. All 16
judgements said `satisfied=false`; even so, every aggregate decision was labelled
`consensus_disagreement`. The cache manifest omitted exactly those judges'
traffic: 1,024 cache-read and 3,011 cache-write tokens.

The log had 123 events. The report used only the last 100 without announcing the
cut, omitting 23 initial events. Of the 100 presented, 57 were stream events
(`peer.token.delta` or `peer.token.completed`), while `caller_requests` and
`follow_ups` were not rendered.

### 5.4. Session `36214b31`

The budget worked correctly. After four reviews, Claude's generation was
estimated at USD 9.787594, above the persisted ceiling of USD 5; no generation
call happened. The public outcome `max-rounds` is broader than its name suggests,
but it has been documented since earlier versions as the bucket for a round
**or budget** limit. Reclassifying it in isolation would break metrics, health,
the dashboard and consumers.

4.5.18 therefore preserves `max-rounds / generation_budget_preflight`. A future
taxonomy should create an outcome of its own, such as `budget-exhausted`, in a
deliberate contract change.

### 5.5. Session `5e5d0389`

This is the positive control:

- four `READY / clean` reviewers;
- nothing rejected;
- evidence persisted automatically;
- truthfulness and evidence preflight approved;
- convergence in one round;
- zero human upload, promotion or finalization.

It proves the 4.5.16 happy path works and that there was no widespread API
incompatibility. It does not neutralize the blocking-path and observability
defects described above.

## 6. Defects and 4.5.18 remediations

### DEF-17 — asymmetric grounding of factual vetoes

**Severity:** high.

`READY` was checked against artifact/attachments; `NOT_READY` and
`NEEDS_EVIDENCE` escaped through the early return. That let a blocking
hallucination prevent unanimity and generate additional rounds.

**Fix:**

- `READY` and `NOT_READY` are definitive verdicts and require a grounded source;
- a factual `NOT_READY` with no source, or with a false source, becomes
  `NEEDS_EVIDENCE`, a non-clean `decision_quality` and a `blocking_grounding`
  transformation;
- `NEEDS_EVIDENCE` may legitimately have no source, but a supplied source that is
  fabricated/ungrounded raises an auditable warning;
- requests originally written in the `NOT_READY` remain the peer's asks, not
  remediation invented by the server.

### DEF-18 — potential loss before the slowest peer's barrier

**Severity:** high.

`Promise.all` had to finish before the first `savePeerResult`.

**Fix:**

- each response/failure is written as `provider-response`/`provider-failure` as
  soon as the call ends;
- the settlement also enters `in_flight.provider_settlements`, with path, usage,
  cost, attempts and billing status;
- restart/cancel moves already-completed settlements into the interrupted ledger
  and marks as unknown only the peers not yet resolved;
- on a normal append, the temporary ledger is promoted without double-counting;
- `peer.call.completed` is emitted after persistence;
- the normalized version is still saved at the end, keeping the raw and the
  post-gate decision as distinct artifacts.

### DEF-19 — preflight without a durable draft and a stale-open session

**Severity:** high for auditability.

**Fix:**

- loops save the draft before the local gates;
- a refused truthfulness/evidence preflight ends immediately in
  `aborted / needs_*_preflight`;
- `ask_peers`, which is iterative, keeps its refused local round open for the
  next correction;
- no route requires a human operator.

### DEF-20 — judge cost, cache and timing

**Severity:** medium/high because of repetitive spend.

**Fix:**

- the judge budget adds the cost of the paid round still in flight;
- its own `max_output_tokens` cap, default 2,048, minimum 256;
- its own effort, default `medium`, without inheriting the reviews' `max`;
- the estimate and the call use the real model and the same cap;
- unknown/unpriced pending cost blocks the judge instead of becoming zero;
- asks created in the current round wait for a later submission before
  triggering a judge;
- the manifest records `call_kind` and `call_label` for review, generation and
  evidence judge.

### DEF-21 — non-actionable report

**Severity:** medium.

**Fix:**

- token deltas leave the default timeline;
- truncation and the suppressed quantity are announced;
- `caller_requests` and `follow_ups` appear per peer;
- Markdown does not print `undefined` fields;
- `session_list` treats metadata with no outcome as open and exposes
  `not_resurfaced_evidence_items`.

### DEF-22 — zero calls displayed as unknown cost

**Severity:** low.

**Fix:** accounting-v2 sessions with zero calls have a known cost equal to
USD 0. Historical/incomplete sessions still do not invent a reconciliation.

### DEF-23 — effective configuration not reproducible

**Severity:** medium.

**Fix:** every new session stores a redacted snapshot and the SHA-256 of models,
fallbacks, selection, enablement, effort, retry, budgets, prompt limits, output
caps, preflights, streaming, judge, cache, Perplexity controls and rate cards.
Credentials do not enter the snapshot.

### DEF-24 — shadow consensus semantics

**Severity:** medium.

**Fix:** all judges returning false produce `consensus_unsatisfied`, not
`consensus_disagreement`; shadow events do not arbitrarily attribute the result
to a peer, and the message explains that the author is excluded per item.

### DEF-25 — lexical false positive on Service Bindings

**Severity:** medium.

**Fix:** the product phrase `Service Binding(s)` is no longer treated as a
health/status subject. Real claims about service/CI/deploy stay fail-closed.

### DEF-26 — early artifact orphaned from the recovery ledger

**Severity:** high.

The first DEF-18 fix wrote the JSON before the barrier, but
`accountInterruptedInFlight` still marked every peer as unknown. The file
survived; usage/cost and the fact that the peer had already completed did not.

**Fix:** a minimal, redacted per-call settlement now becomes part of
`meta.in_flight`. The first response and each recovery get their own artifact;
the recovery receives a durable reservation before dispatch, removed atomically
once its result or failure is settled. Process recovery preserves the exact
values in `interrupted_provider_settlements`; only unsettled initial peers and
still-open reservations receive a conservative unknown attempt. The report shows
those settlements without pretending they form a complete round/vote.

### DEF-27 — generation cache written ahead of the ledger

**Severity:** high for reconciliation.

`generateWithFailureAccounting` recorded the cache before `saveGeneration` and
received labels such as `initial-draft-failure` for a successful generation. A
crash in that window left cache/cost without the authoritative generation.

**Fix:** the order is provider result → `saveGeneration` → cache manifest. The
success label (`initial-draft`, `revision` or `rotation`) is separated from the
failure label and shared by the artifact and the telemetry.

### DEF-28 — the compact judge inherited maximum effort and accepted unknown cost

**Severity:** high because of truncation and spend risk.

The 2,048-token cap did not stop OpenAI/Anthropic from inheriting `max` effort.
Beyond that, `total_cost ?? 0` allowed new calls while an attempt from the round
was still without a reliable price.

**Fix:** the judge has an independent configurable effort, default `medium`, and
the preflight fails closed when any current or historical paid attempt has
`unpriced_attempts`, unknown billing or a non-finite cost. When the current round
is already in the in-flight ledger, its total is subtracted from the base before
the pending aggregate is added, eliminating double-counting.

### DEF-29 — veto demotion with no actionable request

**Severity:** high for convergence.

The runtime converted a sourceless `NOT_READY` into `NEEDS_EVIDENCE`, but stored
the remediation only inside `decision_transformations`; the Evidence Broker reads
`structured.caller_requests`.

**Fix:** the citation remediation is deduplicated and persisted in
`caller_requests`. The durable opinion keeps the original correction requests for
audit, but the Evidence Broker receives only the synthesized citation
remediation; prose such as "fix the DELETE" is no longer reborn as a historical
`not_resurfaced` item. The prompt also states that `NOT_READY` is a definitive
factual verdict and must cite its blockers; without a source, the peer has to ask
for the proof.

### DEF-30 — effective snapshot still incomplete

**Severity:** medium.

The first snapshot omitted prompt limits and the Perplexity controls
`disable_search`, `search_context_size` and `probe_mode`.

**Fix:** both blocks were included; the test also confirms that `api_keys` and
secret values remain absent.

### DEF-31 — OpenAI tier inherited from the project

**Severity:** high for financial reconciliation.

The adapter did not send `service_tier`. Per the official Priority Processing
documentation, omitting it lets the project's configuration select another tier,
while the local ledger kept assuming the Standard table.

**Fix:** review, generation, judge and retries share payloads with
`service_tier: "default"`. The configured price now corresponds
deterministically to the Standard tier; the wire contract is covered by a
regression.

### DEF-32 — an alternative publication path bypassed the hardgate

**Severity:** critical for the supply chain.

Auto-tag validated CI/CodeQL/alerts, but `workflow_dispatch` and a manual tag
could trigger `publish.yml` without repeating that link. Conditional workflows
could also still be running.

**Fix:** publish itself revalidates tag = `origin/main`, waits for CI, CodeQL,
Socket and, where applicable, Scorecard, Pages and Dependabot jobs, requires both
CodeQL analyses processed for the SHA and zero open alerts. After publishing via
OIDC/provenance, it installs the exact version under the npm 12 restrictions and
runs `npm audit signatures`, which verifies the registry signature and the
provenance attestation.

### DEF-33 — a grounded but irrelevant quote sustained a factual veto

**Severity:** high for anti-deception and convergence.

The validator proved the quote's path, SHA-256 and literal, but did not check
whether it sustained the concrete blocker the peer stated. So an authentic
citation of `src/index.ts:10` could accompany a claimed defect in `db.ts:99` and
still keep `NOT_READY` as a clean veto.

**Fix:** a factual `NOT_READY` must now carry a `path:line` reference in the
summary matching the same already-grounded source. The authentic but disconnected
source is preserved in the artifact for audit, but the verdict is transformed
into `NEEDS_EVIDENCE`; no product correction is reopened by the broker from that
internal transformation.

### DEF-34 — a crash after append could keep merit without a final artifact

**Severity:** high for operational autonomy.

A unanimous round already persisted between `appendRound` and `finalize`
survived, but recovery treated it as an interrupted session. The material result
was on disk and there was no new provider call, but `final.md` and the terminal
seal were missing.

**Fix:** recovery recognizes durable convergence, rebuilds the final artifact
from the already-appended round and records `session.finalized` under the
session's lock. The path does not reopen the checklist, does not charge the
provider and does not ask the operator to attach or finalize anything.

### DEF-35 — the synchronous evidence-judge reservation did not survive correctly

**Severity:** critical for cost and recovery.

The synchronous judge does not create `in_flight`; a crash left its global
reservation without an automatic sweep, and a manual recovery could account a
still-live call as unknown. Beyond that, a cancellation during the judge could
stall at `cancel_requested`.

**Fix:** reservations now store `owner_pid`; initialization sweeps reservations
whose owner is dead but preserves sessions with a live call. Recovery terminates
a cancellation only after the conservative settlement, and every recovery event
uses the normal lock. The single and consensus modes evaluate cancellation again
before promoting evidence, and the shared transition
`markEvidenceItemAddressedByJudge` revalidates `cancel_requested` inside the
lock: a cancellation that wins between the optimistic check and the promotion
leaves the item open and ends the session as `aborted/session_cancelled`.

### DEF-36 — the release ref identity could diverge from the dispatch

**Severity:** critical for the supply chain.

`workflow_dispatch` is necessary: per GitHub's documentation, a tag created with
`GITHUB_TOKEN` does not trigger another workflow. The free-form `tag` input,
however, could replace the dispatch's real ref and create ambiguity between tag,
checkout and provenance.

**Fix:** `workflow_dispatch` remains only as a bridge over the tag's own ref,
with no input. Auto-tag calls `gh workflow run publish.yml --ref "$TAG"`; Publish
requires `github.ref_type=tag`, `github.ref=refs/tags/<name>` and
`github.ref_protected=true`, and revalidates tag = checkout = `main` after the
local tests and before each external write. The live audit confirmed the active
organization ruleset `tag ruleset` (ID 16728097) on `refs/tags/v*`, with no
bypass, carrying `deletion`, `non_fast_forward` and `required_signatures`;
`v04.05.17` is a lightweight tag pointing at `8e790116`, whose commit has a valid
signature.

Official sources for this control: <https://docs.github.com/en/actions/concepts/security/github_token>,
<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>,
<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts> and
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>.

### 6.1 Findings from the final 4.5.18 validation (not inferred from the corpus)

These findings came from the local red/green validation of the remediation, not
from the five audited 4.5.16 sessions. They are recorded separately so as not to
alter the corpus's historical evidence.

#### REG-37 — recovery sealed a cancellation without the dead owner's acknowledgement

**Severity:** high for the audit trail and for cost.

A dead process with `cancel_requested`, having neither acknowledged nor settled
the in-flight call, was treated as terminal `cancelled`. That hid interrupted
work and could discard the conservative cost recovery.

**Fix:** recovery distinguishes an already-acknowledged terminal cancellation
from a persisted request whose owner died. The second case follows the auditable
recovery path, preserving settlements and accounting only for what remains
unknown. The red and green scenario is in `v4.5.4-durable-jobs-regression`.

#### REG-38 — the Evidence Broker's symbol extraction had quadratic backtracking

**Severity:** high for local availability.

The `snake_case` matcher accepted the case-insensitive flag and could backtrack
quadratically on an adversarial input made of 100,000 uppercase letters followed
by `_`. Extraction happens over the request's text, so the bound had to be
deterministic.

**Fix:** the matcher was replaced by a linear ASCII scan, preserving the
camelCase, snake_case and UPPER_SNAKE forms. The `evidence-transport-regression`
keeps the two-second bound and checks the functional correlation.

#### REG-39 — hardened validation guardrails

**Telemetry.** The runtime already removed the fabricated scalar authorship of a
shadow consensus, but the static smoke still required `judge_peer` on that event.
The assertion was replaced by a dynamic contract: shadow carries the `judge_peers`
panel and `per_peer_verdict`, with neither `peer` nor `judge_peer`; an active
promotion keeps the real author. The telemetry regression went from two cases to
three.

**npm registry.** The post-publication fixture had `NPM_CONFIG_REGISTRY`, but the
three calls `npm init`, `npm install` and `npm audit signatures` did not declare
the registry inline. All of them now pin `https://registry.npmjs.org`, keeping
the variable as defence in depth. The policy is covered by
`npm-v12-release-security-regression` and by the registry-discipline smoke.

#### REG-40 — the stale sweep could steal a still-live judge call

**Severity:** high for durability and accounting.

`clearStaleInFlight` observed only the generation/background PID and the
transient lock. After 30 minutes, it could reconcile the `in_flight` of a round
whose evidence judge still held a reservation with a live `owner_pid`. That
removed the envelope before the real settlement and could create a duplicate
unknown attempt.

**Fix:** the sweep identifies a pending reservation held by a live owner before
attempting the lock and repeats the check once inside the lock. The round and the
reservation stay intact until the durable result/failure. The new regression is
in `v4.5.4-durable-jobs-regression`.

#### REG-41 — `not_resurfaced` made a pending item invisible to the judge

**Severity:** critical for autonomous convergence.

Autowire selected open IDs before the resurfacing inference, but then accepted
only items still `open`. When a peer returned `READY`, the historical ask became
`not_resurfaced`, kept blocking the hardgate and no longer reached the judge. The
single/consensus executors and the atomic promotion also restricted the
transition to `open`.

**Fix:** pre-existing `open` and `not_resurfaced` items are eligible; both
executors keep them in the queue and the verified promotion allows
`open|not_resurfaced → addressed`, without touching the operator's terminal
states. There are separate regressions for single and consensus autowire in
`v4.5.18-contract-gaps-regression`.

#### REG-42 — the judge's implicit floor could exceed an explicit cap

**Severity:** medium for budget and configuration obedience.

`evidenceJudgeOutputTokens` applied `max(256, min(peerCap, judgeCap))`. Since the
central schema accepts positive caps below 256, a configuration of 64 tokens
could produce a 256-token call and an incompatible cost estimate.

**Fix:** the effective cap is only `min(peerCap, judgeCap)`; both are already
validated as positive by the schema. The regression pins a Codex cap of 64 and
confirms the wire context receives 64, not 256.

#### REG-43 — a durable reservation still looked like reconciled cost in the report

**Severity:** high for financial transparency.

Before settlement, `sessionCostBreakdown` ignored
`pending_provider_call_reservations` and `in_flight.provider_call_reservations`.
An accounting-v2 session with no other artifact could then display USD 0 and
`reconciled: true` despite a paid call in progress.

**Fix:** every pending reservation counts as an unpriced attempt, blocks the
zero-total fallback and keeps `reconciled: false` until settlement. The
regression in `server-reports-regression` covers judge and recovery
reservations.

#### REG-44 — an in-flight generation could still look like reconciled zero cost

**Severity:** high for financial transparency.

The `generation_in_flight` marker is written before `adapter.generate`, but the
cost breakdown observed only settlements and reservations. In a v2 session with
no other artifact, a generation in progress could still fall into the USD 0 and
`reconciled: true` fallback.

**Fix:** an in-flight generation is an unpriced attempt until atomic settlement
by `saveGeneration` or `recordPeerFailureAccounting`. The report now shows an
unknown cost and `reconciled: false` during that interval.

#### REG-45 — in-flight primary peers could still look like reconciled zero cost

**Severity:** high for financial transparency.

The main round's peers sit in `in_flight.peers` before each result or failure is
persisted. Without a matching primary settlement, the report did not count them
as pending work and could announce a zero reconciliation.

**Fix:** every peer without a primary settlement is counted as an unknown
dispatch in the breakdown. Recovery settlements stay separate through the
`reservation_id`, without duplicating primary peers that are already settled.

#### REG-46 — the judge and generation preflights disagreed about unknown cost

**Severity:** critical for budget control.

The judge preflight received the fail-closed rule but initially omitted
`generation_in_flight`. Separately, the relator's generation converted a missing
`total_cost` into zero even when there were historical unpriced attempts. Either
path could therefore start a new paid call above a ceiling that was no longer
measurable.

**Fix:** `sessionHasUnknownProviderSpend` includes an in-flight generation and is
used by both preflights. Single/consensus judge and generation abort before
dispatch, persist `generation_budget_preflight` where applicable, and do not
invent a numeric current cost.

#### REG-47 — round and format recovery could be stolen by the sweep after 30 min

**Severity:** critical for durability.

`markInFlight` did not persist an owner. A long synchronous round — especially a
primary peer, a fallback or a moderation retry — sat without a lock while waiting
on the API. Another host could then consider the round old and delete it. The
format-recovery reservation had the same problem individually.

**Fix:** `InFlightRound` and `ProviderCallReservation` now persist `owner_pid`.
`clearStaleInFlight` and `recoverInterruptedSessions` check every known owner
before and after acquiring the lock. Legacy sessions without that field remain
recoverable; dead owners are accounted conservatively, while a live process's
work is not stolen.

#### REG-48 — autowire could judge an ask the peer had just reopened

**Severity:** high for the Evidence Broker's integrity.

The snapshot of historical IDs was correct, but the later filter accepted the
same ID if the ask was reasserted by the peer in the current round. That let the
judge promote `addressed` against a new `NEEDS_EVIDENCE`, contradicting the rule
that autowire only judges evidence predating the round.

**Fix:** beyond the historical ID and the `open|not_resurfaced` state, autowire
requires `last_round < roundNumber`. The valid silence → `not_resurfaced` case
stays eligible; the reopened ask now stays open for a future round with new
evidence.

## 7. Audit of the six official APIs

| Peer             | Pin                      | Confirmed contract                                                                                                | Result                                                                  |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OpenAI/Codex     | `gpt-5.6-sol`            | Responses API; 1,050,000 context; 128,000 output; structured output; effort `none/low/medium/high/xhigh/max`      | correct; `ultra` becomes `max` on the wire; tier fixed at `default`     |
| Anthropic/Claude | `claude-fable-5`         | Messages API; adaptive thinking; `output_config.effort`; structured output sanitized by the SDK's official helper | correct; `maxItems` does not reach the API raw                          |
| Google/Gemini    | `gemini-3.1-pro-preview` | `generateContent` officially supported; thinking `low/medium/high`; `responseJsonSchema` in the documented subset | correct; Interactions is a future evaluation, not a mandatory migration |
| DeepSeek         | `deepseek-v4-pro`        | Chat Completions compatible; effort `high/max`; structured response `json_object`                                 | correct                                                                 |
| xAI/Grok         | `grok-4.5`               | Responses API; effort `low/medium/high`; 500K context; structured outputs                                         | adapter correct; only the >200K price tier was missing from config/docs |
| Perplexity       | `sonar-reasoning-pro`    | Sonar Chat API; effort up to `high`; JSON Schema; `<think>` may precede the JSON                                  | correct; `disable_search` does not eliminate the request fee            |

The OpenAI, Anthropic, Gemini, DeepSeek and Perplexity rate cards matched the
official tables for the standard/global mode the runtime uses. The only financial
adjustment needed was Grok 4.5's long tier. Local caps are below the official
limits and were not raised without evidence of truncation.

Official sources:

- OpenAI: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>,
  <https://developers.openai.com/api/docs/pricing> and
  <https://developers.openai.com/api/docs/guides/priority-processing#configuring-priority-processing>
- Anthropic:
  <https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5>
- Google:
  <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview>
- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing>
- xAI: <https://docs.x.ai/developers/models/grok-4.5>
- Perplexity: <https://docs.perplexity.ai/docs/getting-started/pricing>

## 8. TDD evidence prepared

New or extended regressions:

- `v4.5.18-grounding-contract-regression`: 5 cases;
- `v4.5.18-durability-regression`: 12 cases;
- `v4.5.18-budget-cache-regression`: 10 cases;
- `v4.5.18-contract-gaps-regression`: 9 cases;
- `v4.5.18-judge-wire-contract-regression`: 8 cases;
- `v4.5.18-session-telemetry-regression`: 3 cases;
- `server-reports-regression`: 8 cases;
- `v4.5.18-pricing-regression`: 6 cases.

Total: 60 focused checks. Every new defect above was observed red before the fix
and green after it. The npm v12 security regression also protects the dispatch's
identity by tag, the absence of a divergent input, post-test revalidation and the
`main` check before the three external writes. Beyond those,
`v4.5.4-durable-jobs-regression` now holds 24 checks, including a live owner for
a primary round, the format-recovery reservation and legacy session recovery
compatibility. The affected pre-existing regressions add further focused checks
for grounding, judge/cost, accounting/preflight and bounded symbol extraction.

The remote validation, the published SHA, the workflows and the version confirmed
on npm should be added to this report only after the release converges; they are
not anticipated as success.

## 9. Local closing validation

Every test in this section uses the stub adapters; none of them opens a paid
provider call.

- `npm run check`: green (Prettier, ESLint with no warnings, Biome and
  `tsc --noEmit`);
- `npm run smoke`: green in 140.9 seconds, including registry discipline,
  evidence, cost, durability and the six simulated peers;
- the new and extended focused regressions described in section 8: green;
- `npm test` started correctly, compiled and ran without failure every block it
  managed to report, but the local invoker terminated it at the external limit of
  240.9 seconds. That is not a test failure and was not masked as success;
- to close without repeating the whole chain, the exact tail not reached under
  that limit was run in isolation and came out green: evidence transport (57
  checks), custody, truthfulness preflight (4), source contract (10) and
  `runtime-smoke` (build + six stub peers, `ok: true`, source version 4.5.18).

Every component of the `npm test` chain was therefore observed green in this
validation, even though the monolithic process received no final exit code
because of an executor limitation. GitHub's CI remains the authoritative verifier
of the monolithic run on the published SHA.

Dependabot was also validated before publication. The configuration covers `npm`,
GitHub Actions, `pip`/`pip-compile` and `pre-commit`, which are every
ecosystem/manifest present. The npm binary pin in the workflows is a toolchain
dependency with an explicit update, outside Dependabot's scope; the validator
`scripts/validate-dependabot-config.py` passed.

## 10. Action plan and closing criterion

1. finish the independent review of the diff;
2. commit and sync directly on `main`;
3. follow CI, CodeQL, release/publish and alerts on the exact SHA;
4. confirm `@lcv-ideas-software/cross-review@4.5.18` on npm with provenance;
5. after the global upgrade and the window reload, require
   `server_info.version=4.5.18`, the current config SHA and
   `reload_required=false`;
6. only then deliberately re-enable `shadow`, if its cost/benefit is wanted.

The work is not finished merely because the source is corrected. The final
criterion is: green workflows, zero relevant new alerts and package 4.5.18
published successfully.
