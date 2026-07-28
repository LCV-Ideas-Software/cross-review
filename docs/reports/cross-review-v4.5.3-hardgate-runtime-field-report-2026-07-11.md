# Cross Review v4.5.3 - Runtime Hardgate Field Report

Date: 2026-07-11, America/Sao_Paulo  
Observation window: 2026-07-12 01:41-02:13 UTC  
Runtime: cross-review 4.5.3  
Reviewed commit: `165c6805e75bc64d11f773907e45f1b645c58b1c`

## Purpose

This report records a live hardgate exercise performed after installing and reloading
cross-review 4.5.3. It is intended to be aggregated with other field reports produced by
independent 4.5.3 sessions.

The exercise had two goals:

1. verify that the loaded MCP process was actually version 4.5.3; and
2. obtain a formal cross-review verdict for the 4.5.3 hardening commit while observing the
   evidence, truthfulness, review, relator, judge, cancellation, cost and persistence paths.

No source file was changed during the review attempts. The only repository change produced by
this exercise is this report.

## Executive conclusion

The loaded process was conclusively 4.5.3 and the automatic evidence transport introduced in
the release worked. Every structured evidence submission was persisted without human operator
action, retained its SHA-256, was marked `caller_submitted_unverified`, and appeared in the
review prompts. The earlier loss of inline evidence was not reproduced.

The formal hardgate did not converge after three diagnostic submissions. This was not caused by
a substantive code objection:

- ten usable reviewer responses across the first two submissions returned raw `READY`;
- none of the sessions contained a raw `NOT_READY` code verdict;
- the first six usable votes were reclassified by strict grounding;
- the next four usable votes were also reclassified because explanatory prose made at least one
  `evidence_sources` item ungrounded;
- in the final, deliberately unambiguous submission, Gemini and DeepSeek were persisted as
  `READY` with `decision_quality=clean`;
- Claude Fable 5 ended at `stop_reason=max_tokens`; and
- Perplexity returned a zero-character answer and its paid format-recovery retry was aborted.

The observed runtime therefore cannot be treated as operationally reliable for this hardgate,
even though the reviewed patch received no substantive rejection. Formal status remains open.

## Runtime snapshot

Fresh `server_info` returned:

| Field                  | Observed value                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Version                | `4.5.3`                                                            |
| Release date           | `2026-07-11`                                                       |
| Transport              | `stdio`                                                            |
| Stub mode              | `false`                                                            |
| Config applied         | `true`                                                             |
| Fields applied         | `70`                                                               |
| Environment overrides  | `0`                                                                |
| Loaded config SHA-256  | `87f809f2bd9cba20147c707d3a33be0745907889d0e9a3968c8a3090db1a9c0b` |
| Current config SHA-256 | same as loaded                                                     |
| Reload required        | `false`                                                            |
| Max output tokens      | `20000`                                                            |
| Default max rounds     | `15`                                                               |
| Session cost ceiling   | `$20`                                                              |

Loaded models and configured effort:

| Role         | Model                    | Effort           |
| ------------ | ------------------------ | ---------------- |
| Codex caller | `gpt-5.6-sol`            | `max`            |
| Claude       | `claude-fable-5`         | `max`            |
| Gemini       | `gemini-3.1-pro-preview` | provider/default |
| DeepSeek     | `deepseek-v4-pro`        | `max`            |
| Grok         | `grok-4.5`               | `high`           |
| Perplexity   | `sonar-reasoning-pro`    | `high`           |

All capability snapshots matched the requested model identifiers. No silent model fallback was
observed. The Perplexity probe was `auth_only`; it did not perform a model round-trip and therefore
did not predict the later empty response or timeout.

## Sessions

| Session                                | Purpose                     | Relator    | Rounds | Terminal outcome            | Persisted minimum cost |
| -------------------------------------- | --------------------------- | ---------- | -----: | --------------------------- | ---------------------: |
| `ef7b67c6-511c-413e-8d87-7d0f8d861172` | full operational evidence   | DeepSeek   |      2 | `aborted/session_cancelled` |            `$1.295806` |
| `023aab7e-32dc-4006-8e1d-d09b2d6f721a` | compact static patch        | Perplexity |      1 | `aborted/session_cancelled` |            `$1.143486` |
| `bc830eba-b479-4e39-8513-576aff3ead9b` | exact one-citation contract | Grok       |      1 | `max-rounds`                |            `$0.039289` |

