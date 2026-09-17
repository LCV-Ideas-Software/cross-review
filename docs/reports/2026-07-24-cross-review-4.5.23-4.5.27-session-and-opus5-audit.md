# Technical audit of cross-review 4.5.23–4.5.27 and preparation for Claude Opus 5

Audit date: 24 July 2026  
Published version loaded during the analysis: 4.5.27  
Final corrective version prepared: 4.5.29
Release note: the immutable tag 4.5.28 was not published; the gate detected
GHSA-mh99-v99m-4gvg, disclosed during the delivery, and required 4.5.29 with
`brace-expansion` 5.0.8.

## 1. Executive summary

Every durable session identified as originating from versions 4.5.23 to 4.5.27
was audited, along with their events and the recent logs available. The analysis
confirmed five principal defect classes:

1. incomplete recovery of interrupted sessions, including false `running`
   states, a recycled PID and an orphaned durable job;
2. unbounded growth of the Evidence Broker, able to amplify prompts, tokens and
   cost with every round;
3. a `truthfulness_preflight` false positive on a future condition;
4. checklist identifiers issued by the server itself classified as possibly
   fabricated evidence;
5. insufficient aggregate diagnostics when the grounding of a claim fails
   against one of two distinct corpora.

A proven operational opportunity was also identified: `session_events` returned
events with no page limit and included, by default, granular token telemetry
that accounted for 59.1% of the records in the recent logs analysed.

The 4.5.28 worktree contains targeted fixes for those classes:

- automatic, coherent recovery of session, control, health, accounting and job
  after a restart;
- validation of the process start date to detect a recycled PID;
- a fail-closed circuit breaker and atomic admission for the Evidence Broker;
- correct handling of future temporal conditions;
- incorporation of the server-issued checklist IDs into the provenance corpus;
- per-claim and per-corpus diagnostics;
- pagination and filtering for `session_events`;
- hardened protection of the local caller-token file.

The Anthropic adapter was also prepared for `claude-opus-5` as an explicit
operator override. The active model stays `claude-fable-5`; Opus 5 was not
introduced as an automatic fallback. The change covers the request wire, refusal
classification, cache limits, the SDK and the cost table.

The most important security finding is residual: the hardened DACL reduces the
exposure of `host-tokens.json` to inherited groups, but it does not isolate two
unrestricted processes running under the same SID. For that threat model, the
definitive solution requires server-persisted verifiers and the distribution of
each raw secret exclusively to its own host, with the operator token kept in a
vault or a separate operating-system identity.

## 2. Scope and methodology

### 2.1 Temporal scope

The corpus was selected by the runtime version persisted in each session:

| Version | Sessions |
| ------- | -------: |
| 4.5.23  |        5 |
| 4.5.24  |        0 |
| 4.5.25  |       26 |
| 4.5.26  |       15 |
| 4.5.27  |        0 |
| Total   |       46 |

The absence of 4.5.24 and 4.5.27 sessions in the audited storage does not
authorize inferring they went unused on other hosts; it only means there was no
durable session of those versions in the local corpus available.

### 2.2 Sources examined

The audit considered:

- `meta.json`, rounds, prompts, responses and durable reports of the 46
  sessions;
- the sequential events persisted per session;
- the 11 recent log files available;
- control, health, accounting, provider reservations and durable job state;
- raw, parsed and normalized status transformations;
- convergence scope, declared identity and verified identity;
- persisted evidence references and texts;
- the configuration, adapters and regressions present in the 4.5.28 worktree.

1,403 session and log files were inspected. The forensic analysis was read-only:
it opened no new sessions and called no paid providers.

### 2.3 Classification criterion

A behaviour was classified as a proven bug only when there was reproducible
persisted state, a direct incompatibility between runtime invariants, or a
deterministic replay of the rule. External reports without the exact session
were kept as investigation hypotheses, not converted into a conclusion.

