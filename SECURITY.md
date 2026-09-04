# Security Policy

## Supported status

Current supported source/release target: v04.06.07 for package 4.6.7. This
statement identifies supported source metadata; registry publication is
verified independently through npm. The current `main` branch remains supported
for security fixes after publication.

v04.06.04 keeps those boundaries fail-closed while removing their residual
ambiguity and scaling defect. Evidence records are analyzed once; generic
command identity keeps normalized executable spelling separate from exact
argument boundaries and case. Truthfulness parsing uses finite English and
Portuguese transition/relation frames over occurrence-specific clause spans,
so strong punctuation isolates clauses while comma-relative current qualifiers
remain attached to their model occurrence.

v04.06.03 restores fail-closed correlation in the two textual preflight
boundaries affected by recent parser changes. A clean count cannot be proved by
one execution when another record reports failure for the same normalized
command, and unframed conflicting evidence remains ambiguous. Truthfulness
parsing treats contrastive additions (`not only … but also …`, `não só … mas
também …`) as affirmative on both sides and exempts a model occurrence as
future only when an explicit transition or selection construct targets it.
Continuative and present-state claims remain subject to the live model pins.

v04.05.39 closes three residual caller-token recovery gaps found after the
v04.05.37 merge. One boot never repeats a failed permission recovery; a file
that is confirmed missing after an existence precheck may safely reach the
exclusive-create path; and the trusted-console Windows recipe replaces only an
observed protected-empty DACL, then verifies the exact protected DACL before
restart. Other failures remain fail-closed.

v04.05.38 does not change runtime behavior. It locks the T2#10 source-regex
test debt at the current `smoke=129`, `source-contract=29`, total `158`
baseline, preventing future broad source-style regex pins from consuming the
two-pin allowance retained by the older gate.

v04.05.37 makes Windows caller-token ACL hardening interruption-tolerant and
self-healing for one initial `EACCES`/`EPERM` without rotating the capability
record. It replaces the prior three-process `icacls` sequence with one complete
protected-DACL application compatible with Windows PowerShell 5.1 and
PowerShell 7. Paths and SIDs reach the ACL scripts as JSON over standard input,
outside PowerShell's command parser. Required identities are deduplicated and
the final DACL is verified as an exact set. The recovery is Windows-only,
rejects non-files and symbolic links, binds the reopened descriptor to the pre-repair file identity and
current path, and never retries persistent or unrelated failures. POSIX retains
descriptor-based mode hardening. This is not a cross-process serialization
claim; the final exact-ACL verifier continues to fail closed.

v04.05.36 preserves fail-closed path, SHA-256, literal-contiguity and
fabrication checks while correcting false-negative JSON quote extraction. It
also keeps authenticated caller evidence in full decision retries and accepts
documented terminal Perplexity aggregate content only when streamed deltas
contain no usable post-reasoning text. No operator evidence promotion or raw
chain-of-thought persistence is introduced.

v04.05.35 keeps the public npm artifact free of internal field reports, binds
administrative release checks to the protected `github-administration`
environment without creating a Deployment, and preserves the isolated
`npm-production` Trusted Publishing boundary. The Windows parent-process
snapshot remains best-effort and time-bounded; its deterministic parser test
does not weaken caller-token validation or change persisted-state contracts.

v04.05.33 supersedes the unpublished v04.05.32 tag after its fail-closed
negative OIDC probe observed npm's documented `404` concealment for a trusted
publisher identity mismatch. It accepts only `401` or `404` outside
`npm-production`, still requires exactly `201` inside that environment, and
uses npm-compatible scoped-package escaping. The failed v04.05.32 run stopped
before checkout, project execution, artifact creation, GitHub Release, or npm
publication. v04.05.33 also resolves OpenAI 7.3.0 through Dependabot PR #163.

The v04.05.32 source upgrades the SHA-512-verified npm toolchain to 12.0.2 on Linux and
Windows and requires two clean-room OIDC exchange proofs before any checkout or
dependency execution: npm must reject the context outside `npm-production` and
authorize the exact context inside it. The positive probe discards its issued
credential without checking out code or invoking an action; only the immutable
npmjs writer uses an npm OIDC credential to publish. Registry/provenance
verification runs afterward without that environment. It also resolves the current
Hono, `brace-expansion`, `fast-uri` and `ip-address` advisories with 4.12.34,
5.0.9, 3.1.5 and 10.4.0 respectively, including GHSA-8j4g-w8fx-2239.

