# Evidence and Truthfulness Preflight

`run_until_unanimous` and `session_start_unanimous` run a **pure textual
evidence preflight** before any paid peer call. It catches the
`f0db3970`-class failure — a submission that _claims_ completed
operational work (tests pass, a diff exists, a build was validated) but
embeds **zero concrete evidence** — and fails it locally with
`needs_evidence_preflight` instead of burning API budget across multiple
`NEEDS_EVIDENCE` rounds.

## Scope boundary (important)

cross-review is an **API-only orchestrator**. The preflight:

- **does NOT** execute shell, run `git diff`, or read the repo;
- **does NOT** invent or gather evidence for you;
- only inspects text the caller already supplied — `task`,
  `initial_draft`, the structured `evidence` field, and
  already-attached evidence.

The runtime packages authenticated caller material for transport: raw inline
blocks and the `evidence` field are persisted with caller identity, SHA-256
and byte count, then included verbatim in reviewer prompts. No manual operator
attachment is required.

Each authenticated external submission is a complete snapshot. Its immutable
manifest becomes the sole active automatic caller-evidence bundle; older
snapshots remain auditable but are excluded from preflight, grounding and the
reviewer prompt. Consequently, corrected evidence is not poisoned by an older
failure, omitted channels do not replay an older success, and old large blobs
cannot crowd the current correction out of the prompt budget.

Evidence _packaging_ (`git diff --stat`, hunks, `git status --short`,
validation-command tails, changed-file lists, target commit) is a
**caller-side responsibility**. Build it into a local agent helper,
prompt workflow, or shared utility — never inside the MCP server.

## How it decides

The preflight first detects completed-work assertions such as
`\d+ passed/failed`, `git diff`, `git status`, `npm run`,
`cargo test|build`, successful builds or green tests. It then requires each
assertion to have value-corresponding evidence: the same test count and
outcome, the same command plus a success signal, or the actual diff/status
form. A filename, hash, generic attachment, code fence, or `trust me` text does
not satisfy that correlation.

Within command records, an explicit non-zero `EXIT_CODE`, a positive failure
count or a failure conclusion takes precedence over words such as `passed` or
`success`. Explicit non-execution in English or Portuguese also fails closed;
modal failure and skipped runs are non-execution too, and an unrelated
`ok`/`green` cannot reverse them. Inline evidence must bind the command and its
result in the same raw line or structured command block. Conflicting executions
of the same command do not prove success.

Mere keyword presence does **not** trip it. "I plan to write a patch"
or "here is the test plan" is a design review with legitimately no diff
— it passes.

Authenticated peer material may satisfy the transport/admission gate when it
contains value-corresponding raw output. It is labeled
`PEER-SUBMITTED / UNVERIFIED`: reviewers may inspect and cite the exact bytes,
but must not claim they independently executed the command. Optional operator
material is labeled `OPERATOR-VERIFIED`; it is a higher authority tier, not a
routine prerequisite for review or convergence.

Integrity does not turn peer text into truth. Operational claims supported only
by `PEER-SUBMITTED / UNVERIFIED` material require at least two independent
non-author reviewers. Each qualifying vote must remain `READY`, use
`confidence="verified"`, and cite the persisted attachment path, SHA-256 and
literal raw lines that value-correlate every assertion. One reviewer,
`confidence="inferred"`, or a copied narrative sentence blocks convergence.
Historical-runtime detection requires an explicit cross-review, MCP,
`server_info`, `runtime_capabilities`, or local-runtime subject. Words such as
`workflow`, `run`, `audit`, and `session` identify when something happened;
they are not by themselves a runtime namespace. Once that explicit runtime
scope exists, the raw material must itself identify the relevant
workflow/run/session start; a suggestive attachment filename or a current
`server_info` snapshot is not temporal provenance. A timestamp elsewhere in
the artifact cannot temporalize a current-only value: timing and value must
occur in the same historically scoped record.

From v4.3.7 onward, that declaration is no longer a blank cheque for
references to separate artifacts. If `task`, `initial_draft`, or the
structured `evidence` text explicitly points to an external evidence/log
artifact such as `wmx4fm04e.output`, `release-evidence.txt`, `events.ndjson`,
`audit.log`, `audit.md`, `changes.diff`, `fix.patch`, or `metrics.csv`, that
artifact's literal content must also be supplied inline, in `evidence`, or as
a session artifact. A bare filename is not proof. Otherwise the preflight
blocks locally with `unattached_evidence_references`.

