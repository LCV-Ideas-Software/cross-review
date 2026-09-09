# Cross-Review 4.5.x — Field Report

**Date:** 11/07/2026 / 12/07/2026 / 13/07/2026 UTC
**Author:** Claude (caller=claude, host claude-code) — calculadora-app working session
**Context:** the workspace's pre/post-ship hardgate required submitting two calculadora-app ships
(v04.02.00 and the retro-review of v04.02.01, commit `8eee516`) to cross-review. During the run,
the gate **could not record convergence on the 4.5.0–4.5.3 versions exercised in that phase, even
though the substance was approved unanimously by the peers**. This report records every observed
behaviour, correct and defective, for analysis and correction. The 4.5.8 addendum records the
formal convergence that came later.

> **Central finding:** the defects are NOT in the quality of the reviewed work nor in the submitted
> evidence. On 4.5.2 and 4.5.3, the 6 peer models **emitted `"status":"READY"` with
> "No blocking objections remain"** and verbatim citations anchored by `sha256`; the server
> **demoted** them to `NEEDS_EVIDENCE` through anti-hallucination false positives, and then
> **aborted** whole rounds through preflight false positives. In that interval, the gate was unable
> to reach ALL READY for an agent-caller, even with impeccable work and evidence.

---

## 1. Scope and methodology

- **Runtime versions exercised:** 4.5.0, 4.5.2, 4.5.3 (4.5.1 was installed via tarball but the
  in-memory process did not reload in time — not exercised in isolation).
- **Caller:** always `claude`, host `claude-code` (an agent, not a human operator).
- **Mode:** `review` (retro/pre-commit), 6 peers enabled
  (codex/claude/gemini/deepseek/grok/perplexity), relator-lottery active.