v04.05.31 supersedes the unpublished v04.05.30 tag after its fail-closed
pre-publish gate detected a stale SDK-license assertion. It updates the OpenAI
runtime client to 7.0.0 and bundles MCP SDK 1.30.0.
It completely removes the active Socket Security and StepSecurity integrations,
including their dependency proxy and dedicated tooling. Zizmor now runs
directly at the centrally pinned version after uv's official archive passes an
explicit SHA-256 check. Auto-tag suppresses an immutable-tag redispatch only
when an exact successful Publish run or an exact immutable Release with the
expected uploaded asset and valid SHA-256 digest proves completion. Auto-tag
and Publish treat only an exact `gh api` HTTP 404 as absence; every other API
failure remains fatal.

v04.05.29 resolves GHSA-mh99-v99m-4gvg by locking `brace-expansion` 5.0.8.
The advisory was published while the 4.5.28 release gate was running, so the
immutable 4.5.28 tag was not published. v04.05.25 had resolved the three
advisories known at that time: `body-parser` 2.3.0, nested `protobufjs` 7.6.5,
and the earlier `brace-expansion` advisory with 5.0.7.
At that release the Scorecard/Code Scanning and Auto-tag gates were fail-closed
and no finding was suppressed; Auto-tag was removed in v04.06.06. Its version-pinned `allowScripts` approval is likewise updated only
to `protobufjs@7.6.5`; the cryptographic `npm audit signatures` gate was mandatory then (removed in
v04.06.06: npm verifies provenance itself at publication). It
preserves v04.05.23 normalization of the one-item JSON array that npm v12 returns
from `npm view --json`; v04.05.22 decoding of npm's published Sigstore DSSE
envelope before binding SLSA provenance to the release workflow, protected tag,
and immutable source commit; the v04.05.21 durable telemetry fixture; the v04.05.20 deterministic
budget/cache fixture, the v04.05.19 release-gate hardening and the 4.5.18 runtime
trust-boundary controls: that release gate did not weaken artifact verification;
its post-publish audit used an integrity-bound lock and `npm ci`, validated the
installed package contract, then verified npm registry signatures and
provenance. That machinery was removed in v04.06.06; no post-publish verifier
exists in this repository. The preceding
4.5.18 release extends the runtime trust boundary symmetrically to factual
`NOT_READY` and `NEEDS_EVIDENCE` verdicts: missing or fabricated blocker
evidence cannot remain a clean veto. Raw provider results are persisted as each
call finishes, caller drafts survive preflight rejection, and terminal
preflight outcomes no longer remain stale-open. npm 12 still fails closed on
dependency lifecycle changes; wildcard script permission and broad bypasses
remain forbidden.

Publication is triggered by a push to `main` that changes the manifest
version, so the published commit is `main` by construction and the required
checks already ran on it. Publishing is fail-closed on what neither GitHub nor
npm proves on its own: the manifest version must be a plain three-part numeric
version the `vXX.XX.XX` form can express, never a prerelease; a version whose
tag already exists publishes nothing, because it was released before; and the
version must be newer than the one the registry already serves, so `latest`
cannot move backward. A tag or registry read that fails for any reason other
than an explicit not-found refuses the publication. The Release is created
last, by the run's own token, as the record of a publication that already
happened, so a registry failure never leaves an immutable Release behind. The Enterprise tag ruleset prohibits
deletion and non-fast-forward updates without bypass, so a published ref cannot
be silently retargeted.

The 4.5.16 controls preserved here transport evidence submitted
by authenticated callers automatically into the review session. Peer-submitted
evidence is hashed, attributed, reverified on every read and clearly marked as
unverified; no manual operator attachment is required for admission or
convergence. It also makes raw, parsed and normalized verdicts auditable;
prevents one attachment from grounding another attachment's quote; excludes an
ask author from its own judge panel; and records paid, failed, skipped,
cancelled and interrupted attempts without claiming complete cost
reconciliation when coverage is unknown. Operator-only mutations still require
a distinct capability token, incomplete or unhealthy provider terminal states
fail closed, and unsupported operational claims, model-pin contradictions and
unresolved evidence cannot converge.

