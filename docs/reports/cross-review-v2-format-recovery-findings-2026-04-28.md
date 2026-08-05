# Cross Review v2 - Format Recovery Findings

Date: 28/04/2026, America/Sao_Paulo
Runtime: pre-stable API-first runtime 2.0.0-alpha.2

## Context

This report records real operational issues found while using the API-first cross-review runtime
that later became `cross-review-v2`, while reviewing the published Maestro Editorial AI v0.3.11
release.

The reviewed release itself was published successfully:

- Repository: `LCV-Ideas-Software/maestro-app`
- Commit: `ec37513`
- Release: `v0.3.11`
- Release URL: `https://github.com/LCV-Ideas-Software/maestro-app/releases/tag/v0.3.11`
- Release asset: `maestro-editorial-ai-v0.3.11-windows-x64-portable.zip`
- Asset SHA-256: `f97947b1a7ea74ae8d652d64fbbb0b9146fe5a2d6b60bf176aaa0346d66f6b62`
- CI, Release, CodeQL, and Code Quality runs: success
- Open code scanning alerts: 0
- Open Dependabot alerts: 0

## Sessions

- `b560d4fb-640e-46cf-9ff3-26218cdfdddf`
- `16d55e54-4b8c-4153-8451-818c3fc37625`
- `41e5d453-84ed-45a3-9c6d-c70c31a9d9f9`

Relevant persisted files live under:

- `data/sessions/<session-id>/meta.json`
- `data/sessions/<session-id>/agent-runs/*.json`
- `data/sessions/b560d4fb-640e-46cf-9ff3-26218cdfdddf/evidence/`

## Findings

### 1. READY content can be classified as NEEDS_EVIDENCE when `summary` exceeds 800 chars

Several peers returned semantically clear `READY` decisions, but the structured
parser rejected the response because `summary` was longer than 800 characters.
The round then recorded the peer as `NEEDS_EVIDENCE`.

Observed examples:

- `b560d4fb-640e-46cf-9ff3-26218cdfdddf`
- `41e5d453-84ed-45a3-9c6d-c70c31a9d9f9`

The parser warning shape was:

```text
summary: Too big: expected string to have <=800 characters
```

Impact:

- A peer can agree with the decision but still block convergence.
- The operator must inspect raw artifacts to distinguish a true disagreement
  from a formatting failure.
- This increases false-negative convergence results.

Recommended fix:

- Treat overlong summary as a recoverable format violation, not as substantive
  `NEEDS_EVIDENCE`.
- Server-side normalize by truncating `summary` to the schema limit while
  preserving the full raw text in the artifact.
- Add a parser warning such as `summary_truncated`, but keep `status=READY`
  when the status is otherwise parseable and valid.

### 2. Recovery rounds can silently narrow quorum scope

After full-peer rounds produced `codex`, `gemini`, and `deepseek` as `READY`,
an isolated recovery call was sent only to `claude`. Claude returned `READY`,
and the runtime marked that round as converged because `expected_peers=["claude"]`.

Observed session:

- `41e5d453-84ed-45a3-9c6d-c70c31a9d9f9`

Impact:

- The tool can report `converged=true` for the recovery round while the session
  no longer represents a single strict quadrilateral round.
- The correct human interpretation is "all peers reached READY across the
  original round plus a format-recovery round", not "the latest full quorum
  round converged".

Recommended fix:

- Add a first-class "format recovery" mode that retries only failed-format
  peers but preserves the original quorum scope.
- Convergence should distinguish:
  - `latest_round_converged`
  - `session_quorum_converged`
  - `recovery_converged`
- The public response should not collapse a recovery-only quorum into ordinary
  strict unanimity.

### 3. Minimal prompts can cause peers to review the schema instead of the decision

In session `16d55e54-4b8c-4153-8451-818c3fc37625`, the draft included a JSON
schema example with placeholders like `READY|NOT_READY`. DeepSeek interpreted
the template itself as the artifact under review and returned `NOT_READY`
because it saw no concrete decision.