The worktree's fixes were evaluated by the observable contract they implement.
The validation section distinguishes:

- a targeted test already run at the time of the change;
- static inspection of the worktree;
- integrated validation still pending;
- CI, publication and post-reload runtime still pending.

## 3. Characterizing the corpus

### 3.1 Volume and cost

| Metric                       |          Result |
| ---------------------------- | --------------: |
| Sessions                     |              46 |
| Rounds                       |              95 |
| Tokens accounted             |       6,080,046 |
| Cost accounted               | USD 54.67147309 |
| Durable session events       |           4,439 |
| Events in the 11 recent logs |           3,983 |
| Invalid JSON                 |               0 |
| Sequence gaps detected       |               0 |

### 3.2 Outcomes

| Outcome observed | Sessions |
| ---------------- | -------: |
| Converged        |        6 |
| Round limit      |       20 |
| Aborted          |       18 |
| Open             |        2 |

The corpus's low convergence rate does not, on its own, prove a gate defect. It
combines interruptions, round limits, legitimate evidence demands and the
specific defects detailed in this report.

### 3.3 Status transformations

274 peer responses were examined:

| Raw status and destination                     | Count |
| ---------------------------------------------- | ----: |
| `READY` preserved                              |   118 |
| `READY` demoted                                |    61 |
| `NEEDS_EVIDENCE` preserved                     |    77 |
| `NOT_READY` demoted for insufficient grounding |    18 |

Of the 179 raw `READY` votes, 34.1% were demoted. That number demonstrates real
cost and friction, but it does not authorize presuming every demotion was a
false positive. The audit separated the demonstrably incorrect cases from
deliberate conservative applications of the contract.

## 4. Claude Opus 5's official contract

### 4.1 Official sources used

The contract was derived exclusively from Anthropic's official documentation and
the SDK's official release:

- [What's new in Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Claude model migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Anthropic TypeScript SDK 0.115.0](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.115.0)

Behaviours observed in a session were not used as substitutes for the API
contract.

### 4.2 Identity and limits

- fixed, undated ID: `claude-opus-5`;
- input context window: 1 million tokens;
- maximum synchronous output: 128 thousand tokens;
- thinking enabled by default;
- explicit adaptive thinking still valid;
- native effort scale: `low`, `medium`, `high`, `xhigh` and `max`;
- default effort: `high`;
- the documentation gives `max_tokens=64000` as an example for `xhigh` or `max`.

The Claude output budget cross-review already keeps, 64,000 tokens, is
compatible with the official recommendation and sits below the synchronous
ceiling.

### 4.3 Request wire

For Opus 5, the prepared request uses:

```json
{
  "model": "claude-opus-5",
  "max_tokens": 64000,
  "thinking": {
    "type": "adaptive",
    "display": "omitted"
  },
  "output_config": {
    "effort": "max"
  }
}
```

The adapter does not send:

- `thinking={type:"enabled",budget_tokens:...}`;
- `temperature`;
- `top_p`;
- `top_k`.

That avoids combining Opus 5 with manual thinking forms and non-default sampling
that the new family does not accept. `thinking=disabled` is not used with
`xhigh` or `max`, a combination that results in an HTTP 400 error.

### 4.4 Refusals

Fable 5 and Opus 5 may return a refusal as an HTTP 200 response with
`stop_reason="refusal"`. The runtime:

- discards the refusal's partial content;
- records `provider_refusal` as a non-ignorable failure;
- treats a refusal preceding any output as unbilled;
- preserves input and output accounting when the refusal happens mid-generation.

The messages and the classification stopped being Fable-specific so as to cover
both models without inferring an automatic downgrade.

### 4.5 Cache and costs

Official values per million tokens:

| Opus 5 item                |   USD |
| -------------------------- | ----: |
| Input                      |  5.00 |
| Output                     | 25.00 |
| Cache read                 |  0.50 |
| Cache write, TTL 5 minutes |  6.25 |
| Cache write, TTL 1 hour    | 10.00 |

The documented minimum cacheable prefix is 512 tokens. The adapter now uses a
per-model limit:

- Fable 5: 512 tokens;
- Opus 5: 512 tokens;
- Opus 4.8: 1,024 tokens;
- unknown Anthropic model: a conservative fallback of 4,096 tokens.

The central configuration added for the Opus 5 override uses the one-hour TTL,
hence `cache_write_per_million=10`. Fable 5 stays active with its own costs.

### 4.6 Product restrictions

Per the official documentation considered:

- Opus 5 offers no Priority Tier;
- Opus 5 offers no web fetch.

cross-review does not try to enable those capabilities for the model.

### 4.7 Integration decision

`claude-opus-5` was added to the list of supported Anthropic overrides, without
changing the canonical priority:

- active by default: `claude-fable-5`;
- future override permitted: `claude-opus-5`;
- compatibility preserved: `claude-opus-4-8`;
- automatic fallbacks: none.

The `@anthropic-ai/sdk` SDK was raised from `^0.114.0` to `^0.115.0`, the version
that includes Opus 5 support and a fix for abort-listener cleanup.

## 5. Proven bugs and fixes prepared for 4.5.28

### 5.1 P1 — an interrupted session stayed falsely `running`

#### Evidence

In session `fef6f09e-8991-4950-93f2-f6d643e3ac0e`, created by 4.5.26, round 8:

- the sweep correctly removed `in_flight`;
- Gemini's and Grok's exact costs were preserved;
- three interrupted calls with no result stayed `unknown/unpriced`;
- `convergence_health`, `control` and job `a836...` stayed `running`;
- PID 328 no longer represented the original process.

Session `6f51a9d6-34b0-4b77-a636-cea82c4401fa`, 4.5.25, showed the same class
with an orphaned Grok generation. There, the persisted PID had been reused by
another process, so a check based only on the PID's existence produced a
liveness false positive.

#### Cause

`clearStaleInFlight()` reconciled `in_flight` and accounting, but did not
coherently transition:

- control;
- convergence health;
- the background job;
- the recovery event;
- the durable report.

`recoverInterruptedSessions()` contained part of the correct transition, but
depended on an operator-only tool and was not run automatically at startup. The
process check did not compare the process's start date with the date persisted
in the marker.

#### 4.5.28 fix

- complete recovery at startup, before the fallback sweep;
- comparison of the process start against the marker to detect a recycled PID;
- transition of `control` to `recovered_after_restart`;
- an orphaned job to `failed` or `cancelled`, depending on the previous state;
- convergence health updated to a stale/recovered state;
- preservation of known accounting and of the `unknown` state for interrupted
  calls with no result;
- event and report regenerated.

### 5.2 P1 — a durable job stayed `running` after a terminal session

#### Evidence

Session `1ce5e743-e3d6-4d0d-a2c1-276bc84aad85` ended `aborted`, but job `2dab...`
remained persisted as `running`.

#### Cause

`reconcileObservedJobs()` did not terminate an orphaned job when:

- `session.outcome` was already terminal;
- there was no matching local durable execution;
- there was no active control justifying the state.

#### 4.5.28 fix

The reconciler now terminates an orphaned job belonging to a terminal session or
having no durable execution, while preserving genuinely active local jobs and
valid pending executions.

### 5.3 P1 operational / P2 security — unbounded Evidence Broker amplification

#### Evidence

In session `1ce5e743-e3d6-4d0d-a2c1-276bc84aad85`:

- 142 checklist items accumulated;
- 116 ended `not_resurfaced`;
- `meta.json` reached roughly 619.5 KiB;
- the session consumed 889,187 tokens;
- the cost was USD 5.39668585;
- every unresolved item was injected again into the subsequent prompts.

The runtime imposed no limit:

- per peer and round;
- global per round;
- per session;
- per persisted character.

A hostile, defective or merely over-verbose peer could cause denial-of-wallet
without needing to compromise a provider or the host.

#### 4.5.28 fix

Configurable limits were introduced:

| Limit                    | Default |
| ------------------------ | ------: |
| Requests per peer/round  |       8 |
| Total requests per round |      24 |
| Items per session        |      64 |
| Characters per session   |  64,000 |

The contract is fail-closed:

- exact duplicates from the same owner are deduplicated;
- admission is atomic;
- excess does not cause silent truncation;
- no blocker is auto-satisfied;
- no partial batch is appended;
- the peers' complete response stays in the round for audit;
- a legacy checklist that is already excessive is stopped before any new paid
  dispatch;
- excess created in the round stops the session before an automatic judge or an
  additional round;
- the event `session.evidence_checklist_circuit_breaker_tripped` records the
  phase, the limits, the calls already started and the absence of partial
  mutation;
- formal outcome: `evidence_checklist_contract_violation`.

### 5.4 P2 — a future condition read as a current-state claim

#### Evidence

Session `108bece7-74d6-47b5-b5b0-44efab05cd5a` was aborted before the first round
because of the text:

> After merge and exact-head green CI, retry...

The text describes future prerequisites; it does not assert that the merge and a
green CI have already happened.

#### Cause

The operational-state detector found terms such as `CI` and `green` before
evaluating whether they belonged to a temporal condition preceding an
instruction.

#### 4.5.28 fix

The detector removes only an initial temporal preamble in order to classify the
main clause:

- `After merge and exact-head green CI, retry...` stays a future instruction;
- `After the merge completed, CI is green.` is still an assertive claim and fails
  without evidence.

The fix reduces false positives without relaxing the protection over real runtime
claims.

### 5.5 P2 — the server's checklist IDs classified as fabricated

#### Evidence

In the replay of round 6 of session `fef6f09e-8991-4950-93f2-f6d643e3ac0e`, seven
hexadecimal IDs referenced by the peers were `Checklist-Item` IDs issued by the
server itself. Even so, the detection found seven new hexadecimal tokens and
marked `fabricated=true`.

#### Cause

The provenance corpus contained attachments and evidence text, but did not
contain the checklist IDs the server had inserted into the prompt.

#### 4.5.28 fix

The IDs actually issued in the session now form part of the provenance corpus.
The rule stays conservative:

- an ID known to the server is not a fabrication;
- a similar ID that the server did not issue is still subject to detection and
  demotion.

### 5.6 P2 — aggregate grounding diagnostics hid which claim failed

#### Evidence

In round 1 of session `fef6f09e-8991-4950-93f2-f6d643e3ac0e`, Gemini was
transformed from raw `READY` to `NEEDS_EVIDENCE`, even though:

- 5/5 sources had `supported=true`;
- custody and attachment were correlated;
- `fabricated=false`;
- the only failing aggregate predicate was
  `peer_submitted_evidence_corroborated`.

The rule checked high-risk claims against two distinct corpora, but the result
did not indicate which claim had failed in which corpus.

#### 4.5.28 fix

`failed_claim_diagnostics` now persists:

- the corpus: `caller_evidence` or `peer_sources`;
- the claim's type;
- the index;
- a bounded excerpt.

The complete fabrication details are also preserved in the status
transformation. The fix increases auditability without turning an invalid source
into valid evidence.

### 5.7 P3 operational — `session_events` with no useful page and with delta noise

#### Evidence

In the 11 recent logs, 2,354 of 3,983 events, or 59.1%, were `peer.token.delta`.
Because the events were returned all together, follow-up queries could produce
large, truncated payloads.

#### 4.5.28 improvement

`session_events` now offers:

- `limit` default 200;
- `limit` maximum 1,000;
- `include_token_deltas=false` by default;
- `next_seq`;
- `has_more`;
- `filtered_token_delta_count`.

The operator can still opt into granular telemetry to investigate streaming, but
the normal path stays bounded and incremental.

## 6. Security and anti-deception mechanisms

### 6.1 Controls whose operation was confirmed

In the audited corpus:

- 45 convergence scopes were examined with no anti-self-review violation;
- no `non-voting` relator appeared among the voters;
- 274 peer responses showed zero `model_match=false`;
- 145 caller verifications observed in the logs were token-verified;
- one attempt by Claude to declare itself `operator` was blocked;
- two operator-only calls made by Codex were blocked;
- no Anthropic, OpenAI, Google, xAI, DeepSeek, Perplexity or GitHub key pattern,
  Bearer token or PEM was found;
- streaming had `include_text=false`, persisting the count and not the deltas'
  content.

The negative search for secret patterns lowers the probability of a leak in the
corpus, but it does not constitute mathematical proof that no possible secret is
present.

### 6.2 Conservative grounding must stay

The all-or-nothing behaviour of citations is deliberately conservative. In round
7 of `fef6...`, Gemini presented 2/3 valid sources and Grok 9/10, but the
complete votes were demoted. That creates friction, yet preventing a decisive
claim from resting on the single invalid item is part of the anti-deception
guarantee.

A future delta fix may preserve valid items and ask for repair of only the
invalid index, but it must not:

- accept a definitive vote with an ungrounded decisive blocker;
- turn an absence of correlation into a mere warning;
- auto-satisfy the checklist;
- let a valid citation cover for another, independent and invalid claim.

### 6.3 Caller tokens: mitigation applied

`host-tokens.json` holds seven capabilities in the clear: six peers and the
operator. In the 4.5.28 worktree, the runtime fails closed if it cannot protect
the file:

- POSIX: mode `0600` verified;
- Windows: NTFS inheritance removed and the DACL limited to the current user,
  SYSTEM and Administrators.
- existing files are opened once, hardened and read through the same descriptor;
  the schema migration also writes through the descriptor, after checking that it
  still matches the path. On POSIX, the open uses `O_NOFOLLOW`.

The ACL of the local file actually used during the analysis was adjusted to that
set, removing inherited access from sandbox groups.

### 6.4 Caller tokens: residual risk

The ACL mitigation does not separate unrestricted processes running under the
same SID. If the threat model includes a potentially deceptive model host with
unrestricted access to the user's filesystem, that process can still read the
token map in the clear.

Recommended architectural fix:

1. persist only a hash/verifier of each capability on the server;
2. supply each host only its own raw token, by secret/env;
3. keep the operator token in a vault or a separate operating-system identity;
4. rotate every current token during the migration;
5. never log a raw token, including in an error or in telemetry.

## 7. Hypotheses discarded or reclassified

### 7.1 `not_resurfaced` in `fef6...`

This case proves neither a false close nor an improper reopening:

- the items belonged to Perplexity;
- the sources declared custody of an attachment;
- the long code quotes did not exist in that attachment;
- citations by Gemini or Grok could not automatically close another owner's
  items.

The external report of "five peers READY with valid citations and
not_resurfaced items" still deserves a replay, but it requires the exact ID of
the reported session. It must not be attributed to `fef6...`.

### 7.2 Accounting

No accounting bug was found:

- `fef6...`: USD 3.475978295 with no double-counting;
- `1ce5...`: USD 5.39668585;
- interrupted calls with no confirmation stay `unknown/unpriced`, not an
  invented zero cost.

### 7.3 Provider terminations

DeepSeek's `finish_reason=length` and Perplexity timeouts are non-retryable under
the project's current documented policy. They may justify product evolution, but
the corpus did not prove a violation of the provider contract.

### 7.4 Earlier polling problems

The classes previously reported about:

- an excessively detailed `session_poll`;
- Markdown requested but the response serialized as JSON;
- a cancellation losing the race with an already-finished job;

were already fixed in the current source. They were not reclassified as
4.5.23–4.5.27 regressions in this audit.

## 8. Central configuration and costs

### 8.1 Desired state

The central configuration must keep:

```json
{
  "models": {
    "claude": "claude-fable-5"
  },
  "model_fallbacks": null,
  "model_cost_rates": {
    "claude": {
      "claude-opus-5": {
        "input_per_million": 5,
        "output_per_million": 25,
        "cache_read_per_million": 0.5,
        "cache_write_per_million": 10
      }
    }
  }
}
```

Fable 5 therefore stays active and Opus 5 is ready for an explicit future
selection, with no silent fallback.

### 8.2 New Evidence Broker keys

The 4.5.28 schema accepts:

```json
{
  "evidence_broker": {
    "max_requests_per_peer_round": 8,
    "max_requests_per_round": 24,
    "max_items_per_session": 64,
    "max_chars_per_session": 64000
  }
}
```

In the absence of those keys, the same values are the runtime's defaults. The
four keys were included explicitly in the central configuration and the file was
accepted by the 4.5.28 schema, making the policy visible in the snapshot.

### 8.3 Streaming

The central configuration was changed from 4,096 to 16,384 characters, keeping
1,000 ms and `include_text=false`. The change was accepted by the 4.5.28 schema.
`session_events` pagination further reduces the impact on the read path.

### 8.4 Reload

The runtime loaded during the audit is 4.5.27. The Opus 5 rate card has already
been added to the central configuration on disk, but any hash difference between
file and process requires a window reload for `server_info` to prove the
application. The 4.5.29 publication and the reload are not part of this stage's
evidence.

## 9. Validation matrix

| Area               | Validation                                              | State                                          |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------- |
| Opus 5             | selection as an explicit override                       | PASS                                           |
| Opus 5             | wire with adaptive thinking, effort and 64K             | PASS                                           |
| Opus 5             | absence of unsupported sampling                         | PASS                                           |
| Opus 5             | minimum cache and unbilled pre-output refusal           | PASS                                           |
| Anthropic SDK      | lockfile resolves 0.115.0                               | PASS                                           |
| Lifecycle          | specific durable regression                             | PASS 28/28                                     |
| Lifecycle          | integrated validation after all concurrent changes      | PASS                                           |
| Truthfulness       | future condition versus assertive claim                 | PASS                                           |
| Truthfulness       | integrated validation after concurrent changes          | PASS                                           |
| Checklist IDs      | known IDs trusted and unknown ones blocked              | PASS                                           |
| Grounding          | final diagnostics across both corpora                   | PASS 7/7                                       |
| Evidence Broker    | amplification, atomicity and circuit-breaker regression | PASS                                           |
| `session_events`   | pagination, filter and forensic opt-in                  | PASS                                           |
| Caller tokens      | temporary generation and hardening                      | PASS                                           |
| Caller tokens      | exact DACL and a flow with no pathname TOCTOU           | PASS                                           |
| Supply chain       | `brace-expansion` 5.0.8 and `npm audit`                 | PASS, zero vulnerabilities                     |
| Quality            | formatter, lint, Biome and TypeScript                   | PASS                                           |
| Integrated suite   | complete coverage of the `npm test` targets             | PASS by a single run plus a directed follow-up |
| Final smoke        | `npm run smoke` on the final worktree                   | PASS                                           |
| Packaged runtime   | `npm run runtime-smoke`                                 | PASS                                           |
| External consumer  | `npm run test:consumer`                                 | PASS                                           |
| Independent review | diff audit and Ultrabrain reasoning                     | Complete; two findings fixed                   |
| GitHub Actions     | every workflow on the release SHA                       | Pending at this stage                          |
| npm                | package 4.5.29 published and intact                     | Pending at this stage                          |
| Installed runtime  | `server_info` 4.5.29, matching hashes and reload false  | Depends on install/reload by the operator      |

The first integrated run was interrupted by stale anti-drift metadata in the
documentation and in the smoke itself, not by new product defects. Rather than
restarting the suite on each occurrence, the run continued through the targets
not yet covered. After the fixes, the complete smoke, the packaged runtime and
the external consumer were run against the final state and closed with exit code
zero.

The independent diff audit found two problems before the closing: `VERSION` still
at 4.5.27, and a Windows DACL that did not remove pre-existing explicit ACEs.
Both were fixed and covered by the final validation.

The external gates added two later findings: CodeQL detected the pathname TOCTOU
flow in the caller-token load, and Scorecard detected GHSA-mh99-v99m-4gvg,
disclosed during the release. The first was converted to reading/migration
through a descriptor; the second was fixed with `brace-expansion` 5.0.8 and a
bump to 4.5.29. No alert was suppressed.

## 10. Prioritized action plan

### P0 — close 4.5.29

1. format only the changed files;
2. run the quality gate once;
3. run the full suite once;
4. fix only a concrete failure, with a targeted test, without restarting full
   cycles;
5. submit the final SHA to the independent hardgate;
6. commit and sync directly on `main`;
7. follow every GitHub Action to green;
8. publish `@lcv-ideas-software/cross-review@4.5.29`;
9. after the operator's global install and a reload, confirm via `server_info`:
   version, process date, hashes, `config_load.applied=true`, `parse_error=null`
   and `reload_required=false`.

### P1 — eliminate the cleartext capability risk

Design and migrate to persisted verifiers, per-host secrets and a separate
operator. The migration must include rotation and controlled compatibility,
without logging the old tokens.

### P2 — replay the external `not_resurfaced` report

Obtain the session's exact ID and reproduce:

- each item's owner;
- the quotes and attachment actually cited;
- the `open`, `resurfaced`, `addressed` and `not_resurfaced` transitions;
- the raw and normalized status of the five peers.

Only then decide whether the broker needs a new fix.

### P2 — delta citation fix

Evaluate a per-index repair protocol that preserves valid items and requests a
correction for the invalid item only, staying fail-closed for every ungrounded
decisive claim.

### P2 — retry policy for incomplete termination

Re-evaluate, against each provider's official documentation:

- `response.incomplete`;
- `finish_reason=length`;
- timeouts;
- the attempt limit and the budget.

The policy must not repeat expensive calls without a ceiling, nor reclassify
truncated output as a definitive decision.

### P3 — track the reduction in streaming noise

- keep the central threshold applied at 16,384 characters;
- keep `include_text=false`;
- persist the effective thresholds in the snapshot;
- monitor the `peer.token.delta` percentage after 4.5.29.

### P3 — canonical terminal event

Emit a single terminal disposition for each `round.started`, even though
specialized events keep existing. That simplifies analytics and the detection of
interrupted rounds.

## 11. Conclusion

The audit demonstrated real defects in the published range 4.5.23–4.5.27, with
concrete reproductions in 4.5.25 and 4.5.26 sessions; the local corpus contains
no 4.5.24 or 4.5.27 sessions. The gravest problems were not code rejections by
the peers, but lifecycle failures and evidence amplification able to hold
incorrect state and consume budget.

The set prepared in 4.5.28 and finalized in 4.5.29 addresses the proven causes
without relaxing the anti-deception guarantees:

- it does not accept ungrounded blockers;
- it does not turn unknown IDs into provenance;
- it does not silently truncate an over-long checklist;
- it does not invent a zero cost for an interrupted call;
- it does not allow an implicit model fallback;
- it does not confuse a future instruction with current operational state.

Claude Opus 5 is prepared as an explicit option, with wire, effort, refusal,
cache, SDK and costs aligned with the official documentation. Fable 5 remains
the active model.

The delivery can only be considered complete after the single integrated
validation, the independent hardgate, green GitHub Actions, the npm publication
and proof of runtime 4.5.29 after a reload. The same-SID risk over caller tokens
stays explicitly open as a priority architectural fix, not masked by the ACL
improvement.