Routine polling now minimizes disclosure by default. `session_poll` with
`detail="summary"` excludes complete prior-round peer `text`, `raw` and
`structured` fields; `detail="full"` and `session_read` remain explicit
forensic surfaces inside the same trusted local-account boundary. Markdown
responses neutralize HTML from caller, peer and persisted strings before
rendering. Compact background-job status is persisted under the contained
session directory so sibling/restarted hosts can report terminal state, but
that operational record grants no additional mutation authority:
`session_cancel_job` still requires the petitioner capability or operator
token, and a late request is an idempotent no-op with a compact `final_state`.

Requester reverification is item-scoped: when citations carry checklist IDs,
the broker evaluates the sources routed to that item plus separate generic
sources; a source routed to another item is excluded without poisoning generic
evidence. The ID never proves satisfaction by itself. Concrete values, commands, execution records,
file/line material and bilingual semantic concepts still have to correspond to
the original ask. Evidence routed to one item cannot close another, partial
release-document proof remains unresolved, and synthetic adapter injection is
rejected outside explicitly confirmed stub/test mode.

Historical caller blobs never re-enter a later prompt, preflight or READY
grounding corpus. On resume, only a previously persisted clean/verified READY
source whose path, SHA-256 and literal quote still match an immutable caller
attachment can be replayed locally through the current item correlator. This
uses no provider call and cannot prove a new operational claim. Checklist alias
repair is limited to acyclic, older, same-owner strict restatements; cross-peer
requests and requests containing new requirements remain blocking.

Every review round acquires its durable reservation before evidence or broker
mutation. Its journal restores checklist/history when an unappended round is
interrupted and appends an explicit compensation event; an appended converged
round keeps the reservation until terminal finalization, preventing concurrent
operator changes from reopening the checklist between those transitions.

Code scanning runs through GitHub's CodeQL default setup and its analyses
gate every pull request into `main` through the Enterprise ruleset and the
repository's required checks, so a released commit already carries them.
Regex changes over untrusted text
must use bounded or linear matching and include adversarial long-input coverage.

Dependabot covers every package ecosystem represented by a committed manifest:
npm, GitHub Actions, pip/pip-compile and pre-commit. The committed `.npmrc`
declares npmjs.org as npm's global dependency registry. `package.json`
intentionally does not carry a `packageManager` Corepack hint: Dependabot uses
its supported npm resolver, while CI bootstraps npm 12.0.2 from the npm
registry tarball and verifies its pinned SHA-512. Ordinary CI
installs the Python tool lock with `--require-hashes` under the centrally pinned
Python 3.12 and executes the pre-commit hooks, so those bot updates are not
auto-merged on skipped consumer checks. `python-tools-requirements.in` is the
direct pip-compile source; its generated `.txt` companion must contain the full
pinned, hashed transitive closure. Compatible Python updates are grouped to
avoid a burst of lockfile PRs racing each other.

Dependabot updates reach `main` through the same required checks as any other
pull request, and the native auto-merge workflow arms a squash merge only after
those checks pass.

Server-authored parser and grounding remediation is kept in the durable
decision-transformation audit trail, never represented as a peer-authored
evidence request. This prevents an internal format correction from creating an
anchorless checklist item that no later grounded vote can close. Genuine peer
requests, strict ask-to-evidence correlation, operator authority and unresolved
evidence blocking remain unchanged.

When an active legacy session is resumed, old checklist entries are removed
only if the persisted provider verdict proves `READY`, contains no matching
peer request and carries the corresponding server-demotion warning in the
round that originally created the checklist item. A later synthetic collision
cannot erase a genuine earlier ask. The runtime records the proof and removal
durably. Terminal sessions are never rewritten, preserving their forensic
record.

