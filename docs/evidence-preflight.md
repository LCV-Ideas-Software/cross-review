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
- **does NOT** package evidence for you;
- only inspects text the caller already supplied — `task`,
  `initial_draft`, the structured `evidence` field, and
  already-attached evidence.

Evidence _packaging_ (`git diff --stat`, hunks, `git status --short`,
validation-command tails, changed-file lists, target commit) is a
**caller-side responsibility**. Build it into a local agent helper,
prompt workflow, or shared utility — never inside the MCP server.

## How it decides

The preflight trips **only** when **both** are true:

1. **Completed-work claim present** — the text matches one of:
   `\d+ passed/failed`, `git diff`, `git status`, `npm run`,
   `cargo test|build`, `build passed/succeeded/clean/green`,
   `tests? pass/passed/green`, `git diff --check`.
2. **Zero evidence markers** — the text contains none of: fenced code
   blocks (` ``` `), `@@ -`/`@@ +` diff hunks, 7+ hex-char hashes,
   `file.ext:NN` line refs, `$`/`>` command-prompt lines.

Mere keyword presence does **not** trip it. "I plan to write a patch"
or "here is the test plan" is a design review with legitimately no diff
— it passes.

A non-empty `evidence` field **or** any attached evidence makes the
preflight pass unconditionally — that is the caller's authoritative
declaration that concrete evidence exists.

## Minimum evidence format

To pass the preflight when your task makes a completed-work claim,
embed at least one of these inline in `initial_draft` or in the
`evidence` field:

- a fenced code block with the relevant diff hunk(s) — `@@ -N,M +N,M @@`;
- `file/path.ext:LINE` references for every changed location;
- raw command output (the `$ cmd` line plus its output) for every
  validation you claim — `npm run typecheck`, `cargo test`,
  `git diff --check`, `rg` scans;
- content hashes (`sha256`, `md5`) when asserting artifact identity.

This is the same provenance-grade material the R1 evidence-upfront
contract already expects. The preflight just refuses to spend API when
it is obviously absent.

## The `evidence` field

Both `run_until_unanimous` and `session_start_unanimous` accept an
optional `evidence: string`. When non-empty it satisfies the preflight
unconditionally. Use it to attach the caller-packaged evidence bundle
without inflating `initial_draft`.

## Opt-out

Set `CROSS_REVIEW_EVIDENCE_PREFLIGHT=off` to disable the preflight
entirely (default: `on`). Disabling is rarely needed — the trip
condition is deliberately conservative — but the escape hatch exists
for callers whose tasks legitimately make completed-work claims in
prose without inline markers.

## Outcome when it trips

- session finalized: `outcome = "aborted"`, `reason =
"needs_evidence_preflight"`;
- event emitted: `session.evidence_preflight_failed` with
  `completed_work_claim_matched`, `evidence_marker_found`,
  `structured_evidence_supplied`, `attachments_present`;
- **zero paid peer calls** were made.

Re-submit with evidence embedded inline, with the `evidence` field
populated, or with evidence attached via `session_attach_evidence`.

## Truthfulness preflight (v4.2.x)

`run_until_unanimous`, `session_start_unanimous`, and `ask_peers` also run a
local truthfulness preflight for high-risk runtime claims. It looks for current
runtime/version/date claims, historical runtime timing claims, and
fabrication-prone workflow/deployment/authorization claims before paid reviewer
calls.

When it trips, the session is finalized with
`reason = "needs_truthfulness_preflight"` and the event
`session.truthfulness_preflight_failed` includes:

- `issue_classes` — one or more of `runtime_contradiction`,
  `unsupported_current_state_claim`, `unsupported_historical_claim`, or
  `fabrication_pattern`;
- `attachments_present` and `structured_evidence_supplied`, so the operator can
  see whether attached evidence was visible to the runtime;
- `contradictions` and `unsupported_claims` with the concrete text that blocked
  the session.

From v4.2.4, preflight aborts that happen before a peer round is appended are
also visible in `meta.failed_attempts` with `failure_class =
"truthfulness_preflight"` and `attempts = 0`.

## Retesting after evidence

After attaching evidence with `session_attach_evidence`, call
`session_truthfulness_preflight_check` to re-run the local truthfulness preflight
without provider calls. The tool uses the session task plus either the supplied
`draft` argument or the latest persisted draft, and returns the same
`issue_classes`, evidence visibility flags, and unsupported-claim diagnostics.