- **Diagnostic method:** direct reading of `meta.json`, `agent-runs/round-*-*.json` and
  `events.ndjson` for each session under `~/.cross-review/data/sessions/`; offline execution of the
  installed build's `evidencePreflight`/`truthfulnessPreflight` (`node -e`) against the exact
  drafts; reading the source (`dist/src/core/{orchestrator,status,convergence}.js` and the
  workspace's `src/core/orchestrator.ts`).

### 1.1 Session inventory

| Session (7) | Version | Outcome    | Reason                       | Rounds      | Defect observed              |
| ----------- | ------- | ---------- | ---------------------------- | ----------- | ---------------------------- |
| `306ba203`  | 4.5.0   | aborted    | needs_evidence_preflight     | 1           | DEF-1                        |
| `be550cc3`  | 4.5.0   | aborted    | needs_evidence_preflight     | 1           | DEF-1                        |
| `469d8785`  | 4.5.0   | aborted    | needs_evidence_preflight     | 1           | DEF-1 (incl. RED TDD output) |
| `989d8a2e`  | 4.5.0   | aborted    | needs_evidence_preflight     | 2           | DEF-1, DEF-4                 |
| `7afaf133`  | 4.5.0   | max-rounds | max_rounds_without_unanimity | 4           | DEF-2                        |
| `a37722c8`  | 4.5.2   | max-rounds | max_rounds_without_unanimity | 6           | DEF-5                        |
| `8789eb50`  | 4.5.3   | aborted    | needs_truthfulness_preflight | 1(+relator) | DEF-5, DEF-6                 |

Also observed outside the sessions: DEF-3 (`session_attach_evidence` operator-only) and the
1000-char limit of `escalate_to_operator` (minor).

---

## 2. CORRECT behaviours observed (what works)

For calibration: a great deal works well and should be preserved.

1. **`server_info` / `probe_peers` / capability_snapshot:** accurate and fast. Latencies,
   `auth_present`, `model_selection` with `source_url` and `confidence:"verified"` per peer.
2. **Cost/usage accounting:** per-peer and aggregate, with `cache_read/write`, `reasoning_tokens`,
   `tier_used`, `request_cost` (perplexity), `cost_ceiling_usd` and `budget_warning_emitted`.
   Example: session `8789eb50` cost **USD 0.515** for 4 peers + 1 relator.
3. **Persistence of caller evidence (4.5.1+):** `persistCallerSubmittedEvidence` writes the
   `evidence` field as a session attachment with `sha256` and `integrity_version`, and the round
   inlines it into the peers' prompt. Confirmed: the 4.5.3 peers cited the file by hash
   (`c5083095…dc24da`) and by §-section. **This fixes the 4.5.0 delivery regression (DEF-2).**
4. **Preflight testable offline, for free:** `session_truthfulness_preflight_check` and the exported
   `evidencePreflight` allow iterating on the draft without spending paid rounds — essential and
   well designed.
5. **Relator-lottery / anti-self-review:** `convergence_scope` elects a non-voting `lead_peer`
   (`grok` in `8789eb50`), with an explicit `anti_self_review_exclusion_reason`. Correct.
6. **Identity idempotence:** `identity_forgery_blocked` correctly stops an agent host from declaring
   itself `operator`. The intent is right (see DEF-3 for the side effect).
7. **Durable auto-finalization + escalation:** `escalate_to_operator` writes to
   `operator_escalations[]` in the meta; `convergence_health.state` reflects `blocked`.

---

## 3. Defects observed

### DEF-1 — `evidence_preflight` false positive on inline count/command claims (4.5.0)

- **Symptom:** every round aborted BEFORE any paid call, with
  `Evidence preflight failed before any paid peer call: task/draft claims completed operational
work without value-corresponding evidence: 11 passed, 47 passed[, 1 failed, 2 failed, npm run
biome, git diff]; attach raw matching output inline, via the evidence field, or as session
evidence`.
- **Trigger:** the draft contained phrases such as `47 passed`, `npm run biome`, `git diff` —
  extracted by `extractEvidenceOperationalAssertions` (`orchestrator.ts:1169`) as operational
  assertions, with no corroboration recognized by `extractInlineRawEvidence` (`:1230`).
- **Empirical proof:** running each build's `evidencePreflight` against the **same draft**:
  `4.5.0 → pass:false` (uncorroborated: `["11 passed","47 passed","npm run biome","git diff"]`);
  `4.5.1 → pass:true` ("value-correlated with caller-submitted raw material").
- **Aggravating factor observed:** adding the RED TDD output as evidence (to "show the red before
  the green") turns the phrase `1 failed`/`2 failed` into a failure signal
  (`evidenceHasExplicitFailureSignal`, `:1267`) and **invalidates every count corroboration** —
  counter-intuitive for anyone documenting TDD honestly.
- **Root cause:** a corroboration heuristic far too sensitive to narrative text; 4.5.0 did not
  recognize ``` blocks with `$ cmd`/`EXIT_CODE:` that 4.5.1 began to recognize.
- **Status:** **fixed in 4.5.1** (delivering the evidence to the peer is DEF-2).
- **Severity:** high (total block) — resolved.

### DEF-2 — the `evidence` field was not delivered to peers in `session_start_round`/`ask_peers` (4.5.0)

- **Symptom:** in session `7afaf133`, with the evidence in the `evidence` field (via
  `session_start_unanimous`), the preflight passed but all 4 rounds returned `NEEDS_EVIDENCE` — the
  `round-1-prompt.md` contained **zero bytes** of the evidence.
- **Root cause:** in 4.5.0, the `session_start_round`/`ask_peers` schemas did not even have an
  `evidence` field; and the pipeline did not inline the caller's evidence into the peer prompt.
- **Status:** **fixed in 4.5.1+** (`persistCallerSubmittedEvidence` — see §2.3).
- **Severity:** high — resolved.

### DEF-3 — `session_attach_evidence` is operator-only → unreachable for an agent-caller (4.5.0+)

- **Symptom:** `session_attach_evidence(caller:'claude')` →
  `operator_authority_required: ...may only be called by the human operator`; and
  `caller:'operator'` from an agent host → `identity_forgery_blocked: clientInfo.name='claude-code'
resolves to claude`.
- **Effect:** an agent-caller has NO route to an "operator-verified attachment"; it depends entirely
  on the inline `evidence` being accepted by the preflights. When those have false positives
  (DEF-1/4/5/6), the agent has no escape.
- **Recommendation:** keep the forgery block, but provide first-class evidence custody for an
  agent-caller authenticated by token (`CROSS_REVIEW_CALLER_TOKEN` already exists and is
  `hard_enforce:true`), treating an authenticated `caller_submitted` as sufficient for READY when
  the peer corroborates it.
- **Severity:** medium (architectural).

### DEF-4 — `truthfulness_preflight` confuses third-party IDs/dates with system state (4.5.0)

- **Symptom (session `989d8a2e`, 1st attempt):**
  `current-state model claim gemini-3.5-flash for gemini contradicts model_pin
gemini-3.1-pro-preview; current-state release_date claim 2026-10-16 contradicts runtime
release_date 2026-07-10; ...2026-05-19...`.
- **Trigger:** the draft mentioned the **application's migrated model** (`gemini-3.5-flash`) and
  deprecation dates (`2026-10-16`). The scanner crossed those tokens with the `model_pin` of the
  **server's own gemini peer** (`gemini-3.1-pro-preview`) and with the runtime `release_date` — two
  distinct universes (the app's model ≠ the peer's model).
- **Workaround found:** keep model IDs and ISO dates out of lines matching
  `CURRENT_STATE_CLAIM_PATTERN` (`orchestrator.js:1141`:
  `current|currently|actual|atual|runtime|production|prod|loaded|carregad[ao]|is/are running`).
  Rewording the lines let the same content pass.
- **Root cause:** the preflight does not distinguish "a claim about the system under review" from "a
  citation about a third-party product". Model/date token correlation is global to the line.
- **Severity:** high (total block, avoidable only by anti-idiomatic rewriting).

### DEF-5 — READY→NEEDS_EVIDENCE demotion by the grounding check (4.5.2 and 4.5.3) ⚠️ **principal**

- **Symptom:** the peers emit `"status":"READY"` in the raw text, and the server demotes them to
  `NEEDS_EVIDENCE`, with `decision_quality:"format_warning"`.
- **Raw data (the `text` field vs the post-parser `status`):**

  | Session            | Peer       | raw `text` | final `status` | `parser_warnings`                                                                  |
  | ------------------ | ---------- | ---------- | -------------- | ---------------------------------------------------------------------------------- |
  | `a37722c8` (4.5.2) | deepseek   | READY      | NEEDS_EVIDENCE | `verified_without_concrete_evidence_sources`, `ready_downgraded_to_needs_evidence` |
  | `a37722c8` (4.5.2) | gemini     | READY      | NEEDS_EVIDENCE | same                                                                               |
  | `a37722c8` (4.5.2) | grok       | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_fabricated`                                                |
  | `a37722c8` (4.5.2) | perplexity | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_fabricated`                                                |
  | `8789eb50` (4.5.3) | codex      | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |
  | `8789eb50` (4.5.3) | gemini     | READY      | NEEDS_EVIDENCE | `verified_without_concrete_evidence_sources`, `ready_downgraded_to_needs_evidence` |
  | `8789eb50` (4.5.3) | deepseek   | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |
  | `8789eb50` (4.5.3) | perplexity | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |

- **Key contradiction:** those votes' `evidence_sources` **are** concrete and traceable. Example
  (perplexity, `8789eb50`): they cite `evidence/...-caller-structured-evidence-...txt
(sha256=c5083095…dc24da)` and transcribe §2–§8 verbatim (numbered INSERTs, the D1 `typeof`, test
  output, the smoke's HTTP 200). Even so the grounding check classified them as
  `ungrounded`/`fabricated`.
- **Code pointers (dist 4.5.3):**
  - `core/orchestrator.js:659-667` — decides the warning:
    `ready_peer_submitted_evidence_requires_path_hash_and_correlated_raw_quote` →
    `ready_evidence_sources_fabricated` → `ready_evidence_sources_missing` →
    `ready_evidence_sources_ungrounded`, and forces `status:"NEEDS_EVIDENCE"`.
  - `core/status.js:334-355` — `isConcreteEvidenceSource` + the
    `ready_downgraded_to_needs_evidence` / `verified_without_concrete_evidence_sources` demotion.
- **Likely root cause:** the "correlated raw quote / path+hash" matcher does not recognize the
  citation format the peers themselves produce (a reference to the file by `sha256` + a §-section
  citation), OR it requires a literal quote format the prompt does not instruct the peers to emit.
  Result: a peer that does exactly what was asked ("cite verbatim") is punished as if it had
  fabricated.
- **Severity:** **critical** — this is what prevents convergence even with real unanimous approval.

### DEF-6 — `truthfulness_preflight` aborts round 2 on a verbatim third-party doc citation (4.5.3)

- **Symptom (session `8789eb50`, round 2 / relator revision):** the 4 peers recorded in
  `failed_attempts` with
  `Truthfulness preflight failed on lead-generated revision before reviewer peer calls: current
operational-state claim lacks a correlated raw status record: GA (§5): "generally available (GA),
stable, and ready for scaled production use." ... preflight_issue_classes:
["unsupported_current_state_claim"]`.
- **Trigger:** the **verbatim citation of Google's doc** (which the round-1 peers DEMANDED: "cite
  evidence verbatim") contains `GA`, `stable`, `production` — `production`/`prod` match
  `CURRENT_STATE_CLAIM_PATTERN` (`orchestrator.js:1141`) and the line is treated as a current-state
  claim about the **system under review**, requiring a "raw status record" that a doc citation does
  not have.
- **Catch-22:** the citation layer (DEF-5) demands verbatim; the truthfulness layer (DEF-6) aborts
  the session precisely because of the verbatim. No draft satisfies both.
- **Pointers:** `orchestrator.js:1322` and `:1361` (`unsupported_current_state_claim`); pattern at
  `:1141`.
- **Root cause:** identical to DEF-4 — the absence of a distinction between "a citation attributed
  to an external source" and "a self-claim by the system". The round-2 input is generated by the
  relator, so the abort kills the whole session even though round 1 had already collected READY
  votes.
- **Severity:** **critical**.

### DEF-7 (minor) — collateral operational effects

- **Auto-finalization on a preflight abort:** each abort sets `outcome:"aborted"` and the session
  becomes `session_already_finalized`; every retry requires a new `session_init` (there is no "fix
  and resubmit" within the same session). High friction while iterating.
- **`escalate_to_operator.reason` ≤ 1000 chars:** it truncated the first escalation attempt (error
  message `too_big`). Consider 4000 (parity with `review_focus`).
- **Process noise:** ~10 `server.js` instances from distinct hosts in memory; none reloads the
  on-disk config without a host restart (`live_reload_supported:false`). Document that the gate
  depends on a per-host Reload Window.

---

## 3.5. 4.5.5 addendum (12/07/2026) — post-fix retest and residual defects

Retested with two sessions on 4.5.5 (`04691dd6` via unanimous loop; `741b69bc` via a controlled
single round, with no relator between rounds). **Real, measurable progress**, but still no
convergence.

### What 4.5.4/4.5.5 demonstrably fixed

- **DEF-5 partially:** READY votes now SURVIVE the parser when 100% of the cited quotes are exact
  (or whitespace-normalized) substrings of the attachment. Proof: deepseek (2 sessions) and
  perplexity (`741b69bc`) kept `raw:READY → final:READY`, `parser_warnings: []`.
- **DEF-6 partially:** the verbatim citation of Google's docs in the evidence (§5) **no longer
  aborted** round 1 — attributed docs stopped being treated as a runtime claim in the caller's
  input.
- **New transparency (excellent):** `raw_status`/`parsed_status`/`normalized_status` are persisted
  per peer — the demotion is now first-class auditable, without reading the raw `text`.

### Residual defects observed on 4.5.5

**DEF-8 — all-or-nothing citation validation + no quote unescaping (new, dominant cause).** A SINGLE
imperfect item in `evidence_sources` voids the entire READY vote
(`ready_evidence_sources_ungrounded`). Measured in session `741b69bc`: gemini 3 items/1 bad →
demoted; grok **15 items/2 bad** (13 perfectly verbatim!) → demoted. And the bad items share one
pattern: they are the §5 quotes (Gemini docs) that **contain internal quotation marks** — the peers
serialize them with `\"` escaped in the JSON, the validator compares without unescaping → it never
matches. Suggested fixes: (a) unescape `\"`→`"` (and normalize typographic quotes) before the
correlation; (b) a proportional policy — the vote falls only if the MAJORITY of items is
uncorrelatable, discarding bad items individually (or at least reporting them by index so the peer
can fix them in the next round).

**DEF-6 residual — relator-generated text still triggers truthfulness.** In session `04691dd6`
(unanimous loop), round 2 aborted with `current-state model claim gemini-3.5 for gemini contradicts
model_pin gemini-3.1-pro-preview` — the REVISION generated by the relator (lead peer) mentioned the
application's model in a sentence carrying a current-state word. Relator text does not go through
the sanitization the caller can apply to its own draft; while the scanner does not distinguish "the
model of the application under review" from "the peer's model_pin", unanimous-loop mode is unusable
for any review involving the application's Gemini models. Validated workaround:
`session_start_round` (the caller controls 100% of the text between rounds).

**DEF-9 — codex `provider_error: response.incomplete` (transient).** Session `04691dd6`:
`openai responses terminal state rejected for gpt-5.6-sol: event=response.incomplete. Partial,
truncated, filtered, or unterminated output is not a usable response.` — reasoning effort `max` +
`max_output_tokens 20000` truncated it. The peer was rejected with no retry in the same round.
Suggestion: automatic 1× retry on the same model for this class (workspace policy: never
downgrade).

### Merit result of the last session (`741b69bc`, round 1)

| Peer       | raw           | final          | Note                                   |
| ---------- | ------------- | -------------- | -------------------------------------- |
| deepseek   | READY         | **READY**      | citations 100% verbatim                |
| perplexity | READY         | **READY**      | citations 100% verbatim                |
| gemini     | READY         | NEEDS_EVIDENCE | 1/3 items with `\"` (DEF-8)            |
| grok       | READY         | NEEDS_EVIDENCE | 2/15 items with `\"` (DEF-8)           |
| codex      | **NOT_READY** | NOT_READY      | **well-founded merit finding** (below) |

**Codex's finding (well founded, becomes a patch on the calculadora):** the retention DELETE for
`ai_usage_logs` (oraculo.ts:93) sits inside the fire-and-forget `logAiUsage` (a non-awaited IIFE,
not registered in `context.waitUntil`), unlike the observability prune (which does use
`waitUntil`). On Workers/Pages, non-awaited work after the response has no execution guarantee — so
retention is best-effort. Requested fix: return the insert+prune Promise and register it in
`context.waitUntil` (or await it explicitly). The first real merit finding of the whole journey —
and it only emerged once the byte-for-byte citation instruction freed the peers to focus on
substance. Note: 4 of the 5 voting peers approved the merit; the official convergence verdict stays
blocked by the defects above.

---

## 3.6. Closing prepared for 4.5.6 (12/07/2026)

The remediation preserves the sessions above as historical evidence and opened no new paid round.
The three residual defects received offline regressions:

- **DEF-8:** one controlled JSON escape layer is deserialized before the correlation. The
  all-or-nothing policy was kept for safety; the proposal to accept a majority of sources was
  rejected. Later matching stays literal in case and whitespace, and removed code does not ground a
  READY even when quoted with the diff's `-` marker.
- **DEF-6 residual:** only claims explicitly bound to cross-review/MCP, `server_info`,
  `runtime_capabilities` or `model_pin` are compared against the local pins. A "reviewer" or "peer
  model" of the application under review does not automatically belong to the server's namespace.
- **DEF-9:** GPT-5.6 Sol may perform exactly one recovery on the same model, prompt and ceiling,
  reducing `high`/`xhigh`/`max` to `medium`; the truncated attempt's usage and cost stay in the
  ledger. Safety/content filter and an already low/medium effort remain fail-closed with no retry.

The independent review of the diff found, and the same battery also covers: the official
distinction between Gemini `promptFeedback.blockReason` (input) and `Candidate.finishReason=SAFETY`
(output), a per-peer budget compatible with patch consumers, a valid status envelope above 64 KiB,
provisional/commit/discard streaming per attempt, and pricing of the model actually called in
adapters and fallbacks. The final audit round added: a block on generic self-referential READY, the
complete call graph in the hardgate, fail-closed handling of Sonar Deep Research with no official
ceiling, and preservation of billing/errors/refusals across the six adapters' official terminals.
The forensic report of 12/07/2026 contains the official matrix and the 36-hour audit.

---

## 3.7. 4.5.8 outcome (12/07/2026) — formal convergence reached

Clean session `4ed963d4` (single round, `session_start_round`): **outcome `converged |
unanimous_ready` — caller + 5 peers READY raw+final, zero warnings, empty checklist.** Codex's
finding (round 1 of session `741b69bc`) was fixed with TDD and shipped as calculadora v04.02.02.
The recipe that produced the convergence: a byte-exact citation package attached from round 1
(excerpts with no internal quotation marks, the workaround used in that session), an explicit
citation contract in the draft and in the review_focus, `session_start_round` (no relator), and
abandoning sessions contaminated by generic asks.

State correction after confronting the 4.5.8 source:

- **DEF-8:** fixed since 4.5.6 by controlled unescaping before the correlation; the all-or-nothing
  policy stays deliberately fail-closed.
- **DEF-6 residual:** fixed since 4.5.6 by separating the reviewed application's namespace from the
  explicit cross-review/MCP/runtime namespace.
- **DEF-9:** fixed since 4.5.6 by a controlled recovery of
  `response.incomplete/max_output_tokens` on the same GPT-5.6 Sol, with `medium` effort and the
  ledger preserved.
- **DEF-10 (new, confirmed):** generic remediations created by the server itself were mixed into the
  peers' `caller_requests`. With no derived anchor, they could not be closed by requester
  reverification and blocked convergence when an active judge or the operator was unavailable. The
  fix was prepared for 4.5.9, keeping remediation in
  `decision_transformations[].details.remediation` and reserving `caller_requests` for the peers'
  real requests.

## 3.8. Closing prepared for 4.5.9 (12/07/2026)

DEF-10 received red/green regressions for the parser's five READY demotions and for the grounding
demotion. The fix does not change `hasAskDerivedAnchor`, does not auto-close genuine generic asks
and does not weaken the all-or-nothing policy: authentic peer requests stay persisted and blocking;
only server-produced guidance stops entering the checklist as though the peer had authored it.

The historical sweep found 54 synthetic items across 19 sessions: 40 `open` and 14
`not_resurfaced`. Four still-active sessions held 11 items. When resuming an active session, 4.5.9
removes only the item whose synthetic origin is proven by the raw READY vote without that ask and
by the matching warning in the very round that created the item; a later synthetic collision cannot
erase an earlier genuine request. The fix records a durable reclassification and does not alter
terminal sessions. Demonstrably contaminated old sessions therefore stop requiring manual
intervention, without real requests being satisfied by inference.

## 3.9. DEF-11 — independent propagation of the npm attestation (4.5.9 → 4.5.10)

Publication run `29209138113` proved that package 4.5.9 was published correctly on npmjs.com by
Trusted Publishing/OIDC, with provenance, but the post-publication gate produced a false negative.
`npm publish` finished at `21:13:01Z`; the version appeared in the public metadata at `21:13:11Z`;
roughly 0.4 seconds later, the URL already announced in `dist.attestations.url` still answered
`HTTP 404`. The verifier aborted on the first error. Later, with no new publication, the same URL
answered `200` with SLSA provenance v1. The idempotent rerun detected the existing version, did not
republish the package, verified the attestation and closed the run and the GitHub Release green.

The [official provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
and the [official npm/Pacote implementation](https://github.com/npm/pacote/blob/3b5c462a96326fe7c88dc46312122ea720194179/lib/registry.js#L228-L239)
confirm that the consumer must follow the attestation URL announced by the metadata; Pacote uses
its pathname re-anchored to the registry host. The internal literal path is not documented as a
stable public contract. 4.5.10 removes that assumption and adds a bounded retry for `404`,
network/timeout errors, rate limiting, transient HTTP failures, incomplete JSON and a document
whose SLSA predicate has not propagated yet. Permanent errors, structurally invalid metadata and a
persistent absence of SLSA provenance v1 still fail closed. Behavioural regressions reproduce the
sequences visible metadata → first lookup 404/incomplete JSON/missing predicate → second lookup 200
with SLSA.

The adaptation does not blindly copy the `new URL(pathname, registry)` construction: a pathname
starting with `//` would be reinterpreted by WHATWG semantics as a protocol-relative host. The URL
is created already anchored to the registry, receives the pathname by assignment, has its origin
reasserted and uses `redirect: "error"`. The regression includes the pathname
`//attacker.invalid/...` and requires the fetch to stay on the npm registry without following
redirects.

This verifier proves the SLSA predicate is present in the metadata and in the published document;
it is not presented as an independent cryptographic verification of the subject's signature, PURL
or digest.

## 3.10. DEF-12 — the MCP contract led an agent to request a human upload (4.5.10 → 4.5.11)

Session `86f41fbd-fe75-4cd4-a7bb-436f813294e9` reproduced an operationally wrong interpretation
that was nonetheless reasonable given the exposed schema. An authenticated Codex created the
session and twice called the tool generically presented as `Attach Evidence`. The runtime validated
its identity and rejected `session_attach_evidence` with `operator_authority_required`, because
that surface promotes evidence to the operator's optional authority. The restriction has existed
since 4.5.0; it was not introduced by 4.5.10.

Autonomous transport was not broken. Right afterwards, the same host used the `evidence` field in
`run_until_unanimous`. Sessions `ec55558d-a11b-46a8-bce9-31394d299c16` and
`5e076838-7e9c-4ff2-9933-147ee5855d2e` persisted, respectively, 41,417 and 40,751 bytes in physical
files, with SHA-256, `submitted_by=codex`, an active manifest and the events
`session.evidence_attached`/`session.caller_evidence_submission_activated`. All four preflights
passed. The rounds did not call reviewers because the budget preflight estimated
USD 34.10/USD 34.07, above the USD 20 limit (and a USD 5 session limit); the block was neither
evidence nor authorization.

The real defect was one of discovery and contract: the privileged tool's runtime description did
not say `operator-only`, its schema accepted the peers' identifiers, and the `evidence` field
descriptions did not announce their automatic persistence. That led the agent to pick the wrong
surface, make two useless calls and conclude it needed the human.

4.5.11 keeps `operator_verified` out of any model host but makes the correct path unambiguous.
`session_attach_evidence` is presented as an optional authority promotion; the four review starters
declare that `evidence` is persisted automatically as `caller_submitted_unverified`; and a wrong
call redirects the agent to those fields, saying explicitly that no human action is required. The
runtime smoke lists the MCP schemas and covers both the descriptions and the rejection's
remediation.

## 3.11. DEF-13 — the Evidence Broker kept satisfied asks in `not_resurfaced` (4.5.11 → 4.5.12)

Session `b5a73952-8236-4cdf-8e34-880624f663f4` confirmed a deterministic defect in the Evidence
Broker's correlator. DeepSeek opened two requests in round 2. Both moved from `open` to
`not_resurfaced` in round 3. In rounds 4, 6 and 7, Claude, Gemini, DeepSeek, Grok and Perplexity
returned `READY/verified`, with no warnings; path, SHA-256 and quotes were validated byte by byte.
Even so, the rounds stayed blocked by the same two items. The session consumed seven rounds,
241,207 tokens and an estimated configured cost of USD 1.4204596.

The correlator turned natural language into an incorrect conjunction. In the first request,
"file/line **or** git diff" also demanded the expression `git diff`; in the second, the
abbreviation `e.g.` was extracted as though it were a mandatory file path. Beyond that, although
the documentation said `Checklist-Item` routes the recheck, the implementation merged all of the
peer's sources into a single corpus and did not use the ID. That created false negatives and a
symmetric risk of one source closing another item by the same author.

The immediately following session `a78aa17c-93f6-4825-89f9-b8abe1ec76d8` reproduced the class in
more real language: `diff/grep`, release documents with no extension, Portuguese terms about
injection/validation and secret redaction, plus a numbered enumeration from Perplexity. Five items
stayed `not_resurfaced`; in round 3, all five peers were READY, but the broker kept blocking. The
analysis also distinguished genuinely proven asks from narrative claims: READY and an ID are not
enough if the quoted bytes are irrelevant, partial, or merely assert that an earlier round would
have proven something.

4.5.12 fixes the cycle without loosening the anti-deception mechanism:

- `ask_peers`/`session_start_round` now automatically inject every pending ID;
- when the sources carry IDs, each item uses only the sources bearing its own ID;
- `e.g.`/`i.e.`, line/diff and diff/grep alternatives and list markers are handled according to
  their syntactic role, not as mandatory proof;
- bilingual concepts and explicitly requested documents must appear in the evidence;
- an ID with an irrelevant file:line/test, a partial document, a command that is only documented, or
  an explicitly incomplete conjunction all stay blocked;
- an offline E2E regression walks five READY votes, a real attachment, path, SHA-256, a literal
  quote, `requester_reverified`, a durable event and convergence out of `not_resurfaced`.

While that E2E was being created, two initial fixture versions used `stub=false`, but `askPeers`
recreated adapters internally and ignored the substitution made in the constructor. That produced
two unintended real rounds, ten calls, 65,501 tokens and an external cost estimated at about
USD 1.06; the fixture's zero rate card left the local ledger incorrectly at USD 0. The final seam
is injected at every creation point, is accepted only with a confirmed stub/test, rejects
`stub=false` before probes/calls, and verifies exactly five local calls, zero Codex calls and zero
retries.

## 3.12. DEF-14 — ReDoS recurrence and publication before the findings were read (4.5.12 → 4.5.13)

4.5.12's CodeQL opened alert 39 in `src/core/session-store.ts`, in the camelCase matcher used to
correlate symbols requested by the Evidence Broker. The outer repetition accepted the same `A` as
the inner repetition, allowing exponential partitions of a long sequence. The `js/redos` class was
the same as alert 31, fixed in 4.5.3 in the Git options matcher; so this is not a novel class, but
a methodological recurrence.

The problem reached npm because `auto-tag.yml` waited only for the functional CI. The CodeQL
workflow can finish with `success` after uploading findings, and the automation confused
upload/analysis success with an absence of vulnerabilities. Tag `v04.05.12` and the publish
happened before the explicit audit of the alert set.

4.5.13 replaces the matcher with a linear identifier scan and an explicit uppercase filter, with an
adversarial regression of 100,000 characters. It also makes publication fail-closed: auto-tag waits
for the `push` CodeQL of the exact SHA that passed CI and queries the default branch's real alerts.
A missing, incomplete or failed CodeQL, or any open alert, prevents the tag and the publication.
The moving-ref query is fenced by SHA checks before and after; the tag explicitly names the
immutable SHA whose CI, processed analyses and alert-free snapshot passed. A policy regression
verifies permissions, the wait, the endpoint, the ref bracket and the tag's exact identity.

On the first auto-tag run for commit `e698801`, the gate blocked publication before the tag because
the `gh --jq` filter omitted the `|` operator between the array iteration and the object
projection. The log recorded `expected an object but got: array`; no 4.5.13 publication occurred.
The filter was fixed and the regression now explicitly requires the object projection, the SHA grep
and the three comparisons that bind analysis and alert to `VERIFIED_SHA`.

## 3.13. DEF-15 — loss of continuity and Evidence Broker divergence (4.5.13 → 4.5.14)

Session `39cb7669-99c3-4ecd-a635-95103c105390`, run on runtime 4.5.13, finished its sixth round
with Claude, Gemini, DeepSeek, Grok and Perplexity at `raw_status=READY`, `parsed_status=READY`,
`normalized_status=READY`, `decision_quality=clean`, `confidence=verified` and with no
`caller_requests` or `follow_ups`. Even so, the formal result stayed blocked by 18
`not_resurfaced` items. The convergence object placed DeepSeek, Grok and Perplexity simultaneously
in `ready_peers` and `needs_evidence_peers`.

The audit of the six rounds showed that the final unanimity, on its own, did not prove the 18
items. Round 6's active attachment held only 476 bytes and two summary lines; the diffs,
transcripts and specific tests were in earlier submissions, including files of 36,467 and 30,886
bytes. The peers received only the active snapshot. The blobs remained durable on disk and in the
manifest, but the 4.5.13 broker did not re-evaluate the READY responses from the round that had
actually received them once the correlator was fixed. Demanding a new manual upload would recreate
the product failure already rejected in DEF-12; reinserting every blob into the current prompt, on
the other hand, would allow stale borrowing and would raise the APIs' cost again.

Four additional defects amplified the cycle:

- the preflight recognized `git diff --check`, but not the equivalent identity
  `git -C astrologo-app diff --check`; the empty output was not the cause, since the record already
  contained `EXIT_CODE: 0` and `STDOUT: <empty>`;
- a single source carrying any known ID made the router discard every separate generic source when
  evaluating the peer's remaining items;
- deduplication by a hash of `peer + full text` turned requests beginning with
  `Checklist-Item: <id>` into new IDs. The 19 entries were mainly re-presentations of four proof
  groups;
- the round was persisted before aggregation, address detection and the judge. The
  `finalConvergence` computed afterwards was not written back, allowing divergence between the
  response, `rounds[-1].convergence` and `convergence_health`.

The external report's recommendation to automatically close every old request when the peer returns
READY was deliberately rejected. A lazy Claude could abandon its own request without checking the
bytes. In 4.5.14, `open` and `not_resurfaced` remain blocking; silence, a generic READY and a bare
ID still do not prove satisfaction.

The 4.5.14 source fixes continuity without weakening the anti-deception mechanisms:

- the active snapshot remains the only source for the current round's preflight, prompt and
  grounding. When resuming a session, the broker may locally reprocess a historical
  `clean/verified` READY against the path, SHA-256 and literal quote of that response's snapshot.
  The old bytes do not return to the prompt, do not authorize a new claim, and the replay makes no
  provider call;
- sources with no ID stay eligible for another item's strict correlation, while sources explicitly
  routed to someone else's ID stay excluded;
- only a strict "same item" reference, from the same peer and to an older ancestor, resurfaces or
  collapses the ancestor. Cross-peer references, cycles and an ID followed by a new demand remain
  first-class and blocking. Safe repairs of 4.5.13 sessions record
  `evidence_checklist_alias_collapses` plus an audit event;
- the command matcher compares the Git identity after the global options.
  `git -C <dir> diff --check` with a zero exit and explicitly empty streams passes; a missing or
  non-zero exit, `diff --stat`, a bare `echo`, `|| true`, `&&` and pipelines still fail. `--check`
  after the `--` terminator is a pathspec, not an option; `--no-index`, refs and narrowed pathspecs
  also do not prove the global claim;
- `ready_peers` and `needs_evidence_peers` become disjoint in the formal state, without erasing the
  raw vote; the prompt requires the owner to bind each withdrawal to its ID and to a matching
  literal source;
- `in_flight` stores the journaled checklist/history snapshot from before the round and is acquired
  before any repair, evidence or preflight; recovery, a stale sweep or a cancellation without an
  append restores that baseline and records a compensating event. `appendRound` reapplies the gate
  under the same write lock and holds the reservation until converged finalization. Its result is
  the authority for round, health, response and outcome, eliminating the first implementation's
  crash, pre-round concurrency and append-to-finalize gaps.

The offline regressions reproduce the session's real command and its negatives, mixed ID/generic
sources, safe/cross-peer/cyclic aliases, local replay after a restart without reinjecting blobs,
isolation of the current snapshot, disjunction of the derived sets and equality of the blocked or
promoted state after serializing and reading the session back. No wire schema of the six APIs, no
model, no rate card and no central configuration key had to change for this fix.

The final dependency-maintenance audit found four real ecosystems in the repository: npm, GitHub
Actions, the pip/pip-compile lock used by Socket, and the pre-commit hooks. The 4.5.14 Dependabot
configuration covers all four, authenticates the StepSecurity proxy already declared as the global
registry in `.npmrc`, and removes `day` from the `daily` schedules (the key is weekly per the
official contract). The first remote run showed that combining that `.npmrc` with
`replaces-base: true` also redirected npm's own bootstrap through Corepack; the proxy answered
without `dist.tarball` and aborted before dependency resolution. Omitting `replaces-base` was not
enough: the second run showed that Dependabot's own
`enable-private-registry-for-corepack` experiment still redirected the CLI when it found
`packageManager: npm@12.0.1`. The final configuration keeps `.npmrc` and the StepSecurity
credential for resolving dependencies but removes only the Corepack hint from the manifest.
Dependabot uses the built-in/documented npm 11.17; CI and Publish still download npm 12.0.1
directly, validating the SHA-512 before executing it. CI installs the Python lock with hashes under
the 3.12 pin and runs the real pre-commit hooks. That same first remote analysis opened CodeQL
alert 40 on the registry URL's textual regression; the unanchored expression was removed in favour
of a literal comparison, while the YAML parser stays responsible for the structural association,
with no dismissal or suppression.

That activation opened twelve maintenance PRs in parallel. Nine were validated and merged
automatically; PRs 112 and 116 had every content check green, but the automerge job ended red
because another PR changed the base between the read and the merge. The workflow now retries only
the transient `Base branch was modified` response, always with `--match-head-commit` on the same
already-validated SHA. PR 113 demonstrated a second gap: without
`socketsecurity-requirements.in`, Dependabot moved the direct pin to 2.4.20 but did not recompile
the new transitive `brotli>=1.0.9`; `--require-hashes` correctly aborted. 4.5.14 includes the
`.in`/`.txt` pair, groups compatible Python updates and recompiles the full closure with
pip-compile 7.5.3/Python 3.12. The npm 12 + SHA-512 pin stays under its own regression: Dependabot's
official documentation enumerates only npm 7–11, so no undocumented coverage is attributed to the
bot.

A dry-run of the final 4.5.14 logic over a complete copy of session 39cb, with no API calls and
without altering the original records, collapsed and promoted nothing. The old reformulations
carried cross-peer authorship or additional demands and were therefore not safe strict aliases.
That corrects an overreaching conclusion in the external report: the set overlap and the
transport/correlation false negatives were bugs, but round 6's two generic lines and round 5's
citations did not strictly satisfy each request for diffs, commands and tests. 4.5.14 does not
falsify retroactive convergence. A new round can receive evidence through the caller's automatic
channel, with no human upload; each ask closes only with genuinely correlated proof.

## 3.14. Release closing — protected tag 4.5.14 and target 4.5.15

Auto-tag created `v04.05.14` on SHA `1553c1af` while the final Dependabot audit was still
finishing. Publish was cancelled during the gate's install, before npmjs.com, GitHub Packages or
GitHub Release; the npm query returned 404 for 4.5.14. The immutable tag rule refused the deletion,
correctly. The publishable target therefore moved to 4.5.15, without moving or overwriting the old
tag.

The final fix removes only the `packageManager` hint from the manifest. Dependabot stops trying to
activate npm 12 through Corepack/StepSecurity and uses the documented npm 11 from its image; CI and
Publish remain responsible for npm 12.0.1, downloaded directly and checked against the fixed
SHA-512. No model, wire schema, rate card or central configuration key changed in this closing.
Auto-tag also began detecting changes to `dependabot.yml` and waiting for the four dynamic updater
jobs of the same SHA; a missing, pending or red result blocks the tag. That eliminates the race
that once created tag 4.5.14 before the npm updater's failure became visible.

## 3.15. 4.5.16 addendum (13/07/2026) — excessive polling, Markdown and late cancellation

**Session observed:** `50e68ea8-8da3-4132-99b4-552a0399b72a`

**Runtime:** `4.5.15`

**UTC window:** 2026-07-13T08:42:07.513Z to 2026-07-13T09:03:07.360Z

**Classification:** three contract/observability defects; no proven provider failure.

### DEF-16A — `session_poll` amplification

While the first round still had no complete history, the poll measured 1,122 characters. After the
first round, it went to 39,373. During the second round, each repeated response was **43,326
characters**; **34,783** of them were the complete `latest_round`, with all five peers, including
14,848 characters of `text` and 14,690 of `structured`. The tool re-transported the previous result
when the caller only needed to follow the active work, which led to truncation on the client
surface.

4.5.16 makes `detail="summary"` the default: it keeps progress, status, verdicts, bounded summaries
and convergence, but excludes the complete `text`, `raw` and `structured`. `detail="full"` and
`session_read` preserve the explicit forensic route. The contract also separates
`active_round_number` — the round currently running — from `latest_completed_round_number` — the
most recent round already appended.

### DEF-16B — `response_format="markdown"` ignored

The JSON poll at 09:01:49.581Z and the poll requested as Markdown at 09:01:57.681Z had the same
43,326 characters and the same SHA-256
`499e628472bc3ca11b767c11b7a4d6854a58b8ee589a59b1470fd291c7fb98af`. Both began with `{` and were
byte-for-byte identical. 4.5.16 applies the shared Markdown renderer to the objects returned by the
MCP surface and neutralizes HTML in strings coming from callers, peers or persistence.

### DEF-16C — a terminal race described as a non-existent job

The last poll still observed round 2 active at 09:02:36.993Z. Perplexity, the last peer, finished
and confirmed the stream at 09:02:56.242Z; the round was recorded as complete at 09:02:56.489Z. The
cancellation was processed at 09:03:07.360Z, **10.871 seconds later**, and answered only
`requested=false / no_running_job_matched`.

That timeline confirms a normal race in which the job finished between the poll and the
cancellation, not concurrency corruption. 4.5.16 persists a compact job status under the session,
reconciles the observation across hosts/restarts and makes the late response idempotent and
informative: `job_already_terminal` includes `terminal_job` and `final_state`;
`session_already_terminal` includes the same compact final state.

### Provider disposition and responsibility for the second round

The five peers of round 2 emitted `peer.token.completed` with `committed=true`: Grok (4,791
characters), Gemini (2,203), DeepSeek (2,314), Claude (3,508) and Perplexity (4,530). There was no
proven failure in the providers' calls or streaming. The second round was started improperly by the
caller; it was not created automatically by cross-review and is not classified as a defect of the
tool.

### Result prepared for 4.5.16

- an operational poll bounded by default, with opt-in forensic detail;
- distinct names for the active round and the last completed round;
- real Markdown and neutralized HTML;
- durable job status across processes and restarts;
- idempotent terminal cancellation with a final state;
- durable ownership published before the dispatch and a settlement reconciled without recreating an
  orphan control;
- a hermetic regression on stubs, with no paid calls and no dependency on the central config.

No model, provider wire schema, rate card or central configuration key changes in this patch.

## 4. Consolidated historical analysis (4.5.0–4.5.3)

The anti-hallucination pipeline had **four layers** in series, each with absolute veto power and,
in that interval, with overlapping false positives:

```
draft+evidence
  → [1] evidence_preflight        (DEF-1: inline count/command)          → abort
  → [2] truthfulness_preflight    (DEF-4/DEF-6: third-party ID/date/GA)  → abort
  → [3] peer call (paid)          → peer votes READY
  → [4] grounding/demotion parser (DEF-5: "ungrounded" citation)         → READY becomes NEEDS_EVIDENCE
```

For an **agent-caller**, layers [1], [2] and [4] fire on perfectly honest and corroborated content,
and layer [4] punishes exactly the citation format that [1] demands. The peers' human
verdict ("No blocking objections remain", unanimous READY) **is never recorded**: either
the session aborts first, or the parser demotes the vote afterwards.

**Historical product impact:** in those first 4.5.x versions, the hardgate stopped acting as a
quality gate on the work and became a conformance gate on the _textual format of the
draft/citation_, in which impeccable work and evidence fail by tripping heuristics. That erodes
trust in the gate and forces anti-idiomatic workarounds (avoid words like "production", do not
paste RED TDD output, do not cite docs verbatim).

---

## 5. Corrections recommended at the time (historical record)

This list preserves the original prioritization and does not represent the current backlog. DEF-1,
DEF-2, DEF-4, DEF-5, DEF-6, DEF-8 and DEF-9 were fixed in later releases. The automatic
authenticated-evidence route also eliminated the need for a manual operator attachment in normal
reviews; the `session_attach_evidence` surface stays operator-only by security design. The new
defects confirmed after the addendum were DEF-10, closed in 4.5.9, and DEF-11 on npm attestation
propagation, closed in 4.5.10, DEF-12 on autonomous transport discovery, closed in 4.5.11, DEF-13
on Evidence Broker convergence, closed in 4.5.12, DEF-14 on the ReDoS recurrence and premature
publication, closed in source 4.5.13, and DEF-15 on Evidence Broker continuity/persistence, closed
in source 4.5.14. DEF-16 on polling/cancellation was reproduced on 4.5.15 and closed in source
4.5.16.

1. **[P0 — DEF-5] Recognize the citation format the prompt itself asks for.** If a READY vote has
   `evidence_sources` that (a) reference an attachment by a `sha256` present in the session AND (b)
   contain substrings matching the attachment's content verbatim, treat it as _grounded_ — never as
   `fabricated`/`ungrounded`. Add a test with the real body of session `8789eb50`.
2. **[P0 — DEF-4/DEF-6] Distinguish an external-source citation from a self-claim.** Clearly
   attributed lines (a URL prefix, "doc:", quotes + a source, a `§` section) should not trip
   `CURRENT_STATE_CLAIM_PATTERN`/`model_pin`/`release_date`. Minimal alternative: cross a peer's
   `model_pin` only when the model token appears WITHOUT citation context and matches the peer's
   alias — never with the model _of the application under review_.
3. **[P1 — DEF-3] Evidence custody for a token-authenticated agent-caller.** With a valid
   `CROSS_REVIEW_CALLER_TOKEN` (`hard_enforce:true`), allow a route equivalent to the operator's
   attachment, so the agent does not depend on the inline preflight alone.
4. **[P1 — architecture] Do not abort the whole session when round 1 has already collected votes.**
   A preflight abort on the relator's revision (round 2) discards valid READY votes from round 1.
   Preserve the state and allow resuming.
5. **[P2 — DEF-1] Soften failure signals in TDD evidence.** RED output explicitly labelled ("before
   the implementation", "expected RED") should not invalidate corroborations of the subsequent green
   counts in the same corpus.
6. **[P2 — DEF-7] `escalate_to_operator.reason` to 4000 chars; document the reload dependency.**

---

## 6. Appendix — raw data keys

- Sessions: `~/.cross-review/data/sessions/{306ba203,be550cc3,469d8785,989d8a2e,7afaf133,a37722c8,8789eb50}/`
- Raw vote vs parser: the `rounds[].peers[].text` field (raw) vs `.status` (post-parser) vs
  `.parser_warnings` / `.decision_quality`.
- Aborts: `meta.failed_attempts[]` (with `preflight_issue_classes`) and `events.ndjson`
  (`session.truthfulness_preflight_failed`, `session.evidence_preflight_failed`,
  `session.finalized`).
- 4.5.3 attachment: `evidence/2026-07-12T01-47-12-165Z-caller-structured-evidence-*.txt`,
  `sha256=c5083095f3a9052ddad81d35be00a315e660c8322fc794dc50827cb649dc24da`, 7906 bytes.
- Cost of session `8789eb50`: USD 0.5148 (codex 0.437 / perplexity 0.031 / gemini 0.016 /
  deepseek 0.007 / relator grok 0.024).
- Source inspected: `dist/src/core/orchestrator.js:{659-667,1141,1322,1361}`,
  `dist/src/core/status.js:{334-355}`, `src/core/orchestrator.ts:{1169,1230,1267,1460,1770}`.

**Factual conclusion for the record:** the retro-review of calculadora-app v04.02.01 (`8eee516`)
received **unanimous merit approval** from the 4 voting peers (codex, gemini, deepseek, perplexity:
all READY, "No blocking objections remain", with corroborated evidence), with the non-voting
relator grok. The official `aborted` outcome reflects server defects (DEF-5/DEF-6), not the peers'
technical verdict.

## 7. Audit continued — 4.5.16/4.5.17 sessions and the 4.5.18 remediation

The complete audit of the sessions after 4.5.16 was published, including the inventory of the five
sessions found, defects DEF-17 through DEF-25, the official revalidation of the six APIs, the TDD
regressions and the 4.5.18 release plan, is recorded in
[2026-07-17-cross-review-4.5.16-4.5.17-session-audit.md](./2026-07-17-cross-review-4.5.16-4.5.17-session-audit.md).

There was no 4.5.17 session in the corpus. The period's only converged session proved operation
with no human upload or finalization; the residual defects were concentrated in veto grounding,
pre-barrier/preflight durability, judge spend and telemetry, and the operational report.