The attachment path and digest generated by the runtime are part of the
integrity envelope, so reviewers may cite them without triggering the
anti-fabrication detector. They do not establish truth by themselves: READY
still requires a value-corresponding literal from the authenticated corpus.
Source/package release bumps are also kept distinct from claims about what
runtime was loaded at the start of a workflow or session.

Peer-submitted integrity is not treated as authority. Operational claims that
depend only on that tier require at least two independent non-author reviewers,
each with a `READY/verified` vote bound to attachment path, SHA-256 and literal
value-corresponding lines. Non-zero exits, explicit failures, conflicting command
records, inferred confidence and narrative-only citations fail closed.

Evidence attribution is bound to the authenticated invoker, never copied from a
session's persisted petitioner. Existing-session review starters require the
petitioner's capability or the dedicated operator capability, preventing a peer
from continuing an operator-owned session and acquiring operator evidence
authority.

Routine AI evidence never requires human attachment. The four review starters
persist their `evidence` field automatically as integrity-checked
`caller_submitted_unverified` material. `session_attach_evidence` is only an
optional operator authority-promotion surface; its runtime contract and
rejection message redirect model callers to the automatic path rather than
requesting human intervention.
Invalid session metadata is quarantined rather than trusted by list/doctor
operations. The release also retains the dependency advisory floors introduced
in v04.04.07 and v04.04.08.

Package publication uses npm Trusted Publishing/OIDC from the protected
`npm-production` GitHub environment, not a long-lived npm publish token. The
workflow runs on a push to `main` that changes the manifest version, disables dependency caches,
installs with `--ignore-scripts` so no dependency lifecycle script executes on
the publishing path, and publishes with `--provenance`, so npm records and
verifies the SLSA provenance itself. The published package has no install-time
lifecycle script of its own; operators must not bypass npm 12 policy with
`--dangerously-allow-all-scripts` or replace a registry upgrade with a locally
built source installation.

READY is a canonical envelope, not a free-form natural-language classification:
its summary is fixed, requests/follow-ups are empty and outside prose is
rejected. Session cancellation and verdict contestation require the explicit
petitioner token or the operator token; ambiguous legacy ownership is
operator-only.

The capability token authenticates the MCP host, not a model's internal intent
or amount of cognitive effort. The operator token must never be placed in a
model host. The local token file is plaintext and therefore assumes processes
with read access to the cross-review data directory are trusted. The runtime
fails closed unless it can enforce owner-only mode on POSIX or a protected
Windows DACL limited to the current user, SYSTEM and Administrators. This
removes inherited model-sandbox access but cannot isolate two unrestricted
processes running as the same OS user; use separate OS identities or a secret
vault for that threat model.

No API can prove how much internal reasoning a model performed. The runtime
proves observable protocol behavior—terminal completion, evidence custody,
source grounding, independent unanimity and contradiction checks—not private
cognition. In circular mode, byte-identical output is an artifact-stability
signal only; convergence still requires a complete rotation, but an individual
echo is not cryptographic proof that the rotator read deeply. SHA-256 likewise
proves file integrity after custody, not human authorship.

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities, credential leaks, private data exposure, authentication bypasses, payment-flow issues, supply-chain issues, or deployment misconfiguration.

Report privately by email:

- security@lcv.dev

If GitHub private vulnerability reporting is enabled for this repository, that channel is also acceptable.

Please include:

- affected repository, component, route, package, workflow, or public surface;
- affected version, release tag, commit SHA, or deployment URL when known;
- impact and exploitability;
- reproduction steps or a safe proof of concept, if available;
- whether any credential, personal data, payment data, private editorial material, or operational secret may be involved.

## Scope

In scope: application code, Workers/Pages functions, package publication, GitHub Actions, dependency and supply-chain configuration, repository publication boundaries, security documentation, and public service configuration documented in this repository.

Out of scope: social engineering, physical attacks, denial-of-service testing without prior written authorization, spam, automated noisy scanning, and reports that rely only on outdated browser or dependency versions without a concrete vulnerable path in this repository.

## Coordinated disclosure

LCV Ideas & Software will triage reports privately, request clarification when needed, and coordinate remediation before public disclosure. Public disclosure should wait until a fix or mitigation is available, unless there is an immediate user-safety reason to do otherwise.