Impact:

- Attempts to reduce prompt size for parser compliance can create semantic
  ambiguity.
- The model may correctly reject the prompt, but for the wrong target.

Recommended fix:

- The runtime should inject a non-ambiguous response contract internally instead of
  requiring the caller to include a schema template in `draft`.
- Use a separate transport-level response schema or provider-native structured
  output where available.
- If a schema example must be included, wrap it in a clearly labeled
  `RESPONSE_FORMAT_INSTRUCTIONS` block and keep the reviewed artifact separate.

### 4. The runtime needs automated per-peer format retries

The operator had to manually create shorter prompts and isolated calls to
recover from parser failures.

Impact:

- Manual recovery is slow and easy to misinterpret.
- It can distort convergence scope, as described above.

Recommended fix:

- Add an automatic retry path when parsing fails but raw text includes a
  recognizable status.
- Retry only the affected peer with a compact reformat instruction and the
  original evidence.
- Preserve the original peer set in session convergence computation.
- Cap retries per peer to avoid runaway cost.

### 5. Raw status extraction should be separated from structured payload validation

The current behavior appears to conflate:

- status detection (`READY`, `NOT_READY`, `NEEDS_EVIDENCE`)
- structured object validation
- convergence eligibility

Impact:

- A valid status can be hidden by a non-critical structured validation issue.

Recommended fix:

- Parse status first.
- Validate structured fields second.
- Classify format defects by severity:
  - fatal: no recognizable status, invalid JSON with no recoverable status
  - recoverable: overlong summary, too many follow-ups, missing optional fields
  - warning: extra fields, markdown fence around JSON
- Allow recoverable defects to become `READY_WITH_WARNINGS` internally, while
  still counting as READY for convergence if the status is unambiguous.

## Suggested Acceptance Tests

1. Peer returns valid JSON with `status=READY` and a 1,500-character summary.
   Expected: status counts as READY; summary is truncated or moved to raw text;
   parser warning is recorded.

2. Four-peer round where three peers parse READY and one peer has overlong
   summary but raw status READY.
   Expected: session convergence can become true without manual intervention
   after automatic recovery or normalization.

3. Recovery call for one peer after a four-peer round.
   Expected: session-level quorum remains the original four peers; the response
   explicitly reports that the latest call was a format recovery.

4. Draft includes a response schema example and a separate artifact.
   Expected: peers review the artifact, not the schema placeholder.

5. Peer returns markdown-fenced JSON.
   Expected: parser extracts JSON and records a warning instead of rejecting.

## Operator Interpretation for Maestro v0.3.11

For the Maestro v0.3.11 review, the substantive result was favorable:

- Codex: READY
- Gemini: READY
- DeepSeek: READY
- Claude: READY after isolated format-recovery prompt

However, because Claude's READY was obtained in an isolated recovery call, the
The runtime should not present this as a normal single-round quadrilateral convergence.
It should present it as recovered unanimity with explicit scope and audit trail.

## Implementation Update

Implemented locally after this report:

- Overlong `summary`, `evidence_sources`, `caller_requests` and `follow_ups`
  fields are now normalized server-side when the peer status is unambiguous.
- Parser warnings now preserve the recovery reason in the audit trail instead
  of converting the peer to a false `NEEDS_EVIDENCE`.
- Markdown-fenced JSON and tagged JSON are extracted with explicit parser
  warnings.
- Invalid JSON with an unambiguous `"status": "..."` key is recovered as a
  status-only structured result.
- Responses with no parseable status now trigger one automatic per-peer format
  recovery attempt before the round is judged blocked.
- Recovery calls that cover only a subset of peers now preserve the prior
  expected quorum and expose `latest_round_converged`,
  `session_quorum_converged`, `recovery_converged` and `quorum_peers`.
- `statusInstruction()` now tells peers not to review the response-format
  instructions as the artifact under review.

Validated with:

- `npm run typecheck`
- `npm run smoke`
- `npm run build`
- `npm run lint`