## Minimum evidence format

To pass the preflight, any authenticated caller may embed the corresponding raw
material in `initial_draft` or `evidence`. Useful material includes:

- a fenced code block with the relevant diff hunk(s) — `@@ -N,M +N,M @@`;
- `file/path.ext:LINE` references for every changed location;
- raw command output (the `$ cmd` line plus its output) for every
  validation you claim — `npm run typecheck`, `cargo test`,
  `git diff --check`, `rg` scans;
- tool-host command records such as `COMMAND: ...`, `EXIT_CODE: ...`,
  `STDOUT: ...`; command and outcome are correlated within the same block;
- content hashes (`sha256`, `md5`) when asserting artifact identity.

This is the same raw material the R1 evidence-upfront contract already expects.
The preflight checks whether it is present and internally corresponding; the
independent panel decides whether peer-submitted material can sustain READY.

### Reviewer citation contract

When a reviewer cites an admitted attachment in `evidence_sources`, each source
is one string with exactly one attachment identity and one correlated literal:

```text
Attachment: evidence/review.txt
sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Artifact quote: "Tests 74 passed (74)"
```

The block shows one decoded string; raw JSON encodes the two line breaks as
`\n`.

Use the persisted path, the complete 64-character lowercase SHA-256, and a
literal of at least 12 characters from that same attachment. `Artifact quote`
is the last line; rationale does not belong after it. For multiple sources,
emit multiple array items rather than concatenating them. The field remains
`string[]` for client compatibility.

The quote should be the smallest sufficient raw excerpt, normally at most 500
characters. The schema permits up to 2,500 characters for the complete item and
30 items only as hard safety ceilings—not as output targets. Whole files,
unbounded logs, peer messages, and provider responses are not acceptable
substitutes for review. Conversely, a path or digest without the correlated
literal is not proof that the reviewer inspected the artifact.

## The `evidence` field

`ask_peers`, `session_start_round`, `run_until_unanimous`, and
`session_start_unanimous` accept optional `evidence: string`. For every
authenticated caller it can carry a value-corresponding raw bundle without
inflating the draft. The runtime persists it as immutable caller-submitted
material and transports it to the relator and reviewers.

Submitting again replaces the active automatic snapshot atomically, including
when the new snapshot has no evidence channels. This is logical supersession,
not deletion: every prior manifest, digest and blob remains in session history.

If the bundle says that proof lives in another file, include the relevant
literal content inline or in `evidence`. The server does not read arbitrary
filesystem paths.

## Attachment custody and authority

`session_attach_evidence` remains an optional operator-only authority
surface; normal reviews do not require it. AI peers, including Claude, cannot
promote their own bytes into operator authority or arbitrarily close evidence
items. A peer may withdraw only an earlier ask that it authored, and only after
its strictly grounded `READY/verified` recheck; the runtime records
`address_method=requester_reverified`. Silence stays `not_resurfaced`, and asks
from other peers or terminal operator dispositions are untouched.
`Checklist-Item` identifies which ask is being revisited but is never proof by
itself; the cited bytes must still answer a concrete value, command or
verifiable semantic anchor from that ask.
When one or more cited sources use checklist IDs, each item is correlated only
against the sources carrying its own ID; routed evidence cannot bleed into a
different ask from the same peer. The matcher recognizes common natural-language
evidence alternatives such as file/line versus diff and diff versus grep, while
keeping explicit conjunctions, execution claims and named release documents
fail-closed. Direct review-round prompts include every unresolved ID
automatically, so this routing requires no operator or caller-side reconstruction.
The same operator-only gate covers evidence-checklist mutations, terminal-state
mutations and security configuration.

Every new attachment records `attached_by`, `origin`, `attached_at`, UTF-8
`bytes`, `sha256`, and `integrity_version`, and persists a
`session.evidence_attached` event. `readEvidenceAttachments` recalculates byte
count and SHA-256 on every read; deletion, containment failure, malformed
custody metadata or content tampering fails closed and the orchestrator
continues without treating the file as evidence. Pre-custody attachments remain
readable for historical compatibility but are labeled
`provenance_status=legacy_unverified` and are not provenance-grade.

Operator authority is not inferred from `caller="operator"` or `clientInfo`.
It requires the seventh, dedicated operator capability from
`host-tokens.json`. Keep this token only in a separate human-console MCP host.
The six model-host tokens cannot call operator mutation tools. Judge passes are
operator-only, use distinct judges, and reject a peer ruling on its own ask.