The persisted total across the three sessions is at least `$2.478581`. It is a lower bound, not
an accurate provider-spend total, because rejected, retried, judge and aborted calls are omitted
from the ledger in several paths.

## What worked

### Loaded-version verification

The live process, not merely the globally installed package, reported 4.5.3. Loaded and on-disk
configuration hashes matched and `reload_required` was false.

### Automatic evidence transport

Every `evidence` argument was automatically persisted by `session_start_unanimous`. No operator
attachment or human custody operation was used.

Examples:

| Session   |   Bytes | SHA-256                                                            | Authority                     |
| --------- | ------: | ------------------------------------------------------------------ | ----------------------------- |
| `ef7b...` | `50957` | `ce8a93772ab5f0b1a372ee33a2cb4673c1b7ca084bc1760316be8d6eb039c3cb` | `caller_submitted_unverified` |
| `023a...` | `14298` | `6910a54c51049c891827fd669406c086da3cf33b965e918f4c6a9d6120541568` | `caller_submitted_unverified` |
| `bc83...` | `14298` | `6910a54c51049c891827fd669406c086da3cf33b965e918f4c6a9d6120541568` | `caller_submitted_unverified` |

The same compact payload produced the same digest in two sessions while receiving different
server-generated paths. This confirms byte integrity and also shows that identical payloads are
duplicated rather than stored content-addressably.

### Authority separation

Caller material remained explicitly unverified. No event promoted it to operator-verified
custody. This is the correct security boundary.

### Relator lottery and anti-self-review

The lottery rotated across the three sessions:

- DeepSeek was relator in `ef7b...`;
- Perplexity was relator in `023a...`; and
- Grok was relator in `bc83...`.

The relator did not vote in its own session. Codex remained caller and did not review itself.

### Exact citation contract

The final session proved that the 4.5.3 whole-wrapper parser can persist clean votes when the
provider follows a precise citation contract. Gemini and DeepSeek returned exactly:

```text
Artifact quote: "const commands = extractChecklistCommands(ask);"
```

Both were stored as `READY`, with no parser warnings and `decision_quality=clean`.

## Detailed findings

### P0-1: an instruction can be misclassified as a factual state claim

The first task contained:

```text
Inspect the production wiring and regression tests.
```

`CURRENT_STATE_CLAIM_PATTERN` contains the bare token `production`. When independent review is
required, `groundReadyPeerEvidence` places every matching line into `forcedCurrentStateClaims`.
It then requires `truthfulnessClaimHasMatchingEvidence` for every such line.

The quoted line is an instruction, not a factual assertion. It has no version, date, URL, digest
or operational-state anchor, so `truthfulnessClaimHasMatchingEvidence` necessarily returns false.
This makes `peerEvidenceGrounded` false for every peer regardless of its citation quality.

The evidence strongly supports this diagnosis:

- all six usable votes in the two rounds were raw `READY`;
- all six were reclassified with the same generic strict-grounding warning;
- Grok round 2 supplied the generated attachment path, full SHA-256 and a complete
  `Artifact quote`, but was still reclassified; and
- the prompt preserved the triggering task line in every round.

Relevant code areas are `groundReadyPeerEvidence`, `CURRENT_STATE_CLAIM_PATTERN` and
`truthfulnessClaimHasMatchingEvidence` in `src/core/orchestrator.ts`.

Required correction:

- separate instructions from claim-bearing text;
- require assertive syntax before a line becomes a state claim; and
- persist which exact claim and predicate failed.

### P0-2: the consensus judge cannot reach unanimity for an item owned by its panel

The configured consensus panel contained the same peers that created checklist items. For each
item, the judge map includes its author, emits `self_judgment_forbidden`, then treats that error as
a failed vote and sets `unanimousVerifiedSatisfied=false`.

Therefore, if the item owner belongs to `judge_peers`, consensus is mathematically impossible.

Observed effects:

- session `ef7b...` round 1: 3 items, 9 paid eligible-judge generations, `0 promoted, 3 skipped`;
- session `ef7b...` round 2: 3 items, many retries, `0 promoted, 3 skipped`; and
- session `023a...`: 4 items, `0 promoted, 4 skipped`.

The self peer must be removed from both the call set and denominator before unanimity is
calculated.

### P0-3: cancellation is not fail-fast and aborted work is retried

In `ef7b...`, cancellation was requested at `02:00:52.366Z` and terminal state was not written
until `02:01:16.900Z`, about 24.5 seconds later. After the request, the runtime emitted:

- Perplexity attempt 3;
- a new evidence-judge pass;
- multiple judge retries; and
- DeepSeek relator attempts near and after terminal persistence.

`Request was aborted` was classified as `timeout` and `retryable=true`. An abort must instead be a
terminal `cancelled` result and must never start another retry, judge, relator or round.

The second cancellation completed in about 1.2 seconds, showing nondeterministic cancellation
latency depending on the phase. The third session produced mixed terminal semantics: the job was
`cancelled`, control remained `cancel_requested`, while the session outcome became `max-rounds`.

### P0-4: jobs and cancellation controllers are process-local

Sessions and `in_flight` state are durable, but `runtime.jobs` and AbortControllers live in memory
inside the MCP process that created the job. A separate Codex/MCP connection can read the same
session yet see `jobs: []` and cannot cancel the owner process through the current mechanism.

This is a material multi-window defect. A cancellation request must be durable or routed by IPC,
and the owning process must observe it.

### P0-5: cost and token accounting omit paid calls

The persisted ledger includes successful reviewer results and the stored DeepSeek revision, but
omits or cannot reconcile:

- Claude calls rejected at `max_tokens`;
- Perplexity retries and aborted calls;
- evidence-judge calls;
- judge retries; and
- relator attempts discarded during cancellation.

For example, `ef7b...` reports `$1.295806`, exactly the sum of persisted usable peer results and
one saved revision. The many judge and rejected-provider calls are absent. The final session
reports only `$0.039289`, despite a long Claude request reaching `max_tokens` and a Perplexity
format-recovery path estimating an additional `$0.483384`.

Budget enforcement cannot be trusted unless each attempted provider call reserves and records
cost independently of whether its decision is later usable.

### P1-1: the prompt contract and grounding parser disagree about `evidence_sources`

The system prompt tells peers to keep detail in `evidence_sources`. The models accordingly copied
exact code and added analysis in the same string, or supplied additional narrative entries.

`groundReadyPeerEvidence` evaluates every source independently. A valid excerpt plus explanatory
text may not exist verbatim in the corpus, and any additional narrative-only item becomes
unsupported. The whole READY vote is then reclassified.

Session `023a...` demonstrated this systematically:

- Claude, Gemini, DeepSeek and Grok all returned raw `READY`;
- all supplied code excerpts from the 14 KB patch;
- all were persisted as `NEEDS_EVIDENCE` with
  `ready_evidence_sources_ungrounded`.

The final session proved the workaround: exactly one `Artifact quote` and no prose produced clean
READY votes. The provider schema should distinguish literal citations from rationale, or the
prompt must explicitly require citation-only array entries.

### P1-2: the evidence preflight can cross-correlate unrelated tokens in minified JSON

The first preflight attempt failed with:

```text
text references evidence artifact(s) whose literal content was not supplied to this session:
CHANGELOG.md
```

The path occurred in a minified GitHub Publish JSON step named `Extract release notes from
CHANGELOG.md`. Elsewhere on the same long JSON line were words such as `artifact` and `metadata`.
The scanner operates line-by-line, so an unrelated context token anywhere in that minified line
turned the filename into an alleged external evidence reference.

Removing the detailed Publish JSON made the same submission pass both gates. Recommended fixes:

- bound context matching by token distance;
- parse structured JSON rather than treating a whole minified document as one sentence; and
- recognize literal structured evidence as supplied material instead of requiring attachment
  registration for every incidental filename.

### P1-3: Claude Fable 5 at `max` repeatedly exhausts the 20K output budget

Claude behavior was highly sensitive to context but repeatedly incompatible with formal
convergence:

| Session/round | Result                             | Latency | Recorded output tokens |
| ------------- | ---------------------------------- | ------: | ---------------------: |
| `ef7b...` R1  | rejected, `stop_reason=max_tokens` | 265.0 s |                omitted |
| `ef7b...` R2  | raw READY, later reclassified      | 181.7 s |                  14196 |
| `023a...` R1  | raw READY, later reclassified      | 210.3 s |                  19143 |
| `bc83...` R1  | rejected, `stop_reason=max_tokens` | 245.2 s |                omitted |

Even the final prompt demanded a roughly 200-character response, but Claude spent the available
budget and produced no usable terminal answer. The runtime should either:

- reserve tokens for the structured final answer when extended thinking is active;
- automatically retry `max_tokens` with lower effort or a larger documented output ceiling; or
- classify the condition as recoverable format/output exhaustion rather than permanently
  rejecting the peer.

A per-call override from `max` to `high` is the next controlled experiment, but it was not run
after the third failed diagnostic cycle.

### P1-4: Perplexity availability and output handling are insufficient

Perplexity showed three distinct states:

- a valid but slow R1 response in `ef7b...` after 277.9 seconds;
- three failed attempts totaling 475.9 seconds in `ef7b...` R2; and
- one streamed chunk with zero text in `bc83...`, followed by a paid full-decision retry.

The `auth_only` probe could not predict any of these. A zero-character completion should carry a
specific failure class. Retry cost should be reserved and included in the ledger before dispatch.

### P1-5: successful peer responses are not persisted as they finish

Fast responses were written only after the slowest peer completed. In `ef7b...` R2, Gemini,
Grok and Claude completed minutes before their response files were persisted. A process crash in
that interval could lose already completed provider work.

Each peer result should be atomically persisted immediately after parsing and grounding.

### P1-6: reports and events can disagree with terminal state

The automatically existing report for `ef7b...` was stale before an explicit `session_report`
refresh: it had no terminal outcome and omitted late events. Events are appended asynchronously,
so their persisted ordering can also cross the terminal timestamp.

The report should be regenerated or transactionally updated on every terminal transition and
should show raw and transformed status side by side.

### P1-7: diagnostic detail is discarded

The grounding function computes unsupported sources, fabrication state, custody checks,
operational assertions and forced state claims. The persisted result generally exposes only a
generic warning such as:

```text
ready_peer_submitted_evidence_requires_path_hash_and_correlated_raw_quote
```

This prevents the relator from knowing whether the missing predicate was a path, digest, quote,
unsupported source, operational value or misclassified instruction. The resulting generic
checklist asks caused peers to provide more evidence without addressing the hidden predicate.

### P2-1: vacuous `operator_grounded` telemetry

Both static preflights reported:

- no high-risk claim;
- no attachments;
- Codex as caller;
- `independent_review_required=false`; and
- `truthfulness.operator_grounded=true`.

The evidence gate correctly reported authority `none`. The truthfulness field is therefore
misleading, likely from an empty-array/vacuous-truth path, even if it does not currently promote
evidence authority.

### P2-2: undocumented cancellation-reason limit

`session_cancel_job.reason` rejects strings over 300 characters, but the callable tool
description does not expose the limit. The first cancellation attempt failed validation before
reaching the handler. The schema and documentation should declare the constraint, and the error
should include a stable structured `max_length` field.

### P2-3: peer-selection event wording is confusing

When the caller supplied the same five non-caller peers that the policy would select, the runtime
said the panel was ignored and recorded those peers under `ignored_peers`, although they still
participated as relator or voters. The event should distinguish `requested_panel_ignored` from
`effective_panel`.

### P2-4: prompt still asks for MD5 while the security protocol uses SHA-256

The session-start contract mentions `MD5 hashes` as an evidence example. That wording should be
removed in favor of SHA-256 to avoid teaching a weaker and inconsistent evidence convention.

## Provider observations