Existing-session review starters also enforce petitioner/operator authority.
The evidence submitter is always the authenticated invoker; it is never inferred
from the session owner. A peer therefore cannot continue an operator-owned
session and have its bytes mislabeled as `operator_verified`.

## Opt-out

Set `CROSS_REVIEW_EVIDENCE_PREFLIGHT=off` to disable the preflight
entirely (default: `on`). Disabling is rarely needed — the trip
condition is deliberately conservative — but the escape hatch exists
for callers whose tasks legitimately make completed-work claims in
prose without inline markers.

The separate truthfulness gate is controlled by
`CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT` and remains enabled by default. Disabling
either gate weakens anti-deception protection and should be an explicit human
operator decision, not a peer-requested workaround.

## Outcome when it trips

- the session remains open with blocked convergence health so the authenticated
  caller can resubmit corrected inline or structured evidence;
- the corrected submission becomes the active snapshot without requiring an
  operator to attach, approve, delete or rewrite prior evidence;
- event emitted: `session.evidence_preflight_failed` with
  `completed_work_claim_matched`, `evidence_marker_found`,
  `structured_evidence_supplied`, `attachments_present`, and
  `unattached_evidence_references`;
- **zero paid peer calls** were made.

Re-submit value-corresponding raw evidence inline or through `evidence` using
the same authenticated peer. No operator intervention is required.

## Truthfulness preflight (v4.2.x)

`run_until_unanimous`, `session_start_unanimous`, and `ask_peers` also run a
local truthfulness preflight for high-risk runtime claims. It looks for current
runtime/version/date claims, historical runtime timing claims, and
fabrication-prone workflow/deployment/authorization claims before paid reviewer
calls.

The gate also checks value correspondence for fabrication-prone claims. A
workflow/deploy claim needs matching workflow/run identity and outcome evidence;
a model/runtime assertion is compared with live runtime facts; hashes and test
counts must occur in the provenance corpus. Negated or instructional examples
are not misclassified as completed work. Every `READY` decision must cite a
source traceable to the reviewed artifact, authenticated caller evidence, or
optional operator evidence. Workflow/deploy/authorization self-attestation may
enter review when its raw values correspond, but remains marked for strict
independent-panel corroboration; `confidence="inferred"` cannot satisfy that
gate. Runtime metadata may corroborate a matching runtime claim but never
establishes artifact review by itself. Incomplete structured status, model
mismatch, self-review, lossy/truncated READY, READY with blockers or caller
requests, open/not-resurfaced asks, or fabricated relator output cannot
converge.

A submission with no completed-work claim is authority-neutral. It may pass as
a design review, but receives `evidence_authority="none"`; absence of a claim or
evidence is never labeled `operator_verified`.

When it trips on caller input, the session remains blocked and open for a
corrected authenticated submission. Unsafe lead-generated output may still
abort the automated loop. The event
`session.truthfulness_preflight_failed` includes:

- `issue_classes` — one or more of `runtime_contradiction`,
  `unsupported_current_state_claim`, `unsupported_historical_claim`, or
  `fabrication_pattern`;
- `attachments_present`, `structured_evidence_supplied`,
  `source_marker_found`, and `runtime_facts_available`, so the operator can see
  whether evidence and live runtime facts were visible to the local gate;
- `contradictions` and `unsupported_claims` with the concrete text that blocked
  the session.

From v4.2.4, preflight blocks that happen before a peer round is appended are
also visible in `meta.failed_attempts` with `failure_class =
"truthfulness_preflight"` and `attempts = 0`.

## Retesting after evidence

The evidence-preflight behavioral matrix, including external artifact-reference
matching, lives in `scripts/evidence-preflight-smoke.ts` and runs through:

```bash
npm run evidence-preflight-smoke
```

The truthfulness-preflight behavioral and runtime-contract matrix lives in
`scripts/truthfulness-preflight-smoke.ts` and runs through:

```bash
npm run truthfulness-preflight-smoke
```

The focused transport regression runs through:

```bash
npm run evidence-transport-regression
```

`npm test` runs all three focused checks before the broader `scripts/smoke.ts` suite
so evidence and truthfulness preflight behavior can be validated without
searching the monolithic smoke harness.

Call `session_preflight_check` to run the same enabled evidence and
truthfulness gates without provider calls. The legacy
`session_truthfulness_preflight_check` name is retained as an alias, but its
top-level `pass` now reflects both gates. The tool uses the session task plus
either the supplied `draft` or latest persisted draft and requires no manual
attachment.