| Provider   | Positive observation                                        | Blocking observation                                                |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Gemini     | fastest reviewer; clean READY under exact contract          | verbose evidence arrays were reclassified                           |
| DeepSeek   | effective relator; clean READY under exact contract         | high reasoning token use and long static review                     |
| Grok       | supplied path, digest and literal in R2; rotated as relator | still blocked by hidden claim predicate / unsupported sources       |
| Claude     | produced a detailed material READY in two rounds            | two terminal `max_tokens` failures; very high output cost           |
| Perplexity | one material READY with extensive code analysis             | high latency, timeouts, zero-character completion and paid recovery |
| Codex      | authenticated caller; no self-review                        | cannot see/cancel another process's in-memory job registry          |

## Hardgate result

The formal hardgate is **not closed**.

Material review result:

- no raw `NOT_READY` was observed;
- the reviewed code received repeated raw READY decisions; and
- the exact final citation was accepted cleanly by Gemini and DeepSeek.

Formal result:

- session `ef7b...`: aborted after systematic strict-grounding reclassification;
- session `023a...`: aborted after systematic per-source grounding reclassification; and
- session `bc83...`: `max-rounds`, with Gemini and DeepSeek READY, Claude provider error and
  Perplexity empty/timeout.

After three diagnostic submissions, further paid attempts were stopped. The next experiment
requires an explicit decision to lower only Claude's per-call effort from `max` to `high`; it
should also account for Perplexity's zero-output retry risk.

## Recommended acceptance tests

1. **Instruction versus claim**  
   A task containing `Inspect the production wiring` plus valid caller evidence and a grounded
   READY citation must stay READY. An altered digest and invented suffix must still fail.

2. **Citation plus rationale**  
   An evidence entry containing a verbatim fenced excerpt followed by explanation should either
   remain grounded or be normalized into separate citation and rationale fields.

3. **Consensus judge self exclusion**  
   For an item created by Gemini and judges Claude/Gemini/Grok/Perplexity, call and count only
   Claude/Grok/Perplexity. Three verified-satisfied results must produce `would_promote=true` in
   shadow and promotion in active mode.

4. **Fail-fast cancellation**  
   Cancel an in-flight provider and assert no subsequent retry, judge, relator or round is
   started. Terminalize quickly as `cancelled`, not `timeout` or `max-rounds`.

5. **Cross-process cancellation**  
   Process A starts a session; process B polls and cancels it; A must observe the durable request
   and both processes must converge on one terminal state.

6. **Complete cost ledger**  
   A fixture with a successful review, `max_tokens`, a retry, a judge call and an aborted call
   must record or reserve all attempts and enforce the ceiling before dispatch.

7. **Claude final-answer reserve**  
   Under `claude-fable-5` with effort `max`, require a short structured result and assert that
   thinking cannot consume the entire response budget. If it does, retry once with a safe
   documented policy.

8. **Perplexity zero-output terminal**  
   A completion containing one chunk and zero text must become a specific recoverable failure,
   with retry cost reserved and observable.

9. **Immediate peer persistence**  
   Hold one peer open, complete the other peers, simulate process termination and verify that the
   completed responses survive.

10. **Terminal report consistency**  
    After cancel, max-rounds and converge transitions, `meta.json`, `events.ndjson`, job state and
    `session-report.md` must agree on outcome, reason, peers, last sequence and cost.

11. **Minified structured evidence**  
    A one-line JSON document containing an unrelated `artifact` token and a step mentioning
    `CHANGELOG.md` must not create an unattached-evidence false positive.

12. **No vacuous operator authority**  
    A caller peer with no high-risk claim and no operator evidence must never report
    `operator_grounded=true`.

## Durable artifacts

Session roots:

- `C:\Users\leona\.cross-review\data\sessions\ef7b67c6-511c-413e-8d87-7d0f8d861172`
- `C:\Users\leona\.cross-review\data\sessions\023aab7e-32dc-4006-8e1d-d09b2d6f721a`
- `C:\Users\leona\.cross-review\data\sessions\bc830eba-b479-4e39-8513-576aff3ead9b`

For each session, inspect:

- `meta.json`
- `events.ndjson`
- `session-report.md`
- `agent-runs/round-*-prompt.md`
- `agent-runs/round-*-response.json`
- `evidence/`

The reports were explicitly regenerated after terminalization so their current copies include the
final outcomes observed above.
